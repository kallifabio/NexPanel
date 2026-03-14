/**
 * mod-auto-updater.js — Background Auto-Update Engine
 *
 * Wird vom scheduler.js aufgerufen wenn auto_update=1 für einen Server.
 * Führt denselben Flow wie die REST-API durch, aber serverless.
 */
'use strict';

const { db, auditLog } = require('../core/db');
const { v4: uuidv4 }   = require('uuid');

async function checkAndAutoUpdate(serverId) {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);
  if (!srv || !srv.container_id) return;

  // Simuliere einen internen HTTP-Call zum eigenen /mods/check-updates Endpunkt
  // Stattdessen nutzen wir direkt die Logik aus routes/mods.js
  const modsRouter = require('../../routes/mods');

  // Wir bauen einen Mini-Request/Response
  let checkResult = null;
  const fakeReq = {
    params:  { serverId },
    query:   {},
    body:    {},
    user:    { id: 'system', role: 'admin' },
    srv,
    ip:      'system',
    headers: {},
  };
  const fakeRes = {
    status(code) { this._code = code; return this; },
    json(data)   { checkResult = data; },
    _code: 200,
  };

  // Direkter Aufruf der internen Funktion statt HTTP
  // Wir importieren die nötige Logik direkt
  try {
    const https   = require('https');
    const http    = require('http');
    const { routeToNode } = require('../docker/node-router');

    const MODRINTH_UA = 'NexPanel/3.0 (github.com/nexpanel)';

    function fetchUrl(url, headers = {}) {
      return new Promise((resolve, reject) => {
        const mod  = url.startsWith('https') ? https : http;
        const opts = Object.assign(new URL(url), { headers: { 'User-Agent': MODRINTH_UA, ...headers } });
        mod.get(opts, res => {
          if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location)
            return resolve(fetchUrl(res.headers.location, headers));
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        }).on('error', reject);
      });
    }

    async function fetchJSON(url, headers = {}) {
      const { status, body } = await fetchUrl(url, headers);
      if (status >= 400) throw new Error(`HTTP ${status}`);
      return JSON.parse(body.toString());
    }

    async function containerExec(s, cmd, timeout = 60_000) {
      const result = await routeToNode(s.node_id, {
        type: 'server.command', server_id: s.id,
        container_id: s.container_id, command: cmd,
      }, timeout);
      return result.output || '';
    }

    // Detect platform
    const img = (srv.image||'').toLowerCase();
    const env = JSON.parse(srv.env_vars || '{}');
    let loader = 'paper';
    if (img.includes('itzg') || img.includes('minecraft')) {
      const type = (env.TYPE || env.SERVER_TYPE || '').toLowerCase();
      if (type.includes('fabric')) loader = 'fabric';
      else if (type.includes('forge')) loader = 'forge';
      else if (type.includes('neoforge')) loader = 'neoforge';
      else if (type.includes('quilt')) loader = 'quilt';
    }

    const base = (srv.image||'').includes('itzg') || (srv.image||'').includes('minecraft-server') ? '/data' : '/home/container';
    const dirs = [`${base}/plugins`, `${base}/mods`];

    // Get file hashes
    const modFiles = [];
    for (const dir of dirs) {
      const out = await containerExec(srv,
        `find "${dir}" -maxdepth 1 -name "*.jar" -type f 2>/dev/null | while read f; do ` +
        `hash=$(sha1sum "$f" 2>/dev/null | cut -d' ' -f1); echo "$hash\t$(basename "$f")\t$dir"; done || echo ""`,
        30_000
      ).catch(() => '');
      for (const line of out.split('\n').filter(Boolean)) {
        const parts = line.split('\t');
        if (parts.length < 3 || !parts[0] || parts[0].length !== 40) continue;
        modFiles.push({ hash: parts[0], name: parts[1], dir: parts[2] });
      }
    }

    if (!modFiles.length) {
      db.prepare("UPDATE mod_update_settings SET last_check_at=datetime('now') WHERE server_id=?").run(serverId);
      return;
    }

    // Modrinth batch lookup
    const hashes = modFiles.map(m => m.hash);
    let hashMap = {};
    try {
      const data  = JSON.stringify({ hashes, algorithm: 'sha1' });
      const u     = new URL('https://api.modrinth.com/v2/version_files');
      const reqP  = { hostname: u.hostname, path: u.pathname, method: 'POST',
        headers: { 'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'User-Agent':MODRINTH_UA,'Accept':'application/json' } };
      hashMap = await new Promise((res, rej) => {
        const req = https.request(reqP, r => {
          let buf = ''; r.on('data', c => buf+=c);
          r.on('end', () => { try { res(JSON.parse(buf)); } catch { res({}); } });
        }); req.on('error', rej); req.write(data); req.end();
      });
    } catch {}

    // Find updates and apply them
    let updatedCount = 0;
    const projectsSeen = new Set();

    for (const modFile of modFiles) {
      const vInfo = hashMap[modFile.hash];
      if (!vInfo) continue;
      const pid = vInfo.project_id;
      if (projectsSeen.has(pid)) continue;
      projectsSeen.add(pid);

      // Get latest version
      let versions = [];
      try {
        const params = new URLSearchParams({ loaders: JSON.stringify([loader]) });
        versions = await fetchJSON(`https://api.modrinth.com/v2/project/${pid}/version?${params}`, { 'User-Agent': MODRINTH_UA });
      } catch {
        try { versions = await fetchJSON(`https://api.modrinth.com/v2/project/${pid}/version`, { 'User-Agent': MODRINTH_UA }); } catch {}
      }
      if (!versions?.length) continue;

      const latest = versions[0];
      if (latest.id === vInfo.id) continue; // Already up to date

      const primaryFile = (latest.files||[]).find(f=>f.primary) || latest.files?.[0];
      if (!primaryFile?.url) continue;

      // Download new version
      const destPath = `${modFile.dir}/${primaryFile.filename}`;
      const dlCmd    = `wget -q -O "${destPath}" "${primaryFile.url}" 2>&1 && echo "DL_OK" || (curl -fsSL -o "${destPath}" "${primaryFile.url}" && echo "DL_OK")`;
      const dlOut    = await containerExec(srv, dlCmd, 120_000);

      if (!dlOut.includes('DL_OK')) continue;

      // Delete old if different filename
      const oldPath = `${modFile.dir}/${modFile.name}`;
      if (oldPath !== destPath) {
        await containerExec(srv, `rm -f "${oldPath}"`);
      }

      db.prepare(`INSERT INTO mod_update_log (id,server_id,mod_name,old_version,new_version,project_id,status) VALUES (?,?,?,?,?,?,'updated')`)
        .run(uuidv4(), serverId, vInfo.project_id, vInfo.version_number, latest.version_number, pid);

      console.log(`[mod-autoupdate] ${serverId}: ${modFile.name} → ${latest.version_number}`);
      updatedCount++;
    }

    db.prepare("UPDATE mod_update_settings SET last_check_at=datetime('now') WHERE server_id=?").run(serverId);

    if (updatedCount > 0) {
      console.log(`[mod-autoupdate] ${serverId}: ${updatedCount} Mod(s) aktualisiert`);
    }
  } catch (e) {
    console.warn('[mod-auto-updater] Fehler:', e.message);
  }
}

module.exports = { checkAndAutoUpdate };
