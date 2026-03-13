'use strict';
/**
 * routes/mods.js — Mod/Plugin-Installer
 *
 * Unterstützte Plattformen:
 *   • Modrinth    — kostenlose offene API (Minecraft Mods/Plugins/Modpacks)
 *   • CurseForge  — braucht API-Key (CURSEFORGE_API_KEY env)
 *   • Steam Workshop — steamcmd inside container
 *   • Generic     — beliebige URL oder GitHub Release
 *
 * Installation: wget / curl direkt im Container
 */

const express = require('express');
const https   = require('https');
const http    = require('http');
const { db, auditLog } = require('../db');
const { authenticate } = require('./auth');
const { routeToNode }  = require('../node-router');

const router = express.Router({ mergeParams: true });

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CURSEFORGE_KEY = process.env.CURSEFORGE_API_KEY || '';
const MODRINTH_UA    = 'NexPanel/3.0 (github.com/nexpanel)';

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function canAccess(req, res, next) {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (req.user.role !== 'admin' && srv.user_id !== req.user.id)
    return res.status(403).json({ error: 'Kein Zugriff' });
  req.srv = srv;
  next();
}

// HTTP GET with redirect follow → returns Buffer
function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const opts = Object.assign(new URL(url), { headers: { 'User-Agent': MODRINTH_UA, ...headers } });
    mod.get(opts, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(fetchUrl(res.headers.location, headers));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchJSON(url, headers = {}) {
  const { status, body } = await fetchUrl(url, headers);
  if (status >= 400) throw new Error(`HTTP ${status}: ${url}`);
  return JSON.parse(body.toString());
}

// Run a shell command in the container via node-router
async function containerExec(srv, cmd, timeout = 60_000) {
  const result = await routeToNode(srv.node_id, {
    type: 'server.command',
    server_id: srv.id,
    container_id: srv.container_id,
    command: cmd,
  }, timeout);
  return result.output || '';
}

// Detect which loader/platform this server uses based on image + egg
function detectPlatform(srv) {
  const img  = (srv.image || '').toLowerCase();
  const egg  = srv.egg_id ? (db.prepare('SELECT category FROM eggs WHERE id=?').get(srv.egg_id)?.category || '') : '';
  const env  = JSON.parse(srv.env_vars || '{}');

  if (img.includes('itzg/minecraft') || img.includes('minecraft')) {
    const type = (env.TYPE || env.SERVER_TYPE || '').toLowerCase();
    if (type.includes('fabric'))    return { game: 'minecraft', loader: 'fabric' };
    if (type.includes('quilt'))     return { game: 'minecraft', loader: 'quilt' };
    if (type.includes('neoforge') || type.includes('neo')) return { game: 'minecraft', loader: 'neoforge' };
    if (type.includes('forge'))     return { game: 'minecraft', loader: 'forge' };
    if (type.includes('paper') || type.includes('purpur')) return { game: 'minecraft', loader: 'paper' };
    if (type.includes('spigot'))    return { game: 'minecraft', loader: 'spigot' };
    if (type.includes('bungeecord') || type.includes('bungee')) return { game: 'minecraft', loader: 'bungeecord' };
    if (type.includes('velocity'))  return { game: 'minecraft', loader: 'velocity' };
    // default: paper (most common)
    return { game: 'minecraft', loader: 'paper' };
  }
  if (img.includes('steamcmd') || img.includes('cs2') || img.includes('srcds') || img.includes('steamcmd'))
    return { game: 'source', loader: 'metamod' };
  if (img.includes('valheim'))
    return { game: 'valheim', loader: 'bepinex' };

  return { game: 'generic', loader: 'generic' };
}

// Map loader → Modrinth project_type facets
function loaderToModrinthFacets(loader) {
  const pluginLoaders = ['paper', 'spigot', 'bungeecord', 'velocity', 'purpur'];
  const modLoaders    = ['fabric', 'forge', 'quilt', 'neoforge'];
  if (pluginLoaders.includes(loader)) return `[["project_type:plugin"]]`;
  if (modLoaders.includes(loader))    return `[["project_type:mod"]]`;
  return `[["project_type:mod"],["project_type:plugin"]]`;
}

// ─── PLATFORM INFO ───────────────────────────────────────────────────────────
router.get('/platform', authenticate, canAccess, (req, res) => {
  const srv      = req.srv;
  const platform = detectPlatform(srv);
  res.json({
    ...platform,
    has_curseforge: !!CURSEFORGE_KEY,
    container_ready: !!srv.container_id,
    server_id: srv.id,
  });
});

// ─── MODRINTH SEARCH ────────────────────────────────────────────────────────
router.get('/modrinth/search', authenticate, canAccess, async (req, res) => {
  try {
    const { q = '', limit = 20, offset = 0, category } = req.query;
    const platform = detectPlatform(req.srv);
    const facets   = loaderToModrinthFacets(platform.loader);
    const params   = new URLSearchParams({
      query:  q,
      limit:  Math.min(parseInt(limit), 50),
      offset: parseInt(offset),
      facets,
    });
    const data = await fetchJSON(`https://api.modrinth.com/v2/search?${params}`, {
      'User-Agent': MODRINTH_UA,
    });
    res.json({
      hits:       (data.hits || []).map(h => ({
        id:           h.project_id,
        slug:         h.slug,
        title:        h.title,
        description:  h.description,
        icon:         h.icon_url,
        downloads:    h.downloads,
        categories:   h.categories,
        project_type: h.project_type,
        author:       h.author,
        versions:     h.versions,
        latest_version: h.latest_version,
        date_modified: h.date_modified,
        source: 'modrinth',
      })),
      total: data.total_hits || 0,
      offset: data.offset || 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── MODRINTH: GET VERSIONS ──────────────────────────────────────────────────
router.get('/modrinth/project/:projectId/versions', authenticate, canAccess, async (req, res) => {
  try {
    const platform = detectPlatform(req.srv);
    const params   = new URLSearchParams({ loaders: JSON.stringify([platform.loader]) });
    let versions;
    try {
      versions = await fetchJSON(
        `https://api.modrinth.com/v2/project/${req.params.projectId}/version?${params}`,
        { 'User-Agent': MODRINTH_UA }
      );
    } catch {
      // retry without loader filter
      versions = await fetchJSON(
        `https://api.modrinth.com/v2/project/${req.params.projectId}/version`,
        { 'User-Agent': MODRINTH_UA }
      );
    }
    res.json((versions || []).slice(0, 30).map(v => ({
      id:           v.id,
      name:         v.name,
      version:      v.version_number,
      game_versions: v.game_versions,
      loaders:      v.loaders,
      downloads:    v.downloads,
      date:         v.date_published,
      files: (v.files || []).map(f => ({
        filename: f.filename,
        url:      f.url,
        size:     f.size,
        primary:  f.primary,
      })),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CURSEFORGE SEARCH ───────────────────────────────────────────────────────
router.get('/curseforge/search', authenticate, canAccess, async (req, res) => {
  if (!CURSEFORGE_KEY) return res.status(400).json({ error: 'CURSEFORGE_API_KEY nicht konfiguriert' });
  try {
    const { q = '', limit = 20, offset = 0 } = req.query;
    const platform = detectPlatform(req.srv);
    // gameId 432 = Minecraft
    const params = new URLSearchParams({
      gameId:        432,
      searchFilter:  q,
      pageSize:      Math.min(parseInt(limit), 50),
      index:         parseInt(offset),
      sortField:     2, // popularity
      sortOrder:     'desc',
      classId:       platform.loader === 'paper' || platform.loader === 'spigot' ? 5 : 6, // 5=plugins 6=mods
    });
    const data = await fetchJSON(`https://api.curseforge.com/v1/mods/search?${params}`, {
      'x-api-key': CURSEFORGE_KEY,
    });
    res.json({
      hits: (data.data || []).map(m => ({
        id:          m.id,
        title:       m.name,
        description: m.summary,
        icon:        m.logo?.thumbnailUrl,
        downloads:   m.downloadCount,
        categories:  (m.categories || []).map(c => c.name),
        author:      m.authors?.[0]?.name,
        slug:        m.slug,
        source:      'curseforge',
        website:     m.links?.websiteUrl,
      })),
      total: data.pagination?.totalCount || 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CURSEFORGE: GET FILES ────────────────────────────────────────────────────
router.get('/curseforge/mod/:modId/files', authenticate, canAccess, async (req, res) => {
  if (!CURSEFORGE_KEY) return res.status(400).json({ error: 'CURSEFORGE_API_KEY nicht konfiguriert' });
  try {
    const data = await fetchJSON(
      `https://api.curseforge.com/v1/mods/${req.params.modId}/files?pageSize=20`,
      { 'x-api-key': CURSEFORGE_KEY }
    );
    res.json((data.data || []).map(f => ({
      id:            f.id,
      name:          f.displayName,
      filename:      f.fileName,
      url:           f.downloadUrl,
      size:          f.fileLength,
      game_versions: f.gameVersions,
      date:          f.fileDate,
      downloads:     f.downloadCount,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── STEAM WORKSHOP SEARCH ───────────────────────────────────────────────────
router.get('/workshop/search', authenticate, canAccess, async (req, res) => {
  try {
    const { q = '', appid = '730' } = req.query; // 730 = CS2
    // Steam Web API - no key needed for workshop browsing
    const body = JSON.stringify({
      query_type: 0, // k_EUCQResults_RankedByPublicationDate
      numperpage: 20,
      appid: parseInt(appid),
      search_text: q,
      return_metadata: true,
      return_previews: true,
    });
    const { status, body: responseBody } = await fetchUrl(
      'https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/?key=&format=json',
      { 'Content-Type': 'application/json' }
    );
    // Steam workshop search via web scraping fallback
    const params = new URLSearchParams({
      appid,
      searchtext:      q,
      return_metadata: 1,
      numperpage:      20,
    });
    const data = await fetchJSON(
      `https://api.steampowered.com/ISteamRemoteStorage/GetCollectionDetails/v1/?format=json`
    ).catch(() => null);

    // Return simplified workshop search results
    res.json({
      hits: [],
      note: `Steam Workshop Suche für App ${appid}. Nutze die Workshop-ID direkt für Installation.`,
      workshop_url: `https://steamcommunity.com/workshop/browse/?appid=${appid}&searchtext=${encodeURIComponent(q)}`,
      appid,
    });
  } catch (e) {
    res.json({ hits: [], note: 'Steam Workshop API nicht verfügbar. Nutze Workshop-ID direkt.', error: e.message });
  }
});

// ─── GITHUB RELEASES ─────────────────────────────────────────────────────────
router.get('/github/releases', authenticate, canAccess, async (req, res) => {
  try {
    const { repo } = req.query; // format: owner/repo
    if (!repo || !repo.includes('/')) return res.status(400).json({ error: 'repo muss "owner/repo" Format haben' });
    const data = await fetchJSON(`https://api.github.com/repos/${repo}/releases?per_page=10`, {
      'Accept':     'application/vnd.github.v3+json',
      'User-Agent': MODRINTH_UA,
    });
    res.json((data || []).map(r => ({
      id:         r.id,
      tag:        r.tag_name,
      name:       r.name,
      prerelease: r.prerelease,
      date:       r.published_at,
      body:       (r.body || '').substring(0, 300),
      assets:     (r.assets || []).map(a => ({
        id:       a.id,
        name:     a.name,
        url:      a.browser_download_url,
        size:     a.size,
        downloads: a.download_count,
      })),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── INSTALL ENDPOINT ────────────────────────────────────────────────────────
// Alle Installationen laufen als: wget/curl URL → Zielordner im Container
router.post('/install', authenticate, canAccess, async (req, res) => {
  try {
    const srv = req.srv;
    if (!srv.container_id) return res.status(400).json({ error: 'Container nicht bereit' });

    const {
      url,           // direkte Download-URL
      filename,      // Zieldateiname (optional, wird aus URL extrahiert)
      dest_dir,      // Zielordner im Container (default: /home/container/plugins oder /mods)
      source,        // 'modrinth'|'curseforge'|'workshop'|'generic'|'github'
      mod_name,      // Anzeigename für Audit
      workshop_id,   // Steam Workshop Item ID (statt url)
      appid,         // Steam AppID für Workshop
    } = req.body;

    const platform = detectPlatform(srv);

    // Steam Workshop: nutzt steamcmd inside container
    if (source === 'workshop' || workshop_id) {
      if (!workshop_id) return res.status(400).json({ error: 'workshop_id erforderlich' });
      const aid = appid || '730';
      const cmd = [
        `steamcmd +login anonymous`,
        `+workshop_download_item ${aid} ${workshop_id}`,
        `+quit`,
        `&& echo "WORKSHOP_OK"`,
      ].join(' ');
      const output = await containerExec(srv, cmd, 180_000);
      const success = output.includes('WORKSHOP_OK') || output.includes('Success');
      auditLog(req.user.id, 'MOD_INSTALL', 'server', srv.id,
        { source: 'workshop', workshop_id, appid: aid }, req.ip);
      return res.json({ success, output: output.trim() });
    }

    // Alle anderen: wget direkte URL in Container
    if (!url) return res.status(400).json({ error: 'url erforderlich' });

    // Zielordner bestimmen
    // itzg/minecraft-server → /data, alle anderen → /home/container
    const isItzgImg = (srv.image||'').includes('itzg') || (srv.image||'').includes('minecraft-server');
    const mcBase = isItzgImg ? '/data' : '/home/container';

    let targetDir = dest_dir;
    if (!targetDir) {
      if (platform.game === 'minecraft') {
        if (['fabric','forge','quilt','neoforge'].includes(platform.loader)) {
          targetDir = `${mcBase}/mods`;
        } else {
          targetDir = `${mcBase}/plugins`;
        }
      } else {
        targetDir = mcBase;
      }
    }

    const name = filename || decodeURIComponent(url.split('/').pop().split('?')[0]) || 'mod.jar';
    const destPath = `${targetDir}/${name}`;

    // Sicherstellen dass Ordner existiert
    const mkdirOut = await containerExec(srv, `mkdir -p "${targetDir}" && echo "MKDIR_OK"`);
    if (!mkdirOut.includes('MKDIR_OK')) {
      return res.status(500).json({ error: 'Ordner konnte nicht erstellt werden', output: mkdirOut });
    }

    // Download via wget (curl als Fallback)
    const wgetCmd = `wget -q --show-progress -O "${destPath}" "${url}" 2>&1 && echo "DL_OK" || curl -fsSL -o "${destPath}" "${url}" && echo "DL_OK"`;
    const output  = await containerExec(srv, wgetCmd, 120_000);
    const success = output.includes('DL_OK');

    // Dateigröße prüfen
    let fileSize = 0;
    if (success) {
      const szOut  = await containerExec(srv, `stat -c%s "${destPath}" 2>/dev/null || echo "0"`);
      fileSize = parseInt(szOut.trim()) || 0;
    }

    auditLog(req.user.id, 'MOD_INSTALL', 'server', srv.id,
      { source, url, name, dest: destPath }, req.ip);

    res.json({
      success,
      filename:  name,
      dest:      destPath,
      file_size: fileSize,
      output:    output.trim().slice(-500), // last 500 chars of wget output
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── LIST INSTALLED MODS ─────────────────────────────────────────────────────
router.get('/installed', authenticate, canAccess, async (req, res) => {
  try {
    const srv = req.srv;
    if (!srv.container_id) return res.json([]);
    const platform = detectPlatform(srv);

    const _base = (srv.image||'').includes('itzg') || (srv.image||'').includes('minecraft-server')
      ? '/data' : '/home/container';
    const dirs = platform.game === 'minecraft'
      ? [`${_base}/plugins`, `${_base}/mods`]
      : [_base];

    const results = [];
    for (const dir of dirs) {
      const out = await containerExec(srv,
        `ls -lA --time-style=+"%Y-%m-%d" "${dir}" 2>/dev/null | grep -E "\\.(jar|zip|smx|so|dll|vdf)$" || echo ""`
      );
      if (!out.trim()) continue;
      out.split('\n').filter(Boolean).forEach(line => {
        const m = line.match(/^.+?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!m) return;
        const [, size, date, name] = m;
        results.push({ name, size: parseInt(size), date, dir, ext: name.split('.').pop() });
      });
    }
    res.json(results);
  } catch (e) { res.json([]); }
});

// ─── DELETE INSTALLED MOD ────────────────────────────────────────────────────
router.delete('/installed', authenticate, canAccess, async (req, res) => {
  try {
    const srv = req.srv;
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path erforderlich' });
    // Safety: only allow deleting from known mod dirs
    const _delBase = (srv.image||'').includes('itzg') || (srv.image||'').includes('minecraft-server')
      ? '/data' : '/home/container';
    const allowed = [`${_delBase}/plugins/`, `${_delBase}/mods/`, `${_delBase}/`];
    if (!allowed.some(d => filePath.startsWith(d)))
      return res.status(400).json({ error: 'Pfad nicht erlaubt' });
    await containerExec(srv, `rm -f "${filePath}"`);
    auditLog(req.user.id, 'MOD_DELETE', 'server', srv.id, { path: filePath }, req.ip);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// MOD AUTO-UPDATE ENGINE
// ══════════════════════════════════════════════════════════════════════════════

// ─── POST body helper (für Modrinth batch lookup) ─────────────────────────────
function httpsPostJSON(url, body) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const data = JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent':     MODRINTH_UA,
        'Accept':         'application/json',
      },
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

// ─── SHA1-Hashes aller JARs im Container berechnen ───────────────────────────
async function getModHashes(srv) {
  const base = (srv.image||'').includes('itzg') || (srv.image||'').includes('minecraft-server')
    ? '/data' : '/home/container';
  const platform = detectPlatform(srv);
  const dirs = platform.game === 'minecraft'
    ? [`${base}/plugins`, `${base}/mods`]
    : [base];

  const results = [];
  for (const dir of dirs) {
    // find *.jar, compute sha1 for each, output: hash  filename  dir
    const out = await containerExec(srv,
      `find "${dir}" -maxdepth 1 -name "*.jar" -type f 2>/dev/null | while read f; do ` +
      `hash=$(sha1sum "$f" 2>/dev/null | cut -d' ' -f1); ` +
      `echo "$hash\t$(basename "$f")\t$dir"; done || echo ""`,
      30_000
    ).catch(() => '');

    for (const line of out.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      if (parts.length < 3 || !parts[0] || parts[0].length !== 40) continue;
      const [hash, name, d] = parts;
      results.push({ hash, name, dir: d });
    }
  }
  return results;
}

// ─── Modrinth Batch Hash Lookup ───────────────────────────────────────────────
// Returns map: hash → { project_id, version_id, version_number, project_title, ... }
async function modrinthHashLookup(hashes) {
  if (!hashes.length) return {};
  const { status, body } = await httpsPostJSON(
    'https://api.modrinth.com/v2/version_files',
    { hashes, algorithm: 'sha1' }
  );
  if (status >= 400) return {};
  // body is { [hash]: versionObject }
  return body || {};
}

// ─── Neueste Modrinth-Version für ein Projekt + Loader ───────────────────────
async function modrinthLatestVersion(projectId, loader) {
  try {
    const params = new URLSearchParams({ loaders: JSON.stringify([loader]) });
    let versions = await fetchJSON(
      `https://api.modrinth.com/v2/project/${projectId}/version?${params}`,
      { 'User-Agent': MODRINTH_UA }
    ).catch(() => null);

    // retry without loader filter
    if (!versions || !versions.length) {
      versions = await fetchJSON(
        `https://api.modrinth.com/v2/project/${projectId}/version`,
        { 'User-Agent': MODRINTH_UA }
      ).catch(() => []);
    }
    if (!versions || !versions.length) return null;
    // First = most recent (Modrinth returns newest first)
    const v = versions[0];
    const primaryFile = (v.files||[]).find(f=>f.primary) || v.files?.[0];
    return {
      version_id:     v.id,
      version_number: v.version_number,
      name:           v.name,
      date:           v.date_published,
      changelog:      v.changelog || '',
      game_versions:  v.game_versions || [],
      loaders:        v.loaders || [],
      download_url:   primaryFile?.url || null,
      filename:       primaryFile?.filename || null,
      file_size:      primaryFile?.size || 0,
    };
  } catch { return null; }
}

// ─── Modrinth Projekt-Info ─────────────────────────────────────────────────────
async function modrinthProjectInfo(projectId) {
  try {
    return await fetchJSON(`https://api.modrinth.com/v2/project/${projectId}`, { 'User-Agent': MODRINTH_UA });
  } catch { return null; }
}

// ─── GET /mods/update-settings ───────────────────────────────────────────────
router.get('/update-settings', authenticate, canAccess, (req, res) => {
  const serverId = req.params.serverId;
  let row = db.prepare('SELECT * FROM mod_update_settings WHERE server_id=?').get(serverId);
  if (!row) {
    db.prepare(`INSERT OR IGNORE INTO mod_update_settings (server_id) VALUES (?)`).run(serverId);
    row = db.prepare('SELECT * FROM mod_update_settings WHERE server_id=?').get(serverId);
  }
  res.json(row);
});

// ─── PUT /mods/update-settings ───────────────────────────────────────────────
router.put('/update-settings', authenticate, canAccess, (req, res) => {
  const serverId = req.params.serverId;
  const { auto_update, check_interval_h, notify_on_update } = req.body;
  db.prepare(`INSERT OR IGNORE INTO mod_update_settings (server_id) VALUES (?)`).run(serverId);
  db.prepare(`
    UPDATE mod_update_settings
    SET auto_update=?, check_interval_h=?, notify_on_update=?
    WHERE server_id=?
  `).run(
    auto_update ? 1 : 0,
    Math.min(168, Math.max(1, parseInt(check_interval_h) || 6)),
    notify_on_update ? 1 : 0,
    serverId
  );
  auditLog(req.user.id, 'MOD_AUTO_UPDATE_CFG', 'server', serverId,
    { auto_update, check_interval_h }, req.ip);
  res.json({ success: true });
});

// ─── GET /mods/update-log ─────────────────────────────────────────────────────
router.get('/update-log', authenticate, canAccess, (req, res) => {
  const serverId = req.params.serverId;
  const rows = db.prepare(`
    SELECT * FROM mod_update_log WHERE server_id=? ORDER BY updated_at DESC LIMIT 50
  `).all(serverId);
  res.json(rows);
});

// ─── POST /mods/check-updates ─────────────────────────────────────────────────
// Hauptendpunkt: berechnet Hashes, fragt Modrinth, gibt Update-Infos zurück
router.post('/check-updates', authenticate, canAccess, async (req, res) => {
  const srv = req.srv;
  if (!srv.container_id) return res.status(400).json({ error: 'Container nicht bereit' });

  try {
    const platform = detectPlatform(srv);

    // 1) SHA1 aller installierten JARs
    const modFiles = await getModHashes(srv);
    if (!modFiles.length) return res.json({ updates: [], checked: 0, matched: 0 });

    // 2) Modrinth batch lookup
    const hashes = modFiles.map(m => m.hash);
    const hashMap = await modrinthHashLookup(hashes);

    // 3) Für jede gematchte Version: neueste Version laden und vergleichen
    // Dedupliziere nach project_id
    const projectsSeen = new Set();
    const updateChecks = [];

    for (const modFile of modFiles) {
      const versionInfo = hashMap[modFile.hash];
      if (!versionInfo) {
        // Nicht in Modrinth — unbekannt
        updateChecks.push({
          name: modFile.name,
          hash: modFile.hash,
          dir:  modFile.dir,
          status: 'unknown',
          project_id: null,
          installed_version: null,
          installed_version_id: null,
          latest: null,
          has_update: false,
        });
        continue;
      }

      const projectId = versionInfo.project_id;
      if (projectsSeen.has(projectId)) continue;
      projectsSeen.add(projectId);

      const [latest, projectInfo] = await Promise.all([
        modrinthLatestVersion(projectId, platform.loader),
        modrinthProjectInfo(projectId),
      ]);

      const hasUpdate = latest && latest.version_id !== versionInfo.id &&
        latest.version_number !== versionInfo.version_number;

      updateChecks.push({
        name:                  modFile.name,
        hash:                  modFile.hash,
        dir:                   modFile.dir,
        status:                'tracked',
        project_id:            projectId,
        project_title:         projectInfo?.title || versionInfo.project_id,
        project_icon:          projectInfo?.icon_url || null,
        project_slug:          projectInfo?.slug || null,
        installed_version:     versionInfo.version_number,
        installed_version_id:  versionInfo.id,
        installed_version_name: versionInfo.name,
        latest,
        has_update:            !!hasUpdate,
      });
    }

    // Last-check timestamp
    db.prepare(`INSERT OR IGNORE INTO mod_update_settings (server_id) VALUES (?)`).run(srv.id);
    db.prepare(`UPDATE mod_update_settings SET last_check_at=datetime('now') WHERE server_id=?`).run(srv.id);

    const checked = updateChecks.filter(u => u.status === 'tracked').length;
    const updates = updateChecks.filter(u => u.has_update).length;

    res.json({
      updates:     updateChecks,
      checked,
      matched:     checked,
      untracked:   updateChecks.filter(u => u.status === 'unknown').length,
      has_updates: updates,
      checked_at:  new Date().toISOString(),
    });
  } catch (e) {
    console.error('[mods] check-updates Fehler:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /mods/changelog/:projectId/:versionId ────────────────────────────────
router.get('/changelog/:projectId/:versionId', authenticate, canAccess, async (req, res) => {
  try {
    const v = await fetchJSON(
      `https://api.modrinth.com/v2/version/${req.params.versionId}`,
      { 'User-Agent': MODRINTH_UA }
    );
    res.json({
      version_number: v.version_number,
      name:           v.name,
      changelog:      v.changelog || 'Kein Changelog verfügbar.',
      date:           v.date_published,
      game_versions:  v.game_versions || [],
      loaders:        v.loaders || [],
      downloads:      v.downloads || 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /mods/update ────────────────────────────────────────────────────────
// Aktualisiert einen einzelnen Mod: lädt neue Version, löscht alte
router.post('/update', authenticate, canAccess, async (req, res) => {
  const srv = req.srv;
  if (!srv.container_id) return res.status(400).json({ error: 'Container nicht bereit' });

  const {
    old_path,          // vollständiger Pfad der alten Datei im Container
    old_version,       // alte Versionsnummer
    project_id,
    project_title,
    download_url,
    filename,
    dir,
  } = req.body;

  if (!download_url || !dir) return res.status(400).json({ error: 'download_url und dir erforderlich' });

  try {
    const destPath = `${dir}/${filename}`;

    // mkdir sicherstellen
    await containerExec(srv, `mkdir -p "${dir}"`);

    // Neue Datei downloaden
    const dlCmd = `wget -q -O "${destPath}" "${download_url}" 2>&1 && echo "DL_OK" || (curl -fsSL -o "${destPath}" "${download_url}" && echo "DL_OK")`;
    const dlOut = await containerExec(srv, dlCmd, 120_000);

    if (!dlOut.includes('DL_OK')) {
      return res.status(500).json({ error: 'Download fehlgeschlagen', output: dlOut.slice(-300) });
    }

    // Alte Datei löschen (nur wenn != neue Datei)
    if (old_path && old_path !== destPath) {
      const base = (srv.image||'').includes('itzg') || (srv.image||'').includes('minecraft-server')
        ? '/data' : '/home/container';
      const allowedPrefixes = [`${base}/plugins/`, `${base}/mods/`, `${base}/`];
      if (allowedPrefixes.some(p => old_path.startsWith(p))) {
        await containerExec(srv, `rm -f "${old_path}"`);
      }
    }

    // Dateigröße
    const szOut  = await containerExec(srv, `stat -c%s "${destPath}" 2>/dev/null || echo "0"`);
    const fileSize = parseInt(szOut.trim()) || 0;

    // Update-Log
    const { v4: uuidv4 } = require('uuid');
    db.prepare(`
      INSERT INTO mod_update_log (id, server_id, mod_name, old_version, new_version, project_id, status)
      VALUES (?,?,?,?,?,?,'updated')
    `).run(uuidv4(), srv.id, project_title || filename, old_version || '?', req.body.new_version || '?', project_id || null);

    auditLog(req.user.id, 'MOD_UPDATE', 'server', srv.id,
      { project_id, project_title, old_version, new_version: req.body.new_version, filename }, req.ip);

    res.json({ success: true, filename, dest: destPath, file_size: fileSize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /mods/update-all ────────────────────────────────────────────────────
// Automatisches Update aller Mods mit verfügbarem Update
router.post('/update-all', authenticate, canAccess, async (req, res) => {
  const srv = req.srv;
  if (!srv.container_id) return res.status(400).json({ error: 'Container nicht bereit' });

  const { updates } = req.body; // Array von update-objects aus check-updates
  if (!Array.isArray(updates) || !updates.length)
    return res.status(400).json({ error: 'updates-Array erforderlich' });

  const results = [];
  for (const upd of updates) {
    if (!upd.has_update || !upd.latest?.download_url) continue;
    try {
      const oldPath  = `${upd.dir}/${upd.name}`;
      const destPath = `${upd.dir}/${upd.latest.filename}`;
      await containerExec(srv, `mkdir -p "${upd.dir}"`);
      const dlCmd = `wget -q -O "${destPath}" "${upd.latest.download_url}" 2>&1 && echo "DL_OK" || (curl -fsSL -o "${destPath}" "${upd.latest.download_url}" && echo "DL_OK")`;
      const dlOut = await containerExec(srv, dlCmd, 120_000);
      const ok    = dlOut.includes('DL_OK');

      if (ok && oldPath !== destPath) {
        await containerExec(srv, `rm -f "${oldPath}"`);
      }

      const { v4: uuidv4 } = require('uuid');
      db.prepare(`
        INSERT INTO mod_update_log (id, server_id, mod_name, old_version, new_version, project_id, status)
        VALUES (?,?,?,?,?,?,?)
      `).run(uuidv4(), srv.id, upd.project_title || upd.name,
        upd.installed_version || '?', upd.latest.version_number || '?',
        upd.project_id || null, ok ? 'updated' : 'failed');

      results.push({ name: upd.project_title || upd.name, success: ok, filename: upd.latest.filename });
    } catch (e) {
      results.push({ name: upd.project_title || upd.name, success: false, error: e.message });
    }
  }

  auditLog(req.user.id, 'MOD_UPDATE_ALL', 'server', srv.id,
    { count: results.length, success: results.filter(r=>r.success).length }, req.ip);

  res.json({ results, updated: results.filter(r=>r.success).length, total: results.length });
});

module.exports = router;
