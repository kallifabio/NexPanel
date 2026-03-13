/**
 * scaling.js — NexPanel Auto-Scaling Engine
 *
 * Berechnet für jeden Node einen Score und wählt den optimalen
 * Node für neue Server anhand der konfigurierten Strategie.
 *
 * Strategien:
 *   least_loaded   — Node mit niedrigster Auslastung (RAM + Disk gewichtet)
 *   round_robin    — Nodes reihum, gleichmäßige Serveranzahl
 *   first_fit      — Erster Node mit genug freier Kapazität
 *   bin_packing    — Nodes so weit wie möglich füllen bevor nächster genutzt wird
 */

'use strict';

const { db }       = require('./db');
const { isConnected } = require('./daemon-hub');

// ─── STANDARD-KONFIGURATION ───────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  enabled:           1,
  strategy:          'least_loaded',  // least_loaded | round_robin | first_fit | bin_packing
  mem_threshold:     90,  // % — Node gilt als voll wenn alloc_mem/mem_limit > X%
  disk_threshold:    85,  // %
  cpu_threshold:     90,  // % (Overalloc-Faktor berücksichtigt)
  prefer_connected:  1,   // Verbundene Nodes bevorzugen
  allow_offline:     0,   // Offline-Nodes (nicht verbunden) trotzdem nutzen
};

// ─── CONFIG LADEN ─────────────────────────────────────────────────────────────
function getScalingConfig() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='scaling_config'").get();
    if (row) return { ...DEFAULT_CONFIG, ...JSON.parse(row.value) };
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

function saveScalingConfig(config) {
  const merged = { ...DEFAULT_CONFIG, ...config };
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('scaling_config', ?)")
    .run(JSON.stringify(merged));
  return merged;
}

// ─── NODE-KAPAZITÄTS-BERECHNUNG ───────────────────────────────────────────────
function getNodeCapacity(node) {
  const servers = db.prepare(
    "SELECT cpu_limit, memory_limit, disk_limit FROM servers WHERE node_id=? AND status != 'deleted'"
  ).all(node.id);

  const allocMem  = servers.reduce((s, r) => s + (parseInt(r.memory_limit) || 0), 0);
  const allocDisk = servers.reduce((s, r) => s + (parseInt(r.disk_limit)   || 0), 0);
  const allocCpu  = servers.reduce((s, r) => s + (parseFloat(r.cpu_limit)  || 0), 0);

  const limitMem  = node.memory_mb  || 4096;
  const limitDisk = node.disk_mb    || 51200;
  const cpuOveralloc = Math.max(1, node.cpu_overalloc || 1);

  // Letzte Live-Stats
  const stats = db.prepare(`
    SELECT AVG(sl.cpu) as avg_cpu, AVG(sl.memory_mb) as avg_mem
    FROM server_stats_log sl
    INNER JOIN (
      SELECT server_id, MAX(recorded_at) as max_at
      FROM server_stats_log GROUP BY server_id
    ) latest ON sl.server_id = latest.server_id AND sl.recorded_at = latest.max_at
    WHERE sl.server_id IN (SELECT id FROM servers WHERE node_id=? AND status='running')
  `).get(node.id);

  const sysInfo = node.system_info
    ? (() => { try { return JSON.parse(node.system_info); } catch { return {}; } })()
    : {};

  const memUsedPct  = Math.min(100, allocMem  / limitMem  * 100);
  const diskUsedPct = Math.min(100, allocDisk / limitDisk * 100);

  // Freie Ressourcen in absoluten Zahlen
  const freeMemMb  = Math.max(0, limitMem  - allocMem);
  const freeDiskMb = Math.max(0, limitDisk - allocDisk);
  const freeCpuCores = Math.max(0, cpuOveralloc - allocCpu);

  const connected = isConnected(node.id) || !!node.is_local;

  return {
    id:           node.id,
    name:         node.name,
    location:     node.location || '—',
    connected,
    is_local:     !!node.is_local,
    server_count: servers.length,
    running_count: db.prepare("SELECT COUNT(*) as c FROM servers WHERE node_id=? AND status='running'").get(node.id).c,

    alloc: {
      mem_mb:    allocMem,
      disk_mb:   allocDisk,
      cpu_cores: allocCpu,
    },
    limits: {
      mem_mb:       limitMem,
      disk_mb:      limitDisk,
      cpu_overalloc: cpuOveralloc,
    },
    free: {
      mem_mb:    freeMemMb,
      disk_mb:   freeDiskMb,
      cpu_cores: freeCpuCores,
    },
    pct: {
      mem:  Math.round(memUsedPct  * 10) / 10,
      disk: Math.round(diskUsedPct * 10) / 10,
    },
    live: {
      cpu_pct:    stats ? Math.round((stats.avg_cpu  || 0) * 10) / 10 : null,
      mem_mb:     stats ? Math.round(stats.avg_mem   || 0)            : null,
    },
    system: sysInfo,
  };
}

