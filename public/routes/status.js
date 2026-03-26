'use strict';
/**
 * routes/status.js — Öffentliche Status-Page (v2)
 *
 * PUBLIC:  GET /status   GET /status/embed   GET /status/feed.rss
 *          GET /api/status   GET /api/status/feed
 *          POST /api/status/subscribe   GET /api/status/unsubscribe
 * ADMIN:   /api/admin/status-settings  /api/admin/incidents  /api/admin/status-uptime
 */

const express = require('express');
const net     = require('net');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../src/core/db');
const { authenticate, requireAdmin } = require('./auth');
const { getUptimeHistory } = require('../src/core/status-uptime');

const router = express.Router();

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
function getSetting(key, def='') {
  try { return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? def; }
  catch { return def; }
}
function setSetting(key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
function getSettings() {
  return {
    enabled:         getSetting('status_page_enabled',   '1') === '1',
    show_all:        getSetting('status_page_show_all',  '1') === '1',
    title:           getSetting('status_page_title',     'NexPanel Status'),
    description:     getSetting('status_page_desc',      'Echtzeit-Status aller Dienste'),
    logo_url:        getSetting('status_page_logo',      ''),
    accent_color:    getSetting('status_page_accent',    '#00d4ff'),
    favicon_url:     getSetting('status_page_favicon',   ''),
    show_cpu:        getSetting('status_page_show_cpu',  '1') === '1',
    show_ram:        getSetting('status_page_show_ram',  '1') === '1',
    show_uptime:     getSetting('status_page_uptime',    '1') === '1',
    show_groups:     getSetting('status_page_groups',    '1') === '1',
    allow_subscribe: getSetting('status_page_subscribe', '1') === '1',
  };
}

// ─── DATA ────────────────────────────────────────────────────────────────────
function getPublicServers(settings) {
  const rows = settings.show_all
    ? db.prepare("SELECT * FROM servers WHERE status != 'deleted' ORDER BY name").all()
    : db.prepare("SELECT * FROM servers WHERE status_public=1 AND status != 'deleted' ORDER BY name").all();

  return rows.map(srv => {
    const node     = srv.node_id ? db.prepare('SELECT name,fqdn,location FROM nodes WHERE id=?').get(srv.node_id) : null;
    const override = srv.status_override || '';  // degraded | maintenance | custom
    const lastStat = db.prepare("SELECT * FROM server_stats_log WHERE server_id=? ORDER BY recorded_at DESC LIMIT 1").get(srv.id);
    const uptimeLog = db.prepare("SELECT created_at FROM audit_log WHERE target_id=? AND action='POWER_START' ORDER BY created_at DESC LIMIT 1").get(srv.id);
    const uptimeMs = (uptimeLog && srv.status === 'running') ? Date.now() - new Date(uptimeLog.created_at).getTime() : null;
    const uptimeHistory = settings.show_uptime ? getUptimeHistory(srv.id, 90) : [];
    const validDays = uptimeHistory.filter(d => d.up_pct !== null);
    const avgUptime = validDays.length ? Math.round(validDays.reduce((s,d) => s+d.up_pct, 0) / validDays.length * 10) / 10 : null;
    let tags = []; try { tags = JSON.parse(srv.tags || '[]'); } catch {}
    return {
      id: srv.id, name: srv.name, status: srv.status, image: srv.image, tags,
      status_override: override,
      node: node ? { name: node.name, location: node.location } : null,
      uptime_ms: uptimeMs,
      cpu: lastStat?.cpu ?? null, memory_mb: lastStat?.memory_mb ?? null,
      memory_limit_mb: lastStat?.memory_limit_mb ?? null, recorded_at: lastStat?.recorded_at ?? null,
      uptime_history: uptimeHistory, avg_uptime_90d: avgUptime, group_id: srv.group_id,
      response_time_ms: srv.response_time_ms ?? null, last_ping_at: srv.last_ping_at ?? null,
    };
  });
}

function getIncidents(limit=20) {
  const rows = db.prepare("SELECT * FROM status_incidents ORDER BY started_at DESC LIMIT ?").all(limit);
  return rows.map(inc => ({
    ...inc, server_ids: JSON.parse(inc.server_ids || '[]'),
    updates: db.prepare("SELECT * FROM status_incident_updates WHERE incident_id=? ORDER BY created_at ASC").all(inc.id),
  }));
}

function getGroups() {
  return db.prepare("SELECT * FROM server_groups ORDER BY name").all().map(g => ({
    ...g, members: db.prepare("SELECT server_id FROM server_group_members WHERE group_id=?").all(g.id).map(m => m.server_id),
  }));
}

// ─── JSON API ────────────────────────────────────────────────────────────────
router.get('/api/status', (req, res) => {
  const settings = getSettings();
  if (!settings.enabled) return res.status(404).json({ error: 'Status-Page deaktiviert' });
  const servers = getPublicServers(settings);
  const online  = servers.filter(s => s.status === 'running').length;
  res.json({
    panel: settings.title, description: settings.description,
    online, offline: servers.length - online, total: servers.length,
    overall: online === servers.length ? 'operational' : online === 0 ? 'major_outage' : 'partial_outage',
    servers,
    incidents: getIncidents(5).filter(i => i.status !== 'resolved'),
    generated_at: new Date().toISOString(),
  });
});

// ─── SSE ─────────────────────────────────────────────────────────────────────
router.get('/api/status/feed', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const settings = getSettings();
  const send = () => {
    try {
      const servers   = getPublicServers(settings);
      const incidents = getIncidents(5).filter(i => i.status !== 'resolved');
      res.write(`data: ${JSON.stringify({ servers, incidents, ts: Date.now() })}\n\n`);
    } catch {}
  };
  send();
  const iv = setInterval(send, 10_000);
  req.on('close', () => clearInterval(iv));
});

// ─── SUBSCRIBE ───────────────────────────────────────────────────────────────
router.post('/api/status/subscribe', (req, res) => {
  const settings = getSettings();
  if (!settings.allow_subscribe) return res.status(403).json({ error: 'Nicht aktiviert' });
  const { email } = req.body;
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'Ungültige E-Mail' });
  const token = crypto.randomBytes(24).toString('hex');
  try {
    db.prepare("INSERT OR IGNORE INTO status_subscribers (id,email,token,confirmed) VALUES (?,?,?,1)").run(uuidv4(), email.toLowerCase(), token);
    res.json({ success: true, message: 'Erfolgreich abonniert' });
  } catch { res.status(400).json({ error: 'E-Mail bereits registriert' }); }
});

