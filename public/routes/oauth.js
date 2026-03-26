/**
 * routes/oauth.js — OAuth 2.0 Login: GitHub & Discord
 *
 * Popup-basierter Flow:
 *   1. Frontend ruft GET /api/auth/oauth/:provider/url ab → { url, state }
 *   2. Frontend öffnet popup zu dieser URL (Provider-Login)
 *   3. Provider leitet zurück zu GET /api/auth/oauth/:provider/callback?code=&state=
 *   4. Server tauscht Code gegen Token, lädt User-Profil, sucht/erstellt NexPanel-User
 *   5. Server gibt HTML zurück, das window.opener.postMessage({token,user}|{error}) macht + schließt
 *
 * Account-Verknüpfung (im eingeloggten Zustand):
 *   POST /api/auth/oauth/:provider/link?state=...   → verknüpft OAuth mit aktuellem Account
 *   DELETE /api/auth/oauth/:provider/unlink         → trennt Verknüpfung (nur wenn PW vorhanden)
 *   GET  /api/auth/oauth/connections                → alle verknüpften OAuth-Konten
 *
 * Admin-Konfiguration:
 *   GET  /api/admin/oauth/config  → liest Client-IDs/-Secrets
 *   PUT  /api/admin/oauth/config  → speichert Credentials in settings-Tabelle
 */

'use strict';

const express  = require('express');
const https    = require('https');
const http     = require('http');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const jwt      = require('jsonwebtoken');
const { db, auditLog } = require('../src/core/db');
const { authenticate, requireAdmin } = require('./auth');
const { getOrCreateJwtSecret } = require('../src/core/db');

const JWT_SECRET  = process.env.JWT_SECRET || getOrCreateJwtSecret();
const JWT_EXPIRES = '24h';

const router = express.Router();

// ─── In-Memory State-Store (TTL 10 min) ──────────────────────────────────────
const _stateStore = new Map();  // state → { provider, link_user_id?, created_at }
const STATE_TTL_MS = 10 * 60 * 1000;

function createState(provider, linkUserId = null) {
  const state = crypto.randomBytes(24).toString('hex');
  _stateStore.set(state, { provider, link_user_id: linkUserId, created_at: Date.now() });
  // Cleanup old states
  for (const [k, v] of _stateStore) {
    if (Date.now() - v.created_at > STATE_TTL_MS) _stateStore.delete(k);
  }
  return state;
}

function consumeState(state) {
  const data = _stateStore.get(state);
  if (!data) return null;
  if (Date.now() - data.created_at > STATE_TTL_MS) { _stateStore.delete(state); return null; }
  _stateStore.delete(state);
  return data;
}

// ─── OAuth Provider Konfiguration ────────────────────────────────────────────
const PROVIDERS = {
  github: {
    name:          'GitHub',
    color:         '#24292e',
    icon:          'github',
    authUrl:       'https://github.com/login/oauth/authorize',
    tokenUrl:      'https://github.com/login/oauth/access_token',
    userUrl:       'https://api.github.com/user',
    emailUrl:      'https://api.github.com/user/emails',
    scope:         'read:user user:email',
  },
  discord: {
    name:          'Discord',
    color:         '#5865f2',
    icon:          'message-circle',
    authUrl:       'https://discord.com/api/oauth2/authorize',
    tokenUrl:      'https://discord.com/api/oauth2/token',
    userUrl:       'https://discord.com/api/users/@me',
    scope:         'identify email',
  },
};

function getProviderConfig(provider) {
  if (!PROVIDERS[provider]) return null;
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(`oauth_${provider}`);
  let creds = {};
  try { creds = row ? JSON.parse(row.value) : {}; } catch {}
  return {
    ...PROVIDERS[provider],
    client_id:     creds.client_id     || process.env[`${provider.toUpperCase()}_CLIENT_ID`]     || '',
    client_secret: creds.client_secret || process.env[`${provider.toUpperCase()}_CLIENT_SECRET`] || '',
    enabled:       !!(creds.client_id  || process.env[`${provider.toUpperCase()}_CLIENT_ID`]),
  };
}

// ─── HTTP-Helper ──────────────────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'NexPanel/3.0', ...headers } },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u      = new URL(url);
    const mod    = u.protocol === 'https:' ? https : http;
    const bStr   = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const opts   = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Accept':         'application/json',
        'User-Agent':     'NexPanel/3.0',
        'Content-Length': Buffer.byteLength(bStr),
        ...headers,
      },
    };
    const req = mod.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(bStr);
    req.end();
  });
}

