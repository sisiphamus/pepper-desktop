// Process registry — tracks active pipelines and their subprocesses.
// Supports kill-by-key (kills all subprocesses matching a pipeline key).

const processes = new Map(); // key → { proc, label, startedAt }
let changeListener = null;
let activityListener = null;

function register(key, proc, label = '') {
  processes.set(key, { proc, label, startedAt: Date.now() });
  changeListener?.();
}

function unregister(key) {
  processes.delete(key);
  changeListener?.();
}

function kill(key) {
  let killed = false;
  for (const [k, entry] of processes) {
    if (k === key || k.startsWith(key + ':')) {
      entry.proc._stoppedByUser = true;
      try { entry.proc.kill('SIGTERM'); } catch {}
      killed = true;
    }
  }
  return killed;
}

function has(key) {
  for (const k of processes.keys()) {
    if (k === key || k.startsWith(key + ':')) return true;
  }
  return false;
}

function getSummary() {
  const numbered = [];
  const unnumbered = [];
  const seen = new Set();

  for (const [key, entry] of processes) {
    const pipelineKey = key.replace(/:[A-Z]$/, '').replace(/:learner$/, '');
    if (seen.has(pipelineKey)) continue;
    seen.add(pipelineKey);

    const convMatch = pipelineKey.match(/:conv:(\d+)/);
    const item = {
      key: pipelineKey,
      label: entry.label,
      startedAt: entry.startedAt,
    };

    if (convMatch) {
      item.number = parseInt(convMatch[1], 10);
      numbered.push(item);
    } else {
      unnumbered.push(item);
    }
  }

  return { numbered, unnumbered };
}

function setChangeListener(fn) {
  changeListener = fn;
}

function setActivityListener(fn) {
  activityListener = fn;
}

function emitActivity(processKey, type, summary) {
  activityListener?.(processKey, type, summary);
}

module.exports = { register, unregister, kill, has, getSummary, setChangeListener, setActivityListener, emitActivity };
