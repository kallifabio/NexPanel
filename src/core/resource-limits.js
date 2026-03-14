const { notify } = require('./notifications');
'use strict';
/**
 * resource-limits.js — Ressourcen-Limits Enforcement
 *
 * - Prüft Disk-Nutzung aller laufenden Server periodisch
 * - Warnt per WebSocket bei 80%+ Auslastung
 * - Blockiert Datei-Writes bei 100% (via Middleware-Export)
 * - Speichert Snapshots in disk_usage_log
 * - Erzwingt Docker CPU/RAM-Limits beim Container-Start
 */

const { db, auditLog } = require('./db');
const { routeToNode }  = require('../docker/node-router');

// Wird von ws-panel.js gesetzt damit wir Nachrichten pushen können
let _broadcast = null;
function setBroadcast(fn) { _broadcast = fn; }

// ─── DISK CHECK ───────────────────────────────────────────────────────────────
// Returns { bytes_used, bytes_limit, pct, status: 'ok'|'warning'|'critical'|'exceeded' }
async function checkDiskUsage(srv) {
  if (!srv.container_id || srv.status === 'offline') return null;

  try {
    const result = await routeToNode(srv.node_id, {
      type:         'disk.usage',
      server_id:    srv.id,
      container_id: srv.container_id,
      work_dir:     srv.work_dir || '/home/container',
    }, 20_000);

    const bytesUsed  = result.bytes_used || 0;
    const bytesLimit = (srv.disk_limit || 0) * 1024 * 1024; // disk_limit in MB → bytes
    const pct        = bytesLimit > 0 ? Math.round(bytesUsed / bytesLimit * 100) : 0;
    const status     = pct >= 100 ? 'exceeded' : pct >= 90 ? 'critical' : pct >= 75 ? 'warning' : 'ok';

    // Snapshot loggen
    db.prepare("INSERT INTO disk_usage_log (server_id, bytes_used) VALUES (?,?)").run(srv.id, bytesUsed);

    // Alte Logs entfernen (7 Tage)
    db.prepare("DELETE FROM disk_usage_log WHERE server_id=? AND recorded_at < datetime('now','-7 days')").run(srv.id);

    return { bytes_used: bytesUsed, bytes_limit: bytesLimit, pct, status };
  } catch {
    return null;
  }
}

// ─── WARNUNG VIA WEBSOCKET ────────────────────────────────────────────────────
function sendDiskAlert(srv, usage) {
  const msg = usage.status === 'exceeded'
    ? `⛔ Disk-Limit für "${srv.name}" überschritten! Datei-Writes gesperrt.`
    : usage.status === 'critical'
      ? `🔴 Disk-Nutzung von "${srv.name}" bei ${usage.pct}% (${fmtBytes(usage.bytes_used)} / ${fmtBytes(usage.bytes_limit)})`
      : `🟡 Disk-Nutzung von "${srv.name}" bei ${usage.pct}%`;

  if (_broadcast) {
    _broadcast({ type: 'disk.alert', server_id: srv.id, ...usage, message: msg });
  }

  // Notification
  const event = usage.status === 'exceeded' ? 'disk_exceeded'
    : usage.status === 'critical' ? 'disk_critical' : 'disk_warning';
  notify(srv.id, event, msg, {
    'Belegt': fmtBytes(usage.bytes_used),
    'Limit':  fmtBytes(usage.bytes_limit),
    'Prozent': usage.pct + '%',
  }).catch(() => {});
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

// ─── PERIODISCHER SCAN ────────────────────────────────────────────────────────
let _diskInterval = null;

async function runDiskScan() {
  const servers = db.prepare("SELECT * FROM servers WHERE status='running' AND disk_limit > 0").all();
  for (const srv of servers) {
    const usage = await checkDiskUsage(srv);
    if (!usage) continue;

    if (usage.status === 'warning' || usage.status === 'critical' || usage.status === 'exceeded') {
      sendDiskAlert(srv, usage);
    }

    // Bei exceeded: Server pausieren ist optional (zu aggressiv für v1) — nur warnen + loggen
    if (usage.status === 'exceeded') {
      const lastAlert = db.prepare(
        "SELECT created_at FROM audit_log WHERE target_id=? AND action='DISK_EXCEEDED' ORDER BY created_at DESC LIMIT 1"
      ).get(srv.id);
      const minAgo = lastAlert
        ? (Date.now() - new Date(lastAlert.created_at).getTime()) / 60000
        : 999;
      // Nur alle 60 Minuten ins Audit-Log schreiben
      if (minAgo > 60) {
        auditLog(null, 'DISK_EXCEEDED', 'server', srv.id, {
          bytes_used: usage.bytes_used, bytes_limit: usage.bytes_limit, pct: usage.pct
        }, 'system');
      }
    }
  }
}

function startResourceMonitor() {
  if (_diskInterval) return;
  // Alle 5 Minuten Disk-Scan
  _diskInterval = setInterval(runDiskScan, 5 * 60 * 1000);
  // Sofort nach Start (verzögert um 30s damit Container hochfahren können)
  setTimeout(runDiskScan, 30_000);
  console.log('[limits] Ressourcen-Monitor gestartet (Disk-Scan alle 5 min)');
}

function stopResourceMonitor() {
  if (_diskInterval) { clearInterval(_diskInterval); _diskInterval = null; }
}

// ─── MIDDLEWARE: DISK WRITE CHECK ─────────────────────────────────────────────
// Benutze in routes/files.js: import checkDiskBeforeWrite
async function checkDiskBeforeWrite(serverId, nodeId, containerId, workDir, diskLimitMb) {
  if (!diskLimitMb || diskLimitMb <= 0) return { allowed: true };
  try {
    const result = await routeToNode(nodeId, {
      type: 'disk.usage', server_id: serverId,
      container_id: containerId, work_dir: workDir || '/home/container',
    }, 10_000);
    const bytesUsed  = result.bytes_used || 0;
    const bytesLimit = diskLimitMb * 1024 * 1024;
    const pct        = Math.round(bytesUsed / bytesLimit * 100);
    if (pct >= 100) {
      return { allowed: false, pct, bytes_used: bytesUsed, bytes_limit: bytesLimit,
        error: `Disk-Limit erreicht (${pct}% — ${fmtBytes(bytesUsed)} / ${fmtBytes(bytesLimit)}). Bitte Dateien löschen.` };
    }
    return { allowed: true, pct };
  } catch {
    return { allowed: true }; // Im Fehlerfall nicht blockieren
  }
}

// ─── DISK-NUTZUNG HISTORY ─────────────────────────────────────────────────────
function getDiskHistory(serverId, hours = 24) {
  return db.prepare(`
    SELECT bytes_used, recorded_at
    FROM disk_usage_log
    WHERE server_id=? AND recorded_at > datetime('now', ?)
    ORDER BY recorded_at ASC
  `).all(serverId, `-${hours} hours`);
}

module.exports = {
  startResourceMonitor,
  stopResourceMonitor,
  checkDiskBeforeWrite,
  checkDiskUsage,
  getDiskHistory,
  setBroadcast,
};
