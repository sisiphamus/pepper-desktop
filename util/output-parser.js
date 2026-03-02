// Robust JSON extraction from model outputs.
// 4-level fallback: direct parse → code block → regex → defaults.

function extractJSON(raw) {
  const trimmed = (raw || '').trim();

  // 1. Direct parse
  try { return JSON.parse(trimmed); } catch {}

  // 2. Extract from ```json ... ``` code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1].trim()); } catch {}
  }

  // 3. Regex match first { ... } object (greedy, balanced braces)
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch {}
  }

  return null;
}

function parseOutputSpec(raw) {
  const parsed = extractJSON(raw);
  if (parsed && parsed.taskDescription) return parsed;

  return {
    taskDescription: (raw || '').slice(0, 500),
    outputType: 'text',
    outputFormat: { type: 'inline_text', structure: 'direct answer', deliveryMethod: 'inline' },
    requiredDomains: [],
    complexity: 'simple',
    estimatedSteps: 1,
    _fallback: true,
  };
}

// Normalise a single selectedMemories entry — handle { file, relevance, reason } format
// that B sometimes returns instead of { name, category, reason }.
function normaliseMemoryEntry(entry) {
  if (entry.name && entry.category) return entry; // already correct
  if (entry.file) {
    const parts = entry.file.replace(/\\/g, '/').split('/');
    const filename = parts[parts.length - 1].replace('.md', '');
    const dirPart = parts[parts.length - 2] || '';
    const categoryMap = { skills: 'skill', knowledge: 'knowledge', preferences: 'preference', sites: 'site' };
    const category = categoryMap[dirPart] || 'knowledge';
    return { name: filename, category, reason: entry.reason || entry.relevance || '' };
  }
  return entry;
}

function parseAuditResult(raw) {
  const parsed = extractJSON(raw);
  if (parsed) {
    // Normalise alternate key names models sometimes use
    if (!parsed.selectedMemories && parsed.relevant_memories) parsed.selectedMemories = parsed.relevant_memories;
    if (!parsed.selectedMemories && parsed.relevantMemories) parsed.selectedMemories = parsed.relevantMemories;
    if (!parsed.missingMemories && parsed.missing_memories) parsed.missingMemories = parsed.missing_memories;
    // Normalise entries that use { file } instead of { name, category }
    if (Array.isArray(parsed.selectedMemories)) {
      parsed.selectedMemories = parsed.selectedMemories.map(normaliseMemoryEntry);
      return parsed;
    }
  }

  return {
    selectedMemories: [],
    missingMemories: [],
    toolsNeeded: [],
    notes: raw || '',
  };
}

function parseTeacherResult(raw) {
  const parsed = extractJSON(raw);
  if (parsed && Array.isArray(parsed.memories)) return parsed;

  return { memories: [] };
}

function parseLearnerResult(raw) {
  const parsed = extractJSON(raw);
  if (parsed && Array.isArray(parsed.updates)) return parsed;

  return { updates: [] };
}

module.exports = { parseOutputSpec, parseAuditResult, parseTeacherResult, parseLearnerResult };
