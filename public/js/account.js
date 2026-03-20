/* NexPanel — account.js
 * Account: API keys, settings, 2FA setup, OAuth connections, groups, webhooks
 */

// ─── SETTINGS ────────────────────────────────────────────────────────────────
async function loadSettings() {
  const u = State.user;
  let totpStatus = { enabled: false, backup_codes_remaining: 0 };
  try { totpStatus = await API.get('/auth/totp/status'); } catch {}

  document.getElementById('page-content').innerHTML = `
    <div class="grid grid-2" style="max-width:900px">
      <div class="card">
        <div class="card-title" style="margin-bottom:16px"><i data-lucide="user"></i> Profil</div>
        <table class="table">
          <tr><td class="text-dim">Username</td><td>${esc(u.username)}</td></tr>
          <tr><td class="text-dim">Email</td><td>${esc(u.email)}</td></tr>
          <tr><td class="text-dim">Rolle</td><td><span class="chip ${u.role==='admin'?'chip-admin':'chip-offline'}">${u.role}</span></td></tr>
          <tr><td class="text-dim">User ID</td><td class="text-mono text-sm text-dim">${esc(u.id)}</td></tr>
          <tr><td class="text-dim">Dabei seit</td><td class="text-sm">${new Date(u.created_at).toLocaleString('de-DE')}</td></tr>
        </table>
      </div>
      <div class="card">
        <div class="card-title" style="margin-bottom:16px"><i data-lucide="lock"></i> Passwort ändern</div>
        <div class="form-group"><label class="form-label">Aktuelles Passwort</label><input type="password" id="s-cur-pass" class="form-input"/></div>
        <div class="form-group"><label class="form-label">Neues Passwort</label><input type="password" id="s-new-pass" class="form-input"/></div>
        <div id="s-error" class="error-msg hidden"></div>
        <div id="s-success" class="success-msg hidden"></div>
        <button class="btn btn-primary" onclick="changePassword()">Aktualisieren</button>
      </div>

      <!-- 2FA CARD -->
      <div class="card" style="grid-column:span 2">
        <div class="card-header" style="margin-bottom:12px">
          <div class="card-title"><i data-lucide="shield-check"></i> Zwei-Faktor-Authentifizierung (2FA)</div>
          <span style="display:flex;align-items:center;gap:8px">
            ${totpStatus.enabled
              ? `<span style="background:rgba(34,197,94,.12);color:#16a34a;border:1px solid rgba(34,197,94,.25);padding:3px 10px;border-radius:20px;font-size:12px;font-weight:500"><i data-lucide="shield-check" style="width:11px;height:11px;vertical-align:-1px"></i> Aktiv</span>`
              : `<span style="background:var(--color-background-secondary);color:var(--color-text-secondary);border:1px solid var(--color-border-tertiary);padding:3px 10px;border-radius:20px;font-size:12px">Inaktiv</span>`
            }
          </span>
        </div>

        ${totpStatus.enabled ? `
          <div style="display:grid;grid-template-columns:1fr auto;gap:16px;align-items:start">
            <div>
              <p style="font-size:13px;color:var(--color-text-secondary);line-height:1.6;margin-bottom:12px">
                2FA ist aktiviert. Dein Account ist durch einen Authenticator-App-Code geschützt.
                Du benötigst beim Login deinen 6-stelligen TOTP-Code.
              </p>
              <div style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:16px">
                <i data-lucide="key" style="width:13px;height:13px;color:var(--color-text-secondary)"></i>
                <span style="color:var(--color-text-secondary)">Backup-Codes verbleibend:</span>
                <span style="font-weight:500;color:${totpStatus.backup_codes_remaining<=2?'var(--color-text-danger)':'var(--color-text-primary)'}">${totpStatus.backup_codes_remaining}</span>
                ${totpStatus.backup_codes_remaining <= 2 ? `<span style="font-size:11px;color:var(--color-text-warning)">— Bitte neue Codes generieren!</span>` : ''}
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="btn btn-secondary btn-sm" onclick="showRegenBackupCodesModal()"><i data-lucide="refresh-cw"></i> Neue Backup-Codes</button>
                <button class="btn btn-danger btn-sm" onclick="showDisable2FAModal()"><i data-lucide="shield-off"></i> 2FA deaktivieren</button>
              </div>
            </div>
            <div style="text-align:center;padding:12px 16px;background:var(--color-background-secondary);border:1px solid var(--color-border-tertiary);border-radius:8px;min-width:120px">
              <i data-lucide="smartphone" style="width:28px;height:28px;margin-bottom:6px;opacity:.5"></i>
              <div style="font-size:11px;color:var(--color-text-tertiary)">Authenticator</div>
              <div style="font-size:11px;color:var(--color-text-tertiary)">verknüpft</div>
            </div>
          </div>
        ` : `
          <p style="font-size:13px;color:var(--color-text-secondary);line-height:1.6;margin-bottom:14px">
            Schütze deinen Account mit einem zweiten Faktor. Nach der Aktivierung benötigst du beim Login
            zusätzlich einen 6-stelligen Code aus einer Authenticator-App (Google Authenticator, Authy, etc.).
          </p>
          <button class="btn btn-primary" onclick="showSetup2FAModal()"><i data-lucide="shield-plus"></i> 2FA einrichten</button>
        `}
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:12px"><i data-lucide="shield"></i> Aktive Sessions</div>
        <p class="text-dim text-sm" style="margin-bottom:12px">Verwalte deine aktiven Logins und beende fremde Sessions.</p>
        <button class="btn btn-secondary" onclick="navigate('sessions')">Sessions verwalten →</button>
      </div>
      <div class="card">
        <div class="card-title" style="margin-bottom:12px"><i data-lucide="folder-kanban"></i> Server-Gruppen</div>
        <p class="text-dim text-sm" style="margin-bottom:12px">Organisiere deine Server in Gruppen und vergib Tags.</p>
        <button class="btn btn-secondary" onclick="navigate('groups')">Gruppen verwalten →</button>
      </div>
      <!-- OAuth Verbindungen -->
      <div class="card" style="grid-column:span 2" id="oauth-connections-card">
        <div class="card-title" style="margin-bottom:12px"><i data-lucide="key-round"></i> Verknüpfte Konten</div>
        <div id="oauth-connections-list"><div class="empty"><div class="empty-icon spin"><i data-lucide="loader"></i></div></div></div>
      </div>

      <div class="card" style="grid-column:span 2">
        <div class="card-title" style="margin-bottom:12px"><i data-lucide="log-out"></i> Abmelden</div>
        <p class="text-dim text-sm" style="margin-bottom:12px">Von NexPanel auf diesem Gerät abmelden.</p>
        <button class="btn btn-danger" onclick="logout()">Abmelden</button>
      </div>
    </div>`;
  if (window.lucide) lucide.createIcons();
  loadOAuthConnections();
}