// ─── NODE-SCORE (0–100, höher = besser) ───────────────────────────────────────
function scoreNode(cap, required = {}) {
  const { mem_mb = 0, disk_mb = 0, cpu_cores = 0 } = required;

  // Disqualifizieren wenn nicht genug Kapazität
  if (cap.free.mem_mb  < mem_mb)  return -1;
  if (cap.free.disk_mb < disk_mb) return -1;
  if (cap.free.cpu_cores < cpu_cores) return -1;

  // Gewichteter Score: freie RAM und Disk am wichtigsten
  const memScore  = (cap.free.mem_mb  / Math.max(cap.limits.mem_mb,  1)) * 100;
  const diskScore = (cap.free.disk_mb / Math.max(cap.limits.disk_mb, 1)) * 100;
  const cpuScore  = cap.limits.cpu_overalloc > 0
    ? (cap.free.cpu_cores / cap.limits.cpu_overalloc) * 100 : 50;

  // Gewichtung: RAM 50%, Disk 30%, CPU 20%
  const raw = memScore * 0.5 + diskScore * 0.3 + cpuScore * 0.2;

  return Math.round(raw * 10) / 10;
}

// ─── BEST NODE AUSWÄHLEN ──────────────────────────────────────────────────────
/**
 * Gibt die ID des besten Nodes zurück.
 * @param {object} required  - { mem_mb, disk_mb, cpu_cores } — Mindestanforderungen
 * @param {string} [forceStrategy] - Strategie überschreiben
 * @returns {{ node_id: string, reason: string, scores: array } | null}
 */
function getBestNode(required = {}, forceStrategy) {
  const config   = getScalingConfig();
  if (!config.enabled) return null;  // Auto-Scaling deaktiviert → caller nutzt is_default

  const strategy = forceStrategy || config.strategy;

  // Alle Nodes laden
  const nodes = db.prepare('SELECT * FROM nodes').all();
  if (!nodes.length) return null;

  // Kapazitäten berechnen
  let candidates = nodes
    .map(n => ({ node: n, cap: getNodeCapacity(n) }))
    .filter(({ cap }) => {
      // Verbindungsfilter
      if (config.prefer_connected && !config.allow_offline && !cap.connected) return false;
      // Threshold-Filter
      if (cap.pct.mem  >= config.mem_threshold)  return false;
      if (cap.pct.disk >= config.disk_threshold) return false;
      return true;
    });

  if (!candidates.length) return null;

  // Score berechnen
  candidates = candidates
    .map(c => ({ ...c, score: scoreNode(c.cap, required) }))
    .filter(c => c.score >= 0);  // -1 = nicht genug Kapazität

  if (!candidates.length) return null;

  let chosen;
  let reason;

  switch (strategy) {
    case 'least_loaded':
      // Höchster freier-Ressourcen-Score
      candidates.sort((a, b) => b.score - a.score);
      chosen = candidates[0];
      reason = `Niedrigste Auslastung (Score ${chosen.score})`;
      break;

    case 'round_robin':
      // Node mit wenigsten Servern
      candidates.sort((a, b) => a.cap.server_count - b.cap.server_count);
      chosen = candidates[0];
      reason = `Round Robin (${chosen.cap.server_count} Server)`;
      break;

    case 'first_fit':
      // Erster Node mit genug Kapazität (sortiert nach is_default, dann created_at)
      {
        const defaultNode = candidates.find(c => c.node.is_default);
        chosen = defaultNode || candidates[0];
        reason = 'First Fit';
      }
      break;

    case 'bin_packing':
      // Node mit wenigsten freien Ressourcen (möglichst voll machen)
      candidates.sort((a, b) => a.score - b.score);
      chosen = candidates[0];
      reason = `Bin Packing (Score ${chosen.score})`;
      break;

    default:
      candidates.sort((a, b) => b.score - a.score);
      chosen = candidates[0];
      reason = 'Standard (Least Loaded)';
  }

  return {
    node_id: chosen.cap.id,
    node_name: chosen.cap.name,
    reason,
    scores: candidates.map(c => ({
      node_id:   c.cap.id,
      node_name: c.cap.name,
      score:     c.score,
      pct:       c.cap.pct,
      free:      c.cap.free,
      connected: c.cap.connected,
      server_count: c.cap.server_count,
    })),
  };
}

// ─── ALLE NODE-KAPAZITÄTEN (für Admin-Dashboard) ─────────────────────────────
function getAllNodeCapacities(required = {}) {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  const config = getScalingConfig();
  return nodes.map(n => {
    const cap   = getNodeCapacity(n);
    const score = scoreNode(cap, required);
    const wouldBeChosen = score >= 0
      && cap.pct.mem  < config.mem_threshold
      && cap.pct.disk < config.disk_threshold;
    return { ...cap, score, eligible: wouldBeChosen };
  });
}

module.exports = { getBestNode, getAllNodeCapacities, getNodeCapacity, getScalingConfig, saveScalingConfig, scoreNode };
