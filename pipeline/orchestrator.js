// Pipeline orchestrator — coordinates A → B → C? → D → learn with feedback loops.

const { runModel } = require('./model-runner');
const { runPhaseA, runPhaseB } = require('./ml-runner');
const { buildGapPrompt: modelBGapPrompt } = require('./prompts/model-b');
const { buildPrompt: modelCPrompt } = require('./prompts/model-c');
const { buildPrompt: modelDPrompt } = require('./prompts/model-d');
const { buildPrompt: learnerPrompt } = require('./prompts/learner');
const { parseOutputSpec, parseAuditResult, parseTeacherResult, parseLearnerResult } = require('../util/output-parser');
const { createAggregator } = require('../util/progress-aggregator');
const { getFullInventory, getContents, writeMemory, updateMemory, detectSiteContext, detectSelfAwareness } = require('../memory/memory-manager');
const { config } = require('../config');
const { log } = require('../util/logger');
const { getOutputDir, setClaudeSessionId } = require('../session/session-manager');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load last session log for persistent cross-session context
function loadLastSessionLog() {
  try {
    const { app } = require('electron');
    const logPath = path.join(app.getPath('userData'), 'last-session-log.json');
    return JSON.parse(fs.readFileSync(logPath, 'utf-8'));
  } catch {
    return null;
  }
}

const MAX_FEEDBACK_LOOPS = 3;

const FAILURE_PATTERNS = [
  /i (?:can'?t|cannot|am unable to|don'?t have (?:the ability|access)|am not able to)/i,
  /(?:unfortunately|sorry),? (?:i |this )?(?:can'?t|cannot|isn'?t possible|is not possible|won'?t work)/i,
  /i don'?t (?:know how|have (?:enough|the (?:tools|knowledge|capability)))/i,
  /(?:beyond|outside) (?:my|the) (?:capabilities|scope|ability)/i,
  /not (?:currently )?(?:able|possible|supported)/i,
  /i'?m (?:afraid|sorry) (?:i |that )?(?:can'?t|cannot)/i,
];

const SUCCESS_PATTERNS = [
  /^(?:all )?done\.?$/i,
  /^(?:all )?complete[d.]?\.?$/i,
  /^(?:task )?(?:finished|succeeded)\.?$/i,
  /^(?:sent|delivered|created|updated|deleted|saved|installed)\.?$/i,
  /^(?:email|message) sent\.?$/i,
];

function detectFailure(response) {
  if (!response) return true;
  const trimmed = response.trim();
  if (!trimmed) return true;
  // Short responses that match known success patterns are NOT failures
  if (trimmed.length < 20 && SUCCESS_PATTERNS.some(p => p.test(trimmed))) return false;
  // Truly empty/meaningless responses are failures
  if (trimmed.length < 3) return true;
  return FAILURE_PATTERNS.some(p => p.test(response));
}

