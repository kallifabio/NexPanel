/**
 * ws-panel.js — WebSocket-Handler für Browser-Clients
 * Verwaltet Subscriptions für Stats/Console, leitet Daemon-Events weiter.
 * Unterstützt beide Protokolle: v1 (subscribe_stats/console) + v2 (subscribe/console.subscribe)
 */

'use strict';

const WebSocket = require('ws');
const jwt       = require('jsonwebtoken');
const { db }    = require('./db');
const daemonHub = require('./daemon-hub');
const dockerLocal = require('./docker-local');

const { getOrCreateJwtSecret } = require('./db');

// Lazy-loaded to avoid circular deps
function getSaveConsoleCommand() {
  try { return require('./routes/bulk').saveConsoleCommand; } catch { return () => {}; }
}
function getPersistStats() {
  try { return require('./stats-collector').persistStats; } catch { return () => {}; }
}
const JWT_SECRET = process.env.JWT_SECRET || getOrCreateJwtSecret();

// userId → Set<ws>
const panelClients = new Map();

let _panelWss = null;
function attachPanelWS(httpServer) {
  const wss = new WebSocket.Server({ noServer: true });
  _panelWss = wss;

  // Broadcaster-Funktionen im daemon-hub registrieren
  daemonHub.setBroadcasters(
    (msg) => broadcastAll(msg),
    (msg, subKey) => broadcastToSubscribers(msg, subKey)
  );

  wss.on('connection', (ws) => {
    let user         = null;
    let subscriptions = new Set();  // server_id oder "console:server_id"
    let localStatIntervals = new Map(); // server_id → intervalId (v1 lokaler Node)
    let localLogStreams    = new Map(); // server_id → stream

    ws._subscriptions = subscriptions;

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // ── AUTH ────────────────────────────────────────────────────────────
        if (msg.type === 'auth') {
          try {
            const decoded = jwt.verify(msg.token, JWT_SECRET);
            user = db.prepare('SELECT * FROM users WHERE id=? AND is_suspended=0').get(decoded.id);
            if (!user) { ws.send(J({ type: 'error', message: 'Auth fehlgeschlagen' })); return; }
            if (!panelClients.has(user.id)) panelClients.set(user.id, new Set());
            panelClients.get(user.id).add(ws);
            ws.send(J({ type: 'auth', success: true, user: { id: user.id, username: user.username, role: user.role } }));
            // Initiale Node-Stati senden
            sendNodeStatus(ws);
          } catch { ws.send(J({ type: 'error', message: 'Ungültiger Token' })); }
          return;
        }

        if (!user) return;

        // ── SUBSCRIBE STATS (v1 + v2) ────────────────────────────────────────
        if (msg.type === 'subscribe_stats' || msg.type === 'subscribe') {
          const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(msg.server_id);
          if (!srv) return;
          if (user.role !== 'admin' && srv.user_id !== user.id) return;

          subscriptions.add(msg.server_id);

          if (srv.node_id && daemonHub.isConnected(srv.node_id)) {
            // v2: Stats per Daemon
            daemonHub.daemonRequest(srv.node_id, {
              type: 'server.stats.start', server_id: srv.id, container_id: srv.container_id
            }).catch(() => {});
          } else if (srv.container_id) {
            // v1: Lokaler Docker — eigenes Polling
            if (!localStatIntervals.has(srv.id)) {
              const iv = setInterval(async () => {
                if (ws.readyState !== WebSocket.OPEN) { clearInterval(iv); return; }
                try {
                  const stats = await dockerLocal.getStats(srv.container_id);
                  if (stats) {
                    ws.send(J({ type: 'stats', server_id: srv.id, data: stats }));
                    getPersistStats()(srv.id, stats);
                  }
                } catch {}
              }, 2000);
              localStatIntervals.set(srv.id, iv);
            }
          }
        }

        // ── SUBSCRIBE CONSOLE (v1 + v2) ──────────────────────────────────────
        if (msg.type === 'subscribe_console' || msg.type === 'console.subscribe') {
          const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(msg.server_id);
          if (!srv) return;
          if (user.role !== 'admin' && srv.user_id !== user.id) return;

          subscriptions.add(`console:${srv.id}`);

          if (srv.node_id && daemonHub.isConnected(srv.node_id)) {
            // v2: Console per Daemon
            daemonHub.daemonSend(srv.node_id, {
              type: 'server.logs.subscribe', server_id: srv.id, container_id: srv.container_id
            });
          } else if (srv.container_id && !localLogStreams.has(srv.id)) {
            // v1: Lokaler Docker-Log-Stream
            const stream = await dockerLocal.followLogs(
              srv.container_id,
              data => { if (ws.readyState === WebSocket.OPEN) ws.send(J({ type: 'console', server_id: srv.id, data })); },
              () => localLogStreams.delete(srv.id)
            );
            if (stream) localLogStreams.set(srv.id, stream);
          }
        }

        // ── UNSUBSCRIBE ──────────────────────────────────────────────────────
        if (msg.type === 'unsubscribe') {
          subscriptions.delete(msg.server_id);
          const iv = localStatIntervals.get(msg.server_id);
          if (iv) { clearInterval(iv); localStatIntervals.delete(msg.server_id); }
          // Daemon-Stats stoppen falls niemand mehr zuhört
          const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(msg.server_id);
          if (srv?.node_id) {
            const stillWatched = [...panelClients.values()].some(set =>
              [...set].some(c => c !== ws && c._subscriptions?.has(msg.server_id))
            );
            if (!stillWatched) {
              daemonHub.daemonSend(srv.node_id, { type: 'server.stats.stop', server_id: srv.id, container_id: srv.container_id });
            }
          }
        }

        // ── CONSOLE INPUT: console.input (v2 WS) + send_command (v1 legacy) ────
        if (msg.type === 'console.input' || msg.type === 'send_command') {
          const serverId = msg.server_id;
          const command  = msg.command || msg.input || '';
          if (!serverId || !command) return;

          const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);
          if (!srv || !srv.container_id) return;
          if (user.role !== 'admin' && srv.user_id !== user.id) return;

          // Echo zur Konsole (damit User sieht was er eingegeben hat)
          ws.send(J({ type: 'console', server_id: serverId, data: `\x1b[33m> ${command}\x1b[0m\n` }));

          // ── In Konsolen-History speichern ──────────────────────────────────
          getSaveConsoleCommand()(serverId, user.id, command);

          try {
            if (srv.node_id && daemonHub.isConnected(srv.node_id)) {
              // Remote daemon: server.command
              const r = await daemonHub.daemonRequest(srv.node_id, {
                type: 'server.command', server_id: srv.id,
                container_id: srv.container_id, command,
              });
              if (r.output && ws.readyState === WebSocket.OPEN)
                ws.send(J({ type: 'console', server_id: serverId, data: r.output }));
            } else {
              // Local Docker — Minecraft: rcon-cli, sonst exec
              const isMinecraft = (srv.image || '').includes('itzg') || (srv.image || '').includes('minecraft');
              if (isMinecraft) {
                // rcon-cli sendet Befehl über RCON und gibt Antwort zurück
                const result = await dockerLocal.sendStdin(srv.container_id, command);
                const cleaned = (result || '').replace(/\x1b\[[0-9;]*[mGKHF]/g, '').trim();
                if (cleaned && ws.readyState === WebSocket.OPEN)
                  ws.send(J({ type: 'console', server_id: serverId, data: cleaned + '\n' }));
              } else {
                const output = await dockerLocal.execCommand(srv.container_id, command);
                if (ws.readyState === WebSocket.OPEN)
                  ws.send(J({ type: 'console', server_id: serverId, data: (output || '✓') + '\n' }));
              }
            }
          } catch (e) {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(J({ type: 'console', server_id: serverId, data: `\x1b[31mFehler: ${e.message}\x1b[0m\n` }));
          }
        }

      } catch { /* ignoriere fehlerhafte Nachrichten */ }
    });

    ws.on('close', () => {
      // Aufräumen
      for (const [, iv] of localStatIntervals) clearInterval(iv);
      for (const [, stream] of localLogStreams) { try { stream.destroy(); } catch {} }
      if (user && panelClients.has(user.id)) {
        panelClients.get(user.id).delete(ws);
        if (panelClients.get(user.id).size === 0) panelClients.delete(user.id);
      }
    });
  });

  return wss;
}

// ─── BROADCASTER ─────────────────────────────────────────────────────────────
function broadcastAll(msg) {
  const j = J(msg);
  for (const [, clients] of panelClients) {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(j);
    }
  }
}

function broadcastToSubscribers(msg, subKey) {
  const j = J(msg);
  for (const [, clients] of panelClients) {
    for (const ws of clients) {
      if (ws._subscriptions?.has(subKey) && ws.readyState === WebSocket.OPEN) {
        ws.send(j);
      }
    }
  }
}

function sendNodeStatus(ws) {
  const nodes = db.prepare('SELECT id,name,fqdn,location,status,is_local FROM nodes').all();
  ws.send(J({
    type: 'nodes.status',
    nodes: nodes.map(n => ({
      ...n,
      connected: daemonHub.isConnected(n.id) || (n.is_local && dockerLocal.isAvailable()),
    }))
  }));
}

function J(obj) { return JSON.stringify(obj); }

function getPanelWss() { return _panelWss; }
module.exports = { attachPanelWS, broadcastAll, broadcastToSubscribers, getPanelWss };
