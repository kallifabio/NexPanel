/**
 * routes/auth.js — Authentifizierung + 2FA/TOTP
 */
'use strict';

const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const crypto    = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../src/core/db');
const { getOrCreateJwtSecret } = require('../src/core/db');

function getSpeakeasy() {
  try { return require('speakeasy'); }
  catch { throw new Error('speakeasy nicht installiert. Führe "npm install" aus.'); }
}
function getQRCode() {
  try { return require('qrcode'); }
  catch { throw new Error('qrcode nicht installiert. Führe "npm install" aus.'); }
}

const JWT_SECRET          = process.env.JWT_SECRET || getOrCreateJwtSecret();
const JWT_EXPIRES         = '24h';
const TOTP_PENDING_SECRET = JWT_SECRET + '_totp_pending';
const TOTP_PENDING_EXPIRES= '5m';

const router = express.Router();

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Kein Token angegeben' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user    = db.prepare('SELECT * FROM users WHERE id=? AND is_suspended=0').get(decoded.id);
    if (!user) {
      const susp = db.prepare('SELECT is_suspended,suspend_reason FROM users WHERE id=?').get(decoded.id);
      if (susp?.is_suspended) return res.status(403).json({ error: 'SUSPENDED:' + (susp.suspend_reason || 'Dein Account wurde gesperrt') });
      return res.status(401).json({ error: 'Benutzer nicht gefunden' });
    }
    req.user = user;
    try {
      const tHash = crypto.createHash('sha256').update(token).digest('hex');
      db.prepare("UPDATE user_sessions SET last_seen=datetime('now') WHERE token_hash=? AND last_seen < datetime('now','-1 minute')").run(tHash);
    } catch {}
    return next();
  } catch {}

  if (token.startsWith('hp_') || token.startsWith('hpk_')) {
    const allKeys = db.prepare('SELECT * FROM api_keys').all();
    for (const k of allKeys) {
      if (bcrypt.compareSync(token, k.key_hash)) {
        const user = db.prepare('SELECT * FROM users WHERE id=? AND is_suspended=0').get(k.user_id);
        if (!user) return res.status(401).json({ error: 'Benutzer gesperrt' });
        db.prepare("UPDATE api_keys SET last_used_at=datetime('now') WHERE id=?").run(k.id);
        req.user   = user;
        req.apiKey = k;
        return next();
      }
    }
  }

  return res.status(401).json({ error: 'Ungültiger oder abgelaufener Token' });
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin-Berechtigung erforderlich' });
  next();
}

