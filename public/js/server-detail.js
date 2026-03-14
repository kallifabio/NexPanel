/* NexPanel — server-detail.js
 * Server detail view, console, live charts
 */

// ─── SERVER DETAIL ────────────────────────────────────────────────────────────
async function loadServerDetail(id) {
  let server;
  try { server = await API.get(`/servers/${id}`); State.server = server; } catch (e) {
    document.getElementById('page-content').innerHTML = `<div class="empty"><p class="text-danger">Fehler: ${esc(e.message)}</p></div>`; return;
  }
  const sc   = server.status;
  const node = server.node || {};

  // Node-Indikator in Topbar
  if (node.id) {
    State.nodes[node.id] = { ...node, connected: server.node_connected };
    document.getElementById('page-meta').innerHTML = `
      <div class="node-indicator" data-node-ind="${node.id}">
        <div class="ndot ${server.node_connected ? (node.is_local ? 'ndot-local' : 'ndot-on') : 'ndot-off'}"></div>
        <span>${esc(node.name||'Node')}</span>
        <span class="ni-lbl">${server.node_connected ? (node.is_local ? 'lokal' : 'online') : 'offline'}</span>
      </div>`;
  }

  document.getElementById('page-actions').innerHTML = `
    <button class="btn btn-ghost btn-sm" onclick="navigate('servers')">← Zurück</button>
    ${sc !== 'running' ? `<button class="btn btn-success btn-sm" onclick="serverPower('${id}','start')"><i data-lucide="play"></i> Start</button>` : ''}
    ${sc === 'running' ? `<button class="btn btn-ghost btn-sm" onclick="serverPower('${id}','restart')"><i data-lucide="rotate-ccw"></i> Restart</button>` : ''}
    ${sc === 'running' ? `<button class="btn btn-danger btn-sm" onclick="serverPower('${id}','stop')"><i data-lucide="square"></i> Stop</button>` : ''}
    <button class="btn btn-ghost btn-sm" onclick="showEditServer('${id}')"><i data-lucide="pencil"></i> Bearbeiten</button>
    <button class="btn btn-ghost btn-sm" onclick="showCloneServer('${id}','${esc(server.name)}')">⧉ Klonen</button>
    <button class="btn btn-ghost btn-sm text-danger" onclick="confirmDeleteServer('${id}','${esc(server.name)}')"><i data-lucide="trash-2"></i></button>`;

  const portsHtml = server.ports?.length ? server.ports.map(p => typeof p==='object'?`${p.host}→${p.container}`:p).join(', ') : 'Keine';
  const envHtml   = Object.keys(server.env_vars||{}).length
    ? Object.entries(server.env_vars).map(([k,v]) => `<tr><td class="text-mono text-accent">${esc(k)}</td><td class="text-mono">${esc(v)}</td></tr>`).join('')
    : '<tr><td colspan="2" class="text-dim">Keine Variablen</td></tr>';

  document.getElementById('page-content').innerHTML = `
    <div class="server-detail-banner">
      <div class="sdb-left">
        <div class="sdb-status-dot ${sc}"></div>
        <div class="sdb-info">
          <div class="sdb-name">${esc(server.name)}</div>
          <div class="sdb-meta">
            <span><i data-lucide="layers"></i> ${esc(server.image||'–')}</span>
            <span><i data-lucide="globe"></i> ${esc(node.name||'Lokal')}</span>
            ${server.ports?.length ? `<span><i data-lucide="plug"></i> ${server.ports.slice(0,2).map(p=>typeof p==='object'?p.host:p).join(', ')}</span>` : ''}
            <span><i data-lucide="hard-drive"></i> ${server.memory_limit||'?'} MB RAM · ${server.cpu_limit||'?'} Kern(e)</span>
          </div>
        </div>
      </div>
      <span class="sdb-badge sdb-badge-${sc}">${sc}</span>
    </div>
    <div class="tabs-wrap">
    <div class="tabs" id="detail-tabs">
      <button class="tab active" onclick="detailTab('console',this)"><i data-lucide="terminal"></i> Konsole</button>
      <button class="tab" onclick="detailTab('stats',this)"><i data-lucide="activity"></i> Ressourcen</button>
      <button class="tab" onclick="detailTab('files',this)"><i data-lucide="folder"></i> Dateien</button>
      <button class="tab" id="mods-tab-btn" onclick="detailTab('mods',this)"><i data-lucide="puzzle"></i> Mods</button>
      <button class="tab" onclick="detailTab('info',this)"><i data-lucide="settings-2"></i> Konfig</button>
      <button class="tab" onclick="detailTab('network',this)"><i data-lucide="network"></i> Netzwerk</button>
      <button class="tab" onclick="detailTab('schedule',this)"><i data-lucide="clock"></i> Tasks</button>
      <button class="tab" onclick="detailTab('users',this)"><i data-lucide="users"></i> Benutzer</button>
      <button class="tab" onclick="detailTab('activity',this)"><i data-lucide="list"></i> Aktivität</button>
      <button class="tab" onclick="detailTab('backups',this)"><i data-lucide="hard-drive"></i> Backups</button>
      <button class="tab" onclick="detailTab('sftp',this)"><i data-lucide="terminal-square"></i> SFTP</button>
      <button class="tab" onclick="detailTab('notify',this)"><i data-lucide="bell"></i> Alerts</button>
      <button class="tab" onclick="detailTab('maintenance',this)"><i data-lucide="wrench"></i> Wartung</button>
      <button class="tab" onclick="detailTab('transfer',this)"><i data-lucide="package"></i> Transfer</button>
      <button class="tab" onclick="detailTab('reinstall',this)"><i data-lucide="refresh-cw"></i> Reinstall</button>
    </div>
    </div>

    <div id="detail-console">
      <div class="server-detail-grid">
        <div>
          <div class="console-wrap">
            <div class="console-header">
              <div class="console-dot" style="background:${sc==='running'?'var(--success)':'var(--text3)'}"></div>
              <span style="font-size:12px;color:var(--text2);font-family:var(--mono)">${esc(server.name)} — ${sc}</span>
              <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="clearConsole()"><i data-lucide="trash-2"></i></button>
              <button class="btn btn-ghost btn-sm" id="console-pause-btn" onclick="toggleConsolePause()"><i data-lucide="pause"></i> Pause</button>
              <button class="btn btn-ghost btn-sm" onclick="downloadConsoleLogs()"><i data-lucide="download"></i> Log</button>
              <button class="btn btn-ghost btn-sm" onclick="showAliasManager(State.serverDetail)" title="Console Aliases"><i data-lucide="hash"></i> Aliases</button>
              <button class="btn btn-ghost btn-sm" onclick="reloadLogs('${id}')"><i data-lucide="rotate-ccw"></i></button>
            </div>
            <div style="padding:6px 10px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px">
              <span style="font-size:11px;color:var(--text3);flex-shrink:0">Filter:</span>
              <input type="text" style="flex:1;background:transparent;border:none;outline:none;font-size:12px;font-family:var(--mono);color:var(--text2)" placeholder="Regex oder Text… (z.B. ERROR|WARN)" oninput="applyConsoleFilter(this.value)" id="console-filter-input"/>
              <span id="console-filter-hint" class="text-dim" style="font-size:10px"></span>
            </div>
            <div class="console-output" id="console-output"></div>
            <div class="console-input-row">
              <span class="console-prompt">$</span>
              <input type="text" class="console-input" id="console-input" placeholder="Befehl eingeben... (↑↓ History)"
                onkeydown="handleConsoleKey(event,'${id}')"/>
            </div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="card">
            <div class="card-title" style="margin-bottom:14px"><i data-lucide="activity"></i> Live Stats</div>
            <div class="resource-row"><span class="resource-label">CPU</span><div class="resource-bar"><div class="resource-fill cpu" id="stat-cpu-bar" style="width:0%"></div></div><span class="resource-val" id="stat-cpu-val">0%</span></div>
            <div class="resource-row"><span class="resource-label">Memory</span><div class="resource-bar"><div class="resource-fill memory" id="stat-mem-bar" style="width:0%"></div></div><span class="resource-val" id="stat-mem-val">0 MB</span></div>
            <div class="resource-row"><span class="resource-label">PIDs</span><div class="resource-bar"><div class="resource-fill cpu" id="stat-pid-bar" style="width:0%"></div></div><span class="resource-val" id="stat-pid-val">0</span></div>
            <hr class="divider"/>
            <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text2)"><span>↓ RX</span><span class="text-mono" id="stat-rx">0 B</span></div>
            <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text2);margin-top:8px"><span>↑ TX</span><span class="text-mono" id="stat-tx">0 B</span></div>
          </div>
          <div class="card">
            <div class="card-title" style="margin-bottom:8px"><i data-lucide="plug"></i> Ports</div>
            <div class="text-mono text-sm text-accent">${esc(portsHtml)}</div>
          </div>
          <div class="card">
            <div class="card-title" style="margin-bottom:10px"><i data-lucide="settings"></i> Limits</div>
            <div class="text-sm" style="line-height:2">
              <div class="flex" style="justify-content:space-between"><span class="text-muted">CPU</span><span class="text-mono">${server.cpu_limit} ${parseFloat(server.cpu_limit)===1?"Kern":"Kerne"} @ ${server.cpu_percent||100}%</span></div>
              <div class="flex" style="justify-content:space-between"><span class="text-muted">RAM</span><span class="text-mono">${server.memory_limit} MB</span></div>
              <div class="flex" style="justify-content:space-between"><span class="text-muted">Disk</span><span class="text-mono">${server.disk_limit} MB</span></div>
              <div class="flex" style="justify-content:space-between"><span class="text-muted">Node</span><span class="text-mono text-accent">${esc(node.name||'–')}</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div id="detail-stats" class="hidden">
      <div style="display:flex;gap:6px;margin-bottom:16px">
        <button class="tab active" onclick="statsSubTab('live',this)" id="stats-live-btn"><i data-lucide="activity"></i> Live</button>
        <button class="tab" onclick="statsSubTab('history',this)" id="stats-history-btn"><i data-lucide="trending-up"></i> Verlauf</button>
      </div>
      <div id="stats-sub-live">
      <!-- Top KPI row -->
      <div class="stats-kpi-row">
        <div class="kpi-card">
          <div class="kpi-icon" style="background:rgba(0,212,255,.12);color:#00d4ff"><i data-lucide="cpu"></i></div>
          <div class="kpi-body">
            <div class="kpi-label">CPU Auslastung</div>
            <div class="kpi-value" id="sc-cpu">—</div>
            <div class="kpi-bar"><div class="kpi-fill kpi-cpu" id="sc-cpu-bar" style="width:0%"></div></div>
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-icon" style="background:rgba(0,245,160,.12);color:#00f5a0"><i data-lucide="memory-stick"></i></div>
          <div class="kpi-body">
            <div class="kpi-label">Arbeitsspeicher</div>
            <div class="kpi-value" id="sc-mem">—</div>
            <div class="kpi-sub" id="sc-mem-limit"></div>
            <div class="kpi-bar"><div class="kpi-fill kpi-mem" id="sc-mem-bar" style="width:0%"></div></div>
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-icon" style="background:rgba(96,165,250,.12);color:#60a5fa"><i data-lucide="wifi"></i></div>
          <div class="kpi-body">
            <div class="kpi-label">Netzwerk</div>
            <div class="kpi-value" style="font-size:15px"><span style="color:#00d4ff" id="sc-rx">↓ 0 B</span></div>
            <div class="kpi-value" style="font-size:15px"><span style="color:#f59e0b" id="sc-tx">↑ 0 B</span></div>
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-icon" style="background:rgba(167,139,250,.12);color:#a78bfa"><i data-lucide="hard-drive"></i></div>
          <div class="kpi-body">
            <div class="kpi-label">Prozesse</div>
            <div class="kpi-value" id="sc-pids">—</div>
          </div>
        </div>
      </div>

      <!-- Charts row 1 -->
      <div class="stats-chart-row">
        <div class="card stats-chart-card">
          <div class="stats-chart-header">
            <span class="stats-chart-title"><i data-lucide="cpu"></i> CPU</span>
            <span class="stats-chart-badge" id="chart-cpu-cur">0%</span>
          </div>
          <div class="chart-container"><canvas id="cpu-chart"></canvas></div>
        </div>
        <div class="card stats-chart-card">
          <div class="stats-chart-header">
            <span class="stats-chart-title"><i data-lucide="memory-stick"></i> Memory</span>
            <span class="stats-chart-badge" id="chart-mem-cur">0 MB</span>
          </div>
          <div class="chart-container"><canvas id="mem-chart"></canvas></div>
        </div>
      </div>

      <!-- Charts row 2 -->
      <div class="stats-chart-row" style="margin-top:12px">
        <div class="card stats-chart-card" style="flex:2">
          <div class="stats-chart-header">
            <span class="stats-chart-title"><i data-lucide="wifi"></i> Netzwerk I/O</span>
            <div style="display:flex;gap:12px">
              <span style="color:#00d4ff;font-size:11px">■ RX</span>
              <span style="color:#f59e0b;font-size:11px">■ TX</span>
            </div>
          </div>
          <div class="chart-container"><canvas id="net-chart"></canvas></div>
        </div>
        <div class="card" style="flex:1;min-width:200px">
          <div id="disk-gauge-wrap" style="margin-bottom:16px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <span class="stats-chart-title"><i data-lucide="hard-drive"></i> Disk</span>
              <button class="btn btn-ghost btn-xs" onclick="refreshDiskUsage()" title="Aktualisieren"><i data-lucide="rotate-ccw"></i></button>
            </div>
            <div class="disk-gauge-track">
              <div class="disk-gauge-fill" id="disk-gauge-fill" style="width:0%"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:11px;color:var(--text3)">
              <span id="disk-used-label">— MB</span>
              <span id="disk-pct-label">0%</span>
              <span id="disk-limit-label">— MB</span>
            </div>
            <div id="disk-alert-msg" class="hidden" style="font-size:11px;margin-top:6px;padding:6px 8px;border-radius:5px"></div>
          </div>
          <div class="stats-chart-title" style="margin-bottom:14px"><i data-lucide="sliders"></i> Limits</div>
          <div class="limits-table">
            <div class="limits-row"><span>CPU</span><span class="text-mono text-accent" id="limit-cpu">—</span></div>
            <div class="limits-row"><span>RAM</span><span class="text-mono" id="limit-ram">—</span></div>
            <div class="limits-row"><span>Disk</span><span class="text-mono" id="limit-disk">—</span></div>
            <div class="limits-row"><span>Node</span><span class="text-mono text-accent" id="limit-node">—</span></div>
            <div class="limits-row"><span>Status</span><span class="text-mono text-success" id="stat2-status">—</span></div>
          </div>
          <hr class="divider" style="margin:12px 0"/>
          <div class="limits-table">
            <div class="limits-row"><span>↓ Gesamt RX</span><span class="text-mono" id="stat2-rx">0 B</span></div>
            <div class="limits-row"><span>↑ Gesamt TX</span><span class="text-mono" id="stat2-tx">0 B</span></div>
          </div>
        </div>
      </div>
    </div>
      </div><!-- /stats-sub-live -->
      <div id="stats-sub-history" class="hidden">
        <div class="card" style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
            <div class="card-title"><i data-lucide="trending-up"></i> Ressourcen-Verlauf</div>
            <div style="display:flex;gap:8px;align-items:center">
              <select id="history-range" class="form-input" style="width:auto;padding:6px 10px" onchange="loadStatsHistory()">
                <option value="1">Letzte Stunde</option>
                <option value="6">Letzte 6 Stunden</option>
                <option value="24" selected>Letzte 24 Stunden</option>
                <option value="72">Letzte 3 Tage</option>
                <option value="168">Letzte 7 Tage</option>
              </select>
              <button class="btn btn-ghost btn-sm" onclick="loadStatsHistory()"><i data-lucide="rotate-ccw"></i></button>
            </div>
          </div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="stats-chart-title" style="margin-bottom:8px">CPU %</div>
          <div style="height:160px"><canvas id="history-cpu-chart"></canvas></div>
        </div>
        <div class="grid grid-2" style="gap:12px">
          <div class="card">
            <div class="stats-chart-title" style="margin-bottom:8px">RAM (MB)</div>
            <div style="height:140px"><canvas id="history-mem-chart"></canvas></div>
          </div>
          <div class="card">
            <div class="stats-chart-title" style="margin-bottom:8px">Netzwerk I/O</div>
            <div style="height:140px"><canvas id="history-net-chart"></canvas></div>
          </div>
        </div>
        <div class="text-dim text-sm" style="margin-top:10px;text-align:right" id="history-meta"></div>
      </div><!-- /stats-sub-history -->
    </div><!-- /detail-stats -->

    <div id="detail-files" class="hidden">
      <div class="card">
        <div class="fm-toolbar">
          <button class="btn btn-ghost btn-sm" id="fm-up-btn" onclick="fmNavigateUp()">↑ Rauf</button>
          <div class="fm-path" id="fm-path">/home/container</div>
          <button class="btn btn-ghost btn-sm" onclick="fmRefresh()"><i data-lucide="rotate-ccw"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="fmCreateFile()"><i data-lucide="plus"></i> Datei</button>
          <button class="btn btn-ghost btn-sm" onclick="fmCreateDir()"><i data-lucide="folder-plus"></i> Ordner</button>
        </div>
        <div id="fm-content"><div class="empty" style="padding:40px"><div class="empty-icon spin"><i data-lucide="folder"></i></div><p>Lade Dateien...</p></div></div>
      </div>
    </div>

    <div id="detail-mods" class="hidden">
      <!-- Platform badge + installed list rendered dynamically -->
      <div id="mods-root"><div class="empty"><div class="empty-icon spin"><i data-lucide="puzzle"></i></div><p>Lade Mod-Manager...</p></div></div>
    </div>

    <div id="detail-schedule" class="hidden">
      <div id="schedule-root"><div class="empty"><div class="empty-icon"><i data-lucide="loader-2" class="spin"></i></div><p>Lade Tasks…</p></div></div>
    </div>

    <div id="detail-users" class="hidden">
      <div id="users-root"><div class="empty"><div class="empty-icon spin"><i data-lucide="users"></i></div><p>Lade Benutzer...</p></div></div>
    </div>

    <div id="detail-activity" class="hidden">
      <div id="activity-root"><div class="empty"><div class="empty-icon spin"><i data-lucide="clipboard-list"></i></div><p>Lade Aktivitäten...</p></div></div>
    </div>

    <div id="detail-backups" class="hidden">
      <div id="backups-root"><div class="empty"><div class="empty-icon spin"><i data-lucide="hard-drive"></i></div><p>Lade Backups...</p></div></div>
    </div>

    <div id="detail-sftp" class="hidden">
      <div id="sftp-root"><div class="empty"><div class="empty-icon spin"><i data-lucide="antenna"></i></div><p>Lade SFTP-Info...</p></div></div>
    </div>

    <div id="detail-notify" class="hidden">
      <div id="notify-root"><div class="empty"><div class="empty-icon spin"><i data-lucide="bell"></i></div><p>Lade Einstellungen...</p></div></div>
    </div>

    <div id="detail-maintenance" class="hidden">
      <div id="maintenance-root"></div>
    </div>

    <div id="detail-transfer" class="hidden">
      <div id="transfer-root"></div>
    </div>
    <div id="detail-reinstall" class="hidden">
      <div id="reinstall-root"></div>
    </div>

    <div id="detail-network" class="hidden">
      <div id="network-root"><div class="empty"><div class="empty-icon spin"><i data-lucide="globe"></i></div><p>Lade Ports...</p></div></div>
    </div>

    <div id="detail-info" class="hidden">
      <div id="startup-editor-root"><div class="empty"><div class="empty-icon spin"><i data-lucide="settings"></i></div></div></div>
    </div>`;

  // Logs laden + WS abonnieren
  reloadLogs(id);
  State.serverDetail = id;
  // Polling starten wenn Server in transitionalem Zustand
  if (TRANSITIONAL.has(sc)) startStatusPoll(id); else stopStatusPoll();
  if (window.lucide) setTimeout(() => lucide.createIcons(), 0);
  wsSend({ type: 'subscribe_stats',   server_id: id });
  wsSend({ type: 'console.subscribe', server_id: id });
}

