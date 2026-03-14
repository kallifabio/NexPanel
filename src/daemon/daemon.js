'use strict';
/**
 * daemon.js — NexPanel Node-Daemon
 * Läuft auf jedem Remote-Node-Server.
 * Verbindet sich ausgehend per WebSocket zum Panel.
 * Führt Docker-Befehle lokal aus und streamt Ergebnisse zurück.
 *
 * Start:
 *   NODE_ID="xxx" NODE_TOKEN="hpd_xxx" PANEL_URL="ws://panel:3000" node daemon.js
 */

const WebSocket = require('ws');
const Docker    = require('dockerode');
const os        = require('os');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const NODE_ID    = process.env.NODE_ID;
const NODE_TOKEN = process.env.NODE_TOKEN;
const PANEL_URL  = process.env.PANEL_URL;
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const RECONNECT_DELAY = parseInt(process.env.RECONNECT_DELAY) || 5000;

if (!NODE_ID || !NODE_TOKEN || !PANEL_URL) {
  console.error('❌  NODE_ID, NODE_TOKEN und PANEL_URL müssen gesetzt sein.');
  process.exit(1);
}

// ─── DOCKER ───────────────────────────────────────────────────────────────────
let docker;
try {
  docker = new Docker({ socketPath: DOCKER_SOCKET });
  console.log('✅  Docker-Socket verbunden:', DOCKER_SOCKET);
} catch (e) {
  console.error('❌  Docker nicht verfügbar:', e.message);
  process.exit(1);
}

// Aktive Log-Streams: container_id → stream
const logStreams = new Map();