function canAccessServer(req, res, next) {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (req.user.role !== 'admin' && srv.user_id !== req.user.id)
    return res.status(403).json({ error: 'Zugriff verweigert' });
  req.targetServer = { ...srv, ports: JSON.parse(srv.ports), env_vars: JSON.parse(srv.env_vars) };
  next();
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function generateBackupCodes() {
  const plain = Array.from({ length: 8 }, () => {
    const a = crypto.randomBytes(3).toString('hex').toUpperCase();
    const b = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${a}-${b}`;
  });
  const hashed = plain.map(c => bcrypt.hashSync(c, 8));
  return { plain, hashed };
}

function consumeBackupCode(user, inputCode) {
  const raw = user.totp_backup_codes;
  if (!raw) return { valid: false };
  let codes;
  try { codes = JSON.parse(raw); } catch { return { valid: false }; }
  const normalized = inputCode.trim().toUpperCase().replace(/\s/g, '');
  let matchIdx = -1;
  for (let i = 0; i < codes.length; i++) {
    if (bcrypt.compareSync(normalized, codes[i])) { matchIdx = i; break; }
  }
  if (matchIdx === -1) return { valid: false };
  codes.splice(matchIdx, 1);
  db.prepare("UPDATE users SET totp_backup_codes=? WHERE id=?").run(JSON.stringify(codes), user.id);
  return { valid: true, remaining: codes.length };
}

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

function safeUser(user) {
  const { password_hash, totp_secret, totp_backup_codes, ...safe } = user;
  return safe;
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email und Passwort erforderlich' });

    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase().trim());
    if (!user) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    if (user.is_suspended) return res.status(403).json({ error: 'Account gesperrt' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });

    if (user.totp_enabled) {
      const pendingToken = jwt.sign({ id: user.id, type: 'totp_pending' }, TOTP_PENDING_SECRET, { expiresIn: TOTP_PENDING_EXPIRES });
      auditLog(user.id, 'LOGIN_2FA_REQUIRED', 'user', user.id, {}, req.ip);
      return res.json({ requires_totp: true, totp_token: pendingToken });
    }

    const token = issueSession(user, req);
    auditLog(user.id, 'LOGIN', 'user', user.id, {}, req.ip);
    res.json({ token, user: safeUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TOTP: VERIFY (Login Schritt 2) ──────────────────────────────────────────
router.post('/totp/verify', async (req, res) => {
  try {
    const { totp_token, code } = req.body;
    if (!totp_token || !code) return res.status(400).json({ error: 'totp_token und code erforderlich' });

    let decoded;
    try { decoded = jwt.verify(totp_token, TOTP_PENDING_SECRET); }
    catch { return res.status(401).json({ error: '2FA-Sitzung abgelaufen. Bitte neu anmelden.' }); }
    if (decoded.type !== 'totp_pending') return res.status(401).json({ error: 'Ungültiger Token-Typ' });

    const user = db.prepare('SELECT * FROM users WHERE id=? AND is_suspended=0').get(decoded.id);
    if (!user || !user.totp_enabled) return res.status(401).json({ error: 'Benutzer nicht gefunden oder 2FA inaktiv' });

    const speakeasy = getSpeakeasy();
    const valid = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: code.replace(/\s/g, ''), window: 1 });

    if (!valid) {
      auditLog(user.id, 'LOGIN_2FA_FAILED', 'user', user.id, {}, req.ip);
      return res.status(401).json({ error: 'Ungültiger 2FA-Code' });
    }

    const token = issueSession(user, req);
    auditLog(user.id, 'LOGIN_2FA_SUCCESS', 'user', user.id, {}, req.ip);
    res.json({ token, user: safeUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TOTP: RECOVER (Backup-Code beim Login) ───────────────────────────────────
router.post('/totp/recover', async (req, res) => {
  try {
    const { totp_token, backup_code } = req.body;
    if (!totp_token || !backup_code) return res.status(400).json({ error: 'totp_token und backup_code erforderlich' });

    let decoded;
    try { decoded = jwt.verify(totp_token, TOTP_PENDING_SECRET); }
    catch { return res.status(401).json({ error: '2FA-Sitzung abgelaufen' }); }
    if (decoded.type !== 'totp_pending') return res.status(401).json({ error: 'Ungültiger Token-Typ' });

    const user = db.prepare('SELECT * FROM users WHERE id=? AND is_suspended=0').get(decoded.id);
    if (!user || !user.totp_enabled) return res.status(401).json({ error: 'Benutzer nicht gefunden' });

    const result = consumeBackupCode(user, backup_code);
    if (!result.valid) {
      auditLog(user.id, 'LOGIN_BACKUP_CODE_FAILED', 'user', user.id, {}, req.ip);
      return res.status(401).json({ error: 'Ungültiger Backup-Code' });
    }

    const token = issueSession(user, req);
    auditLog(user.id, 'LOGIN_BACKUP_CODE_USED', 'user', user.id, { remaining: result.remaining }, req.ip);
    const resp = { token, user: safeUser(user) };
    if (result.remaining === 0) resp.warning = 'Alle Backup-Codes aufgebraucht! Bitte neue Codes unter Einstellungen generieren.';
    else resp.info = `Noch ${result.remaining} Backup-Code(s) übrig.`;
    res.json(resp);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TOTP: STATUS ─────────────────────────────────────────────────────────────
router.get('/totp/status', authenticate, (req, res) => {
  const user = db.prepare('SELECT totp_enabled, totp_backup_codes FROM users WHERE id=?').get(req.user.id);
  let backupCount = 0;
  try { if (user.totp_backup_codes) backupCount = JSON.parse(user.totp_backup_codes).length; } catch {}
  res.json({ enabled: !!user.totp_enabled, backup_codes_remaining: backupCount });
});

// ─── TOTP: SETUP (QR generieren) ─────────────────────────────────────────────
router.post('/totp/setup', authenticate, async (req, res) => {
  try {
    if (req.user.totp_enabled) return res.status(400).json({ error: '2FA ist bereits aktiviert' });

    const speakeasy = getSpeakeasy();
    const QRCode    = getQRCode();
    const secret    = speakeasy.generateSecret({ name: `NexPanel (${req.user.email})`, length: 32 });

    db.prepare("UPDATE users SET totp_secret=? WHERE id=?").run(secret.base32, req.user.id);

    const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);
    res.json({ secret: secret.base32, otpauth_url: secret.otpauth_url, qr_data_url: qrDataUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TOTP: CONFIRM (aktivieren) ───────────────────────────────────────────────
router.post('/totp/confirm', authenticate, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code erforderlich' });

    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!user.totp_secret) return res.status(400).json({ error: 'Bitte erst Setup starten' });
    if (user.totp_enabled)  return res.status(400).json({ error: '2FA ist bereits aktiviert' });

    const speakeasy = getSpeakeasy();
    const valid = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: code.replace(/\s/g, ''), window: 1 });
    if (!valid) return res.status(401).json({ error: 'Ungültiger Code — bitte erneut versuchen' });

    const { plain, hashed } = generateBackupCodes();
    db.prepare("UPDATE users SET totp_enabled=1, totp_backup_codes=? WHERE id=?").run(JSON.stringify(hashed), req.user.id);
    auditLog(req.user.id, 'TOTP_ENABLED', 'user', req.user.id, {}, req.ip);

    res.json({ success: true, backup_codes: plain });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TOTP: DISABLE ────────────────────────────────────────────────────────────
router.post('/totp/disable', authenticate, async (req, res) => {
  try {
    const { password, code } = req.body;
    if (!password) return res.status(400).json({ error: 'Passwort erforderlich' });

    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!user.totp_enabled) return res.status(400).json({ error: '2FA ist nicht aktiviert' });

    const pwValid = await bcrypt.compare(password, user.password_hash);
    if (!pwValid) return res.status(401).json({ error: 'Falsches Passwort' });

    if (code) {
      const speakeasy = getSpeakeasy();
      const totpValid = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: code.replace(/\s/g, ''), window: 1 });
      if (!totpValid) {
        const backupResult = consumeBackupCode(user, code);
        if (!backupResult.valid) return res.status(401).json({ error: 'Ungültiger 2FA-Code' });
      }
    }

    db.prepare("UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_backup_codes=NULL WHERE id=?").run(req.user.id);
    auditLog(req.user.id, 'TOTP_DISABLED', 'user', req.user.id, {}, req.ip);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TOTP: BACKUP CODES REGENERIEREN ─────────────────────────────────────────
router.post('/totp/backup-codes/regen', authenticate, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Passwort zur Bestätigung erforderlich' });

    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!user.totp_enabled) return res.status(400).json({ error: '2FA ist nicht aktiviert' });

    const pwValid = await bcrypt.compare(password, user.password_hash);
    if (!pwValid) return res.status(401).json({ error: 'Falsches Passwort' });

    const { plain, hashed } = generateBackupCodes();
    db.prepare("UPDATE users SET totp_backup_codes=? WHERE id=?").run(JSON.stringify(hashed), req.user.id);
    auditLog(req.user.id, 'TOTP_BACKUP_CODES_REGEN', 'user', req.user.id, {}, req.ip);

    res.json({ backup_codes: plain });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PASSWORT ÄNDERN ─────────────────────────────────────────────────────────
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!await bcrypt.compare(current_password, req.user.password_hash))
      return res.status(401).json({ error: 'Aktuelles Passwort ist falsch' });
    if ((new_password || '').length < 8) return res.status(400).json({ error: 'Neues Passwort mind. 8 Zeichen' });
    const hash = await bcrypt.hash(new_password, 12);
    db.prepare("UPDATE users SET password_hash=?, updated_at=datetime('now') WHERE id=?").run(hash, req.user.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── REGISTER ────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Alle Felder sind erforderlich' });
    if (password.length < 8) return res.status(400).json({ error: 'Passwort muss mind. 8 Zeichen lang sein' });
    const exists = db.prepare('SELECT id FROM users WHERE email=? OR username=?').get(email.toLowerCase(), username);
    if (exists) return res.status(409).json({ error: 'Email oder Username bereits vergeben' });
    const id   = uuidv4();
    const hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO users (id,username,email,password_hash) VALUES (?,?,?,?)').run(id, username.trim(), email.toLowerCase().trim(), hash);
    const token = jwt.sign({ id, role: 'user' }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.status(201).json({ token, user: { id, username, email: email.toLowerCase(), role: 'user' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ME ───────────────────────────────────────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
  res.json(safeUser(req.user));
});

module.exports = { router, authenticate, requireAdmin, canAccessServer };
