/**
 * routes/servers.js — Server-Verwaltung
 * Kombiniert v1 (lokales Docker) + v2 (Daemon-Node-Routing).
 * Power-Aktionen, Logs und Commands werden per node-router.js
 * automatisch an den richtigen Node geleitet.
 */

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../src/core/db');
const { routeToNode }  = require('../src/docker/node-router');
const { authenticate, requireAdmin, canAccessServer } = require('./auth');

const router = express.Router();

// ─── SERVER LISTE ─────────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const sql = isAdmin
    ? `SELECT s.*, u.username as owner_name, n.name as node_name, n.fqdn as node_fqdn,
              n.is_local as node_is_local, n.status as node_status
       FROM servers s
       JOIN users u ON s.user_id=u.id
       LEFT JOIN nodes n ON s.node_id=n.id
       ORDER BY s.created_at DESC`
    : `SELECT s.*, u.username as owner_name, n.name as node_name, n.fqdn as node_fqdn,
              n.is_local as node_is_local, n.status as node_status
       FROM servers s
       JOIN users u ON s.user_id=u.id
       LEFT JOIN nodes n ON s.node_id=n.id
       WHERE s.user_id=?
       ORDER BY s.created_at DESC`;

  const rows = isAdmin ? db.prepare(sql).all() : db.prepare(sql).all(req.user.id);
  res.json(rows.map(s => ({ ...s, ports: JSON.parse(s.ports), env_vars: JSON.parse(s.env_vars) })));
});

router.get('/:id', authenticate, canAccessServer, (req, res) => {
  const { targetServer: s } = req;
  const node = s.node_id ? db.prepare('SELECT id,name,fqdn,location,status,is_local FROM nodes WHERE id=?').get(s.node_id) : null;
  const { authenticate: _a, requireAdmin: _ra, canAccessServer: _c, ...daemonHub } = require('../src/docker/daemon-hub');
  const node_connected = node ? (require('../src/docker/daemon-hub').isConnected(node.id) || node.is_local) : false;
  res.json({ ...s, node, node_connected });
});

