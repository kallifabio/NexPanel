/**
 * routes/admin.js — Admin-Routen + API-Keys
 * User-Management, Stats, Audit-Log, Docker-Images (v1 Legacy), API-Keys
 */

'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../db');
// server_subusers table used in audit check above
const { authenticate, requireAdmin } = require('./auth');
const { isConnected }  = require('../daemon-hub');
const dockerLocal      = require('../docker-local');
const { routeToNode }  = require('../node-router');

const router = express.Router();

// ─── ADMIN: STATISTIKEN ──────────────────────────────────────────────────────
router.get('/stats', authenticate, requireAdmin, async (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  const stats = {
    users:    db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    servers:  db.prepare('SELECT COUNT(*) as c FROM servers').get().c,
    running:  db.prepare("SELECT COUNT(*) as c FROM servers WHERE status='running'").get().c,
    suspended: db.prepare('SELECT COUNT(*) as c FROM users WHERE is_suspended=1').get().c,
    nodes:    nodes.length,
    nodes_online: nodes.filter(n => isConnected(n.id) || n.is_local).length,
  };

  // Docker-Info vom lokalen Node (v1-Kompatibilität)
  const localNode = nodes.find(n => n.is_local);
  if (localNode) {
    try {
      const info = await dockerLocal.getDockerInfo();
      stats.docker = info;
    } catch { stats.docker = { error: 'Nicht verfügbar' }; }
  } else {
    stats.docker = { note: 'Kein lokaler Node' };
  }

  stats.nodes_detail = nodes.map(n => ({
    id: n.id, name: n.name, fqdn: n.fqdn, location: n.location,
    is_local:    n.is_local,
    connected:   isConnected(n.id) || (!!n.is_local && dockerLocal.isAvailable()),
    server_count: db.prepare('SELECT COUNT(*) as c FROM servers WHERE node_id=?').get(n.id).c,
    system_info:  n.system_info ? JSON.parse(n.system_info) : null,
  }));

  res.json(stats);
});

