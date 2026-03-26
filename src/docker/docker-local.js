'use strict';
/**
 * docker-local.js — Lokales Docker-Integration (v1 Fallback)
 * Wird verwendet wenn der Node als is_local=1 konfiguriert ist.
 * Kein Daemon benötigt — spricht direkt mit dem Docker-Socket.
 */

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

let Docker;
try { Docker = require('dockerode'); } catch { Docker = null; }

let docker = null;
let _dockerAvailable = false;

if (Docker) {
  try {
    docker = new Docker({ socketPath: DOCKER_SOCKET });
    _dockerAvailable = true;
  } catch (e) {
    console.warn('[docker-local] Socket-Verbindung fehlgeschlagen:', e.message);
  }
}

function isAvailable() { return _dockerAvailable && docker !== null; }

// ─── Verbindung beim ersten Aufruf verifizieren ───────────────────────────────
let _verified = false;
async function verifyConnection() {
  if (_verified || !docker) return _dockerAvailable;
  try {
    await docker.ping();
    _dockerAvailable = true;
    _verified = true;
    console.log('[docker-local] Docker verfügbar auf', DOCKER_SOCKET);
  } catch (e) {
    _dockerAvailable = false;
    _verified = false; // retry on next call
    console.warn('[docker-local] Docker nicht erreichbar:', e.message.split('\n')[0]);
  }
  return _dockerAvailable;
}

// Beim Start einmal prüfen (non-blocking)
setTimeout(() => verifyConnection().catch(() => {}), 2000);

// ─── STATS ────────────────────────────────────────────────────────────────────
async function getStats(containerId, memLimitMb) {
  if (!docker || !containerId || !_dockerAvailable) return null;
  if (!_verified) await verifyConnection().catch(() => {});
  if (!_dockerAvailable) return null;
  try {
    const container = docker.getContainer(containerId);
    const raw = await new Promise((resolve, reject) =>
      container.stats({ stream: false }, (err, d) => err ? reject(err) : resolve(d))
    );
    const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
    const sysDelta = raw.cpu_stats.system_cpu_usage - raw.precpu_stats.system_cpu_usage;
    const cpuCount = raw.cpu_stats.online_cpus || raw.cpu_stats.cpu_usage.percpu_usage?.length || 1;
    const cpu      = sysDelta > 0 ? (cpuDelta / sysDelta) * cpuCount * 100 : 0;
    const nets     = raw.networks || {};
    return {
      cpu:          Math.round(cpu * 100) / 100,
      memory:       raw.memory_stats.usage || 0,
      memory_limit: raw.memory_stats.limit || (memLimitMb || 512) * 1024 * 1024,
      network_rx:   Object.values(nets).reduce((a, n) => a + n.rx_bytes, 0),
      network_tx:   Object.values(nets).reduce((a, n) => a + n.tx_bytes, 0),
      pids:         raw.pids_stats?.current || 0,
      status:       'running',
    };
  } catch { return null; }
}

