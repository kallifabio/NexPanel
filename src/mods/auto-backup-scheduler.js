'use strict';
/**
 * auto-backup-scheduler.js — Automatische Backup-Zeitpläne
 *
 * Wird vom scheduler.js jede Minute aufgerufen.
 * Prüft alle aktiven Backup-Schedules und erstellt bei Bedarf einen Backup.
 * Löscht automatisch alte Backups gemäß keep_count.
 */

const path = require('path');
const fs   = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../core/db');
const { routeToNode } = require('../docker/node-router');
const { notify } = require('../core/notifications');

const BACKUP_BASE = process.env.BACKUP_PATH
  ? path.resolve(process.env.BACKUP_PATH)
  : path.join(__dirname, 'backups');

function backupDir(serverId) {
  const d = path.join(BACKUP_BASE, serverId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function resolveWorkDir(srv) {
  const image = (srv.image || '').toLowerCase();
  if (image.includes('itzg') || image.includes('minecraft')) return '/data';
  return srv.work_dir || '/home/container';
}

// Cron-Matcher (gleiche Logik wie scheduler.js)
function matchCron(expr, now) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  return [
    [min,  now.getMinutes()],
    [hour, now.getHours()],
    [dom,  now.getDate()],
    [mon,  now.getMonth() + 1],
    [dow,  now.getDay()],
  ].every(([expr, val]) => {
    if (expr === '*') return true;
    const step = expr.match(/^\*\/(\d+)$/);
    if (step) return val % parseInt(step[1]) === 0;
    // Range: 1-5
    const range = expr.match(/^(\d+)-(\d+)$/);
    if (range) return val >= parseInt(range[1]) && val <= parseInt(range[2]);
    return parseInt(expr) === val;
  });
}

// Name-Template: {date} → YYYY-MM-DD, {time} → HH:MM, {server} → Server-Name
function buildBackupName(template, serverName) {
  const now  = new Date();
  const date = now.toLocaleDateString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' })
    .split('.').reverse().join('-');
  const time = now.toTimeString().slice(0, 5).replace(':', '-');
  return (template || 'Auto {date} {time}')
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
    .replace(/\{server\}/g, serverName || 'Server');
}

// Retention: löscht überschüssige Auto-Backups (sortiert nach Datum, älteste zuerst)
async function pruneAutoBackups(serverId, keepCount) {
  const autoBackups = db.prepare(
    `SELECT * FROM server_backups
     WHERE server_id=? AND name LIKE 'Auto %' AND status='ready'
     ORDER BY created_at DESC`
  ).all(serverId);

  const toDelete = autoBackups.slice(keepCount);
  for (const b of toDelete) {
    try {
      if (b.file_path && fs.existsSync(b.file_path)) {
        fs.unlinkSync(b.file_path);
      }
    } catch (_) {}
    db.prepare('DELETE FROM server_backups WHERE id=?').run(b.id);
    console.log(`[auto-backup] Altes Backup gelöscht: "${b.name}" (${serverId})`);
  }
  return toDelete.length;
}

// Einen einzelnen Auto-Backup-Job ausführen
async function runAutoBackup(schedule, srv) {
  const backupId   = uuidv4();
  const backupName = buildBackupName(schedule.name_template, srv.name);
  const dir        = backupDir(srv.id);
  const filePath   = path.join(dir, `${backupId}.tar.gz`);

  // DB-Eintrag anlegen
  db.prepare(
    `INSERT INTO server_backups (id, server_id, name, note, file_path, status, created_by)
     VALUES (?, ?, ?, 'Automatisch erstellt', ?, 'creating', NULL)`
  ).run(backupId, srv.id, backupName, filePath);

  db.prepare(
    `UPDATE backup_schedules SET last_run_at=datetime('now'), last_result='Erstelle Backup…'
     WHERE server_id=?`
  ).run(srv.id);

  try {
    await routeToNode(srv.node_id, {
      type:         'backup.create',
      server_id:    srv.id,
      container_id: srv.container_id,
      backup_id:    backupId,
      file_path:    filePath,
      image:        srv.image || '',
      work_dir:     resolveWorkDir(srv),
    }, 300_000);

    // Dateigröße ermitteln
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(filePath).size; } catch (_) {}
    const sizeMb = Math.round(sizeBytes / 1024 / 1024 * 10) / 10;

    db.prepare("UPDATE server_backups SET status='ready', size_bytes=? WHERE id=?")
      .run(sizeBytes, backupId);

    db.prepare(
      `UPDATE backup_schedules SET last_result=? WHERE server_id=?`
    ).run(`✅ Erfolgreich (${sizeMb} MB)`, srv.id);

    // Retention: alte Backups löschen
    const pruned = await pruneAutoBackups(srv.id, schedule.keep_count || 5);

    notify(srv.id, 'backup_done',
      `Auto-Backup "${backupName}" erstellt (${sizeMb} MB)${pruned ? `, ${pruned} alte gelöscht` : ''}.`,
      { Größe: sizeMb + ' MB' }
    ).catch(() => {});

    // Reset failure counter on success
    db.prepare(`UPDATE backup_schedules
      SET consecutive_failures=0, last_success_at=datetime('now')
      WHERE server_id=?`).run(srv.id);

    console.log(`[auto-backup] ✅ "${backupName}" für Server ${srv.id} (${sizeMb} MB)`);

  } catch (e) {
    const errMsg = (e.message || 'Unbekannter Fehler').substring(0, 200);
    console.error(`[auto-backup] ❌ Backup für ${srv.id} fehlgeschlagen:`, errMsg);

    db.prepare("UPDATE server_backups SET status='failed', note=? WHERE id=?")
      .run('Fehler: ' + errMsg, backupId);
    db.prepare("UPDATE backup_schedules SET last_result=? WHERE server_id=?")
      .run('❌ Fehler: ' + errMsg, srv.id);

    notify(srv.id, 'backup_failed',
      `Auto-Backup "${backupName}" fehlgeschlagen: ${errMsg}`, {}
    ).catch(() => {});

    // Email on failure
    if (schedule.notify_on_fail && schedule.notify_email) {
      sendBackupFailEmail(schedule.notify_email, srv.name, backupName, errMsg).catch(() => {});
    }

    // Track consecutive failures
    db.prepare(`UPDATE backup_schedules
      SET consecutive_failures = COALESCE(consecutive_failures,0) + 1
      WHERE server_id=?`).run(srv.id);
  }
}

