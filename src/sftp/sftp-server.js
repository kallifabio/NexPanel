'use strict';
/**
 * sftp-server.js — NexPanel SFTP Gateway
 *
 * Startet einen SSH/SFTP-Server. Clients verbinden sich mit:
 *   Host: <panel-ip>
 *   Port: SFTP_PORT (Standard: 2022)
 *   User: <nexpanel-username>.<server-id-prefix>   (z.B. admin.a1b2c3)
 *   Pass: <nexpanel-passwort>
 *
 * Alle Dateioperationen werden auf den jeweiligen Docker-Container weitergeleitet.
 *
 * Benötigt: npm install ssh2
 */

const { Server: SshServer } = require('ssh2');
const { utils: { generateKeyPairSync } } = require('ssh2');
const fs   = require('fs');
const path = require('path');
const { db }           = require('../core/db');
const bcrypt           = require('bcryptjs');
const { routeToNode }  = require('../docker/node-router');

const SFTP_PORT     = parseInt(process.env.SFTP_PORT || '2022');
// Use SFTP_HOST_KEY_PATH env var (matches .env.example), default to ./data/sftp_host_key
const HOST_KEY_PATH = process.env.SFTP_HOST_KEY_PATH
  || path.join(process.cwd(), 'data', 'sftp_host_key');

// ─── HOST KEY ─────────────────────────────────────────────────────────────────
function ensureHostKey() {
  // Ensure data/ directory exists
  fs.mkdirSync(path.dirname(HOST_KEY_PATH), { recursive: true });

  if (!fs.existsSync(HOST_KEY_PATH)) {
    console.log('[sftp] Generiere Host-Key...');
    try {
      const { private: priv } = generateKeyPairSync('ed25519');
      fs.writeFileSync(HOST_KEY_PATH, priv, { mode: 0o600 });
      console.log('[sftp] Host-Key gespeichert:', HOST_KEY_PATH);
    } catch (e) {
      // Fallback: ssh-keygen
      const { execSync } = require('child_process');
      try {
        execSync(`ssh-keygen -t ed25519 -N "" -f "${HOST_KEY_PATH}" 2>/dev/null`);
      } catch {
        execSync(`ssh-keygen -t rsa -b 2048 -N "" -f "${HOST_KEY_PATH}" 2>/dev/null`);
      }
    }
  }
  return fs.readFileSync(HOST_KEY_PATH);
}

// ─── AUTH: username = "nexpanel-user.server-id-prefix" ────────────────────────
async function resolveAuth(username, password) {
  const parts = username.split('.');
  if (parts.length < 2) return null;

  const serverPrefix = parts[parts.length - 1];
  const panelUser    = parts.slice(0, -1).join('.');

  // User suchen
  const user = db.prepare('SELECT * FROM users WHERE username=? AND is_suspended=0').get(panelUser);
  if (!user) return null;

  // Passwort prüfen
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;

  // Server suchen (prefix = erste 6 Zeichen der ID)
  const server = db.prepare("SELECT * FROM servers WHERE id LIKE ?").get(serverPrefix + '%');
  if (!server) return null;

  // Zugriff prüfen: Besitzer oder Admin oder Sub-User mit 'files'
  if (user.role !== 'admin' && server.user_id !== user.id) {
    const sub = db.prepare(
      "SELECT permissions FROM server_subusers WHERE server_id=? AND user_id=?"
    ).get(server.id, user.id);
    if (!sub) return null;
    const perms = JSON.parse(sub.permissions || '[]');
    if (!perms.includes('files')) return null;
  }

  return { user, server };
}