// ─── Provider: Token + Profil abrufen ────────────────────────────────────────
async function fetchGithubProfile(code, cfg, redirectUri) {
  const tokenData = await httpsPost(cfg.tokenUrl, {
    client_id:     cfg.client_id,
    client_secret: cfg.client_secret,
    code,
    redirect_uri:  redirectUri,
  });
  if (!tokenData.access_token) throw new Error('GitHub Token-Fehler: ' + (tokenData.error_description || tokenData.error || 'Unbekannt'));

  const [profile, emails] = await Promise.all([
    httpsGet(cfg.userUrl,   { Authorization: `Bearer ${tokenData.access_token}` }),
    httpsGet(cfg.emailUrl,  { Authorization: `Bearer ${tokenData.access_token}` }).catch(() => []),
  ]);

  const primaryEmail = Array.isArray(emails)
    ? (emails.find(e => e.primary && e.verified) || emails.find(e => e.primary) || emails[0])?.email
    : null;

  return {
    provider_id: String(profile.id),
    username:    profile.login || '',
    email:       primaryEmail || profile.email || '',
    avatar_url:  profile.avatar_url || '',
    name:        profile.name || profile.login || '',
  };
}

async function fetchDiscordProfile(code, cfg, redirectUri) {
  const tokenData = await httpsPost(cfg.tokenUrl, {
    client_id:     cfg.client_id,
    client_secret: cfg.client_secret,
    grant_type:    'authorization_code',
    code,
    redirect_uri:  redirectUri,
  });
  if (!tokenData.access_token) throw new Error('Discord Token-Fehler: ' + (tokenData.error_description || tokenData.error || 'Unbekannt'));

  const profile = await httpsGet(cfg.userUrl, { Authorization: `Bearer ${tokenData.access_token}` });
  const avatar  = profile.avatar
    ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
    : '';

  return {
    provider_id: String(profile.id),
    username:    profile.username || '',
    email:       profile.email || '',
    avatar_url:  avatar,
    name:        profile.global_name || profile.username || '',
  };
}

async function fetchProfile(provider, code, cfg, redirectUri) {
  if (provider === 'github')  return fetchGithubProfile(code, cfg, redirectUri);
  if (provider === 'discord') return fetchDiscordProfile(code, cfg, redirectUri);
  throw new Error('Unbekannter Provider: ' + provider);
}

// ─── Session ausstellen ───────────────────────────────────────────────────────
function issueSession(user, req) {
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  try {
    const tHash     = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
    db.prepare("INSERT OR IGNORE INTO user_sessions (id,user_id,token_hash,ip,user_agent,expires_at) VALUES (?,?,?,?,?,?)")
      .run(uuidv4(), user.id, tHash, req.ip || '', (req.headers['user-agent'] || '').substring(0, 200), expiresAt);
  } catch {}
  return token;
}

// ─── Callback HTML ────────────────────────────────────────────────────────────
function callbackHtml(payload) {
  const json = JSON.stringify(payload);
  return `<!DOCTYPE html><html><head><title>NexPanel OAuth</title></head><body>
<script>
  try {
    if (window.opener) {
      window.opener.postMessage(${json}, window.location.origin);
    }
  } catch(e) {}
  window.close();
  setTimeout(() => { document.body.innerText = 'Du kannst dieses Fenster schließen.'; }, 200);
</script>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#94a3b8;font-size:14px}</style>
<p>Verarbeitung… Dieses Fenster schließt sich automatisch.</p>
</body></html>`;
}

// ─── GET /api/auth/oauth/:provider/url ────────────────────────────────────────
// Gibt die Authorization-URL zurück (Frontend öffnet Popup dazu)
router.get('/:provider/url', (req, res) => {
  const { provider } = req.params;
  const cfg = getProviderConfig(provider);
  if (!cfg) return res.status(404).json({ error: 'Unbekannter Provider' });
  if (!cfg.enabled || !cfg.client_id) return res.status(400).json({ error: `${cfg.name} OAuth ist nicht konfiguriert` });

  // Optional: Link-Modus — JWT im query übergeben, state merkt sich user_id
  let linkUserId = null;
  if (req.query.link_token) {
    try {
      const decoded = jwt.verify(req.query.link_token, JWT_SECRET);
      linkUserId = decoded.id;
    } catch {}
  }

  const state       = createState(provider, linkUserId);
  const redirectUri = `${getBaseUrl(req)}/api/auth/oauth/${provider}/callback`;
  const params      = new URLSearchParams({
    client_id:    cfg.client_id,
    redirect_uri: redirectUri,
    scope:        cfg.scope,
    state,
    response_type: 'code',
  });
  if (provider === 'discord') params.set('prompt', 'none');

  res.json({ url: `${cfg.authUrl}?${params}`, state });
});

