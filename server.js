'use strict';
require('dotenv').config();

// Ensure runtime directories exist
require('fs').mkdirSync('./data',    { recursive: true });
require('fs').mkdirSync('./backups', { recursive: true });
/**
 * server.js — NexPanel v3.0 (Merged)
 * ─────────────────────────────────────────────────────────────────
 * Kombiniert v1 (lokales Docker) + v2 (Multi-Node Daemon-System).
 *
 * Dateistruktur:
 *   server.js          ← Du bist hier (Einstiegspunkt)
 *   db.js              ← Datenbank, Schema, Migrationen, Seeds
 *   docker-local.js    ← Lokaler Docker-Client (v1-Fallback)
 *   daemon-hub.js      ← Daemon-Verbindungsverwaltung (v2)
 *   node-router.js     ← Routing: Daemon oder lokales Docker
 *   ws-panel.js        ← WebSocket für Browser-Clients
 *   routes/auth.js     ← Auth-Routen + Middleware
 *   routes/servers.js  ← Server-CRUD, Power, Logs, Commands
 *   routes/nodes.js    ← Node-Management (v2)
 *   routes/admin.js    ← Admin, Benutzer, Audit, API-Keys, Docker
 *   public/index.html  ← Single-Page-App (Frontend)
 */

'use strict';

const express    = require('express');
const http       = require('http');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

// ─── MODULE ──────────────────────────────────────────────────────────────────
// Datenbank zuerst (andere Module brauchen db)
const { db }     = require('./src/core/db');
const daemonHub  = require('./src/docker/daemon-hub');
const { attachPanelWS, broadcastAll, getPanelWss }  = require('./src/core/ws-panel');
const { attachDaemonEndpoint } = require('./src/docker/daemon-hub');
const bcrypt     = require('bcryptjs');

// Routes
const { router: authRouter } = require('./routes/auth');
const serversRouter    = require('./routes/servers');
const nodesRouter      = require('./routes/nodes');
const adminRouter      = require('./routes/admin');
const eggsRouter       = require('./routes/eggs');
const allocationsRouter= require('./routes/allocations');
const { serverPorts } = require('./routes/allocations');
const scheduleRouter  = require('./routes/schedule');
const subusersRouter  = require('./routes/subusers');
const backupsRouter   = require('./routes/backups');
const { startScheduler } = require('./src/core/scheduler');
const { autoSleepTick }   = require('./src/core/auto-sleep');
const { startSftpServer } = require('./src/sftp/sftp-server');
const notificationsRouter = require('./routes/notifications');
const { smtpRouter }      = require('./routes/notifications');
const statusRouter        = require('./routes/status');
const bulkRouter          = require('./routes/bulk');
const { startStatsCollector } = require('./src/core/stats-collector');
const { startUptimeScheduler } = require('./src/core/status-uptime');
const sessionsRouter      = require('./routes/sessions');
const groupsRouter        = require('./routes/groups');
const webhooksRouter      = require('./routes/webhooks');
const maintenanceRouter   = require('./routes/maintenance');
const composeRouter       = require('./routes/compose');
const scalingRouter       = require('./routes/scaling');
const alertsRouter        = require('./routes/alerts');
const oauthRouter         = require('./routes/oauth');
const metricsRouter       = require('./routes/metrics');
const docsRouter          = require('./routes/docs');
const pterodactylRouter   = require('./routes/pterodactyl');
const favoritesRouter     = require('./routes/favorites');
const broadcastRouter     = require('./routes/broadcast');
const { serverDbRouter, adminHostRouter: dbHostRouter } = require('./routes/databases');
const rconRouter          = require('./routes/rcon');
const quotasRouter        = require('./routes/quotas');
const ipWhitelistRouter   = require('./routes/ip-whitelist');
const { startResourceMonitor, setBroadcast } = require('./src/core/resource-limits');
const filesRouter      = require('./routes/files');
const modsRouter       = require('./routes/mods');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ─── EXPRESS ─────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate-Limiting
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, message: { error: 'Zu viele Anfragen' } });
const apiLimiter  = rateLimit({ windowMs: 60_000, max: 200 });
app.use('/api/auth', authLimiter);
app.use('/api', (req, res, next) => req.path.startsWith('/docs') ? next() : apiLimiter(req, res, next));

