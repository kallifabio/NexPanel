'use strict';
/**
 * routes/databases.js
 * Two router exports:
 *   serverDbRouter  → /api/servers/:serverId/databases
 *   adminHostRouter → /api/admin/database-hosts
 */

const express        = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto         = require('crypto');
const { db, auditLog }               = require('../src/core/db');
const { authenticate, requireAdmin } = require('./auth');

function genPassword(length = 24) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#%^&*';
  return Array.from(crypto.randomBytes(length)).map(b => chars[b % chars.length]).join('');
}
function sanitizeDbName(s) { return (s||'').replace(/[^a-zA-Z0-9_]/g,'_').slice(0,48); }

function getDbHosts() {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key='database_hosts'").get();
    return r ? JSON.parse(r.value) : [];
  } catch { return []; }
}
function saveDbHosts(hosts) {
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('database_hosts',?)").run(JSON.stringify(hosts));
}
function getDbHost(id) { return getDbHosts().find(h => h.id === id) || null; }

async function getMysqlClient(host) {
  try {
    const mysql = require('mysql2/promise');
    return await mysql.createConnection({ host: host.host, port: host.port||3306, user: host.root_user||'root', password: host.root_password||'', connectTimeout: 8000 });
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') throw new Error('mysql2 nicht installiert — npm install mysql2');
    throw e;
  }
}

function canAccess(req, res, next) {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (req.user.role !== 'admin' && srv.user_id !== req.user.id) {
    const sub = db.prepare('SELECT permissions FROM server_subusers WHERE server_id=? AND user_id=?').get(req.params.serverId, req.user.id);
    if (!sub) return res.status(403).json({ error: 'Kein Zugriff' });
    if (!JSON.parse(sub.permissions||'[]').includes('databases')) return res.status(403).json({ error: 'Keine Datenbank-Berechtigung' });
  }
  req.srv = srv; next();
}

function safe(row) { if (!row) return null; const {db_password_clear:_,...r}=row; return r; }

// ── SERVER DB ROUTER ──────────────────────────────────────────────────────────
const serverDbRouter = express.Router({ mergeParams: true });

serverDbRouter.get('/', authenticate, canAccess, (req, res) => {
  const rows = db.prepare('SELECT * FROM server_databases WHERE server_id=? ORDER BY created_at DESC').all(req.params.serverId);
  const hosts = getDbHosts();
  res.json(rows.map(r => ({
    ...safe(r),
    has_password_visible: !!r.db_password_clear,
    jdbc_url: `jdbc:mysql://${r.host}:${r.port}/${r.db_name}`,
    host_label: hosts.find(h=>h.host===r.host)?.name || r.host,
    phpmyadmin_url: hosts.find(h=>h.host===r.host)?.phpmyadmin_url || '',
  })));
});

