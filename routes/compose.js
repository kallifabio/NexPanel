'use strict';
/**
 * routes/compose.js — Docker Compose Import & Server Reinstall
 *
 * Docker Compose:
 *   POST /api/compose/import   — YAML parsen + Server erstellen
 *   GET  /api/compose/:id      — Import-Status
 *
 * Server Reinstall:
 *   POST /api/servers/:id/reinstall  — Container neu aufsetzen (optional: neues Image)
 */

const express   = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../db');
const { authenticate } = require('./auth');
const { routeToNode }  = require('../node-router');

const router = express.Router();

// ─── YAML PARSER (kein externer Dep) ─────────────────────────────────────────
function parseCompose(yaml) {
  const services = {};
  let currentService = null;
  let inPorts = false, inEnv = false, inVolumes = false;

  const lines = yaml.split('\n');
  for (const raw of lines) {
    const line    = raw.replace(/\r/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { inPorts = inEnv = inVolumes = false; continue; }

    // services:
    if (/^services\s*:/.test(trimmed)) { currentService = null; continue; }

    // service name (2 spaces indent)
    const serviceMatch = line.match(/^  ([a-zA-Z0-9_-]+)\s*:/);
    if (serviceMatch && !line.startsWith('    ')) {
      currentService = serviceMatch[1];
      services[currentService] = { image: '', ports: [], environment: {}, volumes: [], command: '' };
      inPorts = inEnv = inVolumes = false;
      continue;
    }

    if (!currentService) continue;
    const svc = services[currentService];

    if (/^\s+image\s*:/.test(line))   { svc.image = trimmed.replace(/^image\s*:\s*/, '').replace(/['"]/g,''); continue; }
    if (/^\s+command\s*:/.test(line)) { svc.command = trimmed.replace(/^command\s*:\s*/, ''); continue; }
    if (/^\s+ports\s*:/.test(line))   { inPorts = true; inEnv = inVolumes = false; continue; }
    if (/^\s+environment\s*:/.test(line)) { inEnv = true; inPorts = inVolumes = false; continue; }
    if (/^\s+volumes\s*:/.test(line)) { inVolumes = true; inPorts = inEnv = false; continue; }
    // Reset on any unindented-enough key
    if (/^\s{4}[a-zA-Z]/.test(line) && !/^\s{6}/.test(line)) { inPorts = inEnv = inVolumes = false; }

    if (inPorts && trimmed.startsWith('- ')) {
      const p = trimmed.slice(2).replace(/['"]/g,'').trim();
      const [host, container] = p.split(':');
      if (host && container) svc.ports.push({ host: parseInt(host), container: parseInt(container) });
    }
    if (inEnv && trimmed.startsWith('- ')) {
      const kv = trimmed.slice(2);
      const eq = kv.indexOf('='); if (eq>0) svc.environment[kv.slice(0,eq)] = kv.slice(eq+1);
    }
    if (inEnv && trimmed.includes(': ')) {
      const eq = trimmed.indexOf(': '); svc.environment[trimmed.slice(0,eq)] = trimmed.slice(eq+2);
    }
    if (inVolumes && trimmed.startsWith('- ')) {
      svc.volumes.push(trimmed.slice(2).replace(/['"]/g,'').trim());
    }
  }
  return services;
}

// ─── COMPOSE IMPORT ───────────────────────────────────────────────────────────
router.post('/import', authenticate, async (req, res) => {
  const { yaml, name_prefix = '' } = req.body;
  if (!yaml?.trim()) return res.status(400).json({ error: 'compose YAML erforderlich' });

  let services;
  try { services = parseCompose(yaml); } catch (e) {
    return res.status(400).json({ error: 'YAML Parsing-Fehler: ' + e.message });
  }

  const serviceNames = Object.keys(services);
  if (!serviceNames.length) return res.status(400).json({ error: 'Keine Services gefunden' });
  if (serviceNames.length > 20) return res.status(400).json({ error: 'Maximal 20 Services' });

  const importId = uuidv4();
  const results  = [];

  // Für jeden Service einen Server erstellen
  for (const [svcName, svc] of Object.entries(services)) {
    if (!svc.image) { results.push({ name: svcName, success: false, error: 'Kein Image angegeben' }); continue; }

    const serverId   = uuidv4();
    const serverName = (name_prefix ? name_prefix + '-' : '') + svcName;

    try {
      // Erst Container erstellen (lokal)
      const createResult = await routeToNode(null, {
        type: 'server.create', server_id: serverId,
        config: {
          image: svc.image, cpu_limit: 1, cpu_percent: 100,
          memory_limit: 512, swap_limit: 0,
          ports: svc.ports, env_vars: svc.environment,
          startup_command: svc.command || '',
          work_dir: '/home/container', network: 'bridge',
        },
      }, 60_000);

      db.prepare(`
        INSERT INTO servers (id,name,description,user_id,node_id,container_id,image,cpu_limit,cpu_percent,memory_limit,swap_limit,disk_limit,ports,env_vars,startup_command,work_dir,network,status,node,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
      `).run(serverId, serverName, `Importiert via Docker Compose`, req.user.id,
        null, createResult.container_id, svc.image, 1, 100, 512, 0, 5120,
        JSON.stringify(svc.ports), JSON.stringify(svc.environment),
        svc.command || '', '/home/container', 'bridge',
        createResult.status || 'offline', 'local');

      auditLog(req.user.id, 'SERVER_CREATE_COMPOSE', 'server', serverId, { image: svc.image, import_id: importId }, req.ip);
      results.push({ name: serverName, success: true, server_id: serverId, image: svc.image });
    } catch (e) {
      results.push({ name: serverName, success: false, error: e.message, image: svc.image });
    }
  }

  const ok  = results.filter(r => r.success).length;
  const err = results.filter(r => !r.success).length;
  res.json({ import_id: importId, results, summary: { ok, err, total: results.length } });
});

// ─── COMPOSE PREVIEW (parsen ohne erstellen) ──────────────────────────────────
router.post('/preview', authenticate, (req, res) => {
  const { yaml } = req.body;
  if (!yaml?.trim()) return res.status(400).json({ error: 'YAML erforderlich' });
  try {
    const services = parseCompose(yaml);
    res.json({ services, count: Object.keys(services).length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── SERVER REINSTALL ─────────────────────────────────────────────────────────
router.post('/servers/:serverId/reinstall', authenticate, async (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (srv.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Kein Zugriff' });

  const newImage   = req.body.image || srv.image;
  const keepData   = req.body.keep_data !== false; // default: Daten behalten
  const newEnvVars = req.body.env_vars ? JSON.parse(req.body.env_vars) : JSON.parse(srv.env_vars || '{}');
  const newStartup = req.body.startup_command || srv.startup_command;

  try {
    // 1. Server stoppen
    if (srv.container_id && srv.status === 'running') {
      await routeToNode(srv.node_id, { type: 'server.stop', server_id: srv.id, container_id: srv.container_id }, 30_000).catch(() => {});
    }

    // 2. Backup falls keep_data
    let backupPath = null;
    if (keepData && srv.container_id) {
      const path    = require('path');
      const fs      = require('fs');
      const BPATH   = process.env.BACKUP_PATH || path.join(__dirname, '..', 'backups');
      backupPath    = path.join(BPATH, srv.id, `reinstall_${Date.now()}.tar.gz`);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      await routeToNode(srv.node_id, {
        type: 'backup.create', server_id: srv.id, container_id: srv.container_id,
        file_path: backupPath, work_dir: srv.work_dir || '/home/container',
      }, 300_000).catch(e => { backupPath = null; console.warn('[reinstall] Backup fehlgeschlagen:', e.message); });
    }

    // 3. Alten Container löschen
    if (srv.container_id) {
      await routeToNode(srv.node_id, { type: 'server.delete', container_id: srv.container_id }, 30_000).catch(() => {});
    }

    // 4. Neuen Container erstellen
    db.prepare("UPDATE servers SET status='installing',updated_at=datetime('now') WHERE id=?").run(srv.id);
    const createResult = await routeToNode(srv.node_id, {
      type: 'server.create', server_id: srv.id,
      config: {
        image: newImage, cpu_limit: srv.cpu_limit, cpu_percent: srv.cpu_percent || 100,
        memory_limit: srv.memory_limit, swap_limit: srv.swap_limit || 0,
        ports: JSON.parse(srv.ports || '[]'), env_vars: newEnvVars,
        startup_command: newStartup, work_dir: srv.work_dir || '/home/container',
        network: srv.network || 'bridge',
      },
    }, 120_000);

    // 5. Daten wiederherstellen
    if (backupPath) {
      const fs = require('fs');
      if (fs.existsSync(backupPath)) {
        await routeToNode(srv.node_id, {
          type: 'backup.restore', server_id: srv.id, container_id: createResult.container_id,
          file_path: backupPath, work_dir: srv.work_dir || '/home/container',
        }, 300_000).catch(e => console.warn('[reinstall] Restore fehlgeschlagen:', e.message));
        fs.unlink(backupPath, () => {});
      }
    }

    // 6. DB aktualisieren
    db.prepare(`UPDATE servers SET container_id=?,image=?,env_vars=?,startup_command=?,status='offline',updated_at=datetime('now') WHERE id=?`)
      .run(createResult.container_id, newImage, JSON.stringify(newEnvVars), newStartup, srv.id);

    auditLog(req.user.id, 'SERVER_REINSTALL', 'server', srv.id, {
      old_image: srv.image, new_image: newImage, keep_data: keepData,
    }, req.ip);

    res.json({ success: true, container_id: createResult.container_id, keep_data: keepData, new_image: newImage });
  } catch (e) {
    db.prepare("UPDATE servers SET status='error',updated_at=datetime('now') WHERE id=?").run(srv.id);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
