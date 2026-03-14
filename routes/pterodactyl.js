'use strict';
/**
 * routes/pterodactyl.js — Pterodactyl Import Engine
 *
 * Endpunkte:
 *   POST /api/ptero/egg/preview      — Egg-JSON parsen + Preview (kein Speichern)
 *   POST /api/ptero/egg/import       — Einzelnes Egg importieren
 *   POST /api/ptero/egg/bulk         — Mehrere Eggs auf einmal importieren
 *   GET  /api/ptero/egg/diff/:id     — Diff: importiertes Egg vs. bestehendes
 *   POST /api/ptero/server/preview   — Server-Config parsen + Preview
 *   POST /api/ptero/server/import    — Server-Config(s) importieren + Container anlegen
 *   GET  /api/ptero/import/history   — Import-Verlauf abrufen
 *
 * Unterstützte Formate:
 *   Eggs:    PTDL_v1, PTDL_v2, NexPanel Re-Export
 *   Server:  Pterodactyl Panel API Export JSON, NexPanel Server Export
 */

const express       = require('express');
const { v4: uuidv4 }= require('uuid');
const { db, auditLog } = require('../src/core/db');
const { authenticate, requireAdmin } = require('./auth');
const { routeToNode } = require('../src/docker/node-router');

const router = express.Router();

// ─── KATEGORIE-ERKENNUNG ─────────────────────────────────────────────────────
const CATEGORY_RULES = [
  { pattern: /minecraft|mc|bukkit|spigot|paper|forge|fabric|bungeecord|velocity/i, cat: 'minecraft' },
  { pattern: /terraria|valheim|rust|ark|csgo|cs2|tf2|gmod|garrys|left.?4.?dead|l4d|7days|dayz|conan|unturned|squad|palworld|satisfactory|factorio|starbound|stardew/i, cat: 'gameserver' },
  { pattern: /nginx|apache|caddy|traefik|haproxy|lighttpd/i,                        cat: 'webserver' },
  { pattern: /monitor|uptime|grafana|prometheus|loki|influx|zabbix|netdata/i,       cat: 'monitoring' },
  { pattern: /node|python|ruby|php|go|rust|java|deno|bun/i,                         cat: 'generic'    },
  { pattern: /discord|bot|telegram/i,                                                cat: 'generic'    },
];

function detectCategory(name = '', description = '') {
  const text = `${name} ${description}`.toLowerCase();
  for (const { pattern, cat } of CATEGORY_RULES) {
    if (pattern.test(text)) return cat;
  }
  return 'other';
}

// ─── ICON-ERKENNUNG ───────────────────────────────────────────────────────────
const ICON_MAP = {
  minecraft: '⛏️', paper: '📄', forge: '🔥', fabric: '🧵', bungeecord: '🌐',
  velocity: '🚀', spigot: '🔩', bukkit: '🔧',
  valheim: '⚔️', rust: '🦀', ark: '🦕', terraria: '🌿', csgo: '🔫',
  cs2: '🔫', tf2: '🎮', gmod: '🔩', dayz: '☠️', palworld: '🌎',
  satisfactory: '🏭', factorio: '⚙️', starbound: '⭐',
  nodejs: '🟩', node: '🟩', python: '🐍', ruby: '💎', php: '🐘',
  java: '☕', go: '🔵', rust_lang: '🦀', deno: '🦕', bun: '🍞',
  nginx: '🌐', apache: '🪶', caddy: '🔒', traefik: '🔀',
  discord: '💬', bot: '🤖', telegram: '✈️',
  monitor: '📊', grafana: '📈', prometheus: '🔥', uptime: '✅',
};

function detectIcon(name = '') {
  const lower = name.toLowerCase();
  for (const [key, icon] of Object.entries(ICON_MAP)) {
    if (lower.includes(key)) return icon;
  }
  return '🐣';
}

// ─── VARIABLE-VALIDIERUNG-MAPPING (Pterodactyl rules → NexPanel) ─────────────
// Pterodactyl nutzt Laravel-Validation-Strings → wir extrahieren nur die wichtigsten Infos
function parseRules(rulesStr = '') {
  const parts  = rulesStr.split('|');
  const result = { required: parts.includes('required') };
  const numMax = parts.find(p => p.startsWith('max:'));
  const numMin = parts.find(p => p.startsWith('min:'));
  if (numMax) result.max_length = parseInt(numMax.split(':')[1]);
  if (numMin) result.min_length = parseInt(numMin.split(':')[1]);
  if (parts.includes('integer') || parts.includes('numeric')) result.type = 'integer';
  if (parts.includes('boolean')) result.type = 'boolean';
  return result;
}

