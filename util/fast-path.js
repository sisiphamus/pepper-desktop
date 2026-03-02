// Fast-path detection — identifies simple messages that can skip the full pipeline.

const SIMPLE_PATTERNS = /^(what|who|when|where|how|why|is|are|can|does|do|did|hi|hey|hello|thanks|ok|yes|no)\b/i;

function isLikelySimple(prompt) {
  return prompt.length < 200 && SIMPLE_PATTERNS.test(prompt.trim());
}

module.exports = { isLikelySimple };