// ─── SFTP-SESSION ──────────────────────────────────────────────────────────────
function handleSftp(session, server, user) {
  session.on('sftp', (accept) => {
    const sftp = accept();
    const openFiles = new Map();
    let handleCounter = 0;
    const workDir = server.work_dir || '/home/container';

    function absPath(p) {
      if (!p || p === '/' || p === '') return workDir;
      if (path.isAbsolute(p)) {
        // Wenn der Pfad bereits unter workDir liegt → unverändert
        // Sonst workDir voranstellen (Sicherheit)
        if (p.startsWith(workDir)) return p;
        return path.posix.join(workDir, p);
      }
      return path.posix.join(workDir, p);
    }

    function sftpAttrs(entry) {
      return {
        mode:  entry.type === 'directory' ? 0o040755 : 0o100644,
        uid:   0,
        gid:   0,
        size:  entry.size || 0,
        atime: Math.floor(new Date(entry.modified || Date.now()).getTime() / 1000),
        mtime: Math.floor(new Date(entry.modified || Date.now()).getTime() / 1000),
      };
    }

    // REALPATH
    sftp.on('REALPATH', (reqid, p) => {
      sftp.name(reqid, [{ filename: absPath(p), longname: absPath(p), attrs: {} }]);
    });

    // STAT / LSTAT
    async function doStat(reqid, p) {
      try {
        const entries = await routeToNode(server.node_id, {
          type: 'files.list', server_id: server.id,
          container_id: server.container_id, path: path.posix.dirname(absPath(p)),
        }, 10_000);
        const name = path.posix.basename(absPath(p));
        const entry = entries.files?.find(e => e.name === name);
        if (!entry && absPath(p) === workDir) {
          return sftp.attrs(reqid, { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 });
        }
        if (!entry) return sftp.status(reqid, 2); // SSH_FX_NO_SUCH_FILE
        sftp.attrs(reqid, sftpAttrs(entry));
      } catch { sftp.status(reqid, 4); }
    }
    sftp.on('STAT',  (reqid, p) => doStat(reqid, p));
    sftp.on('LSTAT', (reqid, p) => doStat(reqid, p));

    // OPENDIR
    sftp.on('OPENDIR', (reqid, p) => {
      const h = Buffer.alloc(4);
      h.writeUInt32BE(++handleCounter, 0);
      openFiles.set(handleCounter, { type: 'dir', path: absPath(p), listed: false, entries: [] });
      sftp.handle(reqid, h);
    });

    // READDIR
    sftp.on('READDIR', async (reqid, handle) => {
      const hid = handle.readUInt32BE(0);
      const info = openFiles.get(hid);
      if (!info || info.type !== 'dir') return sftp.status(reqid, 4);

      if (info.listed) return sftp.status(reqid, 1); // SSH_FX_EOF

      try {
        const result = await routeToNode(server.node_id, {
          type: 'files.list', server_id: server.id,
          container_id: server.container_id, path: info.path,
        }, 10_000);

        info.listed = true;
        const entries = (result.files || []).map(e => ({
          filename: e.name,
          longname: `${e.type === 'directory' ? 'd' : '-'}rw-r--r-- 1 root root ${e.size || 0} Jan 1 00:00 ${e.name}`,
          attrs: sftpAttrs(e),
        }));

        if (entries.length === 0) return sftp.status(reqid, 1);
        sftp.name(reqid, entries);
      } catch { sftp.status(reqid, 4); }
    });

    // CLOSEDIR / CLOSEFILE
    sftp.on('CLOSE', (reqid, handle) => {
      const hid = handle.readUInt32BE(0);
      openFiles.delete(hid);
      sftp.status(reqid, 0);
    });

    // OPEN (file)
    sftp.on('OPEN', async (reqid, filename, flags) => {
      const absp = absPath(filename);
      try {
        let content = '';
        // flags: 1=READ, 2=WRITE, 8=CREATE, 16=TRUNC
        if (flags & 1) {
          const result = await routeToNode(server.node_id, {
            type: 'files.read', server_id: server.id,
            container_id: server.container_id, path: absp,
          }, 15_000);
          content = result.content || '';
        }
        const h = Buffer.alloc(4);
        h.writeUInt32BE(++handleCounter, 0);
        openFiles.set(handleCounter, { type: 'file', path: absp, content, offset: 0, dirty: false, writeMode: !!(flags & 2) });
        sftp.handle(reqid, h);
      } catch { sftp.status(reqid, 4); }
    });

    // READ
    sftp.on('READ', (reqid, handle, offset, length) => {
      const hid = handle.readUInt32BE(0);
      const info = openFiles.get(hid);
      if (!info || info.type !== 'file') return sftp.status(reqid, 4);

      const buf = Buffer.from(info.content, 'utf8');
      if (offset >= buf.length) return sftp.status(reqid, 1); // EOF
      const slice = buf.slice(offset, offset + length);
      sftp.data(reqid, slice);
    });

    // WRITE
    sftp.on('WRITE', (reqid, handle, offset, data) => {
      const hid = handle.readUInt32BE(0);
      const info = openFiles.get(hid);
      if (!info || info.type !== 'file') return sftp.status(reqid, 4);

      const buf = Buffer.from(info.content, 'utf8');
      const newBuf = Buffer.alloc(Math.max(buf.length, offset + data.length));
      buf.copy(newBuf);
      data.copy(newBuf, offset);
      info.content = newBuf.toString('utf8');
      info.dirty = true;
      sftp.status(reqid, 0);
    });

    // FSETSTAT / commit write on close
    sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, 0));
    sftp.on('SETSTAT',  (reqid) => sftp.status(reqid, 0));

    // CLOSE — flush write
    sftp.on('CLOSE', async (reqid, handle) => {
      const hid = handle.readUInt32BE(0);
      const info = openFiles.get(hid);
      openFiles.delete(hid);

      if (info?.dirty) {
        try {
          await routeToNode(server.node_id, {
            type: 'files.write', server_id: server.id,
            container_id: server.container_id, path: info.path, content: info.content,
          }, 15_000);
        } catch (e) { console.warn('[sftp] Write flush error:', e.message); }
      }
      sftp.status(reqid, 0);
    });

    // REMOVE
    sftp.on('REMOVE', async (reqid, p) => {
      try {
        await routeToNode(server.node_id, {
          type: 'files.delete', server_id: server.id,
          container_id: server.container_id, path: absPath(p),
        }, 10_000);
        sftp.status(reqid, 0);
      } catch { sftp.status(reqid, 4); }
    });

    // RENAME
    sftp.on('RENAME', async (reqid, oldPath, newPath) => {
      try {
        await routeToNode(server.node_id, {
          type: 'files.rename', server_id: server.id,
          container_id: server.container_id, from: absPath(oldPath), to: absPath(newPath),
        }, 10_000);
        sftp.status(reqid, 0);
      } catch { sftp.status(reqid, 4); }
    });

    // MKDIR
    sftp.on('MKDIR', async (reqid, p) => {
      try {
        await routeToNode(server.node_id, {
          type: 'files.create', server_id: server.id,
          container_id: server.container_id, path: absPath(p), file_type: 'directory',
        }, 10_000);
        sftp.status(reqid, 0);
      } catch { sftp.status(reqid, 4); }
    });

    // RMDIR
    sftp.on('RMDIR', async (reqid, p) => {
      try {
        await routeToNode(server.node_id, {
          type: 'files.delete', server_id: server.id,
          container_id: server.container_id, path: absPath(p),
        }, 10_000);
        sftp.status(reqid, 0);
      } catch { sftp.status(reqid, 4); }
    });
  });
}

