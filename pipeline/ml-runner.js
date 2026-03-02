// ml-runner.js — Node.js integration layer for the local ML inference subprocess.
// Maintains a pool of persistent Python subprocesses for concurrent session throughput.
// Communicates via newline-delimited JSON over stdin/stdout.

const { spawn } = require('child_process');
const path = require('path');
const { log } = require('../util/logger');

// When packaged with asar + asarUnpack, ml/ files live at app.asar.unpacked/ml/
// instead of app.asar/ml/. Replace .asar with .asar.unpacked in the path.
const RAW_INFER = path.join(__dirname, '..', 'ml', 'infer.py');
const INFER_SCRIPT = RAW_INFER.replace('app.asar', 'app.asar.unpacked');
const PYTHON = process.env.PEPPER_PYTHON || 'python';
const CALL_TIMEOUT_MS = 30000;
const POOL_SIZE = 2;

class MLWorker {
  constructor() {
    this.proc = null;
    this.stdoutBuffer = '';
    this.pendingQueue = [];
  }

  startProcess() {
    log(`[ml-runner] Starting worker (${PYTHON} ${INFER_SCRIPT})`);
    this.proc = spawn(PYTHON, [INFER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    this.proc.stdout.on('data', chunk => {
      this.stdoutBuffer += chunk.toString();
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop(); // keep incomplete last chunk
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const pending = this.pendingQueue.shift();
        if (!pending) {
          log(`[ml-runner] Unexpected output: ${trimmed}`);
          continue;
        }
        clearTimeout(pending.timer);
        try {
          pending.resolve(JSON.parse(trimmed));
        } catch (e) {
          pending.reject(new Error(`[ml-runner] JSON parse failed: ${trimmed}`));
        }
      }
    });

    this.proc.stderr.on('data', chunk => {
      log(`[ml-runner] ${chunk.toString().trimEnd()}`);
    });

    this.proc.on('close', code => {
      log(`[ml-runner] subprocess exited (code ${code})`);
      this.proc = null;
      while (this.pendingQueue.length > 0) {
        const pending = this.pendingQueue.shift();
        clearTimeout(pending.timer);
        pending.reject(new Error(`[ml-runner] subprocess exited unexpectedly (code ${code})`));
      }
    });

    this.proc.on('error', err => {
      log(`[ml-runner] spawn error: ${err.message}`);
      this.proc = null;
      while (this.pendingQueue.length > 0) {
        const pending = this.pendingQueue.shift();
        clearTimeout(pending.timer);
        pending.reject(err);
      }
    });
  }

  ensureProcess() {
    if (!this.proc || this.proc.killed) {
      this.startProcess();
    }
  }

  call(payload) {
    return new Promise((resolve, reject) => {
      this.ensureProcess();
      const timer = setTimeout(() => {
        const idx = this.pendingQueue.findIndex(p => p.timer === timer);
        if (idx !== -1) this.pendingQueue.splice(idx, 1);
        reject(new Error(`[ml-runner] timeout after ${CALL_TIMEOUT_MS}ms for task: ${payload.task}`));
      }, CALL_TIMEOUT_MS);

      this.pendingQueue.push({ resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pendingQueue.pop();
        reject(err);
      }
    });
  }

  shutdown() {
    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      this.proc = null;
    }
  }
}

// Worker pool — round-robin dispatch
const workers = [];
let nextIdx = 0;

function getWorker() {
  while (workers.length < POOL_SIZE) {
    workers.push(new MLWorker());
  }
  const worker = workers[nextIdx % workers.length];
  nextIdx++;
  return worker;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Phase A: classify the prompt into output type labels.
 * Returns a JSON string compatible with parseOutputSpec().
 */
async function runPhaseA(prompt) {
  const t = Date.now();
  try {
    const result = await getWorker().call({ task: 'phase_a', prompt });
    log(`[ml-runner] Phase A complete in ${Date.now() - t}ms`);
    return JSON.stringify(result);
  } catch (err) {
    log(`[ml-runner] Phase A failed after ${Date.now() - t}ms: ${err.message}`);
    // Return a safe fallback that parseOutputSpec can handle
    return JSON.stringify({
      taskDescription: (prompt || '').slice(0, 500),
      outputType: 'text',
      outputLabels: { text: true, picture: false, command: false, presentation: false, specificFile: false, other: false },
      outputFormat: { type: 'inline_text', structure: 'direct answer', deliveryMethod: 'inline' },
      requiredDomains: [],
      complexity: 'simple',
      estimatedSteps: 1,
    });
  }
}

/**
 * Phase B: retrieve relevant memory files via TF-IDF cosine similarity.
 * inventory is the array from getFullInventory().
 * Returns a JSON string compatible with parseAuditResult().
 */
async function runPhaseB(prompt, inventory) {
  const t = Date.now();
  try {
    const result = await getWorker().call({ task: 'phase_b', prompt, inventory });
    const selected = result.selectedMemories?.length || 0;
    log(`[ml-runner] Phase B complete in ${Date.now() - t}ms — ${selected}/${inventory.length} files selected`);
    return JSON.stringify(result);
  } catch (err) {
    log(`[ml-runner] Phase B failed after ${Date.now() - t}ms: ${err.message}`);
    return JSON.stringify({
      selectedMemories: [],
      missingMemories: [],
      toolsNeeded: [],
      notes: `ML retrieval failed: ${err.message}`,
    });
  }
}

/**
 * Gracefully shut down all Python subprocesses.
 */
function shutdown() {
  for (const worker of workers) {
    worker.shutdown();
  }
  workers.length = 0;
}

module.exports = { runPhaseA, runPhaseB, shutdown };
