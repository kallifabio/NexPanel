/**
 * node-router.js — Routing von Server-Operationen
 * Entscheidet automatisch ob ein Befehl per Daemon (v2, remote Node)
 * oder direkt per lokalem Docker-Client (v1, lokaler Node) ausgeführt wird.
 */

'use strict';

const daemonHub  = require('./daemon-hub');
const dockerLocal= require('./docker-local');
const { db }     = require('../core/db');

/**
 * Führt eine Operation auf dem richtigen Node aus:
 * 1. Daemon-Verbindung vorhanden → per WS an Daemon senden
 * 2. Lokaler Node (is_local=1) + lokales Docker → direkt ansprechen
 * 3. Sonst → Fehler: Node offline
 */
async function routeToNode(nodeId, msg, timeout = 30_000) {
  if (daemonHub.isConnected(nodeId)) {
    return daemonHub.daemonRequest(nodeId, msg, timeout);
  }

  // Lokales Docker-Fallback
  const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(nodeId);
  if (node?.is_local && dockerLocal.isAvailable()) {
    return localFallback(msg);
  }

  throw new Error(`Node ist offline. Bitte starte den Daemon auf dem Node-Server.`);
}

/**
 * Führt eine Daemon-Nachricht lokal über Docker aus.
 * Übersetzt das Daemon-Protokoll in lokale Docker-Operationen.
 */
async function localFallback(msg) {
  const { type, server_id, container_id, config, action, command, lines } = msg;

  switch (type) {
    case 'server.create': {
      return dockerLocal.createContainer(server_id, config);
    }

    case 'server.delete': {
      return dockerLocal.removeContainer(container_id);
    }

    case 'server.start':
    case 'server.stop':
    case 'server.restart':
    case 'server.kill': {
      const act = type.split('.')[1];
      return dockerLocal.powerAction(container_id, act);
    }

    case 'server.command': {
      const output = await dockerLocal.execCommand(container_id, command);
      return { success: true, output };
    }

    case 'server.logs.tail': {
      const logs = await dockerLocal.getLogs(container_id, lines || 200);
      return { success: true, logs };
    }

    case 'server.stats.start':
    case 'server.stats.stop':
      // Stats werden über WS-Handler direkt gehandhabt
      return { success: true };

    case 'docker.images': {
      const images = await dockerLocal.listImages();
      return { success: true, images: images.map(img => ({
        id:   (img.Id || '').substring(7, 19),
        tags: img.RepoTags || ['<none>'],
        size: img.Size,
        created: img.Created,
      }))};
    }

    case 'docker.pull': {
      return dockerLocal.pullImage(msg.image);
    }

    case 'node.info': {
      const info = await dockerLocal.getDockerInfo();
      return { success: true, system: info };
    }

    // ── FILE MANAGER ─────────────────────────────────────────────────────────
    case 'files.list': {
      return dockerLocal.filesList(container_id, msg.path || '/home/container');
    }
    case 'files.read': {
      return dockerLocal.filesRead(container_id, msg.path);
    }
    case 'files.write': {
      return dockerLocal.filesWrite(container_id, msg.path, msg.content || '');
    }
    case 'files.create': {
      return dockerLocal.filesCreate(container_id, msg.path, msg.file_type || 'file');
    }
    case 'files.delete': {
      return dockerLocal.filesDelete(container_id, msg.path);
    }
    case 'files.rename': {
      return dockerLocal.filesRename(container_id, msg.from, msg.to);
    }
    case 'files.compress': {
      return dockerLocal.filesCompress(container_id, msg.paths, msg.destination);
    }

    // ── DISK USAGE ───────────────────────────────────────────────────────────
    case 'disk.usage': {
      return dockerLocal.diskUsage(container_id, msg.work_dir || '/home/container');
    }

    // ── BACKUPS ───────────────────────────────────────────────────────────────
    case 'backup.create': {
      return dockerLocal.createBackup(container_id, msg.work_dir || '/home/container', msg.file_path);
    }
    case 'backup.restore': {
      return dockerLocal.restoreBackup(container_id, msg.work_dir || '/home/container', msg.file_path);
    }

    default:
      throw new Error(`Unbekannte Daemon-Operation: ${type}`);
  }
}

module.exports = { routeToNode };


// ─── FILE MANAGER OPERATIONEN ─────────────────────────────────────────────────
// Diese werden in localFallback bereits über den switch abgedeckt:
// files.list, files.read, files.write, files.create, files.delete, files.rename
// Wir erweitern den localFallback in docker-local.js direkt über exec-Befehle.