// ─── HAUPTPARSER: PTDL_v1 + PTDL_v2 → NexPanel Egg ─────────────────────────
function parsePterodactylEgg(raw) {
  // raw kann String oder bereits geparste Object sein
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

  const version = data.meta?.version || 'PTDL_v1';
  const isV2    = version === 'PTDL_v2';

  if (!data.name) throw new Error('Kein Egg-Name gefunden (data.name fehlt)');

  // ── Docker Image ────────────────────────────────────────────────────────────
  // PTDL_v1/v2: docker_images ist ein Objekt { "Label": "image:tag" }
  // Wir nehmen das erste Image (höchste Java-Version kommt in PTDL_v2 zuerst)
  let dockerImage = '';
  const dockerImages = [];

  if (data.docker_images && typeof data.docker_images === 'object') {
    const entries = Object.entries(data.docker_images);
    if (entries.length > 0) {
      // Nimm das erste Bild
      dockerImage  = entries[0][1];
      dockerImages = entries.map(([label, image]) => ({ label, image }));
    }
  } else if (typeof data.docker_image === 'string') {
    // Direktes Feld (einige custom Eggs)
    dockerImage  = data.docker_image;
    dockerImages = [{ label: 'Default', image: dockerImage }];
  }

  if (!dockerImage) throw new Error('Kein Docker-Image im Egg gefunden');

  // ── Startup-Command ─────────────────────────────────────────────────────────
  // Pterodactyl nutzt {{VARIABLE}} — wir konvertieren zu ${VARIABLE} für Lesbarkeit
  const rawStartup     = data.startup || '';
  const startupCommand = rawStartup.replace(/\{\{(\w+)\}\}/g, '${$1}');

  // ── Stop-Command ────────────────────────────────────────────────────────────
  const configStop = data.config?.stop || '';

  // ── ENV Variables ────────────────────────────────────────────────────────────
  // PTDL: variables[].{name, description, env_variable, default_value, user_viewable, user_editable, rules}
  // NexPanel: env_vars[].{key, default, description, required, type, max_length}
  const envVars = (data.variables || []).map(v => {
    const parsed = parseRules(v.rules || '');
    return {
      key:         v.env_variable || v.key || '',
      default:     v.default_value !== undefined ? String(v.default_value) : (v.default || ''),
      description: v.description || v.name || '',
      required:    parsed.required,
      user_editable: v.user_editable !== undefined ? v.user_editable : true,
      user_viewable: v.user_viewable !== undefined ? v.user_viewable : true,
      ...(parsed.type       ? { type: parsed.type }             : {}),
      ...(parsed.max_length ? { max_length: parsed.max_length } : {}),
    };
  }).filter(v => v.key);

  // ── Features ────────────────────────────────────────────────────────────────
  const features = Array.isArray(data.features) ? data.features : [];

  // ── Config-Files ─────────────────────────────────────────────────────────────
  const configFiles = data.config?.files || {};

  // ── Kategorie & Icon ────────────────────────────────────────────────────────
  const category = detectCategory(data.name, data.description || '');
  const icon     = detectIcon(data.name);

  // ── Alle verfügbaren Docker Images als Beschreibungsanhang ─────────────────
  const imagesNote = dockerImages.length > 1
    ? `\n\nVerfügbare Images:\n${dockerImages.map(i => `• ${i.label}: ${i.image}`).join('\n')}`
    : '';

  return {
    name:            data.name,
    description:     (data.description || '') + imagesNote,
    author:          data.author || 'pterodactyl-import',
    docker_image:    dockerImage,
    docker_images:   dockerImages,   // extra, nicht in DB gespeichert
    startup_command: startupCommand,
    config_stop:     configStop,
    env_vars:        envVars,
    features,
    config_files:    configFiles,
    category,
    icon,
    port_range:      '',
    // Metadaten für Preview
    _meta: {
      source_version:   version,
      source_name:      data.name,
      exported_at:      data.exported_at || null,
      update_url:       data.meta?.update_url || null,
      has_install_script: !!(data.scripts?.installation?.script),
      variable_count:   envVars.length,
      image_count:      dockerImages.length,
    },
  };
}

