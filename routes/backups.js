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
const { db, auditLog } = require('../src/core/db');
const { authenticate } = require('./auth');
const { routeToNode }  = require('../src/docker/node-router');
const { notify }       = require('../src/core/notifications');

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



// ─── BACKUP-ZEITPLAN (Auto-Backup) ────────────────────────────────────────────

// GET  /api/servers/:serverId/backups/schedule
router.get('/schedule', authenticate, canAccess, (req, res) => {
  let schedule = db.prepare('SELECT * FROM backup_schedules WHERE server_id=?')
    .get(req.params.serverId);

  if (!schedule) {
    // Defaults zurückgeben ohne zu speichern
    schedule = {
      server_id:     req.params.serverId,
      enabled:       0,
      cron:          '0 4 * * *',
      keep_count:    5,
      name_template: 'Auto {date} {time}',
      last_run_at:   null,
      last_result:   null,
    };
  }
  res.json(schedule);
});

// PUT  /api/servers/:serverId/backups/schedule
router.put('/schedule', authenticate, canAccess, (req, res) => {
  const {
    enabled = 0, cron = '0 4 * * *',
    keep_count = 5, name_template = 'Auto {date} {time}',
  } = req.body;

  // Cron-Format prüfen (5 Felder)
  if (cron && cron.trim().split(/\s+/).length !== 5) {
    return res.status(400).json({ error: 'Ungültiges Cron-Format (5 Felder erwartet: min h dom mon dow)' });
  }
  if (keep_count < 1 || keep_count > 50) {
    return res.status(400).json({ error: 'keep_count muss zwischen 1 und 50 liegen' });
  }

  const exists = db.prepare('SELECT id FROM backup_schedules WHERE server_id=?')
    .get(req.params.serverId);

  if (exists) {
    db.prepare(`
      UPDATE backup_schedules
      SET enabled=?, cron=?, keep_count=?, name_template=?, updated_at=datetime('now')
      WHERE server_id=?
    `).run(enabled ? 1 : 0, cron.trim(), keep_count, name_template, req.params.serverId);
  } else {
    const { v4: uuid4 } = require('uuid');
    db.prepare(`
      INSERT INTO backup_schedules (id, server_id, enabled, cron, keep_count, name_template)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuid4(), req.params.serverId, enabled ? 1 : 0, cron.trim(), keep_count, name_template);
  }

  auditLog(req.user.id, 'BACKUP_SCHEDULE_UPDATE', 'server', req.params.serverId,
    { enabled: !!enabled, cron }, req.ip);

  res.json(db.prepare('SELECT * FROM backup_schedules WHERE server_id=?').get(req.params.serverId));
});

// POST /api/servers/:serverId/backups/schedule/run — manuell auslösen
router.post('/schedule/run', authenticate, canAccess, async (req, res) => {
  const schedule = db.prepare('SELECT * FROM backup_schedules WHERE server_id=?')
    .get(req.params.serverId);

  if (!schedule) return res.status(404).json({ error: 'Kein Backup-Zeitplan konfiguriert' });

  const srv = req.srv;
  if (!srv.container_id) return res.status(400).json({ error: 'Server hat keinen Container' });

  // Sofort auslösen (async)
  res.json({ success: true, message: 'Auto-Backup wird erstellt…' });

  const { autoBackupTick } = require('../src/mods/auto-backup-scheduler');
  const { runAutoBackup: _r } = require('../src/mods/auto-backup-scheduler');

  // Direkt den runAutoBackup aus dem Modul aufrufen
  try {
    const { autoBackupTick: _t, ...mod } = require('../src/mods/auto-backup-scheduler');
    // Re-require mit Zugriff auf interne Funktion via Tick
    // Stattdessen: Backup direkt wie im normalen Flow erstellen
    const { v4: uuid4 } = require('uuid');
    const path_ = require('path');
    const name_tmpl = schedule.name_template || 'Auto {date} {time}';
    const now = new Date();
    const date = now.toLocaleDateString('de-DE', { year:'numeric', month:'2-digit', day:'2-digit' }).split('.').reverse().join('-');
    const time = now.toTimeString().slice(0, 5).replace(':', '-');
    const backupName = name_tmpl.replace(/\{date\}/g, date).replace(/\{time\}/g, time).replace(/\{server\}/g, srv.name || '');
    const backupId   = uuid4();
    const dir        = path_.join(process.env.BACKUP_PATH ? require('path').resolve(process.env.BACKUP_PATH) : path_.join(__dirname, '..', 'backups'), srv.id);
    require('fs').mkdirSync(dir, { recursive: true });
    const filePath   = path_.join(dir, `${backupId}.tar.gz`);

    db.prepare("INSERT INTO server_backups (id,server_id,name,note,file_path,status,created_by) VALUES (?,?,?,'Manuell ausgelöst',?,'creating',?)")
      .run(backupId, srv.id, backupName, filePath, req.user.id);

    setImmediate(async () => {
      try {
        await routeToNode(srv.node_id, {
          type:'backup.create', server_id:srv.id, container_id:srv.container_id,
          backup_id:backupId, file_path:filePath, image:srv.image||'', work_dir:srv.work_dir||'/home/container',
        }, 300_000);
        let sizeBytes = 0;
        try { sizeBytes = require('fs').statSync(filePath).size; } catch(_){}
        db.prepare("UPDATE server_backups SET status='ready', size_bytes=? WHERE id=?").run(sizeBytes, backupId);
        db.prepare("UPDATE backup_schedules SET last_run_at=datetime('now'), last_result=? WHERE server_id=?")
          .run(`✅ Manuell (${Math.round(sizeBytes/1024/1024*10)/10} MB)`, srv.id);
        notify(srv.id,'backup_done',`Auto-Backup "${backupName}" erstellt.`,{}).catch(()=>{});
      } catch(e) {
        db.prepare("UPDATE server_backups SET status='failed', note=? WHERE id=?").run('Fehler: '+e.message.slice(0,190), backupId);
        db.prepare("UPDATE backup_schedules SET last_result=? WHERE server_id=?").run('❌ Fehler: '+e.message.slice(0,190), srv.id);
      }
    });
  } catch (e) { console.error('[backup/schedule/run]', e.message); }
});

module.exports = router;
module.exports.BACKUP_BASE = BACKUP_BASE;
