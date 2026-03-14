/* NexPanel — ws.js
 * WebSocket connection, status polling, real-time updates
 */

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
let _wsDelay = 2000;
let _wsTimer = null;

function connectWS() {
  // Verhindere doppelte Verbindungen
  if (State.wsConn && State.wsConn.readyState === WebSocket.CONNECTING) return;
  if (State.wsConn && State.wsConn.readyState === WebSocket.OPEN) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try {
    ws = new WebSocket(`${proto}//${location.host}/ws`);
  } catch { return; }

  State.wsConn = ws;

  ws.onopen = () => {
    _wsDelay = 2000; // Reset backoff bei Erfolg
    ws.send(JSON.stringify({ type: 'auth', token: State.token }));
    // Aktiven Server neu abonnieren
    if (State.serverDetail) {
      wsSend({ type: 'subscribe_stats',   server_id: State.serverDetail });
      wsSend({ type: 'console.subscribe', server_id: State.serverDetail });
    }
  };

  ws.onmessage = e => { try { handleWsMsg(JSON.parse(e.data)); } catch {} };

  ws.onerror = () => { /* Error wird durch onclose abgehandelt, kein Log */ };

  ws.onclose = () => {
    State.wsConn = null;
    // Exponential backoff: 2s → 4s → 8s → max 30s
    _wsDelay = Math.min(_wsDelay * 1.5, 30000);
    if (_wsTimer) clearTimeout(_wsTimer);
    _wsTimer = setTimeout(connectWS, _wsDelay);
  };
}

function toggleAlloc(el, port) {
  const portsEl = document.getElementById('m-ports');
  if (!portsEl) return;
  const entry = `${port}:${port}`;
  const selected = el.dataset.selected === '1';
  if (selected) {
    el.style.background = 'var(--card2)';
    el.style.color = 'var(--success)';
    el.dataset.selected = '0';
    portsEl.value = portsEl.value.split(',').map(s=>s.trim()).filter(s=>s && s!==entry).join(', ');
  } else {
    el.style.background = '#7c6af7';
    el.style.color = '#fff';
    el.dataset.selected = '1';
    const parts = portsEl.value.split(',').map(s=>s.trim()).filter(Boolean);
    if (!parts.includes(entry)) parts.push(entry);
    portsEl.value = parts.join(', ');
  }
}

function wsSend(m) { if (State.wsConn?.readyState === WebSocket.OPEN) State.wsConn.send(JSON.stringify(m)); }

// ─── STATUS POLLING ──────────────────────────────────────────────────────────
// Wenn Server in transitionalem Zustand (starting/stopping/installing) → alle 3s Status prüfen
let _statusPollTimer = null;
const TRANSITIONAL = new Set(['starting','stopping','restarting','installing']);

function startStatusPoll(serverId) {
  stopStatusPoll();
  _statusPollTimer = setInterval(async () => {
    try {
      const srv = await API.get(`/servers/${serverId}`);
      // Status-Dot überall aktualisieren
      document.querySelectorAll(`[data-sid="${serverId}"]`).forEach(el => {
        el.className = `server-status-dot ${srv.status}`;
      });
      if (State.currentPage === 'server-detail' && State.serverDetail === serverId) {
        // Topbar-Buttons neu rendern wenn Status sich geändert hat
        const sc = srv.status;
        document.getElementById('page-actions').innerHTML = `
          <button class="btn btn-ghost btn-sm" onclick="navigate('servers')">← Zurück</button>
          ${sc !== 'running' ? `<button class="btn btn-success btn-sm" onclick="serverPower('${serverId}','start')"><i data-lucide="play"></i> Start</button>` : ''}
          ${sc === 'running' ? `<button class="btn btn-ghost btn-sm" onclick="serverPower('${serverId}','restart')"><i data-lucide="rotate-ccw"></i> Restart</button>` : ''}
          ${sc === 'running' ? `<button class="btn btn-danger btn-sm" onclick="serverPower('${serverId}','stop')"><i data-lucide="square"></i> Stop</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="showEditServer('${serverId}')"><i data-lucide="pencil"></i> Bearbeiten</button>
          <button class="btn btn-ghost btn-sm text-danger" onclick="confirmDeleteServer('${serverId}','${esc(srv.name)}')"><i data-lucide="trash-2"></i></button>`;
        // Konsole-Header-Dot
        const dot = document.querySelector('.console-dot');
        if (dot) dot.style.background = sc === 'running' ? 'var(--success)' : 'var(--text3)';
      }
      // Polling stoppen wenn stabiler Status erreicht
      if (!TRANSITIONAL.has(srv.status)) stopStatusPoll();
    } catch {}
  }, 3000);
}

function stopStatusPoll() {
  if (_statusPollTimer) { clearInterval(_statusPollTimer); _statusPollTimer = null; }
}

function handleWsMsg(msg) {
  if (msg.type === 'auth') return;
  if (msg.type === 'stats')          { handleWsStats(msg); return; }
  if (msg.type === 'disk.alert')      { handleDiskAlert(msg); return; }
  if (msg.type === 'console')        { handleWsConsole(msg); return; }
  // v2: Node-Events
  if (msg.type === 'nodes.status')   { msg.nodes.forEach(n => { State.nodes[n.id] = n; }); updateNodeIndicators(); return; }
  if (msg.type === 'node.online')    { if (State.nodes[msg.node_id]) State.nodes[msg.node_id].connected = true; updateNodeIndicators(); toast(`Node "${msg.node_name}" verbunden`, 'success'); return; }
  if (msg.type === 'node.offline')   { if (State.nodes[msg.node_id]) State.nodes[msg.node_id].connected = false; updateNodeIndicators(); toast(`Node "${msg.node_name}" getrennt`, 'warn'); return; }
  if (msg.type === 'node.info' && State.nodes[msg.node_id]) { State.nodes[msg.node_id].system = msg.system; return; }
  if (msg.type === 'server.status')  {
    document.querySelectorAll(`[data-sid="${msg.server_id}"]`).forEach(el => el.className = `server-status-dot ${msg.status}`);
  }
}

function updateNodeIndicators() {
  document.querySelectorAll('[data-node-ind]').forEach(el => {
    const n = State.nodes[el.dataset.nodeInd];
    if (!n) return;
    const dot = el.querySelector('.ndot');
    if (dot) dot.className = `ndot ${n.connected ? (n.is_local ? 'ndot-local' : 'ndot-on') : 'ndot-off'}`;
    const lbl = el.querySelector('.ni-lbl');
    if (lbl) lbl.textContent = n.connected ? (n.is_local ? 'lokal' : 'online') : 'offline';
  });
}
