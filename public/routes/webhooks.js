'use strict';
/**
 * routes/webhooks.js + webhook-dispatcher.js (in einem File)
 *
 * GET    /api/webhooks              — Eigene Webhooks
 * POST   /api/webhooks              — Webhook erstellen
 * PATCH  /api/webhooks/:id          — Webhook bearbeiten
 * DELETE /api/webhooks/:id          — Webhook löschen
 * POST   /api/webhooks/:id/test     — Test-Request senden
 *
 * Unterstützte Events (identisch mit Notifications):
 *   server.start, server.stop, server.crash,
 *   backup.done, backup.failed, restore.done,
 *   disk.warning, disk.critical, disk.exceeded,
 *   transfer.done
 */

const express = require('express');
const https   = require('https');
const http    = require('http');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../src/core/db');
const { authenticate } = require('./auth');

const router = express.Router();

const ALL_EVENTS = [
  'server.start','server.stop','server.crash',
  'backup.done','backup.failed','restore.done',
  'disk.warning','disk.critical','disk.exceeded',
  'transfer.done',
];

// ─── LISTE ────────────────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const hooks = req.user.role === 'admin'
    ? db.prepare(`SELECT w.*, u.username as owner_name FROM webhooks w JOIN users u ON w.user_id=u.id ORDER BY w.created_at DESC`).all()
    : db.prepare(`SELECT * FROM webhooks WHERE user_id=? ORDER BY created_at DESC`).all(req.user.id);
  res.json(hooks.map(h => ({ ...h, events: JSON.parse(h.events || '[]'), secret: h.secret ? '••••••••' : '' })));
});

// ─── ERSTELLEN ────────────────────────────────────────────────────────────────
router.post('/', authenticate, (req, res) => {
  const { name, url, secret = '', events = [], server_id = null } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
  if (!url?.startsWith('http')) return res.status(400).json({ error: 'Gültige URL erforderlich' });
  const badEvents = events.filter(e => !ALL_EVENTS.includes(e));
  if (badEvents.length) return res.status(400).json({ error: `Unbekannte Events: ${badEvents.join(', ')}` });

  // Überprüfe Zugriff auf server_id falls angegeben
  if (server_id) {
    const srv = db.prepare('SELECT user_id FROM servers WHERE id=?').get(server_id);
    if (!srv || (srv.user_id !== req.user.id && req.user.role !== 'admin'))
      return res.status(403).json({ error: 'Kein Zugriff auf diesen Server' });
  }

  const id = uuidv4();
  db.prepare(`INSERT INTO webhooks (id,user_id,server_id,name,url,secret,events) VALUES (?,?,?,?,?,?,?)`)
    .run(id, req.user.id, server_id || null, name.trim(), url, secret, JSON.stringify(events));
  res.status(201).json({ id, name: name.trim(), url, events, enabled: true });
});

// ─── BEARBEITEN ───────────────────────────────────────────────────────────────
router.patch('/:id', authenticate, (req, res) => {
  const h = db.prepare('SELECT * FROM webhooks WHERE id=?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'Webhook nicht gefunden' });
  if (h.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Kein Zugriff' });

  const name    = req.body.name?.trim()  ?? h.name;
  const url     = req.body.url           ?? h.url;
  const events  = req.body.events        ?? JSON.parse(h.events);
  const enabled = req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : h.enabled;
  const secret  = (req.body.secret && req.body.secret !== '••••••••') ? req.body.secret : h.secret;
  db.prepare("UPDATE webhooks SET name=?,url=?,events=?,enabled=?,secret=? WHERE id=?")
    .run(name, url, JSON.stringify(events), enabled, secret, h.id);
  res.json({ success: true });
});

// ─── LÖSCHEN ──────────────────────────────────────────────────────────────────
router.delete('/:id', authenticate, (req, res) => {
  const h = db.prepare('SELECT * FROM webhooks WHERE id=?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'Webhook nicht gefunden' });
  if (h.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Kein Zugriff' });
  db.prepare('DELETE FROM webhooks WHERE id=?').run(h.id);
  res.json({ success: true });
});

// ─── TEST ─────────────────────────────────────────────────────────────────────
router.post('/:id/test', authenticate, async (req, res) => {
  const h = db.prepare('SELECT * FROM webhooks WHERE id=?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'Webhook nicht gefunden' });
  if (h.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Kein Zugriff' });
  try {
    const result = await fireWebhook(h, 'test', { message: 'NexPanel Test-Webhook', timestamp: new Date().toISOString() });
    res.json({ success: true, status: result.status });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── DISPATCHER ───────────────────────────────────────────────────────────────
async function fireWebhook(hook, event, payload) {
  const body = JSON.stringify({
    event,
    panel: 'NexPanel',
    timestamp: new Date().toISOString(),
    server_id: hook.server_id || null,
    ...payload,
  });

  const signature = hook.secret
    ? 'sha256=' + crypto.createHmac('sha256', hook.secret).update(body).digest('hex')
    : undefined;

  const headers = {
    'Content-Type':  'application/json',
    'User-Agent':    'NexPanel-Webhook/1.0',
    'X-NexPanel-Event': event,
    ...(signature ? { 'X-NexPanel-Signature': signature } : {}),
    'Content-Length': Buffer.byteLength(body),
  };

  return new Promise((resolve, reject) => {
    const u    = new URL(hook.url);
    const mod  = u.protocol === 'https:' ? https : http;
    const req  = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST', headers,
    }, res => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

async function dispatchWebhookEvent(event, serverId, payload = {}) {
  let hooks;
  if (serverId) {
    hooks = db.prepare(
      "SELECT * FROM webhooks WHERE enabled=1 AND (server_id=? OR server_id IS NULL)"
    ).all(serverId);
    // Filter by ownership
    const srv = db.prepare('SELECT user_id FROM servers WHERE id=?').get(serverId);
    if (srv) hooks = hooks.filter(h => h.user_id === srv.user_id || !h.server_id);
  } else {
    hooks = db.prepare("SELECT * FROM webhooks WHERE enabled=1 AND server_id IS NULL").all();
  }

  for (const hook of hooks) {
    const events = JSON.parse(hook.events || '[]');
    if (!events.includes(event)) continue;
    try {
      const result = await fireWebhook(hook, event, payload);
      db.prepare("UPDATE webhooks SET last_fired=datetime('now'),last_status=? WHERE id=?")
        .run(result.status, hook.id);
    } catch (e) {
      db.prepare("UPDATE webhooks SET last_fired=datetime('now'),last_status=0 WHERE id=?").run(hook.id);
      console.warn(`[webhook] ${hook.name} Fehler:`, e.message);
    }
  }
}

module.exports = router;
module.exports.dispatchWebhookEvent = dispatchWebhookEvent;
module.exports.ALL_WEBHOOK_EVENTS   = ALL_EVENTS;