// ─── WS CONNECTION ────────────────────────────────────────────────────────────
function connect() {
  const wsUrl = PANEL_URL.replace(/^http/, 'ws').replace(/\/$/, '') + '/daemon';
  console.log(`🔌  Verbinde mit Panel: ${wsUrl}`);

  const ws = new WebSocket(wsUrl, {
    headers: {
      'x-node-id':    NODE_ID,
      'x-node-token': NODE_TOKEN,
    },
  });

  ws.on('open', async () => {
    console.log('🟢  Panel verbunden');
    // Hello-Paket mit System-Info senden
    const sysInfo = await getSystemInfo();
    send(ws, { type: 'hello', system: sysInfo });

    // Heartbeat alle 15 Sekunden
    const heartbeat = setInterval(async () => {
      if (ws.readyState !== WebSocket.OPEN) { clearInterval(heartbeat); return; }
      send(ws, { type: 'heartbeat', system: await getSystemInfo() });
    }, 15_000);

    ws.on('close', () => clearInterval(heartbeat));
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    try {
      const result = await handleMessage(ws, msg);
      if (msg.req_id) {
        send(ws, { type: 'reply', req_id: msg.req_id, success: true, ...result });
      }
    } catch (e) {
      console.error(`❌  Fehler bei ${msg.type}:`, e.message);
      if (msg.req_id) {
        send(ws, { type: 'reply', req_id: msg.req_id, success: false, error: e.message });
      }
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`🔴  Verbindung getrennt (${code}). Retry in ${RECONNECT_DELAY}ms...`);
    // Log-Streams bereinigen
    for (const [, stream] of logStreams) { try { stream.destroy(); } catch {} }
    logStreams.clear();
    setTimeout(connect, RECONNECT_DELAY);
  });

  ws.on('error', (e) => console.error('WS-Fehler:', e.message));
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
async function handleMessage(ws, msg) {
  const { type, server_id, container_id, config, command, image, lines } = msg;

  switch (type) {

    // ── SERVER ERSTELLEN ────────────────────────────────────────────────────
    case 'server.create': {
      const {
        image: img, cpu_limit = 100, memory_limit = 512, swap_limit = 0,
        ports = [], env_vars = {}, startup_command, work_dir = '/home/container', network = 'bridge',
      } = config;

      // Image lokal vorhanden? Falls nicht: automatisch pullen
      const existingImages = await docker.listImages({ filters: { reference: [img] } }).catch(() => []);
      if (!existingImages.length) {
        console.log(`📦 Pulling image: ${img}`);
        const pullStream = await docker.pull(img);
        await new Promise((resolve, reject) =>
          docker.modem.followProgress(pullStream, err => err ? reject(err) : resolve())
        );
        console.log(`✅ Image gepullt: ${img}`);
      }

      const portBindings = {};
      const exposedPorts = {};
      ports.forEach(p => {
        const [h, c] = typeof p === 'object' ? [p.host, p.container] : [p, p];
        exposedPorts[`${c}/tcp`] = {};
        portBindings[`${c}/tcp`] = [{ HostPort: String(h) }];
      });

      const container = await docker.createContainer({
        Image:        img,
        name:         `nexpanel_${server_id.substring(0, 8)}`,
        Env:          Object.entries(env_vars).map(([k, v]) => `${k}=${v}`),
        WorkingDir:   work_dir,
        ExposedPorts: exposedPorts,
        Cmd:          startup_command ? startup_command.split(' ') : undefined,
        HostConfig: {
          Memory:        memory_limit * 1024 * 1024,
          MemorySwap:    swap_limit > 0 ? (memory_limit + swap_limit) * 1024 * 1024 : -1,
          NanoCpus:      Math.floor(cpu_limit * 1e9), // cpu_limit = Kerne
          PortBindings:  portBindings,
          NetworkMode:   network,
          RestartPolicy: { Name: 'unless-stopped' },
          PidsLimit:     256,
        },
        Labels: { 'nexpanel.managed': 'true', 'nexpanel.server_id': server_id },
      });
      return { container_id: container.id };
    }

    // ── SERVER LÖSCHEN ──────────────────────────────────────────────────────
    case 'server.delete': {
      if (!container_id) return {};
      const c = docker.getContainer(container_id);
      await c.stop({ t: 5 }).catch(() => {});
      await c.remove({ force: true }).catch(() => {});
      return {};
    }

    // ── POWER AKTIONEN ──────────────────────────────────────────────────────
    case 'server.start': {
      await docker.getContainer(container_id).start();
      send(ws, { type: 'server.status', server_id, status: 'running' });
      return { status: 'running' };
    }

    case 'server.stop': {
      await docker.getContainer(container_id).stop({ t: 10 });
      send(ws, { type: 'server.status', server_id, status: 'offline' });
      return { status: 'offline' };
    }

    case 'server.restart': {
      await docker.getContainer(container_id).restart({ t: 10 });
      send(ws, { type: 'server.status', server_id, status: 'running' });
      return { status: 'running' };
    }

    case 'server.kill': {
      await docker.getContainer(container_id).kill();
      send(ws, { type: 'server.status', server_id, status: 'offline' });
      return { status: 'offline' };
    }

    // ── LOGS ────────────────────────────────────────────────────────────────
    case 'server.logs.tail': {
      const raw = await docker.getContainer(container_id)
        .logs({ stdout: true, stderr: true, tail: lines || 200, timestamps: true });
      return { logs: raw.toString('utf8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') };
    }

    // ── LOG STREAMING ───────────────────────────────────────────────────────
    case 'server.logs.subscribe': {
      if (logStreams.has(container_id)) break;
      const stream = await docker.getContainer(container_id)
        .logs({ stdout: true, stderr: true, follow: true, tail: 50 });
      logStreams.set(container_id, stream);
      stream.on('data', chunk => {
        const text = chunk.toString('utf8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
        send(ws, { type: 'server.log', server_id, data: text });
      });
      stream.on('end', () => logStreams.delete(container_id));
      return {};
    }

    case 'server.logs.unsubscribe': {
      const stream = logStreams.get(container_id);
      if (stream) { try { stream.destroy(); } catch {} logStreams.delete(container_id); }
      return {};
    }

    // ── STATS STREAMING ─────────────────────────────────────────────────────
    case 'server.stats.start': {
      // Starte Stats-Stream (fire-and-forget)
      streamStats(ws, server_id, container_id);
      return {};
    }

    case 'server.stats.stop': {
      // Wird durch Container-Stop automatisch beendet
      return {};
    }

    // ── COMMAND ─────────────────────────────────────────────────────────────
    case 'server.command': {
      const exec   = await docker.getContainer(container_id)
        .exec({ Cmd: ['sh', '-c', command], AttachStdout: true, AttachStderr: true });
      const stream = await exec.start({ hijack: true, stdin: false });
      let output   = '';
      stream.on('data', d => { output += d.toString(); });
      await new Promise(resolve => stream.on('end', resolve));
      return { output };
    }

    // ── NODE INFO ────────────────────────────────────────────────────────────
    case 'node.info': {
      return { system: await getSystemInfo() };
    }

    // ── DOCKER IMAGES ────────────────────────────────────────────────────────
    case 'docker.images': {
      const imgs = await docker.listImages();
      return {
        images: imgs.map(i => ({
          id:      (i.Id || '').replace('sha256:', '').substring(0, 12),
          tags:    i.RepoTags || ['<none>:<none>'],
          size:    i.Size,
          created: i.Created,
        }))
      };
    }

    case 'docker.pull': {
      const stream = await docker.pull(image);
      await new Promise((resolve, reject) =>
        docker.modem.followProgress(stream, err => err ? reject(err) : resolve())
      );
      return {};
    }

    default:
      throw new Error(`Unbekannter Befehl: ${type}`);
  }
  return {};
}

// ─── STATS STREAM ─────────────────────────────────────────────────────────────
async function streamStats(ws, serverId, containerId) {
  const container = docker.getContainer(containerId);
  while (ws.readyState === WebSocket.OPEN) {
    try {
      const raw = await new Promise((resolve, reject) =>
        container.stats({ stream: false }, (err, d) => err ? reject(err) : resolve(d))
      );
      const cpuD = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
      const sysD = raw.cpu_stats.system_cpu_usage - raw.precpu_stats.system_cpu_usage;
      const cpus = raw.cpu_stats.online_cpus || 1;
      const cpu  = sysD > 0 ? (cpuD / sysD) * cpus * 100 : 0;
      const nets = raw.networks || {};
      send(ws, {
        type: 'server.stats', server_id: serverId,
        data: {
          cpu:          Math.round(cpu * 100) / 100,
          memory:       raw.memory_stats.usage || 0,
          memory_limit: raw.memory_stats.limit || 0,
          network_rx:   Object.values(nets).reduce((a, n) => a + n.rx_bytes, 0),
          network_tx:   Object.values(nets).reduce((a, n) => a + n.tx_bytes, 0),
          pids:         raw.pids_stats?.current || 0,
        }
      });
    } catch { break; }
    await sleep(2000);
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(msg));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getSystemInfo() {
  const mem = os.totalmem();
  const free = os.freemem();
  let dockerInfo = null;
  try { dockerInfo = await docker.info(); } catch {}
  return {
    hostname:           os.hostname(),
    platform:           os.platform(),
    cpus:               os.cpus().length,
    memory_total:       mem,
    memory_free:        free,
    memory_used:        mem - free,
    load:               os.loadavg(),
    uptime:             os.uptime(),
    docker_version:     dockerInfo?.ServerVersion || 'unknown',
    containers_running: dockerInfo?.ContainersRunning || 0,
    containers_total:   dockerInfo?.Containers || 0,
    images:             dockerInfo?.Images || 0,
    node_version:       process.version,
  };
}

// ─── START ────────────────────────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════════╗
║         NexPanel Node-Daemon v3.0           ║
╠══════════════════════════════════════════════╣
║  Node-ID: ${NODE_ID.substring(0, 34).padEnd(34)}║
║  Panel:   ${PANEL_URL.substring(0, 34).padEnd(34)}║
╚══════════════════════════════════════════════╝
`);

connect();
