'use strict';
/**
 * routes/groups.js — Server-Gruppen & Tags
 *
 * GET    /api/groups              — Eigene Gruppen
 * POST   /api/groups              — Gruppe erstellen
 * PATCH  /api/groups/:id          — Gruppe umbenennen/umfärben
 * DELETE /api/groups/:id          — Gruppe löschen
 * POST   /api/groups/:id/servers  — Server zur Gruppe hinzufügen
 * DELETE /api/groups/:id/servers/:serverId — Server aus Gruppe entfernen
 *
 * Tags: gespeichert als JSON-Array in servers.tags
 * PATCH /api/servers/:id/tags     — Tags eines Servers setzen
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../db');
const { authenticate } = require('./auth');

const router = express.Router();

const COLORS = ['#64748b','#00d4ff','#00f5a0','#f59e0b','#ff4757','#a78bfa','#f472b6','#34d399'];

// ─── GRUPPEN LESEN ────────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const groups  = isAdmin
    ? db.prepare(`SELECT g.*, u.username as owner FROM server_groups g JOIN users u ON g.user_id=u.id ORDER BY g.name`).all()
    : db.prepare(`SELECT * FROM server_groups WHERE user_id=? ORDER BY name`).all(req.user.id);

  const withMembers = groups.map(g => {
    const members = db.prepare(`
      SELECT s.id, s.name, s.status, s.image FROM server_group_members m
      JOIN servers s ON m.server_id = s.id WHERE m.group_id=?
    `).all(g.id);
    return { ...g, servers: members };
  });
  res.json(withMembers);
});

// ─── GRUPPE ERSTELLEN ─────────────────────────────────────────────────────────
router.post('/', authenticate, (req, res) => {
  const { name, color = '#64748b', icon = '📁' } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
  if (!COLORS.includes(color) && !/^#[0-9a-fA-F]{6}$/.test(color))
    return res.status(400).json({ error: 'Ungültige Farbe' });

  const id = uuidv4();
  db.prepare("INSERT INTO server_groups (id,name,color,icon,user_id) VALUES (?,?,?,?,?)")
    .run(id, name.trim(), color, icon, req.user.id);
  res.status(201).json({ id, name: name.trim(), color, icon, servers: [] });
});

// ─── GRUPPE BEARBEITEN ────────────────────────────────────────────────────────
router.patch('/:id', authenticate, (req, res) => {
  const g = db.prepare('SELECT * FROM server_groups WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
  if (g.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Kein Zugriff' });

  const name  = req.body.name?.trim()  ?? g.name;
  const color = req.body.color ?? g.color;
  const icon  = req.body.icon  ?? g.icon;
  db.prepare("UPDATE server_groups SET name=?,color=?,icon=? WHERE id=?").run(name, color, icon, g.id);
  res.json({ success: true });
});

// ─── GRUPPE LÖSCHEN ───────────────────────────────────────────────────────────
router.delete('/:id', authenticate, (req, res) => {
  const g = db.prepare('SELECT * FROM server_groups WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
  if (g.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Kein Zugriff' });
  db.prepare('DELETE FROM server_groups WHERE id=?').run(g.id);
  res.json({ success: true });
});

// ─── SERVER HINZUFÜGEN ────────────────────────────────────────────────────────
router.post('/:id/servers', authenticate, (req, res) => {
  const g = db.prepare('SELECT * FROM server_groups WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
  if (g.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Kein Zugriff' });

  const { server_ids = [] } = req.body;
  const ids = Array.isArray(server_ids) ? server_ids : [server_ids];
  for (const sid of ids) {
    const srv = db.prepare('SELECT id FROM servers WHERE id=?').get(sid);
    if (!srv) continue;
    db.prepare("INSERT OR IGNORE INTO server_group_members (group_id,server_id) VALUES (?,?)").run(g.id, sid);
  }
  res.json({ success: true });
});

// ─── SERVER ENTFERNEN ─────────────────────────────────────────────────────────
router.delete('/:id/servers/:serverId', authenticate, (req, res) => {
  const g = db.prepare('SELECT * FROM server_groups WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
  if (g.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Kein Zugriff' });
  db.prepare('DELETE FROM server_group_members WHERE group_id=? AND server_id=?').run(g.id, req.params.serverId);
  res.json({ success: true });
});

// ─── TAGS EINES SERVERS SETZEN ────────────────────────────────────────────────
router.patch('/servers/:serverId/tags', authenticate, (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (srv.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Kein Zugriff' });

  const tags = (req.body.tags || []).slice(0, 10).map(t => String(t).trim().substring(0, 32));
  db.prepare("UPDATE servers SET tags=? WHERE id=?").run(JSON.stringify(tags), srv.id);
  res.json({ success: true, tags });
});

module.exports = router;
