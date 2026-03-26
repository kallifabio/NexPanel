/**
 * routes/alerts.js — Resource Alert Rules API
 *
 *  GET  /api/servers/:id/alerts        — Regel lesen (legt Default an falls nicht vorhanden)
 *  PUT  /api/servers/:id/alerts        — Regel speichern
 *  POST /api/servers/:id/alerts/test   — Test-Alert auslösen
 */
'use strict';

const express = require('express');
const { db, auditLog } = require('../src/core/db');
const { authenticate } = require('./auth');
const { getOrCreateRule, saveRule, checkResourceAlerts } = require('../src/core/resource-alerts');

const router = express.Router({ mergeParams: true });

function canAccess(req, res, next) {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (req.user.role !== 'admin' && srv.user_id !== req.user.id)
    return res.status(403).json({ error: 'Zugriff verweigert' });
  req.srv = srv;
  next();
}

// ─── LADEN ────────────────────────────────────────────────────────────────────
router.get('/', authenticate, canAccess, (req, res) => {
  const rule = getOrCreateRule(req.params.id);
  let lastFired = {};
  try { lastFired = JSON.parse(rule.last_fired || '{}'); } catch {}
  res.json({ ...rule, last_fired: lastFired });
});

// ─── SPEICHERN ────────────────────────────────────────────────────────────────
router.put('/', authenticate, canAccess, (req, res) => {
  const {
    enabled, cooldown_minutes,
    cpu_warn, cpu_crit,
    ram_warn, ram_crit,
    disk_warn, disk_crit,
  } = req.body;

  // Validierung
  const pct = v => (v === null || v === undefined) ? undefined : Math.min(100, Math.max(0, parseInt(v) || 0));
  const fields = {
    enabled:          enabled !== undefined ? (enabled ? 1 : 0) : undefined,
    cooldown_minutes: cooldown_minutes != null ? Math.min(1440, Math.max(1, parseInt(cooldown_minutes) || 30)) : undefined,
    cpu_warn:  pct(cpu_warn),
    cpu_crit:  pct(cpu_crit),
    ram_warn:  pct(ram_warn),
    ram_crit:  pct(ram_crit),
    disk_warn: pct(disk_warn),
    disk_crit: pct(disk_crit),
  };

  saveRule(req.params.id, fields);
  auditLog(req.user.id, 'ALERT_RULE_UPDATE', 'server', req.params.id, fields, req.ip);

  const rule = getOrCreateRule(req.params.id);
  let lastFired = {};
  try { lastFired = JSON.parse(rule.last_fired || '{}'); } catch {}
  res.json({ ...rule, last_fired: lastFired });
});

// ─── COOLDOWN ZURÜCKSETZEN ────────────────────────────────────────────────────
router.post('/reset-cooldown', authenticate, canAccess, (req, res) => {
  db.prepare("UPDATE resource_alert_rules SET last_fired='{}' WHERE server_id=?").run(req.params.id);
  res.json({ success: true });
});

// ─── TEST-ALERT ───────────────────────────────────────────────────────────────
router.post('/test', authenticate, canAccess, async (req, res) => {
  try {
    // Simuliere Stats nahe einem kritischen Schwellenwert
    await checkResourceAlerts(req.params.id, {
      cpu: 96,
      memory_mb: (req.srv.memory_limit || 512) * 0.97,
      memory_limit_mb: req.srv.memory_limit || 512,
    });
    res.json({ success: true, message: 'Test-Alert ausgelöst (prüfe Discord/E-Mail)' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