// ─── SERVER STARTEN ───────────────────────────────────────────────────────────
function startSftpServer() {
  let hostKey;
  try {
    hostKey = ensureHostKey();
  } catch (e) {
    console.warn('[sftp] Host-Key konnte nicht geladen/generiert werden:', e.message);
    console.warn('[sftp] SFTP-Server wird nicht gestartet.');
    return;
  }

  const sshServer = new SshServer({ hostKeys: [hostKey] }, (client) => {
    let authCtx = null;

    client.on('authentication', async (ctx) => {
      if (ctx.method !== 'password') return ctx.reject(['password']);
      try {
        const resolved = await resolveAuth(ctx.username, ctx.password);
        if (!resolved) return ctx.reject();
        authCtx = resolved;
        ctx.accept();
      } catch { ctx.reject(); }
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        handleSftp(session, authCtx.server, authCtx.user);
      });
    });

    client.on('error', (e) => {
      if (!['ECONNRESET','ETIMEDOUT'].includes(e.code))
        console.warn('[sftp] Client-Fehler:', e.message);
    });
  });

  sshServer.on('error', (e) => {
    console.error('[sftp] Server-Fehler:', e.message);
  });

  sshServer.listen(SFTP_PORT, '0.0.0.0', () => {
    console.log(`[sftp] SFTP-Server lauscht auf Port ${SFTP_PORT}`);
    console.log(`[sftp] Verbindung: sftp <user>.<server-id-prefix>@<host> -P ${SFTP_PORT}`);
  });

  return sshServer;
}

module.exports = { startSftpServer, SFTP_PORT };
