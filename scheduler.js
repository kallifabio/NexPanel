'use strict';
/**
 * scheduler.js — Läuft als Background-Timer, prüft jede Minute ob Cron-Tasks fällig sind
 * Kein externes Paket nötig — einfache Cron-Matching-Logik
 */

const { db } = require('./db');
const { executeTask } = require('./routes/schedule');

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

function startScheduler() {
  if (_interval) return;
  // Nächste volle Minute abwarten, dann jede Minute
  const msToNextMinute = (60 - new Date().getSeconds()) * 1000;
  setTimeout(() => {
    tick();
    _interval = setInterval(tick, 60_000);
  }, msToNextMinute);
  console.log(`[scheduler] Gestartet — läuft in ${Math.round(msToNextMinute/1000)}s zum ersten Mal`);
}

function stopScheduler() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { startScheduler, stopScheduler };
