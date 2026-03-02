// Spawns a single Claude CLI subprocess with stream-json output parsing.
// Built from scratch using Node's child_process.spawn.

const { spawn } = require('child_process');
const { config } = require('../config');
const { log } = require('../util/logger');
const { register, unregister, emitActivity } = require('../util/process-registry');

const MODEL_MAP = {
  opus: 'claude-opus-4-20250514',
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-4-5-20251001',
};

function resolveModel(shorthand) {
  if (!shorthand) return null;
  return MODEL_MAP[shorthand.toLowerCase()] || shorthand;
}

function extractText(message) {
  if (typeof message === 'string') return message;
  if (message && Array.isArray(message.content)) {
    return message.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return String(message || '');
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE')) delete env[key];
  }
  return env;
}

function summarizeToolInput(toolName, input) {
  if (!input) return '';
  try {
    const obj = typeof input === 'string' ? JSON.parse(input) : input;
    // Show the most useful field per tool type
    if (obj.command) return ` → ${obj.command.slice(0, 120)}`;
    if (obj.url) return ` → ${obj.url.slice(0, 120)}`;
    if (obj.file_path) return ` → ${obj.file_path}`;
    if (obj.path) return ` → ${obj.path}`;
    if (obj.query) return ` → "${obj.query.slice(0, 80)}"`;
    if (obj.pattern) return ` → ${obj.pattern}`;
    if (obj.selector) return ` → ${obj.selector.slice(0, 80)}`;
    if (obj.ref) return ` → ref=${obj.ref}`;
    // Fallback: show first key=value pair
    const keys = Object.keys(obj);
    if (keys.length > 0) {
      const val = String(obj[keys[0]]).slice(0, 80);
      return ` → ${keys[0]}=${val}`;
    }
  } catch {}
  return '';
}