// ─── GET /api/auth/oauth/:provider/callback ────────────────────────────────────
router.get('/:provider/callback', async (req, res) => {
  const { provider }       = req.params;
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return res.send(callbackHtml({ error: `OAuth abgebrochen: ${oauthError}` }));
  }

  const stateData = consumeState(state);
  if (!stateData || stateData.provider !== provider) {
    return res.send(callbackHtml({ error: 'Ungültiger oder abgelaufener State-Parameter' }));
  }

  const cfg = getProviderConfig(provider);
  if (!cfg || !cfg.client_id) {
    return res.send(callbackHtml({ error: `${provider} ist nicht konfiguriert` }));
  }

  try {
    const redirectUri = `${getBaseUrl(req)}/api/auth/oauth/${provider}/callback`;
    const profile     = await fetchProfile(provider, code, cfg, redirectUri);

    // ── Link-Modus: OAuth an bestehenden Account anhängen ──────────────────
    if (stateData.link_user_id) {
      const existing = db.prepare('SELECT * FROM oauth_connections WHERE provider=? AND provider_id=?')
        .get(provider, profile.provider_id);

      if (existing && existing.user_id !== stateData.link_user_id) {
        return res.send(callbackHtml({ error: `Dieses ${cfg.name}-Konto ist bereits mit einem anderen NexPanel-Account verknüpft.` }));
      }

      db.prepare(`
        INSERT OR REPLACE INTO oauth_connections (id, user_id, provider, provider_id, username, email, avatar_url)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        existing?.id || uuidv4(),
        stateData.link_user_id,
        provider, profile.provider_id,
        profile.username, profile.email, profile.avatar_url
      );

      auditLog(stateData.link_user_id, 'OAUTH_LINK', 'user', stateData.link_user_id,
        { provider, username: profile.username }, '');
      return res.send(callbackHtml({ success: true, action: 'linked', provider, username: profile.username }));
    }

    // ── Login-Modus ────────────────────────────────────────────────────────
    // 1) OAuth-Connection schon vorhanden?
    let conn = db.prepare('SELECT * FROM oauth_connections WHERE provider=? AND provider_id=?')
      .get(provider, profile.provider_id);

    let user = conn ? db.prepare('SELECT * FROM users WHERE id=?').get(conn.user_id) : null;

    // 2) Gleiche Email → mit bestehendem Account verknüpfen
    if (!user && profile.email) {
      const byEmail = db.prepare('SELECT * FROM users WHERE email=?').get(profile.email.toLowerCase());
      if (byEmail) {
        user = byEmail;
        // Auto-link
        db.prepare(`
          INSERT OR REPLACE INTO oauth_connections (id, user_id, provider, provider_id, username, email, avatar_url)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), user.id, provider, profile.provider_id, profile.username, profile.email, profile.avatar_url);
      }
    }

    // 3) Neu registrieren
    if (!user) {
      // Username sicherstellen (eindeutig)
      let username = (profile.username || profile.name || provider + '_user').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 20);
      if (!username) username = provider.substring(0, 4) + '_' + crypto.randomBytes(3).toString('hex');

      // Username-Konflikt lösen
      let finalUsername = username;
      let attempt = 0;
      while (db.prepare('SELECT id FROM users WHERE username=?').get(finalUsername)) {
        attempt++;
        finalUsername = username.substring(0, 16) + '_' + attempt;
      }

      const newId    = uuidv4();
      const email    = profile.email?.toLowerCase() || `${newId.substring(0,8)}@oauth.nexpanel`;
      const pwdHash  = '!oauth_no_password_' + crypto.randomBytes(16).toString('hex'); // non-crackable placeholder

      db.prepare('INSERT INTO users (id, username, email, password_hash) VALUES (?,?,?,?)')
        .run(newId, finalUsername, email, pwdHash);

      db.prepare(`
        INSERT INTO oauth_connections (id, user_id, provider, provider_id, username, email, avatar_url)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), newId, provider, profile.provider_id, profile.username, profile.email, profile.avatar_url);

      user = db.prepare('SELECT * FROM users WHERE id=?').get(newId);
      auditLog(user.id, 'OAUTH_REGISTER', 'user', user.id, { provider, username: profile.username }, '');
    } else {
      // Avatar/Username in connection aktualisieren
      if (conn) {
        db.prepare('UPDATE oauth_connections SET username=?, avatar_url=? WHERE id=?')
          .run(profile.username, profile.avatar_url, conn.id);
      }
    }

    if (user.is_suspended) {
      return res.send(callbackHtml({ error: 'Dein Account ist gesperrt.' }));
    }

    const token = issueSession(user, req);
    auditLog(user.id, 'LOGIN_OAUTH', 'user', user.id, { provider }, req.ip);

    const { password_hash, totp_secret, totp_backup_codes, ...safeUser } = user;
    // 2FA-Check
    if (user.totp_enabled) {
      const TOTP_PENDING_SECRET  = JWT_SECRET + '_totp_pending';
      const pendingToken = jwt.sign({ id: user.id, type: 'totp_pending' }, TOTP_PENDING_SECRET, { expiresIn: '5m' });
      return res.send(callbackHtml({ requires_totp: true, totp_token: pendingToken }));
    }

    return res.send(callbackHtml({ token, user: safeUser }));
  } catch (e) {
    console.error('[oauth] Callback-Fehler:', e.message);
    return res.send(callbackHtml({ error: 'OAuth-Fehler: ' + e.message }));
  }
});

// ─── GET /api/auth/oauth/connections ─────────────────────────────────────────
router.get('/connections', authenticate, (req, res) => {
  const conns = db.prepare('SELECT id, provider, username, email, avatar_url, created_at FROM oauth_connections WHERE user_id=?')
    .all(req.user.id);
  res.json(conns);
});

// ─── DELETE /api/auth/oauth/:provider/unlink ──────────────────────────────────
router.delete('/:provider/unlink', authenticate, (req, res) => {
  const { provider } = req.params;
  const conn = db.prepare('SELECT * FROM oauth_connections WHERE user_id=? AND provider=?').get(req.user.id, provider);
  if (!conn) return res.status(404).json({ error: 'Keine Verknüpfung gefunden' });

  // Sicherheitscheck: User muss Passwort haben ODER andere OAuth-Verbindung
  const otherConns = db.prepare('SELECT COUNT(*) as n FROM oauth_connections WHERE user_id=? AND provider!=?').get(req.user.id, provider);
  const hasPassword = !req.user.password_hash?.startsWith('!oauth_no_password_');
  if (!hasPassword && otherConns.n === 0) {
    return res.status(400).json({ error: 'Du musst mindestens eine Login-Methode behalten (Passwort oder andere OAuth-Verbindung).' });
  }

  db.prepare('DELETE FROM oauth_connections WHERE id=?').run(conn.id);
  auditLog(req.user.id, 'OAUTH_UNLINK', 'user', req.user.id, { provider }, req.ip);
  res.json({ success: true });
});

// ─── GET /api/admin/oauth/config ─────────────────────────────────────────────
router.get('/admin/config', authenticate, requireAdmin, (req, res) => {
  const config = {};
  for (const provider of Object.keys(PROVIDERS)) {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(`oauth_${provider}`);
    let creds = {};
    try { creds = row ? JSON.parse(row.value) : {}; } catch {}
    config[provider] = {
      client_id:     creds.client_id     || '',
      client_secret: creds.client_secret || '',
      enabled:       !!(creds.client_id),
    };
  }
  res.json(config);
});

// ─── PUT /api/admin/oauth/config ─────────────────────────────────────────────
router.put('/admin/config', authenticate, requireAdmin, (req, res) => {
  const { github, discord } = req.body;
  for (const [provider, creds] of Object.entries({ github, discord })) {
    if (!creds) continue;
    const val = JSON.stringify({
      client_id:     (creds.client_id     || '').trim(),
      client_secret: (creds.client_secret || '').trim(),
    });
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(`oauth_${provider}`, val);
  }
  auditLog(req.user.id, 'OAUTH_CONFIG_UPDATE', 'settings', 'oauth', {}, req.ip);
  res.json({ success: true });
});

// ─── GET /api/admin/oauth/providers — welche Provider sind aktiv ──────────────
router.get('/admin/providers', (req, res) => {
  const active = {};
  for (const provider of Object.keys(PROVIDERS)) {
    const cfg = getProviderConfig(provider);
    active[provider] = { enabled: cfg.enabled, name: cfg.name };
  }
  res.json(active);
});

// ─── Hilfsfunktion: Base-URL ermitteln ───────────────────────────────────────
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host  = req.headers['x-forwarded-host']  || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

module.exports = router;
