'use strict';
/**
 * routes/maintenance.js — Maintenance-Modus & Server-Transfer
 *
 * Maintenance:
 *   GET    /api/servers/:id/maintenance        — Status
 *   PUT    /api/servers/:id/maintenance        — Aktivieren/deaktivieren
 *
 * Transfer:
 *   POST   /api/servers/:id/transfer           — Transfer starten
 *     body: { target_node_id }
 *   GET    /api/servers/:id/transfer/status    — Transfer-Status abfragen
 *
 * Node-Ressourcen-Übersicht:
 *   GET    /api/admin/nodes/resources          — Alle Nodes mit Ressourcen-Nutzung
 */

const express = require('express');
const { db, auditLog } = require('../src/core/db');
const { authenticate, requireAdmin } = require('./auth');
const { routeToNode } = require('../src/docker/node-router');

const router = express.Router({ mergeParams: true });

// ─── MAINTENANCE STATUS ───────────────────────────────────────────────────────
router.get('/:serverId/maintenance', authenticate, (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (srv.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Kein Zugriff' });

  const m = db.prepare('SELECT * FROM maintenance_mode WHERE server_id=?').get(srv.id);
  res.json(m || { server_id: srv.id, enabled: false, message: 'Server wird gewartet', started_at: null });
});

// ─── MAINTENANCE AKTIVIEREN / DEAKTIVIEREN ────────────────────────────────────
router.put('/:serverId/maintenance', authenticate, (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (srv.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Kein Zugriff' });

  const { enabled, message = 'Server wird gewartet' } = req.body;
  const existing = db.prepare('SELECT server_id FROM maintenance_mode WHERE server_id=?').get(srv.id);

  if (existing) {
    db.prepare("UPDATE maintenance_mode SET enabled=?,message=?,started_at=CASE WHEN ?=1 THEN datetime('now') ELSE started_at END,started_by=? WHERE server_id=?")
      .run(enabled ? 1 : 0, message, enabled ? 1 : 0, req.user.id, srv.id);
  } else {
    db.prepare("INSERT INTO maintenance_mode (server_id,enabled,message,started_at,started_by) VALUES (?,?,?,CASE WHEN ?=1 THEN datetime('now') ELSE NULL END,?)")
      .run(srv.id, enabled ? 1 : 0, message, enabled ? 1 : 0, req.user.id);
  }

  auditLog(req.user.id, enabled ? 'MAINTENANCE_ON' : 'MAINTENANCE_OFF', 'server', srv.id, { message }, req.ip);
  res.json({ success: true, enabled: !!enabled });
});

// ─── SERVER TRANSFER ──────────────────────────────────────────────────────────
// Transfer-Status in Memory (für laufende Transfers)
const transferStatus = new Map();

router.post('/:serverId/transfer', authenticate, async (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (srv.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Kein Zugriff' });
  if (transferStatus.get(srv.id)?.running)
    return res.status(409).json({ error: 'Transfer läuft bereits' });

  const { target_node_id } = req.body;
  if (!target_node_id) return res.status(400).json({ error: 'target_node_id erforderlich' });
  if (target_node_id === (srv.node_id || 'local'))
    return res.status(400).json({ error: 'Ziel-Node ist bereits die aktuelle Node' });

  const targetNode = db.prepare('SELECT * FROM nodes WHERE id=?').get(target_node_id);
  if (!targetNode) return res.status(404).json({ error: 'Ziel-Node nicht gefunden' });

  transferStatus.set(srv.id, { running: true, stage: 'starting', progress: 0, error: null });
  res.json({ success: true, message: 'Transfer gestartet' });

  // ── Async Transfer ────────────────────────────────────────────────────────
  setImmediate(async () => {
    const setStage = (stage, progress) => transferStatus.set(srv.id, { running: true, stage, progress, error: null });
    try {
      // 1. Server stoppen falls läuft
      setStage('stopping', 10);
      if (srv.container_id && srv.status === 'running') {
        await routeToNode(srv.node_id, { type: 'server.stop', server_id: srv.id, container_id: srv.container_id }, 30_000).catch(() => {});
        db.prepare("UPDATE servers SET status='offline' WHERE id=?").run(srv.id);
      }

      // 2. Backup der Daten auf Panel erstellen
      setStage('backup', 25);
      const fs   = require('fs');
      const path = require('path');
      const BACKUP_BASE = process.env.BACKUP_PATH || path.join(__dirname, '..', 'backups');
      const tmpFile = path.join(BACKUP_BASE, srv.id, `transfer_${Date.now()}.tar.gz`);
      fs.mkdirSync(path.dirname(tmpFile), { recursive: true });

      if (srv.container_id) {
        await routeToNode(srv.node_id, {
          type: 'backup.create', server_id: srv.id, container_id: srv.container_id,
          file_path: tmpFile, work_dir: srv.work_dir || '/home/container',
        }, 300_000);
      }

      // 3. Container auf Quell-Node löschen
      setStage('removing_source', 50);
      if (srv.container_id) {
        await routeToNode(srv.node_id, { type: 'server.delete', container_id: srv.container_id }, 30_000).catch(() => {});
      }

      // 4. Neuen Container auf Ziel-Node erstellen
      setStage('creating_target', 65);
      const ports = JSON.parse(srv.ports || '[]');
      const envVars = JSON.parse(srv.env_vars || '{}');
      const createResult = await routeToNode(target_node_id, {
        type: 'server.create', server_id: srv.id,
        config: {
          image: srv.image, cpu_limit: srv.cpu_limit, cpu_percent: srv.cpu_percent || 100,
          memory_limit: srv.memory_limit, swap_limit: srv.swap_limit || 0,
          ports, env_vars: envVars, startup_command: srv.startup_command,
          work_dir: srv.work_dir, network: srv.network || 'bridge',
        },
      }, 120_000);

      // 5. Daten wiederherstellen auf neuem Container
      setStage('restoring', 80);
      if (fs.existsSync(tmpFile)) {
        await routeToNode(target_node_id, {
          type: 'backup.restore', server_id: srv.id, container_id: createResult.container_id,
          file_path: tmpFile, work_dir: srv.work_dir || '/home/container',
        }, 300_000).catch(e => console.warn('[transfer] Restore-Fehler (nicht fatal):', e.message));
        fs.unlink(tmpFile, () => {});
      }

      // 6. DB aktualisieren
      setStage('updating', 95);
      db.prepare("UPDATE servers SET node_id=?,node=?,container_id=?,status='offline',updated_at=datetime('now') WHERE id=?")
        .run(target_node_id, targetNode.name, createResult.container_id, srv.id);

      auditLog(req.user.id, 'SERVER_TRANSFER', 'server', srv.id, {
        from_node: srv.node_id || 'local', to_node: target_node_id, target_name: targetNode.name,
      }, '');

      transferStatus.set(srv.id, { running: false, stage: 'done', progress: 100, error: null });
    } catch (e) {
      console.error('[transfer] Fehler:', e.message);
      transferStatus.set(srv.id, { running: false, stage: 'error', progress: 0, error: e.message });
    }
  });
});

router.get('/:serverId/transfer/status', authenticate, (req, res) => {
  const srv = db.prepare('SELECT id,user_id FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (srv.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Kein Zugriff' });

  const status = transferStatus.get(req.params.serverId) || { running: false, stage: 'idle', progress: 0 };
  res.json(status);
});

// ─── NODE RESSOURCEN-ÜBERSICHT (Admin) ────────────────────────────────────────
router.get('/resources', authenticate, requireAdmin, (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes').all();

  const resources = nodes.map(node => {
    const servers = db.prepare("SELECT * FROM servers WHERE node_id=? AND status != 'deleted'").all(node.id);

    // Geplante Ressourcen (aus DB-Limits)
    const allocCpu = servers.reduce((s, srv) => s + (parseFloat(srv.cpu_limit) || 0), 0);
    const allocMem = servers.reduce((s, srv) => s + (parseInt(srv.memory_limit) || 0), 0);
    const allocDisk = servers.reduce((s, srv) => s + (parseInt(srv.disk_limit) || 0), 0);

    // Tatsächliche Nutzung aus letztem Stats-Snapshot
    const statRows = db.prepare(`
      SELECT sl.cpu, sl.memory_mb FROM server_stats_log sl
      INNER JOIN (SELECT server_id, MAX(recorded_at) as max_at FROM server_stats_log GROUP BY server_id) latest
        ON sl.server_id=latest.server_id AND sl.recorded_at=latest.max_at
      WHERE sl.server_id IN (SELECT id FROM servers WHERE node_id=?)
    `).all(node.id);

    const usedCpu = statRows.reduce((s, r) => s + (r.cpu || 0), 0);
    const usedMem = statRows.reduce((s, r) => s + (r.memory_mb || 0), 0);

    const sysInfo = node.system_info ? (() => { try { return JSON.parse(node.system_info); } catch { return {}; } })() : {};

    return {
      ...node,
      server_count: servers.length,
      running_count: servers.filter(s => s.status === 'running').length,
      alloc: { cpu_cores: allocCpu, memory_mb: allocMem, disk_mb: allocDisk },
      used:  { cpu_pct: Math.round(usedCpu * 10) / 10, memory_mb: Math.round(usedMem) },
      limits: {
        memory_mb: node.memory_mb || 0,
        disk_mb:   node.disk_mb   || 0,
        cpu_overalloc: node.cpu_overalloc || 0,
      },
      system: sysInfo,
    };
  });

  res.json(resources);
});

module.exports = router;
