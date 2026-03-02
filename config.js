// Config loader for Outdoors pipeline.
// Uses __dirname-relative paths for memory and outputs.

const path = require('path');
const fs = require('fs');

const defaults = {
  claudeCommand: 'claude',
  claudeArgs: ['--print', '--max-turns', '20'],
  maxResponseLength: 4000,
  messageTimeout: 900000,
  rateLimitPerMinute: 10,
  workingDirectory: process.cwd(),
  outputDirectory: path.join(__dirname, 'bot', 'outputs'),
  memoryDirectory: path.join(__dirname, 'bot', 'memory'),
  browserPreference: null, // 'edge' | 'chrome' | 'brave' | 'firefox' | null
};

let config = { ...defaults };

/**
 * Initialize config with overrides (called from main.js with Electron paths).
 */
function init(overrides) {
  // Mutate the existing object so all modules that imported `config`
  // by reference see the updated values (reassigning would break them).
  Object.keys(config).forEach(k => delete config[k]);
  Object.assign(config, defaults, overrides);
  // Ensure directories exist
  try { fs.mkdirSync(config.outputDirectory, { recursive: true }); } catch {}
  try { fs.mkdirSync(config.memoryDirectory, { recursive: true }); } catch {}
}

module.exports = { config, init };
