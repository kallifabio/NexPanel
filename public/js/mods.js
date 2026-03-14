/* NexPanel — mods.js
 * Mod/plugin manager + Pterodactyl import
 */

// ─── MOD / PLUGIN MANAGER ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const ModState = {
  platform:     null,
  activeTab:    'modrinth',
  searchQuery:  '',
  results:      [],
  installed:    [],
  updateData:   null,   // last check-updates result
  updateSettings: null,
  loading:      false,
};

const PLATFORM_ICONS = {
  minecraft: '<i data-lucide="pickaxe"></i>', source: '<i data-lucide="crosshair"></i>', valheim: '<i data-lucide="swords"></i>', generic: '<i data-lucide="package"></i>',
};
const LOADER_LABELS = {
  paper:'Paper', spigot:'Spigot', fabric:'Fabric', forge:'Forge',
  quilt:'Quilt', neoforge:'NeoForge', bungeecord:'BungeeCord', velocity:'Velocity',
};

async function modsInit(serverId) {
  const root = document.getElementById('mods-root');
  if (!root) return;
  root.innerHTML = '<div class="empty"><div class="empty-icon spin"><i data-lucide="puzzle"></i></div></div>';
  try {
    ModState.platform = await API.get(`/servers/${serverId}/mods/platform`);
  } catch (e) {
    root.innerHTML = `<div class="empty"><p class="text-danger">Fehler: ${esc(e.message)}</p></div>`;
    return;
  }
  if (!ModState.platform.container_ready) {
    root.innerHTML = '<div class="empty"><div class="empty-icon"><i data-lucide="loader-2" class="spin"></i></div><p>Container ist noch nicht bereit (wird installiert)</p></div>';
    return;
  }
  modsRender(serverId);
  modsLoadInstalled(serverId);
  modsLoadAutoUpdateSettings(serverId);
}