async function runPipeline(prompt, { onProgress, processKey, timeout, resumeSessionId, sessionContext }) {
  const tPipeline = Date.now();
  const outputDir = sessionContext ? getOutputDir(sessionContext.id) : config.outputDirectory;
  fs.mkdirSync(outputDir, { recursive: true });
  const agg = createAggregator(onProgress);

  // CRITICAL: Use a stable CWD for Claude CLI so sessions can be found on resume.
  // Claude CLI stores sessions per-project based on the CWD hash. If we use the
  // per-session output directory as CWD, each invocation creates sessions in a
  // different project and --resume can never find previous sessions.
  const stableCwd = config.workingDirectory;
  if (!stableCwd) {
    log('[orchestrator] WARNING: workingDirectory not set — session resume will fail');
  }

  // ── Fast path: resumed session → skip A/B/C, send raw message ──
  // When resuming a conversation, the Claude session already has full context
  // from the previous turn(s). Re-running the pipeline would wrap the user's
  // follow-up in a fresh "Model D Executor" system prompt, destroying continuity.
  if (resumeSessionId) {
    const tResume = Date.now();
    agg.phase('D', `Resuming session ${resumeSessionId} (${prompt.length} char prompt)`);

    const phaseD = await runModel({
      userPrompt: prompt,
      systemPrompt: undefined,
      model: null,
      claudeArgs: config.claudeArgs,
      onProgress: (type, data) => agg.forward('D', type, data),
      processKey: processKey ? `${processKey}:D` : null,
      timeout,
      cwd: stableCwd,
      resumeSessionId,
    });

    // If the resumed session returned empty (stale/invalid session ID),
    // fall through to the full pipeline instead of returning nothing.
    if (!phaseD.response || !phaseD.response.trim()) {
      agg.phase('D', `Resume failed for session ${resumeSessionId} after ${Date.now() - tResume}ms, falling back to full pipeline`);
      resumeSessionId = null;
      // Fall through to full pipeline below
    } else {
      // Track Claude's session ID back to our internal session
      if (sessionContext && phaseD.sessionId) {
        setClaudeSessionId(sessionContext.id, phaseD.sessionId);
      }

      if (phaseD.questionRequest) {
        return {
          status: 'needs_user_input',
          questions: phaseD.questionRequest,
          sessionId: phaseD.sessionId,
          fullEvents: phaseD.fullEvents,
        };
      }

      // Fire-and-forget learning
      learnInBackground(prompt, { taskDescription: prompt }, phaseD.response, onProgress, processKey, timeout);

      agg.phase('done', `Pipeline complete in ${Date.now() - tPipeline}ms [D(resume)] — ${phaseD.response.length} chars`);
      return {
        status: 'completed',
        response: phaseD.response,
        sessionId: phaseD.sessionId,
        fullEvents: phaseD.fullEvents,
      };
    }
  }

  // ── Phase A + B: Run classification and memory retrieval in parallel ──
  const tAB = Date.now();
  agg.phase('A', 'Classifying request (local ML)');

  const inventory = getFullInventory();
  agg.phase('B', `Selecting from ${inventory.length} memory files (ML)`);

  const [phaseAResponse, initialPhaseBResponse] = await Promise.all([
    runPhaseA(prompt),
    runPhaseB(prompt, inventory),
  ]);

  const outputSpec = parseOutputSpec(phaseAResponse);
  const activeLabels = outputSpec.outputLabels
    ? Object.entries(outputSpec.outputLabels).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'
    : outputSpec.outputType || 'text';
  const scoreStr = outputSpec.outputScores
    ? ' | scores: ' + Object.entries(outputSpec.outputScores).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';
  agg.phase('A', `Complete in ${Date.now() - tAB}ms → [${activeLabels}]${scoreStr}`);

  // ── Feedback loop: B → C? → D, max 3 iterations ──
  let loopCount = 0;
  let lastDResponse = null;
  let lastDSessionId = null;
  let lastDFullEvents = null;
  let previousFailure = null;
  const seenToolRequests = new Set();

  while (loopCount < MAX_FEEDBACK_LOOPS) {
    loopCount++;

    // ── Phase B: On retries, re-run with failure context. First pass uses parallel result. ──
    const taskDesc = outputSpec.taskDescription || prompt;

    let phaseBResponse;
    if (loopCount === 1) {
      phaseBResponse = initialPhaseBResponse;
    } else {
      const tBRetry = Date.now();
      agg.phase('B', `Re-selecting memory files (ML, loop ${loopCount}/${MAX_FEEDBACK_LOOPS})`);
      phaseBResponse = await runPhaseB(
        `${prompt}\n\nPrevious failure context: ${previousFailure.slice(0, 500)}`,
        inventory
      );
      agg.phase('B', `Re-selection complete in ${Date.now() - tBRetry}ms`);
    }
    const audit = parseAuditResult(phaseBResponse);
    const selectedSummary = (audit.selectedMemories || [])
      .map(m => `${m.name} (${m.reason || m.category})`)
      .join(', ') || 'none';
    onProgress?.('pipeline_phase', { phase: 'B', description: `Selected ${(audit.selectedMemories || []).length} files: ${selectedSummary}` });

    // Gap detection: only invoke Haiku when a previous execution failed
    if (previousFailure != null) {
      const tGap = Date.now();
      agg.phase('B', 'Detecting knowledge gaps (Haiku)');
      const gapModel = await runModel({
        userPrompt: `Output ONLY a raw JSON object. No prose. No explanation. Identify missing memories for the failed task.\n\nFailed task: ${taskDesc}\n\nFailure output: ${previousFailure.slice(0, 800)}`,
        systemPrompt: modelBGapPrompt(taskDesc, inventory, prompt, previousFailure),
        model: 'haiku',
        claudeArgs: ['--print', '--max-turns', '1'],
        onProgress: (type, data) => agg.forward('B', type, data),
        processKey: processKey ? `${processKey}:Bgap` : null,
        timeout,
      });
      const gapAudit = parseAuditResult(gapModel.response);
      audit.missingMemories = gapAudit.missingMemories || [];
      audit.toolsNeeded = gapAudit.toolsNeeded || [];
      if (gapAudit.notes) audit.notes = (audit.notes ? audit.notes + ' | ' : '') + gapAudit.notes;
      agg.phase('B', `Gap detection complete in ${Date.now() - tGap}ms — ${audit.missingMemories.length} gaps found`);
    }

    // If B didn't return valid JSON and we have a previous failure, force-create
    // a missing memory so C (Teacher) actually runs and researches the topic
    if (previousFailure != null && (!audit.missingMemories || audit.missingMemories.length === 0)) {
      onProgress?.('warning', { message: `Model B didn't identify gaps — forcing knowledge acquisition for: ${outputSpec.taskDescription}` });
      audit.missingMemories = [{
        name: outputSpec.taskDescription.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50),
        category: 'knowledge',
        description: `How to: ${outputSpec.taskDescription}. The executor previously failed with: ${(previousFailure || '').slice(0, 300)}`,
        reason: 'Executor failed and auditor did not identify gaps — forcing research',
      }];
    }

    // ── Phase C: Teacher (if gaps found) ──
    let newlyCreatedMemories = [];
    if (audit.missingMemories && audit.missingMemories.length > 0) {
      const tC = Date.now();
      const memNames = audit.missingMemories.map(m => m.name).join(', ');
      agg.phase('C', `Creating ${audit.missingMemories.length} memory file(s): ${memNames}`);

      const phaseC = await runModel({
        userPrompt: `Create the following memories:\n${audit.missingMemories.map(m => `- ${m.name}: ${m.description}`).join('\n')}`,
        systemPrompt: modelCPrompt(audit.missingMemories, inventory),
        model: 'sonnet',
        claudeArgs: ['--print', '--allowedTools', 'WebSearch,WebFetch,Bash'],
        onProgress: (type, data) => agg.forward('C', type, data),
        processKey: processKey ? `${processKey}:C` : null,
        timeout,
      });

      const teacherResult = parseTeacherResult(phaseC.response);
      for (const mem of teacherResult.memories) {
        try {
          await writeMemory(mem.name, mem.category, mem.content);
          newlyCreatedMemories.push(mem);
          await tryInstallFromMemory(mem, onProgress);
        } catch (err) {
          onProgress?.('warning', { message: `Failed to write memory ${mem.name}: ${err.message}` });
        }
      }
      agg.phase('C', `Teacher complete in ${Date.now() - tC}ms — wrote ${newlyCreatedMemories.length} file(s)`);
    }

    // ── Phase D: Executor ──
    const tD = Date.now();

    // Gather memory contents for selected memories + newly created ones from C
    const selectedContents = getContents(audit.selectedMemories || []);
    const newContents = newlyCreatedMemories.map(m => ({ name: m.name, category: m.category, content: m.content }));

    // Add site context detected from the prompt
    const siteContext = detectSiteContext(prompt);
    // Force-include self-awareness data for performance/latency questions
    const selfAwareness = detectSelfAwareness(prompt);
    const allMemoryContents = [...selectedContents, ...newContents, ...siteContext, ...selfAwareness];

    // Load persistent cross-session context
    const lastLog = loadLastSessionLog();

    const dSystemPrompt = modelDPrompt(prompt, outputSpec, allMemoryContents, lastLog);
    agg.phase('D', `Executing task (${(dSystemPrompt.length / 1024).toFixed(1)}KB prompt, ${allMemoryContents.length} memories)`);

    const phaseD = await runModel({
      userPrompt: prompt,
      systemPrompt: dSystemPrompt,
      model: null,
      claudeArgs: config.claudeArgs,
      onProgress: (type, data) => agg.forward('D', type, data),
      processKey: processKey ? `${processKey}:D` : null,
      timeout,
      cwd: stableCwd,
      resumeSessionId,
    });

    // Track Claude's session ID back to our internal session
    if (sessionContext && phaseD.sessionId) {
      setClaudeSessionId(sessionContext.id, phaseD.sessionId);
    }

    if (phaseD.questionRequest) {
      return {
        status: 'needs_user_input',
        questions: phaseD.questionRequest,
        sessionId: phaseD.sessionId,
        fullEvents: phaseD.fullEvents,
      };
    }

    lastDResponse = phaseD.response;
    lastDSessionId = phaseD.sessionId;
    lastDFullEvents = phaseD.fullEvents;
    agg.phase('D', `Executor complete in ${((Date.now() - tD) / 1000).toFixed(1)}s — ${(lastDResponse || '').length} chars`);

    // Check if Model D needs more tools/knowledge or failed entirely
    const needsMore = lastDResponse?.match(/\[NEEDS_MORE_TOOLS:\s*(.+?)\]/);
    if (needsMore && loopCount < MAX_FEEDBACK_LOOPS) {
      const toolsNeeded = needsMore[1].trim();
      if (seenToolRequests.has(toolsNeeded.toLowerCase())) {
        agg.phase('feedback', `Already attempted to resolve: ${toolsNeeded}. Stopping retry loop.`);
        break;
      }
      seenToolRequests.add(toolsNeeded.toLowerCase());
      agg.phase('feedback', `Model D needs: ${toolsNeeded}. Bypassing B and injecting targeted memory request (loop ${loopCount}/${MAX_FEEDBACK_LOOPS}).`);
      audit.missingMemories = [buildToolMemoryRequest(toolsNeeded)];
      previousFailure = lastDResponse;
      loopCount++;
      if (loopCount <= MAX_FEEDBACK_LOOPS) {
        agg.phase('C', `Creating 1 new memory file(s) for: ${toolsNeeded}`);
        const phaseC2 = await runModel({
          userPrompt: `Create the following memories:\n- ${audit.missingMemories[0].name}: ${audit.missingMemories[0].description}`,
          systemPrompt: modelCPrompt(audit.missingMemories, getFullInventory()),
          model: 'sonnet',
          claudeArgs: ['--print', '--allowedTools', 'WebSearch,WebFetch,Bash'],
          onProgress: (type, data) => agg.forward('C', type, data),
          processKey: processKey ? `${processKey}:C2` : null,
          timeout,
        });
        const teacherResult2 = parseTeacherResult(phaseC2.response);
        for (const mem of teacherResult2.memories) {
          try {
            await writeMemory(mem.name, mem.category, mem.content);
            newlyCreatedMemories.push(mem);
            await tryInstallFromMemory(mem, onProgress);
          } catch (err) {
            onProgress?.('warning', { message: `Failed to write memory ${mem.name}: ${err.message}` });
          }
        }
        // Re-run D with the new memory
        const updatedContents = [...getContents(audit.selectedMemories || []), ...newlyCreatedMemories.map(m => ({ name: m.name, category: m.category, content: m.content })), ...detectSiteContext(prompt)];
        const phaseD2 = await runModel({
          userPrompt: prompt,
          systemPrompt: modelDPrompt(prompt, outputSpec, updatedContents, lastLog || loadLastSessionLog()),
          model: null,
          claudeArgs: config.claudeArgs,
          onProgress: (type, data) => agg.forward('D', type, data),
          processKey: processKey ? `${processKey}:D2` : null,
          timeout,
          cwd: stableCwd,
          resumeSessionId,
        });
        if (phaseD2.questionRequest) {
          return { status: 'needs_user_input', questions: phaseD2.questionRequest, sessionId: phaseD2.sessionId, fullEvents: phaseD2.fullEvents };
        }
        lastDResponse = phaseD2.response;
        lastDSessionId = phaseD2.sessionId;
        lastDFullEvents = phaseD2.fullEvents;
      }
      break;
    }

    if (detectFailure(lastDResponse) && loopCount < MAX_FEEDBACK_LOOPS) {
      agg.phase('feedback', `Model D couldn't complete the task (loop ${loopCount}/${MAX_FEEDBACK_LOOPS}). Looping back to B for more knowledge.`);
      previousFailure = lastDResponse || '(executor returned empty response)';
      continue;
    }

    break;
  }

  // ── Save persistent memory for next session ──
  try {
    const { app } = require('electron');
    const logPath = path.join(app.getPath('userData'), 'last-session-log.json');
    fs.writeFileSync(logPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      userMessage: (prompt || '').slice(0, 2000),
      botResponse: (lastDResponse || '').slice(0, 3000),
    }, null, 2));
  } catch {}

  // ── Post-task learning (fire-and-forget) ──
  learnInBackground(prompt, outputSpec, lastDResponse, onProgress, processKey, timeout);

  const totalMs = Date.now() - tPipeline;
  const phasePath = `A+B${loopCount > 1 ? `→(${loopCount} loops)` : ''}→D`;
  agg.phase('done', `Pipeline complete in ${(totalMs / 1000).toFixed(1)}s [${phasePath}] — ${(lastDResponse || '').length} chars`);

  return {
    status: 'completed',
    response: lastDResponse,
    sessionId: lastDSessionId,
    fullEvents: lastDFullEvents,
  };
}

