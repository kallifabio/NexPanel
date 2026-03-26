'use strict';
/**
 * routes/ip-whitelist.js — IP-Whitelist + Connection-Log pro Server
 *
 * Endpunkte:
 *   GET    /api/servers/:id/ip-whitelist           — Whitelist + Stats
 *   POST   /api/servers/:id/ip-whitelist           — IP hinzufügen
 *   PUT    /api/servers/:id/ip-whitelist           — Komplette Liste ersetzen
 *   PATCH  /api/servers/:id/ip-whitelist/:ip       — Label/IP bearbeiten
 *   DELETE /api/servers/:id/ip-whitelist/:ip       — IP entfernen
 *   DELETE /api/servers/:id/ip-whitelist           — Gesamte Liste leeren
 *   GET    /api/servers/:id/ip-whitelist/recent    — Letzte verbundene IPs
 *   POST   /api/servers/:id/ip-whitelist/check     — IP gegen Whitelist prüfen
 */

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../src/core/db');
const { authenticate, canAccessServer } = require('./auth');

const router = express.Router({ mergeParams: true });

// ─── IP-Validierung ───────────────────────────────────────────────────────────
function isValidEntry(entry) {
  if (!entry || typeof entry !== 'string') return false;
  const e = entry.trim();
  if (e === '*') return true;
  // IPv4 mit optionalem CIDR /0–32
  if (/^(\d{1,3}\.){3}\d{1,3}(\/([0-9]|[12]\d|3[0-2]))?$/.test(e)) {
    // Validate octets
    const [ip] = e.split('/');
    return ip.split('.').every(o => parseInt(o) <= 255);
  }
  // IPv6 (basic)
  if (/^[0-9a-fA-F:]{2,39}$/.test(e)) return true;
  // IPv6 with CIDR
  if (/^[0-9a-fA-F:]{2,39}\/\d{1,3}$/.test(e)) return true;
  return false;
}

// ─── Whitelist laden / speichern ──────────────────────────────────────────────
function getWhitelist(serverId) {
  const row = db.prepare('SELECT allowed_ips FROM servers WHERE id=?').get(serverId);
  if (!row) return [];
  try { return JSON.parse(row.allowed_ips || '[]'); } catch { return []; }
}

function saveWhitelist(serverId, ips) {
  db.prepare("UPDATE servers SET allowed_ips=?, updated_at=datetime('now') WHERE id=?")
    .run(JSON.stringify(ips), serverId);
}

function normalizeEntry(raw, label = '') {
  const ip = raw.trim();
  return label.trim() ? { ip, label: label.trim() } : ip;
}

function entryIp(e) { return typeof e === 'object' ? e.ip : e; }
function entryLabel(e) { return typeof e === 'object' ? (e.label || '') : ''; }

// ─── CIDR-Matching ────────────────────────────────────────────────────────────
function ipToNum(ip) {
  return ip.split('.').reduce((acc, b) => ((acc << 8) + parseInt(b)) >>> 0, 0);
}

function matchesCIDR(clientIp, cidr) {
  try {
    const [range, bits] = cidr.split('/');
    const mask = bits ? (~((1 << (32 - parseInt(bits))) - 1)) >>> 0 : 0xFFFFFFFF;
    return (ipToNum(clientIp) & mask) === (ipToNum(range) & mask);
  } catch { return false; }
}

// ─── isAllowed (exported für Middleware) ──────────────────────────────────────
function isAllowed(serverId, clientIp) {
  const list = getWhitelist(serverId);
  if (!list || list.length === 0) return true;

  const ip = (clientIp || '').replace(/^::ffff:/, '').split('%')[0].trim();

  return list.some(entry => {
    const e = entryIp(entry);
    if (!e) return false;
    if (e === '*') return true;
    if (e === ip)  return true;
    if (e.includes('/') && !e.includes(':')) return matchesCIDR(ip, e);
    return false;
  });
}

