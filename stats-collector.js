'use strict';
/**
 * stats-collector.js — Periodischer Stats-Sampler
 *
 * Alle 30 Sekunden: Fragt alle laufenden Server-Container nach CPU/RAM/Net
 * und speichert einen Snapshot in server_stats_log.
 * Löscht automatisch Einträge älter als 7 Tage.
 *
 * Wichtig: Funktioniert nur für lokale Container (Docker-Socket).
 * Remote-Nodes schicken Stats per WS push — die werden in ws-panel.js abgefangen
 * und dort ebenfalls in die DB geschrieben (via persistStats()).
 */

const { db }        = require('./db');
const dockerLocal   = require('./docker-local');
let _checkAlerts = null;  // lazy to avoid circular dep

const SAMPLE_INTERVAL_MS = 30_000;  // alle 30s
const RETAIN_DAYS        = 7;

let _interval = null;

// ─── EINEN SNAPSHOT SPEICHERN ─────────────────────────────────────────────────
function persistStats(serverId, stats) {
  if (!stats || !serverId) return;
  try {
    const memMb      = Math.round((stats.memory      || 0) / 1024 / 1024 * 10) / 10;
    const memLimMb   = Math.round((stats.memory_limit|| 0) / 1024 / 1024 * 10) / 10;
    db.prepare(`
      INSERT INTO server_stats_log
        (server_id, cpu, memory_mb, memory_limit_mb, network_rx, network_tx, pids)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      serverId,
      Math.round((stats.cpu || 0) * 10) / 10,
      memMb,
      memLimMb,
      stats.network_rx || 0,
      stats.network_tx || 0,
      stats.pids       || 0,
    );
  } catch (e) {
    // Darf nie crashen
    console.warn('[stats-collector] persistStats Fehler:', e.message);
  }

  // Resource Alerts prüfen (lazy load um circulare Deps zu vermeiden)
  try {
    if (!_checkAlerts) _checkAlerts = require('./resource-alerts').checkResourceAlerts;
    if (stats && serverId) {
      const memMb    = Math.round((stats.memory       || 0) / 1024 / 1024 * 10) / 10;
      const memLimMb = Math.round((stats.memory_limit || 0) / 1024 / 1024 * 10) / 10;
      _checkAlerts(serverId, { cpu: stats.cpu || 0, memory_mb: memMb, memory_limit_mb: memLimMb }).catch(() => {});
    }
  } catch {}
}

// ─── AUFRÄUMEN ────────────────────────────────────────────────────────────────
function pruneOldStats() {
  try {
    const deleted = db.prepare(
      `DELETE FROM server_stats_log WHERE recorded_at < datetime('now','-${RETAIN_DAYS} days')`
    ).run();
    if (deleted.changes > 0)
      console.log(`[stats-collector] ${deleted.changes} alte Einträge gelöscht`);
  } catch {}
}

// ─── VERLAUFS-DATEN ABRUFEN ───────────────────────────────────────────────────
/**
 * Gibt aggregierte Stats zurück für Charts.
 * @param {string} serverId
 * @param {number} hours  — wie weit zurück (1, 6, 24, 168)
 * @param {number} points — max. Datenpunkte (Downsampling)
 */
function getStatsHistory(serverId, hours = 24, points = 120) {
  const rows = db.prepare(`
    SELECT cpu, memory_mb, memory_limit_mb, network_rx, network_tx, pids, recorded_at
    FROM server_stats_log
    WHERE server_id = ? AND recorded_at > datetime('now', ?)
    ORDER BY recorded_at ASC
  `).all(serverId, `-${hours} hours`);

  if (rows.length === 0) return { labels: [], cpu: [], memory: [], net_rx: [], net_tx: [], pids: [] };

  // Downsampling: gleichmäßig verteilen
  const step = Math.max(1, Math.floor(rows.length / points));
  const sampled = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);

  // Netz-Delta berechnen
  const netRx = [], netTx = [];
  for (let i = 0; i < sampled.length; i++) {
    if (i === 0) { netRx.push(0); netTx.push(0); continue; }
    netRx.push(Math.max(0, sampled[i].network_rx - sampled[i-1].network_rx));
    netTx.push(Math.max(0, sampled[i].network_tx - sampled[i-1].network_tx));
  }

  return {
    labels:  sampled.map(r => r.recorded_at),
    cpu:     sampled.map(r => r.cpu),
    memory:  sampled.map(r => r.memory_mb),
    memory_limit: sampled[sampled.length - 1]?.memory_limit_mb || 0,
    net_rx:  netRx,
    net_tx:  netTx,
    pids:    sampled.map(r => r.pids),
    count:   rows.length,
    sampled: sampled.length,
  };
}

// ─── LOKALE CONTAINER SAMPELN ─────────────────────────────────────────────────
async function collectLocalStats() {
  if (!dockerLocal.isAvailable()) return;

  const servers = db.prepare(
    "SELECT * FROM servers WHERE status='running' AND (node_id IS NULL OR node_id='')"
  ).all();

  for (const srv of servers) {
    if (!srv.container_id) continue;
    try {
      const stats = await dockerLocal.getStats(srv.container_id, srv.memory_limit);
      if (stats) persistStats(srv.id, stats);
    } catch {
      // Container möglicherweise gestoppt — ignorieren
    }
  }
}

// ─── STARTEN / STOPPEN ────────────────────────────────────────────────────────
function startStatsCollector() {
  if (_interval) return;

  // Sofort beim Start (nach 5s damit Docker-Socket bereit ist)
  setTimeout(collectLocalStats, 5_000);

  _interval = setInterval(() => {
    collectLocalStats().catch(() => {});
    // Einmal täglich aufräumen
    const now = new Date();
    if (now.getHours() === 3 && now.getMinutes() < 1) pruneOldStats();
  }, SAMPLE_INTERVAL_MS);

  console.log(`[stats-collector] Gestartet (alle ${SAMPLE_INTERVAL_MS / 1000}s)`);
}

function stopStatsCollector() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { startStatsCollector, stopStatsCollector, persistStats, getStatsHistory };