function modsRender(serverId) {
  const root = document.getElementById('mods-root');
  if (!root) return;
  const p = ModState.platform;
  const game = p?.game || 'generic';
  const loader = p?.loader || '';
  const pbClass = `pb-${game}`;
  const isMinecraft = game === 'minecraft';
  const isSource    = game === 'source';
  const isValheim   = game === 'valheim';

  // Determine which tabs to show
  const tabs = [];
  if (isMinecraft) { tabs.push({ id:'modrinth', label:'<i data-lucide="package-check"></i> Modrinth' }); }
  if (isMinecraft && p?.has_curseforge) { tabs.push({ id:'curseforge', label:'<i data-lucide="flame"></i> CurseForge' }); }
  if (isSource || isValheim) { tabs.push({ id:'workshop', label:'<i data-lucide="gamepad-2"></i> Steam Workshop' }); }
  tabs.push({ id:'github',  label:'<i data-lucide="github"></i> GitHub' });
  tabs.push({ id:'generic', label:'<i data-lucide="link"></i> Direkte URL' });

  if (!tabs.find(t => t.id === ModState.activeTab)) ModState.activeTab = tabs[0]?.id || 'generic';

  root.innerHTML = `
    <div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
        <span class="platform-badge ${pbClass}">
          ${PLATFORM_ICONS[game]||'<i data-lucide="package"></i>'} ${game.charAt(0).toUpperCase()+game.slice(1)}
          ${loader ? ` · ${LOADER_LABELS[loader]||loader}` : ''}
        </span>
        ${!p?.has_curseforge && isMinecraft ? '<span class="text-dim text-xs">CurseForge: CURSEFORGE_API_KEY nicht gesetzt</span>' : ''}
      </div>

      <div class="mods-layout">
        <!-- LEFT: Search + Results -->
        <div>
          <div class="mod-tabs">
            ${tabs.map(t => `<button class="mod-tab ${ModState.activeTab===t.id?'active':''}" onclick="modsSwitchTab('${t.id}','${serverId}')">${t.label}</button>`).join('')}
          </div>
          <div id="mods-search-area">
            ${modsRenderSearchArea(serverId)}
          </div>
        </div>

        <!-- RIGHT: Installed Mods + Updates -->
        <div>
          <div class="card">
            <div class="card-header">
              <div class="card-title"><i data-lucide="puzzle"></i> Installierte Mods</div>
              <div style="display:flex;gap:4px">
                <button class="btn btn-ghost btn-xs" title="Updates prüfen" onclick="modsCheckUpdates('${serverId}')"><i data-lucide="refresh-cw"></i> Updates</button>
                <button class="btn btn-ghost btn-xs" onclick="modsLoadInstalled('${serverId}')"><i data-lucide="rotate-ccw"></i></button>
              </div>
            </div>
            <div id="mods-update-bar" style="display:none"></div>
            <div id="mods-installed-list"><div class="text-dim text-sm" style="padding:8px">Lädt...</div></div>
          </div>
          <div class="card" style="margin-top:10px" id="mods-autoupdate-card">
            <div class="card-header" style="margin-bottom:10px">
              <div class="card-title"><i data-lucide="zap"></i> Auto-Update</div>
              <label class="toggle-wrap">
                <input type="checkbox" class="toggle-cb" id="mod-auto-update-cb"
                  onchange="modsSaveAutoUpdateSettings('${serverId}')">
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </label>
            </div>
            <div class="form-group" style="margin:0">
              <label class="form-label" style="font-size:11px">Prüfintervall</label>
              <select id="mod-check-interval" class="form-input" style="font-size:12px;padding:4px 8px"
                onchange="modsSaveAutoUpdateSettings('${serverId}')">
                <option value="1">Stündlich</option>
                <option value="3">Alle 3 Stunden</option>
                <option value="6" selected>Alle 6 Stunden</option>
                <option value="12">Alle 12 Stunden</option>
                <option value="24">Täglich</option>
                <option value="168">Wöchentlich</option>
              </select>
            </div>
            <div id="mod-update-log-btn" style="margin-top:8px">
              <button class="btn btn-ghost btn-xs" onclick="modsShowUpdateLog('${serverId}')"><i data-lucide="history"></i> Update-Verlauf</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function modsRenderSearchArea(serverId) {
  const tab = ModState.activeTab;
  if (tab === 'modrinth' || tab === 'curseforge') {
    return `
      <div class="mod-search-bar">
        <input type="text" class="form-input" id="mod-search-input"
          placeholder="Mod/Plugin suchen..." value="${esc(ModState.searchQuery)}"
          onkeydown="if(event.key==='Enter') modsSearch('${serverId}')"/>
        <button class="btn btn-primary btn-sm" onclick="modsSearch('${serverId}')">Suchen</button>
      </div>
      <div id="mod-results">${ModState.results.length ? modsRenderResults(serverId) : '<div class="empty" style="padding:24px"><p class="text-dim">Suche starten...</p></div>'}</div>`;
  }
  if (tab === 'workshop') {
    return `
      <div class="card" style="margin-bottom:12px">
        <div class="card-title" style="margin-bottom:12px">Steam Workshop installieren</div>
        <div class="form-group"><label class="form-label">Workshop Item ID</label>
          <input type="text" id="ws-id-input" class="form-input" placeholder="z.B. 2123456789"/>
        </div>
        <div class="form-group"><label class="form-label">AppID</label>
          <input type="text" id="ws-appid-input" class="form-input" value="730" placeholder="730 = CS2, 4000 = Garry's Mod"/>
        </div>
        <div class="modal-footer" style="margin:0;padding:0;border:none;justify-content:flex-start;margin-top:8px">
          <a href="https://steamcommunity.com/workshop/" target="_blank" class="btn btn-ghost btn-sm"><i data-lucide="external-link"></i> Workshop öffnen</a>
          <button class="btn btn-primary btn-sm" onclick="modsInstallWorkshop('${serverId}')"><i data-lucide="download"></i> Installieren</button>
        </div>
        <div id="mod-install-log" class="install-progress hidden"></div>
      </div>`;
  }
  if (tab === 'github') {
    return `
      <div class="card" style="margin-bottom:12px">
        <div class="card-title" style="margin-bottom:12px">GitHub Release herunterladen</div>
        <div class="form-group"><label class="form-label">Repository (owner/repo)</label>
          <input type="text" id="gh-repo-input" class="form-input" placeholder="EssentialsX/Essentials"/>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="modsLoadGithubReleases('${serverId}')"><i data-lucide="github"></i> Releases laden</button>
        <div id="mod-results" style="margin-top:12px"></div>
      </div>`;
  }
  if (tab === 'generic') {
    return `
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Direkte URL / beliebige Datei</div>
        <div class="form-group"><label class="form-label">Download-URL</label>
          <input type="text" id="generic-url-input" class="form-input" placeholder="https://example.com/myplugin-1.0.jar"/>
        </div>
        <div class="grid grid-2">
          <div class="form-group"><label class="form-label">Dateiname (optional)</label>
            <input type="text" id="generic-name-input" class="form-input" placeholder="myplugin.jar"/>
          </div>
          <div class="form-group"><label class="form-label">Zielordner im Container</label>
            <input type="text" id="generic-dest-input" class="form-input" placeholder="/home/container/plugins"/>
          </div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="modsInstallGeneric('${serverId}')"><i data-lucide="download"></i> Herunterladen & installieren</button>
        <div id="mod-install-log" class="install-progress hidden"></div>
      </div>`;
  }
  return '';
}

function modsRenderResults(serverId) {
  if (!ModState.results.length)
    return '<div class="empty" style="padding:24px"><p class="text-dim">Keine Ergebnisse</p></div>';
  return ModState.results.map(m => {
    const srcCls = `msb-${m.source||'modrinth'}`;
    const dlFmt  = m.downloads > 1e6 ? (m.downloads/1e6).toFixed(1)+'M' : m.downloads > 1e3 ? (m.downloads/1e3).toFixed(0)+'K' : m.downloads;
    return `
      <div class="mod-card" onclick="modsShowVersions('${serverId}','${m.id}','${esc(m.title)}','${m.source||ModState.activeTab}')">
        ${m.icon
          ? `<img class="mod-icon" src="${esc(m.icon)}" onerror="this.style.display='none'" loading="lazy"/>`
          : `<div class="mod-icon-placeholder"><i data-lucide="puzzle"></i></div>`}
        <div class="mod-info">
          <div class="mod-name">${esc(m.title)}</div>
          <div class="mod-desc">${esc(m.description||'')}</div>
          <div class="mod-meta">
            ${dlFmt ? `<span class="mod-dl">⬇ ${dlFmt}</span>` : ''}
            <span class="mod-source-badge ${srcCls}">${m.source||ModState.activeTab}</span>
            ${(m.categories||[]).slice(0,2).map(c=>`<span class="vtag">${esc(c)}</span>`).join('')}
            ${m.author ? `<span class="text-dim text-xs">by ${esc(m.author)}</span>` : ''}
          </div>
        </div>
        <button class="btn btn-ghost btn-xs" style="align-self:center;flex-shrink:0">Versionen →</button>
      </div>`;
  }).join('');
}

function modsSwitchTab(tab, serverId) {
  ModState.activeTab  = tab;
  ModState.results    = [];
  ModState.searchQuery = '';
  const area = document.getElementById('mods-search-area');
  if (area) area.innerHTML = modsRenderSearchArea(serverId);
  // also update tab buttons
  document.querySelectorAll('.mod-tab').forEach(b => b.classList.toggle('active', b.textContent.includes(
    {modrinth:'Modrinth', curseforge:'CurseForge', workshop:'Workshop', github:'GitHub', generic:'URL'}[tab]||tab
  )));
}

async function modsSearch(serverId) {
  const input = document.getElementById('mod-search-input');
  const q = input?.value.trim() || '';
  ModState.searchQuery = q;
  const tab = ModState.activeTab;
  const resultsEl = document.getElementById('mod-results');
  if (resultsEl) resultsEl.innerHTML = '<div class="empty" style="padding:16px"><div class="empty-icon spin"><i data-lucide="loader"></i></div></div>';
  try {
    let data;
    if (tab === 'modrinth') {
      data = await API.get(`/servers/${serverId}/mods/modrinth/search?q=${encodeURIComponent(q)}`);
      ModState.results = data.hits || [];
    } else if (tab === 'curseforge') {
      data = await API.get(`/servers/${serverId}/mods/curseforge/search?q=${encodeURIComponent(q)}`);
      ModState.results = data.hits || [];
    }
    if (resultsEl) resultsEl.innerHTML = modsRenderResults(serverId);
  } catch (e) {
    if (resultsEl) resultsEl.innerHTML = `<div class="empty" style="padding:16px"><p class="text-danger">Fehler: ${esc(e.message)}</p></div>`;
  }
}

async function modsShowVersions(serverId, projectId, name, source) {
  showModal(`
    <div class="modal-title"><span><i data-lucide="package"></i> ${esc(name)}</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="text-dim text-sm" style="margin-bottom:12px">Versionen laden...</div>
    <div id="version-list-content"><div class="empty"><div class="spin"></div></div></div>
  `, true);

  try {
    let versions = [];
    if (source === 'modrinth') {
      versions = await API.get(`/servers/${serverId}/mods/modrinth/project/${projectId}/versions`);
    } else if (source === 'curseforge') {
      versions = await API.get(`/servers/${serverId}/mods/curseforge/mod/${projectId}/files`);
    }
    const el = document.getElementById('version-list-content');
    if (!el) return;
    if (!versions.length) { el.innerHTML = '<div class="empty"><p>Keine Versionen gefunden</p></div>'; return; }
    el.innerHTML = `<div class="version-list">` + versions.map(v => {
      const files = v.files || [];
      const primaryFile = files.find(f=>f.primary) || files[0] || { url: v.url, filename: v.filename||v.name };
      const mcVers = (v.game_versions||[]).slice(0,3).map(gv=>`<span class="vtag mc">${esc(gv)}</span>`).join('');
      const loaders = (v.loaders||[]).map(l=>`<span class="vtag loader">${esc(l)}</span>`).join('');
      return `
        <div class="version-row" onclick="modsInstallFile('${serverId}','${esc(primaryFile.url||'')}','${esc(primaryFile.filename||primaryFile.name||'')}','${source}','${esc(name)}')">
          <div class="version-name">${esc(v.name||v.version||v.tag||'Unbekannt')}</div>
          <div class="version-tags">${mcVers}${loaders}</div>
          <span class="btn btn-ghost btn-xs">⬇ Installieren</span>
        </div>`;
    }).join('') + '</div>';
  } catch (e) {
    const el = document.getElementById('version-list-content');
    if (el) el.innerHTML = `<div class="empty"><p class="text-danger">${esc(e.message)}</p></div>`;
  }
}

async function modsInstallFile(serverId, url, filename, source, modName) {
  if (!url) { toast('Keine Download-URL verfügbar', 'error'); return; }
  closeModal();
  toast(`⬇ ${modName} wird installiert...`, 'info');
  try {
    const result = await API.post(`/servers/${serverId}/mods/install`, {
      url, filename, source, mod_name: modName,
    });
    if (result.success) {
      toast(`<i data-lucide="check-circle"></i> ${filename} installiert (${fmtBytes(result.file_size)})`, 'success');
      modsLoadInstalled(serverId);
    } else {
      toast('Installation fehlgeschlagen: ' + (result.output||'').slice(-100), 'error');
    }
  } catch (e) { toast('Fehler: '+e.message, 'error'); }
}

async function modsInstallWorkshop(serverId) {
  const wsId   = document.getElementById('ws-id-input')?.value.trim();
  const appId  = document.getElementById('ws-appid-input')?.value.trim() || '730';
  const logEl  = document.getElementById('mod-install-log');
  if (!wsId) { toast('Workshop-ID erforderlich', 'error'); return; }
  if (logEl) { logEl.classList.remove('hidden'); logEl.textContent = ' Starte steamcmd Download...\n'; }
  try {
    const result = await API.post(`/servers/${serverId}/mods/install`, {
      source: 'workshop', workshop_id: wsId, appid: appId,
    });
    if (logEl) logEl.textContent += result.output || '';
    if (result.success) { toast('<i data-lucide="check-circle"></i> Workshop-Item installiert!', 'success'); modsLoadInstalled(serverId); }
    else { toast('Installation fehlgeschlagen', 'error'); }
  } catch (e) {
    if (logEl) logEl.textContent += 'Fehler: ' + e.message;
    toast('Fehler: '+e.message, 'error');
  }
}

async function modsInstallGeneric(serverId) {
  const url      = document.getElementById('generic-url-input')?.value.trim();
  const filename = document.getElementById('generic-name-input')?.value.trim() || '';
  const dest     = document.getElementById('generic-dest-input')?.value.trim() || '';
  const logEl    = document.getElementById('mod-install-log');
  if (!url) { toast('URL erforderlich', 'error'); return; }
  if (logEl) { logEl.classList.remove('hidden'); logEl.textContent = ` Lade herunter: ${url}\n`; }
  try {
    const result = await API.post(`/servers/${serverId}/mods/install`, {
      url, filename: filename || undefined, dest_dir: dest || undefined, source: 'generic',
    });
    if (logEl) logEl.textContent += (result.output || '') + (result.success ? '\n' + '<i data-lucide="check-circle"></i> Fertig!' : '\n' + '<i data-lucide="x-circle"></i> Fehler');
    if (result.success) {
      toast(`<i data-lucide="check-circle"></i> ${result.filename} installiert (${fmtBytes(result.file_size)})`, 'success');
      modsLoadInstalled(serverId);
    } else { toast('Download fehlgeschlagen', 'error'); }
  } catch (e) {
    if (logEl) logEl.textContent += 'Fehler: ' + e.message;
    toast('Fehler: '+e.message, 'error');
  }
}

async function modsLoadGithubReleases(serverId) {
  const repo  = document.getElementById('gh-repo-input')?.value.trim();
  const resEl = document.getElementById('mod-results');
  if (!repo) { toast('Repository erforderlich (owner/repo)', 'error'); return; }
  if (resEl) resEl.innerHTML = '<div class="empty" style="padding:12px"><div class="spin"></div></div>';
  try {
    const releases = await API.get(`/servers/${serverId}/mods/github/releases?repo=${encodeURIComponent(repo)}`);
    if (!releases.length) { if(resEl) resEl.innerHTML='<div class="empty" style="padding:12px"><p class="text-dim">Keine Releases</p></div>'; return; }
    if (resEl) resEl.innerHTML = releases.map(r => {
      const assets = r.assets || [];
      return `
        <div class="card" style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="font-weight:600">${esc(r.name||r.tag)}</span>
            <span class="vtag">${esc(r.tag)}</span>
            ${r.prerelease?'<span class="vtag" style="color:var(--warn)">pre-release</span>':''}
          </div>
          ${r.body?`<p class="text-dim text-xs" style="margin-bottom:8px;line-height:1.5">${esc(r.body)}</p>`:''}
          <div style="display:flex;flex-direction:column;gap:5px">
            ${assets.length ? assets.map(a=>`
              <div style="display:flex;align-items:center;gap:8px">
                <span class="text-mono text-sm flex-1">${esc(a.name)}</span>
                <span class="text-dim text-xs">${fmtBytes(a.size)}</span>
                <button class="btn btn-ghost btn-xs" onclick="modsInstallFile('${serverId}','${esc(a.url)}','${esc(a.name)}','github','${esc(a.name)}')">⬇ Install</button>
              </div>`).join('')
              : '<span class="text-dim text-xs">Keine Assets in diesem Release</span>'}
          </div>
        </div>`;
    }).join('');
  } catch(e) {
    if(resEl) resEl.innerHTML = `<div class="empty"><p class="text-danger">${esc(e.message)}</p></div>`;
  }
}

async function modsLoadInstalled(serverId) {
  const el = document.getElementById('mods-installed-list');
  if (!el) return;
  try {
    const mods = await API.get(`/servers/${serverId}/mods/installed`);
    ModState.installed = mods;
    modsRenderInstalledList(serverId, mods);
  } catch {
    el.innerHTML = '<div class="text-dim text-sm" style="padding:12px">Fehler beim Laden</div>';
  }
}

function modsRenderInstalledList(serverId, mods) {
  const el = document.getElementById('mods-installed-list');
  if (!el) return;
  if (!mods.length) {
    el.innerHTML = '<div class="text-dim text-sm" style="padding:12px;text-align:center">Keine Mods gefunden</div>';
    return;
  }
  // Build update-status map from last check
  const updateMap = {};
  if (ModState.updateData?.updates) {
    for (const u of ModState.updateData.updates) {
      updateMap[u.name] = u;
    }
  }
  el.innerHTML = mods.map(m => {
    const upd = updateMap[m.name];
    const hasUpd  = upd?.has_update;
    const isTrack = upd?.status === 'tracked';
    const badge = hasUpd
      ? `<span style="background:rgba(251,191,36,.15);color:#d97706;border:1px solid rgba(251,191,36,.3);border-radius:10px;font-size:10px;padding:2px 7px;font-weight:600"><i data-lucide="arrow-up-circle" style="width:9px;height:9px"></i> Update</span>`
      : isTrack
        ? `<span style="background:rgba(34,197,94,.1);color:#16a34a;border-radius:10px;font-size:10px;padding:2px 7px"><i data-lucide="check" style="width:9px;height:9px"></i></span>`
        : '';
    return `
      <div class="installed-mod-row" style="${hasUpd?'background:rgba(251,191,36,.04);border-left:2px solid rgba(251,191,36,.4);':''}" >
        ${upd?.project_icon
          ? `<img src="${esc(upd.project_icon)}" style="width:28px;height:28px;border-radius:4px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">`
          : `<span class="mod-ext-badge">${esc(m.ext)}</span>`}
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px">
            <div class="text-sm" style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(upd?.project_title || m.name)}</div>
            ${badge}
          </div>
          <div class="text-xs text-dim">
            ${isTrack ? `v${esc(upd.installed_version)} · ` : ''}${fmtBytes(m.size)} · ${esc(m.date)}
            ${hasUpd ? `→ <span style="color:#d97706">v${esc(upd.latest?.version_number||'?')}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:3px;flex-shrink:0">
          ${hasUpd ? `
            <button class="btn btn-ghost btn-xs" style="color:#d97706" title="Changelog" onclick="modsShowChangelog('${serverId}','${esc(upd.project_id)}','${esc(upd.latest?.version_id||'')}','${esc(upd.project_title||m.name)}','${esc(upd.installed_version||'')}','${esc(upd.latest?.version_number||'')}')" ><i data-lucide="file-text"></i></button>
            <button class="btn btn-ghost btn-xs" style="color:#d97706" title="Update" onclick="modsDoUpdate('${serverId}',${JSON.stringify(JSON.stringify(upd)).slice(1,-1).replace(/'/g,'&#39;')})" ><i data-lucide="download"></i></button>
          ` : ''}
          <button class="btn btn-ghost btn-xs text-danger" title="Entfernen"
            onclick="modsDelete('${serverId}','${esc(m.dir+'/'+m.name)}','${esc(m.name)}')" ><i data-lucide="trash-2"></i></button>
        </div>
      </div>`;
  }).join('');
  if (window.lucide) lucide.createIcons();
}

