// Claude bridge — drop-in adapter for the Pepper pipeline.
// Exposes executeClaudePrompt() which runs the full A→B→C?→D→Learn pipeline.
// Includes clarification management for multi-turn question flows.

const { runPipeline } = require('./pipeline/orchestrator');
const { runModel } = require('./pipeline/model-runner');
const { config, init: initConfig } = require('./config');
const { createSession, getOutputDir } = require('./session/session-manager');
const registry = require('./util/process-registry');
const clarifications = require('./memory/clarification-manager');
const { detectSiteContext } = require('./memory/memory-manager');

/**
 * Execute a prompt through the full Pepper pipeline.
 *
 * @param {string} prompt - User's message
 * @param {object} options
 * @param {function} options.onProgress - Progress callback (type, data)
 * @param {string} options.processKey - Process tracking key
 * @param {string} options.resumeSessionId - Resume existing conversation
 * @param {string} options.clarificationKey - Key for clarification state tracking
 * @param {number} options.timeout - Timeout in ms
 * @returns {Promise<{status, response, sessionId, fullEvents, questions?}>}
 */
async function executeClaudePrompt(prompt, options = {}) {
  const {
    onProgress,
    processKey,
    resumeSessionId,
    clarificationKey,
    timeout,
    sessionContext: existingSessionContext,
  } = options;

  const cKey = clarificationKey || processKey;

  // Check for pending clarification — if the user is answering a previous question
  if (cKey) {
    const pending = clarifications.get(cKey);
    if (pending) {
      clarifications.appendAnswer(cKey, prompt);
      const augmented = clarifications.buildAugmentedPrompt(pending);
      clarifications.clear(cKey);
      // Re-run with the augmented prompt
      return executeClaudePrompt(augmented, {
        ...options,
        resumeSessionId: pending.sessionId,
      });
    }
  }

  try {
    // Create an internal session for file isolation
    const sessionContext = existingSessionContext || createSession(processKey || 'tg:default', 'telegram');

    const result = await runPipeline(prompt, {
      onProgress,
      processKey,
      timeout: timeout || config.messageTimeout,
      resumeSessionId,
      sessionContext,
    });

    // Handle clarification from pipeline
    if (result.status === 'needs_user_input' && cKey) {
      clarifications.setPending(cKey, {
        originalPrompt: prompt,
        pendingQuestions: result.questions,
        sessionId: result.sessionId,
      });
    }

    return result;
  } catch (err) {
    return {
      status: 'error',
      response: `Pipeline error: ${err.message}`,
      sessionId: null,
      fullEvents: [],
    };
  }
}

function killProcess(key) {
  return registry.kill(key);
}

function getActiveProcessSummary() {
  return registry.getSummary();
}

function getClarificationState(key) {
  return clarifications.get(key);
}

function clearClarificationState(key) {
  clarifications.clear(key);
}

module.exports = {
  executeClaudePrompt,
  initConfig,
  killProcess,
  getActiveProcessSummary,
  getClarificationState,
  clearClarificationState,
};