router.get('/api/status/unsubscribe', (req, res) => {
  db.prepare('DELETE FROM status_subscribers WHERE token=?').run(req.query.token || '');
  res.redirect('/status?unsubscribed=1');
});

// ─── RSS ──────────────────────────────────────────────────────────────────────
router.get('/status/feed.rss', (req, res) => {
  const settings  = getSettings();
  const incidents = getIncidents(20);
  const host      = req.protocol + '://' + req.get('host');
  const items = incidents.map(inc => `<item>
    <title>${ex('[' + inc.severity.toUpperCase() + '] ' + inc.title)}</title>
    <link>${ex(host + '/status')}</link>
    <description>${ex(inc.body + (inc.updates.length ? '\n\n' + inc.updates.map(u => u.created_at + ': ' + u.body).join('\n') : ''))}</description>
    <pubDate>${new Date(inc.created_at).toUTCString()}</pubDate>
    <guid>${ex(inc.id)}</guid>
  </item>`).join('');
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
    <title>${ex(settings.title)}</title><link>${ex(host + '/status')}</link>
    <description>${ex(settings.description)}</description><language>de</language>
    <atom:link href="${ex(host + '/status/feed.rss')}" rel="self" type="application/rss+xml"/>
    ${items}</channel></rss>`);
});

// ─── EMBED ────────────────────────────────────────────────────────────────────
router.get('/status/embed', (req, res) => {
  const settings = getSettings();
  if (!settings.enabled) return res.status(404).send('');
  const servers = getPublicServers(settings);
  const online  = servers.filter(s => s.status === 'running').length;
  const total   = servers.length;
  const color   = online === total ? '#00f5a0' : online === 0 ? '#ff4757' : '#f59e0b';
  const label   = online === total ? 'Alle Systeme betriebsbereit' : online === 0 ? 'Systemausfall' : `${online}/${total} online`;
  const accent  = settings.accent_color || '#00d4ff';
  const host    = req.protocol + '://' + req.get('host');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,sans-serif;background:#0b1120;color:#f1f5f9;padding:10px}
    .w{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#111c2e;border:1px solid #1e2d4a;border-radius:10px;border-left:3px solid ${color}}
    .dot{width:9px;height:9px;border-radius:50%;background:${color};flex-shrink:0;animation:p 2s infinite}
    @keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
    .lbl{font-size:13px;font-weight:700} .sub{font-size:11px;color:#64748b;margin-top:1px}
    a{color:${accent};text-decoration:none;font-size:11px}
  </style></head><body>
  <div class="w"><div class="dot"></div><div style="flex:1"><div class="lbl">${eh(label)}</div><div class="sub">${eh(settings.title)}</div></div>
  <a href="${eh(host + '/status')}" target="_blank">Details →</a></div>
  <script>setTimeout(()=>location.reload(),30000)</script>
  </body></html>`);
  function eh(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
});

// ─── ADMIN EINSTELLUNGEN ──────────────────────────────────────────────────────
router.get('/api/admin/status-settings', authenticate, requireAdmin, (req, res) => res.json(getSettings()));
router.put('/api/admin/status-settings', authenticate, requireAdmin, (req, res) => {
  const b = req.body; const bool = v => (v ? '1' : '0');
  setSetting('status_page_enabled',   bool(b.enabled));
  setSetting('status_page_show_all',  bool(b.show_all));
  setSetting('status_page_title',     b.title        || 'NexPanel Status');
  setSetting('status_page_desc',      b.description  || 'Echtzeit-Status aller Dienste');
  setSetting('status_page_logo',      b.logo_url     || '');
  setSetting('status_page_accent',    b.accent_color || '#00d4ff');
  setSetting('status_page_favicon',   b.favicon_url  || '');
  setSetting('status_page_show_cpu',  bool(b.show_cpu  !== false));
  setSetting('status_page_show_ram',  bool(b.show_ram  !== false));
  setSetting('status_page_uptime',    bool(b.show_uptime  !== false));
  setSetting('status_page_groups',    bool(b.show_groups  !== false));
  setSetting('status_page_subscribe', bool(b.allow_subscribe !== false));
  res.json({ success: true });
});

// ─── ADMIN INCIDENTS ─────────────────────────────────────────────────────────
router.get('/api/admin/incidents', authenticate, requireAdmin, (req, res) => res.json(getIncidents()));
router.post('/api/admin/incidents', authenticate, requireAdmin, (req, res) => {
  const { title, body='', severity='degraded', server_ids=[] } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Titel erforderlich' });
  const SEVS = ['info','degraded','partial','major','maintenance'];
  if (!SEVS.includes(severity)) return res.status(400).json({ error: 'Ungültiger Severity' });
  const id = uuidv4();
  db.prepare("INSERT INTO status_incidents (id,title,body,severity,status,server_ids,created_by) VALUES (?,?,?,?,?,?,?)")
    .run(id, title.trim(), body, severity, 'investigating', JSON.stringify(server_ids), req.user.id);
  if (body.trim()) db.prepare("INSERT INTO status_incident_updates (id,incident_id,body,status,created_by) VALUES (?,?,?,?,?)").run(uuidv4(), id, body, 'investigating', req.user.id);
  notifySubscribers(title, body, severity).catch(()=>{});
  res.status(201).json({ id });
});
// ─── GEPLANTE WARTUNGEN ──────────────────────────────────────────────────────
router.post('/api/admin/incidents/scheduled', authenticate, requireAdmin, (req, res) => {
  const { title, body='', server_ids=[], scheduled_at } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Titel erforderlich' });
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at erforderlich' });
  const id = uuidv4();
  db.prepare("INSERT INTO status_incidents (id,title,body,severity,status,server_ids,created_by,is_scheduled,scheduled_at) VALUES (?,?,?,?,?,?,?,1,?)")
    .run(id, title.trim(), body, 'maintenance', 'investigating', JSON.stringify(server_ids), req.user.id, scheduled_at);
  res.status(201).json({ id });
});

