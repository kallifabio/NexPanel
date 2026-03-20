/* NexPanel — servers.js
 * Server list, create, clone, bulk actions
 */

// ─── SERVERS ─────────────────────────────────────────────────────────────────
const _bulkSelected = new Set();

function updateBulkToolbar() {
  const toolbar   = document.getElementById('bulk-toolbar');
  const countEl   = document.getElementById('bulk-count');
  const createBtn = document.getElementById('bulk-create-btn');
  if (!toolbar) return;
  if (_bulkSelected.size > 0) {
    toolbar.style.display = 'flex';
    toolbar.classList.remove('hidden');
    if (countEl) countEl.textContent = `${_bulkSelected.size} ausgewählt`;
    if (createBtn) createBtn.style.opacity = '0.4';
  } else {
    toolbar.style.display = 'none';
    if (createBtn) createBtn.style.opacity = '1';
  }
}

function toggleBulkSelect(id, checked) {
  if (checked) _bulkSelected.add(id); else _bulkSelected.delete(id);
  updateBulkToolbar();
}

function clearBulkSelection() {
  _bulkSelected.clear();
  document.querySelectorAll('.bulk-checkbox').forEach(cb => cb.checked = false);
  updateBulkToolbar();
}

async function bulkPower(action) {
  if (_bulkSelected.size === 0) return;
  const ids   = [..._bulkSelected];
  const label = { start:'starten', stop:'stoppen', restart:'neu starten' }[action] || action;
  if (!confirm(`${ids.length} Server ${label}?`)) return;
  try {
    const res = await API.post('/servers/bulk/power', { server_ids: ids, action });
    toast(`${res.summary.ok}/${res.summary.total} Server: ${action}`, res.summary.err ? 'warn' : 'success');
    clearBulkSelection();
    loadServers();
  } catch(e) { toast(e.message, 'error'); }
}

// ─── localStorage-Favoriten lesen/schreiben ──────────────────────────────────
function getFavCache() {
  try { return new Set(JSON.parse(localStorage.getItem('hp_favorites') || '[]')); }
  catch { return new Set(); }
}
function setFavCache(ids) {
  try { localStorage.setItem('hp_favorites', JSON.stringify([...ids])); } catch {}
}
function isFavCached(id) { return getFavCache().has(id); }
function addFavCache(id) { const s = getFavCache(); s.add(id); setFavCache(s); }
function removeFavCache(id) { const s = getFavCache(); s.delete(id); setFavCache(s); }

// ─── Server-Liste sortieren (Favoriten oben) ──────────────────────────────────
function sortServers(servers) {
  const favCache = getFavCache();
  // Merge: Server-DB-Favorit ODER localStorage-Cache
  const withFav = servers.map(s => ({
    ...s,
    is_favorite: !!(s.is_favorite || favCache.has(s.id)),
  }));
  // Sortierung: Favoriten zuerst, dann alphabetisch nach Name
  return withFav.sort((a, b) => {
    if (a.is_favorite && !b.is_favorite) return -1;
    if (!a.is_favorite && b.is_favorite) return 1;
    return (a.name || '').localeCompare(b.name || '', 'de');
  });
}