// ─── SERVER ERSTELLEN ─────────────────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      name, description = '', image, node_id,
      cpu_limit = 1, cpu_percent = 100, memory_limit = 512, swap_limit = 0, disk_limit = 5120,
      ports = [], env_vars = {}, startup_command = '', work_dir = '/home/container',
      network = 'bridge', user_id,
    } = req.body;

    if (!name || !image) return res.status(400).json({ error: 'Name und Image sind erforderlich' });

    // Node bestimmen — Auto-Scaling oder Standard-Node
    let targetNodeId = node_id;
    let scalingReason = null;
    if (!targetNodeId) {
      try {
        const { getBestNode } = require('../src/core/scaling');
        const best = getBestNode({ mem_mb: memory_limit, disk_mb: disk_limit, cpu_cores: cpu_limit });
        if (best) {
          targetNodeId  = best.node_id;
          scalingReason = best.reason;
        }
      } catch (scalingErr) {
        console.warn('[scaling] getBestNode Fehler:', scalingErr.message);
      }

      if (!targetNodeId) {
        // Fallback: Standard-Node
        const defaultNode = db.prepare('SELECT id FROM nodes WHERE is_default=1').get()
          || db.prepare('SELECT id FROM nodes ORDER BY created_at ASC').get();
        if (!defaultNode) return res.status(400).json({ error: 'Kein Node verfügbar. Bitte zuerst einen Node einrichten.' });
        targetNodeId  = defaultNode.id;
        scalingReason = 'Standard-Node (Fallback)';
      }
    }

    const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(targetNodeId);
    if (!node) return res.status(404).json({ error: 'Node nicht gefunden' });

    const targetUserId = (req.user.role === 'admin' && user_id) ? user_id : req.user.id;

    // Quota-Check (nur für reguläre User, nicht für Admins die fremde Server erstellen)
    if (req.user.role !== 'admin') {
      try {
        const { checkQuota } = require('./quotas');
        const errors = checkQuota(targetUserId, { memory_limit, cpu_limit, disk_limit });
        if (errors.length) return res.status(403).json({ error: errors[0], quota_exceeded: true, details: errors });
      } catch (_) { /* quotas optional */ }
    }
    const id = uuidv4();

    db.prepare(`
      INSERT INTO servers (id,name,description,user_id,node_id,node,image,cpu_limit,cpu_percent,memory_limit,
        swap_limit,disk_limit,ports,env_vars,startup_command,work_dir,network,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'installing')
    `).run(id, name, description, targetUserId, targetNodeId, node.name,
           image, cpu_limit, cpu_percent, memory_limit, swap_limit, disk_limit,
           JSON.stringify(ports), JSON.stringify(env_vars),
           startup_command, work_dir, network);

    // Ports automatisch in port_allocations registrieren
    if (Array.isArray(ports) && ports.length > 0) {
      const nodeForPorts = db.prepare('SELECT * FROM nodes WHERE id=?').get(targetNodeId);
      const nodeIp = nodeForPorts?.fqdn || '0.0.0.0';
      const insertAlloc = db.prepare(
        "INSERT OR IGNORE INTO port_allocations (id, node_id, ip, port, server_id, is_primary, notes) VALUES (?,?,?,?,?,?,'')"
      );
      db.transaction(() => {
        ports.forEach((p, idx) => {
          const hostPort = p.host || p;
          // Prüfen ob schon eine Allocation für diesen Port+Node existiert
          const existing = db.prepare(
            'SELECT id FROM port_allocations WHERE node_id=? AND port=?'
          ).get(targetNodeId, hostPort);
          if (existing) {
            // Vorhandene Allocation diesem Server zuweisen
            db.prepare('UPDATE port_allocations SET server_id=?, is_primary=? WHERE id=?')
              .run(id, idx === 0 ? 1 : 0, existing.id);
          } else {
            // Neue Allocation anlegen und direkt zuweisen
            insertAlloc.run(uuidv4(), targetNodeId, '0.0.0.0', hostPort, id, idx === 0 ? 1 : 0);
          }
        });
      })();
    }

    // Async: Container erstellen
    (async () => {
      try {
        const result = await routeToNode(targetNodeId, {
          type: 'server.create', server_id: id,
          config: { image, cpu_limit, cpu_percent, memory_limit, swap_limit, disk_limit, ports, env_vars, startup_command, work_dir, network }
        }, 120_000);

        if (result.success && result.container_id) {
          db.prepare("UPDATE servers SET container_id=?,status='offline',updated_at=datetime('now') WHERE id=?")
            .run(result.container_id, id);
        } else {
          db.prepare("UPDATE servers SET status='error',updated_at=datetime('now') WHERE id=?").run(id);
        }
      } catch (e) {
        console.error('Container-Erstellung fehlgeschlagen:', e.message);
        db.prepare("UPDATE servers SET status='error',updated_at=datetime('now') WHERE id=?").run(id);
      }
    })();

    auditLog(req.user.id, 'SERVER_CREATE', 'server', id, { name, image, node_id: targetNodeId, scaling_reason: scalingReason }, req.ip);
    const created = db.prepare('SELECT * FROM servers WHERE id=?').get(id);
    res.status(201).json({ ...created, ports: JSON.parse(created.ports), env_vars: JSON.parse(created.env_vars) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SERVER BEARBEITEN ────────────────────────────────────────────────────────
router.patch('/:id', authenticate, canAccessServer, async (req, res) => {
  try {
    const { name, description, cpu_limit, memory_limit, ports, env_vars, startup_command, work_dir } = req.body;
    const s = req.targetServer;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (cpu_limit !== undefined) updates.cpu_limit = cpu_limit;
    if (memory_limit !== undefined) updates.memory_limit = memory_limit;
    if (ports !== undefined) updates.ports = JSON.stringify(ports);
    if (env_vars !== undefined) updates.env_vars = JSON.stringify(env_vars);
    if (startup_command !== undefined) updates.startup_command = startup_command;
    if (work_dir !== undefined) updates.work_dir = work_dir;
    updates.updated_at = new Date().toISOString();

    const set = Object.keys(updates).map(k => `${k}=?`).join(',');
    db.prepare(`UPDATE servers SET ${set} WHERE id=?`).run(...Object.values(updates), s.id);

    auditLog(req.user.id, 'SERVER_UPDATE', 'server', s.id, updates, req.ip);
    const updated = db.prepare('SELECT * FROM servers WHERE id=?').get(s.id);
    res.json({ ...updated, ports: JSON.parse(updated.ports), env_vars: JSON.parse(updated.env_vars) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SERVER LÖSCHEN ──────────────────────────────────────────────────────────
router.delete('/:id', authenticate, canAccessServer, async (req, res) => {
  try {
    const s = req.targetServer;
    if (s.container_id && s.node_id) {
      await routeToNode(s.node_id, { type: 'server.delete', server_id: s.id, container_id: s.container_id }, 20_000)
        .catch(() => {}); // ignorieren falls Node offline
    }
    db.prepare('DELETE FROM servers WHERE id=?').run(s.id);
    auditLog(req.user.id, 'SERVER_DELETE', 'server', s.id, { name: s.name }, req.ip);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POWER ACTIONS ───────────────────────────────────────────────────────────
['start', 'stop', 'restart', 'kill'].forEach(action => {
  router.post(`/:id/power/${action}`, authenticate, canAccessServer, async (req, res) => {
    try {
      const s = req.targetServer;
      if (!s.container_id) return res.status(400).json({ error: 'Kein Container vorhanden (Server noch nicht fertig installiert)' });
      if (!s.node_id) return res.status(400).json({ error: 'Server hat keinen zugewiesenen Node' });

      const pendingStatus = { start: 'starting', stop: 'stopping', restart: 'restarting', kill: 'stopping' }[action] || action;
      db.prepare("UPDATE servers SET status=?,updated_at=datetime('now') WHERE id=?").run(pendingStatus, s.id);

      const result = await routeToNode(s.node_id, {
        type: `server.${action}`, server_id: s.id, container_id: s.container_id
      });

      if (result.status) {
        db.prepare("UPDATE servers SET status=?,updated_at=datetime('now') WHERE id=?").run(result.status, s.id);
      }

      auditLog(req.user.id, `SERVER_${action.toUpperCase()}`, 'server', s.id, {}, req.ip);
      res.json({ success: true, status: result.status });
    } catch (e) {
      db.prepare("UPDATE servers SET status='error',updated_at=datetime('now') WHERE id=?").run(req.targetServer.id);
      res.status(500).json({ error: e.message });
    }
  });
});

// ─── LOGS ────────────────────────────────────────────────────────────────────
router.get('/:id/logs', authenticate, canAccessServer, async (req, res) => {
  try {
    const s = req.targetServer;
    if (!s.container_id || !s.node_id) return res.json({ logs: '' });
    const result = await routeToNode(s.node_id, {
      type: 'server.logs.tail', server_id: s.id, container_id: s.container_id,
      lines: parseInt(req.query.lines) || 200,
    });
    res.json({ logs: result.logs || '' });
  } catch (e) { res.json({ logs: `Fehler: ${e.message}` }); }
});

// ─── COMMAND ─────────────────────────────────────────────────────────────────
router.post('/:id/command', authenticate, canAccessServer, async (req, res) => {
  try {
    const s = req.targetServer;
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'Befehl erforderlich' });
    if (!s.container_id || !s.node_id) return res.json({ output: `[Kein Container] Befehl: ${command}` });
    const result = await routeToNode(s.node_id, {
      type: 'server.command', server_id: s.id, container_id: s.container_id, command
    });
    res.json({ output: result.output || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── STATS (REST Fallback) ────────────────────────────────────────────────────
router.get('/:id/stats', authenticate, canAccessServer, async (req, res) => {
  try {
    const s = req.targetServer;
    if (!s.container_id || !s.node_id || s.status !== 'running')
      return res.json({ cpu: 0, memory: 0, memory_limit: s.memory_limit * 1024 * 1024, network_rx: 0, network_tx: 0 });

    // Nur für lokalen Node
    const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(s.node_id);
    if (node?.is_local) {
      const dockerLocal = require('../src/docker/docker-local');
      const stats = await dockerLocal.getStats(s.container_id);
      return res.json(stats || { cpu: 0, memory: 0, memory_limit: s.memory_limit * 1024 * 1024, network_rx: 0, network_tx: 0 });
    }
    res.json({ cpu: 0, memory: 0, memory_limit: s.memory_limit * 1024 * 1024, network_rx: 0, network_tx: 0, note: 'Echtzeit-Stats via WebSocket' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─── SERVER KLONEN ────────────────────────────────────────────────────────────
router.post('/:id/clone', authenticate, canAccessServer, async (req, res) => {
  try {
    const src = req.targetServer;
    const { name = src.name + ' (Kopie)', node_id } = req.body;

    const targetNodeId = node_id || src.node_id;
    const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(targetNodeId);
    if (!node) return res.status(404).json({ error: 'Node nicht gefunden' });

    const srcPorts = JSON.parse(src.ports || '[]');
    const srcEnv   = JSON.parse(src.env_vars || '{}');
    const id       = uuidv4();

    db.prepare(`
      INSERT INTO servers (id,name,description,user_id,node_id,node,image,cpu_limit,cpu_percent,
        memory_limit,swap_limit,disk_limit,ports,env_vars,startup_command,work_dir,network,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'installing')
    `).run(id, name, src.description || '', src.user_id, targetNodeId, node.name,
           src.image, src.cpu_limit, src.cpu_percent || 100,
           src.memory_limit, src.swap_limit, src.disk_limit,
           src.ports, src.env_vars, src.startup_command, src.work_dir || '/home/container', src.network || 'bridge');

    // Ports in port_allocations anlegen
    if (Array.isArray(srcPorts) && srcPorts.length > 0) {
      const insertAlloc = db.prepare(
        "INSERT OR IGNORE INTO port_allocations (id,node_id,ip,port,server_id,is_primary,notes) VALUES (?,?,?,?,?,?,'')"
      );
      db.transaction(() => {
        srcPorts.forEach((p, idx) => {
          const hostPort = p.host || p;
          const existing = db.prepare('SELECT id FROM port_allocations WHERE node_id=? AND port=? AND server_id IS NULL').get(targetNodeId, hostPort);
          if (existing) {
            db.prepare('UPDATE port_allocations SET server_id=?, is_primary=? WHERE id=?').run(id, idx === 0 ? 1 : 0, existing.id);
          }
          // (Port belegt → einfach überspringen, User muss ggf. anderen Port wählen)
        });
      })();
    }

    // Container async erstellen
    (async () => {
      try {
        const result = await routeToNode(targetNodeId, {
          type: 'server.create', server_id: id,
          config: {
            image: src.image, cpu_limit: src.cpu_limit, cpu_percent: src.cpu_percent || 100,
            memory_limit: src.memory_limit, swap_limit: src.swap_limit, disk_limit: src.disk_limit,
            ports: srcPorts, env_vars: srcEnv,
            startup_command: src.startup_command, work_dir: src.work_dir || '/home/container',
            network: src.network || 'bridge',
          }
        }, 120_000);
        if (result.success && result.container_id) {
          db.prepare("UPDATE servers SET container_id=?,status='offline',updated_at=datetime('now') WHERE id=?").run(result.container_id, id);
        } else {
          db.prepare("UPDATE servers SET status='error',updated_at=datetime('now') WHERE id=?").run(id);
        }
      } catch (e) {
        db.prepare("UPDATE servers SET status='error',updated_at=datetime('now') WHERE id=?").run(id);
      }
    })();

    auditLog(req.user.id, 'SERVER_CLONE', 'server', id, { source_id: src.id, name }, req.ip);
    res.status(201).json({ id, name, status: 'installing' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
