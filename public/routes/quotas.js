'use strict';
/**
 * routes/quotas.js — User-Ressourcen-Quotas
 *
 * Admins können pro User Limits setzen:
 *   - Max. Anzahl Server
 *   - Max. RAM-Gesamtlimit (MB)
 *   - Max. CPU-Kerne gesamt
 *   - Max. Disk (MB)
 *   - Max. Datenbanken
 *   - Max. Backups
 *
 * Endpunkte:
 *   GET  /api/admin/quotas            — Alle Quotas abrufen
 *   GET  /api/admin/quotas/:userId    — Quota eines Users
 *   PUT  /api/admin/quotas/:userId    — Quota setzen/aktualisieren
 *   DELETE /api/admin/quotas/:userId  — Quota zurücksetzen (auf Defaults)
 *   GET  /api/account/quota           — Eigene Quota + aktuellen Verbrauch
 */

const express = require('express');
const { db, auditLog } = require('../src/core/db');
const { authenticate, requireAdmin } = require('./auth');

const router = express.Router();

// ─── Defaults ────────────────────────────────────────────────────────────────
const QUOTA_DEFAULTS = {
  max_servers:   10,
  max_ram_mb:    8192,
  max_cpu_cores: 8,
  max_disk_mb:   51200,
  max_dbs:       5,
  max_backups:   10,
};

// ─── Verbrauch berechnen ─────────────────────────────────────────────────────
function calcUsage(userId) {
  const servers = db.prepare(
    'SELECT memory_limit, cpu_limit, disk_limit FROM servers WHERE user_id=?'
  ).all(userId);
  const dbCount = db.prepare(
    `SELECT COUNT(*) as c FROM server_databases sd
     JOIN servers s ON sd.server_id=s.id WHERE s.user_id=?`
  ).get(userId)?.c || 0;
  const backupCount = db.prepare(
    `SELECT COUNT(*) as c FROM server_backups sb
     JOIN servers s ON sb.server_id=s.id WHERE s.user_id=? AND sb.status='ready'`
  ).get(userId)?.c || 0;

  return {
    servers:    servers.length,
    ram_mb:     servers.reduce((a, s) => a + (s.memory_limit || 0), 0),
    cpu_cores:  Math.round(servers.reduce((a, s) => a + (s.cpu_limit || 0), 0) * 10) / 10,
    disk_mb:    servers.reduce((a, s) => a + (s.disk_limit || 0), 0),
    dbs:        dbCount,
    backups:    backupCount,
  };
}

// ─── Quota für User holen (mit Defaults falls nicht gesetzt) ─────────────────
function getQuotaForUser(userId) {
  const row = db.prepare('SELECT * FROM user_quotas WHERE user_id=?').get(userId);
  return row || { user_id: userId, ...QUOTA_DEFAULTS };
}

// ─── QUOTA CHECK: wird von servers.js importiert ──────────────────────────────
function checkQuota(userId, newServer = {}) {
  const quota = getQuotaForUser(userId);
  const usage = calcUsage(userId);

  const errors = [];
  if (usage.servers >= quota.max_servers) {
    errors.push(`Server-Limit erreicht (${usage.servers}/${quota.max_servers})`);
  }
  if (newServer.memory_limit && (usage.ram_mb + newServer.memory_limit) > quota.max_ram_mb) {
    errors.push(`RAM-Limit überschritten (${usage.ram_mb + newServer.memory_limit} MB / ${quota.max_ram_mb} MB)`);
  }
  if (newServer.cpu_limit && (usage.cpu_cores + newServer.cpu_limit) > quota.max_cpu_cores) {
    errors.push(`CPU-Limit überschritten (${(usage.cpu_cores + newServer.cpu_limit).toFixed(1)} / ${quota.max_cpu_cores} Kerne)`);
  }
  if (newServer.disk_limit && (usage.disk_mb + newServer.disk_limit) > quota.max_disk_mb) {
    errors.push(`Disk-Limit überschritten (${Math.round((usage.disk_mb + newServer.disk_limit)/1024)} GB / ${Math.round(quota.max_disk_mb/1024)} GB)`);
  }
  return errors;
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/quotas — alle User mit Quota + Verbrauch
router.get('/quotas', authenticate, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, email, role FROM users ORDER BY username').all();
  res.json(users.map(u => {
    const quota = getQuotaForUser(u.id);
    const usage = calcUsage(u.id);
    return { ...u, quota, usage };
  }));
});