router.patch('/api/admin/incidents/:id', authenticate, requireAdmin, (req, res) => {
  const inc = db.prepare('SELECT * FROM status_incidents WHERE id=?').get(req.params.id);
  if (!inc) return res.status(404).json({ error: 'Nicht gefunden' });
  const { status, update_text, title, severity } = req.body;
  const newStatus   = ['investigating','identified','monitoring','resolved'].includes(status) ? status : inc.status;
  const newSeverity = ['info','degraded','partial','major','maintenance'].includes(severity) ? severity : inc.severity;
  const newTitle    = title?.trim() || inc.title;
  const resolvedAt  = newStatus === 'resolved' ? new Date().toISOString().replace('T',' ').split('.')[0] : inc.resolved_at;
  db.prepare("UPDATE status_incidents SET status=?,severity=?,title=?,resolved_at=?,updated_at=datetime('now') WHERE id=?").run(newStatus, newSeverity, newTitle, resolvedAt, inc.id);
  if (update_text?.trim()) db.prepare("INSERT INTO status_incident_updates (id,incident_id,body,status,created_by) VALUES (?,?,?,?,?)").run(uuidv4(), inc.id, update_text.trim(), newStatus, req.user.id);
  res.json({ success: true });
});
router.delete('/api/admin/incidents/:id', authenticate, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM status_incidents WHERE id=?').run(req.params.id);
  res.json({ success: true });
});
// ─── SPARKLINE (letzte 24h CPU/RAM) ──────────────────────────────────────────
router.get('/api/status/sparkline/:serverId', (req, res) => {
  const settings = getSettings();
  if (!settings.enabled) return res.status(404).json({ error: 'Deaktiviert' });
  const rows = db.prepare(`
    SELECT recorded_at, cpu, memory_mb, memory_limit_mb
    FROM server_stats_log WHERE server_id=?
    AND recorded_at >= datetime('now','-24 hours')
    ORDER BY recorded_at ASC
  `).all(req.params.serverId);
  // Downsample to max 48 points (one per 30min)
  const bucket = 30 * 60 * 1000;
  const map = new Map();
  for (const r of rows) {
    const k = Math.floor(new Date(r.recorded_at).getTime() / bucket) * bucket;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  const points = [...map.entries()].sort((a,b)=>a[0]-b[0]).map(([ts, pts]) => ({
    t: new Date(ts).toISOString(),
    cpu: Math.round(pts.reduce((s,p)=>s+(p.cpu||0),0)/pts.length*10)/10,
    mem: Math.round(pts.reduce((s,p)=>s+(p.memory_mb||0),0)/pts.length),
    mem_limit: pts[0].memory_limit_mb,
  }));
  res.json(points);
});

// ─── STATUS OVERRIDE ──────────────────────────────────────────────────────────
router.put('/api/admin/status-override/:serverId', authenticate, requireAdmin, (req, res) => {
  const srv = db.prepare('SELECT id FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  const override = ['','degraded','maintenance','custom'].includes(req.body.override) ? req.body.override : '';
  db.prepare("UPDATE servers SET status_override=? WHERE id=?").run(override, srv.id);
  res.json({ success: true });
});

// ─── PING TASK ────────────────────────────────────────────────────────────────
function pingServerPort(host, port, timeoutMs = 3000) {
  return new Promise(resolve => {
    const start = Date.now();
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => { sock.destroy(); resolve(Date.now() - start); });
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
    sock.on('error', () => resolve(null));
    try { sock.connect(port, host); } catch { resolve(null); }
  });
}

async function runPingCycle() {
  const servers = db.prepare("SELECT s.*, n.fqdn FROM servers s LEFT JOIN nodes n ON s.node_id=n.id WHERE s.status='running'").all();
  for (const srv of servers) {
    const ports = JSON.parse(srv.ports || '[]');
    const primary = ports.find(p => p.is_primary) || ports[0];
    if (!primary) continue;
    const host = srv.fqdn || 'localhost';
    const port = primary.host || primary.port;
    if (!port) continue;
    const ms = await pingServerPort(host, port, 2500);
    db.prepare("UPDATE servers SET response_time_ms=?, last_ping_at=datetime('now') WHERE id=?")
      .run(ms, srv.id);
  }
}
// Ping alle 60s
setInterval(runPingCycle, 60_000);
setTimeout(runPingCycle, 5_000);

router.get('/api/admin/status-uptime', authenticate, requireAdmin, (req, res) => {
  const servers = db.prepare("SELECT id,name FROM servers WHERE status != 'deleted'").all();
  res.json(servers.map(s => ({ id: s.id, name: s.name, history: getUptimeHistory(s.id, 90) })));
});

// ─── ADMIN SUBSCRIBER VERWALTUNG ─────────────────────────────────────────────
router.get('/api/admin/status-subscribers', authenticate, requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT id,email,confirmed,created_at FROM status_subscribers ORDER BY created_at DESC").all());
});
router.delete('/api/admin/status-subscribers/:id', authenticate, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM status_subscribers WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── SUBSCRIBER NOTIFICATIONS ────────────────────────────────────────────────
async function notifySubscribers(incTitle, body, severity) {
  const subs = db.prepare("SELECT * FROM status_subscribers WHERE confirmed=1").all();
  if (!subs.length) return;
  try {
    const { sendEmail } = require('../src/core/notifications');
    const SEV = { info:'Info', degraded:'Beeinträchtigung', partial:'Teilausfall', major:'Schwerer Ausfall', maintenance:'Wartung' };
    const title_panel = getSetting('status_page_title','NexPanel Status');
    const subject = `[${title_panel}] ${SEV[severity]||severity}: ${incTitle}`;
    for (const sub of subs) {
      const html = `<div style="font-family:sans-serif;background:#0f172a;color:#f1f5f9;padding:24px;border-radius:10px;max-width:600px">
        <h2 style="color:#00d4ff;margin-bottom:8px">${title_panel}</h2>
        <div style="background:#1e293b;padding:16px;border-radius:8px"><div style="font-weight:700;font-size:16px;margin-bottom:8px">${eh(incTitle)}</div><div style="color:#cbd5e1">${eh(body)}</div></div>
        <p style="color:#64748b;font-size:12px;margin-top:16px"><a href="/api/status/unsubscribe?token=${sub.token}" style="color:#64748b">Abmelden</a></p></div>`;
      await sendEmail(sub.email, subject, html).catch(()=>{});
    }
  } catch {}
  function eh(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
}

// ─── HTML PAGE ────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const settings  = getSettings();
  if (!settings.enabled) return res.status(404).send('<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0b1120;color:#e8edf5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>Status-Page deaktiviert</h2></body></html>');

  const servers   = getPublicServers(settings);
  const incidents = getIncidents(20);
  const groups    = settings.show_groups ? getGroups() : [];
  const online    = servers.filter(s => s.status === 'running').length;
  const total     = servers.length;
  const accent    = settings.accent_color || '#00d4ff';
  const host      = req.protocol + '://' + req.get('host');

  const overallColor = online === total ? '#00f5a0' : online === 0 ? '#ff4757' : '#f59e0b';
  const overallLabel = online === total ? 'Alle Systeme betriebsbereit' : online === 0 ? 'Alle Systeme offline' : `${online} von ${total} Systemen online`;
  const overallSub   = online === total ? 'Es liegen keine bekannten Störungen vor.' : `${total-online} System${total-online!==1?'e':''} aktuell nicht erreichbar`;

  const activeIncidents   = incidents.filter(i => i.status !== 'resolved' && !i.is_scheduled);
  const scheduledMaint    = incidents.filter(i => i.is_scheduled && i.status !== 'resolved');
  const resolvedIncidents = incidents.filter(i => i.status === 'resolved').slice(0,5);

  // Uptime overall 30d
  const allDays30 = [];
  for (let i=29; i>=0; i--) {
    const d  = new Date(Date.now() - i*86400000);
    const dk = d.toISOString().split('T')[0];
    const rows = db.prepare("SELECT AVG(up_pct) as avg FROM status_uptime_log WHERE date=?").get(dk);
    allDays30.push({ date: dk, avg: rows?.avg != null ? Math.round(rows.avg*10)/10 : null });
  }

  const grouped = [];
  if (settings.show_groups && groups.length) {
    for (const g of groups) {
      const gsrvs = servers.filter(s => g.members.includes(s.id));
      if (gsrvs.length) grouped.push({ label: g.icon + ' ' + g.name, color: g.color, servers: gsrvs });
    }
    const ungrouped = servers.filter(s => !groups.some(g => g.members.includes(s.id)));
    if (ungrouped.length) grouped.push({ label: '📂 Weitere', color: '#64748b', servers: ungrouped });
  } else { grouped.push({ label: null, servers }); }

  const unsubscribed = req.query.unsubscribed === '1';

  function srvCards(srvList) {
    return srvList.map(srv => {
      const COLS = {running:'#00f5a0',offline:'#64748b',installing:'#60a5fa',error:'#ff4757',starting:'#f59e0b',stopping:'#f59e0b'};
      const LBLS = {running:'● Online',offline:'○ Offline',installing:'◌ Installing',error:'✕ Error',starting:'◌ Starting',stopping:'◌ Stopping'};
      const ovr  = srv.status_override;
      const OC   = {degraded:'#f59e0b',maintenance:'#a78bfa',custom:'#60a5fa'};
      const OL   = {degraded:'Beeinträchtigt',maintenance:'Wartung',custom:'Info'};
      const col   = ovr ? OC[ovr]||'#64748b' : COLS[srv.status]||'#64748b';
      const label = ovr ? OL[ovr]||ovr : LBLS[srv.status]||'● '+srv.status;
      const hasCpu = settings.show_cpu && srv.cpu !== null;
      const hasMem = settings.show_ram && srv.memory_mb !== null && srv.memory_limit_mb > 0;
      const cpuPct = hasCpu ? Math.min(srv.cpu, 100) : 0;
      const memPct = hasMem ? Math.min(100, srv.memory_mb/srv.memory_limit_mb*100) : 0;
      const ut = srv.uptime_ms ? fmtUpt(srv.uptime_ms) : '';
      const rt = srv.response_time_ms != null ? `<span class="rt-badge" style="color:${srv.response_time_ms<100?'#00f5a0':srv.response_time_ms<300?'#f59e0b':'#ff4757'}">${srv.response_time_ms}ms</span>` : '';

      const upBars = settings.show_uptime && srv.uptime_history.length > 0 ? `
        <div class="uptime-wrap">
          <div class="uptime-bars">${srv.uptime_history.map(d => {
            const p = d.up_pct;
            const bc = p===null?'#1e2d4a':p>=98?'#00f5a0':p>=90?'#f59e0b':'#ff4757';
            const h  = p===null?8:Math.max(5,Math.round(p/100*22));
            return `<div class="upb" style="height:${h}px;background:${bc}" data-d="${eh(d.date)}" data-p="${p===null?'null':p}"></div>`;
          }).join('')}</div>
          <div class="uptime-foot"><span>90d</span><span class="uptime-avg">${srv.avg_uptime_90d!==null?srv.avg_uptime_90d.toFixed(1)+'% Uptime':'—'}</span><span>Heute</span></div>
        </div>` : '';

      return `<div class="sc" id="srv-${eh(srv.id)}" style="border-left:3px solid ${col}" data-id="${eh(srv.id)}">
        <div class="sc-l">
          <div class="sc-name">${eh(srv.name)}</div>
          <div class="sc-meta">
            ${srv.node?`<span>📍 ${eh(srv.node.location||srv.node.name)}</span>`:''}
            ${ut?`<span>⏱ <span class="utv">${ut}</span></span>`:`<span class="utv"></span>`}
            ${rt}
            ${srv.tags.map(t=>`<span class="tag">${eh(t)}</span>`).join('')}
          </div>
          ${upBars}
        </div>
        <div class="sc-r">
          <span class="sbadge" style="color:${col};background:${col}18">${label}</span>
          ${hasCpu||hasMem?`<div class="bars">
            ${hasCpu?`<div class="br"><span class="bl">CPU</span><div class="bt"><div class="bf cpuf" style="width:${cpuPct}%;background:${cpuPct>80?'#ff4757':cpuPct>60?'#f59e0b':'#00d4ff'}"></div></div><span class="bv cpuv">${srv.cpu.toFixed(1)}%</span></div>`:''}
            ${hasMem?`<div class="br"><span class="bl">RAM</span><div class="bt"><div class="bf memf" style="width:${memPct}%;background:${memPct>80?'#ff4757':memPct>60?'#f59e0b':'#00f5a0'}"></div></div><span class="bv memv">${Math.round(srv.memory_mb)} MB</span></div>`:''}
          </div>`:''}
          <button class="spark-btn" onclick="toggleSparkline('${eh(srv.id)}')" title="CPU/RAM Verlauf">📈</button>
        </div>
        <div class="sparkline-box hidden" id="spark-${eh(srv.id)}">
          <canvas id="sc-${eh(srv.id)}" height="60"></canvas>
        </div>
      </div>`;
    }).join('');
  }

  function incCard(inc, resolved=false) {
    const SC = {info:'#60a5fa',degraded:'#f59e0b',partial:'#f59e0b',major:'#ff4757',maintenance:'#a78bfa'};
    const SL = {info:'Info',degraded:'Beeinträchtigt',partial:'Teilausfall',major:'Schwerer Ausfall',maintenance:'Wartung'};
    const SS = {investigating:'Wird untersucht',identified:'Ursache gefunden',monitoring:'Wird beobachtet',resolved:'Behoben'};
    const c = SC[inc.severity]||'#64748b';
    const schedHint = inc.is_scheduled && inc.scheduled_at ? `<div style="font-size:11px;color:#a78bfa;margin-top:4px">🗓 Geplant: ${new Date(inc.scheduled_at).toLocaleString('de-DE')}</div>` : '';
    return `<div class="ic" style="border-color:${c}44;${resolved?'opacity:.7':''}">
      <div class="ih"><div><div class="it">${eh(inc.title)}</div><div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
        <span class="ib" style="background:${c}18;color:${c}">${SL[inc.severity]||inc.severity}</span>
        <span class="ib" style="background:rgba(255,255,255,.05);color:#8fa3c8">${SS[inc.status]||inc.status}</span>
      </div>${schedHint}</div><div class="idate">${new Date(inc.started_at).toLocaleString('de-DE')}</div></div>
      ${inc.body?`<div class="ibody">${eh(inc.body)}</div>`:''}
      ${inc.updates.length?`<div class="itl">${inc.updates.map(u=>`<div class="tli"><div class="tldot"></div><div class="tltime">${new Date(u.created_at).toLocaleString('de-DE')}</div><div class="tltext">${eh(u.body)}</div></div>`).join('')}</div>`:''}
      ${inc.resolved_at?`<div class="imeta">Behoben: ${new Date(inc.resolved_at).toLocaleString('de-DE')}</div>`:''}
    </div>`;
  }

  function fmtUpt(ms) {
    if(!ms) return ''; const s=Math.floor(ms/1000);
    const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60);
    if(d>0) return d+'d '+h+'h'; if(h>0) return h+'h '+m+'m'; return m+'m';
  }

  // 30-day overall chart bars
  const overall30bars = allDays30.map(d => {
    const p = d.avg;
    const bc = p===null?'#1e2d4a':p>=98?'#00f5a0':p>=90?'#f59e0b':'#ff4757';
    const h  = p===null?6:Math.max(4,Math.round(p/100*28));
    return `<div class="upb" style="height:${h}px;background:${bc};flex:1" data-d="${eh(d.date)}" data-p="${p===null?'null':p+' Ø'}"></div>`;
  }).join('');
  const validDays30  = allDays30.filter(d=>d.avg!==null);
  const avg30 = validDays30.length ? (validDays30.reduce((s,d)=>s+d.avg,0)/validDays30.length).toFixed(2) : null;

  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="de" data-theme="dark">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${eh(settings.title)}</title>
  <meta name="description" content="${eh(settings.description)}">
  <meta name="theme-color" content="#0b1120">
  ${settings.favicon_url?`<link rel="icon" href="${eh(settings.favicon_url)}">`:``}
  <link rel="alternate" type="application/rss+xml" title="${eh(settings.title)} RSS" href="/status/feed.rss">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{--bg:#0b1120;--bg2:#111c2e;--bg3:#172035;--card:#161f33;--brd:#1e2d4a;--brd2:#243459;--txt:#e8edf5;--txt2:#8fa3c8;--txt3:#4d6490;--ok:#00f5a0;--err:#ff4757;--warn:#f59e0b;--info:#60a5fa;--ac:${accent};--mono:'JetBrains Mono',monospace}
    [data-theme="light"]{--bg:#f0f4f8;--bg2:#e2e8f0;--bg3:#cbd5e1;--card:#ffffff;--brd:#c4cfe0;--brd2:#b0bfd0;--txt:#0f172a;--txt2:#334155;--txt3:#64748b;--ac:${accent==='#00d4ff'?'#0066cc':accent}}
    body{background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;padding-bottom:60px;transition:background .2s,color .2s}
    a{color:var(--ac);text-decoration:none} a:hover{text-decoration:underline}

    .hdr{background:var(--bg2);border-bottom:1px solid var(--brd);position:sticky;top:0;z-index:100;backdrop-filter:blur(10px)}
    .hdr-i{max-width:960px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px}
    .logo-row{display:flex;align-items:center;gap:12px}
    .logo-img{height:34px;border-radius:8px}
    .logo-txt{font-size:20px;font-weight:800;letter-spacing:-.4px}
    .hdr-desc{font-size:12px;color:var(--txt3);margin-top:2px}
    .hdr-links{display:flex;align-items:center;gap:10px;font-size:13px;flex-shrink:0}
    .live-pill{display:flex;align-items:center;gap:5px;background:rgba(0,245,160,.1);color:var(--ok);border:1px solid rgba(0,245,160,.2);padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700}
    .live-dot{width:6px;height:6px;border-radius:50%;background:var(--ok);animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
    .hdr-btn{background:var(--bg3);border:1px solid var(--brd);border-radius:8px;color:var(--txt2);cursor:pointer;padding:5px 10px;font-size:13px;transition:.15s}
    .hdr-btn:hover{color:var(--txt);border-color:var(--brd2)}

    .wrap{max-width:960px;margin:0 auto;padding:0 24px}

    .banner{margin:28px 0 20px;padding:18px 22px;border-radius:14px;border:1px solid;display:flex;align-items:center;gap:14px}
    .bndot{width:14px;height:14px;border-radius:50%;flex-shrink:0;animation:pulse 2s infinite}
    .bntxt{font-size:17px;font-weight:700}
    .bnsub{font-size:13px;color:var(--txt2);margin-top:3px}

    .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:22px}
    .sbox{background:var(--card);border:1px solid var(--brd);border-radius:12px;padding:16px;text-align:center}
    .sval{font-size:30px;font-weight:800;font-family:var(--mono);line-height:1}
    .slbl{font-size:10px;color:var(--txt3);margin-top:5px;text-transform:uppercase;letter-spacing:.07em}

    .stitle{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--txt3);margin:24px 0 10px;display:flex;align-items:center;gap:8px}
    .stitle::after{content:'';flex:1;height:1px;background:var(--brd)}

    .overall-chart{background:var(--card);border:1px solid var(--brd);border-radius:12px;padding:14px 18px;margin-bottom:20px}
    .overall-chart-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:12px;color:var(--txt3)}
    .overall-chart-bars{display:flex;gap:2px;align-items:flex-end;height:28px}

    .ic{background:var(--card);border:1px solid;border-radius:12px;padding:16px 18px;margin-bottom:8px}
    .ih{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
    .it{font-weight:700;font-size:14px}
    .ib{display:inline-flex;align-items:center;font-size:11px;font-weight:700;padding:3px 9px;border-radius:6px;white-space:nowrap}
    .ibody{font-size:13px;color:var(--txt2);margin-top:8px;line-height:1.6}
    .itl{margin-top:12px;padding-top:12px;border-top:1px solid var(--brd);display:flex;flex-direction:column;gap:8px}
    .tli{display:flex;gap:10px;font-size:12px;align-items:flex-start}
    .tldot{width:8px;height:8px;border-radius:50%;background:var(--txt3);flex-shrink:0;margin-top:4px}
    .tltime{color:var(--txt3);white-space:nowrap;min-width:130px}
    .tltext{color:var(--txt2);line-height:1.5}
    .imeta{font-size:11px;color:var(--txt3);margin-top:8px}
    .idate{font-size:11px;color:var(--txt3);text-align:right;flex-shrink:0;white-space:nowrap}

    .glbl{font-size:12px;font-weight:700;margin:18px 0 8px;display:flex;align-items:center;gap:8px}
    .gline{height:2px;border-radius:1px;flex:1;opacity:.35}
    .srv-list{display:flex;flex-direction:column;gap:6px}

    .sc{background:var(--card);border:1px solid var(--brd);border-radius:12px;padding:14px 18px;display:grid;grid-template-columns:1fr auto;gap:10px;align-items:start;transition:border-color .2s;grid-column:1/-1}
    .sc:hover{border-color:var(--brd2)}
    .sc-name{font-weight:600;font-size:14px}
    .sc-meta{font-size:12px;color:var(--txt3);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .tag{background:rgba(0,212,255,.08);color:var(--ac);padding:1px 7px;border-radius:4px;font-size:10px}
    .rt-badge{font-size:10px;font-weight:700;padding:1px 6px;background:rgba(255,255,255,.05);border-radius:4px}
    .sc-r{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
    .sbadge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:6px;white-space:nowrap}
    .spark-btn{background:var(--bg3);border:1px solid var(--brd);border-radius:6px;cursor:pointer;font-size:12px;padding:3px 8px;color:var(--txt3);transition:.15s}
    .spark-btn:hover{color:var(--txt);border-color:var(--brd2)}

    .bars{display:flex;flex-direction:column;gap:4px;min-width:140px}
    .br{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--txt3)}
    .bl{width:28px;flex-shrink:0}
    .bt{flex:1;height:4px;background:var(--bg3);border-radius:2px;overflow:hidden}
    .bf{height:100%;border-radius:2px;transition:width .5s}
    .bv{min-width:52px;text-align:right;color:var(--txt2)}

    .sparkline-box{padding:10px 0 4px;grid-column:1/-1;border-top:1px solid var(--brd)}
    .sparkline-box.hidden{display:none}

    .uptime-wrap{margin-top:8px}
    .uptime-bars{display:flex;gap:2px;align-items:flex-end;height:22px}
    .upb{flex:1;border-radius:2px;min-width:3px;cursor:default;transition:opacity .15s}
    .upb:hover{opacity:.7}
    .uptime-foot{display:flex;justify-content:space-between;font-size:10px;color:var(--txt3);margin-top:3px}
    .uptime-avg{font-size:11px;font-weight:600;color:var(--txt2)}

    .search-bar{background:var(--card);border:1px solid var(--brd);border-radius:10px;padding:10px 14px;margin-bottom:16px;display:flex;align-items:center;gap:10px}
    .search-bar input{flex:1;background:transparent;border:none;outline:none;color:var(--txt);font-size:13px}
    .search-bar input::placeholder{color:var(--txt3)}

    .subbox{background:var(--card);border:1px solid var(--brd);border-radius:12px;padding:18px 22px;margin:24px 0;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
    .subform{display:flex;gap:8px;flex:1;min-width:260px}
    .subin{flex:1;background:var(--bg3);border:1px solid var(--brd);border-radius:8px;padding:8px 12px;color:var(--txt);font-size:13px;outline:none}
    .subin:focus{border-color:var(--ac)}
    .subbtn{background:var(--ac);color:#000;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;transition:opacity .15s}
    .subbtn:hover{opacity:.85}

    .footer{margin-top:40px;text-align:center;font-size:12px;color:var(--txt3)}
    .footer-lnk{display:flex;gap:16px;justify-content:center;margin-top:8px;flex-wrap:wrap}

    .toast{position:fixed;top:20px;right:20px;background:#1e293b;border:1px solid #334155;border-radius:10px;padding:12px 18px;font-size:13px;color:#f1f5f9;z-index:9999;animation:si .3s}
    @keyframes si{from{transform:translateX(110%);opacity:0}to{transform:none;opacity:1}}

    @media(max-width:640px){.sc{grid-template-columns:1fr}.sc-r{align-items:flex-start;flex-direction:row;flex-wrap:wrap;gap:6px}.stats{grid-template-columns:repeat(3,1fr)}.hdr-desc{display:none}}
  </style>
</head>
<body>
<div class="hdr"><div class="hdr-i">
  <div class="logo-row">
    ${settings.logo_url?`<img src="${eh(settings.logo_url)}" alt="Logo" class="logo-img">`:''}
    <div>
      <div class="logo-txt">${eh(settings.title)}</div>
      <div class="hdr-desc">${eh(settings.description)}</div>
    </div>
  </div>
  <div class="hdr-links">
    <div class="live-pill"><div class="live-dot"></div>Live</div>
    <button class="hdr-btn" onclick="toggleTheme()" id="theme-btn" title="Farbschema">🌙</button>
    <a href="/status/feed.rss" title="RSS Feed" class="hdr-btn" style="display:inline-flex;align-items:center;gap:4px;text-decoration:none">📡</a>
    <a href="/status/embed" title="Embed Widget" class="hdr-btn" style="display:inline-flex;align-items:center;gap:4px;text-decoration:none">🔗</a>
  </div>
</div></div>

<div class="wrap">
  ${unsubscribed?`<div style="background:rgba(0,245,160,.1);border:1px solid rgba(0,245,160,.3);border-radius:10px;padding:12px 16px;margin-top:16px;font-size:13px;color:var(--ok)">✓ Erfolgreich abgemeldet.</div>`:''}

  <div class="banner" id="banner" style="background:${overallColor}12;border-color:${overallColor}44">
    <div class="bndot" id="bndot" style="background:${overallColor}"></div>
    <div style="flex:1">
      <div class="bntxt" id="bntxt">${eh(overallLabel)}</div>
      <div class="bnsub" id="bnsub">${eh(overallSub)}</div>
    </div>
    <div style="font-size:11px;color:var(--txt3);text-align:right;flex-shrink:0">Aktualisiert<br><span id="lupd">${new Date().toLocaleTimeString('de-DE')}</span></div>
  </div>

  <div class="stats">
    <div class="sbox"><div class="sval" id="cnt-on" style="color:var(--ok)">${online}</div><div class="slbl">Online</div></div>
    <div class="sbox"><div class="sval" id="cnt-off" style="color:var(--err)">${total-online}</div><div class="slbl">Offline</div></div>
    <div class="sbox"><div class="sval">${total}</div><div class="slbl">Gesamt</div></div>
  </div>

  ${allDays30.length ? `
  <div class="overall-chart">
    <div class="overall-chart-head">
      <span style="font-weight:600;color:var(--txt)">📊 Uptime der letzten 30 Tage</span>
      ${avg30!==null?`<span style="font-weight:700;color:var(--ok)">${avg30}% Ø</span>`:''}
    </div>
    <div class="overall-chart-bars uptime-bars" style="height:28px">${overall30bars}</div>
    <div class="uptime-foot"><span>${allDays30[0]?.date}</span><span></span><span>${allDays30[29]?.date}</span></div>
  </div>` : ''}

  ${scheduledMaint.length?`<div class="stitle">🗓️ Geplante Wartungen</div>${scheduledMaint.map(i=>incCard(i)).join('')}`:''}
  ${activeIncidents.length?`<div class="stitle">Aktuelle Störungen</div>${activeIncidents.map(i=>incCard(i)).join('')}`:''}

  <div class="search-bar">
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--txt3)"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input id="srv-search" placeholder="Server suchen…" oninput="filterServers(this.value)"/>
    <span id="srv-search-count" style="font-size:11px;color:var(--txt3)"></span>
  </div>

  ${grouped.map(grp => `
    ${grp.label?`<div class="glbl" style="color:${grp.color||'var(--txt3)'}"><span>${eh(grp.label)}</span><div class="gline" style="background:${grp.color||'var(--brd)'}"></div></div>`:`<div class="stitle">🖥️ Server</div>`}
    <div class="srv-list">${srvCards(grp.servers)}${grp.servers.length===0?'<div style="text-align:center;color:var(--txt3);padding:20px;font-size:13px">Keine Server</div>':''}</div>
  `).join('')}

  ${resolvedIncidents.length?`<div class="stitle" style="margin-top:32px">Behobene Vorfälle</div>${resolvedIncidents.map(i=>incCard(i,true)).join('')}`:''}

  ${settings.allow_subscribe?`
  <div class="subbox" id="subbox">
    <div><div style="font-weight:700;font-size:14px;margin-bottom:2px">🔔 Status-Updates abonnieren</div><div style="font-size:12px;color:var(--txt3)">Bei Störungen per E-Mail benachrichtigt werden</div></div>
    <div class="subform"><input class="subin" type="email" id="sub-email" placeholder="deine@email.de" onkeydown="if(event.key==='Enter')subscribe()"/><button class="subbtn" onclick="subscribe()">Abonnieren</button></div>
  </div>`:''} 

  <div class="footer">
    <div>Betrieben mit <strong>NexPanel</strong> · <span id="footer-update">Aktualisiert alle 10 Sekunden</span></div>
    <div class="footer-lnk"><a href="/status/feed.rss">RSS Feed</a><a href="/status/embed">Embed Widget</a><a href="/api/status">JSON API</a></div>
  </div>
</div>

<script>
// ─── THEME ─────────────────────────────────────────────────────────────────
const _themeKey = 'nx-status-theme';
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(_themeKey, t);
  document.getElementById('theme-btn').textContent = t==='dark' ? '🌙' : '☀️';
}
function toggleTheme() { applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark'); }
applyTheme(localStorage.getItem(_themeKey)||'dark');

// ─── SEARCH ────────────────────────────────────────────────────────────────
function filterServers(q) {
  const cards = document.querySelectorAll('.sc');
  const ql = q.toLowerCase().trim();
  let vis = 0;
  cards.forEach(c => {
    const name = c.querySelector('.sc-name')?.textContent?.toLowerCase()||'';
    const meta = c.querySelector('.sc-meta')?.textContent?.toLowerCase()||'';
    const show = !ql || name.includes(ql) || meta.includes(ql);
    c.style.display = show ? '' : 'none';
    if (show) vis++;
  });
  const el = document.getElementById('srv-search-count');
  if (el) el.textContent = ql ? vis+' Treffer' : '';
}

// ─── UPTIME TOOLTIP ────────────────────────────────────────────────────────
document.querySelectorAll('.upb').forEach(b=>{
  b.addEventListener('mouseenter', e => {
    const tt = document.createElement('div');
    tt.style.cssText='position:fixed;background:#1e293b;border:1px solid #334155;border-radius:6px;padding:5px 10px;font-size:11px;color:#f1f5f9;z-index:9999;pointer-events:none;white-space:nowrap';
    tt.textContent = b.dataset.d+': '+(b.dataset.p==='null'?'Keine Daten':b.dataset.p+'% Uptime');
    tt.id='_tt'; document.body.appendChild(tt);
  });
  b.addEventListener('mousemove', e => { const t=document.getElementById('_tt'); if(t){t.style.left=(e.clientX+14)+'px';t.style.top=(e.clientY-32)+'px';}});
  b.addEventListener('mouseleave', ()=>document.getElementById('_tt')?.remove());
});

// ─── SPARKLINE ─────────────────────────────────────────────────────────────
const _sparkCache = {};
async function toggleSparkline(id) {
  const box = document.getElementById('spark-'+id);
  if (!box) return;
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (_sparkCache[id]) return;
  _sparkCache[id] = true;
  try {
    const pts = await fetch('/api/status/sparkline/'+id).then(r=>r.json());
    const canvas = document.getElementById('sc-'+id);
    if (!canvas || !pts.length) { box.innerHTML='<div style="text-align:center;font-size:11px;color:#64748b;padding:8px">Keine Daten</div>'; return; }
    const isDark = document.documentElement.getAttribute('data-theme')!=='light';
    new Chart(canvas, {
      type: 'line',
      data: {
        labels: pts.map(p=>p.t.slice(11,16)),
        datasets: [
          { label:'CPU %', data:pts.map(p=>p.cpu), borderColor:'#00d4ff', backgroundColor:'rgba(0,212,255,.08)', borderWidth:1.5, pointRadius:0, tension:.3, fill:true, yAxisID:'y' },
          { label:'RAM MB', data:pts.map(p=>p.mem), borderColor:'#00f5a0', backgroundColor:'rgba(0,245,160,.08)', borderWidth:1.5, pointRadius:0, tension:.3, fill:true, yAxisID:'y2' },
        ]
      },
      options: {
        responsive:true, maintainAspectRatio:false, interaction:{mode:'index',intersect:false},
        plugins:{ legend:{labels:{color:isDark?'#8fa3c8':'#334155',font:{size:10},boxWidth:10}}, tooltip:{bodyFont:{size:10}} },
        scales:{
          x:{ticks:{color:isDark?'#4d6490':'#64748b',maxTicksLimit:8,font:{size:9}},grid:{color:isDark?'#1e2d4a':'#e2e8f0'}},
          y:{ticks:{color:'#00d4ff',font:{size:9}},grid:{color:isDark?'#1e2d4a':'#e2e8f0'},title:{display:true,text:'CPU %',color:'#00d4ff',font:{size:9}}},
          y2:{position:'right',ticks:{color:'#00f5a0',font:{size:9}},grid:{display:false},title:{display:true,text:'RAM MB',color:'#00f5a0',font:{size:9}}}
        }
      }
    });
  } catch(e) { box.innerHTML='<div style="text-align:center;font-size:11px;color:#ff4757;padding:8px">Fehler: '+e.message+'</div>'; }
}

// ─── LIVE SSE ──────────────────────────────────────────────────────────────
const SC = {running:'#00f5a0',offline:'#64748b',installing:'#60a5fa',error:'#ff4757',starting:'#f59e0b',stopping:'#f59e0b'};
const SL = {running:'● Online',offline:'○ Offline',installing:'◌ Installing',error:'✕ Error',starting:'◌ Starting',stopping:'◌ Stopping'};
function fmtUt(ms){if(!ms||ms<0)return'';const s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60);if(d)return d+'d '+h+'h';if(h)return h+'h '+m+'m';return m+'m';}
function fmtMb(mb){if(!mb)return'';return mb>=1024?(mb/1024).toFixed(1)+' GB':Math.round(mb)+' MB';}
function toast(msg,ok=true){const t=document.createElement('div');t.className='toast';t.textContent=msg;t.style.borderColor=ok?'rgba(0,245,160,.3)':'rgba(255,71,87,.3)';document.body.appendChild(t);setTimeout(()=>t.remove(),3500);}

async function subscribe(){
  const em=document.getElementById('sub-email')?.value?.trim(); if(!em) return;
  try{const r=await fetch('/api/status/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:em})});
    const d=await r.json(); if(r.ok){toast('✓ '+d.message);document.getElementById('subbox').style.display='none';}else toast('✕ '+d.error,false);}
  catch{toast('Fehler',false);}
}

const es = new EventSource('/api/status/feed');
es.onmessage = e => {
  const {servers} = JSON.parse(e.data);
  const on=servers.filter(s=>s.status==='running').length, tot=servers.length;
  document.getElementById('cnt-on').textContent=on;
  document.getElementById('cnt-off').textContent=tot-on;
  document.getElementById('lupd').textContent=new Date().toLocaleTimeString('de-DE');
  const aon=on===tot,aoff=on===0; const c=aon?'#00f5a0':aoff?'#ff4757':'#f59e0b';
  const bn=document.getElementById('banner');
  if(bn){bn.style.background=c+'12';bn.style.borderColor=c+'44';}
  document.getElementById('bndot').style.background=c;
  document.getElementById('bntxt').textContent=aon?'Alle Systeme betriebsbereit':aoff?'Alle Systeme offline':on+' von '+tot+' Systemen online';
  document.getElementById('bnsub').textContent=aon?'Es liegen keine bekannten Störungen vor.':(tot-on)+' System'+(tot-on!==1?'e':'')+' aktuell nicht erreichbar';
  servers.forEach(srv => {
    const OC={degraded:'#f59e0b',maintenance:'#a78bfa',custom:'#60a5fa'};
    const OL={degraded:'Beeinträchtigt',maintenance:'Wartung',custom:'Info'};
    const card=document.getElementById('srv-'+srv.id); if(!card) return;
    const ovr=srv.status_override;
    const col=ovr?OC[ovr]||'#64748b':SC[srv.status]||'#64748b';
    const badge=card.querySelector('.sbadge');
    if(badge){badge.textContent=ovr?OL[ovr]||ovr:SL[srv.status]||'● '+srv.status;badge.style.color=col;badge.style.background=col+'18';}
    card.style.borderLeftColor=col;
    const utv=card.querySelector('.utv'); if(utv) utv.textContent=srv.status==='running'&&srv.uptime_ms?fmtUt(srv.uptime_ms):'';
    if(srv.cpu!=null){const f=card.querySelector('.cpuf'),v=card.querySelector('.cpuv');if(f)f.style.width=Math.min(srv.cpu,100)+'%';if(v)v.textContent=srv.cpu.toFixed(1)+'%';}
    if(srv.memory_mb!=null&&srv.memory_limit_mb>0){const p=Math.min(100,srv.memory_mb/srv.memory_limit_mb*100);const f=card.querySelector('.memf'),v=card.querySelector('.memv');if(f)f.style.width=p+'%';if(v)v.textContent=fmtMb(srv.memory_mb);}
    if(srv.response_time_ms!=null){const rt=card.querySelector('.rt-badge');if(rt){const ms=srv.response_time_ms;rt.textContent=ms+'ms';rt.style.color=ms<100?'#00f5a0':ms<300?'#f59e0b':'#ff4757';}}
  });
};
es.onerror=()=>document.getElementById('bndot').style.background='#f59e0b';
</script>
</body>
</html>`);

  function eh(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
});

function ex(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}
function eh(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

module.exports = router;
