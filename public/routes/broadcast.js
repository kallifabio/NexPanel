'use strict';
/**
 * routes/broadcast.js — Broadcast & Announce System
 *
 * Broadcast (Raw-Befehl):
 *   POST /api/servers/broadcast            — Befehl an mehrere Server senden
 *   GET  /api/servers/broadcast/history    — Broadcast-Verlauf
 *
 * Announce (formatierte Nachricht → say + Discord):
 *   POST /api/servers/announce             — Announce sofort senden
 *   GET  /api/servers/announce/schedules   — Zeitpläne auflisten
 *   POST /api/servers/announce/schedules   — Zeitplan erstellen
 *   PATCH/DELETE /:id                      — Zeitplan bearbeiten/löschen
 *   POST /:id/run                          — Zeitplan sofort auslösen
 */

const express        = require('express');
const { v4: uuidv4 } = require('uuid');
const https          = require('https');
const http           = require('http');
const { db, auditLog }                     = require('../src/core/db');
const { authenticate, requireAdmin }       = require('./auth');
const { routeToNode }                      = require('../src/docker/node-router');

const router = express.Router();

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function getRunningServers(target = 'running') {
  const filter = target === 'all'
    ? "WHERE container_id IS NOT NULL AND container_id != ''"
    : "WHERE status='running' AND container_id IS NOT NULL AND container_id != ''";
  return db.prepare(`SELECT * FROM servers ${filter}`).all();
}

function buildCommand(template, message) {
  // {message} Platzhalter ersetzen; falls kein Platzhalter → direkt anhängen
  if (template.includes('{message}')) return template.replace(/\{message\}/g, message);
  return template + ' ' + message;
}

function saveBroadcastHistory(entry) {
  try {
    const row     = db.prepare("SELECT value FROM settings WHERE key='broadcast_history'").get();
    const history = row ? JSON.parse(row.value) : [];
    history.unshift({ ...entry, at: new Date().toISOString() });
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('broadcast_history',?)")
      .run(JSON.stringify(history.slice(0, 200)));
  } catch (_) {}
}

async function sendDiscordAnnounce(webhookUrl, message, meta = {}) {
  if (!webhookUrl?.trim()) return;
  const body = JSON.stringify({
    username: 'NexPanel',
    embeds: [{
      title:       '📢 Server-Ankündigung',
      description: message,
      color:       0x00d4ff,
      fields: [
        { name: 'Ziel', value: `${meta.sent || 0} / ${meta.total || 0} Server`, inline: true },
        ...(meta.schedule_name ? [{ name: 'Zeitplan', value: meta.schedule_name, inline: true }] : []),
      ],
      footer:    { text: 'NexPanel Announce' },
      timestamp: new Date().toISOString(),
    }],
  });

  return new Promise((resolve) => {
    try {
      const u    = new URL(webhookUrl);
      const mod  = u.protocol === 'https:' ? https : http;
      const opts = {
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };
      const req = mod.request(opts, res => { res.resume(); resolve({ ok: res.statusCode < 300 }); });
      req.on('error', () => resolve({ ok: false }));
      req.write(body); req.end();
    } catch (_) { resolve({ ok: false }); }
  });
}

// Kern-Funktion: Announce an Server + Discord senden
async function runAnnounce({ message, target = 'running', delay_ms = 0, server_command = 'say {message}',
                              discord_webhook = '', discord_enabled = false, server_ids = null }) {
  const servers = server_ids?.length
    ? db.prepare(`SELECT * FROM servers WHERE id IN (${server_ids.map(() => '?').join(',')})`).all(...server_ids)
    : getRunningServers(target);

  const results = [];
  for (let i = 0; i < servers.length; i++) {
    const srv = servers[i];
    if (i > 0 && delay_ms > 0) await new Promise(r => setTimeout(r, delay_ms));
    try {
      const cmd = buildCommand(server_command, message);
      await routeToNode(srv.node_id, {
        type: 'container.exec', server_id: srv.id,
        container_id: srv.container_id, command: cmd,
      }, 15_000);
      results.push({ server_id: srv.id, name: srv.name, status: 'sent' });
    } catch (e) {
      results.push({ server_id: srv.id, name: srv.name, status: 'error', error: e.message });
    }
  }

  const sent   = results.filter(r => r.status === 'sent').length;
  const failed = results.filter(r => r.status === 'error').length;

  // Discord senden
  let discordOk = null;
  if (discord_enabled && discord_webhook) {
    const dr = await sendDiscordAnnounce(discord_webhook, message, { sent, total: servers.length });
    discordOk = dr?.ok ?? false;
  }

  return { sent, failed, total: servers.length, discord_ok: discordOk, results };
}