function detailTab(tab, btn) {
  document.querySelectorAll('#detail-tabs .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  // Scroll active tab into view
  btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  ['console','stats','files','mods','info','network','schedule','users','activity','backups','sftp','notify','maintenance','transfer','reinstall'].forEach(x => document.getElementById('detail-'+x)?.classList.toggle('hidden', x!==tab));
  if (tab === 'files' && State.serverDetail) {
    const _srv = State.server || {};
    const _itzg = (_srv.image||'').includes('itzg') || (_srv.image||'').includes('minecraft-server');
    State.fmPath = _itzg ? '/data' : '/home/container';
    fmLoad(State.serverDetail, State.fmPath);
  }
  if (tab === 'stats') { initCharts(); if (State.serverDetail) refreshDiskUsage(State.serverDetail); }
  if (tab === 'mods' && State.serverDetail) { modsInit(State.serverDetail); }
  if (tab === 'network' && State.serverDetail) { networkInit(State.serverDetail); }
  if (tab === 'info'    && State.serverDetail) { startupEditorInit(State.serverDetail); }
  if (tab === 'schedule' && State.serverDetail) { scheduleInit(State.serverDetail); }
  if (tab === 'users' && State.serverDetail) { subusersInit(State.serverDetail); }
  if (tab === 'activity' && State.serverDetail) { activityInit(State.serverDetail); }
  if (tab === 'backups' && State.serverDetail) { backupsInit(State.serverDetail); }
  if (tab === 'console' && State.serverDetail) { aliasesInit(State.serverDetail).catch(()=>{}); }
  if (tab === 'sftp'        && State.serverDetail) { sftpTabInit(State.serverDetail); }
  if (tab === 'notify'      && State.serverDetail) { notifyInit(State.serverDetail); }
  if (tab === 'maintenance' && State.serverDetail) { maintenanceInit(State.serverDetail); }
  if (tab === 'transfer'    && State.serverDetail) { transferInit(State.serverDetail); }
  if (tab === 'reinstall'   && State.serverDetail) { reinstallInit(State.serverDetail); }
  if (tab === 'console'     && State.serverDetail) {
    _histLoaded = false; _cmdHistory = []; _histIdx = 0; _consoleBuffer = []; _consoleFilter = '';
    const cf = document.getElementById('console-filter-input'); if(cf) cf.value='';
    loadConsoleHistory(State.serverDetail);
  }
}

async function reloadLogs(id) {
  try {
    const d = await API.get(`/servers/${id}/logs`);
    const out = document.getElementById('console-output');
    if (!out) return;
    out.innerHTML = '';
    (d.logs||'').split('\n').filter(Boolean).forEach(line => appendConsoleLine(line));
    out.scrollTop = out.scrollHeight;
  } catch {}
}


// ─── CHARTS ─────────────────────────────────────────────────────────────────
let cpuChart = null, memChart = null, netChart = null;
const chartHistory = { cpu: [], mem: [], rxPrev: 0, txPrev: 0, netRx: [], netTx: [], labels: [] };
const MAX_POINTS = 60;

function initCharts() {
  if (!window.Chart) return;
  const chartDefaults = {
    responsive: true, maintainAspectRatio: false,
    animation: { duration: 0 },
    plugins: { legend: { display: false } },
    scales: {
      x: { display: false },
      y: { min: 0, grid: { color: 'rgba(30,45,74,.5)' }, ticks: { color: '#8fa3c8', font: { family: 'JetBrains Mono', size: 10 } } }
    },
  };
  // CPU Chart
  const cpuCtx = document.getElementById('cpu-chart')?.getContext('2d');
  if (cpuCtx) {
    if (cpuChart) cpuChart.destroy();
    cpuChart = new Chart(cpuCtx, {
      type: 'line',
      data: { labels: chartHistory.labels, datasets: [{ data: chartHistory.cpu, borderColor: '#00d4ff', backgroundColor: 'rgba(0,212,255,.1)', borderWidth: 2, fill: true, tension: .3, pointRadius: 0 }] },
      options: { ...chartDefaults, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, max: 100, ticks: { ...chartDefaults.scales.y.ticks, callback: v => v + '%' } } } }
    });
  }
  // Mem Chart
  const memCtx = document.getElementById('mem-chart')?.getContext('2d');
  if (memCtx) {
    if (memChart) memChart.destroy();
    memChart = new Chart(memCtx, {
      type: 'line',
      data: { labels: chartHistory.labels, datasets: [{ data: chartHistory.mem, borderColor: '#00f5a0', backgroundColor: 'rgba(0,245,160,.1)', borderWidth: 2, fill: true, tension: .3, pointRadius: 0 }] },
      options: { ...chartDefaults, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, ticks: { ...chartDefaults.scales.y.ticks, callback: v => fmtBytes(v * 1024 * 1024) } } } }
    });
  }
  // Net Chart
  const netCtx = document.getElementById('net-chart')?.getContext('2d');
  if (netCtx) {
    if (netChart) netChart.destroy();
    netChart = new Chart(netCtx, {
      type: 'line',
      data: { labels: chartHistory.labels, datasets: [
        { label: 'RX', data: chartHistory.netRx, borderColor: '#00d4ff', backgroundColor: 'rgba(0,212,255,.08)', borderWidth: 2, fill: true, tension: .3, pointRadius: 0 },
        { label: 'TX', data: chartHistory.netTx, borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,.08)', borderWidth: 2, fill: true, tension: .3, pointRadius: 0 },
      ] },
      options: { ...chartDefaults, plugins: { legend: { display: true, labels: { color: '#8fa3c8', font: { size: 11 }, usePointStyle: true } } }, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, ticks: { ...chartDefaults.scales.y.ticks, callback: v => fmtBytes(v) } } } }
    });
  }
}

