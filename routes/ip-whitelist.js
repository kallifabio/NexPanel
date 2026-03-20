'use strict';
/**
 * routes/ip-whitelist.js — IP-Whitelist pro Server
 *
 * Beschränkt den WebSocket-Konsolen-Zugriff und Panel-API auf erlaubte IPs.
 * Leere Liste = kein Limit (alle IPs erlaubt).
 *
 * Endpunkte:
 *   GET    /api/servers/:id/ip-whitelist     — Liste abrufen
 *   PUT    /api/servers/:id/ip-whitelist     — Liste komplett setzen
 *   POST   /api/servers/:id/ip-whitelist     — IP hinzufügen
 *   DELETE /api/servers/:id/ip-whitelist/:ip — IP entfernen
 */

const express = require('express');
const { db, auditLog } = require('../src/core/db');
const { authenticate, canAccessServer } = require('./auth');

const router = express.Router({ mergeParams: true });

// ─── IP-Validierung ───────────────────────────────────────────────────────────
function isValidCIDR(entry) {
  // Akzeptiert: IPv4, IPv4-CIDR, IPv6, "*" (Wildcard)
  if (entry === '*') return true;
  // IPv4 CIDR
  if (/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(entry)) return true;
  // IPv6
  if (/^[0-9a-fA-F:]+$/.test(entry)) return true;
  return false;
}

// ─── Whitelist laden/speichern ────────────────────────────────────────────────
function getWhitelist(serverId) {
  const row = db.prepare('SELECT allowed_ips FROM servers WHERE id=?').get(serverId);
  if (!row) return [];
  try { return JSON.parse(row.allowed_ips || '[]'); } catch { return []; }
}

function saveWhitelist(serverId, ips) {
  db.prepare("UPDATE servers SET allowed_ips=?, updated_at=datetime('now') WHERE id=?")
    .run(JSON.stringify(ips), serverId);
}

// ─── Export-Funktion für Middleware ──────────────────────────────────────────
function isAllowed(serverId, clientIp) {
  const list = getWhitelist(serverId);
  if (!list || list.length === 0) return true; // Leer = alle erlaubt

  // Normalisiere die Client-IP (IPv6-mapped IPv4: ::ffff:1.2.3.4)
  const ip = clientIp?.replace(/^::ffff:/, '') || '';

  return list.some(entry => {
    if (entry === '*') return true;
    if (entry === ip)  return true;
    // CIDR-Check (nur IPv4)
    if (entry.includes('/')) {
      try {
        const [range, bits] = entry.split('/');
        const mask = ~((1 << (32 - parseInt(bits))) - 1);
        const toNum = (a) => a.split('.').reduce((acc, b) => (acc << 8) + parseInt(b), 0) >>> 0;
        return (toNum(ip) & mask) === (toNum(range) & mask);
      } catch { return false; }
    }
    return false;
  });
}

// ──────────────────────────────────────────────────────────────────────────────

// GET /api/servers/:id/ip-whitelist
router.get('/', authenticate, canAccessServer, (req, res) => {
  const list = getWhitelist(req.params.id);
  res.json({ allowed_ips: list, enabled: list.length > 0 });
});

// PUT /api/servers/:id/ip-whitelist — komplette Liste ersetzen
router.put('/', authenticate, canAccessServer, (req, res) => {
  const { allowed_ips } = req.body;
  if (!Array.isArray(allowed_ips)) return res.status(400).json({ error: 'allowed_ips Array erforderlich' });

  const invalid = allowed_ips.filter(ip => !isValidCIDR(ip));
  if (invalid.length) return res.status(400).json({ error: `Ungültige IPs/CIDRs: ${invalid.join(', ')}` });

  const unique = [...new Set(allowed_ips.map(ip => ip.trim()).filter(Boolean))];
  saveWhitelist(req.params.id, unique);
  auditLog(req.user.id, 'IP_WHITELIST_UPDATE', 'server', req.params.id, { count: unique.length }, req.ip);
  res.json({ allowed_ips: unique, enabled: unique.length > 0 });
});

// POST /api/servers/:id/ip-whitelist — einzelne IP hinzufügen
router.post('/', authenticate, canAccessServer, (req, res) => {
  const { ip, label = '' } = req.body;
  if (!ip?.trim()) return res.status(400).json({ error: 'ip erforderlich' });
  if (!isValidCIDR(ip.trim())) return res.status(400).json({ error: 'Ungültige IP / CIDR-Notation' });

  const list = getWhitelist(req.params.id);
  if (list.includes(ip.trim())) return res.status(409).json({ error: 'IP bereits in der Whitelist' });

  // Store as {ip, label} or plain string
  const entry = label ? { ip: ip.trim(), label } : ip.trim();
  list.push(entry);
  saveWhitelist(req.params.id, list);
  auditLog(req.user.id, 'IP_WHITELIST_ADD', 'server', req.params.id, { ip }, req.ip);
  res.status(201).json({ allowed_ips: list });
});

// DELETE /api/servers/:id/ip-whitelist/:ip
router.delete('/:ip', authenticate, canAccessServer, (req, res) => {
  const targetIp = decodeURIComponent(req.params.ip);
  let list = getWhitelist(req.params.id);
  const before = list.length;
  list = list.filter(e => {
    const val = typeof e === 'object' ? e.ip : e;
    return val !== targetIp;
  });
  if (list.length === before) return res.status(404).json({ error: 'IP nicht in der Whitelist' });
  saveWhitelist(req.params.id, list);
  auditLog(req.user.id, 'IP_WHITELIST_REMOVE', 'server', req.params.id, { ip: targetIp }, req.ip);
  res.json({ allowed_ips: list });
});

module.exports = router;
module.exports.isAllowed = isAllowed;
