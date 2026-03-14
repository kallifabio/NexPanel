/**
 * routes/metrics.js — Prometheus Metrics Export
 *
 * GET  /metrics              — Prometheus text format (Bearer Token oder ?token=)
 * GET  /api/admin/metrics/token    — aktuelles Token anzeigen
 * POST /api/admin/metrics/token    — neues Token generieren
 * DELETE /api/admin/metrics/token  — Token deaktivieren
 * GET  /api/admin/metrics/config   — scrape config + Grafana dashboard JSON
 *
 * Auth: Bearer <token> im Authorization-Header ODER ?token=<token> in URL
 * Token wird als SHA256-Hash in der settings-Tabelle gespeichert.
 *
 * Exportierte Metriken:
 *   nexpanel_server_status{id,name,node}           0/1  (running=1)
 *   nexpanel_server_cpu_percent{id,name,node}       aktuelle CPU-Nutzung
 *   nexpanel_server_memory_mb{id,name,node}         RAM belegt in MB
 *   nexpanel_server_memory_limit_mb{id,name,node}   RAM-Limit in MB
 *   nexpanel_server_memory_percent{id,name,node}    RAM % (0-100)
 *   nexpanel_server_disk_limit_mb{id,name,node}     Disk-Limit in MB
 *   nexpanel_server_network_rx_bytes{id,name,node}  Netz RX seit Start
 *   nexpanel_server_network_tx_bytes{id,name,node}  Netz TX seit Start
 *   nexpanel_server_pids{id,name,node}              Prozesse im Container
 *   nexpanel_node_server_count{node_id,node_name}   Server pro Node
 *   nexpanel_node_running_count{node_id,node_name}  Laufende Server pro Node
 *   nexpanel_info{version,uptime_seconds}           Panel-Info
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const { db }  = require('../src/core/db');
const { authenticate, requireAdmin } = require('./auth');

const router  = express.Router();
const START_TIME = Date.now();

// ─── Token-Helpers ────────────────────────────────────────────────────────────
const TOKEN_SETTINGS_KEY = 'prometheus_token_hash';
const TOKEN_PREVIEW_KEY  = 'prometheus_token_preview'; // erste 12 Zeichen

function getTokenHash() {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(TOKEN_SETTINGS_KEY);
  return row?.value || null;
}

function getTokenPreview() {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(TOKEN_PREVIEW_KEY);
  return row?.value || null;
}

function validateToken(raw) {
  const stored = getTokenHash();
  if (!stored || !raw) return false;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return hash === stored;
}

function generateToken() {
  const token   = 'npm_' + crypto.randomBytes(28).toString('hex'); // 60-char prefix npm_ like real tokens
  const hash    = crypto.createHash('sha256').update(token).digest('hex');
  const preview = token.substring(0, 12) + '…';
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(TOKEN_SETTINGS_KEY, hash);
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(TOKEN_PREVIEW_KEY, preview);
  return { token, preview };
}

function deleteToken() {
  db.prepare("DELETE FROM settings WHERE key IN (?,?)").run(TOKEN_SETTINGS_KEY, TOKEN_PREVIEW_KEY);
}

// ─── Prometheus Label escaping ─────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labels(obj) {
  return '{' + Object.entries(obj).map(([k, v]) => `${k}="${esc(v)}"`).join(',') + '}';
}

function metric(name, help, type, lines) {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${lines.join('\n')}\n`;
}

// ─── Neueste Stats pro Server aus DB ──────────────────────────────────────────
function getLatestStats() {
  // Neuester Eintrag pro server_id (SQLite window function not always available → subquery)
  return db.prepare(`
    SELECT l.server_id, l.cpu, l.memory_mb, l.memory_limit_mb,
           l.network_rx, l.network_tx, l.pids
    FROM server_stats_log l
    INNER JOIN (
      SELECT server_id, MAX(recorded_at) AS max_at
      FROM server_stats_log
      GROUP BY server_id
    ) latest ON l.server_id = latest.server_id AND l.recorded_at = latest.max_at
  `).all();
}

// ─── /metrics ─────────────────────────────────────────────────────────────────
router.get('/metrics', (req, res) => {
  // Auth: Bearer token oder ?token=
  const authHeader = req.headers.authorization || '';
  const rawToken   = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim()
    : (req.query.token || '');

  if (!validateToken(rawToken)) {
    res.set('WWW-Authenticate', 'Bearer realm="NexPanel Metrics"');
    return res.status(401).send('# Unauthorized — Bearer token erforderlich\n');
  }

  try {
    const servers   = db.prepare('SELECT id, name, node_id, status, memory_limit, disk_limit FROM servers').all();
    const nodes     = db.prepare('SELECT id, name FROM nodes').all();
    const statsMap  = {};
    for (const s of getLatestStats()) statsMap[s.server_id] = s;

    // Node-Name lookup
    const nodeNames = {};
    for (const n of nodes) nodeNames[n.id] = n.name;

    const output = [];
    const now    = Math.floor(Date.now() / 1000);

    // ── nexpanel_info ──────────────────────────────────────────────────────
    const uptimeSec = Math.floor((Date.now() - START_TIME) / 1000);
    output.push(metric('nexpanel_info',
      'NexPanel instance information', 'gauge',
      [`nexpanel_info{version="3.0",uptime_seconds="${uptimeSec}"} 1`]
    ));

    // ── nexpanel_server_status ─────────────────────────────────────────────
    output.push(metric('nexpanel_server_status',
      'Server running status (1=running, 0=stopped/other)', 'gauge',
      servers.map(s => {
        const lbl = labels({ id: s.id, name: s.name, node: nodeNames[s.node_id] || s.node_id || 'local' });
        return `nexpanel_server_status${lbl} ${s.status === 'running' ? 1 : 0}`;
      })
    ));

    // ── CPU ────────────────────────────────────────────────────────────────
    output.push(metric('nexpanel_server_cpu_percent',
      'Server CPU usage in percent', 'gauge',
      servers.map(s => {
        const st  = statsMap[s.id];
        const lbl = labels({ id: s.id, name: s.name, node: nodeNames[s.node_id] || s.node_id || 'local' });
        return `nexpanel_server_cpu_percent${lbl} ${st ? st.cpu.toFixed(2) : 0}`;
      })
    ));

    // ── RAM ────────────────────────────────────────────────────────────────
    output.push(metric('nexpanel_server_memory_mb',
      'Server memory usage in megabytes', 'gauge',
      servers.map(s => {
        const st  = statsMap[s.id];
        const lbl = labels({ id: s.id, name: s.name, node: nodeNames[s.node_id] || s.node_id || 'local' });
        return `nexpanel_server_memory_mb${lbl} ${st ? st.memory_mb.toFixed(1) : 0}`;
      })
    ));

    output.push(metric('nexpanel_server_memory_limit_mb',
      'Server memory limit in megabytes', 'gauge',
      servers.map(s => {
        const st  = statsMap[s.id];
        const lbl = labels({ id: s.id, name: s.name, node: nodeNames[s.node_id] || s.node_id || 'local' });
        const lim = st?.memory_limit_mb || s.memory_limit || 0;
        return `nexpanel_server_memory_limit_mb${lbl} ${lim}`;
      })
    ));

    output.push(metric('nexpanel_server_memory_percent',
      'Server memory usage in percent of limit', 'gauge',
      servers.map(s => {
        const st  = statsMap[s.id];
        const lbl = labels({ id: s.id, name: s.name, node: nodeNames[s.node_id] || s.node_id || 'local' });
        const used = st?.memory_mb || 0;
        const lim  = st?.memory_limit_mb || s.memory_limit || 0;
        const pct  = lim > 0 ? (used / lim * 100).toFixed(1) : 0;
        return `nexpanel_server_memory_percent${lbl} ${pct}`;
      })
    ));

    // ── Disk Limit ─────────────────────────────────────────────────────────
    output.push(metric('nexpanel_server_disk_limit_mb',
      'Server disk limit in megabytes', 'gauge',
      servers.map(s => {
        const lbl = labels({ id: s.id, name: s.name, node: nodeNames[s.node_id] || s.node_id || 'local' });
        return `nexpanel_server_disk_limit_mb${lbl} ${s.disk_limit || 0}`;
      })
    ));

    // ── Network ────────────────────────────────────────────────────────────
    output.push(metric('nexpanel_server_network_rx_bytes',
      'Server network received bytes (cumulative since container start)', 'counter',
      servers.map(s => {
        const st  = statsMap[s.id];
        const lbl = labels({ id: s.id, name: s.name, node: nodeNames[s.node_id] || s.node_id || 'local' });
        return `nexpanel_server_network_rx_bytes${lbl} ${st?.network_rx || 0}`;
      })
    ));

    output.push(metric('nexpanel_server_network_tx_bytes',
      'Server network transmitted bytes (cumulative since container start)', 'counter',
      servers.map(s => {
        const st  = statsMap[s.id];
        const lbl = labels({ id: s.id, name: s.name, node: nodeNames[s.node_id] || s.node_id || 'local' });
        return `nexpanel_server_network_tx_bytes${lbl} ${st?.network_tx || 0}`;
      })
    ));

    // ── PIDs ───────────────────────────────────────────────────────────────
    output.push(metric('nexpanel_server_pids',
      'Number of processes in server container', 'gauge',
      servers.map(s => {
        const st  = statsMap[s.id];
        const lbl = labels({ id: s.id, name: s.name, node: nodeNames[s.node_id] || s.node_id || 'local' });
        return `nexpanel_server_pids${lbl} ${st?.pids || 0}`;
      })
    ));

    // ── Per-Node Aggregates ────────────────────────────────────────────────
    const nodeServerCount  = {};
    const nodeRunningCount = {};
    for (const s of servers) {
      const nid = s.node_id || 'local';
      nodeServerCount[nid]  = (nodeServerCount[nid]  || 0) + 1;
      if (s.status === 'running') nodeRunningCount[nid] = (nodeRunningCount[nid] || 0) + 1;
    }

    output.push(metric('nexpanel_node_server_count',
      'Total servers per node', 'gauge',
      Object.entries(nodeServerCount).map(([nid, cnt]) => {
        const lbl = labels({ node_id: nid, node_name: nodeNames[nid] || nid });
        return `nexpanel_node_server_count${lbl} ${cnt}`;
      })
    ));

    output.push(metric('nexpanel_node_running_count',
      'Running servers per node', 'gauge',
      Object.entries(nodeServerCount).map(([nid]) => {
        const lbl = labels({ node_id: nid, node_name: nodeNames[nid] || nid });
        return `nexpanel_node_running_count${lbl} ${nodeRunningCount[nid] || 0}`;
      })
    ));

    // ── Totals ─────────────────────────────────────────────────────────────
    const totalServers  = servers.length;
    const totalRunning  = servers.filter(s => s.status === 'running').length;
    const totalUsers    = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
    const totalNodes    = nodes.length;

    output.push(metric('nexpanel_total_servers',  'Total number of servers',       'gauge', [`nexpanel_total_servers ${totalServers}`]));
    output.push(metric('nexpanel_running_servers', 'Number of running servers',     'gauge', [`nexpanel_running_servers ${totalRunning}`]));
    output.push(metric('nexpanel_total_users',     'Total number of users',         'gauge', [`nexpanel_total_users ${totalUsers}`]));
    output.push(metric('nexpanel_total_nodes',     'Total number of registered nodes', 'gauge', [`nexpanel_total_nodes ${totalNodes}`]));

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(output.join('\n'));
  } catch (e) {
    console.error('[metrics] Fehler:', e.message);
    res.status(500).send(`# ERROR: ${e.message}\n`);
  }
});

// ─── Admin: Token lesen ────────────────────────────────────────────────────────
router.get('/token', authenticate, requireAdmin, (req, res) => {
  res.json({
    configured: !!getTokenHash(),
    preview:    getTokenPreview(),
  });
});

// ─── Admin: Token generieren ──────────────────────────────────────────────────
router.post('/token', authenticate, requireAdmin, (req, res) => {
  const { token, preview } = generateToken();
  res.json({ token, preview, note: 'Token wird nur einmal angezeigt — bitte sofort kopieren!' });
});

// ─── Admin: Token löschen ─────────────────────────────────────────────────────
router.delete('/token', authenticate, requireAdmin, (req, res) => {
  deleteToken();
  res.json({ success: true });
});

// ─── Admin: Scrape-Konfiguration + Grafana Dashboard JSON ────────────────────
router.get('/config', authenticate, requireAdmin, (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host  = req.headers['x-forwarded-host']  || req.headers.host || 'localhost:3000';
  const base  = `${proto}://${host}`;

  const scrapeConfig = `# prometheus.yml — Job für NexPanel hinzufügen:
scrape_configs:
  - job_name: 'nexpanel'
    scrape_interval: 30s
    static_configs:
      - targets: ['${host}']
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: <DEIN_TOKEN>`;

  // Minimal but useful Grafana dashboard JSON
  const dashboard = buildGrafanaDashboard(base);

  res.json({ scrape_config: scrapeConfig, base_url: base, dashboard_json: dashboard });
});

// ─── Grafana Dashboard Builder ────────────────────────────────────────────────
function buildGrafanaDashboard(baseUrl) {
  const makePanel = (id, title, expr, unit, x, y, w = 12, h = 8) => ({
    id,
    title,
    type: 'timeseries',
    gridPos: { x, y, w, h },
    datasource: { type: 'prometheus', uid: '${DS_PROMETHEUS}' },
    fieldConfig: {
      defaults: { unit, custom: { lineWidth: 2, fillOpacity: 8 } },
      overrides: [],
    },
    options: { tooltip: { mode: 'multi' }, legend: { displayMode: 'table', placement: 'bottom' } },
    targets: [{ expr, legendFormat: '{{name}}', refId: 'A', datasource: { type: 'prometheus', uid: '${DS_PROMETHEUS}' } }],
  });

  const makeStat = (id, title, expr, unit, x, y, w = 6, h = 4) => ({
    id,
    title,
    type: 'stat',
    gridPos: { x, y, w, h },
    datasource: { type: 'prometheus', uid: '${DS_PROMETHEUS}' },
    fieldConfig: { defaults: { unit, thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'yellow', value: 50 }, { color: 'red', value: 90 }] } } },
    options: { reduceOptions: { calcs: ['lastNotNull'] }, orientation: 'auto', textMode: 'auto', colorMode: 'background' },
    targets: [{ expr, refId: 'A', datasource: { type: 'prometheus', uid: '${DS_PROMETHEUS}' } }],
  });

  return {
    __inputs: [{ name: 'DS_PROMETHEUS', label: 'Prometheus', description: '', type: 'datasource', pluginId: 'prometheus', pluginName: 'Prometheus' }],
    __requires: [{ type: 'datasource', id: 'prometheus', name: 'Prometheus', version: '1.0.0' }],
    title: 'NexPanel Overview',
    uid: 'nexpanel-overview',
    schemaVersion: 38,
    version: 1,
    refresh: '30s',
    time: { from: 'now-1h', to: 'now' },
    tags: ['nexpanel'],
    panels: [
      makeStat(1,  'Server gesamt',    'nexpanel_total_servers',            'short', 0,  0),
      makeStat(2,  'Laufend',          'nexpanel_running_servers',          'short', 6,  0),
      makeStat(3,  'Benutzer',         'nexpanel_total_users',              'short', 12, 0),
      makeStat(4,  'Nodes',            'nexpanel_total_nodes',              'short', 18, 0),
      makePanel(10, 'CPU % pro Server', 'nexpanel_server_cpu_percent',      'percent', 0, 4),
      makePanel(11, 'RAM MB pro Server','nexpanel_server_memory_mb',        'decmbytes', 12, 4),
      makePanel(12, 'RAM % pro Server', 'nexpanel_server_memory_percent',   'percent', 0, 12),
      makePanel(13, 'PIDs pro Server',  'nexpanel_server_pids',             'short', 12, 12),
      makePanel(14, 'Netz RX Bytes',    'rate(nexpanel_server_network_rx_bytes[2m])', 'Bps', 0, 20),
      makePanel(15, 'Netz TX Bytes',    'rate(nexpanel_server_network_tx_bytes[2m])', 'Bps', 12, 20),
      {
        id: 20, title: 'Server Status', type: 'table',
        gridPos: { x: 0, y: 28, w: 24, h: 8 },
        datasource: { type: 'prometheus', uid: '${DS_PROMETHEUS}' },
        fieldConfig: {
          defaults: {},
          overrides: [{ matcher: { id: 'byName', options: 'Value' }, properties: [{ id: 'custom.displayMode', value: 'color-background' }, { id: 'thresholds', value: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'green', value: 1 }] } }] }],
        },
        options: { sortBy: [{ displayName: 'name', desc: false }] },
        targets: [{ expr: 'nexpanel_server_status', instant: true, legendFormat: '', refId: 'A', datasource: { type: 'prometheus', uid: '${DS_PROMETHEUS}' } }],
        transformations: [{ id: 'labelsToFields', options: { mode: 'columns' } }, { id: 'organize', options: { renameByName: { name: 'Server', node: 'Node', Value: 'Status' } } }],
      },
    ],
  };
}

module.exports = router;
