// Merges progress events from sequential sub-models into a single onProgress callback.
// Tags each event with the model name and emits pipeline phase markers.

function createAggregator(onProgress) {
  return {
    phase(name, description) {
      onProgress?.('pipeline_phase', { phase: name, description });
    },
    forward(modelName, type, data) {
      onProgress?.(type, { ...data, model: modelName });
    },
  };
}

module.exports = { createAggregator };