async function loadServers() {
  document.getElementById('page-actions').innerHTML = `
    <div id="bulk-toolbar" style="display:none;align-items:center;gap:8px;background:var(--bg3);padding:6px 12px;border-radius:8px;border:1px solid rgba(0,212,255,.3)">
      <span class="text-accent" style="font-size:13px" id="bulk-count">0 ausgewählt</span>
      <button class="btn btn-sm" style="background:#00f5a022;color:#00f5a0;border:1px solid #00f5a044" onclick="bulkPower('start')"><i data-lucide="play"></i> Start</button>
      <button class="btn btn-sm" style="background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b44" onclick="bulkPower('stop')"><i data-lucide="square"></i> Stop</button>
      <button class="btn btn-sm" style="background:#60a5fa22;color:#60a5fa;border:1px solid #60a5fa44" onclick="bulkPower('restart')"><i data-lucide="rotate-ccw"></i> Restart</button>
      <button class="btn btn-ghost btn-sm" onclick="clearBulkSelection()"><i data-lucide="x"></i></button>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <div style="display:flex;gap:4px;background:var(--bg3);border-radius:8px;padding:3px">
        <button class="btn btn-ghost btn-sm" id="srv-filter-all" onclick="setServerFilter('all',this)" style="border-radius:6px;font-size:12px">Alle</button>
        <button class="btn btn-ghost btn-sm" id="srv-filter-fav" onclick="setServerFilter('fav',this)" style="border-radius:6px;font-size:12px"><i data-lucide="star" style="width:12px;height:12px;color:#facc15"></i> Favoriten</button>
        <button class="btn btn-ghost btn-sm" id="srv-filter-run" onclick="setServerFilter('run',this)" style="border-radius:6px;font-size:12px"><span style="color:var(--accent3)">●</span> Läuft</button>
      </div>
      <button class="btn btn-primary" id="bulk-create-btn" onclick="showCreateServer()"><i data-lucide="plus"></i> Neuer Server</button>
    </div>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();

  try {
    const rawServers = await API.get('/servers');
    document.getElementById('server-count-badge').textContent = rawServers.length;

    if (rawServers.length === 0) {
      document.getElementById('page-content').innerHTML = `<div class="empty"><div class="empty-icon"><i data-lucide="server"></i></div><h3>Keine Server</h3><p>Erstelle deinen ersten Server</p><button class="btn btn-primary" style="margin-top:16px" onclick="showCreateServer()"><i data-lucide="plus"></i> Server erstellen</button></div>`;
      return;
    }

    // Sync DB-Favoriten in localStorage
    rawServers.forEach(s => {
      if (s.is_favorite) addFavCache(s.id);
    });

    State._allServers = rawServers;
    State._serverFilter = State._serverFilter || 'all';
    renderServerList();
  } catch (e) {
    document.getElementById('page-content').innerHTML = `<div class="empty"><p class="text-danger">Fehler: ${esc(e.message)}</p></div>`;
  }
}

let _currentFilter = 'all';
function setServerFilter(filter, btn) {
  _currentFilter = filter;
  document.querySelectorAll('#page-actions .btn-ghost').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderServerList();
}

function renderServerList() {
  const content = document.getElementById('page-content');
  if (!content || !State._allServers) return;

  let servers = sortServers(State._allServers);

  // Filtern
  if (_currentFilter === 'fav') {
    servers = servers.filter(s => s.is_favorite);
  } else if (_currentFilter === 'run') {
    servers = servers.filter(s => s.status === 'running');
  }

  if (servers.length === 0) {
    const emptyMsg = {
      fav: 'Noch keine Favoriten — klicke den Stern auf einer Server-Karte.',
      run: 'Keine Server gerade online.',
      all: 'Keine Server vorhanden.',
    }[_currentFilter] || 'Keine Server.';
    content.innerHTML = `<div class="empty" style="padding:40px"><div class="empty-icon"><i data-lucide="${_currentFilter==='fav'?'star':_currentFilter==='run'?'activity':'server'}"></i></div><p>${emptyMsg}</p></div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  const favs   = servers.filter(s => s.is_favorite);
  const others = servers.filter(s => !s.is_favorite);

  let html = '';

  // Favoriten-Abschnitt
  if (favs.length > 0 && _currentFilter === 'all') {
    html += `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;margin-top:2px">
        <i data-lucide="star" style="width:13px;height:13px;color:#facc15;fill:#facc15"></i>
        <span style="font-size:11px;font-weight:700;color:#facc15;text-transform:uppercase;letter-spacing:.6px">Favoriten</span>
        <div style="flex:1;height:1px;background:rgba(250,204,21,.2)"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
        ${favs.map(s => serverItemHtml(s, false)).join('')}
      </div>`;

    if (others.length > 0) {
      html += `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <i data-lucide="server" style="width:13px;height:13px;color:var(--text3)"></i>
          <span style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.6px">Alle Server</span>
          <div style="flex:1;height:1px;background:var(--border)"></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${others.map(s => serverItemHtml(s, false)).join('')}
        </div>`;
    }
  } else {
    html = `<div style="display:flex;flex-direction:column;gap:6px">${servers.map(s => serverItemHtml(s, false)).join('')}</div>`;
  }

  content.innerHTML = html;
  if (typeof lucide !== 'undefined') lucide.createIcons();

  // Active filter button
  const filterBtn = document.getElementById(`srv-filter-${_currentFilter}`);
  if (filterBtn) filterBtn.classList.add('active');
}