serverDbRouter.post('/', authenticate, canAccess, async (req, res) => {
  try {
    const { db_name_suffix='', note='', host_id=null } = req.body;
    const hosts = getDbHosts();
    let hostObj = host_id ? getDbHost(host_id) : (hosts.find(h=>h.is_default)||hosts[0]||null);
    if (!hostObj && hosts.length === 0) return res.status(400).json({ error: 'Kein Datenbank-Host konfiguriert. Admin → Datenbank-Hosts einrichten.', setup_required: true });

    const host = hostObj?.host || '127.0.0.1';
    const port = hostObj?.port || 3306;
    const sid    = req.params.serverId.replace(/-/g,'').slice(0,8);
    const suffix = sanitizeDbName(db_name_suffix || Date.now().toString(36));
    const dbName = `nex_${sid}_${suffix}`.slice(0,64);
    const dbUser = `nex_${sid}_${suffix}`.slice(0,32);
    const passwd = genPassword(24);

    if (db.prepare('SELECT id FROM server_databases WHERE db_name=?').get(dbName)) {
      return res.status(409).json({ error: `"${dbName}" bereits vergeben` });
    }

    let mysqlErr = null;
    if (hostObj?.root_user) {
      try {
        const conn = await getMysqlClient(hostObj);
        await conn.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await conn.execute(`CREATE USER IF NOT EXISTS '${dbUser}'@'%' IDENTIFIED BY '${passwd}'`);
        await conn.execute(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'%'`);
        await conn.execute('FLUSH PRIVILEGES');
        await conn.end();
      } catch(e) { mysqlErr = e.message; }
    }

    const id = uuidv4();
    db.prepare("INSERT INTO server_databases (id,server_id,db_name,db_user,db_password,db_password_clear,host,port,note) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, req.params.serverId, dbName, dbUser, passwd, passwd, host, port, note);
    auditLog(req.user.id, 'DATABASE_CREATE', 'server', req.params.serverId, { db_name: dbName, host }, req.ip);

    const created = db.prepare('SELECT * FROM server_databases WHERE id=?').get(id);
    res.status(201).json({ ...created, password_visible:true, jdbc_url:`jdbc:mysql://${host}:${port}/${dbName}`, phpmyadmin_url: hostObj?.phpmyadmin_url||'', ...(mysqlErr?{warning:`Gespeichert, MySQL fehlgeschlagen: ${mysqlErr}`}:{}) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

serverDbRouter.get('/:dbId/password', authenticate, canAccess, (req, res) => {
  const row = db.prepare('SELECT * FROM server_databases WHERE id=? AND server_id=?').get(req.params.dbId, req.params.serverId);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!row.db_password_clear) return res.status(410).json({ error: 'Passwort bereits abgerufen — bitte rotieren' });
  const pwd = row.db_password_clear;
  db.prepare("UPDATE server_databases SET db_password_clear='' WHERE id=?").run(row.id);
  auditLog(req.user.id, 'DATABASE_PASSWORD_REVEAL', 'server', req.params.serverId, { db_name: row.db_name }, req.ip);
  res.json({ password: pwd, db_name: row.db_name, db_user: row.db_user });
});

serverDbRouter.get('/:dbId', authenticate, canAccess, (req, res) => {
  const row = db.prepare('SELECT * FROM server_databases WHERE id=? AND server_id=?').get(req.params.dbId, req.params.serverId);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden' });
  const hosts = getDbHosts();
  res.json({ ...safe(row), has_password_visible:!!row.db_password_clear, jdbc_url:`jdbc:mysql://${row.host}:${row.port}/${row.db_name}`, phpmyadmin_url: hosts.find(h=>h.host===row.host)?.phpmyadmin_url||'' });
});

serverDbRouter.delete('/:dbId', authenticate, canAccess, async (req, res) => {
  const row = db.prepare('SELECT * FROM server_databases WHERE id=? AND server_id=?').get(req.params.dbId, req.params.serverId);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden' });
  let mysqlErr = null;
  const h = getDbHosts().find(x=>x.host===row.host);
  if (h?.root_user) {
    try {
      const conn = await getMysqlClient(h);
      await conn.execute(`DROP DATABASE IF EXISTS \`${row.db_name}\``);
      await conn.execute(`DROP USER IF EXISTS '${row.db_user}'@'%'`);
      await conn.execute('FLUSH PRIVILEGES');
      await conn.end();
    } catch(e) { mysqlErr = e.message; }
  }
  db.prepare('DELETE FROM server_databases WHERE id=?').run(row.id);
  auditLog(req.user.id, 'DATABASE_DELETE', 'server', req.params.serverId, { db_name: row.db_name }, req.ip);
  res.json({ success:true, ...(mysqlErr?{warning:`Eintrag gelöscht, MySQL-Drop fehlgeschlagen: ${mysqlErr}`}:{}) });
});

serverDbRouter.post('/:dbId/rotate-password', authenticate, canAccess, async (req, res) => {
  const row = db.prepare('SELECT * FROM server_databases WHERE id=? AND server_id=?').get(req.params.dbId, req.params.serverId);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden' });
  const newPwd = genPassword(24);
  let mysqlErr = null;
  const h = getDbHosts().find(x=>x.host===row.host);
  if (h?.root_user) {
    try {
      const conn = await getMysqlClient(h);
      await conn.execute(`ALTER USER '${row.db_user}'@'%' IDENTIFIED BY '${newPwd}'`);
      await conn.execute('FLUSH PRIVILEGES');
      await conn.end();
    } catch(e) { mysqlErr = e.message; }
  }
  db.prepare("UPDATE server_databases SET db_password=?,db_password_clear=?,updated_at=datetime('now') WHERE id=?").run(newPwd, newPwd, row.id);
  auditLog(req.user.id, 'DATABASE_PASSWORD_ROTATE', 'server', req.params.serverId, { db_name: row.db_name }, req.ip);
  res.json({ success:true, password:newPwd, db_name:row.db_name, db_user:row.db_user, ...(mysqlErr?{warning:`Gespeichert, MySQL-Update fehlgeschlagen: ${mysqlErr}`}:{}) });
});

// ── ADMIN HOST ROUTER ─────────────────────────────────────────────────────────
const adminHostRouter = express.Router();

adminHostRouter.get('/', authenticate, requireAdmin, (req, res) => {
  res.json(getDbHosts().map(h => ({ ...h, root_password: h.root_password ? '***' : '' })));
});

adminHostRouter.post('/', authenticate, requireAdmin, (req, res) => {
  const { name, host, port=3306, root_user='root', root_password='', phpmyadmin_url='', is_default=false } = req.body;
  if (!name?.trim() || !host?.trim()) return res.status(400).json({ error: 'name und host erforderlich' });
  const hosts = getDbHosts();
  const id = uuidv4();
  const nh = { id, name:name.trim(), host:host.trim(), port:parseInt(port)||3306, root_user, root_password, phpmyadmin_url, is_default:!!is_default };
  if (nh.is_default) hosts.forEach(h => { h.is_default = false; });
  hosts.push(nh);
  saveDbHosts(hosts);
  auditLog(req.user.id,'DB_HOST_CREATE','setting',id,{name,host},req.ip);
  res.status(201).json({ ...nh, root_password: '' });
});

adminHostRouter.patch('/:id', authenticate, requireAdmin, (req, res) => {
  const hosts = getDbHosts(); const idx = hosts.findIndex(h=>h.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error: 'Host nicht gefunden' });
  const { name,host,port,root_user,root_password,phpmyadmin_url,is_default } = req.body;
  if (name!==undefined) hosts[idx].name=name;
  if (host!==undefined) hosts[idx].host=host;
  if (port!==undefined) hosts[idx].port=parseInt(port);
  if (root_user!==undefined) hosts[idx].root_user=root_user;
  if (root_password && root_password!=='***') hosts[idx].root_password=root_password;
  if (phpmyadmin_url!==undefined) hosts[idx].phpmyadmin_url=phpmyadmin_url;
  if (is_default!==undefined) { if(is_default) hosts.forEach((h,i)=>{h.is_default=(i===idx);}); else hosts[idx].is_default=false; }
  saveDbHosts(hosts);
  auditLog(req.user.id,'DB_HOST_UPDATE','setting',req.params.id,{name:hosts[idx].name},req.ip);
  res.json({ ...hosts[idx], root_password: '' });
});

adminHostRouter.delete('/:id', authenticate, requireAdmin, (req, res) => {
  const hosts = getDbHosts(); const updated = hosts.filter(h=>h.id!==req.params.id);
  if (hosts.length===updated.length) return res.status(404).json({ error: 'Host nicht gefunden' });
  saveDbHosts(updated);
  auditLog(req.user.id,'DB_HOST_DELETE','setting',req.params.id,{},req.ip);
  res.json({ success:true });
});

adminHostRouter.post('/:id/test', authenticate, requireAdmin, async (req, res) => {
  const h = getDbHost(req.params.id);
  if (!h) return res.status(404).json({ error: 'Host nicht gefunden' });
  try {
    const conn = await getMysqlClient(h);
    const [rows] = await conn.execute('SELECT VERSION() AS v');
    await conn.end();
    res.json({ success:true, version: rows[0]?.v||'unknown' });
  } catch(e) { res.status(500).json({ success:false, error: e.message }); }
});

module.exports = { serverDbRouter, adminHostRouter };