function runModel({
  userPrompt,
  systemPrompt,
  model,
  claudeArgs,
  onProgress,
  processKey,
  timeout,
  cwd,
  resumeSessionId,
}) {
  return new Promise((resolve, reject) => {
    const cmd = config.claudeCommand || 'claude';
    const args = [...(claudeArgs || config.claudeArgs || ['--print']), '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];

    // For large system prompts, prepend instructions into the user prompt via stdin
    // instead of passing as a CLI arg to avoid Windows ENAMETOOLONG errors.
    let stdinPrefix = '';
    if (systemPrompt) {
      if (systemPrompt.length > 8000) {
        stdinPrefix = `[SYSTEM INSTRUCTIONS — follow these carefully]\n${systemPrompt}\n[END SYSTEM INSTRUCTIONS]\n\n`;
      } else {
        args.push('--append-system-prompt', systemPrompt);
      }
    }

    const resolvedModel = resolveModel(model);
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }

    // On Windows, shell: true is needed so spawn resolves .cmd wrappers (e.g. claude.cmd).
    const proc = spawn(cmd, args, {
      cwd: cwd || config.workingDirectory || process.cwd(),
      env: cleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    const modelLabel = resolvedModel ? resolvedModel.split('-').slice(0, 2).join('-') : 'default';
    const promptKB = ((stdinPrefix.length + (userPrompt || '').length) / 1024).toFixed(1);
    log(`[model-runner] Spawning ${modelLabel}${resumeSessionId ? ' (resume)' : ''} — ${promptKB}KB input`);
    const tSpawn = Date.now();

    if (processKey) {
      register(processKey, proc, model || 'claude');
    }

    let response = '';
    let sessionId = null;
    const fullEvents = [];
    let buffer = '';
    let response_streamed = false;
    let killedForQuestion = false;
    let killedAfterResult = false;

    // Write prompt to stdin and close
    if (stdinPrefix) {
      proc.stdin.write(stdinPrefix);
    }
    if (userPrompt) {
      proc.stdin.write(userPrompt);
    }
    proc.stdin.end();

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }
        fullEvents.push(event);

        switch (event.type) {
          case 'system':
            if (event.session_id) sessionId = event.session_id;
            break;

          case 'assistant':
            if (event.subtype === 'tool_use') {
              // Legacy format: subtype at top level
              const toolInputSummary = summarizeToolInput(event.tool_name, event.input);
              log(`[model-runner] Tool: ${event.tool_name}${toolInputSummary}`);
              onProgress?.('tool_use', {
                tool: event.tool_name,
                input: event.input,
              });
              emitActivity(processKey, 'tool_use', event.tool_name);

              if (event.tool_name === 'AskUserQuestion') {
                fullEvents._questionRequest = event.input;
                killedForQuestion = true;
                setTimeout(() => {
                  try { proc.kill(); } catch {}
                }, 3000);
              }
            } else if (event.message) {
              const content = Array.isArray(event.message.content) ? event.message.content : [];

              // Extract tool_use blocks from message.content
              for (const block of content) {
                if (block.type === 'tool_use') {
                  const toolInput = typeof block.input === 'string'
                    ? (() => { try { return JSON.parse(block.input); } catch { return block.input; } })()
                    : block.input;
                  const toolInputSummary = summarizeToolInput(block.name, toolInput);
                  log(`[model-runner] Tool: ${block.name}${toolInputSummary}`);
                  onProgress?.('tool_use', {
                    tool: block.name,
                    input: toolInput,
                  });
                  emitActivity(processKey, 'tool_use', block.name);

                  if (block.name === 'AskUserQuestion') {
                    fullEvents._questionRequest = toolInput;
                    killedForQuestion = true;
                    // Give Claude CLI time to persist session state before killing.
                    // Without this delay, --resume can't find the session next time.
                    setTimeout(() => {
                      try { proc.kill(); } catch {}
                    }, 3000);
                  }
                }
              }

              // Extract text from message
              const text = extractText(event.message);
              if (text && !killedAfterResult) {
                response = text;
                response_streamed = true;
                onProgress?.('assistant_text', { text });
              }
            }
            break;

          case 'user':
            if (event.subtype === 'tool_result') {
              onProgress?.('tool_result', {
                tool: event.tool_name,
                output: event.output,
              });
            } else if (event.message) {
              const content = Array.isArray(event.message.content) ? event.message.content : [];
              for (const block of content) {
                if (block.type === 'tool_result') {
                  onProgress?.('tool_result', {
                    tool: block.tool_use_id,
                    output: block.content || block.output || '',
                  });
                }
              }
            }
            break;

          case 'result': {
            const resultText = event.result ? (typeof event.result === 'string' ? event.result : extractText(event.result)) : null;
            if (resultText && !killedAfterResult) {
              response = resultText;
              onProgress?.('assistant_text', { text: resultText });
            }
            if (!killedAfterResult && event.session_id) sessionId = event.session_id;
            if (event.duration_ms !== undefined || event.total_cost_usd !== undefined) {
              onProgress?.('cost', {
                cost: event.total_cost_usd,
                duration: event.duration_ms,
                input_tokens: event.usage?.input_tokens,
                output_tokens: event.usage?.output_tokens,
                cache_read: event.usage?.cache_read_input_tokens,
              });
              const elapsed = ((Date.now() - tSpawn) / 1000).toFixed(1);
              const tokens = event.usage ? `${event.usage.input_tokens}in/${event.usage.output_tokens}out` : 'no usage data';
              const cached = event.usage?.cache_read_input_tokens ? `, ${event.usage.cache_read_input_tokens} cached` : '';
              log(`[model-runner] ${modelLabel} complete in ${elapsed}s — ${tokens}${cached}, ${response.length} chars`);
            }
            // After the first result, kill the process tree to prevent background
            // tasks from triggering additional model turns that waste API credits.
            // Use a 5s delay to let Claude CLI persist session state so
            // --resume works on the next invocation.
            if (!killedAfterResult && !killedForQuestion) {
              killedAfterResult = true;
              setTimeout(() => {
                try {
                  if (process.platform === 'win32') {
                    spawn('taskkill', ['/T', '/F', '/PID', String(proc.pid)], {
                      shell: true,
                      stdio: 'ignore',
                      detached: true,
                    });
                  } else {
                    process.kill(-proc.pid, 'SIGTERM');
                  }
                } catch {}
              }, 5000);
            }
            break;
          }
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) onProgress?.('stderr', { text, model: model || 'default' });
    });

    proc.on('close', (code) => {
      if (processKey) unregister(processKey);

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          fullEvents.push(event);
          if (event.type === 'result' && event.result) response = event.result;
          if (event.session_id) sessionId = event.session_id;
        } catch {}
      }

      if (proc._stoppedByUser) {
        reject({ stopped: true, message: 'Process stopped by user' });
        return;
      }

      resolve({
        response,
        sessionId,
        fullEvents,
        questionRequest: fullEvents._questionRequest || null,
      });
    });

    proc.on('error', (err) => {
      if (processKey) unregister(processKey);
      reject(err);
    });
  });
}

module.exports = { runModel };
