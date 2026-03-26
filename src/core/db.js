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

const DB_PATH    = process.env.DB_PATH    || './nexpanel.db';
const ADMIN_EMAIL= process.env.ADMIN_EMAIL|| 'admin@nexpanel.local';
const ADMIN_PASS = process.env.ADMIN_PASS || process.env.ADMIN_PASSWORD || 'admin123';
const DOCKER_SOCK= process.env.DOCKER_SOCKET || '/var/run/docker.sock';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── SCHEMA ───────────────────────────────────────────────────────────────────
// ─── MIGRATIONS
try { db.prepare("ALTER TABLE servers ADD COLUMN cpu_percent INTEGER DEFAULT 100").run(); } catch(e){}
try { db.prepare("ALTER TABLE port_allocations ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0").run(); } catch(e){}
try { db.prepare("INSERT OR IGNORE INTO smtp_config (id) VALUES (1)").run(); } catch(e){}
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

try { db.prepare("ALTER TABLE users ADD COLUMN totp_secret TEXT DEFAULT NULL").run(); } catch(e){}
try { db.prepare("ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0").run(); } catch(e){}
try { db.prepare("ALTER TABLE users ADD COLUMN totp_backup_codes TEXT DEFAULT NULL").run(); } catch(e){}


try { db.prepare(`
  CREATE TABLE IF NOT EXISTS resource_alert_rules (
    server_id         TEXT PRIMARY KEY,
    enabled           INTEGER NOT NULL DEFAULT 1,
    cpu_warn          INTEGER DEFAULT 80,
    cpu_crit          INTEGER DEFAULT 95,
    ram_warn          INTEGER DEFAULT 80,
    ram_crit          INTEGER DEFAULT 95,
    disk_warn         INTEGER DEFAULT 75,
    disk_crit         INTEGER DEFAULT 90,
    cooldown_minutes  INTEGER DEFAULT 30,
    last_fired        TEXT    DEFAULT '{}',
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )
`).run(); } catch(e){}


