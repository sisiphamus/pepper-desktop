// ============================================================
// Outdoors Setup Wizard — Renderer
// ============================================================

let currentPage = 0;
const totalPages = 5;

// ---------------------------------------------------------------------------
// Page navigation
// ---------------------------------------------------------------------------

function goToPage(index) {
  if (index < 0 || index >= totalPages) return;

  const pages = document.querySelectorAll('.page');
  const dots = document.querySelectorAll('.dot');

  // Fade out current
  pages[currentPage].classList.remove('active');
  dots[currentPage].classList.remove('active');
  dots[currentPage].classList.add('completed');

  currentPage = index;

  // Fade in target
  pages[currentPage].classList.add('active');
  dots[currentPage].classList.remove('completed');
  dots[currentPage].classList.add('active');

  // Trigger page-specific actions
  if (currentPage === 1) startInstallation();
  if (currentPage === 2) checkExistingAuth();
}

function nextPage() {
  goToPage(currentPage + 1);
}

// ---------------------------------------------------------------------------
// Page 1: Welcome
// ---------------------------------------------------------------------------

document.getElementById('btn-begin').addEventListener('click', () => nextPage());

// ---------------------------------------------------------------------------
// Page 2: Installation
// ---------------------------------------------------------------------------

async function startInstallation() {
  // Listen for progress updates from main process
  window.outdoors.onInstallProgress(({ step, status, detail }) => {
    // Show Continue button when installation is complete
    if (step === 'complete' && status === 'done') {
      document.getElementById('btn-install-continue').classList.remove('hidden');
      return;
    }

    const item = document.querySelector(`.check-item[data-step="${step}"]`);
    if (!item) return;

    const icon = item.querySelector('.check-icon');
    const detailEl = item.querySelector('.check-detail');

    icon.className = 'check-icon ' + status;
    if (detail) detailEl.textContent = detail;
  });

  const result = await window.outdoors.installDependencies();
  if (!result.success) {
    const errorEl = document.getElementById('install-error');
    errorEl.textContent = result.error || 'Installation encountered an issue. You may need to install Node.js manually.';
    errorEl.classList.remove('hidden');
    // Still show continue button so user can retry or proceed
    document.getElementById('btn-install-continue').classList.remove('hidden');
  }
}

document.getElementById('btn-install-continue').addEventListener('click', () => nextPage());

// ---------------------------------------------------------------------------
// Page 3: Claude Authentication
// ---------------------------------------------------------------------------

async function checkExistingAuth() {
  const result = await window.outdoors.checkClaudeAuth();
  if (result.authenticated) {
    showAuthConnected();
  }
}

function showAuthConnected() {
  document.getElementById('auth-not-connected').classList.add('hidden');
  document.getElementById('auth-checking').classList.add('hidden');
  document.getElementById('auth-connected').classList.remove('hidden');
}

document.getElementById('btn-auth').addEventListener('click', async () => {
  document.getElementById('auth-not-connected').classList.add('hidden');
  document.getElementById('auth-checking').classList.remove('hidden');

  await window.outdoors.startClaudeAuth();
});

window.outdoors.onAuthStatus(({ status }) => {
  if (status === 'success') {
    showAuthConnected();
  } else if (status === 'timeout') {
    document.getElementById('auth-checking').classList.add('hidden');
    document.getElementById('auth-not-connected').classList.remove('hidden');
    // Could show an error here
  }
});

document.getElementById('btn-auth-continue').addEventListener('click', () => nextPage());

// ---------------------------------------------------------------------------
// Page 4: Telegram Setup
// ---------------------------------------------------------------------------

document.getElementById('btn-botfather').addEventListener('click', () => {
  window.outdoors.openExternal('https://t.me/BotFather');
});

document.getElementById('btn-connect').addEventListener('click', async () => {
  const tokenInput = document.getElementById('token-input');
  const statusEl = document.getElementById('token-status');
  const token = tokenInput.value.trim();

  if (!token) {
    statusEl.textContent = 'Please paste your bot token above.';
    statusEl.className = 'token-status error';
    statusEl.classList.remove('hidden');
    return;
  }

  statusEl.textContent = 'Verifying...';
  statusEl.className = 'token-status';
  statusEl.classList.remove('hidden');

  const result = await window.outdoors.validateToken(token);

  if (result.valid) {
    statusEl.classList.add('hidden');

    // Show QR code section
    document.getElementById('telegram-steps').classList.add('hidden');
    document.querySelector('.help-toggle').classList.add('hidden');
    const qrSection = document.getElementById('qr-section');
    qrSection.classList.remove('hidden');

    // Generate QR code
    const qr = await window.outdoors.generateQrCode(result.username);
    if (qr.dataUrl) {
      document.getElementById('qr-image').src = qr.dataUrl;
    }
    document.getElementById('bot-name-display').textContent = `@${result.username}`;

    // Show verification code for secure owner registration
    if (result.verifyCode) {
      const verifyEl = document.getElementById('verify-code');
      if (verifyEl) {
        verifyEl.textContent = result.verifyCode;
        document.getElementById('verify-section').classList.remove('hidden');
      }
    }
  } else {
    statusEl.textContent = result.error || 'Invalid token. Please check and try again.';
    statusEl.className = 'token-status error';
  }
});

// Help toggle
document.getElementById('btn-help-toggle').addEventListener('click', () => {
  const content = document.getElementById('help-content');
  const btn = document.getElementById('btn-help-toggle');
  if (content.classList.contains('hidden')) {
    content.classList.remove('hidden');
    btn.textContent = 'Hide help';
  } else {
    content.classList.add('hidden');
    btn.textContent = 'Need help finding the token?';
  }
});

document.getElementById('btn-telegram-continue').addEventListener('click', async () => {
  const btn = document.getElementById('btn-telegram-continue');
  btn.textContent = 'Finishing...';
  btn.disabled = true;
  await window.outdoors.completeSetup();
  nextPage();
});

// ---------------------------------------------------------------------------
// Page 5: Complete
// ---------------------------------------------------------------------------

document.getElementById('btn-close').addEventListener('click', () => {
  window.outdoors.closeWindow();
});

// ---------------------------------------------------------------------------
// Token input: allow Enter key to submit
// ---------------------------------------------------------------------------

document.getElementById('token-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    document.getElementById('btn-connect').click();
  }
});