// ─── ADMIN: AUDIT LOG ────────────────────────────────────────────────────────
router.get('/audit-log', authenticate, requireAdmin, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const logs   = db.prepare(`
    SELECT a.*, u.username FROM audit_log a
    LEFT JOIN users u ON a.user_id=u.id
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  res.json(logs);
});


// ─── SERVER-SPEZIFISCHES AUDIT LOG ───────────────────────────────────────────
router.get('/audit-log/server/:serverId', authenticate, (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (req.user.role !== 'admin' && srv.user_id !== req.user.id) {
    // Check if subuser
    const sub = db.prepare('SELECT id FROM server_subusers WHERE server_id=? AND user_id=?')
      .get(req.params.serverId, req.user.id);
    if (!sub) return res.status(403).json({ error: 'Kein Zugriff' });
  }
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const logs = db.prepare(`
    SELECT a.*, u.username FROM audit_log a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.target_type IN ('server','file','mod','port','task','subuser')
      AND a.target_id = ?
    ORDER BY a.created_at DESC LIMIT ?
  `).all(req.params.serverId, limit);
  res.json(logs);
});

// ─── ADMIN: BENUTZER ─────────────────────────────────────────────────────────
router.get('/users', authenticate, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id,username,email,role,is_suspended,suspend_reason,created_at FROM users ORDER BY created_at DESC').all();
  const counts = db.prepare('SELECT user_id, COUNT(*) as c FROM servers GROUP BY user_id').all();
  const cm = Object.fromEntries(counts.map(r => [r.user_id, r.c]));
  res.json(users.map(u => ({ ...u, server_count: cm[u.id] || 0 })));
});

router.post('/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const { username, email, password, role = 'user' } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Alle Felder erforderlich' });
    if (db.prepare('SELECT id FROM users WHERE email=? OR username=?').get(email, username))
      return res.status(409).json({ error: 'Benutzer existiert bereits' });
    const id   = uuidv4();
    const hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO users (id,username,email,password_hash,role) VALUES (?,?,?,?,?)')
      .run(id, username.trim(), email.toLowerCase().trim(), hash, role);
    auditLog(req.user.id, 'USER_CREATE', 'user', id, { username, role }, req.ip);
    res.status(201).json({ id, username, email, role, is_suspended: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/users/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { username, email, role, is_suspended, suspend_reason, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    const upd = {};
    if (username) upd.username = username;
    if (email) upd.email = email.toLowerCase();
    if (role) upd.role = role;
    if (is_suspended !== undefined) upd.is_suspended = is_suspended ? 1 : 0;
    if (suspend_reason !== undefined) upd.suspend_reason = suspend_reason || '';
    if (password) upd.password_hash = await bcrypt.hash(password, 12);
    upd.updated_at = new Date().toISOString();
    const set = Object.keys(upd).map(k => `${k}=?`).join(',');
    db.prepare(`UPDATE users SET ${set} WHERE id=?`).run(...Object.values(upd), req.params.id);
    // Alle Sessions des gesperrten Users beenden
    if (is_suspended) db.prepare("DELETE FROM user_sessions WHERE user_id=?").run(req.params.id);
    auditLog(req.user.id, 'USER_UPDATE', 'user', req.params.id, { ...upd, password_hash: undefined }, req.ip);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/users/:id', authenticate, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Du kannst dich nicht selbst löschen' });
  const r = db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  auditLog(req.user.id, 'USER_DELETE', 'user', req.params.id, {}, req.ip);
  res.json({ success: true });
});

// ─── DOCKER IMAGES (v1 Legacy + Routing auf lokalen Node) ────────────────────
router.get('/docker/images', authenticate, requireAdmin, async (req, res) => {
  try {
    // Versuche lokalen Node oder ersten verfügbaren
    const localNode = db.prepare('SELECT id FROM nodes WHERE is_local=1').get()
      || db.prepare('SELECT id FROM nodes ORDER BY is_default DESC').get();
    if (!localNode) return res.json([]);

    const result = await routeToNode(localNode.id, { type: 'docker.images' }, 10_000);
    // v1 Format zurückgeben
    const images = result.images || [];
    res.json(images.map(img => ({
      Id:       'sha256:' + (img.id || 'unknown'),
      RepoTags: img.tags || ['<none>'],
      Size:     img.size || 0,
    })));
  } catch (e) { res.status(503).json({ error: e.message }); }
});

router.post('/docker/images/pull', authenticate, requireAdmin, async (req, res) => {
  try {
    const { image, node_id } = req.body;
    if (!image) return res.status(400).json({ error: 'Image-Name erforderlich' });
    const targetNodeId = node_id || db.prepare('SELECT id FROM nodes WHERE is_local=1').get()?.id
      || db.prepare('SELECT id FROM nodes ORDER BY is_default DESC').get()?.id;
    if (!targetNodeId) return res.status(400).json({ error: 'Kein Node verfügbar' });
    const result = await routeToNode(targetNodeId, { type: 'docker.pull', image }, 120_000);
    auditLog(req.user.id, 'IMAGE_PULL', 'node', targetNodeId, { image }, req.ip);
    res.json(result);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// ─── API KEYS ─────────────────────────────────────────────────────────────────
router.get('/api-keys', authenticate, (req, res) => {
  res.json(db.prepare('SELECT id,name,key_prefix,permissions,last_used_at,created_at FROM api_keys WHERE user_id=?').all(req.user.id));
});

router.post('/api-keys', authenticate, async (req, res) => {
  try {
    const { name, permissions = ['servers:read'] } = req.body;
    if (!name) return res.status(400).json({ error: 'Name erforderlich' });

    // Unterstütze beide Prefixes (hp_ v1, hpk_ v2)
    const key    = 'hpk_' + crypto.randomBytes(32).toString('hex');
    const hash   = await bcrypt.hash(key, 10);
    const prefix = key.substring(0, 12);
    const id     = uuidv4();

    db.prepare('INSERT INTO api_keys (id,user_id,name,key_hash,key_prefix,permissions) VALUES (?,?,?,?,?,?)')
      .run(id, req.user.id, name, hash, prefix, JSON.stringify(permissions));

    res.status(201).json({ id, name, key, key_prefix: prefix, permissions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api-keys/:id', authenticate, (req, res) => {
  const r = db.prepare('DELETE FROM api_keys WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  if (r.changes === 0) return res.status(404).json({ error: 'API-Key nicht gefunden' });
  res.json({ success: true });
});

module.exports = router;