// GET /api/admin/quotas/:userId
router.get('/quotas/:userId', authenticate, requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id, username, email FROM users WHERE id=?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  const quota = getQuotaForUser(user.id);
  const usage = calcUsage(user.id);
  res.json({ ...user, quota, usage, defaults: QUOTA_DEFAULTS });
});

// PUT /api/admin/quotas/:userId — Quota setzen
router.put('/quotas/:userId', authenticate, requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

  const {
    max_servers   = QUOTA_DEFAULTS.max_servers,
    max_ram_mb    = QUOTA_DEFAULTS.max_ram_mb,
    max_cpu_cores = QUOTA_DEFAULTS.max_cpu_cores,
    max_disk_mb   = QUOTA_DEFAULTS.max_disk_mb,
    max_dbs       = QUOTA_DEFAULTS.max_dbs,
    max_backups   = QUOTA_DEFAULTS.max_backups,
    note          = '',
  } = req.body;

  db.prepare(`
    INSERT INTO user_quotas (user_id, max_servers, max_ram_mb, max_cpu_cores, max_disk_mb, max_dbs, max_backups, note, updated_at)
    VALUES (?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      max_servers=excluded.max_servers, max_ram_mb=excluded.max_ram_mb,
      max_cpu_cores=excluded.max_cpu_cores, max_disk_mb=excluded.max_disk_mb,
      max_dbs=excluded.max_dbs, max_backups=excluded.max_backups,
      note=excluded.note, updated_at=excluded.updated_at
  `).run(req.params.userId, max_servers, max_ram_mb, max_cpu_cores, max_disk_mb, max_dbs, max_backups, note);

  auditLog(req.user.id, 'QUOTA_UPDATE', 'user', req.params.userId,
    { max_servers, max_ram_mb, max_cpu_cores }, req.ip);

  const quota = getQuotaForUser(req.params.userId);
  const usage = calcUsage(req.params.userId);
  res.json({ quota, usage });
});

// DELETE /api/admin/quotas/:userId — auf Defaults zurücksetzen
router.delete('/quotas/:userId', authenticate, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM user_quotas WHERE user_id=?').run(req.params.userId);
  auditLog(req.user.id, 'QUOTA_RESET', 'user', req.params.userId, {}, req.ip);
  res.json({ success: true, quota: { ...QUOTA_DEFAULTS } });
});

// ══════════════════════════════════════════════════════════════════════════════
// USER SELF-SERVICE
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/account/quota — eigene Quota + Verbrauch
router.get('/account/quota', authenticate, (req, res) => {
  const quota = getQuotaForUser(req.user.id);
  const usage = calcUsage(req.user.id);

  // Calculate percentages
  const pct = (used, max) => max > 0 ? Math.min(100, Math.round(used / max * 100)) : 0;

  res.json({
    quota,
    usage,
    percentages: {
      servers:   pct(usage.servers,   quota.max_servers),
      ram:       pct(usage.ram_mb,    quota.max_ram_mb),
      cpu:       pct(usage.cpu_cores, quota.max_cpu_cores),
      disk:      pct(usage.disk_mb,   quota.max_disk_mb),
      dbs:       pct(usage.dbs,       quota.max_dbs),
      backups:   pct(usage.backups,   quota.max_backups),
    },
  });
});

module.exports = router;
module.exports.checkQuota = checkQuota;
module.exports.getQuotaForUser = getQuotaForUser;
