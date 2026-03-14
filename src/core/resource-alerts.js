/**
 * resource-alerts.js — NexPanel Resource Alert Engine
 *
 * Wird von stats-collector.js nach jedem persistStats()-Aufruf aufgerufen.
 * Prüft CPU & RAM gegen konfigurierte Schwellenwerte (warn / critical).
 * Disk-Alerts laufen weiterhin über resource-limits.js.
 *
 * Cooldown: Pro Server+Metrik+Schwere wird last_fired in der DB gespeichert.
 * Innerhalb des Cooldown-Fensters werden keine weiteren Alerts gefeuert.
 */

'use strict';

const { db }      = require('./db');
const { notify }  = require('./notifications');

// ─── EVENT-KONSTANTEN ─────────────────────────────────────────────────────────
// Neue Events werden auch in notifications.js eingetragen
const ALERT_EVENTS = {
  cpu_warn:  { color: 0xfbbf24, emoji: '🟡', label: 'CPU-Warnung' },
  cpu_crit:  { color: 0xef4444, emoji: '🔴', label: 'CPU Kritisch' },
  ram_warn:  { color: 0xfbbf24, emoji: '🟡', label: 'RAM-Warnung' },
  ram_crit:  { color: 0xef4444, emoji: '🔴', label: 'RAM Kritisch' },
  disk_warn: { color: 0xfbbf24, emoji: '🟡', label: 'Disk-Warnung' },
  disk_crit: { color: 0xef4444, emoji: '🔴', label: 'Disk Kritisch' },
};

// ─── STANDARD-REGEL für neuen Server ─────────────────────────────────────────
const DEFAULT_RULE = {
  enabled: 1,
  cpu_warn: 80, cpu_crit: 95,
  ram_warn: 80, ram_crit: 95,
  disk_warn: 75, disk_crit: 90,
  cooldown_minutes: 30,
  last_fired: '{}',
};

// ─── REGEL LADEN / ANLEGEN ────────────────────────────────────────────────────
function getOrCreateRule(serverId) {
  let rule = db.prepare('SELECT * FROM resource_alert_rules WHERE server_id=?').get(serverId);
  if (!rule) {
    db.prepare(`
      INSERT OR IGNORE INTO resource_alert_rules
        (server_id, enabled, cpu_warn, cpu_crit, ram_warn, ram_crit, disk_warn, disk_crit, cooldown_minutes, last_fired)
      VALUES (?,1,80,95,80,95,75,90,30,'{}')
    `).run(serverId);
    rule = db.prepare('SELECT * FROM resource_alert_rules WHERE server_id=?').get(serverId);
  }
  return rule;
}

function saveRule(serverId, fields) {
  const existing = db.prepare('SELECT server_id FROM resource_alert_rules WHERE server_id=?').get(serverId);
  if (!existing) {
    db.prepare(`
      INSERT INTO resource_alert_rules
        (server_id, enabled, cpu_warn, cpu_crit, ram_warn, ram_crit, disk_warn, disk_crit, cooldown_minutes, last_fired)
      VALUES (?,?,?,?,?,?,?,?,?,'{}')
    `).run(
      serverId,
      fields.enabled       ?? 1,
      fields.cpu_warn      ?? 80,
      fields.cpu_crit      ?? 95,
      fields.ram_warn      ?? 80,
      fields.ram_crit      ?? 95,
      fields.disk_warn     ?? 75,
      fields.disk_crit     ?? 90,
      fields.cooldown_minutes ?? 30,
    );
  } else {
    const allowed = ['enabled','cpu_warn','cpu_crit','ram_warn','ram_crit','disk_warn','disk_crit','cooldown_minutes'];
    const sets = allowed.filter(k => fields[k] !== undefined).map(k => `${k}=?`).join(',');
    const vals = allowed.filter(k => fields[k] !== undefined).map(k => fields[k]);
    if (sets) {
      db.prepare(`UPDATE resource_alert_rules SET ${sets} WHERE server_id=?`).run(...vals, serverId);
    }
  }
}

