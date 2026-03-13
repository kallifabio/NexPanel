'use strict';
/**
 * routes/backups.js — Server-Backups
 *
 * Backups werden als .tar.gz im Panel-Dateisystem unter ./backups/<server_id>/ gespeichert.
 * Für lokale Container: docker cp direkt.
 * Für Remote-Nodes: via Daemon-Protokoll (backup.create / backup.restore).
 *
 * Endpunkte:
 *   GET    /api/servers/:id/backups          — Liste
 *   POST   /api/servers/:id/backups          — Backup erstellen
 *   GET    /api/servers/:id/backups/:bid     — Backup-Details
 *   DELETE /api/servers/:id/backups/:bid     — Backup löschen
 *   GET    /api/servers/:id/backups/:bid/download  — Download als .tar.gz
 *   POST   /api/servers/:id/backups/:bid/restore   — Wiederherstellen
 */

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../db');
const { authenticate } = require('./auth');
const { routeToNode }  = require('../node-router');
const { notify }       = require('../notifications');

const router = express.Router({ mergeParams: true });

// ─── HELPER: richtigen Work-Dir ermitteln ────────────────────────────────────
function resolveWorkDir(srv) {
  const image = (srv.image || '').toLowerCase();
  if (image.includes('itzg') || image.includes('minecraft-server')) return '/data';
  if (srv.work_dir && srv.work_dir !== '/home/container') return srv.work_dir;
  return srv.work_dir || '/home/container';
}

// Backups werden hier gespeichert: ./backups/<server_id>/
const BACKUP_BASE = process.env.BACKUP_PATH
  ? path.resolve(process.env.BACKUP_PATH)
  : path.join(__dirname, '..', 'backups');

