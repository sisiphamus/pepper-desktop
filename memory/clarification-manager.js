// Clarification manager — handles needs_user_input → user answers → resumed flows.
// Uses in-memory Map (no file persistence) to avoid race conditions between
// concurrent sessions. Clarifications are ephemeral — if the app restarts,
// the Claude subprocess that asked the question is also dead, so pending
// clarifications are correctly discarded.

const store = new Map();

function get(key) {
  return store.get(key) || null;
}

function setPending(key, { originalPrompt, pendingQuestions, sessionId }) {
  store.set(key, {
    originalPrompt,
    pendingQuestions,
    sessionId,
    answers: [],
    timestamp: Date.now(),
  });
}

function appendAnswer(key, answer) {
  const entry = store.get(key);
  if (!entry) return;
  entry.answers.push(answer);
}

function buildAugmentedPrompt(entry) {
  const parts = [entry.originalPrompt];

  if (entry.answers.length > 0) {
    parts.push('\n\n[Previous clarification Q&A]:');
    for (let i = 0; i < entry.answers.length; i++) {
      const q = entry.pendingQuestions?.questions?.[i]?.question || `Question ${i + 1}`;
      parts.push(`Q: ${q}`);
      parts.push(`A: ${entry.answers[i]}`);
    }
    parts.push('\nPlease continue with the task using the above answers.');
  }

  return parts.join('\n');
}

function clear(key) {
  store.delete(key);
}

module.exports = { get, setPending, appendAnswer, buildAugmentedPrompt, clear };