// ─── CREATE ───────────────────────────────────────────────────────────────────
async function createContainer(serverId, cfg) {
  if (!docker) throw new Error('Lokales Docker nicht verfügbar');
  const {
    image, cpu_limit = 1, cpu_percent = 100, memory_limit = 512, swap_limit = 0,
    ports = [], env_vars = {}, startup_command, work_dir: _work_dir = '/home/container', network = 'bridge',
  } = cfg;
  // itzg/minecraft-server speichert alles in /data, nicht /home/container
  const work_dir = _work_dir !== '/home/container' ? _work_dir
    : (image.includes('itzg') ? '/data' : '/home/container');

  // Image lokal vorhanden? Falls nicht: automatisch pullen
  const images = await docker.listImages({ filters: { reference: [image] } }).catch(() => []);
  if (!images.length) {
    console.log(`📦 Image "${image}" nicht gefunden — wird gepullt...`);
    try {
      const stream = await docker.pull(image);
      await new Promise((resolve, reject) =>
        docker.modem.followProgress(stream,
          (err) => err ? reject(err) : resolve(),
          (evt) => evt.status && process.stdout.write(`  ${evt.status}${evt.progress ? ' '+evt.progress : ''}\r`)
        )
      );
      console.log(`\n✅ Image "${image}" gepullt`);
    } catch (pullErr) {
      throw new Error(`Image "${image}" konnte nicht gepullt werden: ${pullErr.message}`);
    }
  }

  const portBindings = {};
  const exposedPorts = {};
  ports.forEach(p => {
    const [host, cont] = typeof p === 'object' ? [p.host, p.container] : [p, p];
    exposedPorts[`${cont}/tcp`] = {};
    portBindings[`${cont}/tcp`]  = [{ HostPort: String(host) }];
  });

  // itzg/minecraft-server und ähnliche Images steuern sich komplett über ENV-Vars.
  // Kein Cmd setzen — sonst werden die Args falsch an den Java-Prozess weitergegeben.
  const isEnvDrivenImage = image.includes('itzg/') || image.includes('minecraft-server');
  const cmdArgs = (!isEnvDrivenImage && startup_command)
    ? startup_command.trim().split(/\s+/)
    : undefined;

  // cpu_limit = Kerne, cpu_percent = % Auslastung dieser Kerne (Standard 100%)
  const cpuCores   = parseFloat(cpu_limit) || 1;
  const cpuPercent = parseFloat(cpu_percent) || 100;
  const nanoCpus   = Math.floor(cpuCores * (cpuPercent / 100) * 1e9);

  const container = await docker.createContainer({
    Image:        image,
    name:         `nexpanel_${serverId.substring(0, 8)}`,
    Env:          Object.entries(env_vars).map(([k, v]) => `${k}=${v}`),
    WorkingDir:   work_dir,
    ExposedPorts: exposedPorts,
    Cmd:          cmdArgs,
    HostConfig: {
      Memory:        memory_limit * 1024 * 1024,
      MemorySwap:    swap_limit > 0 ? (memory_limit + swap_limit) * 1024 * 1024 : -1,
      NanoCpus:      nanoCpus,
      PortBindings:  portBindings,
      NetworkMode:   network,
      // on-failure statt unless-stopped: stoppt nach 3 Abstürzen statt endlos zu loopen
      RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
      PidsLimit:     256,
    },
    Labels: { 'nexpanel.managed': 'true', 'nexpanel.server_id': serverId },
  });
  return { success: true, container_id: container.id };
}

// ─── POWER ────────────────────────────────────────────────────────────────────
async function powerAction(containerId, action) {
  if (!docker) throw new Error('Lokales Docker nicht verfügbar');
  const c = docker.getContainer(containerId);
  switch (action) {
    case 'start':
      try { await c.start(); } catch (e) {
        // 304 = already running → kein Fehler
        if (!e.message?.includes('304') && !e.statusCode === 304) throw e;
      }
      break;
    case 'stop':
      try { await c.stop({ t: 15 }); } catch (e) {
        if (!e.message?.includes('304') && e.statusCode !== 304) throw e;
      }
      break;
    case 'restart': await c.restart({ t: 10 }); break;
    case 'kill':    await c.kill();              break;
    default: throw new Error(`Unbekannte Aktion: ${action}`);
  }
  // Echten Status vom Container lesen statt annehmen
  try {
    const info = await c.inspect();
    const running = info.State?.Running;
    const status  = running ? 'running' : info.State?.ExitCode !== 0 ? 'error' : 'offline';
    return { success: true, status };
  } catch {
    const fallback = { start:'running', stop:'offline', restart:'running', kill:'offline' };
    return { success: true, status: fallback[action] || 'offline' };
  }
}

// ─── LOGS ────────────────────────────────────────────────────────────────────
async function getLogs(containerId, lines = 200) {
  if (!docker || !containerId) return '';
  try {
    const raw = await docker.getContainer(containerId)
      .logs({ stdout: true, stderr: true, tail: lines, timestamps: true });
    return demuxDockerLogs(raw).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  } catch { return ''; }
}

// ─── STREAMING LOGS ───────────────────────────────────────────────────────────
function demuxDockerLogs(chunk) {
  // Docker multiplexed stream: 8-byte header per frame
  // [type(1)][0,0,0(3)][size uint32 BE(4)][payload]
  const lines = [];
  let offset = 0;
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset];    // 1=stdout, 2=stderr
    const frameSize  = buf.readUInt32BE(offset + 4);
    if (frameSize === 0) { offset += 8; continue; }
    if (offset + 8 + frameSize > buf.length) break;
    const payload = buf.slice(offset + 8, offset + 8 + frameSize).toString('utf8');
    lines.push(payload);
    offset += 8 + frameSize;
  }
  // Fallback: if parsing yielded nothing, just use raw (non-multiplexed mode)
  if (lines.length === 0 && buf.length > 0) {
    lines.push(buf.toString('utf8'));
  }
  return lines.join('')
    .replace(/\x1b\[[0-9;]*[mGKHF]/g, '')   // ANSI farben/cursor weg
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // restliche Steuerzeichen
}

