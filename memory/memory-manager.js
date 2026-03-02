// Memory manager — reads/writes all 4 memory categories from bot/memory/.
// Categories: skills, knowledge, preferences, sites.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { enqueueWrite } = require('./memory-write-queue');
const { config } = require('../config');

function getMemoryRoot() {
  return config.memoryDirectory || path.join(__dirname, '..', 'bot', 'memory');
}

let inventoryCache = null;

function readFirstLine(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    // Try YAML frontmatter description
    const descMatch = content.match(/^---[\s\S]*?description:\s*(.+)/m);
    if (descMatch) return descMatch[1].trim();
    // Try first heading
    const headingMatch = content.match(/^#\s+(.+)/m);
    if (headingMatch) return headingMatch[1].trim();
    // First non-empty line
    const firstLine = content.split('\n').find(l => l.trim());
    return firstLine ? firstLine.trim().slice(0, 100) : '(no description)';
  } catch {
    return '(unreadable)';
  }
}

function scanCategory(category, subdir) {
  const dir = path.join(getMemoryRoot(), subdir);
  if (!fs.existsSync(dir)) return [];

  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Skills are in subdirectories with SKILL.md
      const skillFile = path.join(dir, entry.name, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        results.push({
          name: entry.name,
          category,
          description: readFirstLine(skillFile),
          path: skillFile,
        });
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push({
        name: entry.name.replace('.md', ''),
        category,
        description: readFirstLine(path.join(dir, entry.name)),
        path: path.join(dir, entry.name),
      });
    }
  }

  return results;
}

function getFullInventory() {
  if (inventoryCache) return inventoryCache;

  const inventory = [
    ...scanCategory('skill', 'skills'),
    ...scanCategory('knowledge', 'knowledge'),
    ...scanCategory('preference', 'preferences'),
    ...scanCategory('site', 'sites'),
  ];

  inventoryCache = inventory;
  return inventory;
}

function invalidateCache() {
  inventoryCache = null;
}

function getContents(selections) {
  return selections.map(sel => {
    const inventory = getFullInventory();
    const match = inventory.find(m => m.name === sel.name && m.category === sel.category);
    if (!match) return { ...sel, content: '(not found)' };

    try {
      const content = fs.readFileSync(match.path, 'utf-8');
      return { ...sel, content, path: match.path };
    } catch {
      return { ...sel, content: '(unreadable)' };
    }
  });
}

function writeMemory(name, category, content) {
  const categoryDirs = {
    skill: 'skills',
    knowledge: 'knowledge',
    preference: 'preferences',
    site: 'sites',
  };

  const subdir = categoryDirs[category];
  if (!subdir) throw new Error(`Unknown memory category: ${category}`);

  return enqueueWrite(() => {
    let filepath;
    if (category === 'skill') {
      const dir = path.join(getMemoryRoot(), subdir, name);
      fs.mkdirSync(dir, { recursive: true });
      filepath = path.join(dir, 'SKILL.md');
    } else {
      const dir = path.join(getMemoryRoot(), subdir);
      fs.mkdirSync(dir, { recursive: true });
      filepath = path.join(dir, `${name}.md`);
    }

    atomicWrite(filepath, content);
    invalidateCache();
    return filepath;
  });
}

function updateMemory(filePath, action, content) {
  return enqueueWrite(() => {
    if (action === 'append') {
      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
      atomicWrite(filePath, existing + '\n\n' + content);
    } else {
      atomicWrite(filePath, content);
    }
    invalidateCache();
  });
}

/** Write to a temp file then rename — atomic on same filesystem. */
function atomicWrite(filepath, content) {
  const tmpPath = filepath + `.tmp.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filepath);
}

function detectSiteContext(prompt) {
  const sitesDir = path.join(getMemoryRoot(), 'sites');
  if (!fs.existsSync(sitesDir)) return [];

  const promptLower = prompt.toLowerCase();
  const matches = [];

  try {
    const files = fs.readdirSync(sitesDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const name = file.replace('.md', '');
      if (promptLower.includes(name.toLowerCase())) {
        try {
          matches.push({
            name,
            category: 'site',
            content: fs.readFileSync(path.join(sitesDir, file), 'utf-8'),
          });
        } catch {}
      }
    }
  } catch {}

  // Auto-inject browser-preferences when any site context was matched
  // (if a site is mentioned, browser automation is likely needed)
  if (matches.length > 0) {
    const browserPrefs = path.join(getMemoryRoot(), 'preferences', 'browser-preferences.md');
    if (fs.existsSync(browserPrefs)) {
      try {
        matches.push({
          name: 'browser-preferences',
          category: 'preference',
          content: fs.readFileSync(browserPrefs, 'utf-8'),
        });
      } catch {}
    }
  }

  return matches;
}

const SELF_AWARENESS_KEYWORDS = [
  'slow', 'fast', 'speed', 'latency', 'performance', 'response time',
  'took so long', 'taking so long', 'how long', 'why so long',
  'check your logs', 'check logs', 'your logs',
  'bottleneck', 'pipeline', 'improve yourself',
  'why did you', 'why are you', 'what took you',
];

function detectSelfAwareness(prompt) {
  const lower = prompt.toLowerCase();
  const matched = SELF_AWARENESS_KEYWORDS.some(kw => lower.includes(kw));
  if (!matched) return [];

  const filePath = path.join(getMemoryRoot(), 'knowledge', 'self-awareness.md');
  if (!fs.existsSync(filePath)) return [];

  try {
    return [{
      name: 'self-awareness',
      category: 'knowledge',
      content: fs.readFileSync(filePath, 'utf-8'),
    }];
  } catch {
    return [];
  }
}

module.exports = { getFullInventory, invalidateCache, getContents, writeMemory, updateMemory, detectSiteContext, detectSelfAwareness };