function backupDir(serverId) {
  const d = path.join(BACKUP_BASE, serverId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function canAccess(req, res, next) {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (req.user.role !== 'admin' && srv.user_id !== req.user.id) {
    const sub = db.prepare(
      "SELECT permissions FROM server_subusers WHERE server_id=? AND user_id=?"
    ).get(req.params.serverId, req.user.id);
    if (!sub) return res.status(403).json({ error: 'Kein Zugriff' });
    const perms = JSON.parse(sub.permissions || '[]');
    if (!perms.includes('backups')) return res.status(403).json({ error: 'Keine Backup-Berechtigung' });
  }
  req.srv = srv;
  next();
}

// ─── LISTE ────────────────────────────────────────────────────────────────────
router.get('/', authenticate, canAccess, (req, res) => {
  const backups = db.prepare(`
    SELECT b.*, u.username as created_by_name
    FROM server_backups b
    LEFT JOIN users u ON b.created_by = u.id
    WHERE b.server_id = ?
    ORDER BY b.created_at DESC
  `).all(req.params.serverId);
  res.json(backups);
});

// ─── BACKUP ERSTELLEN ─────────────────────────────────────────────────────────
router.post('/', authenticate, canAccess, async (req, res) => {
  const srv = req.srv;
  if (!srv.container_id) return res.status(400).json({ error: 'Server hat keinen Container' });

  const { name = `Backup ${new Date().toLocaleString('de-DE')}`, note = '' } = req.body;
  const id       = uuidv4();
  const filename = `${id}.tar.gz`;
  const dir      = backupDir(srv.id);
  const filePath = path.join(dir, filename);

  // In DB als "creating" anlegen — sofortiger Response, Erstellung läuft async
  db.prepare(`
    INSERT INTO server_backups (id, server_id, name, note, file_path, status, created_by)
    VALUES (?, ?, ?, ?, ?, 'creating', ?)
  `).run(id, srv.id, name, note, filePath, req.user.id);

  res.status(202).json({ id, name, status: 'creating' });

  // Async erstellen
  setImmediate(async () => {
    try {
      const result = await routeToNode(srv.node_id, {
        type:         'backup.create',
        server_id:    srv.id,
        container_id: srv.container_id,
        backup_id:    id,
        file_path:    filePath,
        image:        srv.image || '',
        work_dir:     resolveWorkDir(srv),
      }, 300_000); // 5 min Timeout

      const stat    = fs.statSync(filePath);
      const sizeMb  = Math.round(stat.size / 1024 / 1024 * 10) / 10;
      db.prepare("UPDATE server_backups SET status='ready', size_bytes=? WHERE id=?")
        .run(stat.size, id);
      auditLog(req.user.id, 'BACKUP_CREATE', 'server', srv.id,
        { backup_id: id, name, size_mb: sizeMb }, '');
      notify(srv.id, 'backup_done', `Backup "${name}" erfolgreich erstellt.`, { Größe: sizeMb + ' MB' }).catch(() => {});
    } catch (e) {
      const errMsg = e.message || 'Unbekannter Fehler';
      console.error('[backup] Fehler bei Backup', id, ':', errMsg);
      db.prepare("UPDATE server_backups SET status='failed', note=? WHERE id=?")
        .run('Fehler: ' + errMsg.substring(0, 190), id);
      notify(srv.id, 'backup_failed', `Backup "${name}" fehlgeschlagen: ${e.message}`, {}).catch(() => {});
    }
  });
});

// ─── DISK-NUTZUNG (muss VOR /:backupId stehen!) ───────────────────────────────
router.get('/disk-usage', authenticate, canAccess, async (req, res) => {
  try {
    const result = await routeToNode(req.srv.node_id, {
      type:         'disk.usage',
      server_id:    req.srv.id,
      container_id: req.srv.container_id,
      work_dir:     resolveWorkDir(req.srv),
    }, 20_000);
    if (result.bytes_used != null) {
      db.prepare("INSERT INTO disk_usage_log (server_id, bytes_used) VALUES (?,?)").run(req.srv.id, result.bytes_used);
      db.prepare("DELETE FROM disk_usage_log WHERE server_id=? AND recorded_at < datetime('now','-7 days')").run(req.srv.id);
    }
    const bytesLimit = (req.srv.disk_limit || 0) * 1024 * 1024;
    const pct = bytesLimit > 0 ? Math.round((result.bytes_used || 0) / bytesLimit * 100) : 0;
    res.json({ ...result, bytes_limit: bytesLimit, pct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BACKUP DETAILS ───────────────────────────────────────────────────────────
router.get('/:backupId', authenticate, canAccess, (req, res) => {
  const b = db.prepare(`
    SELECT b.*, u.username as created_by_name
    FROM server_backups b LEFT JOIN users u ON b.created_by=u.id
    WHERE b.id=? AND b.server_id=?
  `).get(req.params.backupId, req.params.serverId);
  if (!b) return res.status(404).json({ error: 'Backup nicht gefunden' });
  res.json(b);
});

// ─── BACKUP LÖSCHEN ───────────────────────────────────────────────────────────
router.delete('/:backupId', authenticate, canAccess, (req, res) => {
  const b = db.prepare('SELECT * FROM server_backups WHERE id=? AND server_id=?')
    .get(req.params.backupId, req.params.serverId);
  if (!b) return res.status(404).json({ error: 'Backup nicht gefunden' });

  // Datei löschen (ignoriere Fehler falls schon weg)
  try { if (b.file_path && fs.existsSync(b.file_path)) fs.unlinkSync(b.file_path); } catch {}
  db.prepare('DELETE FROM server_backups WHERE id=?').run(b.id);
  auditLog(req.user.id, 'BACKUP_DELETE', 'server', req.params.serverId, { name: b.name }, req.ip);
  res.json({ success: true });
});

// ─── BACKUP DOWNLOAD ──────────────────────────────────────────────────────────
router.get('/:backupId/download', authenticate, canAccess, (req, res) => {
  const b = db.prepare('SELECT * FROM server_backups WHERE id=? AND server_id=?')
    .get(req.params.backupId, req.params.serverId);
  if (!b) return res.status(404).json({ error: 'Backup nicht gefunden' });
  if (b.status !== 'ready') return res.status(400).json({ error: 'Backup noch nicht bereit' });
  if (!fs.existsSync(b.file_path)) return res.status(404).json({ error: 'Backup-Datei nicht gefunden' });

  const safeName = b.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.tar.gz"`);
  res.setHeader('Content-Type', 'application/gzip');
  res.sendFile(b.file_path);
});

// ─── BACKUP WIEDERHERSTELLEN ──────────────────────────────────────────────────
router.post('/:backupId/restore', authenticate, canAccess, async (req, res) => {
  const b = db.prepare('SELECT * FROM server_backups WHERE id=? AND server_id=?')
    .get(req.params.backupId, req.params.serverId);
  if (!b) return res.status(404).json({ error: 'Backup nicht gefunden' });
  if (b.status !== 'ready') return res.status(400).json({ error: 'Backup nicht verfügbar' });
  if (!fs.existsSync(b.file_path)) return res.status(404).json({ error: 'Backup-Datei nicht gefunden' });

  const srv = req.srv;
  db.prepare("UPDATE server_backups SET status='restoring' WHERE id=?").run(b.id);
  res.json({ success: true, message: 'Wiederherstellung gestartet' });

  setImmediate(async () => {
    try {
      await routeToNode(srv.node_id, {
        type:         'backup.restore',
        server_id:    srv.id,
        container_id: srv.container_id,
        file_path:    b.file_path,
        work_dir:     resolveWorkDir(srv),
      }, 300_000);
      db.prepare("UPDATE server_backups SET status='ready' WHERE id=?").run(b.id);
      auditLog(req.user.id, 'BACKUP_RESTORE', 'server', srv.id,
        { backup_id: b.id, name: b.name }, '');
      notify(srv.id, 'restore_done', `Backup "${b.name}" wiederhergestellt.`, {}).catch(() => {});
    } catch (e) {
      console.error('[restore] Fehler:', e.message);
      db.prepare("UPDATE server_backups SET status='ready' WHERE id=?").run(b.id);
    }
  });
});



module.exports = router;
module.exports.BACKUP_BASE = BACKUP_BASE;