function serverItemHtml(s, compact) {
  const sc = s.status || 'offline';
  const nodeTag = s.node_name ? `<span class="tag tag-node"><i data-lucide="globe"></i> ${esc(s.node_name)}</span>` : '';
  const actions = compact ? '' : `
    <div class="server-actions">
      ${sc !== 'running' ? `<button class="power-btn start" title="Starten" onclick="event.stopPropagation();serverPower('${s.id}','start')"><i data-lucide="play"></i></button>` : ''}
      ${sc === 'running' ? `<button class="power-btn restart" title="Neustart" onclick="event.stopPropagation();serverPower('${s.id}','restart')"><i data-lucide="rotate-ccw"></i></button>` : ''}
      ${sc === 'running' ? `<button class="power-btn stop" title="Stoppen" onclick="event.stopPropagation();serverPower('${s.id}','stop')"><i data-lucide="square"></i></button>` : ''}
    </div>`;
  return `
    <div class="server-item" onclick="navigate('server-detail','${s.id}')">
      <input type="checkbox" class="bulk-checkbox" style="width:16px;height:16px;cursor:pointer;flex-shrink:0;accent-color:var(--accent)"
        onclick="event.stopPropagation()" onchange="toggleBulkSelect('${s.id}',this.checked)"/>
      <div class="server-status-dot ${sc}" data-sid="${s.id}"></div>
      <div class="server-info">
        <div class="server-name">${esc(s.name)}</div>
        <div class="server-meta">${s.owner_name ? esc(s.owner_name)+' · ' : ''}${esc(s.image)}</div>
        <div class="server-tags">
          <span class="tag tag-image">${esc(s.image.split(':')[0])}</span>
          <span class="tag tag-status ${sc}">${sc}</span>
          ${nodeTag}
          ${s.ports?.length ? `<span class="tag"><i data-lucide="zap"></i> ${s.ports.slice(0,2).map(p=>typeof p==='object'?`${p.host}:${p.container}`:p).join(', ')}</span>` : ''}
        </div>
      </div>
      <div class="server-resources"><div>${s.cpu_limit} ${parseFloat(s.cpu_limit)===1?"Kern":"Kerne"} · ${s.cpu_percent||100}% CPU</div><div>${s.memory_limit}MB RAM</div>${s.node_name?`<div style="color:var(--text3)">${esc(s.node_name)}</div>`:''}</div>
      <button class="power-btn fav-btn${s.is_favorite?' fav-active':''}" title="${s.is_favorite?'Favorit entfernen':'Als Favorit markieren'}" onclick="event.stopPropagation();toggleFavorite('${s.id}',this)">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
          fill="${s.is_favorite?'#facc15':'none'}"
          stroke="${s.is_favorite?'#facc15':'var(--text3)'}"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
      </button>
      ${actions}
    </div>`;
}

