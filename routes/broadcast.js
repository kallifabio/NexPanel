'use strict';
/**
 * routes/broadcast.js — Server-Broadcast
 *
 * Sendet einen Befehl an mehrere (oder alle) laufenden Server gleichzeitig.
 *
 * Endpunkte:
 *   POST /api/servers/broadcast        — Befehl an mehrere Server senden
 *   GET  /api/servers/broadcast/history — Broadcast-Verlauf abrufen
 */

const express       = require('express');
const { v4: uuidv4 }= require('uuid');
const { db, auditLog } = require('../src/core/db');
const { authenticate, requireAdmin } = require('./auth');
const { routeToNode } = require('../src/docker/node-router');

const router = express.Router();

// ─── BROADCAST SENDEN ────────────────────────────────────────────────────────
// POST /api/servers/broadcast
router.post('/broadcast', authenticate, async (req, res) => {
  const {
    command,                     // Befehl der gesendet wird
    server_ids,                  // Optional: spezifische Server-IDs. Null = alle eigenen laufenden
    target = 'running',          // 'running' | 'all' | 'mine'
    delay_ms = 0,                // Optional: Verzögerung zwischen Servern (0–5000 ms)
  } = req.body;

  if (!command?.trim()) return res.status(400).json({ error: 'command erforderlich' });
  if (delay_ms < 0 || delay_ms > 5000) return res.status(400).json({ error: 'delay_ms muss zwischen 0 und 5000 ms liegen' });

  const isAdmin = req.user.role === 'admin';

  // Ziel-Server ermitteln
  let servers;

  if (Array.isArray(server_ids) && server_ids.length > 0) {
    // Explizite Liste — jeder Server wird auf Zugriff geprüft
    if (server_ids.length > 50) return res.status(400).json({ error: 'Maximal 50 Server pro Broadcast' });
    servers = db.prepare(
      `SELECT * FROM servers WHERE id IN (${server_ids.map(() => '?').join(',')})`
    ).all(...server_ids);

    // Zugriffsprüfung
    servers = servers.filter(s => {
      if (isAdmin) return true;
      if (s.user_id === req.user.id) return true;
      const sub = db.prepare(
        "SELECT permissions FROM server_subusers WHERE server_id=? AND user_id=?"
      ).get(s.id, req.user.id);
      if (!sub) return false;
      const perms = JSON.parse(sub.permissions || '[]');
      return perms.includes('console');
    });
  } else {
    // Automatisch alle eigenen (oder alle bei Admin)
    const statusFilter = target === 'running' ? "AND s.status='running'" : '';
    if (isAdmin) {
      servers = db.prepare(`SELECT * FROM servers WHERE container_id IS NOT NULL ${statusFilter}`).all();
    } else {
      servers = db.prepare(
        `SELECT s.* FROM servers s
         LEFT JOIN server_subusers su ON su.server_id=s.id AND su.user_id=?
         WHERE (s.user_id=? OR (su.user_id IS NOT NULL AND su.permissions LIKE '%console%'))
         AND s.container_id IS NOT NULL ${statusFilter}`
      ).all(req.user.id, req.user.id);
    }

    if (servers.length === 0) {
      return res.json({ sent: 0, failed: 0, results: [], message: 'Keine passenden Server gefunden' });
    }
    if (servers.length > 50) {
      return res.status(400).json({ error: `Zu viele Server (${servers.length}) — bitte server_ids explizit angeben` });
    }
  }

  if (servers.length === 0) return res.json({ sent: 0, failed: 0, results: [] });

  // Sofort antworten — Ausführung async
  const broadcastId = uuidv4();
  res.json({
    broadcast_id: broadcastId,
    target_count: servers.length,
    message:      `Befehl wird an ${servers.length} Server gesendet…`,
  });

  // Broadcast in Hintergrund ausführen
  setImmediate(async () => {
    const results = [];

    for (let i = 0; i < servers.length; i++) {
      const srv = servers[i];
      if (i > 0 && delay_ms > 0) {
        await new Promise(r => setTimeout(r, delay_ms));
      }

      try {
        await routeToNode(srv.node_id, {
          type:         'container.exec',
          server_id:    srv.id,
          container_id: srv.container_id,
          command:      command.trim(),
        }, 15_000);

        results.push({ server_id: srv.id, name: srv.name, status: 'sent' });
      } catch (e) {
        results.push({ server_id: srv.id, name: srv.name, status: 'error', error: e.message });
      }
    }

    const sent   = results.filter(r => r.status === 'sent').length;
    const failed = results.filter(r => r.status === 'error').length;

    // In History speichern
    saveBroadcastHistory({
      id:          broadcastId,
      user_id:     req.user.id,
      command:     command.trim(),
      target_count: servers.length,
      sent, failed,
      results:     JSON.stringify(results),
    });

    auditLog(req.user.id, 'BROADCAST', 'server', null,
      { command: command.trim(), sent, failed, total: servers.length }, '');

    console.log(`[broadcast] ${broadcastId}: "${command.trim().slice(0,60)}" → ${sent}/${servers.length} OK, ${failed} Fehler`);
  });
});

// ─── BROADCAST HISTORY ────────────────────────────────────────────────────────
// GET /api/servers/broadcast/history
router.get('/broadcast/history', authenticate, (req, res) => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='broadcast_history'").get();
    const history = row ? JSON.parse(row.value) : [];

    // User sieht nur seine eigenen, Admin sieht alle
    const filtered = req.user.role === 'admin'
      ? history
      : history.filter(h => h.user_id === req.user.id);

    res.json(filtered.slice(0, 50));
  } catch (_) { res.json([]); }
});

// ─── INTERN: History speichern ────────────────────────────────────────────────
function saveBroadcastHistory(entry) {
  try {
    const row     = db.prepare("SELECT value FROM settings WHERE key='broadcast_history'").get();
    const history = row ? JSON.parse(row.value) : [];
    history.unshift({ ...entry, at: new Date().toISOString() });
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('broadcast_history',?)")
      .run(JSON.stringify(history.slice(0, 200)));
  } catch (_) { /* non-fatal */ }
}

module.exports = router;
