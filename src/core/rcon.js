'use strict';
/**
 * src/core/rcon.js — Minecraft RCON-Protokoll (reines TCP, kein externer Dep)
 *
 * Source-RCON-Protokoll (Valve/Minecraft):
 *   Paket: [Length(4)] [RequestID(4)] [Type(4)] [Body(\0)] [\0]
 *   Types: 3 = LOGIN, 2 = COMMAND, 0 = RESPONSE
 *
 * Nutzung:
 *   const rcon = new RconClient({ host, port, password });
 *   await rcon.connect();
 *   const resp = await rcon.send('list');
 *   rcon.disconnect();
 */

const net = require('net');

const PKT_COMMAND       = 2;
const PKT_AUTH          = 3;
const PKT_AUTH_RESPONSE = 2;
const AUTH_FAILED_ID    = -1;

class RconClient {
  constructor({ host = '127.0.0.1', port = 25575, password = '', timeout = 8000 } = {}) {
    this.host     = host;
    this.port     = parseInt(port) || 25575;
    this.password = password;
    this.timeout  = timeout;
    this._socket  = null;
    this._reqId   = 1;
    this._pending = new Map();   // reqId → { resolve, reject, timer }
    this._buf     = Buffer.alloc(0);
  }

  // ── Verbinden + Authentifizieren ─────────────────────────────────────────────
  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setTimeout(this.timeout);

      socket.on('timeout', () => {
        socket.destroy(new Error(`RCON-Timeout (${this.timeout}ms)`));
      });

      socket.once('error', err => {
        this._socket = null;
        reject(new Error(`RCON-Verbindungsfehler: ${err.message}`));
      });

      socket.once('connect', async () => {
        this._socket = socket;
        socket.on('data', d => this._onData(d));
        socket.on('close', () => {
          // Alle ausstehenden Anfragen abbrechen
          for (const { reject: rej, timer } of this._pending.values()) {
            clearTimeout(timer);
            rej(new Error('RCON-Verbindung getrennt'));
          }
          this._pending.clear();
          this._socket = null;
        });

        // Authenticate
        try {
          await this._auth();
          resolve();
        } catch (e) {
          socket.destroy();
          this._socket = null;
          reject(e);
        }
      });
    });
  }

  // ── Befehl senden ────────────────────────────────────────────────────────────
  send(command) {
    if (!this._socket) return Promise.reject(new Error('RCON nicht verbunden'));
    return this._packet(PKT_COMMAND, command);
  }

  // ── Verbindung trennen ────────────────────────────────────────────────────────
  disconnect() {
    if (this._socket) {
      try { this._socket.destroy(); } catch (_) {}
      this._socket = null;
    }
  }

  get connected() { return !!this._socket; }

  // ── Intern: Authentifizieren ──────────────────────────────────────────────────
  async _auth() {
    const id  = this._nextId();
    const buf = this._buildPacket(id, PKT_AUTH, this.password);
    this._socket.write(buf);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('RCON-Auth-Timeout'));
      }, this.timeout);

      this._pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timer);
          // Auth-Antwort: RequestID = -1 → falsches Passwort
          if (resp.requestId === AUTH_FAILED_ID) {
            reject(new Error('RCON-Authentifizierung fehlgeschlagen (falsches Passwort)'));
          } else {
            resolve();
          }
        },
        reject: (e) => { clearTimeout(timer); reject(e); },
        timer,
        isAuth: true,
      });
    });
  }

  // ── Intern: Paket senden und auf Antwort warten ──────────────────────────────
  _packet(type, body) {
    return new Promise((resolve, reject) => {
      if (!this._socket) return reject(new Error('Nicht verbunden'));
      const id  = this._nextId();
      const buf = this._buildPacket(id, type, body);

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`RCON-Timeout für Befehl: ${body.slice(0, 30)}`));
      }, this.timeout);

      this._pending.set(id, {
        resolve: (resp) => { clearTimeout(timer); resolve(resp.body || ''); },
        reject:  (e)    => { clearTimeout(timer); reject(e); },
        timer,
      });

      try {
        this._socket.write(buf);
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // ── Intern: Eingehende Daten parsen ──────────────────────────────────────────
  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);

    while (this._buf.length >= 4) {
      const pktLen = this._buf.readInt32LE(0);
      const totalLen = pktLen + 4;

      if (this._buf.length < totalLen) break;

      const requestId = this._buf.readInt32LE(4);
      const type      = this._buf.readInt32LE(8);
      // Body: bytes 12 bis (totalLen - 2) — zwei abschließende Nullbytes
      const body = this._buf.slice(12, totalLen - 2).toString('utf8');

      this._buf = this._buf.slice(totalLen);

      // Auth-Antwort: type=2 (PKT_AUTH_RESPONSE) oder requestId=-1
      const pending = this._pending.get(requestId);
      if (pending) {
        this._pending.delete(requestId);
        pending.resolve({ requestId, type, body });
      } else if (requestId === AUTH_FAILED_ID) {
        // Auth-Fehler-Broadcast: suche ausstehende Auth-Anfragen
        for (const [id, p] of this._pending) {
          if (p.isAuth) {
            this._pending.delete(id);
            p.resolve({ requestId: AUTH_FAILED_ID, type, body });
            break;
          }
        }
      }
    }
  }

  // ── Intern: Paket aufbauen ────────────────────────────────────────────────────
  _buildPacket(id, type, body) {
    const bodyBuf = Buffer.from(body || '', 'utf8');
    const pktLen  = 4 + 4 + bodyBuf.length + 2; // requestId + type + body + 2×null
    const buf     = Buffer.alloc(4 + pktLen);
    let off = 0;
    buf.writeInt32LE(pktLen, off); off += 4;
    buf.writeInt32LE(id,     off); off += 4;
    buf.writeInt32LE(type,   off); off += 4;
    bodyBuf.copy(buf, off);        off += bodyBuf.length;
    buf.writeUInt8(0, off++);
    buf.writeUInt8(0, off);
    return buf;
  }

  _nextId() {
    this._reqId = (this._reqId % 0x7FFFFFFF) + 1;
    return this._reqId;
  }
}

// ── Connection-Pool (pro Server 1 persistente Verbindung) ─────────────────────
const pool = new Map();  // serverId → { client, ts, connecting }

async function getConnection(serverId, opts) {
  const existing = pool.get(serverId);
  if (existing?.client?.connected) {
    existing.ts = Date.now();
    return existing.client;
  }

  // Entfernen falls tot
  if (existing) pool.delete(serverId);

  const client = new RconClient(opts);
  pool.set(serverId, { client, ts: Date.now() });
  await client.connect();
  return client;
}

function closeConnection(serverId) {
  const entry = pool.get(serverId);
  if (entry) {
    entry.client.disconnect();
    pool.delete(serverId);
  }
}

// Idle-Pool-Cleaner: schließt Verbindungen die > 5 Min idle sind
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pool) {
    if (now - entry.ts > 5 * 60 * 1000) {
      entry.client.disconnect();
      pool.delete(id);
    }
  }
}, 60_000);

module.exports = { RconClient, getConnection, closeConnection };