// ─── ROUTEN ──────────────────────────────────────────────────────────────────
app.use('/api/auth',             authRouter);
app.use('/api/servers',          serversRouter);
app.use('/api/nodes',            nodesRouter);
app.use('/api/eggs',             eggsRouter);
app.use('/api/allocations',      allocationsRouter);
// File manager: /api/servers/:serverId/files/*
app.use('/api/servers/:serverId/files', filesRouter);
app.use('/api/servers/:serverId/ports', serverPorts);
app.use('/api/servers/:serverId/schedule', scheduleRouter);
app.use('/api/servers/:serverId/subusers', subusersRouter);
app.use('/api/servers/:serverId/backups',      backupsRouter);
app.use('/api/servers/:serverId/notifications', notificationsRouter);
app.use('/api/admin/smtp',                     smtpRouter);
app.use('/api/servers',                        maintenanceRouter);  // /:serverId/maintenance + /:serverId/transfer
app.use('/api/servers',                        bulkRouter);
app.use('/api/groups',                         groupsRouter);
app.use('/api/webhooks',                       webhooksRouter);
app.use('/api',                                sessionsRouter);
app.use('/api/admin/nodes',                    maintenanceRouter);  // /resources
app.use('/api/compose',                        composeRouter);
app.use('/api',                                composeRouter);  // /servers/:id/reinstall
app.use('/api/admin',                          scalingRouter);  // scaling config + scores + auto-register
app.use('/api/servers/:id/alerts',             alertsRouter);   // resource alert rules per server
app.use('/api/auth/oauth',                     oauthRouter);    // OAuth login: GitHub, Discord
app.use('/api/docs',                           docsRouter);     // Swagger / OpenAPI Dokumentation
app.use('/api/ptero',                          pterodactylRouter); // Pterodactyl Import Engine
app.use('/api/servers',                        favoritesRouter);   // Favoriten + Console Aliases
app.use('/api/servers',                        broadcastRouter);   // Server Broadcast
app.use('/api/servers/:serverId/databases',     serverDbRouter);
app.use('/api/servers/:id/rcon',               rconRouter);        // RCON-Integration    // Server-Datenbanken
app.use('/api/admin/database-hosts',           dbHostRouter);      // DB-Host-Verwaltung (Admin)
app.use('/api/admin',                          quotasRouter);      // User-Quotas (Admin)
app.use('/api',                                quotasRouter);      // /api/account/quota
app.use('/api/servers/:id/ip-whitelist',       ipWhitelistRouter); // IP-Whitelist pro Server
app.use('/api/admin/metrics',                  metricsRouter);  // Prometheus token management
app.use('/metrics',                            metricsRouter);  // Prometheus scrape endpoint
app.use('/api/admin/oauth',                    oauthRouter);    // OAuth admin config
app.use('/',                                   statusRouter);
// Mod/plugin installer: /api/servers/:serverId/mods/*
app.use('/api/servers/:serverId/mods', modsRouter);

// Admin-Routen (mehrere Pfade für Backward-Kompatibilität)
app.use('/api/admin',          adminRouter);
app.use('/api/account',        adminRouter);   // /api/account/api-keys
app.use('/api/docker',         adminRouter);   // /api/docker/images (v1)

// Legacy: v1-Routen auf neue Pfade mappen
app.get('/api/docker/images',       (req, res) => res.redirect(307, '/api/admin/docker/images'));
app.post('/api/docker/images/pull', (req, res) => res.redirect(307, '/api/admin/docker/images/pull'));

// SPA Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
attachPanelWS(server);
attachDaemonEndpoint(server, db, bcrypt);

// ─── WebSocket Routing via handleUpgrade ──────────────────────────────────
// Verhindert Konflikte zwischen /ws und /daemon auf demselben Port
const { getDaemonWss } = require('./src/docker/daemon-hub');

server.on('upgrade', (req, socket, head) => {
  const url = req.url?.split('?')[0];
  if (url === '/ws') {
    const wss = getPanelWss();
    if (wss) wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    else socket.destroy();
  } else if (url === '/daemon') {
    const wss = getDaemonWss();
    if (wss) wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    else socket.destroy();
  } else {
    socket.destroy();
  }
});

// ─── START ───────────────────────────────────────────────────────────────────
startScheduler();
startResourceMonitor();
startStatsCollector();
try { startUptimeScheduler(); } catch(e) { console.warn('[uptime] Scheduler-Fehler:', e.message); }
setBroadcast((msg) => broadcastAll(msg));
// SFTP server (optional — set SFTP_ENABLED=false to disable)
if (process.env.SFTP_ENABLED !== 'false') {
  try { startSftpServer(); } catch (e) { console.warn('[sftp] Nicht gestartet:', e.message); }
}
server.listen(PORT, () => {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@nexpanel.local';
  const adminPass  = process.env.ADMIN_PASS  || 'admin123';
  console.log(`
╔═══════════════════════════════════════════════════════╗
║          NexPanel v3.0 — Multi-Node           ║
╠═══════════════════════════════════════════════════════╣
║  Panel:        http://localhost:${String(PORT).padEnd(25)}║
║  Admin:        ${adminEmail.padEnd(39)}║
║  Passwort:     ${adminPass.padEnd(39)}║
╠═══════════════════════════════════════════════════════╣
║  WS Clients:   /ws        (Browser)                   ║
║  WS Daemons:   /daemon    (Node-Server)               ║
╚═══════════════════════════════════════════════════════╝
  `);
});

module.exports = { app, server };