// Maps a [NEEDS_MORE_TOOLS] description to a targeted missingMemories entry for Model C.
function buildToolMemoryRequest(toolsNeeded) {
  const lower = toolsNeeded.toLowerCase();
  if (lower.includes('playwright')) {
    return {
      name: 'playwright-mcp-setup',
      category: 'knowledge',
      description: 'How to install and use the Playwright MCP server (claude mcp add playwright) on Windows so that Claude Code subprocesses have access to browser_navigate, browser_snapshot, browser_click and other browser automation tools. Include: exact install command, how to verify it is active, and how to use it in a claude --print subprocess.',
      reason: toolsNeeded,
    };
  }
  const slug = toolsNeeded.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50);
  return {
    name: `tool-setup-${slug}`,
    category: 'knowledge',
    description: `How to install and use: ${toolsNeeded}. Include exact install/setup commands for Windows and how to verify the tool is available.`,
    reason: toolsNeeded,
  };
}

// If a freshly-created memory describes tool installs, run them immediately so D can use them.
async function tryInstallFromMemory(mem, onProgress) {
  const content = mem.content || '';
  const lines = content.split('\n');
  const installLines = lines
    .map(l => l.match(/^\s*install_command:\s*(.+)/i))
    .filter(Boolean)
    .map(m => {
      let cmd = m[1].trim();
      cmd = cmd.replace(/[*_`]+$/, '').trim();
      cmd = cmd.replace(/^claude\b/, config.claudeCommand);
      return cmd;
    })
    .filter(cmd => cmd.length > 0);

  for (const cmd of installLines) {
    onProgress?.('tool_install', { message: `Installing: ${cmd}` });
    try {
      execSync(cmd, { stdio: 'pipe', timeout: 60000, shell: true });
      onProgress?.('tool_install', { message: `Installed: ${cmd}` });
    } catch (err) {
      onProgress?.('warning', { message: `Install failed (${cmd}): ${err.message?.slice(0, 200)}` });
    }
  }
}

function learnInBackground(prompt, outputSpec, executionResponse, onProgress, processKey, timeout) {
  const agg = createAggregator(onProgress);

  // Don't await — fire and forget
  (async () => {
    try {
      agg.phase('learn', 'Reviewing execution for learnings');

      const inventory = getFullInventory();
      const result = await runModel({
        userPrompt: `Review this execution and save any useful knowledge.\n\nPrompt: ${prompt}\n\nResponse summary: ${(executionResponse || '').slice(0, 2000)}`,
        systemPrompt: learnerPrompt(prompt, outputSpec, (executionResponse || '').slice(0, 3000), inventory),
        model: 'sonnet',
        claudeArgs: ['--print', '--max-turns', '2'],
        onProgress: (type, data) => agg.forward('learner', type, data),
        processKey: processKey ? `${processKey}:learner` : null,
        timeout: 120000,
      });

      const learnerResult = parseLearnerResult(result.response);
      for (const update of learnerResult.updates) {
        try {
          if (update.path && update.action === 'append') {
            await updateMemory(update.path, 'append', update.content);
          } else {
            await writeMemory(update.name, update.category, update.content);
          }
        } catch {}
      }
    } catch {
      // Non-fatal — learning is best-effort
    }
  })();
}

module.exports = { runPipeline };
