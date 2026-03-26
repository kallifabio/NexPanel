'use strict';
/**
 * routes/allocations.js — Port-Allocations-Verwaltung
 * Admins verwalten Ports pro Node; Server bekommen Allocations zugewiesen
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../src/core/db');
const { authenticate, requireAdmin } = require('./auth');

const router = express.Router();

// ─── ALLE ALLOCATIONS (Admin: alle, User: eigene Server) ──────────────────────
router.get('/', authenticate, (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = db.prepare(`
      SELECT a.*, n.name as node_name, s.name as server_name
      FROM port_allocations a
      JOIN nodes n ON a.node_id=n.id
      LEFT JOIN servers s ON a.server_id=s.id
      ORDER BY n.name ASC, a.port ASC
    `).all();
  } else {
    // User sieht nur Allocations seiner Server
    rows = db.prepare(`
      SELECT a.*, n.name as node_name, s.name as server_name
      FROM port_allocations a
      JOIN nodes n ON a.node_id=n.id
      LEFT JOIN servers s ON a.server_id=s.id
      WHERE s.user_id=?
      ORDER BY a.port ASC
    `).all(req.user.id);
  }
  res.json(rows);
});

// ─── ALLOCATIONS FÜR EINEN NODE ───────────────────────────────────────────────
router.get('/node/:nodeId', authenticate, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, s.name as server_name
    FROM port_allocations a
    LEFT JOIN servers s ON a.server_id=s.id
    WHERE a.node_id=?
    ORDER BY a.port ASC
  `).all(req.params.nodeId);
  res.json(rows);
});

// ─── FREIE ALLOCATIONS FÜR EINEN NODE ────────────────────────────────────────
router.get('/node/:nodeId/free', authenticate, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM port_allocations WHERE node_id=? AND server_id IS NULL ORDER BY port ASC'
  ).all(req.params.nodeId);
  res.json(rows);
});

// ─── ALLOCATION ERSTELLEN ─────────────────────────────────────────────────────
router.post('/', authenticate, requireAdmin, (req, res) => {
  try {
    const { node_id, ip = '0.0.0.0', port, alias = '' } = req.body;
    if (!node_id || !port) return res.status(400).json({ error: 'node_id und port erforderlich' });

    const node = db.prepare('SELECT id FROM nodes WHERE id=?').get(node_id);
    if (!node) return res.status(404).json({ error: 'Node nicht gefunden' });

    const existing = db.prepare('SELECT id FROM port_allocations WHERE node_id=? AND ip=? AND port=?')
      .get(node_id, ip, port);
    if (existing) return res.status(409).json({ error: `Port ${port} auf ${ip} ist bereits reserviert` });

    const id = uuidv4();
    db.prepare('INSERT INTO port_allocations (id,node_id,ip,port,alias) VALUES (?,?,?,?,?)')
      .run(id, node_id, ip, parseInt(port), alias);
    res.status(201).json({ id, node_id, ip, port: parseInt(port), alias, server_id: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BULK ALLOCATIONS ERSTELLEN (Portbereich) ────────────────────────────────
router.post('/bulk', authenticate, requireAdmin, (req, res) => {
  try {
    const { node_id, ip = '0.0.0.0', start_port, end_port } = req.body;
    if (!node_id || !start_port || !end_port)
      return res.status(400).json({ error: 'node_id, start_port und end_port erforderlich' });
    if (end_port - start_port > 1000)
      return res.status(400).json({ error: 'Maximal 1000 Ports auf einmal' });

    const stmt = db.prepare('INSERT OR IGNORE INTO port_allocations (id,node_id,ip,port) VALUES (?,?,?,?)');
    let created = 0;
    const insertMany = db.transaction(() => {
      for (let p = parseInt(start_port); p <= parseInt(end_port); p++) {
        const r = stmt.run(uuidv4(), node_id, ip, p);
        created += r.changes;
      }
    });
    insertMany();
    res.json({ success: true, created, skipped: (end_port - start_port + 1) - created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ALLOCATION LÖSCHEN ───────────────────────────────────────────────────────
router.delete('/:id', authenticate, requireAdmin, (req, res) => {
  const alloc = db.prepare('SELECT * FROM port_allocations WHERE id=?').get(req.params.id);
  if (!alloc) return res.status(404).json({ error: 'Allocation nicht gefunden' });
  if (alloc.server_id) return res.status(409).json({ error: 'Port ist einem Server zugewiesen. Erst Server entfernen.' });
  db.prepare('DELETE FROM port_allocations WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── ALLOCATION EINEM SERVER ZUWEISEN ────────────────────────────────────────
router.post('/:id/assign', authenticate, requireAdmin, (req, res) => {
  const { server_id } = req.body;
  const alloc = db.prepare('SELECT * FROM port_allocations WHERE id=?').get(req.params.id);
  if (!alloc) return res.status(404).json({ error: 'Allocation nicht gefunden' });
  if (alloc.server_id && alloc.server_id !== server_id)
    return res.status(409).json({ error: 'Port ist bereits einem anderen Server zugewiesen' });
  db.prepare('UPDATE port_allocations SET server_id=? WHERE id=?').run(server_id || null, req.params.id);
  res.json({ success: true });
});

module.exports = router;
// ─── SERVER-PORTS VERWALTEN ──────────────────────────────────────────────────
// GET  /api/servers/:id/ports  → alle Ports dieses Servers
// POST /api/servers/:id/ports  → freie Allocation zuweisen (body: { alloc_id })
// DELETE /api/servers/:id/ports/:allocId → Port entfernen
// PUT /api/servers/:id/ports/:allocId/primary → als primär setzen
// PUT /api/servers/:id/ports/:allocId/notes → Notiz aktualisieren

const serverPorts = express.Router({ mergeParams: true });
const dockerLocal = require('../src/docker/docker-local');
const { routeToNode } = require('../src/docker/node-router');

// Helper: Container-Ports nach Zuweisung synchronisieren
async function syncContainerPorts(srv) {
  if (!srv || !srv.container_id) return;
  const allPorts = db.prepare(
    'SELECT port FROM port_allocations WHERE server_id=? ORDER BY is_primary DESC, port ASC'
  ).all(srv.id);
  const portList = allPorts.map(p => ({ host: p.port, container: p.port }));
  if (!portList.length) return;
  try {
    if (srv.node_id) {
      // Remote daemon
      await routeToNode(srv.node_id, {
        type: 'server.update_ports', server_id: srv.id,
        container_id: srv.container_id, ports: portList,
      }, 30_000).catch(() => {});
    } else {
      // Lokales Docker
      const result = await dockerLocal.updateContainerPorts(srv.container_id, portList);
      if (result.container_id && result.container_id !== srv.container_id) {
        db.prepare("UPDATE servers SET container_id=? WHERE id=?").run(result.container_id, srv.id);
      }
    }
  } catch (e) {
    console.warn('Port-Sync fehlgeschlagen (nicht kritisch):', e.message);
  }
}

function canAccessServer(req, res, next) {
  const { db: _db, authenticate: _auth } = req._deps || {};
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (req.user.role !== 'admin' && srv.user_id !== req.user.id)
    return res.status(403).json({ error: 'Kein Zugriff' });
  req.srv = srv;
  next();
}

serverPorts.get('/', authenticate, canAccessServer, (req, res) => {
  const ports = db.prepare(
    'SELECT * FROM port_allocations WHERE server_id=? ORDER BY is_primary DESC, port ASC'
  ).all(req.params.serverId);
  res.json(ports);
});

serverPorts.post('/', authenticate, canAccessServer, (req, res) => {
  try {
    const { alloc_id } = req.body;
    if (!alloc_id) return res.status(400).json({ error: 'alloc_id erforderlich' });
    const alloc = db.prepare('SELECT * FROM port_allocations WHERE id=?').get(alloc_id);
    if (!alloc) return res.status(404).json({ error: 'Allocation nicht gefunden' });
    if (alloc.server_id && alloc.server_id !== req.params.serverId)
      return res.status(409).json({ error: 'Port ist bereits einem anderen Server zugewiesen' });
    // Erster Port → automatisch primär
    const existing = db.prepare('SELECT COUNT(*) as c FROM port_allocations WHERE server_id=?').get(req.params.serverId);
    const isPrimary = existing.c === 0 ? 1 : 0;
    db.prepare('UPDATE port_allocations SET server_id=?, is_primary=? WHERE id=?')
      .run(req.params.serverId, isPrimary, alloc_id);
    auditLog(req.user.id, 'PORT_ASSIGN', 'server', req.params.serverId, { alloc_id }, req.ip);
    // Container-Ports synchronisieren (async, non-blocking)
    syncContainerPorts(req.srv).catch(() => {});
    res.json({ success: true, is_primary: isPrimary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

serverPorts.delete('/:allocId', authenticate, canAccessServer, (req, res) => {
  const alloc = db.prepare('SELECT * FROM port_allocations WHERE id=? AND server_id=?')
    .get(req.params.allocId, req.params.serverId);
  if (!alloc) return res.status(404).json({ error: 'Port nicht gefunden' });
  if (alloc.is_primary) return res.status(409).json({ error: 'Primär-Port kann nicht entfernt werden. Erst anderen Port als primär setzen.' });
  db.prepare("UPDATE port_allocations SET server_id=NULL, is_primary=0, notes='' WHERE id=?").run(req.params.allocId);
  auditLog(req.user.id, 'PORT_REMOVE', 'server', req.params.serverId, { alloc_id: req.params.allocId }, req.ip);
  syncContainerPorts(req.srv).catch(() => {});
  res.json({ success: true });
});

serverPorts.put('/:allocId/primary', authenticate, canAccessServer, (req, res) => {
  const alloc = db.prepare('SELECT * FROM port_allocations WHERE id=? AND server_id=?')
    .get(req.params.allocId, req.params.serverId);
  if (!alloc) return res.status(404).json({ error: 'Port nicht gefunden' });
  // Alle auf sekundär, dann diesen auf primär
  db.transaction(() => {
    db.prepare('UPDATE port_allocations SET is_primary=0 WHERE server_id=?').run(req.params.serverId);
    db.prepare('UPDATE port_allocations SET is_primary=1 WHERE id=?').run(req.params.allocId);
  })();
  auditLog(req.user.id, 'PORT_SET_PRIMARY', 'server', req.params.serverId, { alloc_id: req.params.allocId }, req.ip);
  res.json({ success: true });
});

serverPorts.put('/:allocId/notes', authenticate, canAccessServer, (req, res) => {
  const { notes = '' } = req.body;
  const alloc = db.prepare('SELECT id FROM port_allocations WHERE id=? AND server_id=?')
    .get(req.params.allocId, req.params.serverId);
  if (!alloc) return res.status(404).json({ error: 'Port nicht gefunden' });
  db.prepare('UPDATE port_allocations SET notes=? WHERE id=?').run(notes, req.params.allocId);
  res.json({ success: true });
});

module.exports.serverPorts = serverPorts;

