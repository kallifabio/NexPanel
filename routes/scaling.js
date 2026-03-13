/**
 * routes/scaling.js — NexPanel Auto-Scaling API
 *
 *  GET  /api/admin/scaling/config           — Konfiguration laden
 *  PUT  /api/admin/scaling/config           — Konfiguration speichern
 *  GET  /api/admin/scaling/scores           — Node-Scores (Live)
 *  POST /api/admin/scaling/preview          — Besten Node für Anforderungen vorhersagen
 *  POST /api/admin/nodes/auto-register      — Node registriert sich selbst (kein Auth nötig)
 */

'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../db');
const { authenticate, requireAdmin } = require('./auth');
const { getBestNode, getAllNodeCapacities, getScalingConfig, saveScalingConfig } = require('../scaling');
const { isConnected } = require('../daemon-hub');

const router = express.Router();

// ─── AUTO-REGISTER: Node registriert sich selbst ─────────────────────────────
// Kein normales Auth — nutzt einen gemeinsamen Auto-Register-Key aus ENV oder Settings
// POST /api/admin/nodes/auto-register
router.post('/nodes/auto-register', async (req, res) => {
  try {
    const { name, fqdn, location = 'Auto', memory_mb = 4096, disk_mb = 51200,
            cpu_overalloc = 1, register_key } = req.body;

    if (!name || !fqdn) return res.status(400).json({ error: 'name und fqdn sind erforderlich' });

    // Register-Key prüfen (aus ENV oder Settings-DB)
    const configuredKey = process.env.AUTO_REGISTER_KEY
      || (() => {
           try {
             const r = db.prepare("SELECT value FROM settings WHERE key='auto_register_key'").get();
             return r?.value || null;
           } catch { return null; }
         })();

    if (!configuredKey) {
      return res.status(403).json({
        error: 'Auto-Register deaktiviert. Setze AUTO_REGISTER_KEY in den Einstellungen.',
      });
    }

    if (register_key !== configuredKey) {
      return res.status(403).json({ error: 'Ungültiger Register-Key' });
    }

    // Prüfen ob Node mit diesem FQDN schon existiert → Update statt Insert
    const existing = db.prepare('SELECT * FROM nodes WHERE fqdn=?').get(fqdn);
    if (existing) {
      // Metadaten aktualisieren, aber Token behalten
      db.prepare(`
        UPDATE nodes SET name=?, location=?, memory_mb=?, disk_mb=?, cpu_overalloc=?,
          status='offline', last_seen=datetime('now') WHERE id=?
      `).run(name, location, memory_mb, disk_mb, cpu_overalloc, existing.id);

      return res.json({
        node_id:      existing.id,
        token_prefix: existing.token_prefix,
        updated:      true,
        message:      'Node-Metadaten aktualisiert. Token unverändert.',
      });
    }

    // Neuen Node anlegen
    const id         = uuidv4();
    const token      = 'hpd_' + crypto.randomBytes(32).toString('hex');
    const hash       = await bcrypt.hash(token, 10);
    const prefix     = token.substring(0, 12);
    const isDefault  = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c === 0 ? 1 : 0;

    db.prepare(`
      INSERT INTO nodes
        (id,name,fqdn,location,token_hash,token_prefix,is_default,is_local,memory_mb,disk_mb,cpu_overalloc,status)
      VALUES (?,?,?,?,?,?,?,0,?,?,?,'offline')
    `).run(id, name, fqdn, location, hash, prefix, isDefault, memory_mb, disk_mb, cpu_overalloc);

    auditLog(null, 'NODE_AUTO_REGISTER', 'node', id, { name, fqdn, location }, req.ip);

    res.status(201).json({
      node_id:      id,
      token,          // einmalig sichtbar
      token_prefix: prefix,
      created:      true,
      message:      'Node erfolgreich registriert. Starte den Daemon mit node_id und token.',
    });
  } catch (e) {
    console.error('[scaling] auto-register error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── CONFIG ───────────────────────────────────────────────────────────────────
router.get('/scaling/config', authenticate, requireAdmin, (req, res) => {
  const config = getScalingConfig();
  // Auto-Register-Key (nur Präfix anzeigen, nicht den vollen Key)
  const keyRow = db.prepare("SELECT value FROM settings WHERE key='auto_register_key'").get();
  const fullKey = process.env.AUTO_REGISTER_KEY || keyRow?.value || null;
  res.json({
    ...config,
    auto_register_enabled: !!fullKey,
    auto_register_key_set: !!fullKey,
    auto_register_key_prefix: fullKey ? fullKey.substring(0, 8) + '…' : null,
  });
});

router.put('/scaling/config', authenticate, requireAdmin, (req, res) => {
  const { enabled, strategy, mem_threshold, disk_threshold, cpu_threshold,
          prefer_connected, allow_offline, auto_register_key } = req.body;

  const merged = saveScalingConfig({
    enabled:          enabled !== undefined  ? (enabled          ? 1 : 0) : undefined,
    strategy:         strategy               || undefined,
    mem_threshold:    mem_threshold          != null ? Number(mem_threshold)  : undefined,
    disk_threshold:   disk_threshold         != null ? Number(disk_threshold) : undefined,
    cpu_threshold:    cpu_threshold          != null ? Number(cpu_threshold)  : undefined,
    prefer_connected: prefer_connected !== undefined ? (prefer_connected ? 1 : 0) : undefined,
    allow_offline:    allow_offline    !== undefined ? (allow_offline    ? 1 : 0) : undefined,
  });

  // Auto-Register-Key speichern (leer = deaktivieren)
  if (auto_register_key !== undefined) {
    if (auto_register_key) {
      db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('auto_register_key',?)")
        .run(auto_register_key);
    } else {
      db.prepare("DELETE FROM settings WHERE key='auto_register_key'").run();
    }
  }

  auditLog(req.user.id, 'SCALING_CONFIG_UPDATE', 'system', null, merged, req.ip);
  res.json({ success: true, config: merged });
});

// ─── LIVE NODE SCORES ─────────────────────────────────────────────────────────
router.get('/scaling/scores', authenticate, requireAdmin, (req, res) => {
  const mem_mb    = parseInt(req.query.mem_mb)    || 0;
  const disk_mb   = parseInt(req.query.disk_mb)   || 0;
  const cpu_cores = parseFloat(req.query.cpu_cores) || 0;
  const required  = { mem_mb, disk_mb, cpu_cores };

  const caps    = getAllNodeCapacities(required);
  const config  = getScalingConfig();
  const preview = config.enabled ? getBestNode(required) : null;

  res.json({
    config,
    nodes: caps,
    best_node_id: preview?.node_id || null,
    best_reason:  preview?.reason  || null,
  });
});

// ─── PREVIEW: Welcher Node für diese Anforderungen? ──────────────────────────
router.post('/scaling/preview', authenticate, (req, res) => {
  const { mem_mb = 512, disk_mb = 5120, cpu_cores = 1, strategy } = req.body;
  const result = getBestNode({ mem_mb, disk_mb, cpu_cores }, strategy);

  if (!result) {
    // Fallback auf is_default wenn Auto-Scaling aus oder kein geeigneter Node
    const def = db.prepare('SELECT * FROM nodes WHERE is_default=1').get()
              || db.prepare('SELECT * FROM nodes ORDER BY created_at ASC').get();
    if (!def) return res.json({ node_id: null, node_name: null, reason: 'Kein Node verfügbar', scores: [] });
    return res.json({ node_id: def.id, node_name: def.name, reason: 'Standard-Node (Auto-Scaling deaktiviert)', scores: [] });
  }

  res.json(result);
});

// ─── AUTO-REGISTER KEY GENERIEREN ────────────────────────────────────────────
router.post('/scaling/generate-key', authenticate, requireAdmin, (req, res) => {
  const key = 'ark_' + crypto.randomBytes(24).toString('hex');
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('auto_register_key',?)").run(key);
  auditLog(req.user.id, 'SCALING_KEY_GENERATED', 'system', null, {}, req.ip);
  res.json({ key });
});

router.delete('/scaling/auto-register-key', authenticate, requireAdmin, (req, res) => {
  db.prepare("DELETE FROM settings WHERE key='auto_register_key'").run();
  res.json({ success: true });
});

module.exports = router;