// ══════════════════════════════════════════════════════════════════════════════
// MOD UPDATE FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

// ── Updates prüfen ────────────────────────────────────────────────────────────
async function modsCheckUpdates(serverId) {
  const bar = document.getElementById('mods-update-bar');
  const el  = document.getElementById('mods-installed-list');
  if (bar) {
    bar.style.display = 'block';
    bar.innerHTML = `<div style="padding:10px 14px;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--color-text-secondary);border-bottom:1px solid var(--color-border-tertiary)">
      <div class="empty-icon spin" style="width:14px;height:14px;margin:0"><i data-lucide="loader" style="width:14px;height:14px"></i></div>
      Hashes berechnen und Modrinth befragen…
    </div>`;
    if (window.lucide) lucide.createIcons();
  }
  try {
    const result = await API.post(`/servers/${serverId}/mods/check-updates`, {});
    ModState.updateData = result;

    const upd = result.has_updates;
    if (bar) {
      if (upd > 0) {
        bar.innerHTML = `<div style="padding:8px 14px;display:flex;align-items:center;gap:10px;background:rgba(251,191,36,.06);border-bottom:1px solid rgba(251,191,36,.2)">
          <i data-lucide="arrow-up-circle" style="width:14px;height:14px;color:#d97706;flex-shrink:0"></i>
          <span style="flex:1;font-size:12px"><strong style="color:#d97706">${upd} Update${upd>1?'s':''}</strong> verfügbar für ${result.checked} erkannte Mods</span>
          <button class="btn btn-sm" style="background:rgba(251,191,36,.2);color:#d97706;border:1px solid rgba(251,191,36,.3)" onclick="modsUpdateAll('${serverId}')"><i data-lucide="download"></i> Alle updaten</button>
        </div>`;
      } else {
        bar.innerHTML = `<div style="padding:8px 14px;display:flex;align-items:center;gap:8px;font-size:12px;color:#16a34a;border-bottom:1px solid var(--color-border-tertiary)">
          <i data-lucide="check-circle" style="width:13px;height:13px"></i>
          Alle ${result.checked} erkannten Mods sind aktuell. ${result.untracked > 0 ? `(${result.untracked} nicht auf Modrinth)` : ''}
        </div>`;
        setTimeout(() => { if (bar) bar.style.display = 'none'; }, 5000);
      }
      if (window.lucide) lucide.createIcons();
    }
    // Re-render list with update badges
    modsRenderInstalledList(serverId, ModState.installed);
  } catch (e) {
    if (bar) {
      bar.innerHTML = `<div style="padding:8px 14px;font-size:12px;color:var(--color-text-danger);border-bottom:1px solid var(--color-border-tertiary)">
        <i data-lucide="x-circle" style="width:12px;height:12px"></i> Fehler: ${esc(e.message)}</div>`;
      if (window.lucide) lucide.createIcons();
    }
  }
}

