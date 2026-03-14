/**
 * routes/nodes.js — Node-Verwaltung (v2 Multi-Node)
 * Erstellen, Bearbeiten, Token-Rotation, Docker-Images pro Node
 */

'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog }   = require('../src/core/db');
const { authenticate, requireAdmin } = require('./auth');
const { isConnected }    = require('../src/docker/daemon-hub');
const { routeToNode }    = require('../src/docker/node-router');

const router = express.Router();

function generateToken() {
  return 'hpd_' + crypto.randomBytes(32).toString('hex');
}

// ─── LISTE ────────────────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY created_at ASC').all();
  res.json(nodes.map(n => ({
    ...n,
    system_info:  n.system_info ? JSON.parse(n.system_info) : null,
    connected:    isConnected(n.id) || n.is_local,
    server_count: db.prepare('SELECT COUNT(*) as c FROM servers WHERE node_id=?').get(n.id).c,
  })));
});

// ─── NODE ERSTELLEN ───────────────────────────────────────────────────────────
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, fqdn, location = 'Default', memory_mb = 4096, disk_mb = 51200, cpu_overalloc = 0 } = req.body;
    if (!name || !fqdn) return res.status(400).json({ error: 'Name und FQDN sind erforderlich' });

    const id      = uuidv4();
    const token   = generateToken();
    const hash    = await bcrypt.hash(token, 10);
    const prefix  = token.substring(0, 12);
    const isDefault = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c === 0 ? 1 : 0;

    db.prepare(`
      INSERT INTO nodes (id,name,fqdn,location,token_hash,token_prefix,is_default,is_local,memory_mb,disk_mb,cpu_overalloc,status)
      VALUES (?,?,?,?,?,?,?,0,?,?,?,'offline')
    `).run(id, name, fqdn, location, hash, prefix, isDefault, memory_mb, disk_mb, cpu_overalloc);

    auditLog(req.user.id, 'NODE_CREATE', 'node', id, { name, fqdn }, req.ip);

    res.status(201).json({
      id, name, fqdn, location, is_default: isDefault,
      token,          // Einmalig! Wird nicht in Klartext gespeichert
      token_prefix: prefix,
      setup: {
        env: { NODE_ID: id, NODE_TOKEN: token, PANEL_URL: `ws://YOUR_PANEL_IP:3000` },
        command: `cd daemon && npm install && NODE_ID="${id}" NODE_TOKEN="${token}" PANEL_URL="ws://YOUR_PANEL_IP:3000" node daemon.js`,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NODE BEARBEITEN ──────────────────────────────────────────────────────────
router.patch('/:id', authenticate, requireAdmin, (req, res) => {
  try {
    const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(req.params.id);
    if (!node) return res.status(404).json({ error: 'Node nicht gefunden' });

    const { name, location, memory_mb, disk_mb, cpu_overalloc, is_default } = req.body;
    const upd = {};
    if (name !== undefined) upd.name = name;
    if (location !== undefined) upd.location = location;
    if (memory_mb !== undefined) upd.memory_mb = memory_mb;
    if (disk_mb !== undefined) upd.disk_mb = disk_mb;
    if (cpu_overalloc !== undefined) upd.cpu_overalloc = cpu_overalloc;
    if (is_default) { db.prepare('UPDATE nodes SET is_default=0').run(); upd.is_default = 1; }

    if (Object.keys(upd).length) {
      const set = Object.keys(upd).map(k => `${k}=?`).join(',');
      db.prepare(`UPDATE nodes SET ${set} WHERE id=?`).run(...Object.values(upd), node.id);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NODE LÖSCHEN ─────────────────────────────────────────────────────────────
router.delete('/:id', authenticate, requireAdmin, (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node nicht gefunden' });
  if (node.is_local) return res.status(400).json({ error: 'Der lokale Node kann nicht gelöscht werden' });

  const count = db.prepare('SELECT COUNT(*) as c FROM servers WHERE node_id=?').get(req.params.id).c;
  if (count > 0) return res.status(409).json({ error: `Node hat noch ${count} Server. Erst alle Server dieses Nodes löschen.` });

  const { daemonSend } = require('../src/docker/daemon-hub');
  daemonSend(req.params.id, { type: 'shutdown' });

  db.prepare('DELETE FROM nodes WHERE id=?').run(req.params.id);
  auditLog(req.user.id, 'NODE_DELETE', 'node', req.params.id, { name: node.name }, req.ip);
  res.json({ success: true });
});

// ─── TOKEN ROTIEREN ───────────────────────────────────────────────────────────
router.post('/:id/rotate-token', authenticate, requireAdmin, async (req, res) => {
  try {
    const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(req.params.id);
    if (!node) return res.status(404).json({ error: 'Node nicht gefunden' });
    if (node.is_local) return res.status(400).json({ error: 'Lokaler Node benötigt kein Token' });

    const token  = generateToken();
    const hash   = await bcrypt.hash(token, 10);
    const prefix = token.substring(0, 12);

    db.prepare('UPDATE nodes SET token_hash=?,token_prefix=? WHERE id=?').run(hash, prefix, node.id);
    // Bestehende Daemon-Verbindung trennen (muss neu verbinden)
    const conn = require('../src/docker/daemon-hub').connections.get(node.id);
    if (conn) { try { conn.ws.close(); } catch {} }

    res.json({
      token, token_prefix: prefix,
      setup: { NODE_ID: node.id, NODE_TOKEN: token }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NODE SYSTEM-INFO ─────────────────────────────────────────────────────────
router.get('/:id/info', authenticate, requireAdmin, async (req, res) => {
  try {
    const data = await routeToNode(req.params.id, { type: 'node.info' }, 8000);
    res.json(data);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// ─── DOCKER IMAGES AUF NODE ───────────────────────────────────────────────────
router.get('/:id/images', authenticate, requireAdmin, async (req, res) => {
  try {
    const data = await routeToNode(req.params.id, { type: 'docker.images' }, 10_000);
    res.json(data.images || []);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

router.post('/:id/images/pull', authenticate, requireAdmin, async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'Image-Name erforderlich' });
    const data = await routeToNode(req.params.id, { type: 'docker.pull', image }, 120_000);
    auditLog(req.user.id, 'IMAGE_PULL', 'node', req.params.id, { image }, req.ip);
    res.json(data);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// ─── LEGACY: /api/docker/images (v1-Kompatibilität) ──────────────────────────
// Diese werden in server.js als /api/docker/* eingehängt

module.exports = router;