// ── 2FA SETUP MODAL ───────────────────────────────────────────────────────────
async function showSetup2FAModal() {
  showModal(`
    <div class="modal-title"><span><i data-lucide="shield-plus"></i> 2FA einrichten</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div id="setup-step-1">
      <p style="font-size:13px;color:var(--color-text-secondary);line-height:1.6;margin-bottom:16px">
        Scanne den QR-Code mit deiner Authenticator-App (Google Authenticator, Authy, Bitwarden, etc.)
        oder gib den Secret-Key manuell ein.
      </p>
      <div style="text-align:center;margin:16px 0" id="qr-loading">
        <div class="empty-icon spin"><i data-lucide="loader"></i></div>
        <p style="font-size:12px;color:var(--color-text-tertiary)">QR-Code wird generiert…</p>
      </div>
      <div id="qr-content" style="display:none">
        <div style="text-align:center;margin-bottom:14px">
          <img id="qr-img" src="" alt="QR Code" style="width:200px;height:200px;border-radius:8px;border:4px solid white"/>
        </div>
        <div style="background:var(--color-background-secondary);border:1px solid var(--color-border-tertiary);border-radius:8px;padding:10px 14px;margin-bottom:16px">
          <div style="font-size:11px;color:var(--color-text-tertiary);margin-bottom:4px">Manueller Schlüssel (falls QR nicht funktioniert)</div>
          <code id="totp-secret-display" style="font-family:var(--font-mono);font-size:13px;word-break:break-all;letter-spacing:.05em"></code>
          <button class="btn btn-ghost btn-sm" style="margin-top:6px;display:block" onclick="navigator.clipboard.writeText(document.getElementById('totp-secret-display').textContent).then(()=>toast('Kopiert!','success'))"><i data-lucide="clipboard"></i> Kopieren</button>
        </div>
        <div class="form-group">
          <label class="form-label">Bestätigungscode aus der App eingeben</label>
          <input type="text" id="totp-confirm-code" class="form-input"
            placeholder="000000" maxlength="6" autocomplete="one-time-code"
            style="text-align:center;font-size:20px;font-family:var(--font-mono);letter-spacing:.25em"
            oninput="this.value=this.value.replace(/[^0-9]/g,'')"
            onkeydown="if(event.key==='Enter')confirmTotp2FA()"/>
        </div>
        <div id="setup-error" class="error-msg hidden"></div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
          <button class="btn btn-primary" onclick="confirmTotp2FA()"><i data-lucide="check"></i> Aktivieren</button>
        </div>
      </div>
    </div>
  `, false);

  if (window.lucide) lucide.createIcons();

  try {
    const r = await API.post('/auth/totp/setup', {});
    document.getElementById('qr-loading').style.display = 'none';
    document.getElementById('qr-img').src = r.qr_data_url;
    document.getElementById('totp-secret-display').textContent = r.secret;
    document.getElementById('qr-content').style.display = 'block';
    if (window.lucide) lucide.createIcons();
    setTimeout(() => document.getElementById('totp-confirm-code')?.focus(), 100);
  } catch (e) {
    document.getElementById('qr-loading').innerHTML = `<p style="color:var(--color-text-danger)">${esc(e.message)}</p>`;
  }
}

async function confirmTotp2FA() {
  const code = document.getElementById('totp-confirm-code')?.value.trim();
  const errEl = document.getElementById('setup-error');
  if (!code || code.length !== 6) { if(errEl){errEl.textContent='Bitte 6-stelligen Code eingeben';errEl.classList.remove('hidden');} return; }
  try {
    const r = await API.post('/auth/totp/confirm', { code });
    closeModal();
    showBackupCodesModal(r.backup_codes, true);
    toast('2FA erfolgreich aktiviert!', 'success');
    loadSettings();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
    document.getElementById('totp-confirm-code').value = '';
    document.getElementById('totp-confirm-code').focus();
  }
}

