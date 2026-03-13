'use strict';
/**
 * routes/bulk.js — Bulk-Aktionen für mehrere Server gleichzeitig
 *
 * POST /api/servers/bulk/power   { server_ids: [...], action: 'start'|'stop'|'restart'|'kill' }
 * GET  /api/servers/:id/console/history   — Konsolen-History abrufen
 * DELETE /api/servers/:id/console/history — History löschen
 */

const express = require('express');
const { db, auditLog } = require('../db');
const { authenticate } = require('./auth');
const { routeToNode }  = require('../node-router');

const router = express.Router();

// ─── BULK POWER ───────────────────────────────────────────────────────────────
router.post('/bulk/power', authenticate, async (req, res) => {
  const { server_ids, action } = req.body;

  if (!Array.isArray(server_ids) || server_ids.length === 0)
    return res.status(400).json({ error: 'server_ids erforderlich' });
  if (!['start','stop','restart','kill'].includes(action))
    return res.status(400).json({ error: 'Ungültige Aktion' });
  if (server_ids.length > 50)
    return res.status(400).json({ error: 'Maximal 50 Server gleichzeitig' });

  // Zugriff prüfen: User darf nur eigene Server steuern (außer Admins)
  const results = [];

  await Promise.allSettled(server_ids.map(async (id) => {
    try {
      const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(id);
      if (!srv) return results.push({ id, success: false, error: 'Nicht gefunden' });
      if (req.user.role !== 'admin' && srv.user_id !== req.user.id)
        return results.push({ id, success: false, error: 'Kein Zugriff' });
      if (!srv.container_id)
        return results.push({ id, success: false, error: 'Kein Container' });

      const result = await routeToNode(srv.node_id, {
        type: `server.${action}`,
        server_id: srv.id,
        container_id: srv.container_id,
      }, 30_000);

      // Status in DB aktualisieren
      const newStatus = { start:'running', stop:'offline', restart:'running', kill:'offline' }[action];
      db.prepare("UPDATE servers SET status=?,updated_at=datetime('now') WHERE id=?")
        .run(result.status || newStatus, id);

      auditLog(req.user.id, `POWER_${action.toUpperCase()}`, 'server', id, { bulk: true }, req.ip);
      results.push({ id, success: true, status: result.status || newStatus, name: srv.name });
    } catch (e) {
      results.push({ id, success: false, error: e.message });
    }
  }));

  const ok  = results.filter(r => r.success).length;
  const err = results.filter(r => !r.success).length;
  res.json({ results, summary: { ok, err, total: results.length } });
});

// ─── KONSOLEN-HISTORY ABRUFEN ─────────────────────────────────────────────────
router.get('/:serverId/console/history', authenticate, (req, res) => {
  const srv = db.prepare('SELECT id, user_id FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (req.user.role !== 'admin' && srv.user_id !== req.user.id)
    return res.status(403).json({ error: 'Kein Zugriff' });

  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const rows  = db.prepare(`
    SELECT command, executed_at
    FROM console_history
    WHERE server_id=? AND user_id=?
    ORDER BY executed_at DESC LIMIT ?
  `).all(req.params.serverId, req.user.id, limit);

  res.json(rows.reverse()); // älteste zuerst → für Pfeil-Navigation
});

// ─── KONSOLEN-HISTORY LÖSCHEN ─────────────────────────────────────────────────
router.delete('/:serverId/console/history', authenticate, (req, res) => {
  const srv = db.prepare('SELECT id, user_id FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (req.user.role !== 'admin' && srv.user_id !== req.user.id)
    return res.status(403).json({ error: 'Kein Zugriff' });

  db.prepare('DELETE FROM console_history WHERE server_id=? AND user_id=?')
    .run(req.params.serverId, req.user.id);
  res.json({ success: true });
});

// ─── KONSOLEN-BEFEHL SPEICHERN (intern, kein Auth-Check — wird von ws-panel gerufen) ─
function saveConsoleCommand(serverId, userId, command) {
  if (!command?.trim() || !serverId || !userId) return;
  try {
    db.prepare(`
      INSERT INTO console_history (server_id, user_id, command) VALUES (?,?,?)
    `).run(serverId, userId, command.trim());
    // Maximal 500 Einträge pro User+Server behalten
    db.prepare(`
      DELETE FROM console_history WHERE server_id=? AND user_id=? AND id NOT IN (
        SELECT id FROM console_history WHERE server_id=? AND user_id=?
        ORDER BY executed_at DESC LIMIT 500
      )
    `).run(serverId, userId, serverId, userId);
  } catch {}
}

// ─── STATS VERLAUF ────────────────────────────────────────────────────────────
router.get('/:serverId/stats/history', authenticate, async (req, res) => {
  const srv = db.prepare('SELECT id, user_id FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (req.user.role !== 'admin' && srv.user_id !== req.user.id)
    return res.status(403).json({ error: 'Kein Zugriff' });

  const hours  = Math.min(parseInt(req.query.hours)  || 24,  168); // max 7 Tage
  const points = Math.min(parseInt(req.query.points) || 120, 500);

  const { getStatsHistory } = require('../stats-collector');
  res.json(getStatsHistory(req.params.serverId, hours, points));
});

module.exports = router;
module.exports.saveConsoleCommand = saveConsoleCommand;