async function serverPower(id, action) {
  try {
    await API.post(`/servers/${id}/power/${action}`, {});
    const actionLabels = { start:'<i data-lucide="play"></i> Start', stop:'■ Stop', restart:'<i data-lucide="rotate-ccw"></i> Neustart', kill:'<i data-lucide="zap"></i> Kill' };
    toast(`${actionLabels[action]||action} Signal gesendet`, 'success');
    startStatusPoll(id); // Polling starten bis Status stabil
    if (State.currentPage === 'servers') loadServers();
    if (State.currentPage === 'server-detail') loadServerDetail(id);
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('noch nicht fertig') || msg.includes('installiert')) {
      toast('Server wird noch installiert — bitte warten', 'warn');
    } else if (msg.includes('offline') || msg.includes('Node')) {
      toast('<i data-lucide="alert-triangle"></i> Node ist offline', 'warn');
    } else {
      toast(msg, 'error');
    }
  }
}

// ─── SERVER ERSTELLEN ─────────────────────────────────────────────────────────
async function showCreateServer(preEgg) {
  const [nodes, eggs, allocs, quota] = await Promise.all([
    API.get('/nodes').catch(() => []),
    API.get('/eggs').catch(() => []),
    API.get('/allocations').catch(() => []),
    API.get('/account/quota').catch(() => null),
  ]);
  const nodeOptions = `<option value="">Auto (Scaling)</option>` + nodes.map(n => {
    const on = n.connected;
    return `<option value="${n.id}" ${!on?'disabled':''}>${esc(n.name)} — ${esc(n.fqdn)} ${n.is_local?'(Lokal)':''} ${!on?'[offline]':''}</option>`;
  }).join('');

  const eggOptions = `<option value="">— Kein Template —</option>` + eggs.map(e => `<option value="${e.id}" ${preEgg?.id===e.id?'selected':''}>${e.icon} ${esc(e.name)} (${esc(e.docker_image.split(':')[0])})</option>`).join('');
  showModal(`
    <div class="modal-title"><span><i data-lucide="plus"></i> Neuer Server</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    ${nodes.filter(n=>n.connected).length===0 ? `<div class="warn-msg"><i data-lucide="alert-triangle"></i> Keine Online-Nodes. ${State.user.role==='admin'?'<button class="btn btn-ghost btn-xs" onclick="closeModal();navigate(\'admin-nodes\')">→ Nodes einrichten</button>':'Kontaktiere den Admin.'}</div>` : ''}
    <div class="form-group">
      <label class="form-label"><i data-lucide="egg"></i> Egg / Template</label>
      <select id="m-egg" class="form-input" onchange="onEggSelect(this.value)">
        ${eggOptions}
      </select>
    </div>
    <div class="grid grid-2">
      <div class="form-group"><label class="form-label">Server Name *</label><input type="text" id="m-name" class="form-input" placeholder="Mein Minecraft Server"/></div>
      <div class="form-group"><label class="form-label">Docker Image *</label><input type="text" id="m-image" class="form-input" value="${preEgg?esc(preEgg.docker_image):''}"/></div>
    </div>
    <div class="form-group">
      <label class="form-label" style="display:flex;justify-content:space-between;align-items:center">
        <span>Node</span>
        <span id="scaling-badge" style="font-size:11px;color:var(--color-text-secondary)"></span>
      </label>
      <select id="m-node" class="form-input" onchange="updateScalingPreview()">${nodeOptions}</select>
      <div id="scaling-preview" style="margin-top:6px;padding:8px 10px;border-radius:6px;background:var(--color-background-secondary);border:1px solid var(--color-border-tertiary);font-size:12px;display:none"></div>
    </div>
    <div class="form-group"><label class="form-label">Beschreibung</label><input type="text" id="m-desc" class="form-input" placeholder="Optional"/></div>
    <div class="grid grid-3">
      <div class="form-group"><label class="form-label">CPU Kerne</label>
        <select id="m-cpu" class="form-input">
          <option value="0.5">0.5 Kerne</option>
          <option value="1" selected>1 Kern</option>
          <option value="2">2 Kerne</option>
          <option value="4">4 Kerne</option>
          <option value="6">6 Kerne</option>
          <option value="8">8 Kerne</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">CPU Auslastung %</label>
        <select id="m-cpu-pct" class="form-input">
          <option value="25">25%</option>
          <option value="50">50%</option>
          <option value="75">75%</option>
          <option value="100" selected>100%</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">RAM (MB)</label><input type="number" id="m-mem" class="form-input" value="512" min="64" oninput="updateScalingPreview()"/></div>
      <div class="form-group"><label class="form-label">Disk (MB)</label><input type="number" id="m-disk" class="form-input" value="5120" min="512" oninput="updateScalingPreview()"/></div>
    </div>
    <div class="form-group">
      <label class="form-label" style="display:flex;justify-content:space-between;align-items:center">
        <span>Port Allocations</span>
        <span id="m-ports-hint" class="text-muted" style="font-size:11px">Aus Allocations wählen oder manuell eingeben</span>
      </label>
      <div id="m-alloc-list" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;min-height:28px"></div>
      <input type="text" id="m-ports" class="form-input" placeholder="25565:25565, 25575:25575 (oder oben wählen)"/>
    </div>
    <div id="m-minecraft-opts" class="hidden">
      <div class="grid grid-2">
        <div class="form-group">
          <label class="form-label"><i data-lucide="coffee"></i> Minecraft Version</label>
          <select id="m-mc-version" class="form-input">
            <option value="LATEST">LATEST (aktuellste)</option>
            <option value="1.21.4">1.21.4</option>
            <option value="1.21.3">1.21.3</option>
            <option value="1.21.1">1.21.1</option>
            <option value="1.20.6">1.20.6</option>
            <option value="1.20.4">1.20.4</option>
            <option value="1.20.1">1.20.1</option>
            <option value="1.19.4">1.19.4</option>
            <option value="1.19.2">1.19.2</option>
            <option value="1.18.2">1.18.2</option>
            <option value="1.17.1">1.17.1</option>
            <option value="1.16.5">1.16.5</option>
            <option value="1.12.2">1.12.2</option>
            <option value="1.8.9">1.8.9</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Server-Typ</label>
          <select id="m-mc-type" class="form-input">
            <option value="PAPER">Paper (empfohlen)</option>
            <option value="VANILLA">Vanilla</option>
            <option value="SPIGOT">Spigot</option>
            <option value="FABRIC">Fabric</option>
            <option value="FORGE">Forge</option>
            <option value="QUILT">Quilt</option>
            <option value="PURPUR">Purpur</option>
            <option value="BUNGEECORD">BungeeCord</option>
            <option value="VELOCITY">Velocity</option>
          </select>
        </div>
      </div>
    </div>
    <div class="form-group"><label class="form-label">Startup-Befehl (optional)</label><input type="text" id="m-cmd" class="form-input" placeholder="java -jar server.jar"/></div>
    <div class="form-group"><label class="form-label">Umgebungsvariablen (KEY=VALUE, eine pro Zeile)</label><textarea id="m-env" class="form-input" rows="3" placeholder="EULA=TRUE\nMEMORY=512M"></textarea></div>
    ${State.user.role==='admin'?`<div class="form-group"><label class="form-label">Besitzer (User-ID, leer = du selbst)</label><input type="text" id="m-userid" class="form-input" placeholder="User-ID (optional)"/></div>`:''}
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <!-- Quota-Anzeige -->
      <div id="cs-quota-bar" style="flex:1;font-size:11px;color:var(--text3)"></div>
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitCreateServer()">Server erstellen</button>
    </div>`, true);

  // Quota-Bar befüllen
  if (quota) {
    const u = quota.usage, q = quota.quota;
    const remServers = q.max_servers   - u.servers;
    const remRamGb   = ((q.max_ram_mb  - u.ram_mb)  / 1024).toFixed(1);
    const remCpu     = (q.max_cpu_cores - u.cpu_cores).toFixed(1);
    const qEl = document.getElementById('cs-quota-bar');
    if (qEl) {
      const warn = remServers <= 1 || (q.max_ram_mb - u.ram_mb) < 512;
      qEl.innerHTML = warn
        ? `<span style="color:var(--warn)"><i data-lucide="alert-triangle" style="width:11px;height:11px;vertical-align:-2px"></i> ${remServers} Server · ${remRamGb}GB RAM · ${remCpu} CPU frei</span>`
        : `<span style="color:var(--text3)"><i data-lucide="gauge" style="width:11px;height:11px;vertical-align:-2px"></i> ${remServers} Server · ${remRamGb}GB RAM · ${remCpu} CPU frei</span>`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }

  // Freie Port-Allocations als klickbare Badges rendern
  const allocEl = document.getElementById('m-alloc-list');
  if (allocEl) {
    const free = (allocs || []).filter(a => !a.server_id);
    if (free.length === 0) {
      allocEl.innerHTML = '<span class="text-muted" style="font-size:12px">Keine freien Allocations — unter Admin → Port Allocations anlegen</span>';
    } else {
      allocEl.innerHTML = free.map(a =>
        `<span data-selected="0" onclick="toggleAlloc(this,${a.port})"
          style="cursor:pointer;background:var(--card2);color:var(--success);border:1px solid var(--success);padding:3px 10px;border-radius:4px;font-size:12px;transition:background .15s"
        >${a.alias ? esc(a.alias)+' ' : ''}${a.ip||'0.0.0.0'}:${a.port}</span>`
      ).join('');
    }
  }
}


async function updateScalingPreview() {
  const nodeEl    = document.getElementById('m-node');
  const previewEl = document.getElementById('scaling-preview');
  const badgeEl   = document.getElementById('scaling-badge');
  if (!nodeEl || !previewEl) return;

  // Wenn manuell ein Node gewählt → kein Preview nötig
  if (nodeEl.value) {
    previewEl.style.display = 'none';
    if (badgeEl) badgeEl.textContent = '';
    return;
  }

  const mem_mb    = parseInt(document.getElementById('m-mem')?.value)  || 512;
  const disk_mb   = parseInt(document.getElementById('m-disk')?.value) || 5120;
  const cpu_cores = parseFloat(document.getElementById('m-cpu')?.value) || 1;

  try {
    const r = await API.post('/admin/scaling/preview', { mem_mb, disk_mb, cpu_cores });
    if (!previewEl) return;
    if (!r.node_id) {
      previewEl.innerHTML = '<span style="color:var(--color-text-danger)"><i data-lucide="alert-triangle"></i> Kein geeigneter Node verfügbar</span>';
      previewEl.style.display = 'block';
      if (badgeEl) badgeEl.textContent = '';
      if (window.lucide) lucide.createIcons();
      return;
    }
    // Score-Balken für alle Nodes
    const bars = (r.scores || []).map(s => {
      const pct = Math.max(0, Math.min(100, s.score));
      const chosen = s.node_id === r.node_id;
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="width:130px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${chosen?'var(--color-text-primary)':'var(--color-text-secondary)'};font-weight:${chosen?500:400}">${chosen?'→ ':''} ${esc(s.node_name)}</span>
        <div style="flex:1;background:var(--color-border-tertiary);border-radius:3px;height:6px">
          <div style="width:${pct}%;background:${chosen?'var(--color-text-success)':'var(--color-border-secondary)'};height:6px;border-radius:3px;transition:width .3s"></div>
        </div>
        <span style="width:38px;text-align:right;font-size:11px;color:var(--color-text-secondary)">${pct}%</span>
      </div>`;
    }).join('');
    previewEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
        <i data-lucide="git-branch" style="width:12px;height:12px;flex-shrink:0"></i>
        <span style="font-weight:500;color:var(--color-text-primary)">→ ${esc(r.node_name)}</span>
        <span style="color:var(--color-text-tertiary);font-size:11px">${esc(r.reason)}</span>
      </div>
      ${bars}`;
    previewEl.style.display = 'block';
    if (badgeEl) badgeEl.innerHTML = `<span style="color:var(--color-text-success)"><i data-lucide="check-circle"></i> Auto-Scaling aktiv</span>`;
    if (window.lucide) lucide.createIcons();
  } catch {
    if (previewEl) previewEl.style.display = 'none';
  }
}

async function onEggSelect(eggId) {
  if (!eggId) return;
  try {
    const egg = await API.get(`/eggs/${eggId}`);
    const imgEl = document.getElementById('m-image');
    const cmdEl = document.getElementById('m-cmd');
    const envEl = document.getElementById('m-env');
    const mcOpts = document.getElementById('m-minecraft-opts');
    if (imgEl && egg.docker_image) imgEl.value = egg.docker_image;
    if (cmdEl && egg.startup_command) cmdEl.value = egg.startup_command;
    if (envEl && egg.env_vars?.length) {
      envEl.value = egg.env_vars.map(v => `${v.key}=${v.default||''}`).join('\n');
    }
    // Minecraft-Optionen ein-/ausblenden
    const isMinecraft = egg.category === 'minecraft' || egg.docker_image.includes('minecraft');
    if (mcOpts) mcOpts.classList.toggle('hidden', !isMinecraft);
    toast(`Template "${egg.name}" geladen`, 'info');
  } catch {}
}

async function submitCreateServer() {
  const name = document.getElementById('m-name').value.trim();
  const image = document.getElementById('m-image').value.trim();
  const node_id = document.getElementById('m-node')?.value;
  if (!name || !image) { mErr('Name und Image sind erforderlich'); return; }

  const portsRaw = document.getElementById('m-ports').value.trim();
  const ports = portsRaw ? portsRaw.split(',').map(p => {
    const [h,c] = p.trim().split(':');
    return c ? { host: parseInt(h), container: parseInt(c) } : { host: parseInt(h), container: parseInt(h) };
  }) : [];
  const envRaw = document.getElementById('m-env').value.trim();
  const env_vars = {};
  if (envRaw) envRaw.split('\n').forEach(line => { const [k,...v]=line.split('='); if(k&&v.length) env_vars[k.trim()]=v.join('=').trim(); });
  // Minecraft VERSION + TYPE aus den Dropdowns einfügen (überschreiben ENV-Zeile falls vorhanden)
  const mcVersionEl = document.getElementById('m-mc-version');
  const mcTypeEl    = document.getElementById('m-mc-type');
  const mcOptsEl    = document.getElementById('m-minecraft-opts');
  if (mcVersionEl && mcOptsEl && !mcOptsEl.classList.contains('hidden')) {
    env_vars['VERSION'] = mcVersionEl.value;
    env_vars['TYPE']    = mcTypeEl?.value || 'PAPER';
    env_vars['EULA']    = 'TRUE';
  }

  const body = {
    name, image, node_id,
    description:     document.getElementById('m-desc').value.trim(),
    cpu_limit:       parseFloat(document.getElementById('m-cpu').value)||1,
    cpu_percent:     parseInt(document.getElementById('m-cpu-pct')?.value)||100,
    memory_limit:    parseInt(document.getElementById('m-mem').value)||512,
    disk_limit:      parseInt(document.getElementById('m-disk').value)||5120,
    startup_command: document.getElementById('m-cmd').value.trim(),
    ports, env_vars,
  };
  const uidEl = document.getElementById('m-userid');
  if (uidEl?.value.trim()) body.user_id = uidEl.value.trim();

  try {
    const srv = await API.post('/servers', body);
    toast('Server wird erstellt...', 'success');
    closeModal();
    navigate('server-detail', srv.id);
    loadServerCount();
  } catch (e) {
    if (e.quota_exceeded || e.message?.includes('Limit') || e.message?.includes('quota')) {
      // Show quota exceeded with details
      const details = e.details?.join('\n') || e.message;
      mErr('Quota überschritten: ' + e.message);
      // Highlight quota bar
      const qEl = document.getElementById('cs-quota-bar');
      if (qEl) { qEl.style.color = 'var(--danger)'; qEl.innerHTML = '<i data-lucide="alert-circle" style="width:11px;height:11px"></i> ' + esc(e.message); if (typeof lucide !== 'undefined') lucide.createIcons(); }
    } else {
      mErr(e.message);
    }
  }
}

async function showEditServer(id) {
  const s = await API.get(`/servers/${id}`);
  showModal(`
    <div class="modal-title"><span><i data-lucide="pencil"></i> Server bearbeiten</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group"><label class="form-label">Name</label><input type="text" id="m-name" class="form-input" value="${esc(s.name)}"/></div>
    <div class="form-group"><label class="form-label">Beschreibung</label><input type="text" id="m-desc" class="form-input" value="${esc(s.description||'')}"/></div>
    <div class="grid grid-3">
      <div class="form-group"><label class="form-label">CPU (%)</label><input type="number" id="m-cpu" class="form-input" value="${s.cpu_limit}"/></div>
      <div class="form-group"><label class="form-label">RAM (MB)</label><input type="number" id="m-mem" class="form-input" value="${s.memory_limit}"/></div>
      <div class="form-group"><label class="form-label">Startup</label><input type="text" id="m-cmd" class="form-input" value="${esc(s.startup_command||'')}"/></div>
    </div>
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitEditServer('${id}')">Speichern</button>
    </div>`);
}
async function submitEditServer(id) {
  try {
    await API.patch(`/servers/${id}`, { name:document.getElementById('m-name').value.trim(), description:document.getElementById('m-desc').value.trim(), cpu_limit:parseInt(document.getElementById('m-cpu').value), memory_limit:parseInt(document.getElementById('m-mem').value), startup_command:document.getElementById('m-cmd').value.trim() });
    toast('Gespeichert!','success'); closeModal(); navigate('server-detail',id);
  } catch (e) { mErr(e.message); }
}
function confirmDeleteServer(id, name) {
  showModal(`
    <div class="modal-title"><span style="color:var(--danger)"><i data-lucide="trash-2"></i> Server löschen</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <p>Server <strong>${esc(name)}</strong> und den Container permanent löschen?</p>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-danger" onclick="deleteServer('${id}')">Endgültig löschen</button>
    </div>`);
}
async function deleteServer(id) {
  try { await API.delete(`/servers/${id}`); toast('Server gelöscht','success'); closeModal(); navigate('servers'); loadServerCount(); } catch (e) { toast(e.message,'error'); }
}

// ─── SERVER KLONEN ────────────────────────────────────────────────────────────
function showCloneServer(id, name) {
  showModal(`
    <div class="modal-title"><span>⧉ Server klonen</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <p class="text-dim" style="margin-bottom:16px">Erstellt eine neue Instanz mit gleicher Konfiguration wie <strong>${esc(name)}</strong>.</p>
    <div class="form-group"><label class="form-label">Name des neuen Servers *</label><input id="m-clone-name" class="form-input" value="${esc(name)} (Kopie)"/></div>
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button><button class="btn btn-primary" onclick="submitClone('${id}')">Klonen</button></div>`);
}

async function submitClone(id) {
  const name = document.getElementById('m-clone-name').value.trim();
  const errEl = document.getElementById('m-error');
  if (!name) { errEl.textContent='Name erforderlich'; errEl.classList.remove('hidden'); return; }
  try {
    const newSrv = await API.post(`/servers/${id}/clone`, { name });
    toast('Server wird geklont...', 'success');
    closeModal();
    navigate('server-detail', newSrv.id);
  } catch(e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
}