// ── BACKUP CODES ANZEIGE MODAL ────────────────────────────────────────────────
function showBackupCodesModal(codes, isNew = false) {
  showModal(`
    <div class="modal-title">
      <span><i data-lucide="key"></i> ${isNew ? 'Backup-Codes — Bitte jetzt sichern!' : 'Neue Backup-Codes'}</span>
      <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
    </div>
    ${isNew ? `
    <div style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px;line-height:1.5">
      <i data-lucide="alert-triangle" style="width:14px;height:14px;vertical-align:-2px;color:#d97706"></i>
      <strong>Wichtig:</strong> Speichere diese Codes jetzt sicher. Sie werden nur einmal angezeigt und können
      den Zugriff auf deinen Account wiederherstellen wenn du keinen Zugriff auf deine Authenticator-App hast.
    </div>` : ''}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0 16px">
      ${codes.map(c => `<code style="font-family:var(--font-mono);font-size:14px;background:var(--color-background-secondary);padding:8px 12px;border-radius:6px;border:1px solid var(--color-border-tertiary);text-align:center;letter-spacing:.08em">${esc(c)}</code>`).join('')}
    </div>
    <div style="font-size:12px;color:var(--color-text-tertiary);margin-bottom:14px;line-height:1.5">
      Jeder Code kann nur einmal verwendet werden. Bei Nutzung eines Codes wird er gelöscht.
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="copyAllBackupCodes(${JSON.stringify(codes).replace(/"/g,'&quot;')})"><i data-lucide="clipboard"></i> Alle kopieren</button>
      <button class="btn btn-primary" onclick="closeModal()">Verstanden</button>
    </div>
  `, false);
  if (window.lucide) lucide.createIcons();
}

function copyAllBackupCodes(codes) {
  navigator.clipboard.writeText(codes.join('\n')).then(() => toast('Backup-Codes kopiert!', 'success'));
}

// ── BACKUP CODES REGENERIEREN ─────────────────────────────────────────────────
function showRegenBackupCodesModal() {
  showModal(`
    <div class="modal-title"><span><i data-lucide="refresh-cw"></i> Neue Backup-Codes generieren</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <p style="font-size:13px;color:var(--color-text-secondary);line-height:1.6;margin-bottom:16px">
      Alle bestehenden Backup-Codes werden ungültig und durch 8 neue ersetzt.
      Zur Bestätigung dein Passwort eingeben.
    </p>
    <div class="form-group">
      <label class="form-label">Passwort</label>
      <input type="password" id="regen-pass" class="form-input" placeholder="Dein Passwort"
        onkeydown="if(event.key==='Enter')regenBackupCodes()"/>
    </div>
    <div id="regen-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="regenBackupCodes()"><i data-lucide="refresh-cw"></i> Neue Codes generieren</button>
    </div>
  `);
  if (window.lucide) lucide.createIcons();
  setTimeout(() => document.getElementById('regen-pass')?.focus(), 50);
}

async function regenBackupCodes() {
  const pw = document.getElementById('regen-pass')?.value;
  const errEl = document.getElementById('regen-error');
  if (!pw) { if(errEl){errEl.textContent='Passwort erforderlich';errEl.classList.remove('hidden');} return; }
  try {
    const r = await API.post('/auth/totp/backup-codes/regen', { password: pw });
    closeModal();
    showBackupCodesModal(r.backup_codes, false);
    toast('Neue Backup-Codes generiert!', 'success');
    loadSettings();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  }
}

// ── 2FA DEAKTIVIEREN ──────────────────────────────────────────────────────────
function showDisable2FAModal() {
  showModal(`
    <div class="modal-title"><span><i data-lucide="shield-off"></i> 2FA deaktivieren</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px;line-height:1.5">
      <i data-lucide="alert-octagon" style="width:14px;height:14px;vertical-align:-2px;color:var(--color-text-danger)"></i>
      Nach der Deaktivierung ist dein Account nur noch durch Passwort geschützt.
    </div>
    <div class="form-group">
      <label class="form-label">Passwort</label>
      <input type="password" id="disable-pass" class="form-input" placeholder="Dein Passwort"/>
    </div>
    <div class="form-group">
      <label class="form-label">2FA-Code oder Backup-Code (optional, aber empfohlen)</label>
      <input type="text" id="disable-code" class="form-input" placeholder="123456 oder ABCDEF-123456" maxlength="13"
        onkeydown="if(event.key==='Enter')disable2FA()"/>
    </div>
    <div id="disable-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-danger" onclick="disable2FA()"><i data-lucide="shield-off"></i> 2FA deaktivieren</button>
    </div>
  `);
  if (window.lucide) lucide.createIcons();
  setTimeout(() => document.getElementById('disable-pass')?.focus(), 50);
}

