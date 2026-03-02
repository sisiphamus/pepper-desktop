const { app, BrowserWindow, ipcMain, Tray, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Dev mode — skip installer, auto-reload on changes
// ---------------------------------------------------------------------------
const isDev = !!process.defaultApp;

if (isDev) {
  try {
    require('electron-reloader')(module, {
      watchRenderer: true,
      ignore: ['node_modules/**', 'dist/**', 'bot/outputs/**', 'bot/memory/**', 'ml/models/**'],
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Pipeline integration — Pepper's A→B→C?→D→Learn pipeline
// ---------------------------------------------------------------------------
const { executeClaudePrompt, initConfig } = require('./claude-bridge');

// ---------------------------------------------------------------------------
// Single instance lock (enforce in all modes to prevent duplicate polling)
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const CONFIG_DIR = path.join(app.getPath('userData'));
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LOG_PATH = path.join(CONFIG_DIR, 'outdoors.log');
const SESSIONS_PATH = path.join(CONFIG_DIR, 'sessions.json');
const LAST_LOG_PATH = path.join(CONFIG_DIR, 'last-session-log.json');

// ---------------------------------------------------------------------------
// Logging — shared logger so pipeline modules can also write to console + file
// ---------------------------------------------------------------------------
const { log, init: initLogger } = require('./util/logger');
try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch {}
initLogger(LOG_PATH);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

// ---------------------------------------------------------------------------
// Browser preference — paths, launching, and MCP config
// ---------------------------------------------------------------------------
const BROWSER_PATHS = {
  edge: [
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  brave: [
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ],
  firefox: [
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
  ],
};

let browserProcess = null;

function findBrowserExe(browser) {
  const paths = BROWSER_PATHS[browser] || [];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function launchBrowserWithCDP(browser) {
  if (!browser) return;

  if (browserProcess) {
    try { browserProcess.kill(); } catch {}
    browserProcess = null;
  }

  if (browser === 'firefox') {
    const exe = findBrowserExe('firefox');
    if (exe) {
      browserProcess = spawn(exe, ['--start-debugger-server', '2828'], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
      browserProcess.unref();
      log('[Browser] Launched Firefox with Marionette on port 2828');
    } else {
      log('[Browser] Firefox executable not found, Playwright will use its own browser');
    }
    return;
  }

  const exe = findBrowserExe(browser);
  if (!exe) {
    log(`[Browser] ${browser} executable not found at known paths`);
    return;
  }

  // Check if port 9222 is already in use
  try {
    execSync('powershell -Command "Get-NetTCPConnection -LocalPort 9222 -ErrorAction SilentlyContinue"', {
      stdio: 'pipe',
      timeout: 5000,
      shell: true,
    });
    log('[Browser] Port 9222 already in use, browser likely running with CDP');
    return;
  } catch {
    // Port not in use — proceed to launch
  }

  browserProcess = spawn(exe, ['--remote-debugging-port=9222'], {
    detached: true,
    stdio: 'ignore',
    shell: false,
  });
  browserProcess.unref();
  log(`[Browser] Launched ${browser} with CDP on port 9222`);
}

function updatePlaywrightMcpConfig(browser) {
  try {
    const homeClaudeConfig = path.join(app.getPath('home'), '.claude.json');
    let existingConfig = {};
    if (fs.existsSync(homeClaudeConfig)) {
      try { existingConfig = JSON.parse(fs.readFileSync(homeClaudeConfig, 'utf-8')); } catch {}
    }
    if (!existingConfig.mcpServers) existingConfig.mcpServers = {};

    if (browser === 'firefox') {
      existingConfig.mcpServers.playwright = {
        command: 'npx',
        args: ['@anthropic-ai/mcp-playwright@latest'],
      };
    } else {
      existingConfig.mcpServers.playwright = {
        command: 'npx',
        args: ['@anthropic-ai/mcp-playwright@latest', '--cdp-endpoint', 'http://localhost:9222'],
      };
    }

    fs.writeFileSync(homeClaudeConfig, JSON.stringify(existingConfig, null, 2));
    log(`[Browser] Updated Playwright MCP config for ${browser}`);
  } catch (err) {
    log(`[Browser] Failed to update Playwright MCP config: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Recursive directory copy (for copying bundled memory out of .asar)
// ---------------------------------------------------------------------------
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Workspace mirroring — make Claude CLI's CWD match the local dev structure
// ---------------------------------------------------------------------------

/**
 * Create or verify a Windows directory junction.
 * Junctions don't require admin rights and are transparent to file I/O.
 */
function ensureJunction(linkPath, targetPath) {
  const resolvedTarget = path.resolve(targetPath);
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      if (path.resolve(fs.readlinkSync(linkPath)) === resolvedTarget) return;
      fs.unlinkSync(linkPath);
    } else if (stat.isDirectory()) {
      // Real directory — only replace if empty
      try { fs.rmdirSync(linkPath); } catch {
        log(`[Workspace] Cannot create junction at ${linkPath} — directory not empty`);
        return;
      }
    }
  } catch {
    // Doesn't exist — good
  }
  try {
    fs.symlinkSync(resolvedTarget, linkPath, 'junction');
  } catch (err) {
    log(`[Workspace] Failed to create junction ${linkPath} → ${resolvedTarget}: ${err.message}`);
  }
}

/**
 * Scan the memory directory for available skill names.
 */
function listAvailableSkills(memDir) {
  const skillsDir = path.join(memDir, 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  const skills = [];
  try {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md'))) {
          skills.push(entry.name);
        }
      }
    }
  } catch {}
  return skills;
}

/**
 * Generate CLAUDE.md from the bundled template with browser/skills substitutions.
 */
function generateClaudeMd(browserPref, memDir) {
  const browserName = {
    edge: 'Microsoft Edge', chrome: 'Google Chrome',
    brave: 'Brave', firefox: 'Firefox',
  }[browserPref] || 'Microsoft Edge';

  const skills = listAvailableSkills(memDir);
  const skillsList = skills.map(s => `(bot/memory/skills/${s})`).join('\n');

  // Read bundled template
  let template;
  try {
    template = fs.readFileSync(path.join(__dirname, 'CLAUDE.md.template'), 'utf-8');
  } catch (err) {
    log(`[Workspace] Cannot read CLAUDE.md.template: ${err.message}`);
    return null;
  }

  return template
    .replace(/\{\{BROWSER_NAME\}\}/g, browserName)
    .replace('{{SKILLS_LIST}}', skillsList);
}

/**
 * Generate .mcp.json with Playwright configured for the user's browser,
 * plus any MCP servers from the global ~/.claude.json.
 */
function generateMcpJson(browserPref) {
  const mcpConfig = { mcpServers: {} };

  // Playwright MCP — same package and flags as the local pepperv1 version
  if (browserPref === 'firefox') {
    mcpConfig.mcpServers.playwright = {
      command: 'npx',
      args: ['@playwright/mcp@latest', '--browser', 'firefox'],
    };
  } else {
    const browserArg = { edge: 'msedge', chrome: 'chrome', brave: 'chromium' }[browserPref] || 'msedge';
    mcpConfig.mcpServers.playwright = {
      command: 'npx',
      args: [
        '@playwright/mcp@latest',
        '--browser', browserArg,
        '--cdp-endpoint', 'http://localhost:9222',
        '--timeout-navigation', '10000',
        '--timeout-action', '5000',
      ],
    };
  }

  // Pull Todoist and Notion MCP configs from global ~/.claude.json
  // so the project-scoped .mcp.json has all tools the local version has.
  try {
    const homeClaudeConfig = path.join(app.getPath('home'), '.claude.json');
    if (fs.existsSync(homeClaudeConfig)) {
      const globalCfg = JSON.parse(fs.readFileSync(homeClaudeConfig, 'utf-8'));
      const servers = globalCfg.mcpServers || {};
      if (servers.todoist) mcpConfig.mcpServers.todoist = servers.todoist;
      if (servers.notion) mcpConfig.mcpServers.notion = servers.notion;
    }
  } catch {}

  return mcpConfig;
}

/**
 * Write CLAUDE.md, .mcp.json, and set up bot/ junctions inside the workspace
 * so Claude CLI's CWD mirrors the local pepperv1/backend/ structure exactly.
 */
function writeProjectFiles(workspaceDir, browserPref, memDir, outputDir) {
  // 1. CLAUDE.md
  const claudeMd = generateClaudeMd(browserPref, memDir);
  if (claudeMd) {
    fs.writeFileSync(path.join(workspaceDir, 'CLAUDE.md'), claudeMd);
    log('[Workspace] Wrote CLAUDE.md');
  }

  // 2. .mcp.json
  const mcpJson = generateMcpJson(browserPref);
  fs.writeFileSync(path.join(workspaceDir, '.mcp.json'), JSON.stringify(mcpJson, null, 2));
  log(`[Workspace] Wrote .mcp.json (${Object.keys(mcpJson.mcpServers).join(', ')})`);

  // 3. bot/ directory structure via junctions
  //    This makes `bot/memory/`, `bot/outputs/`, `bot/logs/` work as relative
  //    paths inside the workspace — identical to the local pepperv1/backend/ layout.
  const botInWorkspace = path.join(workspaceDir, 'bot');
  fs.mkdirSync(botInWorkspace, { recursive: true });

  ensureJunction(path.join(botInWorkspace, 'memory'), memDir);
  ensureJunction(path.join(botInWorkspace, 'outputs'), outputDir);

  // Logs directory — create if missing, then junction
  const logsDir = path.join(path.dirname(memDir), 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  ensureJunction(path.join(botInWorkspace, 'logs'), logsDir);

  log(`[Workspace] Junctions: memory→${memDir}, outputs→${outputDir}, logs→${logsDir}`);
}

/**
 * Save a full conversation log to bot/logs/ (mirrors local pepperv1 behaviour).
 */
function saveConversationLog(sender, prompt, result) {
  try {
    const logsDir = path.join(app.getPath('userData'), 'bot', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeSender = (sender || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
    const filename = `${timestamp}_${safeSender}.json`;
    fs.writeFileSync(path.join(logsDir, filename), JSON.stringify({
      timestamp: new Date().toISOString(),
      sender,
      prompt: (prompt || '').slice(0, 10000),
      response: (result.response || '').slice(0, 10000),
      sessionId: result.sessionId || null,
      status: result.status || 'unknown',
      events: (result.fullEvents || []).map(e => ({
        type: e.type,
        subtype: e.subtype,
        tool_name: e.tool_name,
        session_id: e.session_id,
      })),
    }, null, 2));
  } catch (err) {
    log(`[Log] Failed to save conversation log: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Persistent memory — last session log for cross-session context
// ---------------------------------------------------------------------------
function saveLastLog(chatId, userMessage, botResponse) {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      chatId,
      userMessage: (userMessage || '').slice(0, 2000),
      botResponse: (botResponse || '').slice(0, 3000),
    };
    fs.writeFileSync(LAST_LOG_PATH, JSON.stringify(entry, null, 2));
  } catch {}
}

function loadLastLog() {
  try {
    return JSON.parse(fs.readFileSync(LAST_LOG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function buildLastLogContext() {
  const lastLog = loadLastLog();
  if (!lastLog) return '';
  return `\n\n--- PREVIOUS SESSION CONTEXT (this may or may not be relevant) ---\nTimestamp: ${lastLog.timestamp}\nUser said: ${lastLog.userMessage}\nAssistant responded: ${lastLog.botResponse}\n--- END PREVIOUS SESSION CONTEXT ---\n`;
}

// ---------------------------------------------------------------------------
// Session persistence (chatId -> sessionId mapping)
// ---------------------------------------------------------------------------
function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSessions(sessions) {
  const tmp = SESSIONS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
  fs.renameSync(tmp, SESSIONS_PATH);
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let mainWindow = null;
let tray = null;
let botPolling = false;
let botPollTimeout = null;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createSetupWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 660,
    minWidth: 600,
    minHeight: 500,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#FAF6F1',
    title: 'Outdoors',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.setMenuBarVisibility(false);

  if (isDev) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        mainWindow.webContents.toggleDevTools();
      }
    });
  }

  mainWindow.loadFile(path.join(__dirname, 'src', 'setup', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------
function createTray() {
  // Use a text-based icon as fallback
  const iconPath = path.join(__dirname, 'src', 'assets', 'icon.png');
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  } else {
    // Create a simple 16x16 colored square
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon.isEmpty() ? nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2M8w8DwnwEPYMSnmHGQGcC4atUqvC5gGjUAPRAYcGEwagBBLxh1AV4XAABClQ8RwrJ/YwAAAABJRU5ErkJggg=='
  ) : icon);
  tray.setToolTip('Outdoors — running');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Outdoors', enabled: false },
    { type: 'separator' },
    { label: 'Status: Running', enabled: false },
    { type: 'separator' },
    {
      label: 'View Logs',
      click: () => {
        spawn('powershell', ['-Command', `Get-Content -Path '${LOG_PATH}' -Wait -Tail 100`], {
          detached: true,
          stdio: 'ignore',
          shell: true,
        }).unref();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Outdoors',
      click: () => {
        botPolling = false;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

// ---------------------------------------------------------------------------
// Auto-launch on startup
// ---------------------------------------------------------------------------
async function enableAutoLaunch() {
  if (isDev) { log('[Outdoors] DEV MODE: skipping auto-launch'); return; }
  try {
    const AutoLaunch = require('auto-launch');
    const launcher = new AutoLaunch({
      name: 'Outdoors',
      path: app.getPath('exe'),
      isHidden: true,
    });
    const isEnabled = await launcher.isEnabled();
    if (!isEnabled) await launcher.enable();
    log('[Outdoors] Auto-launch enabled');
  } catch (err) {
    log(`[Outdoors] Auto-launch error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Dependency checking / installation
// ---------------------------------------------------------------------------
function commandExists(cmd) {
  try {
    execSync(`where ${cmd}`, { stdio: 'ignore', shell: true });
    return true;
  } catch {
    return false;
  }
}

function getClaudeVersion() {
  try {
    return execSync('claude --version', { encoding: 'utf-8', shell: true, timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Claude CLI bridge
// ---------------------------------------------------------------------------
function runClaude(userMessage, sessionId) {
  return new Promise((resolve, reject) => {
    const args = ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    // Clean CLAUDE* env vars to avoid conflicts
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE')) delete env[key];
    }

    const proc = spawn('claude', args, {
      cwd: path.join(app.getPath('userData'), 'workspace'),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let response = '';
    let newSessionId = null;
    let buffer = '';

    // Inject previous session context if not resuming an existing session
    if (!sessionId) {
      const lastLogContext = buildLastLogContext();
      if (lastLogContext) {
        proc.stdin.write(lastLogContext + '\n');
      }
    }
    proc.stdin.write(userMessage);
    proc.stdin.end();

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }

        if (event.type === 'system' && event.session_id) {
          newSessionId = event.session_id;
        }
        if (event.type === 'result' && event.result) {
          response = typeof event.result === 'string'
            ? event.result
            : extractText(event.result);
          if (event.session_id) newSessionId = event.session_id;
        }
        if (event.type === 'assistant' && event.message) {
          const text = extractText(event.message);
          if (text) response = text;
        }
      }
    });

    proc.stderr.on('data', () => {}); // suppress

    proc.on('close', (code) => {
      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          if (event.type === 'result' && event.result) {
            response = typeof event.result === 'string'
              ? event.result
              : extractText(event.result);
          }
          if (event.session_id) newSessionId = event.session_id;
        } catch {}
      }

      if (!response && code !== 0) {
        reject(new Error(`Claude exited with code ${code}`));
      } else {
        resolve({ response, sessionId: newSessionId });
      }
    });

    proc.on('error', reject);

    // 5-minute timeout
    setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error('Claude timed out after 5 minutes'));
    }, 300000);
  });
}

function extractText(message) {
  if (typeof message === 'string') return message;
  if (message && Array.isArray(message.content)) {
    return message.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return String(message || '');
}

// ---------------------------------------------------------------------------
// Telegram bot service
// ---------------------------------------------------------------------------
const TELEGRAM_API = 'https://api.telegram.org/bot';
let telegramToken = null;
let telegramOffset = 0;
let ownerChatId = null;
const chatSessions = {}; // chatId -> { sessionId, lastActivity }
const pausedChats = {};  // chatId -> true when paused
const processedUpdateIds = new Set(); // dedup guard against race conditions
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours — sessions persist, use /new to reset

async function telegramApi(method, body = {}) {
  const res = await fetch(`${TELEGRAM_API}${telegramToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendTelegramMessage(chatId, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) {
    chunks.push(text.slice(i, i + 4000));
  }
  for (const chunk of chunks) {
    await telegramApi('sendMessage', { chat_id: chatId, text: chunk });
  }
}

async function processMessage(chatId, text, sender) {
  const cfg = loadConfig();

  // Owner verification: require verification code on first /start
  if (!cfg.ownerChatId) {
    // Check if message contains the verification code
    const code = cfg.verifyCode;
    if (code && text.includes(code)) {
      cfg.ownerChatId = chatId;
      delete cfg.verifyCode;
      saveConfig(cfg);
      ownerChatId = chatId;
      log(`[Auth] Owner verified: ${chatId} (${sender})`);
      await sendTelegramMessage(chatId, 'Ownership verified.\n\nWhich browser do you use?\n\n1. Microsoft Edge\n2. Google Chrome\n3. Brave\n4. Firefox\n\nReply with the number (1-4).');
      return;
    }
    // If no verify code in config, accept first user (backwards compat)
    if (!code) {
      cfg.ownerChatId = chatId;
      saveConfig(cfg);
      ownerChatId = chatId;
      log(`[Auth] Owner set (no verify code): ${chatId}`);
    } else {
      await sendTelegramMessage(chatId, 'Please send the verification code shown in the Outdoors setup window.');
      return;
    }
  }

  // Security: only allow the owner
  if (chatId !== cfg.ownerChatId) {
    log(`[Auth] Blocked message from unauthorized user: ${chatId}`);
    return;
  }

  // Browser preference: ask on first interaction, before normal usage
  if (!cfg.browserPreference) {
    const choice = text.trim();
    if (['1', '2', '3', '4'].includes(choice)) {
      const browsers = { '1': 'edge', '2': 'chrome', '3': 'brave', '4': 'firefox' };
      cfg.browserPreference = browsers[choice];
      saveConfig(cfg);

      updatePlaywrightMcpConfig(cfg.browserPreference);
      launchBrowserWithCDP(cfg.browserPreference);

      // Update the live pipeline config so Model D sees the preference immediately
      const { config: pipelineConfig } = require('./config');
      pipelineConfig.browserPreference = cfg.browserPreference;

      // Regenerate CLAUDE.md and .mcp.json with the new browser preference
      try {
        const workspaceDir = pipelineConfig.workingDirectory;
        writeProjectFiles(workspaceDir, cfg.browserPreference, pipelineConfig.memoryDirectory, pipelineConfig.outputDirectory);
      } catch (err) {
        log(`[Browser] Failed to regenerate project files: ${err.message}`);
      }

      const name = { edge: 'Microsoft Edge', chrome: 'Google Chrome', brave: 'Brave', firefox: 'Firefox' }[cfg.browserPreference];
      await sendTelegramMessage(chatId,
        `Browser set to ${name}. Outdoors is ready.\n\nSend any message and I'll handle it.\n/new — Fresh conversation\n/pause — Pause/resume\n/browser — Change browser`
      );
      return;
    }

    await sendTelegramMessage(chatId,
      'Which browser do you use?\n\n1. Microsoft Edge\n2. Google Chrome\n3. Brave\n4. Firefox\n\nReply with the number (1-4).'
    );
    return;
  }

  // Handle /start
  if (text === '/start') {
    await sendTelegramMessage(chatId, 'Outdoors is ready. Send any message and Claude will respond.\n\n/new — Start a fresh conversation\n/pause — Pause/resume the bot\n/browser — Change browser');
    return;
  }

  // Handle /new to reset session
  if (text.toLowerCase() === '/new') {
    delete chatSessions[chatId];
    const sessions = loadSessions();
    delete sessions[chatId];
    saveSessions(sessions);
    await sendTelegramMessage(chatId, 'Session cleared. Next message starts fresh.');
    return;
  }

  // Handle /pause to toggle pause state
  if (text.toLowerCase() === '/pause') {
    if (pausedChats[chatId]) {
      delete pausedChats[chatId];
      await sendTelegramMessage(chatId, 'Resumed.');
    } else {
      pausedChats[chatId] = true;
      await sendTelegramMessage(chatId, 'Paused. Send /pause to resume.');
    }
    return;
  }

  // Handle /browser to change browser preference
  if (text.toLowerCase() === '/browser') {
    delete cfg.browserPreference;
    saveConfig(cfg);
    await sendTelegramMessage(chatId,
      'Which browser do you want to use?\n\n1. Microsoft Edge\n2. Google Chrome\n3. Brave\n4. Firefox\n\nReply with the number (1-4).'
    );
    return;
  }

  // If paused, don't process regular messages
  if (pausedChats[chatId]) {
    await sendTelegramMessage(chatId, 'I\'m paused. Send /pause to resume.');
    return;
  }

  // Determine session for continuity
  let resumeSessionId = null;
  const existing = chatSessions[chatId];
  if (existing && (Date.now() - existing.lastActivity) < SESSION_TIMEOUT) {
    resumeSessionId = existing.sessionId;
  }

  log(`[Message] From ${sender}: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}" (${text.length} chars${resumeSessionId ? ', resuming session' : ', new conversation'})`);

  // Send typing indicator
  await telegramApi('sendChatAction', { chat_id: chatId, action: 'typing' });

  // Keep typing indicator active during long pipeline runs
  const typingInterval = setInterval(() => {
    telegramApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }, 5000);

  try {
    // Run through the full Pepper pipeline (A→B→C?→D→Learn)
    const processKey = `tg:chat:${chatId}`;
    const result = await executeClaudePrompt(text, {
      resumeSessionId,
      processKey,
      onProgress: (type, data) => {
        if (type === 'pipeline_phase') {
          log(`[Pipeline ${data.phase}] ${data.description}`);
        } else if (type === 'tool_use') {
          log(`[Tool] ${data.tool}${data.input?.command ? ' → ' + data.input.command.slice(0, 120) : data.input?.url ? ' → ' + data.input.url.slice(0, 120) : data.input?.file_path ? ' → ' + data.input.file_path : data.input?.query ? ' → "' + data.input.query.slice(0, 80) + '"' : ''}`);
        } else if (type === 'stderr') {
          log(`[Claude stderr] ${data.text}`);
        }
      },
    });

    clearInterval(typingInterval);

    // Store session for conversation continuity
    if (result.sessionId) {
      chatSessions[chatId] = {
        sessionId: result.sessionId,
        lastActivity: Date.now(),
      };
      const sessions = loadSessions();
      sessions[chatId] = chatSessions[chatId];
      saveSessions(sessions);
    } else if (resumeSessionId) {
      // Resume returned no session ID — clear stale session so next message starts fresh
      delete chatSessions[chatId];
      const sessions = loadSessions();
      delete sessions[chatId];
      saveSessions(sessions);
    }

    // Save to persistent memory for cross-session context
    saveLastLog(chatId, text, result.response);

    // Handle pipeline result
    if (result.status === 'needs_user_input' && result.questions) {
      // Format questions for Telegram
      const questions = result.questions;
      let questionText = '';
      if (questions.questions && Array.isArray(questions.questions)) {
        for (const q of questions.questions) {
          questionText += q.question + '\n';
          if (q.options) {
            q.options.forEach((opt, i) => {
              questionText += `  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}\n`;
            });
          }
          questionText += '\n';
        }
      } else {
        questionText = JSON.stringify(questions, null, 2);
      }
      await sendTelegramMessage(chatId, questionText || '(Questions format error)');
    } else {
      const response = result.response || '(No response)';
      await sendTelegramMessage(chatId, response);
    }

    log(`[Reply] To ${sender}: ${(result.response || '').length} chars, session=${result.sessionId || 'none'}`);

    // Save full conversation log (mirrors local pepperv1 bot/logs/ behaviour)
    saveConversationLog(sender, text, result);
  } catch (err) {
    clearInterval(typingInterval);
    log(`[Error] Processing "${text.slice(0, 50)}..." from ${sender}: ${err.message}`);
    // If resume failed, retry without session
    if (resumeSessionId) {
      try {
        delete chatSessions[chatId];
        const result = await executeClaudePrompt(text, {
          resumeSessionId: null,
          processKey: `tg:chat:${chatId}`,
        });
        if (result.sessionId) {
          chatSessions[chatId] = {
            sessionId: result.sessionId,
            lastActivity: Date.now(),
          };
          const sessions = loadSessions();
          sessions[chatId] = chatSessions[chatId];
          saveSessions(sessions);
        }
        await sendTelegramMessage(chatId, result.response || '(No response)');
      } catch (retryErr) {
        log(`[Error] Retry without session also failed for ${sender}: ${retryErr.message}`);
        await sendTelegramMessage(chatId, 'Something went wrong. Please try again.');
      }
    } else {
      await sendTelegramMessage(chatId, 'Something went wrong. Please try again.');
    }
  }
}

async function pollTelegram() {
  if (!botPolling) return;

  try {
    const data = await telegramApi('getUpdates', {
      offset: telegramOffset,
      timeout: 30,
      allowed_updates: ['message'],
    });

    if (data.ok && data.result?.length) {
      for (const update of data.result) {
        telegramOffset = update.update_id + 1;

        // Deduplicate: skip if already processed (guards against instance races)
        if (processedUpdateIds.has(update.update_id)) continue;
        processedUpdateIds.add(update.update_id);
        // Cap the set size to prevent unbounded memory growth
        if (processedUpdateIds.size > 1000) {
          const oldest = processedUpdateIds.values().next().value;
          processedUpdateIds.delete(oldest);
        }

        const msg = update.message;
        if (!msg?.text) continue;
        const chatId = msg.chat.id;
        const sender = msg.from?.first_name || msg.from?.username || String(chatId);
        // Process async — don't block polling
        processMessage(chatId, msg.text, sender).catch(err => {
          log(`[Error] processMessage crashed for ${sender}: ${err.message}`);
        });
      }
    }
  } catch (err) {
    log(`[Telegram] Poll error: ${err.message}`);
    await new Promise(r => setTimeout(r, 5000));
  }

  if (botPolling) {
    botPollTimeout = setTimeout(pollTelegram, 100);
  }
}

function startBot(token) {
  if (botPolling) return;
  telegramToken = token;
  botPolling = true;
  // Load persisted sessions
  const sessions = loadSessions();
  for (const [id, data] of Object.entries(sessions)) {
    chatSessions[id] = data;
  }
  pollTelegram();
  log(`[Telegram] Bot polling started (${Object.keys(sessions).length} persisted sessions)`);
}

function stopBot() {
  botPolling = false;
  if (botPollTimeout) clearTimeout(botPollTimeout);
  log('[Telegram] Bot polling stopped');
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
ipcMain.handle('check-dependencies', async () => {
  const hasNode = commandExists('node');
  const hasNpm = commandExists('npm');
  const claudeVersion = getClaudeVersion();
  return { hasNode, hasNpm, hasClaude: !!claudeVersion, claudeVersion };
});

ipcMain.handle('install-dependencies', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const send = (step, status, detail) => {
    win?.webContents.send('install-progress', { step, status, detail });
  };

  // Step 1: Check Node.js
  send('node', 'checking', 'Checking for Node.js...');
  if (!commandExists('node') || !commandExists('npm')) {
    send('node', 'installing', 'Node.js not found. Please install Node.js from nodejs.org');
    // Try winget first
    try {
      execSync('winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements', {
        shell: true,
        timeout: 120000,
        stdio: 'pipe',
      });
      send('node', 'done', 'Node.js installed');
    } catch {
      send('node', 'error', 'Could not auto-install Node.js. Please install it from nodejs.org and restart Outdoors.');
      return { success: false, error: 'Node.js required' };
    }
  } else {
    send('node', 'done', 'Node.js found');
  }

  // Step 2: Install Claude CLI
  send('claude', 'checking', 'Checking Claude CLI...');
  if (!getClaudeVersion()) {
    send('claude', 'installing', 'Installing Claude CLI...');
    try {
      execSync('npm install -g @anthropic-ai/claude-code', {
        shell: true,
        timeout: 120000,
        stdio: 'pipe',
      });
      if (getClaudeVersion()) {
        send('claude', 'done', 'Claude CLI installed');
      } else {
        send('claude', 'error', 'Installation finished but claude not found on PATH. Try restarting.');
        return { success: false, error: 'Claude CLI not on PATH after install' };
      }
    } catch (err) {
      send('claude', 'error', `Install failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  } else {
    send('claude', 'done', 'Claude CLI found');
  }

  // Step 3: Configure Claude Code permissions for non-interactive execution.
  // On a fresh install, ~/.claude/settings.json doesn't exist, which means
  // --dangerously-skip-permissions triggers an interactive confirmation prompt
  // that blocks non-interactive (--print) mode. We must create it upfront.
  send('permissions', 'installing', 'Configuring permissions...');
  try {
    const claudeDir = path.join(app.getPath('home'), '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    const settingsPath = path.join(claudeDir, 'settings.json');
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch {}
    }

    // Allow --dangerously-skip-permissions without interactive confirmation
    settings.skipDangerousModePermissionPrompt = true;

    // Ensure a permissions object exists so Claude doesn't prompt for initial setup
    if (!settings.permissions) {
      settings.permissions = { allow: [], deny: [], additionalDirectories: [] };
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    send('permissions', 'done', 'Permissions configured');
  } catch (err) {
    send('permissions', 'warn', `Permissions config: ${err.message} (non-critical)`);
  }

  // Step 4: Configure MCP servers in user's Claude config
  send('mcp', 'installing', 'Configuring extensions...');
  try {
    const homeClaudeConfig = path.join(app.getPath('home'), '.claude.json');

    let existingConfig = {};
    if (fs.existsSync(homeClaudeConfig)) {
      try { existingConfig = JSON.parse(fs.readFileSync(homeClaudeConfig, 'utf-8')); } catch {}
    }

    // Add default MCP servers if not already configured
    if (!existingConfig.mcpServers) {
      existingConfig.mcpServers = {};
    }

    // Playwright MCP — configured based on browser preference (updated when user selects a browser)
    if (!existingConfig.mcpServers.playwright) {
      const savedCfg = loadConfig();
      if (savedCfg.browserPreference === 'firefox') {
        existingConfig.mcpServers.playwright = {
          command: 'npx',
          args: ['@anthropic-ai/mcp-playwright@latest'],
        };
      } else {
        existingConfig.mcpServers.playwright = {
          command: 'npx',
          args: ['@anthropic-ai/mcp-playwright@latest', '--cdp-endpoint', 'http://localhost:9222'],
        };
      }
    }

    fs.writeFileSync(homeClaudeConfig, JSON.stringify(existingConfig, null, 2));
    send('mcp', 'done', 'Extensions configured');
  } catch (err) {
    send('mcp', 'warn', `MCP config: ${err.message} (non-critical)`);
  }

  send('complete', 'done', 'All dependencies ready');
  return { success: true };
});

ipcMain.handle('check-claude-auth', async () => {
  // Check if Claude CLI is authenticated by looking for credentials
  const home = app.getPath('home');
  const credPaths = [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.claude', 'credentials.json'),
    path.join(home, '.claude.json'),
  ];

  for (const p of credPaths) {
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (data.oauthToken || data.claudeAiOauth || data.apiKey) {
          return { authenticated: true };
        }
      } catch {}
    }
  }

  return { authenticated: false };
});

ipcMain.handle('start-claude-auth', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  // Spawn claude login
  const proc = spawn('claude', ['login'], {
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let output = '';
  proc.stdout.on('data', (chunk) => { output += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { output += chunk.toString(); });

  // Poll for auth completion by checking credential files
  const pollInterval = setInterval(() => {
    const home = app.getPath('home');
    const credPaths = [
      path.join(home, '.claude', '.credentials.json'),
      path.join(home, '.claude', 'credentials.json'),
    ];
    for (const p of credPaths) {
      if (fs.existsSync(p)) {
        try {
          const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
          if (data.oauthToken || data.claudeAiOauth) {
            clearInterval(pollInterval);
            win?.webContents.send('auth-status', { status: 'success' });
            try { proc.kill(); } catch {}
            return;
          }
        } catch {}
      }
    }
  }, 2000);

  // Timeout after 5 minutes
  const authTimeout = setTimeout(() => {
    clearInterval(pollInterval);
    try { proc.kill(); } catch {}
    win?.webContents.send('auth-status', { status: 'timeout' });
  }, 300000);

  proc.on('close', () => {
    clearInterval(pollInterval);
    clearTimeout(authTimeout);
    // Check one final time
    const home = app.getPath('home');
    const cred = path.join(home, '.claude', '.credentials.json');
    if (fs.existsSync(cred)) {
      win?.webContents.send('auth-status', { status: 'success' });
    }
  });

  return { started: true };
});

ipcMain.handle('validate-token', async (_event, token) => {
  // Validate token format (numeric_id:alphanumeric)
  if (!token || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(token.trim())) {
    return { valid: false, error: 'Token should be in format 123456:ABC-DEF...' };
  }
  try {
    const res = await fetch(`${TELEGRAM_API}${token.trim()}/getMe`);
    const data = await res.json();
    if (data.ok) {
      // Generate a verification code for secure owner registration
      const verifyCode = Math.random().toString(36).slice(2, 8).toUpperCase();
      const cfg = loadConfig();
      cfg.telegramToken = token.trim();
      cfg.botUsername = data.result.username;
      cfg.verifyCode = verifyCode;
      saveConfig(cfg);
      // Start bot immediately so it can receive the verify code
      stopBot();
      startBot(token.trim());

      return { valid: true, username: data.result.username, verifyCode };
    }
    return { valid: false, error: data.description || 'Invalid token' };
  } catch (err) {
    return { valid: false, error: err.message };
  }
});

ipcMain.handle('generate-qr', async (_event, botUsername) => {
  try {
    const QRCode = require('qrcode');
    const url = `https://t.me/${botUsername}`;
    const dataUrl = await QRCode.toDataURL(url, {
      width: 200,
      margin: 2,
      color: { dark: '#2C2417', light: '#FAF6F1' },
    });
    return { dataUrl, url };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('complete-setup', async () => {
  const cfg = loadConfig();
  if (!cfg.telegramToken) {
    return { success: false, error: 'No Telegram token configured.' };
  }
  cfg.setupComplete = true;
  cfg.setupDate = new Date().toISOString();
  saveConfig(cfg);

  // Enable auto-launch
  await enableAutoLaunch();

  // Start the bot
  if (cfg.telegramToken) {
    startBot(cfg.telegramToken);
  }

  // Create tray
  createTray();

  // Hide the setup window
  if (mainWindow) {
    mainWindow.hide();
  }

  log('Setup complete');
  return { success: true };
});

ipcMain.handle('close-window', () => {
  if (mainWindow) {
    mainWindow.close();
  }
});

ipcMain.handle('open-external', async (_event, url) => {
  // Only allow https/http URLs to prevent protocol handler attacks
  try {
    const parsed = new URL(url);
    if (['https:', 'http:'].includes(parsed.protocol)) {
      await shell.openExternal(url);
    }
  } catch {}
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  log(`[Outdoors] Starting (pid=${process.pid}, node=${process.version})`);

  // Ensure Claude Code permissions are configured on every launch.
  // This guarantees --dangerously-skip-permissions works without interactive
  // prompts even if the user's ~/.claude/settings.json was deleted or is missing.
  try {
    const claudeDir = path.join(app.getPath('home'), '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch {}
    }
    if (!settings.skipDangerousModePermissionPrompt) {
      settings.skipDangerousModePermissionPrompt = true;
      if (!settings.permissions) {
        settings.permissions = { allow: [], deny: [], additionalDirectories: [] };
      }
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      log('[Outdoors] Claude Code permissions provisioned');
    }
  } catch (err) {
    log(`[Outdoors] Warning: could not provision Claude permissions: ${err.message}`);
  }

  // Initialize the Pepper pipeline config with proper paths.
  let memoryDir, outputDir;

  if (isDev) {
    // Dev mode: read/write directly from the source tree — no stale copies
    memoryDir = path.join(__dirname, 'bot', 'memory');
    outputDir = path.join(__dirname, 'bot', 'outputs');
    log('[Outdoors] DEV MODE: using source-tree paths');
  } else {
    // CRITICAL: Use app.getPath('userData') for writable directories, NOT __dirname.
    // Inside a packaged app, __dirname points inside the .asar archive which is read-only.
    const userDataDir = app.getPath('userData');
    memoryDir = path.join(userDataDir, 'bot', 'memory');
    outputDir = path.join(userDataDir, 'bot', 'outputs');

    // On first run, copy bundled memory files from .asar to the writable userData location
    if (!fs.existsSync(memoryDir)) {
      log('[Outdoors] First run: copying bundled memory files to userData...');
      const bundledMemory = path.join(__dirname, 'bot', 'memory');
      if (fs.existsSync(bundledMemory)) {
        copyDirRecursive(bundledMemory, memoryDir);
        log(`[Outdoors] Copied memory files to ${memoryDir}`);
      } else {
        fs.mkdirSync(memoryDir, { recursive: true });
        log('[Outdoors] No bundled memory files found, created empty memory directory');
      }
    }
  }
  fs.mkdirSync(outputDir, { recursive: true });

  // Use a dedicated workspace directory so Claude CLI gets its own project context,
  // NOT the home directory (which has Pepper's auto-memory).
  const workspaceDir = path.join(app.getPath('userData'), 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const cfgForInit = loadConfig();
  initConfig({
    outputDirectory: outputDir,
    memoryDirectory: memoryDir,
    workingDirectory: workspaceDir,
    browserPreference: cfgForInit.browserPreference || null,
  });
  log(`[Outdoors] Pipeline ready (A→B→C?→D→Learn) — cwd: ${workspaceDir}, memory: ${memoryDir}, outputs: ${outputDir}`);

  // Pre-warm ML workers so the first real task doesn't hit cold-start timeouts.
  // These are fire-and-forget — failures are non-fatal.
  const { runPhaseA, runPhaseB } = require('./pipeline/ml-runner');
  runPhaseA('warmup').catch(() => {});
  runPhaseB('warmup', []).catch(() => {});
  log('[Outdoors] ML workers pre-warming...');

  // Mirror the local pepperv1/backend/ structure inside the workspace:
  //   workspace/CLAUDE.md       — system prompt (112-line instruction manual)
  //   workspace/.mcp.json       — Playwright + Todoist + Notion MCP servers
  //   workspace/bot/memory/     → junction to memoryDir
  //   workspace/bot/outputs/    → junction to outputDir
  //   workspace/bot/logs/       → junction to logsDir
  // This makes Claude CLI behave identically to the local version.
  try {
    writeProjectFiles(workspaceDir, cfgForInit.browserPreference, memoryDir, outputDir);
  } catch (err) {
    log(`[Outdoors] Warning: workspace setup failed: ${err.message}`);
  }

  const cfg = loadConfig();

  if (cfg.setupComplete && cfg.telegramToken) {
    // Already set up — start background service
    startBot(cfg.telegramToken);
    createTray();
    if (cfg.browserPreference) {
      launchBrowserWithCDP(cfg.browserPreference);
    }
    log(`[Outdoors] Background service started — browser: ${cfg.browserPreference || 'none'}, owner: ${cfg.ownerChatId || 'not set'}`);
  } else {
    // First run or setup incomplete — show wizard
    createSetupWindow();
  }
});

app.on('second-instance', () => {
  // If user tries to open a second instance, show the existing window
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', (e) => {
  // Don't quit when window closes — keep running in tray
  if (tray) {
    // Already in tray mode, do nothing
  } else {
    // No tray yet (during setup), quit if window closed
    // But only on non-macOS
    if (process.platform !== 'darwin') {
      app.quit();
    }
  }
});

app.on('before-quit', () => {
  stopBot();
  if (browserProcess) {
    try { browserProcess.kill(); } catch {}
  }
  // Kill all tracked Claude CLI child processes to prevent orphans
  const registry = require('./util/process-registry');
  const { numbered, unnumbered } = registry.getSummary();
  for (const entry of [...numbered, ...unnumbered]) {
    registry.kill(entry.key);
  }
});
