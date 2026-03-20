'use strict';
/**
 * scheduler.js — Läuft als Background-Timer, prüft jede Minute ob Cron-Tasks fällig sind
 * Kein externes Paket nötig — einfache Cron-Matching-Logik
 */

const { db } = require('./db');
const { executeTask } = require('../../routes/schedule');
const { autoBackupTick } = require('../mods/auto-backup-scheduler');
const { autoSleepTick }  = require('./auto-sleep');
const { announceScheduleTick } = require('../../routes/broadcast');

let _interval = null;

function matchCron(expr, now) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  const checks = [
    [min,  now.getMinutes()],
    [hour, now.getHours()],
    [dom,  now.getDate()],
    [mon,  now.getMonth() + 1],
    [dow,  now.getDay()],
  ];
  return checks.every(([expr, val]) => {
    if (expr === '*') return true;
    const stepMatch = expr.match(/^\*\/(\d+)$/);
    if (stepMatch) return val % parseInt(stepMatch[1]) === 0;
    return parseInt(expr) === val;
  });
}

async function tick() {
  const now = new Date();
  // Sekunden ignorieren — läuft einmal pro Minute
  const tasks = db.prepare("SELECT t.*, s.container_id, s.node_id FROM scheduled_tasks t JOIN servers s ON t.server_id=s.id WHERE t.enabled=1").all();
  for (const task of tasks) {
    if (!matchCron(task.cron, now)) continue;
    const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(task.server_id);
    if (!srv) continue;
    try {
      await executeTask(task, srv);
      console.log(`[scheduler] Task "${task.name}" (${task.action}) auf Server ${task.server_id} ausgeführt`);
    } catch (e) {
      console.warn(`[scheduler] Task "${task.name}" fehlgeschlagen:`, e.message);
      db.prepare("UPDATE scheduled_tasks SET last_run=datetime('now'), last_result=? WHERE id=?")
        .run('Fehler: ' + e.message.substring(0, 190), task.id);
    }
  }
}


// ─── AUTO-UPDATE TICK ─────────────────────────────────────────────────────────
async function autoUpdateTick() {
  try {
    const settings = db.prepare(`
      SELECT s.*, srv.id as srv_id, srv.container_id, srv.node_id, srv.image, srv.env_vars
      FROM mod_update_settings s
      JOIN servers srv ON srv.id = s.server_id
      WHERE s.auto_update = 1 AND srv.container_id IS NOT NULL AND srv.container_id != ''
    `).all();

    for (const row of settings) {
      // Cooldown prüfen
      const intervalMs = (row.check_interval_h || 6) * 60 * 60 * 1000;
      const lastCheck  = row.last_check_at ? new Date(row.last_check_at).getTime() : 0;
      if (Date.now() - lastCheck < intervalMs) continue;

      console.log(`[mod-autoupdate] Prüfe Server ${row.server_id}...`);
      try {
        const { checkAndAutoUpdate } = require('../mods/mod-auto-updater');
        await checkAndAutoUpdate(row.server_id);
      } catch (e) {
        console.warn(`[mod-autoupdate] Fehler bei Server ${row.server_id}:`, e.message);
      }
    }
  } catch (e) {
    console.warn('[mod-autoupdate] Tick-Fehler:', e.message);
  }
}

function startScheduler() {
  if (_interval) return;
  // Nächste volle Minute abwarten, dann jede Minute
  const msToNextMinute = (60 - new Date().getSeconds()) * 1000;
  setTimeout(() => {
    tick();
    _interval = setInterval(() => {
    tick();
    autoBackupTick().catch(() => {});
    autoSleepTick().catch(() => {});
    announceScheduleTick().catch(() => {});
    if (new Date().getMinutes() % 10 === 0) autoUpdateTick().catch(()=>{});
  }, 60_000);
  }, msToNextMinute);
  console.log(`[scheduler] Gestartet — läuft in ${Math.round(msToNextMinute/1000)}s zum ersten Mal`);
  setTimeout(() => autoUpdateTick().catch(()=>{}), 2 * 60 * 1000);
}

function stopScheduler() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { startScheduler, stopScheduler };
