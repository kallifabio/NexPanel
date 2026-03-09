/**
 * daemon-hub.js — Daemon-Verbindungs-Management
 * Verwaltet alle eingehenden WebSocket-Verbindungen von Node-Daemons.
 * Bietet daemonRequest() und daemonSend() für Panel-→-Daemon-Kommunikation.
 * Broadcaster für Panel-Clients (Browser).
 */

'use strict';

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// nodeId → { ws, pendingReplies: Map<reqId, {resolve,reject,timer}>, info }
const connections = new Map();

// Panel-Client-Broadcast-Funktion – wird von ws-panel.js gesetzt
let _broadcastAll  = () => {};
let _broadcastSub  = () => {};

function setBroadcasters(broadcastAll, broadcastSub) {
  _broadcastAll = broadcastAll;
  _broadcastSub = broadcastSub;
}

// ─── ANFRAGE AN DAEMON ────────────────────────────────────────────────────────
function daemonRequest(nodeId, msg, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const conn = connections.get(nodeId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return reject(new Error(`Node "${nodeId}" ist offline oder nicht verbunden`));
    }

    const req_id = uuidv4();
    const timer  = setTimeout(() => {
      conn.pendingReplies.delete(req_id);
      reject(new Error(`Timeout: Node antwortete nicht innerhalb ${timeoutMs}ms`));
    }, timeoutMs);

    conn.pendingReplies.set(req_id, { resolve, reject, timer });
    conn.ws.send(JSON.stringify({ ...msg, req_id }));
  });
}

// Fire-and-forget
function daemonSend(nodeId, msg) {
  const conn = connections.get(nodeId);
  if (conn?.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(msg));
  }
}

function isConnected(nodeId) {
  const conn = connections.get(nodeId);
  return conn?.ws.readyState === WebSocket.OPEN;
}

function getConnectionInfo(nodeId) {
  return connections.get(nodeId)?.info || null;
}

// ─── DAEMON WEBSOCKET ENDPOINT ────────────────────────────────────────────────
// Wird in server.js dem HTTP-Server angehängt (/daemon)
let _daemonWss = null;
function attachDaemonEndpoint(httpServer, db, bcrypt) {
  const { auditLog } = require('./db');

  const daemonWss = new WebSocket.Server({ noServer: true });
  _daemonWss = daemonWss;

  daemonWss.on('connection', async (ws, req) => {
    const nodeId    = req.headers['x-node-id'];
    const nodeToken = req.headers['x-node-token'];

    if (!nodeId || !nodeToken) {
      console.warn('🚫 Daemon-Verbindung ohne x-node-id oder x-node-token abgewiesen');
      ws.close(4001, 'Missing credentials');
      return;
    }

    // Node in DB nachschlagen
    const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(nodeId);
    if (!node) {
      console.warn(`🚫 Unbekannte Node-ID: ${nodeId}`);
      ws.close(4002, 'Unknown node');
      return;
    }

    // Token prüfen
    if (!node.token_hash || !await bcrypt.compare(nodeToken, node.token_hash)) {
      console.warn(`🚫 Falsches Token für Node "${node.name}"`);
      ws.close(4003, 'Invalid token');
      return;
    }

    console.log(`🟢 Node verbunden: ${node.name} (${node.fqdn})`);

    const conn = { ws, pendingReplies: new Map(), info: null };
    connections.set(nodeId, conn);

    db.prepare("UPDATE nodes SET status='online', last_seen=datetime('now') WHERE id=?").run(nodeId);
    _broadcastAll({ type: 'node.online', node_id: nodeId, node_name: node.name });

    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());

        // Antwort auf Request
        if (msg.type === 'reply' && msg.req_id) {
          const pending = conn.pendingReplies.get(msg.req_id);
          if (pending) {
            clearTimeout(pending.timer);
            conn.pendingReplies.delete(msg.req_id);
            msg.success !== false ? pending.resolve(msg) : pending.reject(new Error(msg.error || 'Daemon-Fehler'));
          }
          return;
        }

        // Heartbeat / Hello
        if (msg.type === 'heartbeat' || msg.type === 'hello') {
          conn.info = msg.system;
          db.prepare("UPDATE nodes SET last_seen=datetime('now'), system_info=? WHERE id=?")
            .run(JSON.stringify(msg.system), nodeId);
          if (msg.type === 'hello') {
            _broadcastAll({ type: 'node.info', node_id: nodeId, system: msg.system });
          }
          return;
        }

        // Live-Events → an Panel-Clients weiterleiten
        if (msg.type === 'server.log' && msg.server_id) {
          _broadcastSub({ type: 'console', server_id: msg.server_id, data: msg.data },
            `console:${msg.server_id}`);
          return;
        }

        if (msg.type === 'server.stats' && msg.server_id) {
          _broadcastSub({ type: 'stats', server_id: msg.server_id, data: msg.data }, msg.server_id);
          return;
        }

        if (msg.type === 'server.status' && msg.server_id) {
          db.prepare("UPDATE servers SET status=?, updated_at=datetime('now') WHERE id=?")
            .run(msg.status, msg.server_id);
          _broadcastAll({ type: 'server.status', server_id: msg.server_id, status: msg.status });
          return;
        }

      } catch (e) {
        console.error('Daemon-Message-Fehler:', e.message);
      }
    });

    ws.on('close', () => {
      console.log(`🔴 Node getrennt: ${node.name}`);
      // Alle ausstehenden Requests ablehnen
      for (const [, { reject, timer }] of conn.pendingReplies) {
        clearTimeout(timer);
        reject(new Error('Node-Verbindung getrennt'));
      }
      connections.delete(nodeId);
      db.prepare("UPDATE nodes SET status='offline' WHERE id=?").run(nodeId);
      _broadcastAll({ type: 'node.offline', node_id: nodeId, node_name: node.name });
    });

    ws.on('error', e => console.error(`Node ${node.name} Fehler:`, e.message));
  });

  return daemonWss;
}

function getDaemonWss() { return _daemonWss; }
module.exports = { daemonRequest, daemonSend, isConnected, getConnectionInfo, attachDaemonEndpoint, getDaemonWss, setBroadcasters, connections };
