// Shared logger — writes to both a log file and console.log().
// Pipeline modules import this instead of using process.stderr.write(),
// which is invisible in Electron on Windows (GUI subsystem app).

const fs = require('fs');

let logPath = null;

function init(filePath) {
  logPath = filePath;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  if (logPath) {
    try { fs.appendFileSync(logPath, line); } catch {}
  }
  console.log(msg);
}

module.exports = { init, log };