// ─── NexPanel Re-Export Parser ───────────────────────────────────────────────
// Falls jemand einen NexPanel-Egg-Export re-importiert
function parseNexPanelEgg(data) {
  // NexPanel eggs haben dasselbe Schema, wir müssen nur die ID strippen
  const { id: _id, is_builtin: _bi, created_at: _ca, updated_at: _ua, ...rest } = data;
  return {
    ...rest,
    _meta: {
      source_version: 'nexpanel',
      source_name:    data.name,
      variable_count: (data.env_vars || []).length,
      image_count:    1,
    },
  };
}

// ─── FORMAT-ERKENNUNG ────────────────────────────────────────────────────────
function detectAndParse(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;

  // NexPanel Re-Export: hat docker_image direkt + env_vars als Array im richtigen Format
  if (data.docker_image && Array.isArray(data.env_vars) && data.env_vars[0]?.key !== undefined) {
    return parseNexPanelEgg(data);
  }

  // Pterodactyl: hat meta.version = PTDL_v1 oder PTDL_v2
  if (data.meta?.version?.startsWith('PTDL') || data.docker_images || data.variables) {
    return parsePterodactylEgg(data);
  }

  // Fallback: versuche als Pterodactyl zu parsen
  return parsePterodactylEgg(data);
}

// ─── SERVER-MIGRATION PARSER ─────────────────────────────────────────────────
// Unterstützt:
//   1. Pterodactyl Panel API Export: GET /api/application/servers/:id
//   2. NexPanel Server Export (Reverse)
//   3. Eigenes Migrations-Format (generiert vom Export-Button im Panel)
function parsePterodactylServer(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

  // ── Format 1: Pterodactyl Application API (attributes wrapper) ─────────────
  const s = data.attributes || data;

  // Startup
  const rawStartup = s.container?.startup_command
    || s.startup_command
    || '';
  const startup = rawStartup.replace(/\{\{(\w+)\}\}/g, '${$1}');

  // ENV vars: Pterodactyl stellt sie als { VAR: value } oder als environment-Objekt bereit
  let envVars = {};
  const env = s.container?.environment || s.environment || s.env_vars || {};
  if (typeof env === 'object' && !Array.isArray(env)) {
    envVars = { ...env };
    // Entferne interne Pterodactyl-Variablen
    const internal = ['STARTUP', 'SERVER_MEMORY', 'SERVER_IP', 'SERVER_PORT',
                      'P_SERVER_LOCATION', 'P_SERVER_UUID', 'P_SERVER_ALLOCATION_LIMIT'];
    for (const k of internal) delete envVars[k];
  }

  // Ports: Pterodactyl hat allocation (primärer Port) + additional_allocations
  const ports = [];
  const primaryPort = s.allocation?.port || s.default_allocation?.port;
  if (primaryPort) ports.push({ host: primaryPort, container: primaryPort, proto: 'tcp' });
  if (Array.isArray(s.additional_allocations)) {
    for (const a of s.additional_allocations) {
      if (a.port) ports.push({ host: a.port, container: a.port, proto: 'tcp' });
    }
  }

  // Docker Image
  const dockerImage = s.container?.image
    || s.docker_image
    || s.image
    || '';

  // Limits
  const limits   = s.limits   || {};
  const feature  = s.feature_limits || {};

  return {
    name:            s.name || 'Importierter Server',
    description:     s.description || '',
    docker_image:    dockerImage,
    startup_command: startup,
    env_vars:        envVars,
    ports,
    cpu_limit:       typeof limits.cpu  === 'number' ? Math.max(1, limits.cpu / 100) : 1,
    cpu_percent:     typeof limits.cpu  === 'number' ? Math.min(limits.cpu, 100)     : 100,
    memory_limit:    typeof limits.memory === 'number' ? limits.memory                : 512,
    swap_limit:      typeof limits.swap   === 'number' ? limits.swap                  : 0,
    disk_limit:      typeof limits.disk   === 'number' ? limits.disk                  : 5120,
    work_dir:        '/home/container',
    network:         'bridge',
    _meta: {
      source:          'pterodactyl',
      original_uuid:   s.uuid || s.identifier || null,
      original_id:     s.id   || null,
      egg_id:          s.egg  || null,
      node_name:       s.node || null,
    },
  };
}