// ── Einzelnen Mod updaten ──────────────────────────────────────────────────────
async function modsDoUpdate(serverId, updJson) {
  let upd;
  try { upd = JSON.parse(updJson); } catch { toast('Ungültige Update-Daten', 'error'); return; }
  if (!upd?.latest?.download_url) { toast('Keine Download-URL', 'error'); return; }

  const name = upd.project_title || upd.name;
  toast(`⬇ ${name} wird aktualisiert…`, 'info');
  try {
    const result = await API.post(`/servers/${serverId}/mods/update`, {
      old_path:      `${upd.dir}/${upd.name}`,
      old_version:   upd.installed_version,
      new_version:   upd.latest.version_number,
      project_id:    upd.project_id,
      project_title: upd.project_title,
      download_url:  upd.latest.download_url,
      filename:      upd.latest.filename,
      dir:           upd.dir,
    });
    if (result.success) {
      toast(`${name} → v${upd.latest.version_number} (${fmtBytes(result.file_size)})`, 'success');
      // Mark as updated in local state
      if (ModState.updateData?.updates) {
        const idx = ModState.updateData.updates.findIndex(u => u.name === upd.name);
        if (idx >= 0) ModState.updateData.updates[idx].has_update = false;
      }
      await modsLoadInstalled(serverId);
    } else {
      toast('Update fehlgeschlagen', 'error');
    }
  } catch (e) { toast('Fehler: ' + e.message, 'error'); }
}

