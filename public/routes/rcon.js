'use strict';
/**
 * routes/rcon.js — RCON-Integration für Minecraft/Steam-Server
 *
 * Endpunkte (alle unter /api/servers/:id/rcon):
 *   GET    /status        — RCON-Konfiguration + Verbindungsstatus
 *   POST   /connect       — Verbindung herstellen (testet Credentials)
 *   DELETE /disconnect    — Verbindung trennen
 *   POST   /command       — Befehl über RCON senden
 *   GET    /players       — Spielerliste (via `list` Befehl)
 *   PUT    /config        — RCON-Konfiguration speichern (Host/Port/Passwort)
 *
 * Konfiguration wird pro Server in server_rcon_config gespeichert.
 * Passwort AES-256-verschlüsselt (Key aus JWT_SECRET).
 */

const express       = require('express');
const crypto        = require('crypto');
const { v4: uuidv4 }= require('uuid');
const { db, auditLog } = require('../src/core/db');
const { authenticate, canAccessServer } = require('./auth');
const { getConnection, closeConnection } = require('../src/core/rcon');

const router = express.Router({ mergeParams: true });

// ── Passwort-Verschlüsselung ──────────────────────────────────────────────────
function getKey() {
  const secret = process.env.JWT_SECRET || 'nexpanel-rcon-fallback-key-32chars!';
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptPassword(plain) {
  if (!plain) return '';
  const iv         = crypto.randomBytes(16);
  const cipher     = crypto.createCipheriv('aes-256-cbc', getKey(), iv);
  const encrypted  = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptPassword(stored) {
  if (!stored || !stored.includes(':')) return stored || '';
  try {
    const [ivHex, encHex] = stored.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), Buffer.from(ivHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

// ── RCON-Konfiguration aus DB ─────────────────────────────────────────────────
function getRconConfig(serverId) {
  try {
    const row = db.prepare('SELECT * FROM server_rcon_config WHERE server_id=?').get(serverId);
    if (!row) return null;
    return {
      ...row,
      rcon_password: '',  // nie im Klartext zurückgeben
      _password_set: !!row.rcon_password,
    };
  } catch { return null; }
}

function getRconConfigWithPassword(serverId) {
  try {
    const row = db.prepare('SELECT * FROM server_rcon_config WHERE server_id=?').get(serverId);
    if (!row) return null;
    return { ...row, rcon_password: decryptPassword(row.rcon_password) };
  } catch { return null; }
}

// ── Auto-detect RCON-Config aus Server-ENV ────────────────────────────────────

function ports_has_rcon(srv) {
  try {
    const p = srv.ports;
    const arr = Array.isArray(p) ? p : JSON.parse(p || '[]');
    return arr.some(e => e.container === 25575 || e.host === 25575);
  } catch { return false; }
}

function detectRconFromServer(srv) {
  // Handle both already-parsed (from canAccessServer) and raw JSON strings
  const envVars = (() => {
    const v = srv.env_vars;
    if (!v) return {};
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return {}; }
  })();
  const ports = (() => {
    const p = srv.ports;
    if (!p) return [];
    if (Array.isArray(p)) return p;
    try { return JSON.parse(p); } catch { return []; }
  })();

  const isMinecraft = (srv.image || '').toLowerCase().includes('itzg') ||
                      (srv.image || '').toLowerCase().includes('minecraft') ||
                      (srv.image || '').toLowerCase().includes('papermc') ||
                      (srv.image || '').toLowerCase().includes('spigot');

  // RCON-Port aus Ports-Liste: Host-Port für 25575 (Container-seitig)
  const rconPortEntry = ports.find(p =>
    p.container === 25575 || p.host === 25575 ||
    (typeof p === 'object' && (p.containerPort === 25575 || p.hostPort === 25575))
  );
  const rconPort  = rconPortEntry?.host || rconPortEntry?.hostPort || 25575;
  const rconPass  = envVars.RCON_PASSWORD || envVars.RCON_PASS || envVars.RCON_PASSWD || '';

  // Node-FQDN für Remote-Nodes
  let rconHost = '127.0.0.1';
  if (srv.node_id) {
    const node = db.prepare('SELECT fqdn, is_local FROM nodes WHERE id=?').get(srv.node_id);
    if (node && !node.is_local && node.fqdn && node.fqdn !== 'localhost') {
      rconHost = node.fqdn;
    }
  }

  return { rcon_host: rconHost, rcon_port: rconPort, rcon_password: rconPass, is_minecraft: isMinecraft };
}

// ── Player-Liste parsen (Minecraft `list` Ausgabe) ────────────────────────────
function parsePlayerList(output) {
  if (!output) return { online: 0, max: 0, players: [] };

  // Format: "There are X of a max of Y players online: Name1, Name2"
  // Format: "There are X/Y players online:"
  const countMatch = output.match(/There are (\d+)(?:\s+of\s+a\s+max\s+(?:of\s+)?|\/)(\d+)/i);
  const online = countMatch ? parseInt(countMatch[1]) : 0;
  const max    = countMatch ? parseInt(countMatch[2]) : 0;

  // Spielernamen extrahieren — nach dem letzten ":" oder "online:"
  let players = [];
  const colonIdx = output.lastIndexOf(':');
  if (colonIdx !== -1 && online > 0) {
    const namesPart = output.slice(colonIdx + 1).trim();
    players = namesPart
      .split(',')
      .map(n => n.trim())
      .filter(n => n.length > 0 && n.length <= 16 && /^[a-zA-Z0-9_]+$/.test(n));
  }

  return { online, max, players };
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTEN
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/servers/:id/rcon/status
router.get('/status', authenticate, canAccessServer, (req, res) => {
  const srv    = req.targetServer;
  const config = getRconConfig(srv.id);
  const detect = detectRconFromServer(srv);

  // Status: lazy-connect, keine persistente Verbindung gespeichert

  res.json({
    configured:   !!config,
    connected:    false,  // lazy-connect, kein persistenter Status
    config:       config || {
      rcon_host: detect.rcon_host,
      rcon_port: detect.rcon_port,
      _password_set: !!detect.rcon_password,
    },
    auto_detected: detect,
    is_minecraft: detect.is_minecraft || ports_has_rcon(srv),
    server_status: srv.status,
  });
});

// PUT /api/servers/:id/rcon/config  — Konfiguration speichern
router.put('/config', authenticate, canAccessServer, (req, res) => {
  const { rcon_host, rcon_port = 25575, rcon_password } = req.body;
  if (!rcon_host) return res.status(400).json({ error: 'rcon_host erforderlich' });

  const srv = req.targetServer;
  // Prüfe ob altes Passwort beibehalten werden soll (leerer String = unverändert)
  let passwordToStore;
  if (rcon_password === '' || rcon_password === undefined) {
    // Altes behalten
    const existing = db.prepare('SELECT rcon_password FROM server_rcon_config WHERE server_id=?').get(srv.id);
    passwordToStore = existing?.rcon_password || '';
  } else {
    passwordToStore = encryptPassword(rcon_password);
  }

  db.prepare(`
    INSERT INTO server_rcon_config (server_id, rcon_host, rcon_port, rcon_password, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(server_id) DO UPDATE SET
      rcon_host=excluded.rcon_host,
      rcon_port=excluded.rcon_port,
      rcon_password=excluded.rcon_password,
      updated_at=excluded.updated_at
  `).run(srv.id, rcon_host.trim(), parseInt(rcon_port) || 25575, passwordToStore);

  // Alte Verbindung schließen wenn Config geändert
  closeConnection(srv.id);

  auditLog(req.user.id, 'RCON_CONFIG_UPDATE', 'server', srv.id, { host: rcon_host }, req.ip);
  res.json({ success: true, config: getRconConfig(srv.id) });
});

// POST /api/servers/:id/rcon/connect  — Verbindung testen
router.post('/connect', authenticate, canAccessServer, async (req, res) => {
  const srv = req.targetServer;
  let config = getRconConfigWithPassword(srv.id);

  // Fallback: Auto-detect aus Server-ENV
  if (!config) {
    const detect = detectRconFromServer(srv);
    config = {
      rcon_host:     detect.rcon_host,
      rcon_port:     detect.rcon_port,
      rcon_password: detect.rcon_password,
    };
  }

  // Optionale Override-Parameter aus dem Request-Body
  const host     = req.body.rcon_host     || config.rcon_host     || '127.0.0.1';
  const port     = req.body.rcon_port     || config.rcon_port     || 25575;
  const password = req.body.rcon_password || config.rcon_password || '';

  try {
    const client = await getConnection(srv.id, { host, port, password });
    // Test: Version/Info abrufen
    const motd = await client.send('').catch(() => '');
    res.json({ success: true, message: 'RCON verbunden', host, port });
  } catch (e) {
    closeConnection(srv.id);
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/servers/:id/rcon/disconnect
router.delete('/disconnect', authenticate, canAccessServer, (req, res) => {
  closeConnection(req.targetServer.id);
  res.json({ success: true });
});

// POST /api/servers/:id/rcon/command  — Befehl ausführen
router.post('/command', authenticate, canAccessServer, async (req, res) => {
  const { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: 'command erforderlich' });

  const srv    = req.targetServer;
  if (srv.status !== 'running') return res.status(400).json({ error: 'Server nicht gestartet' });

  let config = getRconConfigWithPassword(srv.id);
  const detect = detectRconFromServer(srv);
  if (!config) {
    config = { rcon_host: detect.rcon_host, rcon_port: detect.rcon_port, rcon_password: detect.rcon_password };
  }
  // Merge: auto-detected password takes precedence if saved config has none
  const connHost = config.rcon_host || detect.rcon_host || '127.0.0.1';
  const connPort = config.rcon_port || detect.rcon_port || 25575;
  const connPass = config.rcon_password || detect.rcon_password || '';

  if (!connPass) {
    return res.status(400).json({
      success: false,
      error: 'Kein RCON-Passwort konfiguriert. Setze RCON_PASSWORD in den Server-ENV-Variablen (Konfig-Tab) oder speichere das Passwort unter Wartung → RCON-Konfiguration.',
      needs_password: true,
    });
  }

  try {
    const client = await getConnection(srv.id, { host: connHost, port: connPort, password: connPass });

    const clean  = command.trim().replace(/^\//, '');
    const output = await client.send(clean);

    auditLog(req.user.id, 'RCON_COMMAND', 'server', srv.id,
      { command: clean.slice(0, 80) }, req.ip);

    res.json({ success: true, output: output || '(kein Output)', command: clean });
  } catch (e) {
    closeConnection(srv.id);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/servers/:id/rcon/players  — Spielerliste
router.get('/players', authenticate, canAccessServer, async (req, res) => {
  const srv = req.targetServer;
  if (srv.status !== 'running') return res.json({ online: 0, max: 0, players: [], offline: true });

  let config = getRconConfigWithPassword(srv.id);
  const detect2 = detectRconFromServer(srv);
  if (!config) {
    config = { rcon_host: detect2.rcon_host, rcon_port: detect2.rcon_port, rcon_password: detect2.rcon_password };
  }
  const pHost = config.rcon_host || detect2.rcon_host || '127.0.0.1';
  const pPort = config.rcon_port || detect2.rcon_port || 25575;
  const pPass = config.rcon_password || detect2.rcon_password || '';

  try {
    if (!pPass) {
      return res.json({ online: 0, max: 0, players: [], needs_password: true,
        error: 'RCON-Passwort fehlt — unter Wartung → RCON-Konfiguration einrichten' });
    }
    const client = await getConnection(srv.id, { host: pHost, port: pPort, password: pPass });
    const output = await client.send('list');
    const parsed = parsePlayerList(output);
    res.json({ ...parsed, raw: output, success: true });
  } catch (e) {
    closeConnection(srv.id);
    res.json({ online: 0, max: 0, players: [], error: e.message, success: false });
  }
});

module.exports = router;
