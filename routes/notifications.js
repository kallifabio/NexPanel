'use strict';
/**
 * routes/notifications.js — Benachrichtigungs-Einstellungen pro Server
 *
 * GET    /api/servers/:id/notifications          — Einstellungen lesen
 * PUT    /api/servers/:id/notifications          — Einstellungen speichern
 * POST   /api/servers/:id/notifications/test     — Test senden
 * GET    /api/admin/smtp                         — SMTP-Konfiguration (Admin)
 * PUT    /api/admin/smtp                         — SMTP-Konfiguration (Admin)
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../src/core/db');
const { authenticate, requireAdmin } = require('./auth');
const { sendTestNotification, resetTransporter } = require('../src/core/notifications');

const router = express.Router({ mergeParams: true });

const ALL_EVENTS = [
  'crash', 'start', 'stop',
  'disk_warning', 'disk_critical', 'disk_exceeded',
  'backup_done', 'backup_failed', 'restore_done',
];

function canAccess(req, res, next) {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (req.user.role !== 'admin' && srv.user_id !== req.user.id)
    return res.status(403).json({ error: 'Kein Zugriff' });
  req.srv = srv;
  next();
}

// ─── EINSTELLUNGEN LESEN ──────────────────────────────────────────────────────
router.get('/', authenticate, canAccess, (req, res) => {
  let s = db.prepare('SELECT * FROM notification_settings WHERE server_id=?').get(req.params.serverId);
  if (!s) {
    // Defaults zurückgeben ohne zu speichern
    s = {
      server_id: req.params.serverId,
      discord_webhook: '', discord_enabled: 0,
      discord_events: JSON.stringify(['crash','disk_warning','backup_done','backup_failed']),
      email_to: '', email_enabled: 0,
      email_events: JSON.stringify(['crash','disk_warning']),
    };
  }
  res.json({
    ...s,
    discord_events: JSON.parse(s.discord_events || '[]'),
    email_events:   JSON.parse(s.email_events   || '[]'),
    available_events: ALL_EVENTS,
  });
});

// ─── EINSTELLUNGEN SPEICHERN ──────────────────────────────────────────────────
router.put('/', authenticate, canAccess, (req, res) => {
  try {
    const {
      discord_webhook = '', discord_enabled = false, discord_events = [],
      email_to = '',        email_enabled   = false, email_events   = [],
    } = req.body;

    const invalidDisc = discord_events.filter(e => !ALL_EVENTS.includes(e));
    const invalidMail = email_events.filter(e => !ALL_EVENTS.includes(e));
    if (invalidDisc.length) return res.status(400).json({ error: `Unbekannte Events: ${invalidDisc.join(', ')}` });
    if (invalidMail.length) return res.status(400).json({ error: `Unbekannte Events: ${invalidMail.join(', ')}` });

    const existing = db.prepare('SELECT id FROM notification_settings WHERE server_id=?').get(req.params.serverId);

    if (existing) {
      db.prepare(`UPDATE notification_settings SET
        discord_webhook=?, discord_enabled=?, discord_events=?,
        email_to=?, email_enabled=?, email_events=?,
        updated_at=datetime('now') WHERE server_id=?
      `).run(
        discord_webhook, discord_enabled ? 1 : 0, JSON.stringify(discord_events),
        email_to, email_enabled ? 1 : 0, JSON.stringify(email_events),
        req.params.serverId,
      );
    } else {
      db.prepare(`INSERT INTO notification_settings
        (id, server_id, discord_webhook, discord_enabled, discord_events, email_to, email_enabled, email_events)
        VALUES (?,?,?,?,?,?,?,?)`
      ).run(
        uuidv4(), req.params.serverId,
        discord_webhook, discord_enabled ? 1 : 0, JSON.stringify(discord_events),
        email_to, email_enabled ? 1 : 0, JSON.stringify(email_events),
      );
    }

    auditLog(req.user.id, 'NOTIFICATION_UPDATE', 'server', req.params.serverId, {}, req.ip);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TEST SENDEN ──────────────────────────────────────────────────────────────
router.post('/test', authenticate, canAccess, async (req, res) => {
  const { channel } = req.body; // 'discord' | 'email'
  if (!['discord','email'].includes(channel))
    return res.status(400).json({ error: 'channel muss "discord" oder "email" sein' });
  try {
    await sendTestNotification(req.params.serverId, channel);
    res.json({ success: true, message: 'Test-Benachrichtigung gesendet' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── SMTP (Admin-only, separater Router-Einsatz in server.js) ─────────────────
const smtpRouter = express.Router();

smtpRouter.get('/', authenticate, requireAdmin, (req, res) => {
  const cfg = db.prepare('SELECT * FROM smtp_config WHERE id=1').get();
  if (!cfg) return res.json({ host:'',port:587,secure:false,user:'',from_addr:'',enabled:false });
  res.json({ ...cfg, password: cfg.password ? '••••••••' : '', secure: !!cfg.secure, enabled: !!cfg.enabled });
});

smtpRouter.put('/', authenticate, requireAdmin, (req, res) => {
  try {
    const { host='', port=587, secure=false, user='', password, from_addr='', enabled=false } = req.body;
    const existing = db.prepare('SELECT password FROM smtp_config WHERE id=1').get();
    const finalPass = (password && password !== '••••••••') ? password : (existing?.password || '');
    db.prepare(`INSERT INTO smtp_config (id,host,port,secure,user,password,from_addr,enabled) VALUES (1,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET host=excluded.host,port=excluded.port,secure=excluded.secure,
      user=excluded.user,password=excluded.password,from_addr=excluded.from_addr,enabled=excluded.enabled`
    ).run(host, parseInt(port)||587, secure?1:0, user, finalPass, from_addr, enabled?1:0);
    resetTransporter();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

smtpRouter.post('/test', authenticate, requireAdmin, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'to erforderlich' });
  try {
    const { sendEmail } = (() => {
      // inline re-import to test live config
      const nodemailer = require('nodemailer');
      const cfg = db.prepare('SELECT * FROM smtp_config WHERE id=1').get();
      if (!cfg || !cfg.host) throw new Error('SMTP nicht konfiguriert');
      const transport = nodemailer.createTransport({
        host: cfg.host, port: cfg.port||587, secure: !!cfg.secure,
        auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
      });
      return { sendEmail: (to, subject, html) => transport.sendMail({ from: cfg.from_addr||'nexpanel@localhost', to, subject, html }) };
    })();
    await sendEmail(to, '[NexPanel] SMTP Test', '<p>SMTP-Konfiguration funktioniert! ✅</p>');
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
module.exports.smtpRouter = smtpRouter;