// ── Alle Updates auf einmal ────────────────────────────────────────────────────
async function modsUpdateAll(serverId) {
  const updates = ModState.updateData?.updates?.filter(u => u.has_update) || [];
  if (!updates.length) { toast('Keine Updates verfügbar', 'info'); return; }
  if (!confirm(`${updates.length} Mod(s) aktualisieren?\n${updates.map(u=>u.project_title||u.name).join(', ')}`)) return;

  const bar = document.getElementById('mods-update-bar');
  if (bar) bar.innerHTML = `<div style="padding:8px 14px;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--color-text-secondary)">
    <div class="empty-icon spin" style="width:14px;height:14px;margin:0"><i data-lucide="loader" style="width:14px;height:14px"></i></div>
    Aktualisiere ${updates.length} Mod(s)…
  </div>`;
  if (window.lucide) lucide.createIcons();

  try {
    const result = await API.post(`/servers/${serverId}/mods/update-all`, { updates });
    const ok     = result.updated || 0;
    const total  = result.total || 0;

    if (bar) {
      bar.innerHTML = `<div style="padding:8px 14px;font-size:12px;color:#16a34a;border-bottom:1px solid var(--color-border-tertiary)">
        <i data-lucide="check-circle" style="width:12px;height:12px"></i> ${ok}/${total} Mods aktualisiert
      </div>`;
      if (window.lucide) lucide.createIcons();
      setTimeout(() => { if (bar) bar.style.display = 'none'; }, 5000);
    }

    toast(`${ok} von ${total} Mods aktualisiert`, ok === total ? 'success' : 'warn');
    if (ModState.updateData?.updates) {
      ModState.updateData.updates.forEach(u => { if (u.has_update) u.has_update = false; });
    }
    await modsLoadInstalled(serverId);
  } catch (e) {
    toast('Fehler beim Update-All: ' + e.message, 'error');
  }
}

