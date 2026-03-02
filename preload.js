const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('outdoors', {
  // Installer
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),
  installDependencies: () => ipcRenderer.invoke('install-dependencies'),
  onInstallProgress: (callback) => {
    ipcRenderer.on('install-progress', (_e, data) => callback(data));
  },

  // Claude auth
  checkClaudeAuth: () => ipcRenderer.invoke('check-claude-auth'),
  startClaudeAuth: () => ipcRenderer.invoke('start-claude-auth'),
  onAuthStatus: (callback) => {
    ipcRenderer.on('auth-status', (_e, data) => callback(data));
  },

  // Telegram
  validateToken: (token) => ipcRenderer.invoke('validate-token', token),
  generateQrCode: (botUsername) => ipcRenderer.invoke('generate-qr', botUsername),

  // Setup
  completeSetup: () => ipcRenderer.invoke('complete-setup'),
  closeWindow: () => ipcRenderer.invoke('close-window'),

  // Util
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