// ─── HILFSFUNKTIONEN ─────────────────────────────────────────────────────────
function findDuplicateEgg(name, dockerImage) {
  return db.prepare(
    'SELECT id, name, docker_image FROM eggs WHERE name=? OR docker_image=? LIMIT 1'
  ).get(name, dockerImage);
}

function saveEggToDb(eggData, userId, ip) {
  const id = uuidv4();
  const {
    name, description = '', author = 'pterodactyl-import',
    docker_image, startup_command = '', config_stop = '',
    env_vars = [], features = [], config_files = {},
    category = 'other', icon = '🐣', port_range = '',
  } = eggData;

  db.prepare(`
    INSERT INTO eggs
      (id, name, description, author, docker_image, startup_command, config_stop,
       env_vars, features, config_files, category, icon, port_range)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, description, author, docker_image, startup_command, config_stop,
    JSON.stringify(env_vars),
    JSON.stringify(features),
    JSON.stringify(typeof config_files === 'string' ? JSON.parse(config_files) : config_files),
    category, icon, port_range
  );

  auditLog(userId, 'PTERO_EGG_IMPORT', 'egg', id, { name, docker_image }, ip);
  return db.prepare('SELECT * FROM eggs WHERE id=?').get(id);
}

// Import-History in settings-Tabelle speichern (leichtgewichtig)
function appendImportHistory(entry) {
  try {
    const existing = db.prepare("SELECT value FROM settings WHERE key='ptero_import_history'").get();
    const history  = existing ? JSON.parse(existing.value) : [];
    history.unshift({ ...entry, at: new Date().toISOString() });
    const trimmed  = history.slice(0, 100); // max 100 Einträge
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ptero_import_history', ?)")
      .run(JSON.stringify(trimmed));
  } catch (_) { /* non-fatal */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTEN
// ══════════════════════════════════════════════════════════════════════════════

// ─── EGG PREVIEW (kein DB-Zugriff) ───────────────────────────────────────────
router.post('/egg/preview', authenticate, requireAdmin, (req, res) => {
  try {
    const { json } = req.body;
    if (!json) return res.status(400).json({ error: 'json Feld erforderlich' });

    const parsed    = detectAndParse(json);
    const duplicate = findDuplicateEgg(parsed.name, parsed.docker_image);

    res.json({
      egg:        parsed,
      duplicate:  duplicate || null,
      warnings:   buildWarnings(parsed),
    });
  } catch (e) {
    res.status(400).json({ error: `Parse-Fehler: ${e.message}` });
  }
});

// ─── EINZELNES EGG IMPORTIEREN ────────────────────────────────────────────────
router.post('/egg/import', authenticate, requireAdmin, (req, res) => {
  try {
    const { json, overwrite = false } = req.body;
    if (!json) return res.status(400).json({ error: 'json Feld erforderlich' });

    const parsed    = detectAndParse(json);
    const duplicate = findDuplicateEgg(parsed.name, parsed.docker_image);

    if (duplicate && !overwrite) {
      return res.status(409).json({
        error:     'Doppeltes Egg gefunden',
        duplicate,
        hint:      'Sende overwrite:true um das bestehende Egg zu überschreiben',
      });
    }

    // Überschreiben: altes löschen (sofern nicht built-in)
    if (duplicate && overwrite) {
      const existing = db.prepare('SELECT is_builtin FROM eggs WHERE id=?').get(duplicate.id);
      if (existing?.is_builtin) {
        return res.status(400).json({ error: 'Built-in Eggs können nicht überschrieben werden' });
      }
      db.prepare('DELETE FROM eggs WHERE id=?').run(duplicate.id);
    }

    const created = saveEggToDb(parsed, req.user.id, req.ip);
    appendImportHistory({
      type: 'egg', name: parsed.name, id: created.id,
      source_version: parsed._meta?.source_version,
      overwritten: !!(duplicate && overwrite),
    });

    res.status(201).json({
      egg:      { ...created, env_vars: JSON.parse(created.env_vars), features: JSON.parse(created.features) },
      warnings: buildWarnings(parsed),
      meta:     parsed._meta,
    });
  } catch (e) {
    res.status(400).json({ error: `Import-Fehler: ${e.message}` });
  }
});

// ─── BULK IMPORT (mehrere Eggs auf einmal) ────────────────────────────────────
// Akzeptiert: Array von Egg-JSONs oder { eggs: [...] }
router.post('/egg/bulk', authenticate, requireAdmin, (req, res) => {
  try {
    const { eggs: rawList, overwrite = false } = req.body;
    if (!Array.isArray(rawList) || rawList.length === 0) {
      return res.status(400).json({ error: 'eggs Array erforderlich (min. 1 Eintrag)' });
    }
    if (rawList.length > 50) {
      return res.status(400).json({ error: 'Maximal 50 Eggs pro Bulk-Import' });
    }

    const results = [];
    const importTx = db.transaction(() => {
      for (const raw of rawList) {
        try {
          const parsed    = detectAndParse(raw);
          const duplicate = findDuplicateEgg(parsed.name, parsed.docker_image);

          if (duplicate && !overwrite) {
            results.push({ name: parsed.name, status: 'skipped', reason: 'duplicate', duplicate_id: duplicate.id });
            continue;
          }
          if (duplicate && overwrite) {
            const existing = db.prepare('SELECT is_builtin FROM eggs WHERE id=?').get(duplicate.id);
            if (existing?.is_builtin) {
              results.push({ name: parsed.name, status: 'skipped', reason: 'builtin_protected' });
              continue;
            }
            db.prepare('DELETE FROM eggs WHERE id=?').run(duplicate.id);
          }

          const created = saveEggToDb(parsed, req.user.id, req.ip);
          results.push({
            name: parsed.name, status: 'imported', id: created.id,
            warnings: buildWarnings(parsed),
            meta:     parsed._meta,
          });
        } catch (e) {
          results.push({ name: String(raw?.name || '?'), status: 'error', reason: e.message });
        }
      }
    });

    importTx();

    const imported = results.filter(r => r.status === 'imported').length;
    const skipped  = results.filter(r => r.status === 'skipped').length;
    const errors   = results.filter(r => r.status === 'error').length;

    appendImportHistory({
      type: 'bulk_egg', imported, skipped, errors, total: rawList.length,
    });

    res.json({ imported, skipped, errors, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── EGG DIFF (Vergleich mit bestehendem Egg) ─────────────────────────────────
router.get('/egg/diff/:id', authenticate, requireAdmin, (req, res) => {
  const egg = db.prepare('SELECT * FROM eggs WHERE id=?').get(req.params.id);
  if (!egg) return res.status(404).json({ error: 'Egg nicht gefunden' });

  const { json } = req.query;
  if (!json) return res.status(400).json({ error: 'json Query-Parameter erforderlich' });

  try {
    const incoming = detectAndParse(decodeURIComponent(json));
    const existing = {
      ...egg,
      env_vars:    JSON.parse(egg.env_vars    || '[]'),
      features:    JSON.parse(egg.features    || '[]'),
      config_files: JSON.parse(egg.config_files || '{}'),
    };

    const fields  = ['name','docker_image','startup_command','config_stop','category','icon'];
    const changes = [];

    for (const f of fields) {
      if (String(incoming[f] || '') !== String(existing[f] || '')) {
        changes.push({ field: f, old: existing[f], new: incoming[f] });
      }
    }

    // ENV vars diff
    const inKeys  = new Set(incoming.env_vars.map(v => v.key));
    const exKeys  = new Set(existing.env_vars.map(v => v.key));
    const added   = [...inKeys].filter(k => !exKeys.has(k));
    const removed = [...exKeys].filter(k => !inKeys.has(k));
    const changed = [...inKeys].filter(k => {
      if (!exKeys.has(k)) return false;
      const a = incoming.env_vars.find(v => v.key === k);
      const b = existing.env_vars.find(v => v.key === k);
      return a.default !== b.default || a.required !== b.required;
    });

    res.json({ existing, incoming, changes, env_diff: { added, removed, changed } });
  } catch (e) {
    res.status(400).json({ error: `Parse-Fehler: ${e.message}` });
  }
});

// ─── SERVER PREVIEW ───────────────────────────────────────────────────────────
router.post('/server/preview', authenticate, requireAdmin, (req, res) => {
  try {
    const { json } = req.body;
    if (!json) return res.status(400).json({ error: 'json Feld erforderlich' });

    // Kann Array (mehrere Server) oder einzelnes Objekt sein
    const data     = typeof json === 'string' ? JSON.parse(json) : json;
    const isBulk   = Array.isArray(data) || Array.isArray(data.data);
    const rawList  = isBulk ? (data.data || data) : [data];
    const servers  = rawList.map(parsePterodactylServer);

    const nodes    = db.prepare('SELECT id, name, fqdn FROM nodes').all();

    res.json({
      servers,
      is_bulk: isBulk,
      count:   servers.length,
      nodes,
      warnings: servers.flatMap((s, i) => buildServerWarnings(s).map(w => ({ server: i, ...w }))),
    });
  } catch (e) {
    res.status(400).json({ error: `Parse-Fehler: ${e.message}` });
  }
});

// ─── SERVER IMPORT ────────────────────────────────────────────────────────────
router.post('/server/import', authenticate, requireAdmin, async (req, res) => {
  try {
    const { json, node_id, user_id: targetUserId } = req.body;
    if (!json) return res.status(400).json({ error: 'json Feld erforderlich' });

    const data    = typeof json === 'string' ? JSON.parse(json) : json;
    const isBulk  = Array.isArray(data) || Array.isArray(data.data);
    const rawList = isBulk ? (data.data || data) : [data];

    if (rawList.length > 20) {
      return res.status(400).json({ error: 'Maximal 20 Server pro Import' });
    }

    // Node bestimmen
    let resolvedNodeId = node_id;
    if (!resolvedNodeId) {
      const defaultNode = db.prepare('SELECT id FROM nodes WHERE is_default=1').get()
        || db.prepare('SELECT id FROM nodes ORDER BY created_at ASC').get();
      if (!defaultNode) return res.status(400).json({ error: 'Kein Node verfügbar. Bitte zuerst einen Node einrichten.' });
      resolvedNodeId = defaultNode.id;
    }
    const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(resolvedNodeId);
    if (!node) return res.status(404).json({ error: 'Node nicht gefunden' });

    const userId = targetUserId || req.user.id;
    const results = [];

    for (const raw of rawList) {
      try {
        const parsed = parsePterodactylServer(raw);

        if (!parsed.docker_image) {
          results.push({ name: parsed.name, status: 'error', reason: 'Kein Docker-Image angegeben' });
          continue;
        }

        const serverId = uuidv4();

        db.prepare(`
          INSERT INTO servers
            (id, name, description, user_id, node_id, node, image,
             cpu_limit, cpu_percent, memory_limit, swap_limit, disk_limit,
             ports, env_vars, startup_command, work_dir, network, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing')
        `).run(
          serverId, parsed.name, parsed.description, userId,
          resolvedNodeId, node.name, parsed.docker_image,
          parsed.cpu_limit, parsed.cpu_percent,
          parsed.memory_limit, parsed.swap_limit, parsed.disk_limit,
          JSON.stringify(parsed.ports || []),
          JSON.stringify(parsed.env_vars || {}),
          parsed.startup_command, parsed.work_dir, parsed.network
        );

        // Container asynchron erstellen
        (async () => {
          try {
            const result = await routeToNode(resolvedNodeId, {
              type: 'server.create', server_id: serverId,
              config: {
                image:           parsed.docker_image,
                cpu_limit:       parsed.cpu_limit,
                cpu_percent:     parsed.cpu_percent,
                memory_limit:    parsed.memory_limit,
                swap_limit:      parsed.swap_limit,
                disk_limit:      parsed.disk_limit,
                ports:           parsed.ports || [],
                env_vars:        parsed.env_vars || {},
                startup_command: parsed.startup_command,
                work_dir:        parsed.work_dir,
                network:         parsed.network,
              },
            }, 120_000);

            const status = (result.success && result.container_id) ? 'offline' : 'error';
            db.prepare("UPDATE servers SET container_id=?, status=?, updated_at=datetime('now') WHERE id=?")
              .run(result.container_id || null, status, serverId);
          } catch (_) {
            db.prepare("UPDATE servers SET status='error', updated_at=datetime('now') WHERE id=?")
              .run(serverId);
          }
        })();

        auditLog(req.user.id, 'PTERO_SERVER_IMPORT', 'server', serverId,
          { name: parsed.name, image: parsed.docker_image, original_uuid: parsed._meta?.original_uuid },
          req.ip);

        results.push({
          name: parsed.name, status: 'importing', server_id: serverId,
          warnings: buildServerWarnings(parsed),
        });

      } catch (e) {
        results.push({ name: String(raw?.name || '?'), status: 'error', reason: e.message });
      }
    }

    const imported = results.filter(r => r.status === 'importing').length;
    appendImportHistory({ type: 'server', imported, total: rawList.length });

    res.json({
      imported, errors: results.filter(r => r.status === 'error').length,
      results,
      note: 'Container werden im Hintergrund erstellt. Status unter Server-Detail einsehbar.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── IMPORT HISTORY ────────────────────────────────────────────────────────────
router.get('/import/history', authenticate, requireAdmin, (req, res) => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='ptero_import_history'").get();
    res.json(row ? JSON.parse(row.value) : []);
  } catch (_) { res.json([]); }
});

// ─── EXPORT: NEXPANEL EGG → PTERODACTYL-KOMPATIBLES JSON ─────────────────────
// Erzeugt ein minimales PTDL_v1-kompatibles JSON für das Egg
router.get('/egg/export/:id', authenticate, requireAdmin, (req, res) => {
  const egg = db.prepare('SELECT * FROM eggs WHERE id=?').get(req.params.id);
  if (!egg) return res.status(404).json({ error: 'Egg nicht gefunden' });

  const envVars = JSON.parse(egg.env_vars || '[]');

  const ptdlExport = {
    _comment:    'Exported by NexPanel — compatible with PTDL_v1',
    meta:        { version: 'PTDL_v1', update_url: null },
    exported_at: new Date().toISOString(),
    name:        egg.name,
    author:      egg.author || 'nexpanel',
    description: egg.description || '',
    features:    JSON.parse(egg.features || '[]'),
    docker_images: { Default: egg.docker_image },
    startup:     (egg.startup_command || '').replace(/\$\{(\w+)\}/g, '{{$1}}'),
    config: {
      files:   {},
      startup: { done: 'Done', userInteraction: [] },
      stop:    egg.config_stop || 'stop',
      logs:    [],
    },
    scripts:   { installation: { script: '#!/bin/ash\necho "Installed by NexPanel"', container: 'alpine:3', entrypoint: 'ash' } },
    variables: envVars.map(v => ({
      name:          v.description || v.key,
      description:   v.description || '',
      env_variable:  v.key,
      default_value: v.default || '',
      user_viewable: v.user_viewable !== false,
      user_editable: v.user_editable !== false,
      rules:         [v.required ? 'required' : 'nullable', v.type === 'integer' ? 'integer' : 'string'].join('|'),
    })),
  };

  res.setHeader('Content-Disposition', `attachment; filename="nexpanel-egg-${egg.name.replace(/\s+/g,'-').toLowerCase()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(ptdlExport);
});

// ─── WARNUNGS-BUILDER ─────────────────────────────────────────────────────────
function buildWarnings(egg) {
  const w = [];
  if (!egg.startup_command) {
    w.push({ level: 'info', msg: 'Kein Startup-Command — Container-Image steuert den Start' });
  }
  if ((egg.env_vars || []).some(v => v.required && !v.default)) {
    w.push({ level: 'warn', msg: 'Pflicht-Variablen ohne Standardwert — müssen beim Server-Erstellen ausgefüllt werden' });
  }
  if ((egg.docker_images?.length || 0) > 1) {
    w.push({ level: 'info', msg: `${egg.docker_images.length} Docker Images verfügbar — erstes wurde als Standard übernommen` });
  }
  if (egg._meta?.has_install_script) {
    w.push({ level: 'info', msg: 'Egg enthält Installations-Script — wird in NexPanel nicht ausgeführt (Container-Image übernimmt Setup)' });
  }
  if ((egg.startup_command || '').includes('${')) {
    w.push({ level: 'info', msg: 'Startup-Command enthält Variable-Referenzen (${VAR}) — werden zur Laufzeit durch ENV-Werte ersetzt' });
  }
  return w;
}

function buildServerWarnings(srv) {
  const w = [];
  if (!srv.docker_image) w.push({ level: 'error', msg: 'Kein Docker-Image angegeben' });
  if ((srv.ports || []).length === 0) w.push({ level: 'warn', msg: 'Keine Ports konfiguriert' });
  if (srv.memory_limit < 128) w.push({ level: 'warn', msg: 'Sehr niedriges RAM-Limit (<128 MB)' });
  if (srv.cpu_limit > 8)  w.push({ level: 'warn', msg: 'Sehr hohes CPU-Limit — prüfe ob der Node ausreichend Kapazität hat' });
  return w;
}

module.exports = router;