// ── Changelog Modal ────────────────────────────────────────────────────────────
async function modsShowChangelog(serverId, projectId, versionId, name, oldVer, newVer) {
  showModal(`
    <div class="modal-title">
      <span><i data-lucide="file-text"></i> Changelog — ${esc(name)}</span>
      <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:12px">
      <span style="background:var(--color-background-secondary);padding:3px 9px;border-radius:12px;color:var(--color-text-tertiary)">v${esc(oldVer)}</span>
      <i data-lucide="arrow-right" style="width:12px;height:12px;color:var(--color-text-tertiary)"></i>
      <span style="background:rgba(251,191,36,.15);color:#d97706;padding:3px 9px;border-radius:12px;font-weight:500">v${esc(newVer)}</span>
    </div>
    <div id="changelog-content">
      <div class="empty"><div class="empty-icon spin"><i data-lucide="loader"></i></div></div>
    </div>
    <div class="modal-footer" id="changelog-footer" style="display:none">
      <a id="changelog-modrinth-link" href="#" target="_blank" class="btn btn-ghost"><i data-lucide="external-link"></i> Auf Modrinth</a>
      <button class="btn btn-primary" onclick="modsDoUpdateFromChangelog('${serverId}')">
        <i data-lucide="download"></i> Jetzt updaten
      </button>
    </div>
  `, false);
  if (window.lucide) lucide.createIcons();

  try {
    const cl = await API.get(`/servers/${serverId}/mods/changelog/${projectId}/${versionId}`);
    const el = document.getElementById('changelog-content');
    if (!el) return;

    // Simple markdown-like rendering for changelog
    const rendered = esc(cl.changelog || 'Kein Changelog verfügbar.')
      .replace(/^### (.+)$/gm, '<strong style="font-size:12px;color:var(--color-text-secondary)">$1</strong>')
      .replace(/^## (.+)$/gm, '<strong>$1</strong>')
      .replace(/^# (.+)$/gm, '<strong style="font-size:15px">$1</strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code style="font-family:var(--font-mono);background:var(--color-background-secondary);padding:1px 4px;border-radius:3px;font-size:11px">$1</code>')
      .replace(/^- (.+)$/gm, '<div style="padding-left:12px;margin:2px 0">• $1</div>')
      .replace(/\n/g, '<br>');

    el.innerHTML = `
      <div style="font-size:12px;line-height:1.7;color:var(--color-text-secondary);max-height:380px;overflow-y:auto;padding-right:4px">
        ${rendered}
      </div>
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--color-border-tertiary);display:flex;gap:12px;font-size:11px;color:var(--color-text-tertiary)">
        <span><i data-lucide="download" style="width:10px;height:10px"></i> ${(cl.downloads||0).toLocaleString('de-DE')} Downloads</span>
        <span><i data-lucide="calendar" style="width:10px;height:10px"></i> ${new Date(cl.date||'').toLocaleDateString('de-DE')}</span>
        ${(cl.game_versions||[]).slice(0,3).map(v=>`<span>${esc(v)}</span>`).join('')}
      </div>`;

    const footer = document.getElementById('changelog-footer');
    if (footer) footer.style.display = 'flex';
    const link = document.getElementById('changelog-modrinth-link');
    if (link) link.href = `https://modrinth.com/project/${projectId}/version/${versionId}`;
    if (window.lucide) lucide.createIcons();

    // Store context for update button
    window._pendingModUpdate = { serverId, projectId, versionId, name };
  } catch (e) {
    const el = document.getElementById('changelog-content');
    if (el) el.innerHTML = `<p class="text-dim text-sm">${esc(e.message)}</p>`;
  }
}

function modsDoUpdateFromChangelog(serverId) {
  closeModal();
  const pending = window._pendingModUpdate;
  if (!pending) return;
  const upd = ModState.updateData?.updates?.find(u => u.project_id === pending.projectId);
  if (upd) modsDoUpdate(serverId, JSON.stringify(upd));
}

// ── Auto-Update Settings ───────────────────────────────────────────────────────
async function modsLoadAutoUpdateSettings(serverId) {
  try {
    const s = await API.get(`/servers/${serverId}/mods/update-settings`);
    ModState.updateSettings = s;
    const cb = document.getElementById('mod-auto-update-cb');
    const sel = document.getElementById('mod-check-interval');
    if (cb)  cb.checked = !!s.auto_update;
    if (sel) sel.value  = String(s.check_interval_h || 6);

    // Show last-check info
    if (s.last_check_at) {
      const btn = document.getElementById('mod-update-log-btn');
      if (btn) {
        const diff = Math.round((Date.now() - new Date(s.last_check_at).getTime()) / 60000);
        const ago  = diff < 60 ? `vor ${diff} min` : diff < 1440 ? `vor ${Math.round(diff/60)} h` : `vor ${Math.round(diff/1440)} d`;
        btn.innerHTML = `<button class="btn btn-ghost btn-xs" onclick="modsShowUpdateLog('${serverId}')"><i data-lucide="history"></i> Update-Verlauf</button>
          <span class="text-dim" style="font-size:10px;margin-left:6px">Zuletzt: ${ago}</span>`;
        if (window.lucide) lucide.createIcons();
      }
    }
  } catch {}
}

async function modsSaveAutoUpdateSettings(serverId) {
  try {
    await API.put(`/servers/${serverId}/mods/update-settings`, {
      auto_update:       document.getElementById('mod-auto-update-cb')?.checked ? 1 : 0,
      check_interval_h:  parseInt(document.getElementById('mod-check-interval')?.value || 6),
      notify_on_update:  1,
    });
    toast('Auto-Update Einstellungen gespeichert', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Update-Verlauf Modal ───────────────────────────────────────────────────────
async function modsShowUpdateLog(serverId) {
  showModal(`
    <div class="modal-title">
      <span><i data-lucide="history"></i> Update-Verlauf</span>
      <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
    </div>
    <div id="update-log-content">
      <div class="empty"><div class="empty-icon spin"><i data-lucide="loader"></i></div></div>
    </div>
  `, false);
  if (window.lucide) lucide.createIcons();

  try {
    const logs = await API.get(`/servers/${serverId}/mods/update-log`);
    const el   = document.getElementById('update-log-content');
    if (!el) return;

    if (!logs.length) {
      el.innerHTML = '<div class="empty" style="padding:20px"><p class="text-dim">Noch keine Updates durchgeführt</p></div>';
      return;
    }

    el.innerHTML = `<div style="max-height:400px;overflow-y:auto">
      <table class="table" style="font-size:12px">
        <thead><tr>
          <th>Mod</th><th>Alt</th><th style="color:#d97706">Neu</th><th>Status</th><th>Zeit</th>
        </tr></thead>
        <tbody>
          ${logs.map(l => `<tr>
            <td style="font-weight:500">${esc(l.mod_name)}</td>
            <td class="text-dim">${esc(l.old_version||'?')}</td>
            <td style="color:#16a34a">${esc(l.new_version||'?')}</td>
            <td><span style="font-size:10px;padding:2px 7px;border-radius:10px;background:${l.status==='updated'?'rgba(34,197,94,.1)':'rgba(239,68,68,.1)'};color:${l.status==='updated'?'#16a34a':'#ef4444'}">${esc(l.status)}</span></td>
            <td class="text-dim">${new Date(l.updated_at).toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  } catch (e) {
    const el = document.getElementById('update-log-content');
    if (el) el.innerHTML = `<p class="text-dim">${esc(e.message)}</p>`;
  }
}


async function modsDelete(serverId, path, name) {
  if (!confirm(`"${name}" wirklich entfernen?`)) return;
  try {
    await API.delete(`/servers/${serverId}/mods/installed`, { path });
    toast(`${name} entfernt`, 'success');
    modsLoadInstalled(serverId);
  } catch (e) { toast(e.message, 'error'); }
}
