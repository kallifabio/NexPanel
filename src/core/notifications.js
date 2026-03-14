'use strict';
/**
 * notifications.js — NexPanel Benachrichtigungs-System
 *
 * Unterstützte Kanäle:
 *   - Discord Webhook (kein extra Paket nötig, plain fetch / http request)
 *   - E-Mail via SMTP (nodemailer falls installiert, sonst Fallback-Log)
 *
 * Unterstützte Events:
 *   crash          — Server unerwartet gestoppt / Container-Exit ≠ 0
 *   start          — Server gestartet
 *   stop           — Server manuell gestoppt
 *   disk_warning   — Disk-Nutzung ≥ 75%
 *   disk_critical  — Disk-Nutzung ≥ 90%
 *   disk_exceeded  — Disk-Limit überschritten
 *   backup_done    — Backup erfolgreich erstellt
 *   backup_failed  — Backup fehlgeschlagen
 *   restore_done   — Backup wiederhergestellt
 */

const https = require('https');
const http  = require('http');
const { db } = require('./db');

// ─── DISCORD WEBHOOK ──────────────────────────────────────────────────────────
const EVENT_COLORS = {
  crash:         0xff4757,
  start:         0x00f5a0,
  stop:          0xf59e0b,
  disk_warning:  0xfbbf24,
  disk_critical: 0xf59e0b,
  disk_exceeded: 0xff4757,
  backup_done:   0x00d4ff,
  backup_failed: 0xff4757,
  restore_done:  0xa78bfa,
  cpu_warn:      0xfbbf24,
  cpu_crit:      0xef4444,
  ram_warn:      0xfbbf24,
  ram_crit:      0xef4444,
  disk_warn:     0xfbbf24,
  disk_crit:     0xef4444,
};

const EVENT_EMOJIS = {
  crash: '💥', start: '▶️', stop: '⏹️',
  disk_warning: '🟡', disk_critical: '🔴', disk_exceeded: '⛔',
  backup_done: '💾', backup_failed: '❌', restore_done: '🔄',
  cpu_warn: '🟡', cpu_crit: '🔴', ram_warn: '🟡', ram_crit: '🔴', disk_warn: '🟡', disk_crit: '🔴',
};

async function sendDiscordWebhook(webhookUrl, event, serverName, message, extra = {}) {
  const color = EVENT_COLORS[event] || 0x64748b;
  const emoji = EVENT_EMOJIS[event] || '🔔';

  const body = JSON.stringify({
    username: 'NexPanel',
    avatar_url: 'https://cdn.jsdelivr.net/gh/phosphor-icons/core@main/assets/fill/server-fill.svg',
    embeds: [{
      title:       `${emoji} ${serverName}`,
      description: message,
      color,
      fields: Object.entries(extra).map(([name, value]) => ({
        name, value: String(value), inline: true,
      })),
      footer: { text: 'NexPanel' },
      timestamp: new Date().toISOString(),
    }],
  });

  return httpPost(webhookUrl, body, { 'Content-Type': 'application/json' });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const mod  = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    };
    const req = mod.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true });
        else reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 100)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── EMAIL (nodemailer, optional) ─────────────────────────────────────────────
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  try {
    const nodemailer = require('nodemailer');
    const cfg = db.prepare('SELECT * FROM smtp_config WHERE id=1').get();
    if (!cfg || !cfg.enabled || !cfg.host) return null;
    _transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port || 587,
      secure: !!cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    });
    return _transporter;
  } catch {
    return null; // nodemailer nicht installiert
  }
}

function resetTransporter() { _transporter = null; }

async function sendEmail(to, subject, html) {
  const transport = getTransporter();
  if (!transport) return;
  const cfg = db.prepare('SELECT * FROM smtp_config WHERE id=1').get();
  await transport.sendMail({
    from: cfg?.from_addr || 'nexpanel@localhost',
    to, subject, html,
  });
}

// ─── HAUPT-DISPATCH ───────────────────────────────────────────────────────────
async function notify(serverId, event, message, extra = {}) {
  try {
    const settings = db.prepare('SELECT * FROM notification_settings WHERE server_id=?').get(serverId);
    const server   = db.prepare('SELECT name FROM servers WHERE id=?').get(serverId);
    const name     = server?.name || serverId.substring(0, 8);

    if (settings) {
      // Discord
      if (settings.discord_enabled && settings.discord_webhook) {
        const events = JSON.parse(settings.discord_events || '[]');
        if (events.includes(event)) {
          sendDiscordWebhook(settings.discord_webhook, event, name, message, extra)
            .catch(e => console.warn('[notify] Discord Fehler:', e.message));
        }
      }

      // E-Mail
      if (settings.email_enabled && settings.email_to) {
        const events = JSON.parse(settings.email_events || '[]');
        if (events.includes(event)) {
          const subject = `[NexPanel] ${EVENT_EMOJIS[event] || '🔔'} ${name} — ${event}`;
          const html = `
            <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
              <div style="background:#0f172a;padding:20px;border-radius:8px">
                <h2 style="color:#00d4ff;margin:0 0 12px">${EVENT_EMOJIS[event] || '🔔'} ${esc(name)}</h2>
                <p style="color:#cbd5e1;margin:0 0 16px">${esc(message)}</p>
                ${Object.entries(extra).map(([k, v]) =>
                  `<div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid #1e293b">
                     <span style="color:#94a3b8">${esc(k)}</span>
                     <span style="color:#f1f5f9;font-family:monospace">${esc(String(v))}</span>
                   </div>`
                ).join('')}
                <p style="color:#64748b;margin:16px 0 0;font-size:12px">NexPanel · ${new Date().toLocaleString('de-DE')}</p>
              </div>
            </div>`;
          sendEmail(settings.email_to, subject, html)
            .catch(e => console.warn('[notify] E-Mail Fehler:', e.message));
        }
      }
    }

    // Outgoing Webhooks — immer triggern (unabhängig von notification_settings)
    try {
      const { dispatchWebhookEvent } = require('../../routes/webhooks');
      dispatchWebhookEvent(event, serverId, { server_name: name, message, ...extra })
        .catch(e => console.warn('[notify] Webhook Fehler:', e.message));
    } catch {}

  } catch (e) {
    console.warn('[notify] Dispatch-Fehler:', e.message);
  }
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ─── TEST-BENACHRICHTIGUNG ────────────────────────────────────────────────────
async function sendTestNotification(serverId, channel) {
  const settings = db.prepare('SELECT * FROM notification_settings WHERE server_id=?').get(serverId);
  if (!settings) throw new Error('Keine Einstellungen gefunden');

  const server = db.prepare('SELECT name FROM servers WHERE id=?').get(serverId);
  const name   = server?.name || 'Test-Server';

  if (channel === 'discord') {
    if (!settings.discord_webhook) throw new Error('Kein Webhook konfiguriert');
    await sendDiscordWebhook(settings.discord_webhook, 'start', name,
      '✅ Test-Benachrichtigung von NexPanel erfolgreich empfangen!',
      { Panel: 'NexPanel', Zeit: new Date().toLocaleString('de-DE') });
  } else if (channel === 'email') {
    if (!settings.email_to) throw new Error('Keine E-Mail-Adresse konfiguriert');
    await sendEmail(settings.email_to,
      `[NexPanel] Test-Benachrichtigung für ${name}`,
      `<p>Test-Benachrichtigung erfolgreich! NexPanel kann E-Mails versenden.</p>`);
  }
}

module.exports = { notify, sendTestNotification, resetTransporter };