async function disable2FA() {
  const pw   = document.getElementById('disable-pass')?.value;
  const code = document.getElementById('disable-code')?.value.trim();
  const errEl = document.getElementById('disable-error');
  if (!pw) { if(errEl){errEl.textContent='Passwort erforderlich';errEl.classList.remove('hidden');} return; }
  try {
    await API.post('/auth/totp/disable', { password: pw, code: code || undefined });
    closeModal();
    toast('2FA wurde deaktiviert', 'success');
    loadSettings();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// OAUTH LOGIN & ACCOUNT LINKING
// ══════════════════════════════════════════════════════════════════════════════

const OAUTH_PROVIDERS = {
  github:  { name: 'GitHub',  color: '#24292e', bg: '#161b22', icon: 'github' },
  discord: { name: 'Discord', color: '#5865f2', bg: '#404eed', icon: 'message-circle' },
};

// ── Init: OAuth-Buttons im Login laden ───────────────────────────────────────
async function initOAuthButtons() {
  try {
    const active = await API.get('/auth/oauth/admin/providers').catch(() => ({}));
    const container = document.getElementById('oauth-btns-container');
    const wrapper   = document.getElementById('oauth-login-btns');
    if (!container || !wrapper) return;

    const available = Object.entries(active).filter(([,v]) => v.enabled);
    if (available.length === 0) { wrapper.style.display = 'none'; return; }

    wrapper.style.display = 'block';
    container.innerHTML = available.map(([provider, info]) => `
      <button class="btn btn-block" onclick="oauthLogin('${provider}')"
        style="background:${OAUTH_PROVIDERS[provider]?.bg||'#333'};color:#fff;border:none;display:flex;align-items:center;gap:10px;justify-content:center">
        <i data-lucide="${OAUTH_PROVIDERS[provider]?.icon||'link'}" style="width:16px;height:16px"></i>
        Weiter mit ${info.name}
      </button>
    `).join('');
    if (window.lucide) lucide.createIcons();
  } catch {}
}

// ── OAuth Login Popup ─────────────────────────────────────────────────────────
async function oauthLogin(provider) {
  try {
    const { url } = await API.get(`/auth/oauth/${provider}/url`);
    openOAuthPopup(url, result => {
      if (result.error) { showAuthError(result.error); return; }
      if (result.requires_totp) {
        _totpPendingToken = result.totp_token;
        showTotpStep();
        return;
      }
      if (result.token && result.user) {
        State.token = result.token;
        localStorage.setItem('hp_token', result.token);
        State.user = result.user;
        initApp();
      }
    });
  } catch (e) { showAuthError(e.message); }
}

// ── OAuth Account-Link Popup ──────────────────────────────────────────────────
async function oauthLink(provider) {
  try {
    const { url } = await API.get(`/auth/oauth/${provider}/url?link_token=${State.token}`);
    openOAuthPopup(url, result => {
      if (result.error) { toast(result.error, 'error'); return; }
      if (result.success && result.action === 'linked') {
        toast(`${OAUTH_PROVIDERS[provider]?.name} erfolgreich verknüpft!`, 'success');
        loadOAuthConnections();
      }
    });
  } catch (e) { toast(e.message, 'error'); }
}

// ── Popup-Helper ──────────────────────────────────────────────────────────────
function openOAuthPopup(url, callback) {
  const w = 520, h = 640;
  const left = Math.round(screen.width  / 2 - w / 2);
  const top  = Math.round(screen.height / 2 - h / 2);
  const popup = window.open(url, 'nexoauth',
    `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`);

  if (!popup) { toast('Popup wurde blockiert — bitte Popup-Blocker deaktivieren', 'error'); return; }

  const onMsg = (event) => {
    // Accept only from same origin
    if (event.origin !== window.location.origin) return;
    window.removeEventListener('message', onMsg);
    if (popup && !popup.closed) popup.close();
    callback(event.data || {});
  };
  window.addEventListener('message', onMsg);

  // Fallback: detect closed popup
  const timer = setInterval(() => {
    if (popup.closed) {
      clearInterval(timer);
      window.removeEventListener('message', onMsg);
    }
  }, 500);
}

// ── Verknüpfte Konten in Settings laden ───────────────────────────────────────
async function loadOAuthConnections() {
  const root = document.getElementById('oauth-connections-list');
  if (!root) return;

  try {
    const [conns, active] = await Promise.all([
      API.get('/auth/oauth/connections'),
      API.get('/auth/oauth/admin/providers').catch(() => ({})),
    ]);

    const connMap = {};
    for (const c of conns) connMap[c.provider] = c;

    const allProviders = Object.keys(OAUTH_PROVIDERS);
    root.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">
        ${allProviders.map(provider => {
          const info   = OAUTH_PROVIDERS[provider];
          const conn   = connMap[provider];
          const isActive = active[provider]?.enabled;
          return `
          <div style="border:1px solid var(--color-border-tertiary);border-radius:8px;padding:12px 14px;display:flex;align-items:center;gap:10px">
            <div style="width:36px;height:36px;border-radius:8px;background:${conn?info.bg:'var(--color-background-secondary)'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <i data-lucide="${info.icon}" style="width:18px;height:18px;color:${conn?'#fff':'var(--color-text-tertiary)'}"></i>
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:500;font-size:13px">${info.name}</div>
              ${conn
                ? `<div style="font-size:11px;color:var(--color-text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">@${esc(conn.username||conn.email||'verbunden')}</div>`
                : `<div style="font-size:11px;color:var(--color-text-tertiary)">${isActive ? 'Nicht verknüpft' : 'Nicht konfiguriert'}</div>`
              }
            </div>
            ${isActive
              ? conn
                ? `<button class="btn btn-ghost btn-sm" onclick="oauthUnlink('${provider}')" style="color:var(--color-text-danger);flex-shrink:0"><i data-lucide="unlink"></i></button>`
                : `<button class="btn btn-ghost btn-sm" onclick="oauthLink('${provider}')" style="flex-shrink:0"><i data-lucide="link"></i> Verknüpfen</button>`
              : ''
            }
          </div>`;
        }).join('')}
      </div>`;
    if (window.lucide) lucide.createIcons();
  } catch (e) {
    root.innerHTML = `<p class="text-dim text-sm">${esc(e.message)}</p>`;
  }
}

async function oauthUnlink(provider) {
  if (!confirm(`${OAUTH_PROVIDERS[provider]?.name}-Verknüpfung wirklich trennen?`)) return;
  try {
    await API.delete(`/auth/oauth/${provider}/unlink`);
    toast(`${OAUTH_PROVIDERS[provider]?.name} getrennt`, 'success');
    loadOAuthConnections();
  } catch(e) { toast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN: OAuth Konfiguration
// ══════════════════════════════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════════════════════════════
// ADMIN: Prometheus Metrics Export
// ══════════════════════════════════════════════════════════════════════════════

async function loadAdminPrometheus() {
  const root = document.getElementById('page-content');
  root.innerHTML = '<div class="empty"><div class="empty-icon spin"><i data-lucide="loader"></i></div></div>';
  if (window.lucide) lucide.createIcons();

  let tokenInfo = { configured: false, preview: null };
  let config    = { scrape_config: '', base_url: window.location.origin };

  try {
    [tokenInfo, config] = await Promise.all([
      API.get('/admin/metrics/token'),
      API.get('/admin/metrics/config'),
    ]);
  } catch {}

  const metricsUrl = `${config.base_url}/metrics`;

  root.innerHTML = `
    <div style="max-width:840px;display:flex;flex-direction:column;gap:14px">

      <!-- Status & Token -->
      <div class="card">
        <div class="card-header" style="margin-bottom:14px">
          <div>
            <div class="card-title"><i data-lucide="activity"></i> Prometheus Metrics</div>
            <p class="text-dim text-sm" style="margin:4px 0 0">Exportiert Server-Metriken im Prometheus text format. Erreichbar unter <code class="text-mono" style="font-size:11px">/metrics</code>.</p>
          </div>
          <span id="metrics-status-badge" style="padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600;flex-shrink:0;${tokenInfo.configured ? 'background:rgba(34,197,94,.12);color:#16a34a' : 'background:rgba(100,116,139,.12);color:var(--color-text-tertiary)'}">
            <i data-lucide="${tokenInfo.configured ? 'shield-check' : 'shield-off'}" style="width:12px;height:12px"></i>
            ${tokenInfo.configured ? 'Aktiv' : 'Kein Token'}
          </span>
        </div>

        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--color-background-secondary);border-radius:8px;margin-bottom:14px">
          <code style="flex:1;font-family:var(--font-mono);font-size:12px;color:var(--color-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(metricsUrl)}</code>
          <button class="btn btn-ghost btn-xs" onclick="navigator.clipboard.writeText('${esc(metricsUrl)}').then(()=>toast('URL kopiert','success'))">
            <i data-lucide="clipboard" style="width:12px;height:12px"></i>
          </button>
          <a href="${esc(metricsUrl)}" target="_blank" class="btn btn-ghost btn-xs"><i data-lucide="external-link" style="width:12px;height:12px"></i></a>
        </div>

        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          ${tokenInfo.configured
            ? `<div style="display:flex;align-items:center;gap:8px;flex:1;min-width:200px">
                <i data-lucide="key" style="width:14px;height:14px;color:var(--color-text-tertiary)"></i>
                <span style="font-family:var(--font-mono);font-size:12px;color:var(--color-text-tertiary)">${esc(tokenInfo.preview)}</span>
                <span style="font-size:10px;color:var(--color-text-tertiary)">(nur Vorschau, vollständiges Token nicht mehr einsehbar)</span>
              </div>`
            : `<span class="text-dim text-sm">Noch kein Token generiert — der /metrics Endpunkt ist gesperrt.</span>`
          }
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button class="btn btn-primary btn-sm" onclick="prometheusGenerateToken()">
              <i data-lucide="refresh-cw"></i> ${tokenInfo.configured ? 'Token neu generieren' : 'Token generieren'}
            </button>
            ${tokenInfo.configured
              ? `<button class="btn btn-ghost btn-sm" style="color:var(--color-text-danger)" onclick="prometheusDeleteToken()"><i data-lucide="trash-2"></i></button>`
              : ''}
          </div>
        </div>
      </div>

      <!-- Prometheus scrape config -->
      <div class="card">
        <div class="card-title" style="margin-bottom:10px"><i data-lucide="settings-2"></i> Prometheus Scrape Config</div>
        <p class="text-dim text-sm" style="margin-bottom:10px">In deine <code class="text-mono" style="font-size:11px">prometheus.yml</code> einfügen. <code>&lt;DEIN_TOKEN&gt;</code> durch dein generiertes Token ersetzen.</p>
        <div style="position:relative">
          <pre id="scrape-config-pre" style="background:var(--color-background-secondary);border-radius:8px;padding:14px;font-family:var(--font-mono);font-size:11px;line-height:1.7;color:var(--color-text-secondary);overflow-x:auto;margin:0;white-space:pre-wrap">${esc(config.scrape_config || '')}</pre>
          <button class="btn btn-ghost btn-xs" style="position:absolute;top:8px;right:8px"
            onclick="navigator.clipboard.writeText(document.getElementById('scrape-config-pre').textContent.trim()).then(()=>toast('Kopiert!','success'))">
            <i data-lucide="clipboard" style="width:12px;height:12px"></i>
          </button>
        </div>
      </div>

      <!-- Metriken Übersicht -->
      <div class="card">
        <div class="card-title" style="margin-bottom:12px"><i data-lucide="table"></i> Exportierte Metriken</div>
        <div style="overflow-x:auto">
          <table class="table" style="font-size:12px;min-width:560px">
            <thead><tr><th>Metrik</th><th>Typ</th><th>Labels</th><th>Beschreibung</th></tr></thead>
            <tbody>
              ${[
                ['nexpanel_server_status',          'gauge',   'id, name, node',  'Läuft? (1=ja, 0=nein)'],
                ['nexpanel_server_cpu_percent',      'gauge',   'id, name, node',  'CPU-Nutzung in %'],
                ['nexpanel_server_memory_mb',        'gauge',   'id, name, node',  'RAM-Nutzung in MB'],
                ['nexpanel_server_memory_limit_mb',  'gauge',   'id, name, node',  'RAM-Limit in MB'],
                ['nexpanel_server_memory_percent',   'gauge',   'id, name, node',  'RAM-Nutzung in % vom Limit'],
                ['nexpanel_server_disk_limit_mb',    'gauge',   'id, name, node',  'Disk-Limit in MB'],
                ['nexpanel_server_network_rx_bytes', 'counter', 'id, name, node',  'Netz-Empfang kumulativ'],
                ['nexpanel_server_network_tx_bytes', 'counter', 'id, name, node',  'Netz-Senden kumulativ'],
                ['nexpanel_server_pids',             'gauge',   'id, name, node',  'Prozesse im Container'],
                ['nexpanel_node_server_count',       'gauge',   'node_id, node_name', 'Server-Anzahl pro Node'],
                ['nexpanel_node_running_count',      'gauge',   'node_id, node_name', 'Laufende Server pro Node'],
                ['nexpanel_total_servers',           'gauge',   '—',              'Alle Server gesamt'],
                ['nexpanel_running_servers',         'gauge',   '—',              'Laufende Server gesamt'],
                ['nexpanel_total_users',             'gauge',   '—',              'Registrierte Benutzer'],
                ['nexpanel_total_nodes',             'gauge',   '—',              'Registrierte Nodes'],
                ['nexpanel_info',                    'gauge',   'version, uptime_seconds', 'Panel-Metadaten'],
              ].map(([name, type, lbls, desc]) => `
                <tr>
                  <td><code style="font-family:var(--font-mono);font-size:10px">${esc(name)}</code></td>
                  <td><span style="font-size:10px;padding:1px 6px;border-radius:8px;background:${type==='counter'?'rgba(99,102,241,.15)':'rgba(34,197,94,.12)'};color:${type==='counter'?'#818cf8':'#16a34a'}">${esc(type)}</span></td>
                  <td style="font-size:10px;color:var(--color-text-tertiary)">${esc(lbls)}</td>
                  <td style="font-size:11px">${esc(desc)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Grafana Dashboard -->
      <div class="card">
        <div class="card-title" style="margin-bottom:10px"><i data-lucide="bar-chart-2"></i> Grafana Dashboard</div>
        <p class="text-dim text-sm" style="margin-bottom:12px">
          Fertig konfiguriertes Dashboard JSON für Grafana. Import über <strong>Dashboards → Import → JSON einfügen</strong>.
        </p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" onclick="prometheusDownloadDashboard()">
            <i data-lucide="download"></i> Dashboard JSON herunterladen
          </button>
          <button class="btn btn-ghost btn-sm" onclick="prometheusPreviewDashboard()">
            <i data-lucide="eye"></i> Vorschau
          </button>
        </div>
      </div>

      <!-- Quick Setup -->
      <div class="card">
        <div class="card-title" style="margin-bottom:10px"><i data-lucide="terminal"></i> Quick Setup (Docker Compose)</div>
        <p class="text-dim text-sm" style="margin-bottom:10px">Prometheus + Grafana lokal starten und NexPanel sofort scrapen:</p>
        <div style="position:relative">
          <pre id="docker-compose-pre" style="background:var(--color-background-secondary);border-radius:8px;padding:14px;font-family:var(--font-mono);font-size:11px;line-height:1.7;color:var(--color-text-secondary);overflow-x:auto;margin:0;white-space:pre-wrap">${esc(buildDockerCompose(config.base_url))}</pre>
          <button class="btn btn-ghost btn-xs" style="position:absolute;top:8px;right:8px"
            onclick="navigator.clipboard.writeText(document.getElementById('docker-compose-pre').textContent.trim()).then(()=>toast('Kopiert!','success'))">
            <i data-lucide="clipboard" style="width:12px;height:12px"></i>
          </button>
        </div>
      </div>

    </div>`;

  // Store dashboard JSON for download
  window._prometheusDashboard = config.dashboard_json;
  if (window.lucide) lucide.createIcons();
}

function buildDockerCompose(baseUrl) {
  return `services:
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.retention.time=30d

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_AUTH_ANONYMOUS_ENABLED=false
    volumes:
      - grafana-data:/var/lib/grafana

volumes:
  grafana-data:

# prometheus.yml (separate Datei):
# scrape_configs:
#   - job_name: nexpanel
#     scrape_interval: 30s
#     static_configs:
#       - targets: ['host.docker.internal:3000']
#     metrics_path: /metrics
#     authorization:
#       type: Bearer
#       credentials: <DEIN_TOKEN>`;
}

async function prometheusGenerateToken() {
  if (!confirm('Neuen Token generieren? Ein bestehender Token wird ungültig.')) return;
  try {
    const result = await API.post('/admin/metrics/token', {});
    showModal(`
      <div class="modal-title">
        <span><i data-lucide="key"></i> Neuer Prometheus Token</span>
        <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
      </div>
      <div style="background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.2);border-radius:8px;padding:12px;margin-bottom:14px">
        <div style="font-size:11px;color:#d97706;margin-bottom:8px;font-weight:600">
          <i data-lucide="alert-triangle" style="width:12px;height:12px"></i>
          Einmalig! Diesen Token jetzt kopieren — er wird nicht mehr angezeigt.
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <code id="new-token-val" style="font-family:var(--font-mono);font-size:11px;background:var(--color-background-secondary);padding:8px 12px;border-radius:6px;flex:1;word-break:break-all;color:var(--color-text-primary)">${esc(result.token)}</code>
          <button class="btn btn-primary btn-sm" onclick="navigator.clipboard.writeText('${esc(result.token)}').then(()=>toast('Token kopiert!','success'))">
            <i data-lucide="clipboard"></i> Kopieren
          </button>
        </div>
      </div>
      <div style="font-size:11px;color:var(--color-text-tertiary);line-height:1.6">
        <strong>Verwendung:</strong><br>
        Authorization: Bearer ${esc(result.token)}<br>
        oder: /metrics?token=${esc(result.token)}
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="closeModal();loadAdminPrometheus()">Fertig</button>
      </div>
    `, true);
    if (window.lucide) lucide.createIcons();
  } catch (e) { toast(e.message, 'error'); }
}

async function prometheusDeleteToken() {
  if (!confirm('Token wirklich löschen? /metrics wird dann für alle gesperrt.')) return;
  try {
    await API.delete('/admin/metrics/token');
    toast('Token gelöscht', 'success');
    loadAdminPrometheus();
  } catch (e) { toast(e.message, 'error'); }
}

function prometheusDownloadDashboard() {
  const dash = window._prometheusDashboard;
  if (!dash) { toast('Dashboard-Daten nicht geladen', 'error'); return; }
  const blob = new Blob([JSON.stringify(dash, null, 2)], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'nexpanel-grafana-dashboard.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Dashboard JSON heruntergeladen', 'success');
}

function prometheusPreviewDashboard() {
  const dash = window._prometheusDashboard;
  if (!dash) { toast('Dashboard-Daten nicht geladen', 'error'); return; }
  showModal(`
    <div class="modal-title">
      <span><i data-lucide="bar-chart-2"></i> Grafana Dashboard Vorschau</span>
      <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      ${(dash.panels||[]).slice(0,12).map(p => `
        <div style="background:var(--color-background-secondary);border-radius:6px;padding:8px 12px;min-width:120px;flex:1">
          <div style="font-size:10px;color:var(--color-text-tertiary)">${esc(p.type)}</div>
          <div style="font-size:12px;font-weight:500">${esc(p.title)}</div>
        </div>`).join('')}
    </div>
    <div style="font-size:11px;color:var(--color-text-tertiary)">
      ${(dash.panels||[]).length} Panels · Refresh: ${esc(dash.refresh||'30s')} · Tags: ${(dash.tags||[]).join(', ')}
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Schließen</button>
      <button class="btn btn-primary" onclick="closeModal();prometheusDownloadDashboard()"><i data-lucide="download"></i> Herunterladen</button>
    </div>
  `, true);
  if (window.lucide) lucide.createIcons();
}

async function loadAdminOAuth() {
  const root = document.getElementById('page-content');
  root.innerHTML = '<div class="empty"><div class="empty-icon spin"><i data-lucide="loader"></i></div></div>';

  let cfg = {};
  try { cfg = await API.get('/admin/oauth/config'); } catch {}

  root.innerHTML = `
    <div style="max-width:760px">
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:4px"><i data-lucide="key-round"></i> OAuth / Social Login</div>
        <p class="text-dim text-sm" style="margin:0">Konfiguriere OAuth-Apps damit Benutzer sich mit GitHub oder Discord einloggen können.
        Erstelle eine OAuth-App auf der jeweiligen Developer-Plattform und trage Client-ID + Secret hier ein.</p>
      </div>

      ${Object.entries(OAUTH_PROVIDERS).map(([provider, info]) => `
      <div class="card" style="margin-bottom:12px">
        <div class="card-header" style="margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:36px;height:36px;border-radius:8px;background:${info.bg};display:flex;align-items:center;justify-content:center">
              <i data-lucide="${info.icon}" style="width:20px;height:20px;color:#fff"></i>
            </div>
            <div>
              <div class="card-title" style="margin:0">${info.name}</div>
              <div class="text-dim text-sm">${provider === 'github' ? 'github.com/settings/developers' : 'discord.com/developers/applications'}</div>
            </div>
          </div>
          <label class="toggle-wrap" style="margin-left:auto">
            <input type="checkbox" class="toggle-cb" id="oauth-${provider}-enabled"
              ${cfg[provider]?.client_id ? 'checked' : ''}
              onchange="document.getElementById('oauth-${provider}-fields').style.opacity=this.checked?1:.4">
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </label>
        </div>
        <div id="oauth-${provider}-fields" style="opacity:${cfg[provider]?.client_id ? 1 : .4}">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
            <div class="form-group" style="margin:0">
              <label class="form-label">Client ID</label>
              <input type="text" id="oauth-${provider}-id" class="form-input"
                value="${esc(cfg[provider]?.client_id || '')}" placeholder="${provider === 'github' ? 'Iv1.xxxxxxxxxxxx' : '000000000000000000'}"/>
            </div>
            <div class="form-group" style="margin:0">
              <label class="form-label">Client Secret</label>
              <input type="password" id="oauth-${provider}-secret" class="form-input"
                value="${esc(cfg[provider]?.client_secret || '')}" placeholder="••••••••••••••••"/>
            </div>
          </div>
          <div style="background:var(--color-background-secondary);border-radius:6px;padding:8px 12px;font-size:11px;color:var(--color-text-tertiary);line-height:1.6">
            <strong style="color:var(--color-text-secondary)">Callback URL (in der OAuth-App eintragen):</strong><br>
            <code id="oauth-${provider}-callback" style="font-family:var(--font-mono)">${window.location.origin}/api/auth/oauth/${provider}/callback</code>
            <button class="btn btn-ghost btn-sm" style="padding:2px 6px;margin-left:8px;font-size:10px"
              onclick="navigator.clipboard.writeText(document.getElementById('oauth-${provider}-callback').textContent).then(()=>toast('Kopiert!','success'))">
              <i data-lucide="clipboard" style="width:10px;height:10px"></i>
            </button>
          </div>
        </div>
      </div>
      `).join('')}

      <div id="oauth-save-err" class="error-msg hidden" style="margin-bottom:10px"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="loadAdminOAuth()"><i data-lucide="rotate-ccw"></i> Zurücksetzen</button>
        <button class="btn btn-primary" onclick="saveAdminOAuth()"><i data-lucide="save"></i> Speichern</button>
      </div>
    </div>`;
  if (window.lucide) lucide.createIcons();
}

async function saveAdminOAuth() {
  const errEl = document.getElementById('oauth-save-err');
  const body  = {};
  for (const provider of Object.keys(OAUTH_PROVIDERS)) {
    const enabled = document.getElementById(`oauth-${provider}-enabled`)?.checked;
    body[provider] = {
      client_id:     enabled ? (document.getElementById(`oauth-${provider}-id`)?.value.trim()     || '') : '',
      client_secret: enabled ? (document.getElementById(`oauth-${provider}-secret`)?.value.trim() || '') : '',
    };
  }
  try {
    await API.put('/admin/oauth/config', body);
    toast('OAuth-Konfiguration gespeichert', 'success');
    if (errEl) errEl.classList.add('hidden');
  } catch(e) {
    if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  }
}

async function changePassword() {
  const errEl = document.getElementById('s-error'), sucEl = document.getElementById('s-success');
  errEl.classList.add('hidden'); sucEl.classList.add('hidden');
  try {
    await API.post('/auth/change-password', { current_password: document.getElementById('s-cur-pass').value, new_password: document.getElementById('s-new-pass').value });
    sucEl.textContent = '<i data-lucide="check-circle"></i> Passwort erfolgreich geändert!'; sucEl.classList.remove('hidden');
  } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
}

// ═══════════════════════════════════════════════════════════════
// QUOTA-ANZEIGE (im Dashboard / Einstellungen)
// ═══════════════════════════════════════════════════════════════

async function loadQuotaWidget() {
  const container = document.getElementById('quota-widget');
  if (!container) return;

  const data = await API.get('/account/quota').catch(() => null);
  if (!data) { container.innerHTML = ''; return; }

  const { quota: q, usage: u, percentages: pct } = data;

  function bar(used, max, usedFmt, maxFmt, label, color='var(--accent)') {
    const p = pct[label] || 0;
    const col = p >= 90 ? 'var(--danger)' : p >= 70 ? 'var(--warn)' : color;
    return `
      <div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3);margin-bottom:3px">
          <span>${label.toUpperCase()}</span>
          <span style="color:${p>=90?'var(--danger)':p>=70?'var(--warn)':'var(--text2)'}">${usedFmt} / ${maxFmt}</span>
        </div>
        <div style="background:var(--bg3);border-radius:4px;height:5px;overflow:hidden">
          <div style="height:100%;width:${p}%;background:${col};border-radius:4px;transition:.4s"></div>
        </div>
      </div>`;
  }

  container.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-title" style="margin-bottom:12px"><i data-lucide="gauge"></i> Ressourcen-Quota</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${bar(u.servers, q.max_servers, u.servers+' Server', q.max_servers+' max', 'servers')}
        ${bar(u.ram_mb, q.max_ram_mb, (u.ram_mb/1024).toFixed(1)+'GB', (q.max_ram_mb/1024).toFixed(0)+'GB', 'ram')}
        ${bar(u.cpu_cores, q.max_cpu_cores, u.cpu_cores+' Kerne', q.max_cpu_cores+' max', 'cpu', 'var(--warn)')}
        ${bar(u.disk_mb, q.max_disk_mb, Math.round(u.disk_mb/1024)+'GB', Math.round(q.max_disk_mb/1024)+'GB', 'disk', 'var(--accent3)')}
        ${bar(u.dbs, q.max_dbs, u.dbs+' DBs', q.max_dbs+' max', 'dbs', '#a78bfa')}
      </div>
    </div>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

