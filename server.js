'use strict';
require('dotenv').config();
/**
 * server.js — HostPanel v2.0 (Merged)
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
const { db }     = require('./db');
const daemonHub  = require('./daemon-hub');
const { attachPanelWS }  = require('./ws-panel');
const { attachDaemonEndpoint } = require('./daemon-hub');
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
const { startScheduler } = require('./scheduler');
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
app.use('/api', apiLimiter);

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
const { getPanelWss }  = require('./ws-panel');
const { getDaemonWss } = require('./daemon-hub');

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
server.listen(PORT, () => {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@hostpanel.local';
  const adminPass  = process.env.ADMIN_PASS  || 'admin123';
  console.log(`
╔═══════════════════════════════════════════════════════╗
║          HostPanel v2.0 — Multi-Node Merged           ║
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
