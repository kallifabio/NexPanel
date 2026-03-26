'use strict';
/**
 * routes/schedule.js — Geplante Aufgaben (Cronjobs) pro Server
 * Cron-Expressions: "Minute Stunde Tag Monat Wochentag"
 * z.B. "0 6 * * *" = täglich 06:00
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../src/core/db');
const { authenticate } = require('./auth');
const { routeToNode } = require('../src/docker/node-router');

const router = express.Router({ mergeParams: true });

function canAccess(req, res, next) {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (req.user.role !== 'admin' && srv.user_id !== req.user.id)
    return res.status(403).json({ error: 'Kein Zugriff' });
  req.srv = srv;
  next();
}

// ─── TASKS AUFLISTEN ─────────────────────────────────────────────────────────
router.get('/', authenticate, canAccess, (req, res) => {
  const tasks = db.prepare('SELECT * FROM scheduled_tasks WHERE server_id=? ORDER BY created_at ASC')
    .all(req.params.serverId);
  res.json(tasks);
});

// ─── TASK ERSTELLEN ──────────────────────────────────────────────────────────
router.post('/', authenticate, canAccess, (req, res) => {
  try {
    const { name, action, payload = '', cron, enabled = 1 } = req.body;
    if (!name || !action || !cron)
      return res.status(400).json({ error: 'name, action und cron sind erforderlich' });
    const validActions = ['start', 'stop', 'restart', 'command'];
    if (!validActions.includes(action))
      return res.status(400).json({ error: `Ungültige Aktion. Erlaubt: ${validActions.join(', ')}` });
    if (action === 'command' && !payload.trim())
      return res.status(400).json({ error: 'Befehl darf nicht leer sein' });
    if (!isValidCron(cron))
      return res.status(400).json({ error: 'Ungültige Cron-Expression' });

    const id = uuidv4();
    db.prepare(`INSERT INTO scheduled_tasks (id,server_id,name,action,payload,cron,enabled) VALUES (?,?,?,?,?,?,?)`)
      .run(id, req.params.serverId, name, action, payload, cron, enabled ? 1 : 0);
    auditLog(req.user.id, 'TASK_CREATE', 'server', req.params.serverId, { name, action, cron }, req.ip);
    res.status(201).json(db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TASK BEARBEITEN ─────────────────────────────────────────────────────────
router.patch('/:taskId', authenticate, canAccess, (req, res) => {
  const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id=? AND server_id=?')
    .get(req.params.taskId, req.params.serverId);
  if (!task) return res.status(404).json({ error: 'Task nicht gefunden' });

  const { name, action, payload, cron, enabled } = req.body;
  if (cron && !isValidCron(cron)) return res.status(400).json({ error: 'Ungültige Cron-Expression' });

  db.prepare(`UPDATE scheduled_tasks SET
    name=COALESCE(?,name), action=COALESCE(?,action), payload=COALESCE(?,payload),
    cron=COALESCE(?,cron), enabled=COALESCE(?,enabled)
    WHERE id=?`)
    .run(name ?? null, action ?? null, payload ?? null, cron ?? null, enabled != null ? (enabled ? 1 : 0) : null, task.id);
  res.json(db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(task.id));
});

// ─── TASK LÖSCHEN ────────────────────────────────────────────────────────────
router.delete('/:taskId', authenticate, canAccess, (req, res) => {
  const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id=? AND server_id=?')
    .get(req.params.taskId, req.params.serverId);
  if (!task) return res.status(404).json({ error: 'Task nicht gefunden' });
  db.prepare('DELETE FROM scheduled_tasks WHERE id=?').run(task.id);
  auditLog(req.user.id, 'TASK_DELETE', 'server', req.params.serverId, { name: task.name }, req.ip);
  res.json({ success: true });
});

// ─── TASK MANUELL AUSFÜHREN ───────────────────────────────────────────────────
router.post('/:taskId/run', authenticate, canAccess, async (req, res) => {
  const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id=? AND server_id=?')
    .get(req.params.taskId, req.params.serverId);
  if (!task) return res.status(404).json({ error: 'Task nicht gefunden' });
  try {
    const result = await executeTask(task, req.srv);
    res.json({ success: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CRON VALIDATION ─────────────────────────────────────────────────────────
function isValidCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges = [[0,59],[0,23],[1,31],[1,12],[0,7]];
  return parts.every((part, i) => {
    if (part === '*') return true;
    if (/^\*\/\d+$/.test(part)) return true;
    const [lo, hi] = ranges[i];
    const n = parseInt(part);
    return !isNaN(n) && n >= lo && n <= hi;
  });
}

// ─── TASK AUSFÜHREN ──────────────────────────────────────────────────────────
async function executeTask(task, srv) {
  if (!srv.container_id) throw new Error('Kein Container');
  let result = '';
  switch (task.action) {
    case 'start':
    case 'stop':
    case 'restart': {
      const r = await routeToNode(srv.node_id, {
        type: 'server.power', server_id: srv.id,
        container_id: srv.container_id, action: task.action,
      }, 30_000);
      result = r.status || task.action + ' ausgeführt';
      break;
    }
    case 'command': {
      const r = await routeToNode(srv.node_id, {
        type: 'server.command', server_id: srv.id,
        container_id: srv.container_id, command: task.payload,
      }, 30_000);
      result = r.output || '✓';
      break;
    }
  }
  db.prepare("UPDATE scheduled_tasks SET last_run=datetime('now'), last_result=? WHERE id=?")
    .run(result.substring(0, 200), task.id);
  return result;
}

module.exports = router;
module.exports.executeTask = executeTask;
module.exports.isValidCron = isValidCron;