// ─── E-Mail bei Backup-Fehler ──────────────────────────────────────────────────
async function sendBackupFailEmail(email, serverName, backupName, error) {
  const nodemailer = (() => { try { return require('nodemailer'); } catch { return null; } })();
  if (!nodemailer) return;
  const smtpHost = process.env.SMTP_HOST;
  if (!smtpHost || !email) return;

  const transport = nodemailer.createTransport({
    host:   smtpHost,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth:   process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS || '',
    } : undefined,
  });

  await transport.sendMail({
    from:    process.env.SMTP_FROM || 'NexPanel <nexpanel@localhost>',
    to:      email,
    subject: `[NexPanel] ❌ Backup fehlgeschlagen: ${serverName}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px">
        <h2 style="color:#ff3b5c">Auto-Backup fehlgeschlagen</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:6px 0;color:#666">Server</td><td><strong>${serverName}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#666">Backup-Name</td><td>${backupName}</td></tr>
          <tr><td style="padding:6px 0;color:#666">Zeitpunkt</td><td>${new Date().toLocaleString('de-DE')}</td></tr>
          <tr><td style="padding:6px 0;color:#666;vertical-align:top">Fehler</td>
              <td style="color:#cc2244;font-family:monospace;font-size:12px">${error}</td></tr>
        </table>
        <p style="color:#666;font-size:13px;margin-top:16px">
          Prüfe den Server-Status und die Backup-Konfiguration in NexPanel.<br>
          <a href="#">NexPanel öffnen</a>
        </p>
      </div>`,
    text: `Auto-Backup fehlgeschlagen\nServer: ${serverName}\nBackup: ${backupName}\nFehler: ${error}\n`,
  });
  console.log(`[auto-backup] Fehler-E-Mail gesendet an ${email}`);
}

// Haupt-Tick — vom Scheduler jede Minute aufgerufen
async function autoBackupTick() {
  const now = new Date();
  try {
    const schedules = db.prepare(
      `SELECT bs.*, s.id as srv_id, s.name as srv_name, s.container_id,
              s.node_id, s.image, s.work_dir, s.status as srv_status
       FROM backup_schedules bs
       JOIN servers s ON bs.server_id = s.id
       WHERE bs.enabled = 1 AND s.container_id IS NOT NULL AND s.container_id != ''`
    ).all();

    for (const row of schedules) {
      if (!matchCron(row.cron, now)) continue;

      // Laufenden Server bevorzugen, aber auch offline backupen (Container muss existieren)
      const srv = {
        id:           row.srv_id,
        name:         row.srv_name,
        container_id: row.container_id,
        node_id:      row.node_id,
        image:        row.image,
        work_dir:     row.work_dir,
        status:       row.srv_status,
      };

      console.log(`[auto-backup] Starte Auto-Backup für "${row.srv_name}" (Cron: ${row.cron})`);
      // Nicht await'en — mehrere Backups parallel möglich
      runAutoBackup(row, srv).catch(e =>
        console.warn(`[auto-backup] Unbehandelter Fehler für ${row.srv_id}:`, e.message)
      );
    }
  } catch (e) {
    console.warn('[auto-backup] Tick-Fehler:', e.message);
  }
}

module.exports = { autoBackupTick, runAutoBackup, sendBackupFailEmail };