// ─── IP-Log schreiben ─────────────────────────────────────────────────────────
function logIpEvent(serverId, ip, userId, event = 'connect', userAgent = '') {
  try {
    const cleanIp = (ip || '').replace(/^::ffff:/, '').split('%')[0].trim();
    if (!cleanIp || cleanIp === '::1' || cleanIp === '127.0.0.1') return;
    
    db.prepare(`
      INSERT INTO server_ip_log (id, server_id, ip, user_id, event, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), serverId, cleanIp, userId || null, event, userAgent || '');

    // Keep only last 200 entries per server
    db.prepare(`
      DELETE FROM server_ip_log WHERE server_id=? AND id NOT IN (
        SELECT id FROM server_ip_log WHERE server_id=? ORDER BY connected_at DESC LIMIT 200
      )
    `).run(serverId, serverId);
  } catch (_) {}
}

// ─── GET /api/servers/:id/ip-whitelist ────────────────────────────────────────
router.get('/', authenticate, canAccessServer, (req, res) => {
  const list = getWhitelist(req.params.id);

  // Aggregate recent unique IPs
  const recentUnique = db.prepare(`
    SELECT ip, MAX(connected_at) as last_seen, COUNT(*) as hits,
           GROUP_CONCAT(DISTINCT event) as events
    FROM server_ip_log
    WHERE server_id=? AND connected_at > datetime('now','-7 days')
    GROUP BY ip ORDER BY last_seen DESC LIMIT 20
  `).all(req.params.id);

  res.json({
    allowed_ips: list,
    enabled:     list.length > 0,
    entries: list.map(e => ({
      ip:    entryIp(e),
      label: entryLabel(e),
    })),
    recent_ips: recentUnique,
  });
});

// ─── POST /api/servers/:id/ip-whitelist ── IP hinzufügen ──────────────────────
router.post('/', authenticate, canAccessServer, (req, res) => {
  const { ip, label = '' } = req.body;
  if (!ip?.trim()) return res.status(400).json({ error: 'ip erforderlich' });
  if (!isValidEntry(ip.trim())) return res.status(400).json({ error: 'Ungültige IP / CIDR-Notation. Erlaubt: 1.2.3.4, 1.2.3.0/24, ::1, *' });

  const list = getWhitelist(req.params.id);
  if (list.some(e => entryIp(e) === ip.trim())) {
    return res.status(409).json({ error: `${ip.trim()} ist bereits in der Whitelist` });
  }

  list.push(normalizeEntry(ip, label));
  saveWhitelist(req.params.id, list);
  auditLog(req.user.id, 'IP_WHITELIST_ADD', 'server', req.params.id, { ip: ip.trim() }, req.ip);
  res.status(201).json({ allowed_ips: list, entries: list.map(e => ({ ip: entryIp(e), label: entryLabel(e) })) });
});

// ─── PUT /api/servers/:id/ip-whitelist ── Komplette Liste ersetzen ────────────
router.put('/', authenticate, canAccessServer, (req, res) => {
  const { allowed_ips = [], entries = [] } = req.body;
  
  // Support both flat string array and {ip, label} objects
  const raw = entries.length ? entries : allowed_ips;
  if (!Array.isArray(raw)) return res.status(400).json({ error: 'Array erforderlich' });

  const normalized = [];
  const invalid = [];
  for (const item of raw) {
    const ip    = typeof item === 'object' ? item.ip : item;
    const label = typeof item === 'object' ? (item.label || '') : '';
    if (!ip?.trim()) continue;
    if (!isValidEntry(ip.trim())) { invalid.push(ip); continue; }
    normalized.push(normalizeEntry(ip, label));
  }

  if (invalid.length) return res.status(400).json({ error: `Ungültige Einträge: ${invalid.join(', ')}` });

  // Deduplicate
  const seen = new Set();
  const deduped = normalized.filter(e => {
    const k = entryIp(e);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  saveWhitelist(req.params.id, deduped);
  auditLog(req.user.id, 'IP_WHITELIST_UPDATE', 'server', req.params.id, { count: deduped.length }, req.ip);
  res.json({ allowed_ips: deduped, entries: deduped.map(e => ({ ip: entryIp(e), label: entryLabel(e) })) });
});

// ─── PATCH /api/servers/:id/ip-whitelist/:ip ── Label/IP bearbeiten ──────────
router.patch('/:targetIp', authenticate, canAccessServer, (req, res) => {
  const targetIp = decodeURIComponent(req.params.targetIp);
  const list = getWhitelist(req.params.id);
  const idx  = list.findIndex(e => entryIp(e) === targetIp);
  if (idx === -1) return res.status(404).json({ error: 'IP nicht gefunden' });

  const { ip: newIp, label } = req.body;
  const finalIp    = newIp?.trim() || targetIp;
  const finalLabel = label !== undefined ? label : entryLabel(list[idx]);

  if (newIp && !isValidEntry(finalIp)) return res.status(400).json({ error: 'Ungültige IP / CIDR-Notation' });

  list[idx] = finalLabel ? { ip: finalIp, label: finalLabel } : finalIp;
  saveWhitelist(req.params.id, list);
  res.json({ allowed_ips: list, entries: list.map(e => ({ ip: entryIp(e), label: entryLabel(e) })) });
});

// ─── DELETE /api/servers/:id/ip-whitelist/:ip ── IP entfernen ─────────────────
router.delete('/:targetIp', authenticate, canAccessServer, (req, res) => {
  const targetIp = decodeURIComponent(req.params.targetIp);
  let list = getWhitelist(req.params.id);
  const before = list.length;
  list = list.filter(e => entryIp(e) !== targetIp);
  if (list.length === before) return res.status(404).json({ error: 'IP nicht in der Whitelist' });
  saveWhitelist(req.params.id, list);
  auditLog(req.user.id, 'IP_WHITELIST_REMOVE', 'server', req.params.id, { ip: targetIp }, req.ip);
  res.json({ allowed_ips: list, entries: list.map(e => ({ ip: entryIp(e), label: entryLabel(e) })) });
});

// ─── DELETE /api/servers/:id/ip-whitelist ── Gesamte Liste leeren ────────────
router.delete('/', authenticate, canAccessServer, (req, res) => {
  saveWhitelist(req.params.id, []);
  auditLog(req.user.id, 'IP_WHITELIST_CLEAR', 'server', req.params.id, {}, req.ip);
  res.json({ allowed_ips: [], entries: [], enabled: false });
});

// ─── GET /api/servers/:id/ip-whitelist/recent ── Letzte IPs ──────────────────
router.get('/recent', authenticate, canAccessServer, (req, res) => {
  const days  = Math.min(parseInt(req.query.days  || '30'), 90);
  const limit = Math.min(parseInt(req.query.limit || '50'), 200);

  const rows = db.prepare(`
    SELECT ip,
           MAX(connected_at) as last_seen,
           MIN(connected_at) as first_seen,
           COUNT(*)          as hit_count,
           GROUP_CONCAT(DISTINCT event) as events,
           GROUP_CONCAT(DISTINCT user_id) as user_ids
    FROM server_ip_log
    WHERE server_id=? AND connected_at > datetime('now','-' || ? || ' days')
    GROUP BY ip
    ORDER BY last_seen DESC
    LIMIT ?
  `).all(req.params.id, days, limit);

  const whitelist = getWhitelist(req.params.id);
  const wlSet     = new Set(whitelist.map(e => entryIp(e)));

  res.json(rows.map(r => ({
    ...r,
    is_whitelisted: wlSet.has(r.ip),
    is_blocked:     whitelist.length > 0 && !isAllowed(req.params.id, r.ip),
  })));
});

// ─── POST /api/servers/:id/ip-whitelist/check ── Test-Endpunkt ───────────────
router.post('/check', authenticate, canAccessServer, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip erforderlich' });
  const allowed = isAllowed(req.params.id, ip.trim());
  res.json({ ip: ip.trim(), allowed, whitelist_active: getWhitelist(req.params.id).length > 0 });
});

module.exports = router;
module.exports.isAllowed  = isAllowed;
module.exports.logIpEvent = logIpEvent;