// ══════════════════════════════════════════════════════════════════════════════
// BROADCAST (Raw-Befehl)
// ══════════════════════════════════════════════════════════════════════════════

router.post('/broadcast', authenticate, async (req, res) => {
  const { command, server_ids, target = 'running', delay_ms = 0 } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: 'command erforderlich' });
  if (delay_ms < 0 || delay_ms > 5000) return res.status(400).json({ error: 'delay_ms: 0–5000 ms' });

  const isAdmin = req.user.role === 'admin';
  let servers;
  if (Array.isArray(server_ids) && server_ids.length > 0) {
    if (server_ids.length > 50) return res.status(400).json({ error: 'Max. 50 Server' });
    servers = db.prepare(`SELECT * FROM servers WHERE id IN (${server_ids.map(() => '?').join(',')})`).all(...server_ids)
      .filter(s => {
        if (isAdmin) return true;
        if (s.user_id === req.user.id) return true;
        const sub = db.prepare('SELECT permissions FROM server_subusers WHERE server_id=? AND user_id=?').get(s.id, req.user.id);
        return sub && JSON.parse(sub.permissions || '[]').includes('console');
      });
  } else {
    const sf = target === 'running' ? "AND status='running'" : '';
    servers = isAdmin
      ? db.prepare(`SELECT * FROM servers WHERE container_id IS NOT NULL ${sf}`).all()
      : db.prepare(`SELECT s.* FROM servers s LEFT JOIN server_subusers su ON su.server_id=s.id AND su.user_id=? WHERE (s.user_id=? OR su.user_id IS NOT NULL) AND s.container_id IS NOT NULL ${sf}`).all(req.user.id, req.user.id);
    if (!servers.length) return res.json({ sent: 0, failed: 0, results: [], message: 'Keine Server' });
    if (servers.length > 50) return res.status(400).json({ error: `Zu viele Server (${servers.length})` });
  }
  if (!servers.length) return res.json({ sent: 0, failed: 0, results: [] });

  const broadcastId = uuidv4();
  res.json({ broadcast_id: broadcastId, target_count: servers.length, message: `Befehl wird an ${servers.length} Server gesendet…` });

  setImmediate(async () => {
    const results = [];
    for (let i = 0; i < servers.length; i++) {
      const srv = servers[i];
      if (i > 0 && delay_ms > 0) await new Promise(r => setTimeout(r, delay_ms));
      try {
        await routeToNode(srv.node_id, { type: 'container.exec', server_id: srv.id, container_id: srv.container_id, command: command.trim() }, 15_000);
        results.push({ server_id: srv.id, name: srv.name, status: 'sent' });
      } catch (e) { results.push({ server_id: srv.id, name: srv.name, status: 'error', error: e.message }); }
    }
    const sent = results.filter(r => r.status === 'sent').length;
    const failed = results.filter(r => r.status === 'error').length;
    saveBroadcastHistory({ id: broadcastId, user_id: req.user.id, type: 'broadcast', command: command.trim(), target_count: servers.length, sent, failed, results: JSON.stringify(results) });
    auditLog(req.user.id, 'BROADCAST', 'server', null, { command: command.trim(), sent, failed }, '');
  });
});

