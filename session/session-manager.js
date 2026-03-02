// Session manager — creates isolated execution contexts for concurrent sessions.
// Each session gets its own short-term directory (images) and output directory.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');

function getMemoryRoot() {
  return config.memoryDirectory || path.join(__dirname, '..', 'bot', 'memory');
}

function getOutputRoot() {
  return config.outputDirectory || path.join(__dirname, '..', 'bot', 'outputs');
}

function getShortTermRoot() {
  return path.join(getMemoryRoot(), 'short-term');
}

// Active sessions: Map<sessionId, SessionContext>
const activeSessions = new Map();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Create a new isolated session.
 * @param {string} processKey - routing key (e.g. "tg:chat:123")
 * @param {string} transport - "telegram" | "web" | etc
 * @returns {SessionContext}
 */
function createSession(processKey, transport) {
  const id = crypto.randomUUID();
  const shortTermDir = path.join(getShortTermRoot(), id);
  fs.mkdirSync(shortTermDir, { recursive: true });

  const ctx = {
    id,
    processKey,
    transport,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    shortTermDir,
    outputDir: null, // created on demand
    claudeSessionId: null, // Claude CLI's --resume session ID
    status: 'active',
  };

  activeSessions.set(id, ctx);
  return ctx;
}

function getSession(id) {
  return activeSessions.get(id) || null;
}

function findSessionByClaudeId(claudeSessionId) {
  for (const ctx of activeSessions.values()) {
    if (ctx.claudeSessionId === claudeSessionId) return ctx;
  }
  return null;
}

function touchSession(id) {
  const ctx = activeSessions.get(id);
  if (ctx) ctx.lastActivity = Date.now();
}

function getOutputDir(sessionId) {
  const ctx = activeSessions.get(sessionId);
  if (!ctx) return getOutputRoot(); // fallback to global
  if (!ctx.outputDir) {
    ctx.outputDir = path.join(getOutputRoot(), `session-${sessionId.slice(0, 8)}`);
    fs.mkdirSync(ctx.outputDir, { recursive: true });
  }
  return ctx.outputDir;
}

function getShortTermDir(sessionId) {
  const ctx = activeSessions.get(sessionId);
  if (!ctx) return getShortTermRoot();
  return ctx.shortTermDir;
}

function setClaudeSessionId(sessionId, claudeSessionId) {
  const ctx = activeSessions.get(sessionId);
  if (ctx) ctx.claudeSessionId = claudeSessionId;
}

function closeSession(sessionId) {
  const ctx = activeSessions.get(sessionId);
  if (!ctx) return;
  ctx.status = 'closed';
  cleanupDir(ctx.shortTermDir);
  activeSessions.delete(sessionId);
}

function listActiveSessions() {
  return Array.from(activeSessions.values()).map(ctx => ({
    id: ctx.id,
    processKey: ctx.processKey,
    transport: ctx.transport,
    createdAt: ctx.createdAt,
    lastActivity: ctx.lastActivity,
    status: ctx.status,
    claudeSessionId: ctx.claudeSessionId,
  }));
}

function cleanupStaleSessions() {
  const now = Date.now();
  for (const [id, ctx] of activeSessions) {
    if (now - ctx.lastActivity > SESSION_TTL_MS) {
      closeSession(id);
    }
  }
}

function cleanupOrphanedSessionDirs() {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const SESSION_DIR_RE = /^session-[0-9a-f]{8}$/;

  try {
    const stRoot = getShortTermRoot();
    if (fs.existsSync(stRoot)) {
      for (const entry of fs.readdirSync(stRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && UUID_RE.test(entry.name)) {
          if (!activeSessions.has(entry.name)) {
            cleanupDir(path.join(stRoot, entry.name));
          }
        }
      }
    }
  } catch {}

  try {
    const outRoot = getOutputRoot();
    if (fs.existsSync(outRoot)) {
      for (const entry of fs.readdirSync(outRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && SESSION_DIR_RE.test(entry.name)) {
          const prefix = entry.name.replace('session-', '');
          const hasActive = Array.from(activeSessions.keys()).some(id => id.startsWith(prefix));
          if (!hasActive) {
            cleanupDir(path.join(outRoot, entry.name));
          }
        }
      }
    }
  } catch {}
}

function cleanupDir(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// Periodic cleanup every 5 minutes
setInterval(cleanupStaleSessions, 5 * 60 * 1000);

module.exports = {
  createSession, getSession, findSessionByClaudeId, touchSession,
  getOutputDir, getShortTermDir, setClaudeSessionId,
  closeSession, listActiveSessions, cleanupStaleSessions, cleanupOrphanedSessionDirs,
};
