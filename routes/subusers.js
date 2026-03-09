'use strict';
/**
 * routes/subusers.js — Sub-User Verwaltung pro Server
 * Erlaubt dem Server-Besitzer anderen Nutzern begrenzten Zugriff zu geben.
 * Berechtigungen: console | files | startup | database | allocations | backups
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../db');
const { authenticate } = require('./auth');

const router = express.Router({ mergeParams: true });

const ALL_PERMS = ['console', 'files', 'startup', 'allocations', 'schedule', 'backups'];

function canManage(req, res, next) {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (req.user.role !== 'admin' && srv.user_id !== req.user.id)
    return res.status(403).json({ error: 'Nur der Server-Besitzer kann Sub-User verwalten' });
  req.srv = srv;
  next();
}

// ─── SUB-USER AUFLISTEN ───────────────────────────────────────────────────────
router.get('/', authenticate, canManage, (req, res) => {
  const rows = db.prepare(`
    SELECT su.*, u.username, u.email
    FROM server_subusers su
    JOIN users u ON su.user_id = u.id
    WHERE su.server_id = ?
    ORDER BY su.created_at ASC
  `).all(req.params.serverId);
  res.json(rows.map(r => ({ ...r, permissions: JSON.parse(r.permissions || '[]') })));
});

// ─── SUB-USER EINLADEN ────────────────────────────────────────────────────────
router.post('/', authenticate, canManage, (req, res) => {
  try {
    const { email, permissions = ['console'] } = req.body;
    if (!email) return res.status(400).json({ error: 'E-Mail erforderlich' });

    const invalid = permissions.filter(p => !ALL_PERMS.includes(p));
    if (invalid.length) return res.status(400).json({ error: `Ungültige Berechtigungen: ${invalid.join(', ')}` });

    const target = db.prepare('SELECT id, username FROM users WHERE email=?').get(email);
    if (!target) return res.status(404).json({ error: `Kein Nutzer mit E-Mail "${email}" gefunden` });
    if (target.id === req.srv.user_id) return res.status(409).json({ error: 'Server-Besitzer kann kein Sub-User sein' });

    const existing = db.prepare('SELECT id FROM server_subusers WHERE server_id=? AND user_id=?')
      .get(req.params.serverId, target.id);
    if (existing) return res.status(409).json({ error: `${target.username} hat bereits Zugriff` });

    const id = uuidv4();
    db.prepare('INSERT INTO server_subusers (id, server_id, user_id, permissions) VALUES (?,?,?,?)')
      .run(id, req.params.serverId, target.id, JSON.stringify(permissions));

    auditLog(req.user.id, 'SUBUSER_ADD', 'server', req.params.serverId,
      { target_user: target.username, permissions }, req.ip);

    res.status(201).json({
      id, server_id: req.params.serverId,
      user_id: target.id, username: target.username, email,
      permissions,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BERECHTIGUNGEN AKTUALISIEREN ─────────────────────────────────────────────
router.patch('/:subId', authenticate, canManage, (req, res) => {
  const sub = db.prepare('SELECT * FROM server_subusers WHERE id=? AND server_id=?')
    .get(req.params.subId, req.params.serverId);
  if (!sub) return res.status(404).json({ error: 'Sub-User nicht gefunden' });

  const { permissions } = req.body;
  if (!Array.isArray(permissions)) return res.status(400).json({ error: 'permissions muss ein Array sein' });
  const invalid = permissions.filter(p => !ALL_PERMS.includes(p));
  if (invalid.length) return res.status(400).json({ error: `Ungültige Berechtigungen: ${invalid.join(', ')}` });

  db.prepare('UPDATE server_subusers SET permissions=? WHERE id=?')
    .run(JSON.stringify(permissions), sub.id);

  auditLog(req.user.id, 'SUBUSER_UPDATE', 'server', req.params.serverId,
    { sub_id: sub.id, permissions }, req.ip);

  res.json({ success: true, permissions });
});

// ─── SUB-USER ENTFERNEN ───────────────────────────────────────────────────────
router.delete('/:subId', authenticate, canManage, (req, res) => {
  const sub = db.prepare('SELECT su.*, u.username FROM server_subusers su JOIN users u ON su.user_id=u.id WHERE su.id=? AND su.server_id=?')
    .get(req.params.subId, req.params.serverId);
  if (!sub) return res.status(404).json({ error: 'Sub-User nicht gefunden' });

  db.prepare('DELETE FROM server_subusers WHERE id=?').run(sub.id);
  auditLog(req.user.id, 'SUBUSER_REMOVE', 'server', req.params.serverId,
    { username: sub.username }, req.ip);

  res.json({ success: true });
});

// ─── VERFÜGBARE BERECHTIGUNGEN ───────────────────────────────────────────────
router.get('/permissions', authenticate, canManage, (req, res) => {
  res.json(ALL_PERMS.map(p => ({
    key: p,
    label: { console:'Konsole', files:'Datei-Manager', startup:'Startup/ENV', allocations:'Ports', schedule:'Geplante Tasks', backups:'Backups' }[p] || p,
    description: {
      console:     'Konsole lesen und Befehle senden',
      files:       'Dateien lesen, bearbeiten und hochladen',
      startup:     'Startup-Befehl und Umgebungsvariablen ändern',
      allocations: 'Ports verwalten',
      schedule:    'Geplante Tasks erstellen und ausführen',
      backups:     'Backups erstellen und wiederherstellen',
    }[p] || '',
  })));
});

module.exports = router;