function pushChartData(cpu, memMb, netRxDelta, netTxDelta) {
  const now = new Date().toLocaleTimeString('de', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  if (chartHistory.labels.length >= MAX_POINTS) {
    chartHistory.labels.shift(); chartHistory.cpu.shift(); chartHistory.mem.shift();
    chartHistory.netRx.shift(); chartHistory.netTx.shift();
  }
  chartHistory.labels.push(now); chartHistory.cpu.push(Math.round(cpu*10)/10);
  chartHistory.mem.push(Math.round(memMb)); chartHistory.netRx.push(netRxDelta); chartHistory.netTx.push(netTxDelta);
  if (cpuChart) cpuChart.update('none');
  if (memChart) memChart.update('none');
  if (netChart) netChart.update('none');
  // Update current value labels
  const cc = document.getElementById('chart-cpu-cur'); if (cc) cc.textContent = cpu.toFixed(1)+'%';
  const mc = document.getElementById('chart-mem-cur'); if (mc) mc.textContent = fmtBytes(memMb * 1024 * 1024);
  // Update KPI cards
  const scCpu = document.getElementById('sc-cpu'); if (scCpu) scCpu.textContent = cpu.toFixed(1)+'%';
  const scCpuBar = document.getElementById('sc-cpu-bar'); if (scCpuBar) { scCpuBar.style.width=Math.min(cpu,100)+'%'; scCpuBar.className='kpi-fill kpi-cpu'+(cpu>80?' danger':''); }
  const scMem = document.getElementById('sc-mem'); if (scMem) scMem.textContent = fmtBytes(memMb*1024*1024);
  const scMemSub = document.getElementById('sc-mem-limit'); if (scMemSub&&chartHistory._memLimit) scMemSub.textContent = 'von '+fmtBytes(chartHistory._memLimit*1024*1024);
  const scMemBar = document.getElementById('sc-mem-bar'); if (scMemBar) { const p=memMb>0&&chartHistory._memLimit>0?Math.min(100,memMb/chartHistory._memLimit*100):0; scMemBar.style.width=p+'%'; }
}

function handleWsStats(msg) {
  if (msg.server_id !== State.serverDetail) return;
  const d = msg.data;
  // ── Sidebar stats bar ────────────────────────────────────────────────────────
  const cpuEl = document.getElementById('stat-cpu-val'), cpuBar = document.getElementById('stat-cpu-bar');
  const memEl = document.getElementById('stat-mem-val'), memBar = document.getElementById('stat-mem-bar');
  const pidEl = document.getElementById('stat-pid-val'), pidBar = document.getElementById('stat-pid-bar');
  const rxEl = document.getElementById('stat-rx'), txEl = document.getElementById('stat-tx');
  const cpu = Math.min(d.cpu||0, 100);
  if (cpuEl) { cpuEl.textContent = cpu.toFixed(1)+'%'; cpuBar.style.width = cpu+'%'; cpuBar.className = 'resource-fill '+(cpu>80?'danger':'cpu'); }
  const memMb = d.memory_limit > 0 ? d.memory / 1024 / 1024 : 0;
  const memLimitMb = (d.memory_limit || 0) / 1024 / 1024;
  chartHistory._memLimit = memLimitMb || 512;
  if (memEl && d.memory_limit > 0) {
    const pct = (d.memory / d.memory_limit * 100);
    memEl.textContent = fmtBytes(d.memory)+' / '+fmtBytes(d.memory_limit);
    memBar.style.width = Math.min(pct,100)+'%'; memBar.className = 'resource-fill '+(pct>80?'danger':'memory');
  }
  if (pidEl && d.pids !== undefined) { pidEl.textContent = d.pids; pidBar.style.width = Math.min(d.pids/256*100,100)+'%'; }
  if (rxEl) rxEl.textContent = fmtBytes(d.network_rx);
  if (txEl) txEl.textContent = fmtBytes(d.network_tx);
  // ── Stats tab extended ─────────────────────────────────────────────────────
  const s2cpu = document.getElementById('stat2-cpu-val'); if(s2cpu){s2cpu.textContent=cpu.toFixed(1)+'%';document.getElementById('stat2-cpu-bar').style.width=cpu+'%';}
  const s2mem = document.getElementById('stat2-mem-val'); if(s2mem && d.memory_limit>0){s2mem.textContent=fmtBytes(d.memory)+' / '+fmtBytes(d.memory_limit);const p=(d.memory/d.memory_limit*100);document.getElementById('stat2-mem-bar').style.width=Math.min(p,100)+'%';}
  const s2rx = document.getElementById('stat2-rx'); if(s2rx) s2rx.textContent=fmtBytes(d.network_rx);
  const s2tx = document.getElementById('stat2-tx'); if(s2tx) s2tx.textContent=fmtBytes(d.network_tx);
  // KPI card updates
  const scRx = document.getElementById('sc-rx'); if(scRx) scRx.textContent='↓ '+fmtBytes(d.network_rx||0);
  const scTx = document.getElementById('sc-tx'); if(scTx) scTx.textContent='↑ '+fmtBytes(d.network_tx||0);
  const scPids = document.getElementById('sc-pids'); if(scPids) scPids.textContent=(d.pids||0)+'';
  const s2p = document.getElementById('stat2-pids'); if(s2p) s2p.textContent=d.pids||'0';
  const s2s = document.getElementById('stat2-status'); if(s2s) s2s.textContent=d.status||'running';
  // ── Chart data ─────────────────────────────────────────────────────────────
  const rxDelta = Math.max(0, (d.network_rx||0) - chartHistory.rxPrev);
  const txDelta = Math.max(0, (d.network_tx||0) - chartHistory.txPrev);
  chartHistory.rxPrev = d.network_rx||0; chartHistory.txPrev = d.network_tx||0;
  pushChartData(cpu, memMb, rxDelta, txDelta);
}
function handleWsConsole(msg) { if (msg.server_id === State.serverDetail) appendConsoleLine(msg.data); }

// ─── ANSI → HTML ──────────────────────────────────────────────────────────────
const _ansiColorMap = {
  '30':'#4d6490','31':'#ff6b8a','32':'#00f5a0','33':'#f59e0b',
  '34':'#60a5fa','35':'#a78bfa','36':'#00d4ff','37':'#e8edf5',
  '90':'#64748b','91':'#ff4757','92':'#00e676','93':'#ffd740',
  '94':'#448aff','95':'#e040fb','96':'#18ffff','97':'#ffffff',
};
function ansiToHtml(raw) {
  let s = raw.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /, '');
  s = s.replace(/\r/g, '');
  let out = '', i = 0, openSpans = 0;
  while (i < s.length) {
    if (s[i] === '\x1b' && s[i+1] === '[') {
      const end = s.indexOf('m', i+2);
      if (end === -1) { i++; continue; }
      const codes = s.slice(i+2, end).split(';');
      i = end + 1;
      while (openSpans > 0) { out += '</span>'; openSpans--; }
      for (const code of codes) {
        if (code === '0' || code === '') continue;
        if (code === '1') { out += '<span style="font-weight:bold">'; openSpans++; }
        else if (_ansiColorMap[code]) { out += `<span style="color:${_ansiColorMap[code]}"`; out += '>'; openSpans++; }
      }
    } else {
      out += s[i] === '<' ? '&lt;' : s[i] === '>' ? '&gt;' : s[i] === '&' ? '&amp;' : s[i];
      i++;
    }
  }
  while (openSpans > 0) { out += '</span>'; openSpans--; }
  return out;
}
function lineClass(t) {
  if (/error|exception|fatal/.test(t)) return 'error';
  if (/warn|warning/.test(t)) return 'warn';
  if (/done|success|started|enabled|loaded/.test(t)) return 'ok';
  if (/\[init\]|\[mc-image/.test(t)) return 'sys';
  return '';
}
function _renderLine(raw) {
  const plain = raw.replace(/\x1b\[[0-9;]*[mGKHF]/g,'').toLowerCase();
  return `<div class="line ${lineClass(plain)}">${ansiToHtml(raw)}</div>`;
}
function _matchesFilter(raw) {
  if (!_consoleFilter) return true;
  const plain = raw.replace(/\x1b\[[0-9;]*[mGKHF]/g,'').replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /,'');
  try { return new RegExp(_consoleFilter,'i').test(plain); } catch { return plain.toLowerCase().includes(_consoleFilter.toLowerCase()); }
}

function appendConsoleLine(data) {
  if (!data) return;
  const lines = data.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw) continue;
    _consoleBuffer.push(raw);
    if (_consoleBuffer.length > MAX_CONSOLE_LINES) _consoleBuffer.shift();
  }
  if (_consolePaused) return;
  const el = document.getElementById('console-output');
  if (!el) return;
  for (const raw of lines) {
    if (raw && _matchesFilter(raw)) el.insertAdjacentHTML('beforeend', _renderLine(raw));
  }
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 80) el.scrollTop = el.scrollHeight;
}
function toggleConsolePause() {
  _consolePaused = !_consolePaused;
  const btn = document.getElementById('console-pause-btn');
  if (btn) btn.textContent = _consolePaused ? '<i data-lucide="play"></i> Fortsetzen' : '<i data-lucide="pause"></i> Pause';
  if (!_consolePaused) applyConsoleFilter(_consoleFilter);
}
function applyConsoleFilter(val) {
  _consoleFilter = val.trim();
  const el = document.getElementById('console-output');
  if (!el) return;
  el.innerHTML = _consoleBuffer.filter(_matchesFilter).map(_renderLine).join('');
  const hint = document.getElementById('console-filter-hint');
  if (hint) hint.textContent = _consoleFilter ? el.querySelectorAll('.line').length + ' Treffer' : '';
  el.scrollTop = el.scrollHeight;
}
function downloadConsoleLogs() {
  const blob = new Blob([_consoleBuffer.map(l=>l.replace(/\x1b\[[0-9;]*[mGKHF]/g,'')).join('\n')],{type:'text/plain'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`console-${State.serverDetail||'log'}-${Date.now()}.log`; a.click(); URL.revokeObjectURL(a.href);
}
function clearConsole() { _consoleBuffer=[]; const el=document.getElementById('console-output'); if(el) el.innerHTML=''; }

// ══════════════════════════════════════════════════════════════════════════════
// SERVER REINSTALL
// ══════════════════════════════════════════════════════════════════════════════
async function reinstallInit(serverId) {
  const root = document.getElementById('reinstall-root');
  root.innerHTML = `<div class="empty"><div class="empty-icon spin"><i data-lucide="loader"></i></div></div>`;
  const srv = await API.get(`/servers/${serverId}`).catch(()=>null);
  if (!srv) { root.innerHTML=`<div class="empty"><p class="text-danger">Fehler</p></div>`; return; }
  const eggs = await API.get('/eggs').catch(()=>[]);
  root.innerHTML = `
    <div style="max-width:640px">
      <div class="card" style="border-left:4px solid #f59e0b;margin-bottom:12px">
        <div class="card-title" style="margin-bottom:4px"><i data-lucide="refresh-cw"></i> Server Reinstall</div>
        <p class="text-dim text-sm" style="margin-bottom:18px">Setzt den Container komplett neu auf. Standardmäßig werden deine Daten dabei gesichert und wiederhergestellt.</p>
        <div class="form-group">
          <label class="form-label">Image</label>
          <input id="ri-image" class="form-input" value="${esc(srv.image)}" placeholder="docker/image:tag"/>
          ${eggs.length?`<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${eggs.slice(0,8).map(e=>`<button class="btn btn-ghost btn-xs" onclick="document.getElementById('ri-image').value='${esc(e.docker_image)}'">${esc(e.name)}</button>`).join('')}</div>`:''}
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
            <input type="checkbox" id="ri-keepdata" checked style="accent-color:var(--accent);width:16px;height:16px"/>
            <div><div style="font-weight:500">Daten beibehalten</div><div class="text-dim text-sm">Erstellt ein Backup und stellt es danach wieder her</div></div>
          </label>
        </div>
        <div class="card" style="background:rgba(245,158,11,.07);border-color:rgba(245,158,11,.3);margin-bottom:16px">
          <div style="display:flex;gap:10px;font-size:12px;color:var(--text2)"><i data-lucide="alert-triangle"></i> <div>Der Server wird gestoppt. Ohne "Daten beibehalten" gehen alle Dateien <b>unwiederbringlich verloren</b>.</div></div>
        </div>
        <button class="btn btn-primary" style="background:#f59e0b;border-color:#f59e0b;color:#000" onclick="startReinstall('${serverId}')"><i data-lucide="refresh-cw"></i> Reinstall starten</button>
      </div>
    </div>`;
}
async function startReinstall(serverId) {
  const image=document.getElementById('ri-image')?.value?.trim();
  const keepData=document.getElementById('ri-keepdata')?.checked;
  if (!image) return toast('Image angeben','warn');
  if (!confirm(`Reinstall${keepData?'':' (Daten werden GELÖSCHT)'}?`)) return;
  const btn=document.querySelector('#reinstall-root .btn-primary');
  if (btn){btn.disabled=true;btn.textContent=' Läuft…';}
  try {
    const r=await API.post(`/servers/${serverId}/reinstall`,{image,keep_data:keepData});
    toast(`Reinstall abgeschlossen`,'success'); reinstallInit(serverId);
  } catch(e){toast('Fehler: '+e.message,'error'); if(btn){btn.disabled=false;btn.innerHTML='<i data-lucide="refresh-cw"></i> Reinstall starten';}}
}

// ══════════════════════════════════════════════════════════════════════════════
// DOCKER COMPOSE IMPORT
// ══════════════════════════════════════════════════════════════════════════════
function showComposeImport() {
  showModal(`
    <div class="modal-title"><span><i data-lucide="layers"></i> Docker Compose Import</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <p class="text-dim text-sm" style="margin-bottom:12px">Füge deine <code>docker-compose.yml</code> ein. Jeder Service wird als separater Server angelegt.</p>
    <div class="form-group"><label class="form-label">Name-Präfix (optional)</label><input id="compose-prefix" class="form-input" placeholder="z.B. myproject"/></div>
    <div class="form-group"><label class="form-label">docker-compose.yml</label>
      <textarea id="compose-yaml" class="form-input" rows="10" style="font-family:var(--mono);font-size:12px;resize:vertical" placeholder="version: '3'\nservices:\n  web:\n    image: nginx:latest\n    ports:\n      - '80:80'"></textarea>
    </div>
    <div id="compose-preview" style="margin-bottom:8px"></div>
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="previewCompose()"><i data-lucide="eye"></i> Vorschau</button>
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitComposeImport()"><i data-lucide="download"></i> Importieren</button>
    </div>`, true);
}
async function previewCompose() {
  const yaml=document.getElementById('compose-yaml')?.value;
  if(!yaml?.trim()) return;
  try {
    const r=await API.post('/compose/preview',{yaml});
    const prev=document.getElementById('compose-preview');
    if(!prev) return;
    prev.innerHTML=`<div class="card" style="background:var(--bg3)"><div style="font-size:12px;font-weight:600;margin-bottom:8px">${r.count} Service(s) erkannt:</div>${Object.entries(r.services).map(([name,s])=>`<div style="display:flex;gap:8px;padding:6px 0;border-top:1px solid var(--border)"><div style="font-weight:600;min-width:100px;font-size:12px">${esc(name)}</div><div style="font-size:11px;color:var(--text2)"><div>${esc(s.image||'kein image')}</div>${s.ports.length?`<div>Ports: ${s.ports.map(p=>p.host+':'+p.container).join(', ')}</div>`:''}</div></div>`).join('')}</div>`;
  } catch(e){mErr(e.message);}
}
async function submitComposeImport() {
  const yaml=document.getElementById('compose-yaml')?.value;
  const prefix=document.getElementById('compose-prefix')?.value?.trim();
  if(!yaml?.trim()) return mErr('Kein YAML eingegeben');
  try {
    const r=await API.post('/compose/import',{yaml,name_prefix:prefix});
    const ok=r.results.filter(x=>x.success),err=r.results.filter(x=>!x.success);
    toast(`${ok.length} Server erstellt${err.length?', '+err.length+' Fehler':''}`, err.length?'warn':'success');
    closeModal(); if(State.currentPage==='servers') loadServers();
  } catch(e){mErr(e.message);}
}

// ══════════════════════════════════════════════════════════════════════════════
// SUSPENSION SCREEN
// ══════════════════════════════════════════════════════════════════════════════
function showSuspensionScreen(reason) {
  document.getElementById('app').classList.add('hidden');
  const as = document.getElementById('auth-screen');
  as.classList.remove('hidden');
  as.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:var(--bg);padding:24px"><div style="max-width:480px;width:100%;text-align:center"><div style="font-size:64px;margin-bottom:16px"><i data-lucide="ban"></i></div><h2 style="font-size:22px;font-weight:700;margin-bottom:8px;color:var(--danger)">Account gesperrt</h2><div class="card" style="text-align:left;margin:16px 0"><div class="text-dim text-sm" style="margin-bottom:6px">Begründung:</div><div style="font-size:14px">${esc(reason||'Dein Account wurde vom Administrator gesperrt.')}</div></div><p class="text-dim text-sm">Wende dich an den Administrator falls du glaubst, dass dies ein Fehler ist.</p><button class="btn btn-ghost" style="margin-top:16px" onclick="logout()">Abmelden</button></div></div>`;
}


// ══════════════════════════════════════════════════════════════════════════════
// SESSION-MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════
async function loadSessions() {
  document.getElementById('page-actions').innerHTML =
    `<button class="btn btn-danger btn-sm" onclick="revokeAllSessions()"><i data-lucide="log-out"></i> Alle anderen beenden</button>`;
  try {
    const sessions = await API.get('/account/sessions');
    if (!sessions.length) {
      document.getElementById('page-content').innerHTML = `<div class="empty"><div class="empty-icon"><i data-lucide="shield"></i></div><p>Keine aktiven Sessions</p></div>`;
      return;
    }
    document.getElementById('page-content').innerHTML = `
      <div style="max-width:760px">
        <p class="text-dim text-sm" style="margin-bottom:16px">Alle aktiven Logins deines Accounts. Grün markiert = aktuelle Session.</p>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${sessions.map(s => `
            <div class="card" style="display:flex;align-items:center;gap:16px;padding:14px 18px;${s.is_current?'border-color:rgba(0,245,160,.4);background:rgba(0,245,160,.04)':''}">
              <div style="font-size:28px">${uaIcon(s.user_agent)}</div>
              <div style="flex:1;min-width:0">
                <div style="font-weight:600;font-size:14px">${esc(uaBrowser(s.user_agent))} ${s.is_current?'<span style="color:#00f5a0;font-size:11px">● Aktuelle Session</span>':''}
                </div>
                <div class="text-dim text-sm" style="margin-top:2px">IP: ${esc(s.ip)} · Erstellt: ${fmtDate(s.created_at)} · Zuletzt: ${fmtDate(s.last_seen)}</div>
                <div class="text-dim" style="font-size:11px;margin-top:2px;opacity:.6">Läuft ab: ${fmtDate(s.expires_at)}</div>
              </div>
              ${!s.is_current ? `<button class="btn btn-danger btn-sm" onclick="revokeSession('${s.id}')">Beenden</button>` : ''}
            </div>`).join('')}
        </div>
      </div>`;
  } catch(e) { document.getElementById('page-content').innerHTML = `<div class="empty"><p class="text-danger">${esc(e.message)}</p></div>`; }
}

function uaIcon(ua='') {
  if (/mobile|android|iphone/i.test(ua)) return '<i data-lucide="smartphone"></i>';
  if (/mac/i.test(ua)) return '<i data-lucide="apple"></i>';
  if (/windows/i.test(ua)) return '<i data-lucide="monitor"></i>';
  if (/linux/i.test(ua)) return '<i data-lucide="terminal"></i>';
  return '<i data-lucide="laptop"></i>';
}
function uaBrowser(ua='') {
  if (/Firefox\/([\d.]+)/.test(ua)) return 'Firefox ' + ua.match(/Firefox\/([\d.]+)/)[1];
  if (/Chrome\/([\d.]+)/.test(ua)) return 'Chrome ' + ua.match(/Chrome\/([\d.]+)/)[1];
  if (/Safari\/([\d.]+)/.test(ua) && !/Chrome/.test(ua)) return 'Safari';
  if (/Edg\/([\d.]+)/.test(ua)) return 'Edge ' + ua.match(/Edg\/([\d.]+)/)[1];
  return ua.substring(0,40) || 'Unbekannt';
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
}
async function revokeSession(id) {
  try { await API.delete(`/account/sessions/${id}`); toast('Session beendet','success'); loadSessions(); }
  catch(e) { toast(e.message,'error'); }
}
async function revokeAllSessions() {
  if (!confirm('Alle anderen Sessions beenden?')) return;
  try { const r = await API.delete('/account/sessions'); toast(`${r.revoked} Session(s) beendet`,'success'); loadSessions(); }
  catch(e) { toast(e.message,'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVER-GRUPPEN
// ══════════════════════════════════════════════════════════════════════════════
async function loadGroups() {
  document.getElementById('page-actions').innerHTML =
    `<button class="btn btn-primary" onclick="showCreateGroup()">＋ Neue Gruppe</button>`;
  try {
    const [groups, servers] = await Promise.all([API.get('/groups'), API.get('/servers')]);
    const unGrouped = servers.filter(s => !groups.some(g => g.servers.some(m => m.id === s.id)));

    document.getElementById('page-content').innerHTML = `
      <div style="max-width:900px">
        ${groups.length===0 ? `<div class="empty" style="margin-bottom:20px"><div class="empty-icon"><i data-lucide="folder-kanban"></i></div><h3>Keine Gruppen</h3><p>Erstelle eine Gruppe um Server zu organisieren</p></div>` : ''}
        <div style="display:flex;flex-direction:column;gap:12px" id="groups-list">
          ${groups.map(g => renderGroupCard(g)).join('')}
        </div>
        ${unGrouped.length ? `
        <div class="card" style="margin-top:16px;opacity:.7">
          <div class="card-title" style="margin-bottom:10px"><i data-lucide="folder"></i> Ohne Gruppe (${unGrouped.length})</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${unGrouped.map(s => `<span class="tag" style="cursor:pointer" onclick="quickAddToGroup('${s.id}','${esc(s.name)}')">${esc(s.name)}</span>`).join('')}
          </div>
        </div>` : ''}
      </div>`;
  } catch(e) { document.getElementById('page-content').innerHTML = `<div class="empty"><p class="text-danger">${esc(e.message)}</p></div>`; }
}

function renderGroupCard(g) {
  return `<div class="card" style="border-left:3px solid ${g.color}">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:22px">${g.icon}</span>
        <div>
          <div style="font-weight:700;font-size:15px">${esc(g.name)}</div>
          <div class="text-dim text-sm">${g.servers.length} Server</div>
        </div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-sm" onclick="showEditGroup('${g.id}','${esc(g.name)}','${g.color}','${g.icon}')"><i data-lucide="pencil"></i></button>
        <button class="btn btn-ghost btn-sm" onclick="showAddServerToGroup('${g.id}')">＋ Server</button>
        <button class="btn btn-danger btn-sm" onclick="deleteGroup('${g.id}')"><i data-lucide="trash-2"></i></button>
      </div>
    </div>
    ${g.servers.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:12px">
      ${g.servers.map(s => `
        <div style="display:flex;align-items:center;gap:6px;background:var(--bg3);padding:4px 10px;border-radius:6px;font-size:13px">
          <span class="status-dot ${s.status||'offline'}" style="width:7px;height:7px;border-radius:50%;background:${s.status==='running'?'#00f5a0':'#64748b'};flex-shrink:0"></span>
          <span style="cursor:pointer" onclick="navigate('server-detail','${s.id}')">${esc(s.name)}</span>
          <button style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:12px;padding:0 2px" onclick="removeFromGroup('${g.id}','${s.id}')"><i data-lucide="x"></i></button>
        </div>`).join('')}
    </div>` : `<div class="text-dim text-sm" style="margin-top:10px">Noch keine Server in dieser Gruppe</div>`}
  </div>`;
}

function showCreateGroup() {
  showModal(`
    <div class="modal-title"><span>Neue Gruppe</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group"><label class="form-label">Name</label><input id="grp-name" class="form-input" placeholder="z.B. Produktion"/></div>
    <div class="form-group"><label class="form-label">Icon</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap" id="grp-icon-pick">
        ${['folder','gamepad-2','globe','zap','flame','shield','rocket','gem','target','settings'].map(nm=>`<span style="font-size:22px;cursor:pointer;padding:4px;border-radius:6px;border:2px solid transparent" onclick="pickIcon(this,'${i}')">${i}</span>`).join('')}
      </div>
      <input id="grp-icon" type="hidden" value="folder"/>
    </div>
    <div class="form-group"><label class="form-label">Farbe</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${['#64748b','#00d4ff','#00f5a0','#f59e0b','#ff4757','#a78bfa','#f472b6','#34d399'].map(c=>`<div style="width:28px;height:28px;border-radius:50%;background:${c};cursor:pointer;border:3px solid transparent" onclick="pickColor(this,'${c}')" data-color="${c}"></div>`).join('')}
      </div>
      <input id="grp-color" type="hidden" value="#64748b"/>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="createGroup()">Erstellen</button>
    </div>`);

}
function pickIcon(el, icon) {
  document.querySelectorAll('#grp-icon-pick span').forEach(s => s.style.border='2px solid transparent');
  el.style.border='2px solid var(--accent)';
  document.getElementById('grp-icon').value = icon;
}
function pickColor(el, color) {
  document.querySelectorAll('[data-color]').forEach(s => s.style.border='3px solid transparent');
  el.style.border='3px solid white';
  document.getElementById('grp-color').value = color;
}
async function createGroup() {
  try {
    await API.post('/groups', { name: document.getElementById('grp-name').value, icon: document.getElementById('grp-icon').value, color: document.getElementById('grp-color').value });
    toast('Gruppe erstellt','success'); closeModal(); loadGroups();
  } catch(e) { toast(e.message,'error'); }
}
async function deleteGroup(id) {
  if (!confirm('Gruppe löschen?')) return;
  try { await API.delete(`/groups/${id}`); toast('Gruppe gelöscht','success'); loadGroups(); }
  catch(e) { toast(e.message,'error'); }
}
async function showAddServerToGroup(groupId) {
  const servers = await API.get('/servers');
  showModal(`
    <div class="modal-title"><span>Server zur Gruppe hinzufügen</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div style="display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto">
      ${servers.map(s=>`<label style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg3);border-radius:6px;cursor:pointer">
        <input type="checkbox" value="${s.id}" style="accent-color:var(--accent)"/>
        <span>${esc(s.name)}</span>
        <span class="text-dim text-sm">(${s.status})</span>
      </label>`).join('')}
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="addServersToGroup('${groupId}')">Hinzufügen</button>
    </div>`);
}
async function addServersToGroup(groupId) {
  const ids = [...document.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value);
  if (!ids.length) return toast('Nichts ausgewählt','warn');
  await API.post(`/groups/${groupId}/servers`, { server_ids: ids });
  toast('Server hinzugefügt','success'); closeModal(); loadGroups();
}
async function removeFromGroup(groupId, serverId) {
  await API.delete(`/groups/${groupId}/servers/${serverId}`);
  toast('Entfernt','success'); loadGroups();
}
async function quickAddToGroup(serverId, serverName) {
  const groups = await API.get('/groups');
  if (!groups.length) return toast('Keine Gruppen vorhanden','warn');
  showModal(`
    <div class="modal-title"><span>"${serverName}" zu Gruppe</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${groups.map(g=>`<button class="btn btn-secondary" onclick="addToGroupQuick('${g.id}','${serverId}')">${g.icon} ${esc(g.name)}</button>`).join('')}
    </div>`);
}
async function addToGroupQuick(groupId, serverId) {
  await API.post(`/groups/${groupId}/servers`, { server_ids: [serverId] });
  toast('Hinzugefügt','success'); closeModal(); loadGroups();
}
function showEditGroup(id, name, color, icon) {
  showModal(`
    <div class="modal-title"><span>Gruppe bearbeiten</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group"><label class="form-label">Name</label><input id="grp-name" class="form-input" value="${esc(name)}"/></div>
    <input id="grp-icon" type="hidden" value="${esc(icon)}"/>
    <input id="grp-color" type="hidden" value="${color}"/>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="editGroup('${id}')">Speichern</button>
    </div>`);
}
async function editGroup(id) {
  try {
    await API.patch(`/groups/${id}`, { name: document.getElementById('grp-name').value, icon: document.getElementById('grp-icon').value, color: document.getElementById('grp-color').value });
    toast('Gespeichert','success'); closeModal(); loadGroups();
  } catch(e) { toast(e.message,'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// WEBHOOKS
// ══════════════════════════════════════════════════════════════════════════════
const WEBHOOK_EVENTS = ['server.start','server.stop','server.crash','backup.done','backup.failed','restore.done','disk.warning','disk.critical','disk.exceeded','transfer.done'];
const WEBHOOK_EVENT_LABELS = {'server.start':'<i data-lucide="play"></i> Server Start','server.stop':'<i data-lucide="square"></i> Server Stop','server.crash':'<i data-lucide="zap"></i> Crash','backup.done':'<i data-lucide="hard-drive"></i> Backup fertig','backup.failed':'<i data-lucide="x-circle"></i> Backup Fehler','restore.done':'<i data-lucide="refresh-cw"></i> Restore fertig','disk.warning':'<i data-lucide="alert-triangle"></i> Disk 75%','disk.critical':'<i data-lucide="alert-octagon"></i> Disk 90%','disk.exceeded':'<i data-lucide="ban"></i> Disk 100%','transfer.done':'<i data-lucide="package"></i> Transfer fertig'};

async function loadWebhooks() {
  document.getElementById('page-actions').innerHTML = `<button class="btn btn-primary" onclick="showCreateWebhook()"><i data-lucide="plus"></i> Webhook erstellen</button>`;
  try {
    const hooks = await API.get('/webhooks');
    if (!hooks.length) {
      document.getElementById('page-content').innerHTML = `<div class="empty"><div class="empty-icon"><i data-lucide="link-2"></i></div><h3>Keine Webhooks</h3><p>Sende Panel-Events an externe URLs</p></div>`;
      return;
    }
    document.getElementById('page-content').innerHTML = `
      <div style="max-width:800px;display:flex;flex-direction:column;gap:10px">
        ${hooks.map(h => `
          <div class="card" style="border-left:3px solid ${h.enabled?'#00f5a0':'#64748b'}">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
              <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                  <span style="font-weight:700">${esc(h.name)}</span>
                  <span class="chip ${h.enabled?'chip-running':'chip-offline'}" style="font-size:10px">${h.enabled?'Aktiv':'Deaktiviert'}</span>
                </div>
                <div class="text-mono text-sm text-dim" style="word-break:break-all">${esc(h.url)}</div>
                <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px">
                  ${h.events.map(e=>`<span class="tag" style="font-size:11px">${WEBHOOK_EVENT_LABELS[e]||e}</span>`).join('')}
                  ${!h.events.length?'<span class="text-dim text-sm">Keine Events gewählt</span>':''}
                </div>
                ${h.last_fired?`<div class="text-dim" style="font-size:11px;margin-top:6px">Zuletzt: ${fmtDate(h.last_fired)} · Status: <span style="color:${h.last_status>=200&&h.last_status<300?'#00f5a0':'#ff4757'}">${h.last_status||'—'}</span></div>`:''}
              </div>
              <div style="display:flex;gap:6px">
                <button class="btn btn-ghost btn-sm" onclick="testWebhook('${h.id}')"><i data-lucide="flask-conical"></i> Test</button>
                <button class="btn btn-ghost btn-sm" onclick="toggleWebhook('${h.id}',${h.enabled})">${h.enabled?'<i data-lucide="pause"></i>':'<i data-lucide="play"></i>'}</button>
                <button class="btn btn-danger btn-sm" onclick="deleteWebhook('${h.id}')"><i data-lucide="trash-2"></i></button>
              </div>
            </div>
          </div>`).join('')}
      </div>`;
  } catch(e) { document.getElementById('page-content').innerHTML=`<div class="empty"><p class="text-danger">${esc(e.message)}</p></div>`; }
}

function showCreateWebhook() {
  showModal(`
    <div class="modal-title"><span>Webhook erstellen</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group"><label class="form-label">Name</label><input id="wh-name" class="form-input" placeholder="Mein Discord Bot"/></div>
    <div class="form-group"><label class="form-label">URL</label><input id="wh-url" class="form-input" placeholder="https://..."/></div>
    <div class="form-group"><label class="form-label">Secret (optional, für HMAC-Signatur)</label><input id="wh-secret" class="form-input" placeholder="Geheimschlüssel"/></div>
    <div class="form-group"><label class="form-label">Events</label>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${WEBHOOK_EVENTS.map(e=>`<label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;background:var(--bg3);padding:4px 8px;border-radius:6px">
          <input type="checkbox" value="${e}" class="wh-ev" style="accent-color:var(--accent)"/>${WEBHOOK_EVENT_LABELS[e]||e}</label>`).join('')}
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="createWebhook()">Erstellen</button>
    </div>`);
}
async function createWebhook() {
  const events = [...document.querySelectorAll('.wh-ev:checked')].map(c=>c.value);
  try {
    await API.post('/webhooks', { name:document.getElementById('wh-name').value, url:document.getElementById('wh-url').value, secret:document.getElementById('wh-secret').value, events });
    toast('Webhook erstellt','success'); closeModal(); loadWebhooks();
  } catch(e) { toast(e.message,'error'); }
}
async function testWebhook(id) {
  try { const r = await API.post(`/webhooks/${id}/test`,{}); toast(`Test: HTTP ${r.status}`,'success'); }
  catch(e) { toast('Fehler: '+e.message,'error'); }
}
async function toggleWebhook(id, enabled) {
  try { await API.patch(`/webhooks/${id}`,{enabled:!enabled}); loadWebhooks(); }
  catch(e) { toast(e.message,'error'); }
}
async function deleteWebhook(id) {
  if (!confirm('Webhook löschen?')) return;
  try { await API.delete(`/webhooks/${id}`); toast('Gelöscht','success'); loadWebhooks(); }
  catch(e) { toast(e.message,'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAINTENANCE-MODUS
// ══════════════════════════════════════════════════════════════════════════════
async function maintenanceInit(serverId) {
  const root = document.getElementById('maintenance-root');
  root.innerHTML = `<div class="empty"><div class="empty-icon spin"><i data-lucide="loader"></i></div></div>`;
  try {
    const m = await API.get(`/servers/${serverId}/maintenance`);
    root.innerHTML = `
      <div style="max-width:600px">
        <div class="card" style="border-left:4px solid ${m.enabled?'#f59e0b':'#64748b'}">
          <div class="card-title" style="margin-bottom:16px"><i data-lucide="wrench"></i> Maintenance-Modus</div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div>
              <div style="font-weight:600">Status</div>
              <div class="text-dim text-sm">${m.enabled?`Aktiv seit ${fmtDate(m.started_at)}`:'Deaktiviert'}</div>
            </div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <span class="text-dim text-sm">${m.enabled?'Aktiv':'Aus'}</span>
              <div class="toggle-wrap" onclick="toggleMaintenance('${serverId}',${m.enabled})" style="width:44px;height:24px;background:${m.enabled?'#f59e0b':'var(--bg3)'};border-radius:12px;position:relative;cursor:pointer;transition:.2s">
                <div style="position:absolute;top:3px;left:${m.enabled?'23px':'3px'};width:18px;height:18px;background:#fff;border-radius:50%;transition:.2s"></div>
              </div>
            </label>
          </div>
          <div class="form-group">
            <label class="form-label">Wartungs-Nachricht (wird Benutzern angezeigt)</label>
            <textarea id="maint-msg" class="form-input" rows="3" style="resize:vertical">${esc(m.message)}</textarea>
          </div>
          <button class="btn btn-primary" onclick="saveMaintenance('${serverId}',${m.enabled})">Speichern</button>
        </div>
        <div class="card" style="margin-top:12px">
          <div class="card-title" style="margin-bottom:10px">ℹ️ Was passiert im Maintenance-Modus?</div>
          <ul style="color:var(--text2);font-size:13px;line-height:1.8;padding-left:18px">
            <li>Sub-User sehen eine Wartungsseite statt der Konsole</li>
            <li>API-Requests von Sub-Usern werden mit HTTP 503 abgelehnt</li>
            <li>Admins und der Server-Owner sind nicht betroffen</li>
            <li>Laufende Prozesse werden <b>nicht</b> gestoppt</li>
          </ul>
        </div>
      </div>`;
  } catch(e) { root.innerHTML=`<div class="empty"><p class="text-danger">${esc(e.message)}</p></div>`; }
}

async function toggleMaintenance(serverId, currentlyEnabled) {
  await saveMaintenance(serverId, !currentlyEnabled);
}
async function saveMaintenance(serverId, enabled) {
  const msg = document.getElementById('maint-msg')?.value || 'Server wird gewartet';
  try {
    await API.put(`/servers/${serverId}/maintenance`, { enabled: typeof enabled==='boolean'?enabled:!!enabled, message: msg });
    toast(enabled?'Maintenance deaktiviert':'Maintenance aktiviert','success');
    maintenanceInit(serverId);
  } catch(e) { toast(e.message,'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVER-TRANSFER
// ══════════════════════════════════════════════════════════════════════════════
let _transferPollInterval = null;

async function transferInit(serverId) {
  const root = document.getElementById('transfer-root');
  root.innerHTML = `<div class="empty"><div class="empty-icon spin"><i data-lucide="loader"></i></div></div>`;
  try {
    const [nodes, statusRes] = await Promise.all([
      API.get('/nodes'),
      API.get(`/servers/${serverId}/transfer/status`).catch(()=>({stage:'idle'})),
    ]);
    const srv = await API.get(`/servers/${serverId}`);

    const availNodes = nodes.filter(n => n.id !== srv.node_id && !n.id !== 'local');

    if (statusRes.running) {
      renderTransferProgress(root, statusRes);
      startTransferPoll(serverId);
      return;
    }
    if (statusRes.stage === 'done') {
      root.innerHTML = `<div class="card" style="max-width:600px;border-left:4px solid #00f5a0">
        <div class="card-title"><i data-lucide="check-circle"></i> Transfer abgeschlossen</div>
        <p class="text-dim" style="margin-top:8px">Server wurde erfolgreich auf die neue Node verschoben.</p>
        <button class="btn btn-primary" style="margin-top:12px" onclick="transferInit('${serverId}')">↺ Erneut transferieren</button>
      </div>`;
      return;
    }
    if (statusRes.stage === 'error') {
      root.innerHTML = `<div class="card" style="max-width:600px;border-left:4px solid #ff4757">
        <div class="card-title text-danger"><i data-lucide="x-circle"></i> Transfer fehlgeschlagen</div>
        <p class="text-dim" style="margin-top:8px">${esc(statusRes.error||'Unbekannter Fehler')}</p>
        <button class="btn btn-primary" style="margin-top:12px" onclick="transferInit('${serverId}')">↺ Erneut versuchen</button>
      </div>`;
      return;
    }

    root.innerHTML = `
      <div style="max-width:640px">
        <div class="card" style="border-left:4px solid #60a5fa">
          <div class="card-title" style="margin-bottom:4px"><i data-lucide="package"></i> Server auf andere Node transferieren</div>
          <p class="text-dim text-sm" style="margin-bottom:18px">Der Server wird gestoppt, gesichert und auf der Ziel-Node neu erstellt. Je nach Datenmenge kann dies einige Minuten dauern.</p>
          <div style="background:var(--bg3);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px">
            <div style="display:flex;gap:16px;flex-wrap:wrap">
              <div><div class="text-dim text-sm">Aktuelle Node</div><div style="font-weight:600">${esc(srv.node_name||'Lokal')}</div></div>
              <div style="color:var(--text3);font-size:20px;align-self:center">→</div>
              <div style="flex:1">
                <div class="text-dim text-sm">Ziel-Node</div>
                <select id="transfer-target" class="form-input" style="margin-top:4px">
                  <option value="">Node wählen...</option>
                  ${availNodes.map(n=>`<option value="${n.id}">${esc(n.name)} (${esc(n.location||'—')})</option>`).join('')}
                  ${!availNodes.length?'<option disabled>Keine anderen Nodes verfügbar</option>':''}
                </select>
              </div>
            </div>
          </div>
          <div class="card" style="background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.3);margin-bottom:16px">
            <div style="display:flex;gap:10px;align-items:flex-start">
              <span style="font-size:18px"><i data-lucide="alert-triangle"></i></span>
              <ul style="font-size:12px;color:var(--text2);padding-left:4px;line-height:1.8;list-style:none">
                <li>• Der Server wird während des Transfers <b>gestoppt</b></li>
                <li>• Port-Allocations müssen auf der Ziel-Node manuell angepasst werden</li>
                <li>• Der Transfer kann nicht abgebrochen werden</li>
              </ul>
            </div>
          </div>
          <button class="btn btn-primary" onclick="startTransfer('${serverId}')"><i data-lucide="package"></i> Transfer starten</button>
        </div>
      </div>`;
  } catch(e) { root.innerHTML=`<div class="empty"><p class="text-danger">${esc(e.message)}</p></div>`; }
}

function renderTransferProgress(root, status) {
  const stages = ['stopping','backup','removing_source','creating_target','restoring','updating','done'];
  const idx    = stages.indexOf(status.stage);
  const labels = {'stopping':'Server stoppen','backup':'Backup erstellen','removing_source':'Quelle entfernen','creating_target':'Ziel erstellen','restoring':'Daten wiederherstellen','updating':'Datenbank aktualisieren','done':'Abgeschlossen'};
  root.innerHTML = `
    <div class="card" style="max-width:600px;border-left:4px solid #60a5fa">
      <div class="card-title" style="margin-bottom:16px"><i data-lucide="loader"></i> Transfer läuft…</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${stages.filter(s=>s!=='done').map((s,i)=>`
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:22px;height:22px;border-radius:50%;background:${i<idx?'#00f5a0':i===idx?'#60a5fa':'var(--bg3)'};display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0">
              ${j<idx?'✓':j===idx?'…':(j+1)}
            </div>
            <div style="font-size:13px;color:${i<=idx?'var(--text)':'var(--text3)'};">${labels[s]||s}</div>
          </div>`).join('')}
      </div>
      <div style="margin-top:16px">
        <div style="background:var(--bg3);border-radius:4px;height:6px">
          <div style="background:#60a5fa;height:100%;border-radius:4px;width:${status.progress||0}%;transition:width .5s"></div>
        </div>
        <div class="text-dim text-sm" style="margin-top:6px">${status.progress||0}% abgeschlossen</div>
      </div>
    </div>`;
}

async function startTransfer(serverId) {
  const target = document.getElementById('transfer-target')?.value;
  if (!target) return toast('Bitte Ziel-Node wählen','warn');
  if (!confirm('Transfer wirklich starten? Der Server wird gestoppt.')) return;
  try {
    await API.post(`/servers/${serverId}/transfer`, { target_node_id: target });
    toast('Transfer gestartet','success');
    startTransferPoll(serverId);
    renderTransferProgress(document.getElementById('transfer-root'), { stage:'stopping', progress:5 });
  } catch(e) { toast(e.message,'error'); }
}

function startTransferPoll(serverId) {
  if (_transferPollInterval) clearInterval(_transferPollInterval);
  _transferPollInterval = setInterval(async () => {
    try {
      const s = await API.get(`/servers/${serverId}/transfer/status`);
      const root = document.getElementById('transfer-root');
      if (!root) { clearInterval(_transferPollInterval); return; }
      if (s.running) { renderTransferProgress(root, s); }
      else { clearInterval(_transferPollInterval); _transferPollInterval = null; transferInit(serverId); }
    } catch { clearInterval(_transferPollInterval); }
  }, 3000);
}

// ══════════════════════════════════════════════════════════════════════════════
// NODE RESSOURCEN-ÜBERSICHT (Admin)
// ══════════════════════════════════════════════════════════════════════════════
async function loadNodeResources() {
  document.getElementById('page-actions').innerHTML = `<button class="btn btn-ghost btn-sm" onclick="loadNodeResources()"><i data-lucide="rotate-ccw"></i> Aktualisieren</button>`;
  try {
    const nodes = await API.get('/admin/nodes/resources');
    if (!nodes.length) {
      document.getElementById('page-content').innerHTML = `<div class="empty"><div class="empty-icon"><i data-lucide="bar-chart-2"></i></div><h3>Keine Nodes</h3></div>`;
      return;
    }

    document.getElementById('page-content').innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px">
        ${nodes.map(n => {
          const memUsedPct  = n.limits.memory_mb ? Math.min(100, n.alloc.memory_mb / n.limits.memory_mb * 100) : 0;
          const diskUsedPct = n.limits.disk_mb   ? Math.min(100, n.alloc.disk_mb   / n.limits.disk_mb   * 100) : 0;
          const liveMemPct  = n.limits.memory_mb ? Math.min(100, n.used.memory_mb  / n.limits.memory_mb * 100) : 0;
          const online = n.last_seen && (Date.now() - new Date(n.last_seen).getTime()) < 60_000;
          return `
          <div class="card">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:14px">
              <div style="display:flex;align-items:center;gap:10px">
                <div style="width:10px;height:10px;border-radius:50%;background:${online?'#00f5a0':'#ff4757'};flex-shrink:0"></div>
                <div>
                  <div style="font-weight:700;font-size:15px">${esc(n.name)}</div>
                  <div class="text-dim text-sm">${esc(n.location||'—')} · ${esc(n.fqdn||'—')}</div>
                </div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <span class="chip chip-running">${n.running_count} / ${n.server_count} Online</span>
                ${n.is_local?'<span class="chip chip-offline">Lokal</span>':'<span class="chip">Remote</span>'}
              </div>
            </div>
            <div class="grid grid-3" style="gap:12px">
              <div>
                <div style="font-size:12px;color:var(--text3);margin-bottom:6px">RAM — Verplant</div>
                <div style="font-size:13px;font-weight:600;margin-bottom:4px">${fmtBytes(n.alloc.memory_mb*1024*1024)} / ${n.limits.memory_mb?fmtBytes(n.limits.memory_mb*1024*1024):'∞'}</div>
                <div style="height:6px;background:var(--bg3);border-radius:3px"><div style="height:100%;border-radius:3px;width:${memUsedPct}%;background:${memUsedPct>90?'#ff4757':memUsedPct>75?'#f59e0b':'#00f5a0'};transition:width .4s"></div></div>
              </div>
              <div>
                <div style="font-size:12px;color:var(--text3);margin-bottom:6px">RAM — Live</div>
                <div style="font-size:13px;font-weight:600;margin-bottom:4px">${fmtBytes(n.used.memory_mb*1024*1024)}</div>
                <div style="height:6px;background:var(--bg3);border-radius:3px"><div style="height:100%;border-radius:3px;width:${liveMemPct}%;background:${liveMemPct>90?'#ff4757':liveMemPct>75?'#f59e0b':'#60a5fa'};transition:width .4s"></div></div>
              </div>
              <div>
                <div style="font-size:12px;color:var(--text3);margin-bottom:6px">Disk — Verplant</div>
                <div style="font-size:13px;font-weight:600;margin-bottom:4px">${fmtBytes(n.alloc.disk_mb*1024*1024)} / ${n.limits.disk_mb?fmtBytes(n.limits.disk_mb*1024*1024):'∞'}</div>
                <div style="height:6px;background:var(--bg3);border-radius:3px"><div style="height:100%;border-radius:3px;width:${diskUsedPct}%;background:${diskUsedPct>90?'#ff4757':diskUsedPct>75?'#f59e0b':'#a78bfa'};transition:width .4s"></div></div>
              </div>
            </div>
            ${n.used.cpu_pct>0?`<div style="margin-top:10px;font-size:12px;color:var(--text3)">CPU Live: <span style="color:${n.used.cpu_pct>80?'#ff4757':'var(--text)'}">${n.used.cpu_pct.toFixed(1)}% Ø</span> (${n.server_count} Container)</div>`:''}
            ${n.last_seen?`<div style="margin-top:4px;font-size:11px;color:var(--text3)">Letzter Kontakt: ${fmtDate(n.last_seen)}</div>`:''}
          </div>`;
        }).join('')}
      </div>`;
  } catch(e) { document.getElementById('page-content').innerHTML=`<div class="empty"><p class="text-danger">${esc(e.message)}</p></div>`; }
}


let _histCpuChart = null, _histMemChart = null, _histNetChart = null;

function statsSubTab(tab, btn) {
  document.querySelectorAll('#detail-stats .tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('stats-sub-live').classList.toggle('hidden', tab !== 'live');
  document.getElementById('stats-sub-history').classList.toggle('hidden', tab !== 'history');
  if (tab === 'history' && State.serverDetail) loadStatsHistory();
}


// ══════════════════════════════════════════════════════════════════════════════
// ADMIN STATUS-PAGE VERWALTUNG
// ══════════════════════════════════════════════════════════════════════════════
let _spTab = 'incidents';

async function loadAdminStatusPage() {
  document.getElementById('page-actions').innerHTML = `
    <a href="/status" target="_blank" class="btn btn-secondary btn-sm"><i data-lucide="external-link"></i> Status-Page öffnen ↗</a>
    <button class="btn btn-ghost btn-sm" onclick="loadAdminStatusPage()"><i data-lucide="rotate-ccw"></i></button>`;

  const [incidents, settings, subscribers] = await Promise.all([
    API.get('/admin/incidents').catch(()=>[]),
    API.get('/admin/status-settings').catch(()=>({})),
    API.get('/admin/status-subscribers').catch(()=>[]),
  ]);

  document.getElementById('page-content').innerHTML = `
    <div style="max-width:900px">
      <div class="tabs-wrap"><div class="tabs" style="margin-bottom:16px">
        <button class="tab${_spTab==='incidents'?' active':''}" onclick="spTab('incidents',this)"><i data-lucide="alert-triangle"></i> Incidents</button>
        <button class="tab${_spTab==='scheduled'?' active':''}" onclick="spTab('scheduled',this)"><i data-lucide="calendar"></i> Geplante Wartungen</button>
        <button class="tab${_spTab==='override'?' active':''}" onclick="spTab('override',this)"><i data-lucide="sliders"></i> Status Override</button>
        <button class="tab${_spTab==='settings'?' active':''}" onclick="spTab('settings',this)"><i data-lucide="settings"></i> Einstellungen</button>
        <button class="tab${_spTab==='subscribers'?' active':''}" onclick="spTab('subscribers',this)"><i data-lucide="mail"></i> Abonnenten (${subscribers.length})</button>
      </div></div>

      <div id="sp-incidents" class="${_spTab==='incidents'?'':'hidden'}">
        <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
          <button class="btn btn-primary btn-sm" onclick="showCreateIncident()"><i data-lucide="plus"></i> Incident erstellen</button>
        </div>
        ${incidents.filter(i=>!i.is_scheduled).length ? incidents.filter(i=>!i.is_scheduled).map(inc => renderIncidentCard(inc)).join('') : `<div class="empty"><div class="empty-icon"><i data-lucide="check-circle-2"></i></div><p>Keine Incidents</p></div>`}
      </div>

      <div id="sp-scheduled" class="${_spTab==='scheduled'?'':'hidden'}">
        <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
          <button class="btn btn-primary btn-sm" onclick="showCreateScheduledMaint()"><i data-lucide="plus"></i> Wartungsfenster planen</button>
        </div>
        ${incidents.filter(i=>i.is_scheduled).length ? incidents.filter(i=>i.is_scheduled).map(inc => renderIncidentCard(inc, true)).join('') : `<div class="empty"><div class="empty-icon"><i data-lucide="calendar"></i></div><p>Keine geplanten Wartungen</p></div>`}
      </div>

      <div id="sp-override" class="${_spTab==='override'?'':'hidden'}">
        <p class="text-dim text-sm" style="margin-bottom:12px">Überschreibe den angezeigten Status eines Servers auf der Status-Page (unabhängig vom echten Container-Status).</p>
        <div style="display:flex;flex-direction:column;gap:6px" id="override-list">
          <div class="empty"><div class="spin empty-icon"></div></div>
        </div>
      </div>

      <div id="sp-settings" class="${_spTab==='settings'?'':'hidden'}">
        ${renderStatusSettings(settings)}
      </div>

      <div id="sp-subscribers" class="${_spTab==='subscribers'?'':'hidden'}">
        ${renderSubscribers(subscribers)}
      </div>
    </div>`;

  if (_spTab === 'override') loadOverrideList();
}

function spTab(tab, btn) {
  _spTab = tab;
  document.querySelectorAll('.tabs .tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  ['incidents','scheduled','override','settings','subscribers'].forEach(t =>
    document.getElementById('sp-'+t)?.classList.toggle('hidden', t!==tab));
  if (tab === 'override') loadOverrideList();
}

function renderIncidentCard(inc, scheduled=false) {
  const SC = {info:'#60a5fa',degraded:'#f59e0b',partial:'#f59e0b',major:'#ff4757',maintenance:'#a78bfa'};
  const SS = {investigating:'<i data-lucide="search"></i> Untersucht',identified:'<i data-lucide="target"></i> Identifiziert',monitoring:'<i data-lucide="activity"></i> Monitoring',resolved:'<i data-lucide="check-circle"></i> Behoben'};
  const c = SC[inc.severity]||'#64748b';
  return `<div class="card" style="border-left:3px solid ${c};margin-bottom:8px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:14px">${esc(inc.title)}</div>
        <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">
          <span class="chip" style="background:${c}18;color:${c};font-size:10px">${inc.severity}</span>
          <span class="chip chip-offline" style="font-size:10px">${SS[inc.status]||inc.status}</span>
          ${inc.is_scheduled && inc.scheduled_at ? `<span class="chip" style="background:rgba(167,139,250,.15);color:#a78bfa;font-size:10px"><i data-lucide="calendar"></i> ${new Date(inc.scheduled_at).toLocaleString('de-DE')}</span>` : ''}
        </div>
        ${inc.body ? `<div class="text-dim text-sm" style="margin-top:6px">${esc(inc.body.substring(0,120))}${inc.body.length>120?'…':''}</div>` : ''}
        ${inc.updates?.length ? `<div class="text-dim" style="font-size:11px;margin-top:4px">${inc.updates.length} Update(s)</div>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        ${inc.status !== 'resolved' ? `<button class="btn btn-ghost btn-sm" onclick="showAddUpdate('${inc.id}')"><i data-lucide="plus"></i> Update</button>` : ''}
        ${inc.status !== 'resolved' ? `<button class="btn btn-secondary btn-sm" onclick="resolveIncident('${inc.id}')"><i data-lucide="check"></i> Lösen</button>` : ''}
        <button class="btn btn-danger btn-sm" onclick="deleteIncident('${inc.id}')"><i data-lucide="trash-2"></i></button>
      </div>
    </div>
    <div class="text-dim" style="font-size:11px;margin-top:8px">Erstellt: ${new Date(inc.created_at||inc.started_at).toLocaleString('de-DE')}</div>
  </div>`;
}

function renderStatusSettings(s) {
  return `<div class="grid grid-2" style="gap:12px">
    <div class="card">
      <div class="card-title" style="margin-bottom:14px"><i data-lucide="settings"></i> Allgemein</div>
      <div class="form-group"><label class="form-label">Titel</label><input id="sp-title" class="form-input" value="${esc(s.title||'')}"/></div>
      <div class="form-group"><label class="form-label">Beschreibung</label><input id="sp-desc" class="form-input" value="${esc(s.description||'')}"/></div>
      <div class="form-group"><label class="form-label">Logo-URL</label><input id="sp-logo" class="form-input" value="${esc(s.logo_url||'')}"/></div>
      <div class="form-group"><label class="form-label">Akzent-Farbe</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="color" id="sp-accent" value="${esc(s.accent_color||'#00d4ff')}" style="width:40px;height:34px;border:none;border-radius:6px;cursor:pointer;background:none"/>
          <input id="sp-accent-txt" class="form-input" value="${esc(s.accent_color||'#00d4ff')}" oninput="document.getElementById('sp-accent').value=this.value"/>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-title" style="margin-bottom:14px"><i data-lucide="eye"></i> Anzeige</div>
      ${[
        ['sp-enabled','Status-Page aktiviert','enabled'],
        ['sp-show-all','Alle Server anzeigen','show_all'],
        ['sp-show-cpu','CPU-Auslastung zeigen','show_cpu'],
        ['sp-show-ram','RAM-Auslastung zeigen','show_ram'],
        ['sp-show-uptime','90-Tage Uptime-Bars zeigen','show_uptime'],
        ['sp-show-groups','Server-Gruppen zeigen','show_groups'],
        ['sp-allow-sub','E-Mail-Abo erlauben','allow_subscribe'],
      ].map(([id,label,key]) => `
        <label style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);cursor:pointer">
          <span class="text-sm">${label}</span>
          <input type="checkbox" id="${id}" ${s[key]?'checked':''} style="accent-color:var(--accent);width:16px;height:16px"/>
        </label>`).join('')}
    </div>
    <div style="grid-column:span 2">
      <button class="btn btn-primary" onclick="saveStatusSettings()"><i data-lucide="save"></i> Einstellungen speichern</button>
    </div>
  </div>`;
}

function renderSubscribers(subs) {
  if (!subs.length) return `<div class="empty"><div class="empty-icon"><i data-lucide="mail"></i></div><p>Keine Abonnenten</p></div>`;
  return `<div style="display:flex;flex-direction:column;gap:6px">
    <div class="text-dim text-sm" style="margin-bottom:8px">${subs.length} aktive Abonnenten</div>
    ${subs.map(s => `<div class="card" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px">
      <div>
        <div style="font-size:13px;font-weight:600">${esc(s.email)}</div>
        <div class="text-dim" style="font-size:11px">Seit ${new Date(s.created_at).toLocaleString('de-DE')}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteSubscriber('${s.id}')"><i data-lucide="trash-2"></i></button>
    </div>`).join('')}
  </div>`;
}

async function loadOverrideList() {
  const root = document.getElementById('override-list');
  if (!root) return;
  try {
    const servers = await API.get('/servers');
    root.innerHTML = servers.map(s => {
      const ovr = s.status_override || '';
      return `<div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;flex-wrap:wrap">
        <div>
          <div style="font-weight:600;font-size:13px">${esc(s.name)}</div>
          <div class="text-dim text-sm">${esc(s.image)} · ${s.status}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <select id="ovr-${s.id}" class="form-input" style="width:auto;padding:6px 10px;font-size:12px">
            <option value="" ${!ovr?'selected':''}>— Kein Override</option>
            <option value="degraded" ${ovr==='degraded'?'selected':''}><i data-lucide="alert-triangle"></i> Beeinträchtigt</option>
            <option value="maintenance" ${ovr==='maintenance'?'selected':''}><i data-lucide="wrench"></i> Wartung</option>
            <option value="custom" ${ovr==='custom'?'selected':''}>ℹ Info</option>
          </select>
          <button class="btn btn-secondary btn-sm" onclick="saveOverride('${s.id}')">Setzen</button>
        </div>
      </div>`;
    }).join('') || `<div class="empty"><p>Keine Server</p></div>`;
  } catch(e) { root.innerHTML=`<div class="empty"><p class="text-danger">${esc(e.message)}</p></div>`; }
}
async function saveOverride(serverId) {
  const val = document.getElementById('ovr-'+serverId)?.value || '';
  try { await API.put(`/admin/status-override/${serverId}`, { override: val }); toast('Override gesetzt','success'); }
  catch(e) { toast(e.message,'error'); }
}

function showCreateIncident() {
  showModal(`
    <div class="modal-title"><span><i data-lucide="alert-triangle"></i> Incident erstellen</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group"><label class="form-label">Titel</label><input id="inc-title" class="form-input" placeholder="z.B. Datenbankausfall"/></div>
    <div class="form-group"><label class="form-label">Schweregrad</label>
      <select id="inc-sev" class="form-input">
        <option value="info">ℹ Info</option>
        <option value="degraded" selected><i data-lucide="alert-triangle"></i> Beeinträchtigt</option>
        <option value="partial"><i data-lucide="alert-triangle"></i> Teilausfall</option>
        <option value="major"><i data-lucide="alert-octagon"></i> Schwerer Ausfall</option>
        <option value="maintenance"><i data-lucide="wrench"></i> Wartung</option>
      </select>
    </div>
    <div class="form-group"><label class="form-label">Beschreibung (optional)</label><textarea id="inc-body" class="form-input" rows="3" placeholder="Was ist passiert?"></textarea></div>
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="createIncident()">Erstellen</button>
    </div>`);
}
async function createIncident() {
  try {
    await API.post('/admin/incidents', {
      title: document.getElementById('inc-title').value,
      severity: document.getElementById('inc-sev').value,
      body: document.getElementById('inc-body').value,
    });
    toast('Incident erstellt','success'); closeModal(); loadAdminStatusPage();
  } catch(e) { mErr(e.message); }
}

function showCreateScheduledMaint() {
  const now = new Date(); now.setHours(now.getHours()+1,0,0,0);
  const defVal = now.toISOString().slice(0,16);
  showModal(`
    <div class="modal-title"><span><i data-lucide="calendar"></i> Wartungsfenster planen</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group"><label class="form-label">Titel</label><input id="maint-title" class="form-input" placeholder="z.B. Datenbankupdate"/></div>
    <div class="form-group"><label class="form-label">Geplanter Zeitpunkt</label><input type="datetime-local" id="maint-sched" class="form-input" value="${defVal}"/></div>
    <div class="form-group"><label class="form-label">Beschreibung</label><textarea id="maint-body" class="form-input" rows="2" placeholder="Was wird gemacht?"></textarea></div>
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="createScheduledMaint()">Planen</button>
    </div>`);
}
async function createScheduledMaint() {
  try {
    await API.post('/admin/incidents/scheduled', {
      title: document.getElementById('maint-title').value,
      body:  document.getElementById('maint-body').value,
      scheduled_at: new Date(document.getElementById('maint-sched').value).toISOString(),
    });
    toast('Wartung geplant','success'); closeModal(); loadAdminStatusPage();
  } catch(e) { mErr(e.message); }
}

function showAddUpdate(incId) {
  showModal(`
    <div class="modal-title"><span><i data-lucide="plus"></i> Update hinzufügen</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group"><label class="form-label">Status</label>
      <select id="upd-status" class="form-input">
        <option value="investigating"><i data-lucide="search"></i> Wird untersucht</option>
        <option value="identified"><i data-lucide="target"></i> Ursache gefunden</option>
        <option value="monitoring"><i data-lucide="eye"></i> Wird beobachtet</option>
        <option value="resolved"><i data-lucide="check-circle"></i> Behoben</option>
      </select>
    </div>
    <div class="form-group"><label class="form-label">Update-Text</label><textarea id="upd-body" class="form-input" rows="3" placeholder="Was hat sich geändert?"></textarea></div>
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitIncidentUpdate('${incId}')">Speichern</button>
    </div>`);
}
async function submitIncidentUpdate(incId) {
  try {
    await API.patch(`/admin/incidents/${incId}`, {
      status: document.getElementById('upd-status').value,
      update_text: document.getElementById('upd-body').value,
    });
    toast('Update gespeichert','success'); closeModal(); loadAdminStatusPage();
  } catch(e) { mErr(e.message); }
}
async function resolveIncident(id) {
  if (!confirm('Incident als behoben markieren?')) return;
  try { await API.patch(`/admin/incidents/${id}`, { status:'resolved', update_text:'Incident behoben.' }); toast('Behoben','success'); loadAdminStatusPage(); }
  catch(e) { toast(e.message,'error'); }
}
async function deleteIncident(id) {
  if (!confirm('Incident löschen?')) return;
  try { await API.delete(`/admin/incidents/${id}`); toast('Gelöscht','success'); loadAdminStatusPage(); }
  catch(e) { toast(e.message,'error'); }
}
async function deleteSubscriber(id) {
  if (!confirm('Abonnent entfernen?')) return;
  try { await API.delete(`/admin/status-subscribers/${id}`); toast('Entfernt','success'); loadAdminStatusPage(); }
  catch(e) { toast(e.message,'error'); }
}
async function saveStatusSettings() {
  const g = id => document.getElementById(id);
  const accent = g('sp-accent')?.value || g('sp-accent-txt')?.value || '#00d4ff';
  try {
    await API.put('/admin/status-settings', {
      title:           g('sp-title')?.value,
      description:     g('sp-desc')?.value,
      logo_url:        g('sp-logo')?.value,
      accent_color:    accent,
      enabled:         g('sp-enabled')?.checked,
      show_all:        g('sp-show-all')?.checked,
      show_cpu:        g('sp-show-cpu')?.checked,
      show_ram:        g('sp-show-ram')?.checked,
      show_uptime:     g('sp-show-uptime')?.checked,
      show_groups:     g('sp-show-groups')?.checked,
      allow_subscribe: g('sp-allow-sub')?.checked,
    });
    toast('Einstellungen gespeichert','success');
  } catch(e) { toast(e.message,'error'); }
}

async function loadStatsHistory() {

  if (!State.serverDetail) return;
  const hours  = document.getElementById('history-range')?.value || '24';
  const metaEl = document.getElementById('history-meta');
  if (metaEl) metaEl.textContent = 'Lade...';

  try {
    const data = await API.get(`/servers/${State.serverDetail}/stats/history?hours=${hours}&points=120`);

    if (!data.labels || data.labels.length === 0) {
      if (metaEl) metaEl.textContent = 'Keine Verlaufs-Daten vorhanden. Daten werden alle 30 Sekunden gesammelt.';
      return;
    }

    const labels = data.labels.map(l => {
      const d = new Date(l);
      return hours <= 2
        ? d.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' })
        : d.toLocaleString('de-DE', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
    });

    const chartOpts = (color, unit='') => ({
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color:'#64748b', maxTicksLimit:8, font:{size:10} }, grid: { color:'#1e293b' } },
        y: { ticks: { color:'#64748b', font:{size:10}, callback: v => v + unit }, grid: { color:'#1e293b' } }
      },
    });

    // CPU chart
    const cpuCtx = document.getElementById('history-cpu-chart')?.getContext('2d');
    if (cpuCtx) {
      if (_histCpuChart) _histCpuChart.destroy();
      _histCpuChart = new Chart(cpuCtx, {
        type: 'line',
        data: { labels, datasets: [{ data: data.cpu, borderColor:'#00d4ff', backgroundColor:'rgba(0,212,255,.08)', borderWidth:1.5, fill:true, tension:.3, pointRadius:0 }] },
        options: { ...chartOpts('#00d4ff', '%'), scales: { ...chartOpts('#00d4ff','%').scales, y: { ...chartOpts('#00d4ff','%').scales.y, min:0, max:100 } } },
      });
    }

    // RAM chart
    const memCtx = document.getElementById('history-mem-chart')?.getContext('2d');
    if (memCtx) {
      if (_histMemChart) _histMemChart.destroy();
      const memLimit = data.memory_limit || 0;
      _histMemChart = new Chart(memCtx, {
        type: 'line',
        data: { labels, datasets: [{ data: data.memory, borderColor:'#00f5a0', backgroundColor:'rgba(0,245,160,.08)', borderWidth:1.5, fill:true, tension:.3, pointRadius:0 }] },
        options: { ...chartOpts('#00f5a0', ' MB'), scales: { ...chartOpts('#00f5a0',' MB').scales, y: { ...chartOpts('#00f5a0',' MB').scales.y, min:0, ...(memLimit>0 ? {max: memLimit} : {}) } } },
      });
    }

    // Network chart
    const netCtx = document.getElementById('history-net-chart')?.getContext('2d');
    if (netCtx) {
      if (_histNetChart) _histNetChart.destroy();
      _histNetChart = new Chart(netCtx, {
        type: 'line',
        data: { labels, datasets: [
          { label:'RX', data: data.net_rx, borderColor:'#00d4ff', backgroundColor:'rgba(0,212,255,.06)', borderWidth:1.5, fill:true, tension:.3, pointRadius:0 },
          { label:'TX', data: data.net_tx, borderColor:'#f59e0b', backgroundColor:'rgba(245,158,11,.06)', borderWidth:1.5, fill:true, tension:.3, pointRadius:0 },
        ]},
        options: { ...chartOpts(), plugins:{ legend:{ display:true, labels:{ color:'#64748b', font:{size:11} } } }, scales: { x: chartOpts().scales.x, y: { ticks:{ color:'#64748b', font:{size:10}, callback: v => fmtBytes(v) }, grid:{ color:'#1e293b' } } } },
      });
    }

    if (metaEl) metaEl.textContent = `${data.count} Messpunkte · ${data.sampled} angezeigt`;
  } catch(e) {
    if (metaEl) metaEl.textContent = 'Fehler beim Laden: ' + e.message;
  }
}

// ─── KONSOLEN-HISTORY ─────────────────────────────────────────────────────────
let _cmdHistory = [];
let _histIdx    = -1;
let _histLoaded = false;

async function loadConsoleHistory(serverId) {
  if (_histLoaded) return;
  try {
    const rows = await API.get(`/servers/${serverId}/console/history?limit=200`);
    _cmdHistory = rows.map(r => r.command);
    _histIdx    = _cmdHistory.length; // zeigt hinter letztes Element
    _histLoaded = true;
  } catch {}
}

function handleConsoleKey(event, serverId) {
  const input = document.getElementById('console-input');
  if (!input) return;

  if (event.key === 'Enter') {
    sendConsoleCommand(serverId);
    _histIdx = _cmdHistory.length; // nach Send: wieder ans Ende
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (_cmdHistory.length === 0) return;
    _histIdx = Math.max(0, _histIdx - 1);
    input.value = _cmdHistory[_histIdx] || '';
    input.setSelectionRange(input.value.length, input.value.length);
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    _histIdx = Math.min(_cmdHistory.length, _histIdx + 1);
    input.value = _histIdx < _cmdHistory.length ? _cmdHistory[_histIdx] : '';
  }
}

// sendConsoleCommand patchen um History lokal zu updaten
function sendConsoleCommand(serverId) {
  const input = document.getElementById('console-input');
  const cmd   = input?.value?.trim();
  if (!cmd) return;

  // Lokal in History eintragen
  if (!_cmdHistory.length || _cmdHistory[_cmdHistory.length - 1] !== cmd) {
    _cmdHistory.push(cmd);
    if (_cmdHistory.length > 500) _cmdHistory.shift();
  }
  _histIdx = _cmdHistory.length;

  // Original-Logik: WS senden
  wsSend({ type: 'console.input', server_id: serverId, command: cmd });
  if (input) input.value = '';
}

// History laden wenn Konsolen-Tab aktiv wird — integriert in detailTab oben