async function followLogs(containerId, onData) {
  if (!docker || !containerId) return null;
  try {
    const stream = await docker.getContainer(containerId)
      .logs({ stdout: true, stderr: true, follow: true, tail: 100 });
    stream.on('data', chunk => {
      const text = demuxDockerLogs(chunk);
      if (text) onData(text);
    });
    stream.on('error', () => {});
    return stream;
  } catch { return null; }
}

// ─── EXEC ────────────────────────────────────────────────────────────────────
async function execCommand(containerId, command) {
  if (!docker || !containerId) return `[kein Container] ${command}`;
  const exec   = await docker.getContainer(containerId).exec({ Cmd: ['sh', '-c', command], AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks = [];
  stream.on('data', d => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
  await new Promise(resolve => stream.on('end', resolve));
  // Docker exec stream ist multiplexed (8-Byte Header) → demuxen
  return demuxDockerLogs(Buffer.concat(chunks));
}

// ─── MINECRAFT COMMAND via rcon-cli ──────────────────────────────────────
// ─── CONTAINER RUNNING CHECK ─────────────────────────────────────────────────
async function isContainerRunning(containerId) {
  if (!docker || !containerId || !_dockerAvailable) return false;
  try {
    const info = await docker.getContainer(containerId).inspect();
    return info?.State?.Running === true;
  } catch { return false; }
}

async function sendStdin(containerId, command) {
  if (!docker || !containerId) throw new Error('Kein Container');
  // rcon-cli ist in itzg/minecraft-server eingebaut und nutzt RCON (läuft auf Port 25575 intern)
  const clean = command.replace(/^\//, '').trim(); // führenden / entfernen
  const output = await execCommand(containerId, `rcon-cli "${clean.replace(/"/g, '\\"')}"`);
  return output;
}

// ─── REMOVE ──────────────────────────────────────────────────────────────────
async function removeContainer(containerId) {
  if (!docker || !containerId) return { success: true };
  try {
    const c = docker.getContainer(containerId);
    await c.stop().catch(() => {});
    await c.remove({ force: true }).catch(() => {});
  } catch {}
  return { success: true };
}

// ─── IMAGES ──────────────────────────────────────────────────────────────────
async function listImages() {
  if (!docker) return [];
  try {
    return (await docker.listImages()).map(img => ({
      Id:       (img.Id || '').replace('sha256:', '').substring(0, 12),
      RepoTags: img.RepoTags || ['<none>:<none>'],
      Size:     img.Size,
      Created:  img.Created,
    }));
  } catch { return []; }
}

async function pullImage(image) {
  if (!docker) throw new Error('Lokales Docker nicht verfügbar');
  const stream = await docker.pull(image);
  await new Promise((resolve, reject) =>
    docker.modem.followProgress(stream, err => err ? reject(err) : resolve())
  );
  return { success: true };
}

// ─── INFO ─────────────────────────────────────────────────────────────────────
async function getDockerInfo() {
  if (!docker) return null;
  try {
    const i = await docker.info();
    return {
      docker_version:     i.ServerVersion,
      os:                 i.OperatingSystem,
      cpus:               i.NCPU,
      memory_total:       i.MemTotal,
      containers_total:   i.Containers,
      containers_running: i.ContainersRunning,
      images:             i.Images,
      hostname:           i.Name,
    };
  } catch { return null; }
}



// ─── FILE MANAGER ─────────────────────────────────────────────────────────────
async function filesList(containerId, path) {
  const output = await execCommand(containerId,
    `ls -lA --time-style=+"%Y-%m-%dT%H:%M:%S" "${path}" 2>&1 && echo "EXIT:0" || echo "EXIT:1"`);
  if (output.includes('EXIT:1') || output.includes('No such file')) {
    throw new Error(`Pfad nicht gefunden: ${path}`);
  }
  const lines = output.split('\n').filter(l => l && !l.startsWith('total') && !l.startsWith('EXIT'));
  const files = lines.map(line => {
    // parse: permissions links user group size date name
    const m = line.match(/^([dlrwx\-]{10})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) return null;
    const [, perms, size, mtime, name] = m;
    return {
      name,
      type:     perms.startsWith('d') ? 'directory' : perms.startsWith('l') ? 'symlink' : 'file',
      size:     parseInt(size) || 0,
      modified: mtime,
      perms,
    };
  }).filter(Boolean);
  return { success: true, files };
}

async function filesRead(containerId, path) {
  const sizeOut = await execCommand(containerId, `wc -c < "${path}" 2>&1 || echo "0"`);
  const size = parseInt(sizeOut.trim()) || 0;
  if (size > 2 * 1024 * 1024) throw new Error('Datei zu groß (max 2 MB)');
  const content = await execCommand(containerId, `cat "${path}" 2>&1`);
  return { success: true, content, size };
}

async function filesWrite(containerId, path, content) {
  // Write via printf to handle special characters
  const escaped = content.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
  await execCommand(containerId,
    `mkdir -p "$(dirname '${path}')" && printf '%s' '${escaped}' > "${path}"`);
  return { success: true };
}

async function filesCreate(containerId, path, fileType) {
  if (fileType === 'directory') {
    await execCommand(containerId, `mkdir -p "${path}"`);
  } else {
    await execCommand(containerId, `mkdir -p "$(dirname '${path}')" && touch "${path}"`);
  }
  return { success: true };
}

async function filesDelete(containerId, path) {
  await execCommand(containerId, `rm -rf "${path}"`);
  return { success: true };
}

async function filesRename(containerId, from, to) {
  await execCommand(containerId, `mv "${from}" "${to}"`);
  return { success: true };
}

async function filesCompress(containerId, paths, destination) {
  const dest = destination || '/home/container/archive.tar.gz';
  const fileList = paths.map(p => `"${p}"`).join(' ');
  await execCommand(containerId, `tar -czf "${dest}" ${fileList}`);
  return { success: true };
}

// ─── DISK-NUTZUNG ─────────────────────────────────────────────────────────────
async function diskUsage(containerId, workDir = '/home/container') {
  if (!docker || !containerId) return { bytes_used: 0 };
  try {
    const exec = await docker.getContainer(containerId).exec({
      Cmd: ['sh', '-c', `du -sb "${workDir}" 2>/dev/null | awk '{print $1}' || echo "0"`],
      AttachStdout: true, AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const output = await new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      stream.on('data', chunk => { buf = Buffer.concat([buf, chunk]); });
      stream.on('end', () => resolve(demuxDockerLogs(buf)));
    });
    const bytes = parseInt(output.trim().split(/[\s\n]+/)[0]) || 0;
    return { success: true, bytes_used: bytes };
  } catch {
    return { success: true, bytes_used: 0 };
  }
}

// ─── BACKUP ERSTELLEN ─────────────────────────────────────────────────────────
async function createBackup(containerId, workDir, filePath) {
  if (!docker || !containerId) throw new Error('Kein Container');
  const fs   = require('fs');
  const fsP  = require('fs').promises;
  const path = require('path');
  const zlib = require('zlib');

  await fsP.mkdir(path.dirname(filePath), { recursive: true });

  const container = docker.getContainer(containerId);

  // ── Echtes WorkingDir aus Container auslesen ───────────────────────────────
  // Fallback-Kette: Parameter → Container-Inspect WorkingDir → /data (itzg) → /
  let resolvedPath = workDir;
  try {
    const info   = await container.inspect();
    const image  = (info.Config?.Image || '').toLowerCase();
    const inspWd = info.Config?.WorkingDir;

    if (!resolvedPath || resolvedPath === '/home/container') {
      // itzg images always use /data
      if (image.includes('itzg') || image.includes('minecraft-server')) {
        resolvedPath = '/data';
      } else if (inspWd && inspWd !== '/') {
        resolvedPath = inspWd;
      } else {
        resolvedPath = '/';
      }
    }

    // Verify the path actually exists in the container
    const testExec = await container.exec({
      Cmd: ['test', '-d', resolvedPath],
      AttachStdout: false, AttachStderr: false,
    });
    const testStream = await testExec.start({ hijack: true });
    const exitCode   = await new Promise(resolve => {
      testStream.on('end', async () => {
        try { const r = await testExec.inspect(); resolve(r.ExitCode); }
        catch { resolve(0); }
      });
      testStream.resume();
    });

    if (exitCode !== 0) {
      // Path doesn't exist — fall back to /
      console.warn(`[backup] Pfad "${resolvedPath}" existiert nicht im Container, nutze /`);
      resolvedPath = '/';
    }
  } catch (e) {
    console.warn('[backup] Container-Inspect fehlgeschlagen, nutze angegebenen Pfad:', e.message);
  }

  console.log(`[backup] Erstelle Backup von "${resolvedPath}" → ${filePath}`);

  const archiveStream = await new Promise((resolve, reject) => {
    container.getArchive({ path: resolvedPath }, (err, stream) => {
      if (err) return reject(new Error(`getArchive fehlgeschlagen (Pfad: ${resolvedPath}): ${err.message}`));
      resolve(stream);
    });
  });

  const gzip   = zlib.createGzip({ level: 6 });
  const output = fs.createWriteStream(filePath);

  await new Promise((resolve, reject) => {
    archiveStream.on('error', reject);
    gzip.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
    archiveStream.pipe(gzip).pipe(output);
  });

  return { success: true, path: resolvedPath };
}

// ─── BACKUP WIEDERHERSTELLEN ──────────────────────────────────────────────────
async function restoreBackup(containerId, workDir, filePath) {
  if (!docker || !containerId) throw new Error('Kein Container');
  const fs   = require('fs');
  const zlib = require('zlib');

  if (!fs.existsSync(filePath)) throw new Error('Backup-Datei nicht gefunden: ' + filePath);

  const container = docker.getContainer(containerId);
  const input     = fs.createReadStream(filePath);
  const gunzip    = zlib.createGunzip();
  const tarStream = input.pipe(gunzip);

  await new Promise((resolve, reject) => {
    container.putArchive(tarStream, { path: workDir }, (err) => {
      if (err) reject(err); else resolve();
    });
  });

  return { success: true };
}

module.exports = {
  docker, isAvailable,
  getStats, createContainer, powerAction,
  getLogs, followLogs, execCommand, sendStdin, removeContainer, updateContainerPorts,
  listImages, pullImage, getDockerInfo,
  filesList, filesRead, filesWrite, filesCreate, filesDelete, filesRename, filesCompress,
  diskUsage, createBackup, restoreBackup,
};

// ─── PORTS AKTUALISIEREN (Container neu erstellen) ───────────────────────────
async function updateContainerPorts(containerId, newPorts) {
  if (!docker || !containerId) throw new Error('Kein Container');
  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  const wasRunning = info.State.Running;

  const portBindings = {};
  const exposedPorts = {};
  newPorts.forEach(p => {
    const host = p.host || p;
    const cont = p.container || p.host || p;
    exposedPorts[`${cont}/tcp`] = {};
    portBindings[`${cont}/tcp`] = [{ HostPort: String(host) }];
  });

  if (wasRunning) await container.stop({ t: 10 }).catch(() => {});
  await container.remove({ force: true });

  const cfg = info.Config;
  const hcfg = info.HostConfig;
  const newContainer = await docker.createContainer({
    Image:        cfg.Image,
    name:         info.Name.replace(/^[/]/, ''),
    Env:          cfg.Env || [],
    WorkingDir:   cfg.WorkingDir || '',
    Cmd:          cfg.Cmd || undefined,
    ExposedPorts: exposedPorts,
    HostConfig: {
      Memory:        hcfg.Memory,
      MemorySwap:    hcfg.MemorySwap,
      NanoCpus:      hcfg.NanoCpus,
      PortBindings:  portBindings,
      NetworkMode:   hcfg.NetworkMode || 'bridge',
      RestartPolicy: hcfg.RestartPolicy || { Name: 'on-failure', MaximumRetryCount: 3 },
      PidsLimit:     hcfg.PidsLimit || 256,
      Binds:         hcfg.Binds || [],
    },
    Labels: cfg.Labels || {},
  });

  if (wasRunning) await newContainer.start();
  return { success: true, container_id: newContainer.id };
}