router.get('/broadcast/history', authenticate, (req, res) => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='broadcast_history'").get();
    const history = row ? JSON.parse(row.value) : [];
    const filtered = req.user.role === 'admin' ? history : history.filter(h => h.user_id === req.user.id);
    res.json(filtered.slice(0, 50));
  } catch (_) { res.json([]); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ANNOUNCE (Nachricht → say + Discord)
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/servers/announce
router.post('/announce', authenticate, requireAdmin, async (req, res) => {
  const {
    message, target = 'running', delay_ms = 0,
    server_command = 'say {message}',
    discord_webhook = '', discord_enabled = false,
    server_ids = null,
  } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message erforderlich' });

  const id = uuidv4();
  res.json({ announce_id: id, message: 'Wird gesendet…' });

  setImmediate(async () => {
    const result = await runAnnounce({ message: message.trim(), target, delay_ms,
      server_command, discord_webhook, discord_enabled, server_ids });
    saveBroadcastHistory({ id, user_id: req.user.id, type: 'announce', command: message.trim(),
      target_count: result.total, sent: result.sent, failed: result.failed,
      discord_ok: result.discord_ok, results: JSON.stringify(result.results) });
    auditLog(req.user.id, 'ANNOUNCE', 'server', null,
      { message: message.trim().slice(0, 80), sent: result.sent, discord: result.discord_ok }, '');
    console.log(`[announce] "${message.slice(0,60)}" → ${result.sent}/${result.total} OK${result.discord_ok !== null ? `, Discord: ${result.discord_ok}` : ''}`);
  });
});

// ── ANNOUNCE SCHEDULES ────────────────────────────────────────────────────────

// GET /api/servers/announce/schedules
router.get('/announce/schedules', authenticate, requireAdmin, (req, res) => {
  const schedules = db.prepare(
    `SELECT as2.*, u.username as created_by_name
     FROM announce_schedules as2
     LEFT JOIN users u ON as2.created_by=u.id
     ORDER BY created_at DESC`
  ).all();
  res.json(schedules);
});

// POST /api/servers/announce/schedules
router.post('/announce/schedules', authenticate, requireAdmin, (req, res) => {
  const {
    name, message, cron = '0 * * * *', target = 'running',
    delay_ms = 0, server_command = 'say {message}',
    discord_webhook = '', discord_enabled = false, enabled = true,
  } = req.body;
  if (!name?.trim())    return res.status(400).json({ error: 'name erforderlich' });
  if (!message?.trim()) return res.status(400).json({ error: 'message erforderlich' });
  if (cron.trim().split(/\s+/).length !== 5) return res.status(400).json({ error: 'Ungültiges Cron-Format (5 Felder)' });

  const id = uuidv4();
  db.prepare(`INSERT INTO announce_schedules
    (id,name,message,cron,target,delay_ms,server_command,discord_webhook,discord_enabled,enabled,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, name.trim(), message.trim(), cron.trim(), target,
    parseInt(delay_ms)||0, server_command||'say {message}',
    discord_webhook||'', discord_enabled?1:0, enabled?1:0, req.user.id);

  auditLog(req.user.id, 'ANNOUNCE_SCHEDULE_CREATE', 'setting', id, { name, cron }, req.ip);
  res.status(201).json(db.prepare('SELECT * FROM announce_schedules WHERE id=?').get(id));
});

// PATCH /api/servers/announce/schedules/:id
router.patch('/announce/schedules/:id', authenticate, requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id FROM announce_schedules WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Zeitplan nicht gefunden' });

  const fields = ['name','message','cron','target','delay_ms','server_command',
                  'discord_webhook','discord_enabled','enabled'];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Keine Änderungen' });
  updates.updated_at = "datetime('now')";

  const setClauses = Object.keys(updates).map(k => k === 'updated_at' ? `${k}=${updates[k]}` : `${k}=?`).join(',');
  const values     = Object.entries(updates).filter(([k]) => k !== 'updated_at').map(([,v]) => v);
  db.prepare(`UPDATE announce_schedules SET ${setClauses} WHERE id=?`).run(...values, req.params.id);

  auditLog(req.user.id, 'ANNOUNCE_SCHEDULE_UPDATE', 'setting', req.params.id, {}, req.ip);
  res.json(db.prepare('SELECT * FROM announce_schedules WHERE id=?').get(req.params.id));
});

// DELETE /api/servers/announce/schedules/:id
router.delete('/announce/schedules/:id', authenticate, requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id,name FROM announce_schedules WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Zeitplan nicht gefunden' });
  db.prepare('DELETE FROM announce_schedules WHERE id=?').run(req.params.id);
  auditLog(req.user.id, 'ANNOUNCE_SCHEDULE_DELETE', 'setting', req.params.id, { name: row.name }, req.ip);
  res.json({ success: true });
});

// POST /api/servers/announce/schedules/:id/run  — sofort auslösen
router.post('/announce/schedules/:id/run', authenticate, requireAdmin, async (req, res) => {
  const sched = db.prepare('SELECT * FROM announce_schedules WHERE id=?').get(req.params.id);
  if (!sched) return res.status(404).json({ error: 'Zeitplan nicht gefunden' });

  res.json({ success: true, message: `"${sched.name}" wird ausgeführt…` });

  setImmediate(async () => {
    await executeAnnounceSchedule(sched);
  });
});

// ── INTERNER SCHEDULER-AUFRUF ─────────────────────────────────────────────────
async function executeAnnounceSchedule(sched) {
  try {
    const result = await runAnnounce({
      message:         sched.message,
      target:          sched.target,
      delay_ms:        sched.delay_ms || 0,
      server_command:  sched.server_command || 'say {message}',
      discord_webhook: sched.discord_webhook,
      discord_enabled: !!sched.discord_enabled,
    });

    const resultStr = `✅ ${result.sent}/${result.total} Server${result.discord_ok ? ' + Discord' : result.discord_ok === false ? ' (Discord fehlgeschlagen)' : ''}`;
    db.prepare("UPDATE announce_schedules SET last_run_at=datetime('now'), last_result=?, updated_at=datetime('now') WHERE id=?")
      .run(resultStr, sched.id);
    console.log(`[announce-schedule] "${sched.name}": ${resultStr}`);

    saveBroadcastHistory({ id: uuidv4(), user_id: sched.created_by || 'system', type: 'announce_schedule',
      command: sched.message, schedule_name: sched.name, target_count: result.total,
      sent: result.sent, failed: result.failed, discord_ok: result.discord_ok,
      results: JSON.stringify(result.results) });
  } catch (e) {
    const errStr = `❌ Fehler: ${e.message.slice(0, 100)}`;
    db.prepare("UPDATE announce_schedules SET last_run_at=datetime('now'), last_result=? WHERE id=?")
      .run(errStr, sched.id);
    console.warn(`[announce-schedule] "${sched.name}" Fehler:`, e.message);
  }
}

// ── SCHEDULER TICK (jede Minute aufgerufen) ───────────────────────────────────
function matchCron(expr, now) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  return [[min, now.getMinutes()],[hour, now.getHours()],[dom, now.getDate()],
          [mon, now.getMonth()+1],[dow, now.getDay()]].every(([e, v]) => {
    if (e === '*') return true;
    const step = e.match(/^\*\/(\d+)$/); if (step) return v % parseInt(step[1]) === 0;
    const range = e.match(/^(\d+)-(\d+)$/); if (range) return v >= +range[1] && v <= +range[2];
    return parseInt(e) === v;
  });
}

async function announceScheduleTick() {
  const now = new Date();
  try {
    const schedules = db.prepare("SELECT * FROM announce_schedules WHERE enabled=1").all();
    for (const sched of schedules) {
      if (!matchCron(sched.cron, now)) continue;
      executeAnnounceSchedule(sched).catch(e =>
        console.warn(`[announce-tick] ${sched.name}:`, e.message));
    }
  } catch (e) {
    console.warn('[announce-tick] Fehler:', e.message);
  }
}

module.exports = router;
module.exports.announceScheduleTick = announceScheduleTick;
