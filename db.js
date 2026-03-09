/**
 * db.js — Datenbank-Initialisierung, Schema & Migrationen
 * Unterstützt sowohl v1-Installationen (lokales Docker) als auch
 * v2-Multi-Node-Setups (Daemon-basiert).
 */

'use strict';

const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');

const DB_PATH    = process.env.DB_PATH    || './hostpanel.db';
const ADMIN_EMAIL= process.env.ADMIN_EMAIL|| 'admin@hostpanel.local';
const ADMIN_PASS = process.env.ADMIN_PASS || process.env.ADMIN_PASSWORD || 'admin123';
const DOCKER_SOCK= process.env.DOCKER_SOCKET || '/var/run/docker.sock';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── SCHEMA ───────────────────────────────────────────────────────────────────
// ─── MIGRATIONS
try { db.prepare("ALTER TABLE servers ADD COLUMN cpu_percent INTEGER DEFAULT 100").run(); } catch(e){}
try { db.prepare("ALTER TABLE port_allocations ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0").run(); } catch(e){}
try { db.prepare("ALTER TABLE port_allocations ADD COLUMN notes TEXT NOT NULL DEFAULT ''").run(); } catch(e){}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    is_suspended  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Nodes-Tabelle: kombiniert v1 (lokales Docker) + v2 (Daemon-basiert)
  CREATE TABLE IF NOT EXISTS nodes (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    fqdn          TEXT NOT NULL DEFAULT 'localhost',
    location      TEXT NOT NULL DEFAULT 'Default',
    -- Auth für Daemon (NULL = lokaler Node ohne Daemon-Auth)
    token_hash    TEXT,
    token_prefix  TEXT,
    -- Flags
    is_default    INTEGER NOT NULL DEFAULT 0,
    is_local      INTEGER NOT NULL DEFAULT 0,  -- v1: lokaler Docker-Socket
    -- Ressourcen-Limits
    memory_mb     INTEGER NOT NULL DEFAULT 4096,
    disk_mb       INTEGER NOT NULL DEFAULT 51200,
    cpu_overalloc INTEGER NOT NULL DEFAULT 0,
    -- Status
    status        TEXT NOT NULL DEFAULT 'offline',
    last_seen     TEXT,
    system_info   TEXT,     -- JSON: Docker-Info, CPU, RAM etc.
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Servers: hat node_id (v2) ODER node TEXT (v1 Legacy)
  CREATE TABLE IF NOT EXISTS servers (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    description      TEXT DEFAULT '',
    user_id          TEXT NOT NULL,
    node_id          TEXT,            -- FK zu nodes.id (v2)
    container_id     TEXT,
    image            TEXT NOT NULL,
    cpu_limit        REAL    NOT NULL DEFAULT 1,
  cpu_percent      INTEGER NOT NULL DEFAULT 100,
    memory_limit     INTEGER NOT NULL DEFAULT 512,
    swap_limit       INTEGER NOT NULL DEFAULT 0,
    disk_limit       INTEGER NOT NULL DEFAULT 5120,
    ports            TEXT NOT NULL DEFAULT '[]',
    env_vars         TEXT NOT NULL DEFAULT '{}',
    startup_command  TEXT DEFAULT '',
    work_dir         TEXT DEFAULT '/home/container',
    network          TEXT DEFAULT 'bridge',
    status           TEXT NOT NULL DEFAULT 'installing',
    node             TEXT NOT NULL DEFAULT 'local',  -- v1 Legacy-Feld
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL,
    key_prefix   TEXT NOT NULL,
    permissions  TEXT NOT NULL DEFAULT '["servers:read"]',
    last_used_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          TEXT PRIMARY KEY,
    user_id     TEXT,
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    details     TEXT,
    ip          TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─── MIGRATIONEN (für bestehende v1-Installs) ─────────────────────────────────
// Neue Spalten sicher hinzufügen, falls sie noch nicht existieren
const migrations = [
  // nodes: neue v2-Felder
  `ALTER TABLE nodes ADD COLUMN fqdn TEXT NOT NULL DEFAULT 'localhost'`,
  `ALTER TABLE nodes ADD COLUMN location TEXT NOT NULL DEFAULT 'Default'`,
  `ALTER TABLE nodes ADD COLUMN token_hash TEXT`,
  `ALTER TABLE nodes ADD COLUMN token_prefix TEXT`,
  `ALTER TABLE nodes ADD COLUMN is_local INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE nodes ADD COLUMN memory_mb INTEGER NOT NULL DEFAULT 4096`,
  `ALTER TABLE nodes ADD COLUMN disk_mb INTEGER NOT NULL DEFAULT 51200`,
  `ALTER TABLE nodes ADD COLUMN cpu_overalloc INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE nodes ADD COLUMN last_seen TEXT`,
  `ALTER TABLE nodes ADD COLUMN system_info TEXT`,
  // servers: neue v2-Felder
  `ALTER TABLE servers ADD COLUMN node_id TEXT`,
  `ALTER TABLE servers ADD COLUMN work_dir TEXT DEFAULT '/home/container'`,
  `ALTER TABLE servers ADD COLUMN network TEXT DEFAULT 'bridge'`,
  `ALTER TABLE servers ADD COLUMN description TEXT DEFAULT ''`,
  // port_allocations: primär/sekundär + notizen
  `ALTER TABLE port_allocations ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE port_allocations ADD COLUMN notes TEXT NOT NULL DEFAULT ''`,
];

for (const sql of migrations) {
  try { db.exec(sql); } catch { /* Spalte existiert bereits — ignorieren */ }
}

// ─── SEEDS ────────────────────────────────────────────────────────────────────
// Admin-User
const adminExists = db.prepare("SELECT id FROM users WHERE role='admin'").get();
if (!adminExists) {
  const id   = uuidv4();
  const hash = bcrypt.hashSync(ADMIN_PASS, 12);
  db.prepare("INSERT INTO users (id,username,email,password_hash,role) VALUES (?,?,?,?,'admin')")
    .run(id, 'admin', ADMIN_EMAIL, hash);
  console.log(`✅ Admin erstellt: ${ADMIN_EMAIL} / ${ADMIN_PASS}`);
}

// Lokaler Standard-Node (v1-Kompatibilität)
// Falls noch kein Node existiert, wird ein lokaler erstellt (nutzt direkt Docker)
const localNode = db.prepare("SELECT id FROM nodes WHERE is_local=1").get();
if (!localNode) {
  const existingDefault = db.prepare("SELECT id FROM nodes WHERE is_default=1").get();
  const nodeId = uuidv4();
  db.prepare(`
    INSERT INTO nodes (id, name, fqdn, location, is_default, is_local, memory_mb, disk_mb, status)
    VALUES (?,?, 'localhost', 'Local', ?, 1, 8192, 102400, 'online')
  `).run(nodeId, 'Local Node', existingDefault ? 0 : 1);

  // Bestehende v1-Server (ohne node_id) dem lokalen Node zuweisen
  db.prepare("UPDATE servers SET node_id=? WHERE node_id IS NULL").run(nodeId);
  console.log('✅ Lokaler Node erstellt (v1-Kompatibilität)');
}

// ─── HILFSFUNKTIONEN ─────────────────────────────────────────────────────────
function auditLog(userId, action, targetType, targetId, details, ip) {
  try {
    db.prepare(`INSERT INTO audit_log (id,user_id,action,target_type,target_id,details,ip) VALUES (?,?,?,?,?,?,?)`)
      .run(uuidv4(), userId, action, targetType, targetId, JSON.stringify(details || {}), ip || null);
  } catch { /* non-critical */ }
}


// ─── PERSISTENTER JWT SECRET ──────────────────────────────────────────────────
// Wird einmalig generiert und in der DB gespeichert.
// Überlebt Neustarts, keine Token-Invalidierung durch Math.random().
function getOrCreateJwtSecret() {
  let row = db.prepare("SELECT value FROM settings WHERE key='jwt_secret'").get();
  if (!row) {
    const { randomBytes } = require('crypto');
    const secret = randomBytes(48).toString('hex');
    db.prepare("INSERT INTO settings (key, value) VALUES ('jwt_secret', ?)").run(secret);
    row = { value: secret };
    console.log('✅ JWT Secret generiert und gespeichert');
  }
  return row.value;
}

module.exports = { db, auditLog, getOrCreateJwtSecret };

// ─── NEUE TABELLEN (Feature-Erweiterung) ──────────────────────────────────────
db.exec(`
  -- Egg-System (Server-Vorlagen wie bei Pterodactyl)
  CREATE TABLE IF NOT EXISTS eggs (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT DEFAULT '',
    author          TEXT DEFAULT 'system',
    docker_image    TEXT NOT NULL,
    startup_command TEXT DEFAULT '',
    config_files    TEXT DEFAULT '{}',   -- JSON: Datei-Vorlagen
    config_startup  TEXT DEFAULT '{}',   -- JSON: Startup-Parser
    config_stop     TEXT DEFAULT 'stop',
    env_vars        TEXT DEFAULT '[]',   -- JSON: [{key, default, description, required}]
    features        TEXT DEFAULT '[]',   -- JSON: ["eula","java"]
    port_range      TEXT DEFAULT '',
    category        TEXT DEFAULT 'other',
    icon            TEXT DEFAULT '🐣',
    is_builtin      INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Port-Allocations (verwaltete Ports pro Node)
  CREATE TABLE IF NOT EXISTS port_allocations (
    id        TEXT PRIMARY KEY,
    node_id   TEXT NOT NULL,
    ip        TEXT NOT NULL DEFAULT '0.0.0.0',
    port      INTEGER NOT NULL,
    alias     TEXT DEFAULT '',
    server_id TEXT,             -- NULL = verfügbar, gesetzt = belegt
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(node_id, ip, port),
    FOREIGN KEY (node_id)   REFERENCES nodes(id)   ON DELETE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS server_subusers (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '["console","files","startup"]',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(server_id, user_id),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL,
    name        TEXT NOT NULL,
    action      TEXT NOT NULL,   -- 'start'|'stop'|'restart'|'command'
    payload     TEXT DEFAULT '', -- Befehl bei action='command'
    cron        TEXT NOT NULL,   -- Cron-Expression: "0 6 * * *"
    enabled     INTEGER NOT NULL DEFAULT 1,
    last_run    TEXT,
    last_result TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  -- Server-Egg-Verknüpfung
  CREATE TABLE IF NOT EXISTS server_eggs (
    server_id TEXT NOT NULL,
    egg_id    TEXT NOT NULL,
    PRIMARY KEY (server_id, egg_id),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (egg_id)    REFERENCES eggs(id)    ON DELETE CASCADE
  );
`);

// ─── BUILT-IN EGGS SEEDEN ─────────────────────────────────────────────────────
const eggsSeeded = db.prepare("SELECT COUNT(*) as c FROM eggs WHERE is_builtin=1").get().c;
if (!eggsSeeded) {
  const { v4: uuid4 } = require('uuid');
  const builtinEggs = [
    {
      name: 'Vanilla Minecraft', icon: '⛏️', category: 'minecraft',
      docker_image: 'itzg/minecraft-server:latest',
      startup_command: '',
      work_dir: '/data',
      config_stop: 'stop',
      description: 'Offizieller Minecraft Java Edition Server',
      env_vars: JSON.stringify([
        { key: 'EULA', default: 'TRUE', description: 'Minecraft EULA akzeptieren', required: true },
        { key: 'MEMORY', default: '1G', description: 'RAM für den Server (z.B. 2G)', required: false },
        { key: 'TYPE', default: 'VANILLA', description: 'Server-Typ: VANILLA, PAPER, SPIGOT', required: false },
        { key: 'VERSION', default: 'LATEST', description: 'Minecraft-Version', required: false },
      ]),
      features: JSON.stringify(['eula','java']),
    },
    {
      name: 'Paper Minecraft', icon: '📄', category: 'minecraft',
      docker_image: 'itzg/minecraft-server:latest',
      startup_command: '',
      work_dir: '/data',
      config_stop: 'stop',
      description: 'Hochperformanter Paper-Server mit Plugin-Support',
      env_vars: JSON.stringify([
        { key: 'EULA', default: 'TRUE', description: 'Minecraft EULA', required: true },
        { key: 'TYPE', default: 'PAPER', description: 'Server-Typ', required: true },
        { key: 'VERSION', default: 'LATEST', description: 'Minecraft-Version', required: false },
        { key: 'MEMORY', default: '2G', description: 'RAM', required: false },
      ]),
      features: JSON.stringify(['eula','java']),
    },
    {
      name: 'Pterodactyl Uptime-Kuma', icon: '📊', category: 'monitoring',
      docker_image: 'ghcr.io/ptero-eggs/apps:uptimekuma',
      startup_command: '',
      config_stop: '',
      description: 'Uptime-Monitoring Dashboard',
      env_vars: JSON.stringify([]),
      features: JSON.stringify([]),
    },
    {
      name: 'Node.js App', icon: '🟩', category: 'generic',
      docker_image: 'node:20-alpine',
      startup_command: 'node index.js',
      config_stop: '',
      description: 'Generischer Node.js Anwendungsserver',
      env_vars: JSON.stringify([
        { key: 'NODE_ENV', default: 'production', description: 'Node-Umgebung', required: false },
        { key: 'PORT', default: '3000', description: 'HTTP-Port', required: false },
      ]),
      features: JSON.stringify([]),
    },
    {
      name: 'Python App', icon: '🐍', category: 'generic',
      docker_image: 'python:3.11-alpine',
      startup_command: 'python app.py',
      config_stop: '',
      description: 'Generischer Python-Anwendungsserver',
      env_vars: JSON.stringify([
        { key: 'PORT', default: '8000', description: 'HTTP-Port', required: false },
      ]),
      features: JSON.stringify([]),
    },
    {
      name: 'Nginx', icon: '🌐', category: 'webserver',
      docker_image: 'nginx:alpine',
      startup_command: '',
      config_stop: '',
      description: 'Nginx Webserver / Reverse Proxy',
      env_vars: JSON.stringify([]),
      features: JSON.stringify([]),
    },
    {
      name: 'Valheim', icon: '⚔️', category: 'gameserver',
      docker_image: 'lloesche/valheim-server',
      startup_command: '',
      config_stop: '',
      description: 'Valheim Dedicated Server',
      env_vars: JSON.stringify([
        { key: 'SERVER_NAME', default: 'MyServer', description: 'Server-Name', required: true },
        { key: 'WORLD_NAME', default: 'Dedicated', description: 'Welt-Name', required: true },
        { key: 'SERVER_PASS', default: 'secret', description: 'Server-Passwort', required: true },
      ]),
      features: JSON.stringify([]),
    },
    {
      name: 'CS2 / CS:GO', icon: '🔫', category: 'gameserver',
      docker_image: 'cm2network/steamcmd',
      startup_command: '',
      config_stop: '',
      description: 'Counter-Strike 2 Dedicated Server',
      env_vars: JSON.stringify([
        { key: 'STEAMAPPID', default: '730', description: 'Steam App ID', required: true },
        { key: 'GSLT', default: '', description: 'Game Server Login Token', required: false },
      ]),
      features: JSON.stringify(['steam']),
    },
  ];

  const stmt = db.prepare(`INSERT INTO eggs
    (id,name,icon,category,docker_image,startup_command,config_stop,description,env_vars,features,is_builtin)
    VALUES (?,?,?,?,?,?,?,?,?,?,1)`);
  for (const e of builtinEggs) {
    stmt.run(uuid4(), e.name, e.icon, e.category, e.docker_image,
             e.startup_command, e.config_stop, e.description, e.env_vars, e.features);
  }
  console.log(`✅ ${builtinEggs.length} Built-in Eggs erstellt`);
}
