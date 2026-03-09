/**
 * routes/auth.js — Authentifizierungs-Routen
 */

'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../db');

const { getOrCreateJwtSecret } = require('../db');
const JWT_SECRET = process.env.JWT_SECRET || getOrCreateJwtSecret();
const JWT_EXPIRES= '24h';

const router = express.Router();

// ─── MIDDLEWARE EXPORT ────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Kein Token angegeben' });

  // JWT prüfen
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user    = db.prepare('SELECT * FROM users WHERE id=? AND is_suspended=0').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'Benutzer nicht gefunden oder gesperrt' });
    req.user = user;
    return next();
  } catch {}

  // API-Key prüfen (hp_ oder hpk_ Prefix)
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

// ─── ROUTEN ──────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email und Passwort erforderlich' });

    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase().trim());
    if (!user) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    if (user.is_suspended) return res.status(403).json({ error: 'Account gesperrt' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    auditLog(user.id, 'LOGIN', 'user', user.id, {}, req.ip);

    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Alle Felder sind erforderlich' });
    if (password.length < 8) return res.status(400).json({ error: 'Passwort muss mind. 8 Zeichen lang sein' });

    const exists = db.prepare('SELECT id FROM users WHERE email=? OR username=?').get(email.toLowerCase(), username);
    if (exists) return res.status(409).json({ error: 'Email oder Username bereits vergeben' });

    const id   = uuidv4();
    const hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO users (id,username,email,password_hash) VALUES (?,?,?,?)')
      .run(id, username.trim(), email.toLowerCase().trim(), hash);

    const token = jwt.sign({ id, role: 'user' }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.status(201).json({ token, user: { id, username, email: email.toLowerCase(), role: 'user' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/me', authenticate, (req, res) => {
  const { password_hash, ...user } = req.user;
  res.json(user);
});

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

module.exports = { router, authenticate, requireAdmin, canAccessServer };