// ─── COOLDOWN-CHECK ───────────────────────────────────────────────────────────
function isCooledDown(lastFiredMap, key, cooldownMinutes) {
  const lastStr = lastFiredMap[key];
  if (!lastStr) return true;
  const diffMs = Date.now() - new Date(lastStr).getTime();
  return diffMs >= cooldownMinutes * 60 * 1000;
}

function markFired(serverId, lastFiredMap, key) {
  lastFiredMap[key] = new Date().toISOString();
  db.prepare("UPDATE resource_alert_rules SET last_fired=? WHERE server_id=?")
    .run(JSON.stringify(lastFiredMap), serverId);
}

// ─── HAUPT-CHECK (wird nach jedem Stats-Sample aufgerufen) ────────────────────
async function checkResourceAlerts(serverId, stats) {
  // stats: { cpu, memory_mb, memory_limit_mb, ... }
  try {
    const rule = db.prepare('SELECT * FROM resource_alert_rules WHERE server_id=?').get(serverId);
    if (!rule || !rule.enabled) return;

    const server = db.prepare('SELECT name, memory_limit FROM servers WHERE id=?').get(serverId);
    if (!server) return;

    let lastFired = {};
    try { lastFired = JSON.parse(rule.last_fired || '{}'); } catch {}

    const cooldown = rule.cooldown_minutes || 30;

    // RAM-Prozent berechnen
    const ramLimit = stats.memory_limit_mb || server.memory_limit || 0;
    const ramPct   = ramLimit > 0 ? Math.round(stats.memory_mb / ramLimit * 100) : 0;
    const cpuPct   = Math.round(stats.cpu || 0);

    const checks = [
      // [key, value, threshold, event, metricLabel, valueStr, limitStr]
      ['cpu_crit', cpuPct, rule.cpu_crit, 'cpu_crit',
        'CPU', `${cpuPct}%`, `Limit: ${rule.cpu_crit}%`],
      ['cpu_warn', cpuPct, rule.cpu_warn, 'cpu_warn',
        'CPU', `${cpuPct}%`, `Schwelle: ${rule.cpu_warn}%`],
      ['ram_crit', ramPct, rule.ram_crit, 'ram_crit',
        'RAM', `${ramPct}% (${fmtMb(stats.memory_mb)})`, `Limit: ${fmtMb(ramLimit)}`],
      ['ram_warn', ramPct, rule.ram_warn, 'ram_warn',
        'RAM', `${ramPct}% (${fmtMb(stats.memory_mb)})`, `Schwelle: ${rule.ram_warn}%`],
    ];

    for (const [key, value, threshold, event, metric, valueStr, limitStr] of checks) {
      if (!threshold || value < threshold) continue;
      if (!isCooledDown(lastFired, key, cooldown)) continue;

      // Für warn: nicht feuern wenn crit bereits aktiv (crit hat Vorrang)
      if (key.endsWith('_warn')) {
        const critKey = key.replace('_warn', '_crit');
        const critThresh = rule[critKey];
        if (critThresh && value >= critThresh) continue; // crit übernimmt
      }

      const info = ALERT_EVENTS[event];
      const msg  = `${info.emoji} **${server.name}** — ${metric} bei ${valueStr}`;
      const extra = {
        Server: server.name,
        [metric]: valueStr,
        Schwellenwert: limitStr,
        Cooldown: `${cooldown} min`,
      };

      // Für notify() brauchen wir den Event-Namen in notification_settings
      // Wir nutzen den bestehenden Dispatch und erweitern EVENT_COLORS/EMOJIS in notifications.js
      await notify(serverId, event, msg, extra);
      markFired(serverId, lastFired, key);

      console.log(`[alerts] ${event} ausgelöst für "${server.name}": ${valueStr}`);
    }
  } catch (e) {
    // Darf niemals crashen
    console.warn('[alerts] checkResourceAlerts Fehler:', e.message);
  }
}

function fmtMb(mb) {
  if (!mb) return '0 MB';
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return Math.round(mb) + ' MB';
}

module.exports = { checkResourceAlerts, getOrCreateRule, saveRule, DEFAULT_RULE };