// ── OAuth Migrations ──────────────────────────────────────────────────────────
try { db.prepare("ALTER TABLE users ADD COLUMN password_hash_nullable TEXT").run(); } catch(e){}
try { db.prepare(`
  CREATE TABLE IF NOT EXISTS oauth_connections (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    provider     TEXT NOT NULL,
    provider_id  TEXT NOT NULL,
    username     TEXT DEFAULT '',
    email        TEXT DEFAULT '',
    avatar_url   TEXT DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, provider_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run(); } catch(e){}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_connections(user_id)").run(); } catch(e){}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_oauth_provider ON oauth_connections(provider, provider_id)").run(); } catch(e){}


// ── Mod Auto-Update Migrations ────────────────────────────────────────────────
try { db.prepare(`
  CREATE TABLE IF NOT EXISTS mod_update_settings (
    server_id          TEXT PRIMARY KEY,
    auto_update        INTEGER NOT NULL DEFAULT 0,
    check_interval_h   INTEGER NOT NULL DEFAULT 6,
    last_check_at      TEXT,
    notify_on_update   INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )
`).run(); } catch(e){}
try { db.prepare(`
  CREATE TABLE IF NOT EXISTS mod_update_log (
    id           TEXT PRIMARY KEY,
    server_id    TEXT NOT NULL,
    mod_name     TEXT NOT NULL,
    old_version  TEXT,
    new_version  TEXT,
    project_id   TEXT,
    status       TEXT NOT NULL DEFAULT 'updated',
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )
`).run(); } catch(e){}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_mod_update_log_server ON mod_update_log(server_id, updated_at)").run(); } catch(e){}

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


  -- Benachrichtigungs-Einstellungen pro Server
  CREATE TABLE IF NOT EXISTS notification_settings (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL UNIQUE,
    -- Discord
    discord_webhook  TEXT DEFAULT '',
    discord_enabled  INTEGER DEFAULT 0,
    discord_events   TEXT DEFAULT '["crash","disk_warning","backup_done","backup_failed"]',
    -- E-Mail
    email_to         TEXT DEFAULT '',
    email_enabled    INTEGER DEFAULT 0,
    email_events     TEXT DEFAULT '["crash","disk_warning"]',
    -- Events-Maske
    events           TEXT DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  -- SMTP-Globalkonfiguration (Panel-weit, nur Admin)
  CREATE TABLE IF NOT EXISTS smtp_config (
    id       INTEGER PRIMARY KEY CHECK (id=1),
    host     TEXT DEFAULT '',
    port     INTEGER DEFAULT 587,
    secure   INTEGER DEFAULT 0,
    user     TEXT DEFAULT '',
    password TEXT DEFAULT '',
    from_addr TEXT DEFAULT '',
    enabled  INTEGER DEFAULT 0
  );


  -- Stats-Verlauf (alle 30s gesampelt, 7 Tage vorgehalten)
  CREATE TABLE IF NOT EXISTS server_stats_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   TEXT NOT NULL,
    cpu         REAL NOT NULL DEFAULT 0,
    memory_mb   REAL NOT NULL DEFAULT 0,
    memory_limit_mb REAL NOT NULL DEFAULT 0,
    network_rx  INTEGER NOT NULL DEFAULT 0,
    network_tx  INTEGER NOT NULL DEFAULT 0,
    pids        INTEGER NOT NULL DEFAULT 0,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Konsolen-History pro Server pro User
  CREATE TABLE IF NOT EXISTS console_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    command     TEXT NOT NULL,
    executed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );


  -- Session-Management
  CREATE TABLE IF NOT EXISTS user_sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    ip          TEXT DEFAULT '',
    user_agent  TEXT DEFAULT '',
    last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Server-Gruppen / Tags
  CREATE TABLE IF NOT EXISTS server_groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#64748b',
    icon       TEXT NOT NULL DEFAULT '📁',
    user_id    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS server_group_members (
    group_id  TEXT NOT NULL,
    server_id TEXT NOT NULL,
    PRIMARY KEY (group_id, server_id),
    FOREIGN KEY (group_id)  REFERENCES server_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id)       ON DELETE CASCADE
  );

  -- Outgoing Webhooks
  CREATE TABLE IF NOT EXISTS webhooks (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    server_id  TEXT,            -- NULL = panel-wide (admin only)
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    secret     TEXT DEFAULT '',
    events     TEXT NOT NULL DEFAULT '[]',
    enabled    INTEGER NOT NULL DEFAULT 1,
    last_fired TEXT,
    last_status INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  -- Maintenance-Modus pro Server
  CREATE TABLE IF NOT EXISTS maintenance_mode (
    server_id   TEXT PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 0,
    message     TEXT NOT NULL DEFAULT 'Server wird gewartet',
    started_at  TEXT,
    started_by  TEXT,
    FOREIGN KEY (server_id)  REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (started_by) REFERENCES users(id)   ON DELETE SET NULL
  );


  -- Status-Page: Incidents & Ankündigungen
  CREATE TABLE IF NOT EXISTS status_incidents (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    severity    TEXT NOT NULL DEFAULT 'info',  -- info | degraded | partial | major | maintenance
    status      TEXT NOT NULL DEFAULT 'investigating',  -- investigating | identified | monitoring | resolved
    server_ids  TEXT NOT NULL DEFAULT '[]',  -- JSON array of affected server IDs
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Status-Page: Incident Updates (Timeline)
  CREATE TABLE IF NOT EXISTS status_incident_updates (
    id          TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    body        TEXT NOT NULL,
    status      TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (incident_id) REFERENCES status_incidents(id) ON DELETE CASCADE
  );

  -- Status-Page: E-Mail Subscriber
  CREATE TABLE IF NOT EXISTS status_subscribers (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    token       TEXT NOT NULL UNIQUE,  -- für Unsubscribe-Link
    confirmed   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Status-Page: Uptime-Log (täglich, pro Server)
  CREATE TABLE IF NOT EXISTS status_uptime_log (
    server_id TEXT NOT NULL,
    date      TEXT NOT NULL,  -- YYYY-MM-DD
    up_pct    REAL NOT NULL DEFAULT 100,  -- 0-100
    PRIMARY KEY (server_id, date),
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

  -- Backups
  CREATE TABLE IF NOT EXISTS server_backups (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL,
    name        TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    file_path   TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'creating', -- creating|ready|failed|restoring
    created_by  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (server_id)  REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)   ON DELETE SET NULL
  );

  -- Disk-Nutzung (Snapshot alle paar Minuten für Trend-Anzeige)
  CREATE TABLE IF NOT EXISTS disk_usage_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id  TEXT NOT NULL,
    bytes_used INTEGER NOT NULL DEFAULT 0,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

try { db.prepare("ALTER TABLE servers ADD COLUMN status_public INTEGER DEFAULT 1").run(); } catch(e){}
try { db.prepare("ALTER TABLE servers ADD COLUMN status_override TEXT DEFAULT ''").run(); } catch(e){}
try { db.prepare("ALTER TABLE status_incidents ADD COLUMN scheduled_at TEXT").run(); } catch(e){}
try { db.prepare("ALTER TABLE status_incidents ADD COLUMN is_scheduled INTEGER DEFAULT 0").run(); } catch(e){}
try { db.prepare("ALTER TABLE servers ADD COLUMN response_time_ms INTEGER").run(); } catch(e){}
try { db.prepare("ALTER TABLE servers ADD COLUMN last_ping_at TEXT").run(); } catch(e){}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_subscribers_email ON status_subscribers(email)").run(); } catch(e){}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_incidents_status ON status_incidents(status)").run(); } catch(e){}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_uptime_server ON status_uptime_log(server_id,date)").run(); } catch(e){}
try { db.prepare("ALTER TABLE users ADD COLUMN suspend_reason TEXT DEFAULT ''").run(); } catch(e){}
try { db.prepare("ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'dark'").run(); } catch(e){}
try { db.prepare("CREATE TABLE IF NOT EXISTS compose_imports (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, compose_yaml TEXT NOT NULL, server_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run(); } catch(e){}
try { db.prepare("ALTER TABLE servers ADD COLUMN group_id TEXT").run(); } catch(e){}
try { db.prepare("ALTER TABLE servers ADD COLUMN tags TEXT DEFAULT '[]'").run(); } catch(e){}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id)").run(); } catch(e){}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(token_hash)").run(); } catch(e){}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_webhooks_server ON webhooks(server_id)").run(); } catch(e){}


// ─── MIGRATIONEN: Session 14 (Favoriten, Aliases, Auto-Backup, Broadcast) ─────
try { db.prepare("ALTER TABLE servers ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0").run(); } catch(e){}
try { db.prepare("ALTER TABLE servers ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0").run(); } catch(e){}
try { db.prepare(`CREATE TABLE IF NOT EXISTS console_aliases (
  id         TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  command    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(server_id, user_id, name),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
)`).run(); } catch(e){}
try { db.prepare(`CREATE TABLE IF NOT EXISTS backup_schedules (
  id            TEXT PRIMARY KEY,
  server_id     TEXT NOT NULL UNIQUE,
  enabled       INTEGER NOT NULL DEFAULT 0,
  cron          TEXT NOT NULL DEFAULT '0 4 * * *',
  keep_count    INTEGER NOT NULL DEFAULT 5,
  name_template TEXT NOT NULL DEFAULT 'Auto {date}',
  last_run_at   TEXT,
  last_result   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
)`).run(); } catch(e){}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_console_aliases_srv_user ON console_aliases(server_id, user_id)").run(); } catch(e){}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_server_favorite ON servers(user_id, is_favorite)").run(); } catch(e){}

// ─── MIGRATIONEN: Server-Datenbanken ─────────────────────────────────────────
try { db.prepare(`CREATE TABLE IF NOT EXISTS server_databases (
  id            TEXT PRIMARY KEY,
  server_id     TEXT NOT NULL,
  db_name       TEXT NOT NULL,
  db_user       TEXT NOT NULL,
  db_password   TEXT NOT NULL,      -- bcrypt-verschlüsselt für Anzeige, klartext für Verbindung
  db_password_clear TEXT NOT NULL DEFAULT '', -- einmalig anzeigbar, danach leer
  host          TEXT NOT NULL DEFAULT '127.0.0.1',
  port          INTEGER NOT NULL DEFAULT 3306,
  note          TEXT NOT NULL DEFAULT '',
  phpmyadmin_url TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(db_name),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
)`).run(); } catch(e){}
try { db.prepare("ALTER TABLE settings ADD COLUMN db_host TEXT DEFAULT '127.0.0.1'").run(); } catch(e){}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_server_dbs ON server_databases(server_id)").run(); } catch(e){}

// ─── MIGRATIONEN: IP-Whitelist, User-Quotas, Auto-Sleep ──────────────────────
try { db.prepare("ALTER TABLE servers ADD COLUMN allowed_ips TEXT DEFAULT '[]'").run(); } catch(e){}
try { db.prepare("ALTER TABLE servers ADD COLUMN auto_sleep_enabled INTEGER DEFAULT 0").run(); } catch(e){}
try { db.prepare("ALTER TABLE servers ADD COLUMN auto_sleep_minutes INTEGER DEFAULT 30").run(); } catch(e){}
try { db.prepare("ALTER TABLE servers ADD COLUMN last_activity_at TEXT").run(); } catch(e){}
try { db.prepare(`CREATE TABLE IF NOT EXISTS user_quotas (
  user_id       TEXT PRIMARY KEY,
  max_servers   INTEGER DEFAULT 10,
  max_ram_mb    INTEGER DEFAULT 8192,
  max_cpu_cores REAL    DEFAULT 8,
  max_disk_mb   INTEGER DEFAULT 51200,
  max_dbs       INTEGER DEFAULT 5,
  max_backups   INTEGER DEFAULT 10,
  note          TEXT DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`).run(); } catch(e){}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_server_activity ON servers(last_activity_at, auto_sleep_enabled)").run(); } catch(e){}

// ─── MIGRATIONEN: Announce-Schedules ─────────────────────────────────────────
try { db.prepare(`CREATE TABLE IF NOT EXISTS announce_schedules (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  message         TEXT NOT NULL,
  cron            TEXT NOT NULL DEFAULT '0 * * * *',
  target          TEXT NOT NULL DEFAULT 'running',
  delay_ms        INTEGER NOT NULL DEFAULT 0,
  discord_webhook TEXT NOT NULL DEFAULT '',
  discord_enabled INTEGER NOT NULL DEFAULT 0,
  server_command  TEXT NOT NULL DEFAULT 'say {message}',
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_at     TEXT,
  last_result     TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
)`).run(); } catch(e){}

// ─── MIGRATION: RCON-Konfiguration ───────────────────────────────────────────
try { db.prepare(`CREATE TABLE IF NOT EXISTS server_rcon_config (
  server_id     TEXT PRIMARY KEY,
  rcon_host     TEXT NOT NULL DEFAULT '127.0.0.1',
  rcon_port     INTEGER NOT NULL DEFAULT 25575,
  rcon_password TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
)`).run(); } catch(e){}

// ─── MIGRATION: IP-Log (letzte Verbindungen pro Server) ──────────────────────
try { db.prepare(`CREATE TABLE IF NOT EXISTS server_ip_log (
  id          TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL,
  ip          TEXT NOT NULL,
  user_id     TEXT,
  event       TEXT NOT NULL DEFAULT 'connect',
  user_agent  TEXT DEFAULT '',
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
)`).run(); } catch(e){}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_ip_log_server ON server_ip_log(server_id, connected_at)').run(); } catch(e){}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_ip_log_ip ON server_ip_log(server_id, ip)').run(); } catch(e){}

// ─── MIGRATION: backup_schedules neue Felder ──────────────────────────────────
try { db.prepare("ALTER TABLE backup_schedules ADD COLUMN notify_on_fail INTEGER DEFAULT 1").run(); } catch(e){}
try { db.prepare("ALTER TABLE backup_schedules ADD COLUMN notify_email TEXT DEFAULT ''").run(); } catch(e){}
try { db.prepare("ALTER TABLE backup_schedules ADD COLUMN backup_before_update INTEGER DEFAULT 0").run(); } catch(e){}
try { db.prepare("ALTER TABLE backup_schedules ADD COLUMN min_free_mb INTEGER DEFAULT 512").run(); } catch(e){}
try { db.prepare("ALTER TABLE backup_schedules ADD COLUMN consecutive_failures INTEGER DEFAULT 0").run(); } catch(e){}
try { db.prepare("ALTER TABLE backup_schedules ADD COLUMN last_success_at TEXT").run(); } catch(e){}
// ─── INDIZES ──────────────────────────────────────────────────────────────────
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_stats_server_time ON server_stats_log(server_id, recorded_at)").run(); } catch(e){}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_console_server_user ON console_history(server_id, user_id, executed_at)").run(); } catch(e){}
try { db.prepare("DELETE FROM server_stats_log WHERE recorded_at < datetime('now','-7 days')").run(); } catch(e){}

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
