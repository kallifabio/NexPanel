/* NexPanel — auth.js
 * Authentication: login, register, 2FA/TOTP, OAuth social login
 */

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t,i) => t.classList.toggle('active', (tab==='login'&&i===0)||(tab==='register'&&i===1)));
  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
  document.getElementById('auth-error').classList.add('hidden');
  // Reset 2FA step on tab switch
  if (typeof _totpPendingToken !== 'undefined') _totpPendingToken = null;
  document.getElementById('totp-form')?.classList.add('hidden');
  document.getElementById('totp-recover-form')?.classList.add('hidden');
}
let _totpPendingToken = null;

async function doLogin() {
  try {
    const d = await API.post('/auth/login', { email: document.getElementById('login-email').value.trim(), password: document.getElementById('login-pass').value });
    if (d.requires_totp) {
      _totpPendingToken = d.totp_token;
      showTotpStep();
      return;
    }
    State.token = d.token; localStorage.setItem('hp_token', d.token); State.user = d.user; initApp();
  } catch (e) { showAuthError(e.message); }
}

function showTotpStep() {
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('register-form').classList.add('hidden');
  document.getElementById('totp-recover-form').classList.add('hidden');
  document.getElementById('totp-form').classList.remove('hidden');
  document.getElementById('auth-error').classList.add('hidden');
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  setTimeout(() => { const el = document.getElementById('totp-code'); if(el) { el.value=''; el.focus(); } }, 50);
  if (window.lucide) setTimeout(() => lucide.createIcons(), 0);
}

function showTotpRecover() {
  document.getElementById('totp-form').classList.add('hidden');
  document.getElementById('totp-recover-form').classList.remove('hidden');
  document.getElementById('auth-error').classList.add('hidden');
  setTimeout(() => document.getElementById('backup-code-input')?.focus(), 50);
}

function cancelTotp() {
  _totpPendingToken = null;
  document.getElementById('totp-form').classList.add('hidden');
  document.getElementById('totp-recover-form').classList.add('hidden');
  document.getElementById('login-form').classList.remove('hidden');
  document.getElementById('auth-error').classList.add('hidden');
  document.querySelector('.auth-tab')?.classList.add('active');
}

async function doTotpVerify() {
  const code = document.getElementById('totp-code')?.value.replace(/\s/g,'');
  if (!code || code.length < 6) { showAuthError('Bitte 6-stelligen Code eingeben'); return; }
  try {
    const d = await API.post('/auth/totp/verify', { totp_token: _totpPendingToken, code });
    _totpPendingToken = null;
    if (d.warning) toast(d.warning, 'warn');
    State.token = d.token; localStorage.setItem('hp_token', d.token); State.user = d.user; initApp();
  } catch (e) { showAuthError(e.message); document.getElementById('totp-code').value = ''; }
}

async function doTotpRecover() {
  const code = document.getElementById('backup-code-input')?.value.trim();
  if (!code) { showAuthError('Bitte Backup-Code eingeben'); return; }
  try {
    const d = await API.post('/auth/totp/recover', { totp_token: _totpPendingToken, backup_code: code });
    _totpPendingToken = null;
    if (d.warning) toast(d.warning, 'warn');
    if (d.info)    toast(d.info,    'info');
    State.token = d.token; localStorage.setItem('hp_token', d.token); State.user = d.user; initApp();
  } catch (e) { showAuthError(e.message); }
}
async function doRegister() {
  try {
    const d = await API.post('/auth/register', { username: document.getElementById('reg-user').value.trim(), email: document.getElementById('reg-email').value.trim(), password: document.getElementById('reg-pass').value });
    State.token = d.token; localStorage.setItem('hp_token', d.token); State.user = d.user; initApp();
  } catch (e) { showAuthError(e.message); }
}
function showAuthError(m) { const el = document.getElementById('auth-error'); el.textContent = m; el.classList.remove('hidden'); }
function logout() {
  State.token = null; localStorage.removeItem('hp_token'); State.user = null;
  if (State.wsConn) State.wsConn.close();
  document.getElementById('app').classList.add('hidden');
  document.getElementById('auth-screen').classList.remove('hidden');
  initOAuthButtons();
}
