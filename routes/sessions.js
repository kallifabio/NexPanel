'use strict';
/**
 * routes/sessions.js — Session-Management
 *
 * Sessions werden beim Login angelegt und in user_sessions gespeichert.
 * Das ermöglicht:
 *  - Alle aktiven Logins anzeigen
 *  - Einzelne Sessions remote beenden
 *  - Alle anderen Sessions beenden (wie "Überall abmelden")
 *
 * GET    /api/account/sessions          — Eigene Sessions
 * DELETE /api/account/sessions/:id      — Eine Session beenden
 * DELETE /api/account/sessions          — Alle anderen Sessions beenden
 * GET    /api/admin/sessions            — Alle Sessions (Admin)
 * DELETE /api/admin/sessions/:id        — Beliebige Session (Admin)
 */

const express = require('express');
const crypto  = require('crypto');
const { db, auditLog } = require('../db');
const { authenticate, requireAdmin } = require('./auth');

const router = express.Router();

// ─── HELPER ───────────────────────────────────────────────────────────────────
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function formatSession(s, currentTokenHash) {
  return {
    id:          s.id,
    ip:          s.ip || '—',
    user_agent:  s.user_agent || '—',
    last_seen:   s.last_seen,
    created_at:  s.created_at,
    expires_at:  s.expires_at,
    is_current:  s.token_hash === currentTokenHash,
    user_id:     s.user_id,
    username:    s.username,
  };
}

function getCurrentTokenHash(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return token ? hashToken(token) : null;
}

// ─── EIGENE SESSIONS ──────────────────────────────────────────────────────────
router.get('/account/sessions', authenticate, (req, res) => {
  const sessions = db.prepare(`
    SELECT s.*, u.username FROM user_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.user_id = ? AND s.expires_at > datetime('now')
    ORDER BY s.last_seen DESC
  `).all(req.user.id);

  const currentHash = getCurrentTokenHash(req);
  res.json(sessions.map(s => formatSession(s, currentHash)));
});

// ─── EINE SESSION BEENDEN ─────────────────────────────────────────────────────
router.delete('/account/sessions/:sessionId', authenticate, (req, res) => {
  const s = db.prepare('SELECT * FROM user_sessions WHERE id=?').get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'Session nicht gefunden' });
  if (s.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Kein Zugriff' });

  db.prepare('DELETE FROM user_sessions WHERE id=?').run(s.id);
  auditLog(req.user.id, 'SESSION_REVOKE', 'user', s.user_id, { session_id: s.id, ip: s.ip }, req.ip);
  res.json({ success: true });
});

// ─── ALLE ANDEREN SESSIONS BEENDEN ────────────────────────────────────────────
router.delete('/account/sessions', authenticate, (req, res) => {
  const currentHash = getCurrentTokenHash(req);
  const result = db.prepare(
    'DELETE FROM user_sessions WHERE user_id=? AND token_hash != ?'
  ).run(req.user.id, currentHash || '');
  auditLog(req.user.id, 'SESSION_REVOKE_ALL', 'user', req.user.id, { count: result.changes }, req.ip);
  res.json({ success: true, revoked: result.changes });
});

// ─── ADMIN: ALLE SESSIONS ─────────────────────────────────────────────────────
router.get('/admin/sessions', authenticate, requireAdmin, (req, res) => {
  const sessions = db.prepare(`
    SELECT s.*, u.username FROM user_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.expires_at > datetime('now')
    ORDER BY s.last_seen DESC LIMIT 200
  `).all();
  const currentHash = getCurrentTokenHash(req);
  res.json(sessions.map(s => formatSession(s, currentHash)));
});

router.delete('/admin/sessions/:sessionId', authenticate, requireAdmin, (req, res) => {
  const s = db.prepare('SELECT * FROM user_sessions WHERE id=?').get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'Session nicht gefunden' });
  db.prepare('DELETE FROM user_sessions WHERE id=?').run(s.id);
  auditLog(req.user.id, 'SESSION_REVOKE_ADMIN', 'user', s.user_id, { ip: s.ip }, req.ip);
  res.json({ success: true });
});

// ─── CLEANUP ABGELAUFENER SESSIONS ────────────────────────────────────────────
function cleanupExpiredSessions() {
  try {
    const r = db.prepare("DELETE FROM user_sessions WHERE expires_at < datetime('now')").run();
    if (r.changes > 0) console.log(`[sessions] ${r.changes} abgelaufene Sessions gelöscht`);
  } catch {}
}

// Einmal täglich aufräumen
setInterval(cleanupExpiredSessions, 24 * 60 * 60 * 1000);
setTimeout(cleanupExpiredSessions, 10_000);

module.exports = router;
module.exports.hashToken = hashToken;
module.exports.cleanupExpiredSessions = cleanupExpiredSessions;
