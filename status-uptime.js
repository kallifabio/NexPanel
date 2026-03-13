'use strict';
/**
 * status-uptime.js — Täglicher Uptime-Snapshot-Job
 * Läuft täglich um 23:55 und berechnet den Uptime-% für jeden Server.
 * Basis: server_stats_log (alle 30s) → wie viele Samples waren "running"?
 */
const { db } = require('./db');

function computeDailyUptime(date) {
  // date: 'YYYY-MM-DD'
  const servers = db.prepare("SELECT id FROM servers WHERE status != 'deleted'").all();
  for (const { id } of servers) {
    // Erwartete Samples: 24h * 60min / 0.5min = 2880
    const total = db.prepare(
      "SELECT COUNT(*) as n FROM server_stats_log WHERE server_id=? AND recorded_at >= ? AND recorded_at < datetime(?, '+1 day')"
    ).get(id, date + ' 00:00:00', date + ' 00:00:00');

    // Wie viele davon hatte der Server tatsächlich Stats (= war am Laufen)
    const present = total.n;

    // Auch Audit-Log checken: Starts/Stops zählen
    const starts = db.prepare(
      "SELECT COUNT(*) as n FROM audit_log WHERE target_id=? AND action='POWER_START' AND created_at >= ? AND created_at < datetime(?, '+1 day')"
    ).get(id, date + ' 00:00:00', date + ' 00:00:00').n;

    const stops = db.prepare(
      "SELECT COUNT(*) as n FROM audit_log WHERE target_id=? AND action IN ('POWER_STOP','POWER_KILL') AND created_at >= ? AND created_at < datetime(?, '+1 day')"
    ).get(id, date + ' 00:00:00', date + ' 00:00:00').n;

    let pct;
    if (present === 0) {
      // Keine Stats — wenn der Server nie gestartet wurde: 0%, wenn er ununterbrochen lief und schon vor dem Tag lief: 100%
      const wasRunningBefore = db.prepare(
        "SELECT status FROM servers WHERE id=?"
      ).get(id)?.status === 'running';
      // Prüfe ob Server den ganzen Tag über den Status 'running' hatte
      const lastStatusChange = db.prepare(
        "SELECT created_at, action FROM audit_log WHERE target_id=? AND action IN ('POWER_START','POWER_STOP','POWER_KILL') AND created_at < ? ORDER BY created_at DESC LIMIT 1"
      ).get(id, date + ' 00:00:00');
      const wasUp = lastStatusChange?.action === 'POWER_START';
      pct = wasUp ? 100 : (starts > 0 ? 50 : 0);
    } else {
      // Rough estimate: present stats / expected max
      const expectedMax = 2 * 24 * 2; // 2 samples/min * 24h * ~2 (generous)
      pct = Math.min(100, (present / Math.max(present, 24)) * 100);
      // Adjust by stops
      if (stops > 0 && starts === 0) pct = Math.min(pct, 75);
    }

    db.prepare(
      "INSERT OR REPLACE INTO status_uptime_log (server_id, date, up_pct) VALUES (?,?,?)"
    ).run(id, date, Math.round(pct * 10) / 10);
  }
  console.log(`[uptime] Snapshot für ${date} berechnet (${servers.length} Server)`);
}

function getUptimeHistory(serverId, days = 90) {
  const rows = db.prepare(
    "SELECT date, up_pct FROM status_uptime_log WHERE server_id=? ORDER BY date DESC LIMIT ?"
  ).all(serverId, days);

  // Fülle fehlende Tage auf
  const map = new Map(rows.map(r => [r.date, r.up_pct]));
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().split('T')[0];
    result.push({ date: key, up_pct: map.has(key) ? map.get(key) : null });
  }
  return result;
}

// Heute sofort berechnen falls noch kein Eintrag
function ensureTodaySnapshot() {
  const today = new Date().toISOString().split('T')[0];
  const exists = db.prepare("SELECT 1 FROM status_uptime_log WHERE date=? LIMIT 1").get(today);
  if (!exists) computeDailyUptime(today);
}

// Täglich 23:55 laufen lassen
function startUptimeScheduler() {
  ensureTodaySnapshot();
  const now = new Date();
  const next2355 = new Date(now);
  next2355.setHours(23, 55, 0, 0);
  if (next2355 <= now) next2355.setDate(next2355.getDate() + 1);
  const msUntil = next2355 - now;
  setTimeout(() => {
    const today = new Date().toISOString().split('T')[0];
    computeDailyUptime(today);
    setInterval(() => {
      const d = new Date().toISOString().split('T')[0];
      computeDailyUptime(d);
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
  console.log(`[uptime] Scheduler aktiv, nächster Snapshot in ${Math.round(msUntil/60000)}min`);
}

module.exports = { startUptimeScheduler, getUptimeHistory, computeDailyUptime };
