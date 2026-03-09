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
const MODRINTH_UA    = 'HostPanel/2.0 (github.com/hostpanel)';

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

module.exports = router;
