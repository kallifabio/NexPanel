'use strict';
/**
 * src/core/auto-sleep.js — Auto-Sleep / Wake-on-Connect
 *
 * Auto-Sleep:  Server wird automatisch gestoppt wenn X Minuten keine
 *              Aktivität registriert wurde (kein WS-Client verbunden,
 *              kein Befehl, kein Konsolen-Output).
 *
 * Wake-on-Connect: Beim Aufrufen der Server-Detail-Seite oder beim
 *              WebSocket-Subscribe wird der Server automatisch gestartet
 *              falls er schläft.
 *
 * Aktivität wird bei folgenden Events aktualisiert:
 *   - WebSocket console.subscribe
 *   - console.input
 *   - API power/start|restart
 *   - Files lesen/schreiben
 */

const { db } = require('./db');
const { routeToNode } = require('../docker/node-router');

// ─── Aktivität registrieren ───────────────────────────────────────────────────
function recordActivity(serverId) {
  try {
    db.prepare("UPDATE servers SET last_activity_at=datetime('now') WHERE id=? AND auto_sleep_enabled=1")
      .run(serverId);
  } catch (_) {}
}

// ─── Auto-Sleep prüfen (wird vom Scheduler jede Minute aufgerufen) ────────────
async function autoSleepTick() {
  try {
    const servers = db.prepare(`
      SELECT id, name, node_id, container_id, status, auto_sleep_minutes, last_activity_at
      FROM servers
      WHERE auto_sleep_enabled = 1
        AND status = 'running'
        AND container_id IS NOT NULL
        AND container_id != ''
    `).all();

    const now = Date.now();
    for (const srv of servers) {
      const lastActivity = srv.last_activity_at
        ? new Date(srv.last_activity_at).getTime()
        : 0;
      const idleMinutes = (now - lastActivity) / 60_000;
      const limitMinutes = srv.auto_sleep_minutes || 30;

      if (idleMinutes >= limitMinutes) {
        console.log(`[auto-sleep] "${srv.name}" (${srv.id}): ${Math.round(idleMinutes)} min idle → stoppe`);
        try {
          await routeToNode(srv.node_id, {
            type:         'container.stop',
            server_id:    srv.id,
            container_id: srv.container_id,
          }, 30_000);
          db.prepare("UPDATE servers SET status='offline', updated_at=datetime('now') WHERE id=?")
            .run(srv.id);
          // Notify via WS if available
          try {
            const { broadcastAll } = require('../../routes/bulk');
          } catch (_) {}
          console.log(`[auto-sleep] "${srv.name}" gestoppt (${Math.round(idleMinutes)} min idle)`);
        } catch (e) {
          console.warn(`[auto-sleep] Fehler beim Stoppen von "${srv.name}":`, e.message);
        }
      }
    }
  } catch (e) {
    console.warn('[auto-sleep] Tick-Fehler:', e.message);
  }
}

// ─── Wake-on-Connect ──────────────────────────────────────────────────────────
async function wakeServer(serverId) {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);
  if (!srv) return { success: false, error: 'Server nicht gefunden' };
  if (srv.status === 'running') return { success: true, already_running: true };
  if (!srv.auto_sleep_enabled) return { success: false, error: 'Auto-Sleep nicht aktiviert' };
  if (!srv.container_id) return { success: false, error: 'Kein Container' };

  if (['starting', 'installing'].includes(srv.status)) {
    return { success: true, starting: true };
  }

  try {
    db.prepare("UPDATE servers SET status='starting', updated_at=datetime('now') WHERE id=?")
      .run(serverId);
    recordActivity(serverId);

    routeToNode(srv.node_id, {
      type:         'container.start',
      server_id:    srv.id,
      container_id: srv.container_id,
    }, 60_000).then(() => {
      db.prepare("UPDATE servers SET status='running', updated_at=datetime('now') WHERE id=?")
        .run(serverId);
    }).catch(e => {
      db.prepare("UPDATE servers SET status='offline', updated_at=datetime('now') WHERE id=?")
        .run(serverId);
      console.warn(`[wake] Fehler beim Starten von ${serverId}:`, e.message);
    });

    return { success: true, waking: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Auto-Sleep Einstellungen lesen/setzen ────────────────────────────────────
function getAutoSleepConfig(serverId) {
  const row = db.prepare(
    'SELECT auto_sleep_enabled, auto_sleep_minutes, last_activity_at, status FROM servers WHERE id=?'
  ).get(serverId);
  if (!row) return null;
  return {
    enabled:          !!row.auto_sleep_enabled,
    idle_minutes:     row.auto_sleep_minutes || 30,
    last_activity_at: row.last_activity_at,
    status:           row.status,
  };
}

function setAutoSleepConfig(serverId, { enabled, idle_minutes }) {
  db.prepare(`
    UPDATE servers
    SET auto_sleep_enabled=?, auto_sleep_minutes=?, last_activity_at=datetime('now'),
        updated_at=datetime('now')
    WHERE id=?
  `).run(enabled ? 1 : 0, Math.max(5, Math.min(1440, idle_minutes || 30)), serverId);
}

module.exports = { recordActivity, autoSleepTick, wakeServer, getAutoSleepConfig, setAutoSleepConfig };
