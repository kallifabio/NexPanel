/* NexPanel — server-tabs.js
 * Server detail tabs: ports, schedule, subusers, backups, startup, sftp, alerts
 */

// ─── NETZWERK / PORTS ────────────────────────────────────────────────────────
async function networkInit(serverId) {
  const root = document.getElementById('network-root');
  if (!root) return;
  root.innerHTML = '<div class="empty"><div class="empty-icon spin"><i data-lucide="loader"></i></div></div>';
  try {
    const [ports, allocs] = await Promise.all([
      API.get(`/servers/${serverId}/ports`),
      API.get(`/allocations`).catch(() => [])
    ]);
    const srv = State.server || {};
    const nodeId = srv.node_id;

    // Fallback: wenn keine Allocations vorhanden, Server-Ports aus JSON anzeigen
    let effectivePorts = ports;
    if (ports.length === 0 && Array.isArray(srv.ports) && srv.ports.length > 0) {
      // Ports aus server.ports synthetisch anzeigen (noch nicht in port_allocations)
      effectivePorts = srv.ports.map((p, i) => ({
        id: null,
        ip: '0.0.0.0',
        port: p.host || p,
        is_primary: i === 0 ? 1 : 0,
        notes: '',
        _synthetic: true,
      }));
    }

    // Free allocations for this node (not yet assigned)
    const freeAllocs = allocs.filter(a => !a.server_id && a.node_id === nodeId);

    root.innerHTML = networkRender(effectivePorts, freeAllocs, serverId);
  } catch(e) {
    root.innerHTML = `<div class="empty"><p>Fehler: ${esc(e.message)}</p></div>`;
  }
}

function networkRender(ports, freeAllocs, serverId) {
  const primaryPort = ports.find(p => p.is_primary);
  const secondaryPorts = ports.filter(p => !p.is_primary);

  const portRows = ports.map(p => `
    <div class="network-port-row ${p.is_primary ? 'is-primary' : ''}">
      <div class="network-port-left">
        <span class="network-icon"><i data-lucide="network"></i></span>
        <div>
          <div class="network-badges">
            <span class="badge-ip">${esc(p.ip === '0.0.0.0' ? (State.server?.node_fqdn || p.ip) : p.ip)}</span>
            <span class="badge-port">${p.port}</span>
          </div>
          <div class="network-labels"><span>IP ADDRESS</span><span>PORT</span></div>
        </div>
      </div>
      <div class="network-notes">
        <input type="text" class="form-input network-notes-input" value="${esc(p.notes||'')}"
          placeholder="Notizen..."
          onblur="networkSaveNotes('${serverId}','${p.id}',this.value)"/>
      </div>
      <div class="network-actions">
        ${p._synthetic
          ? '<span class="text-dim text-sm">Wird beim Neustart registriert</span>'
          : p.is_primary
            ? '<span class="btn btn-primary btn-sm" style="cursor:default">Primary</span>'
            : `<button class="btn btn-danger btn-sm" onclick="networkRemovePort('${serverId}','${p.id}')" title="Port entfernen"><i data-lucide="trash-2"></i></button>
               <button class="btn btn-secondary btn-sm" onclick="networkSetPrimary('${serverId}','${p.id}')">Make Primary</button>`
        }
      </div>
    </div>`).join('');

  const freeSection = freeAllocs.length ? `
    <div class="card" style="margin-top:16px">
      <div class="card-title" style="margin-bottom:12px"><i data-lucide="plus"></i> Port hinzufügen</div>
      <div class="network-add-ports">
        ${freeAllocs.map(a => `
          <button class="badge-alloc" onclick="networkAddPort('${serverId}','${a.id}')">
            ${esc(a.ip === '0.0.0.0' ? (State.server?.node_fqdn || a.ip) : a.ip)}:<strong>${a.port}</strong>
          </button>`).join('')}
      </div>
    </div>` : '';

  return `
    <div class="card">
      <div class="card-title" style="margin-bottom:16px"><i data-lucide="globe"></i> Port-Zuweisung</div>
      ${ports.length ? portRows : '<div class="empty" style="padding:20px"><p>Noch keine Ports zugewiesen</p></div>'}
    </div>
    ${freeSection}`;
}

async function networkSetPrimary(serverId, allocId) {
  try {
    await API.put(`/servers/${serverId}/ports/${allocId}/primary`, {});
    networkInit(serverId);
  } catch(e) { toast(e.message, 'error'); }
}

async function networkRemovePort(serverId, allocId) {
  try {
    await API.delete(`/servers/${serverId}/ports/${allocId}`);
    toast('Port entfernt', 'success');
    networkInit(serverId);
  } catch(e) { toast(e.message, 'error'); }
}

async function networkAddPort(serverId, allocId) {
  try {
    await API.post(`/servers/${serverId}/ports`, { alloc_id: allocId });
    toast('Port hinzugefügt', 'success');
    networkInit(serverId);
  } catch(e) { toast(e.message, 'error'); }
}

async function networkSaveNotes(serverId, allocId, notes) {
  try {
    await API.put(`/servers/${serverId}/ports/${allocId}/notes`, { notes });
  } catch(e) { /* still */ }
}


// ─── SCHEDULED TASKS ─────────────────────────────────────────────────────────
async function scheduleInit(serverId) {
  const root = document.getElementById('schedule-root');
  if (!root) return;
  root.innerHTML = '<div class="empty"><div class="empty-icon"><i data-lucide="loader-2" class="spin"></i></div></div>';
  try {
    const tasks = await API.get(`/servers/${serverId}/schedule`);
    root.innerHTML = `
      <div class="card">
        <div class="card-title" style="margin-bottom:16px;display:flex;justify-content:space-between;align-items:center">
          <span><i data-lucide="clock"></i> Geplante Aufgaben</span>
          <button class="btn btn-primary btn-sm" onclick="showCreateTask('${serverId}')">＋ Task erstellen</button>
        </div>
        ${tasks.length === 0
          ? '<div class="empty" style="padding:24px"><p>Noch keine Tasks erstellt</p></div>'
          : `<table class="table">
              <thead><tr><th>Name</th><th>Aktion</th><th>Cron</th><th>Zuletzt</th><th>Status</th><th></th></tr></thead>
              <tbody>${tasks.map(t => `<tr>
                <td><span style="font-weight:600">${esc(t.name)}</span>${t.payload?`<div class="text-mono text-sm text-dim" style="max-width:180px;overflow:hidden;text-overflow:ellipsis">${esc(t.payload)}</div>`:''}</td>
                <td><span class="badge-action ${t.action}">${t.action}</span></td>
                <td class="text-mono text-sm">${esc(t.cron)}<div class="text-dim text-sm">${cronHuman(t.cron)}</div></td>
                <td class="text-sm text-dim">${t.last_run ? new Date(t.last_run).toLocaleString('de-DE') : '—'}</td>
                <td>${t.enabled ? '<span style="color:var(--success)">●</span>' : '<span style="color:var(--text3)">●</span>'}</td>
                <td style="display:flex;gap:6px">
                  <button class="btn btn-ghost btn-xs" onclick="taskRun('${serverId}','${t.id}')" title="Jetzt ausführen"><i data-lucide="play"></i></button>
                  <button class="btn btn-ghost btn-xs" onclick="taskToggle('${serverId}','${t.id}',${t.enabled?0:1})" title="${t.enabled?'Deaktivieren':'Aktivieren'}">${t.enabled?'<i data-lucide="pause"></i>':'<i data-lucide="play"></i>'}</button>
                  <button class="btn btn-ghost btn-xs text-danger" onclick="taskDelete('${serverId}','${t.id}')"><i data-lucide="trash-2"></i></button>
                </td>
              </tr>`).join('')}</tbody>
            </table>`}
      </div>
      <div class="card" style="margin-top:12px">
        <div class="card-title" style="margin-bottom:8px"><i data-lucide="book-open"></i> Cron-Format</div>
        <div class="text-mono text-sm" style="color:var(--text2);line-height:2">
          ┌─── Minute (0–59)<br>
          │ ┌─── Stunde (0–23)<br>
          │ │ ┌─── Tag (1–31)<br>
          │ │ │ ┌─── Monat (1–12)<br>
          │ │ │ │ ┌─── Wochentag (0–7, 0/7=So)<br>
          │ │ │ │ │<br>
          <span style="color:var(--accent)">* * * * *</span>
        </div>
        <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px">
          ${[['0 6 * * *','tägl. 06:00'],['0 */6 * * *','alle 6h'],['0 0 * * 0','Sonntag 00:00'],['*/30 * * * *','alle 30min'],['0 4 * * 1-5','Mo–Fr 04:00']].map(([c,l])=>`<button class="badge-alloc text-sm" onclick="document.getElementById('m-cron')&&(document.getElementById('m-cron').value='${c}')">${esc(l)}<span class="text-mono text-dim" style="margin-left:6px">${c}</span></button>`).join('')}
        </div>
      </div>`;
  } catch(e) {
    root.innerHTML = `<div class="empty"><p>Fehler: ${esc(e.message)}</p></div>`;
  }
}

function cronHuman(expr) {
  const presets = {
    '0 * * * *': 'Stündlich','0 0 * * *': 'Täglich 00:00','0 6 * * *': 'Täglich 06:00',
    '0 */6 * * *': 'Alle 6 Stunden','0 0 * * 0': 'Wöchentlich (So)','*/5 * * * *': 'Alle 5 min',
    '*/30 * * * *': 'Alle 30 min',
  };
  return presets[expr] || '';
}

function showCreateTask(serverId) {
  showModal(`
    <div class="modal-title"><span><i data-lucide="clock"></i> Task erstellen</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group"><label class="form-label">Name *</label><input id="m-tname" class="form-input" placeholder="Nächtlicher Neustart"/></div>
    <div class="form-group"><label class="form-label">Aktion *</label>
      <select id="m-taction" class="form-input" onchange="document.getElementById('m-payload-row').classList.toggle('hidden',this.value!=='command')">
        <option value="restart"><i data-lucide="rotate-ccw"></i> Restart</option>
        <option value="stop"><i data-lucide="square"></i> Stop</option>
        <option value="start"><i data-lucide="play"></i> Start</option>
        <option value="command">⌨️ Befehl</option>
      </select>
    </div>
    <div id="m-payload-row" class="form-group hidden"><label class="form-label">Befehl</label><input id="m-tpayload" class="form-input" placeholder="say Server-Neustart in 1 Minute"/></div>
    <div class="form-group"><label class="form-label">Cron-Expression *</label><input id="m-cron" class="form-input" placeholder="0 4 * * *" value="0 4 * * *"/><p class="text-dim text-sm" style="margin-top:4px">Klicke auf ein Preset unten oder gib manuell ein.</p></div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
      ${[['0 4 * * *','Tägl. 04:00'],['0 */6 * * *','Alle 6h'],['*/30 * * * *','Alle 30min'],['0 0 * * 0','Wöchentl.']].map(([c,l])=>`<button class="badge-alloc text-sm" onclick="document.getElementById('m-cron').value='${c}'">${esc(l)}</button>`).join('')}
    </div>
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button><button class="btn btn-primary" onclick="submitCreateTask('${serverId}')">Erstellen</button></div>`);
}

async function submitCreateTask(serverId) {
  const name    = document.getElementById('m-tname').value.trim();
  const action  = document.getElementById('m-taction').value;
  const payload = document.getElementById('m-tpayload')?.value.trim() || '';
  const cron    = document.getElementById('m-cron').value.trim();
  const errEl   = document.getElementById('m-error');
  if (!name || !cron) { errEl.textContent='Name und Cron sind erforderlich'; errEl.classList.remove('hidden'); return; }
  try {
    await API.post(`/servers/${serverId}/schedule`, { name, action, payload, cron });
    toast('Task erstellt', 'success');
    closeModal();
    scheduleInit(serverId);
  } catch(e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
}

async function taskRun(serverId, taskId) {
  try {
    await API.post(`/servers/${serverId}/schedule/${taskId}/run`, {});
    toast('Task ausgeführt', 'success');
    scheduleInit(serverId);
  } catch(e) { toast(e.message, 'error'); }
}

async function taskToggle(serverId, taskId, enabled) {
  try {
    await API.patch(`/servers/${serverId}/schedule/${taskId}`, { enabled });
    scheduleInit(serverId);
  } catch(e) { toast(e.message, 'error'); }
}

async function taskDelete(serverId, taskId) {
  if (!confirm('Task wirklich löschen?')) return;
  try {
    await API.delete(`/servers/${serverId}/schedule/${taskId}`);
    toast('Task gelöscht', 'success');
    scheduleInit(serverId);
  } catch(e) { toast(e.message, 'error'); }
}

// ─── SUB-USER TAB ─────────────────────────────────────────────────────────────
const PERM_LABELS = { console:'Konsole', files:'Dateien', startup:'Startup', allocations:'Ports', schedule:'Tasks', backups:'Backups' };

async function subusersInit(serverId) {
  const root = document.getElementById('users-root');
  if (!root) return;
  root.innerHTML = '<div class="empty"><div class="empty-icon spin"><i data-lucide="loader"></i></div></div>';
  try {
    const [subs, permsInfo] = await Promise.all([
      API.get(`/servers/${serverId}/subusers`),
      API.get(`/servers/${serverId}/subusers/permissions`),
    ]);
    const isOwner = State.server?.user_id === State.user?.id || State.user?.role === 'admin';
    root.innerHTML = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <div>
            <div class="card-title"><i data-lucide="users"></i> Zugriffsverwaltung</div>
            <div class="text-dim text-sm" style="margin-top:4px">Gib anderen Nutzern eingeschränkten Zugriff auf diesen Server.</div>
          </div>
          ${isOwner ? `<button class="btn btn-primary btn-sm" onclick="showInviteSubuser('${serverId}')">＋ Einladen</button>` : ''}
        </div>
        ${subs.length === 0
          ? '<div class="empty" style="padding:24px"><p>Keine Sub-User eingeladen</p></div>'
          : subs.map(s => subuserRow(s, serverId, isOwner)).join('')
        }
      </div>
      <div class="card" style="margin-top:12px">
        <div class="card-title" style="margin-bottom:12px"><i data-lucide="key"></i> Berechtigungen erklärt</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">
          ${permsInfo.map(p => `
            <div style="background:var(--bg3);border-radius:8px;padding:10px 12px">
              <div style="font-weight:600;font-size:13px">${esc(p.label)}</div>
              <div class="text-dim text-sm" style="margin-top:3px">${esc(p.description)}</div>
            </div>`).join('')}
        </div>
      </div>`;
  } catch(e) {
    root.innerHTML = `<div class="empty"><p>Fehler: ${esc(e.message)}</p></div>`;
  }
}

function subuserRow(s, serverId, isOwner) {
  const initials = (s.username||'?').substring(0,2).toUpperCase();
  const allPerms = ['console','files','startup','allocations','schedule','backups'];
  const chips = allPerms.map(p => {
    const active = s.permissions.includes(p);
    return `<span class="perm-chip${active?' active':''}" data-perm="${p}" ${isOwner?`onclick="toggleSubPerm('${serverId}','${s.id}',this)"`:''} title="${PERM_LABELS[p]||p}">${PERM_LABELS[p]||p}</span>`;
  }).join('');
  return `
    <div class="subuser-row">
      <div class="subuser-avatar">${initials}</div>
      <div class="subuser-info">
        <div class="subuser-name">${esc(s.username)}</div>
        <div class="subuser-email">${esc(s.email)}</div>
        <div class="perm-chips">${chips}</div>
      </div>
      ${isOwner ? `<button class="btn btn-ghost btn-sm text-danger" onclick="removeSubuser('${serverId}','${s.id}')" title="Entfernen"><i data-lucide="x"></i></button>` : ''}
    </div>`;
}

async function toggleSubPerm(serverId, subId, chip) {
  const perm = chip.dataset.perm;
  // Get current row's chips to build new perm list
  const row = chip.closest('.subuser-row');
  const chips = row.querySelectorAll('.perm-chip');
  let perms = [...chips].filter(c => c.classList.contains('active')).map(c => c.dataset.perm);
  if (chip.classList.contains('active')) {
    perms = perms.filter(p => p !== perm);
  } else {
    perms.push(perm);
  }
  try {
    await API.patch(`/servers/${serverId}/subusers/${subId}`, { permissions: perms });
    chip.classList.toggle('active');
  } catch(e) { toast(e.message, 'error'); }
}

async function removeSubuser(serverId, subId) {
  if (!confirm('Zugriff wirklich entziehen?')) return;
  try {
    await API.delete(`/servers/${serverId}/subusers/${subId}`);
    toast('Sub-User entfernt', 'success');
    subusersInit(serverId);
  } catch(e) { toast(e.message, 'error'); }
}

function showInviteSubuser(serverId) {
  showModal(`
    <div class="modal-title"><span><i data-lucide="user-plus"></i> Nutzer einladen</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group">
      <label class="form-label">E-Mail des Nutzers *</label>
      <input id="m-sub-email" class="form-input" type="email" placeholder="user@example.com"/>
    </div>
    <div class="form-group">
      <label class="form-label">Berechtigungen</label>
      <div class="perm-chips" style="margin-top:6px">
        ${['console','files','startup','allocations','schedule'].map(p =>
          `<span class="perm-chip active" data-perm="${p}" onclick="this.classList.toggle('active')">${PERM_LABELS[p]}</span>`
        ).join('')}
      </div>
    </div>
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitInviteSubuser('${serverId}')">Einladen</button>
    </div>`);
}

async function submitInviteSubuser(serverId) {
  const email = document.getElementById('m-sub-email').value.trim();
  const perms = [...document.querySelectorAll('.perm-chips .perm-chip.active')].map(c => c.dataset.perm);
  const errEl = document.getElementById('m-error');
  if (!email) { errEl.textContent='E-Mail erforderlich'; errEl.classList.remove('hidden'); return; }
  try {
    await API.post(`/servers/${serverId}/subusers`, { email, permissions: perms });
    toast('Nutzer eingeladen', 'success');
    closeModal();
    subusersInit(serverId);
  } catch(e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
}

// ─── AKTIVITÄTS-LOG TAB ────────────────────────────────────────────────────────
const ACTIVITY_COLORS = {
  SERVER_START:'#00f5a0', SERVER_STOP:'#f59e0b', SERVER_RESTART:'#60a5fa',
  SERVER_CREATE:'#00f5a0', SERVER_DELETE:'#ff4757', SERVER_CLONE:'#a78bfa',
  FILE_WRITE:'#fbbf24', FILE_DELETE:'#ff4757', FILE_CREATE:'#fbbf24',
  MOD_INSTALL:'#34d399', MOD_DELETE:'#ff4757',
  PORT_ASSIGN:'#60a5fa', PORT_REMOVE:'#f59e0b', PORT_SET_PRIMARY:'#60a5fa',
  TASK_CREATE:'#a78bfa', TASK_DELETE:'#f59e0b',
  SUBUSER_ADD:'#00d4ff', SUBUSER_REMOVE:'#ff4757', SUBUSER_UPDATE:'#60a5fa',
};
const ACTIVITY_ICONS = {
  SERVER_START:'<i data-lucide="play"></i>', SERVER_STOP:'<i data-lucide="square"></i>', SERVER_RESTART:'<i data-lucide="rotate-ccw"></i>',
  SERVER_CREATE:'<i data-lucide="plus-circle"></i>', SERVER_DELETE:'<i data-lucide="trash-2"></i>', SERVER_CLONE:'<i data-lucide="copy"></i>',
  FILE_WRITE:'<i data-lucide="pencil"></i>', FILE_DELETE:'<i data-lucide="trash-2"></i>', FILE_CREATE:'<i data-lucide="file-plus"></i>',
  MOD_INSTALL:'<i data-lucide="puzzle"></i>', PORT_ASSIGN:'<i data-lucide="plug"></i>', TASK_CREATE:'<i data-lucide="clock"></i>',
  SUBUSER_ADD:'<i data-lucide="user-plus"></i>', SUBUSER_REMOVE:'<i data-lucide="user-minus"></i>', LOGIN:'<i data-lucide="log-in"></i>',
};

async function activityInit(serverId) {
  const root = document.getElementById('activity-root');
  if (!root) return;
  root.innerHTML = '<div class="empty"><div class="empty-icon spin"><i data-lucide="loader"></i></div></div>';
  try {
    const logs = await API.get(`/admin/audit-log/server/${serverId}?limit=100`);
    root.innerHTML = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <div class="card-title"><i data-lucide="list"></i> Server-Aktivität</div>
          <button class="btn btn-ghost btn-sm" onclick="activityInit('${serverId}')">↺ Neu laden</button>
        </div>
        ${logs.length === 0
          ? '<div class="empty" style="padding:24px"><p>Noch keine Aktivitäten aufgezeichnet</p></div>'
          : logs.map(l => {
              const color = ACTIVITY_COLORS[l.action] || '#64748b';
              const icon  = ACTIVITY_ICONS[l.action]  || '●';
              let detail = '';
              try { const d = JSON.parse(l.details||'{}'); detail = Object.entries(d).map(([k,v])=>`${k}: ${String(v).substring(0,40)}`).join(' · '); } catch {}
              const timeAgo = timeSince(new Date(l.created_at));
              return `<div class="activity-item">
                <div class="activity-dot" style="background:${color}"></div>
                <div class="activity-body">
                  <div class="activity-action"><span style="color:${color}">${icon}</span> ${esc(l.action.replace(/_/g,' ').toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()))}</div>
                  ${detail ? `<div class="activity-meta">${esc(detail)}</div>` : ''}
                  <div class="activity-meta">von <strong>${esc(l.username||'system')}</strong> · ${timeAgo} · ${l.ip||''}</div>
                </div>
                <div style="font-size:11px;color:var(--text3);white-space:nowrap">${new Date(l.created_at).toLocaleString('de-DE',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'})}</div>
              </div>`;
            }).join('')
        }
      </div>`;
  } catch(e) {
    root.innerHTML = `<div class="empty"><p>Fehler: ${esc(e.message)}</p></div>`;
  }
}

function timeSince(date) {
  const s = Math.floor((new Date() - date) / 1000);
  if (s < 60)  return 'gerade eben';
  if (s < 3600) return Math.floor(s/60) + ' min';
  if (s < 86400) return Math.floor(s/3600) + ' Std';
  return Math.floor(s/86400) + ' Tage';
}


// ─── DISK GAUGE ───────────────────────────────────────────────────────────────
async function refreshDiskUsage(serverId) {
  const sid = serverId || State.serverDetail;
  if (!sid) return;
  try {
    const data = await API.get(`/servers/${sid}/backups/disk-usage`).catch(() => null);
    if (!data) return;
    updateDiskGauge(data);
  } catch {}
}

function updateDiskGauge(data) {
  const fill    = document.getElementById('disk-gauge-fill');
  const usedLbl = document.getElementById('disk-used-label');
  const pctLbl  = document.getElementById('disk-pct-label');
  const limLbl  = document.getElementById('disk-limit-label');
  const alertEl = document.getElementById('disk-alert-msg');
  if (!fill) return;

  const pct   = data.pct || 0;
  const color = pct >= 100 ? '#ff4757' : pct >= 90 ? '#f59e0b' : pct >= 75 ? '#fbbf24' : '#00f5a0';
  fill.style.width    = Math.min(pct, 100) + '%';
  fill.style.background = color;
  if (usedLbl) usedLbl.textContent = fmtBytes(data.bytes_used || 0);
  if (pctLbl)  pctLbl.textContent  = pct + '%';
  if (limLbl)  limLbl.textContent  = data.bytes_limit > 0 ? fmtBytes(data.bytes_limit) : '∞';

  if (alertEl) {
    if (pct >= 90) {
      alertEl.innerHTML = pct >= 100 ? '<i data-lucide="ban"></i> Disk-Limit erreicht — Schreibzugriff gesperrt' : `<i data-lucide="alert-triangle"></i> Disk ${pct}% voll — Bitte Platz schaffen`;
      alertEl.style.background = pct >= 100 ? '#ff475720' : '#f59e0b20';
      alertEl.style.color      = pct >= 100 ? '#ff4757'   : '#f59e0b';
      alertEl.classList.remove('hidden');
    } else {
      alertEl.classList.add('hidden');
    }
  }
}

function handleDiskAlert(msg) {
  if (msg.server_id !== State.serverDetail) return;
  updateDiskGauge(msg);
  const level = msg.status === 'exceeded' ? 'error' : msg.status === 'critical' ? 'warn' : 'info';
  toast(msg.message || 'Disk-Warnung', level);
}

// ─── BACKUPS TAB ──────────────────────────────────────────────────────────────
async function backupsInit(serverId) {
  const root = document.getElementById('backups-root');
  if (!root) return;
  root.innerHTML = '<div class="empty"><div class="empty-icon spin"><i data-lucide="loader"></i></div></div>';

  // Load disk usage + backups in parallel
  const [backups, diskData] = await Promise.all([
    API.get(`/servers/${serverId}/backups`).catch(() => []),
    API.get(`/servers/${serverId}/backups/disk-usage`).catch(() => null),
  ]);

  const srvInfo = State.server || {};
  const maxBackups = 10; // visual limit indicator

  root.innerHTML = `
    <!-- Disk Summary -->
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="card-title"><i data-lucide="pie-chart"></i> Speicher-Übersicht</div>
        <button class="btn btn-ghost btn-sm" onclick="backupsInit('${serverId}')"><i data-lucide="rotate-ccw"></i> Aktualisieren</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <div style="background:var(--bg3);border-radius:8px;padding:12px">
          <div class="text-dim text-sm">Disk-Limit</div>
          <div class="text-mono" style="font-size:18px;font-weight:700;margin-top:4px">${srvInfo.disk_limit ? fmtBytes(srvInfo.disk_limit * 1024 * 1024) : '—'}</div>
        </div>
        <div style="background:var(--bg3);border-radius:8px;padding:12px">
          <div class="text-dim text-sm">Belegt</div>
          <div class="text-mono" style="font-size:18px;font-weight:700;margin-top:4px;color:${diskData&&diskData.pct>=90?'var(--danger)':'var(--text)'}" id="bk-used">${diskData ? fmtBytes(diskData.bytes_used) : '—'}</div>
        </div>
        <div style="background:var(--bg3);border-radius:8px;padding:12px">
          <div class="text-dim text-sm">Backups (gesamt)</div>
          <div class="text-mono" style="font-size:18px;font-weight:700;margin-top:4px">${backups.length}</div>
        </div>
      </div>
      ${diskData ? `<div style="margin-top:12px">
        <div class="disk-gauge-track" style="height:8px">
          <div class="disk-gauge-fill" style="width:${Math.min(diskData.pct,100)}%;background:${diskData.pct>=100?'#ff4757':diskData.pct>=90?'#f59e0b':'#00f5a0'}"></div>
        </div>
        <div style="text-align:right;font-size:11px;color:var(--text3);margin-top:3px">${diskData.pct}% belegt</div>
      </div>` : ''}
    </div>

    <!-- Auto-Backup Schedule (loaded async) -->
    <div id="backup-schedule-container"></div>

    <!-- Create Backup -->
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div class="card-title"><i data-lucide="plus-circle"></i> Neues Backup</div>
          <div class="text-dim text-sm" style="margin-top:2px">Erstellt ein vollständiges Snapshot der Server-Dateien als .tar.gz</div>
        </div>
        <button class="btn btn-primary" onclick="showCreateBackup('${serverId}')"><i data-lucide="plus"></i> Backup erstellen</button>
      </div>
    </div>

    <!-- Backup List -->
    <div class="card">
      <div class="card-title" style="margin-bottom:14px"><i data-lucide="archive"></i> Gespeicherte Backups</div>
      ${backups.length === 0
        ? '<div class="empty" style="padding:24px"><p>Noch keine Backups vorhanden</p></div>'
        : `<div style="display:flex;flex-direction:column;gap:10px">
            ${backups.map(b => backupCard(b, serverId)).join('')}
          </div>`
      }
    </div>`;

  // Load auto-backup schedule card
  loadBackupSchedule(serverId).then(html => {
    const el = document.getElementById('backup-schedule-container');
    if (el) { el.innerHTML = html; if (typeof lucide !== 'undefined') lucide.createIcons(); }
  });

  // Restore auto-refresh for 'creating' backups
  if (backups.some(b => b.status === 'creating' || b.status === 'restoring')) {
    setTimeout(() => backupsInit(serverId), 4000);
  }
}

function backupCard(b, serverId) {
  const sizeTxt = b.size_bytes > 0 ? fmtBytes(b.size_bytes) : '—';
  const dateTxt = new Date(b.created_at).toLocaleString('de-DE');
  const canAct  = b.status === 'ready';
  return `<div class="backup-card">
    <div class="backup-icon"><i data-lucide="hard-drive"></i></div>
    <div class="backup-info">
      <div class="backup-name">${esc(b.name)}</div>
      <div class="backup-meta">${dateTxt} · ${sizeTxt}${b.note ? ' · <span style="color:var(--danger)">' + esc(b.note) + '</span>' : ''}${b.created_by_name ? ' · von ' + esc(b.created_by_name) : ''}</div>
    </div>
    <span class="backup-status ${b.status}">${{ready:'<i data-lucide="check"></i> Bereit',creating:'<i data-lucide="loader"></i> Erstellt...',failed:'<i data-lucide="x"></i> Fehler',restoring:'<i data-lucide="rotate-ccw" class="spin"></i> Stellt wieder her…'}[b.status]||b.status}</span>
    <div class="backup-actions">
      ${canAct ? `<a class="btn btn-ghost btn-sm" href="/api/servers/${serverId}/backups/${b.id}/download" download title="Download"><i data-lucide="download"></i></a>` : ''}
      ${canAct ? `<button class="btn btn-ghost btn-sm" onclick="restoreBackup('${serverId}','${b.id}','${esc(b.name)}')" title="Wiederherstellen"><i data-lucide="rotate-ccw"></i></button>` : ''}
      <button class="btn btn-ghost btn-sm text-danger" onclick="deleteBackup('${serverId}','${b.id}')" title="Löschen" ${b.status==='creating'?'disabled':''}><i data-lucide="trash-2"></i></button>
    </div>
  </div>`;
}

function showCreateBackup(serverId) {
  showModal(`
    <div class="modal-title"><span><i data-lucide="hard-drive"></i> Backup erstellen</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group">
      <label class="form-label">Name</label>
      <input id="m-bk-name" class="form-input" value="Backup ${new Date().toLocaleString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}"/>
    </div>
    <div class="form-group">
      <label class="form-label">Notiz (optional)</label>
      <input id="m-bk-note" class="form-input" placeholder="z.B. vor großem Update"/>
    </div>
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitCreateBackup('${serverId}')">Backup starten</button>
    </div>`);
}

async function submitCreateBackup(serverId) {
  const name  = document.getElementById('m-bk-name').value.trim();
  const note  = document.getElementById('m-bk-note').value.trim();
  const errEl = document.getElementById('m-error');
  try {
    await API.post(`/servers/${serverId}/backups`, { name, note });
    toast('Backup wird erstellt...', 'success');
    closeModal();
    backupsInit(serverId);
  } catch(e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
}

async function restoreBackup(serverId, backupId, name) {
  if (!confirm(`Backup "${name}" wirklich wiederherstellen?\n\nDies überschreibt alle aktuellen Server-Dateien!`)) return;
  try {
    await API.post(`/servers/${serverId}/backups/${backupId}/restore`, {});
    toast('Wiederherstellung gestartet...', 'success');
    setTimeout(() => backupsInit(serverId), 2000);
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteBackup(serverId, backupId) {
  if (!confirm('Backup wirklich löschen? Diese Aktion ist nicht rückgängig zu machen.')) return;
  try {
    await API.delete(`/servers/${serverId}/backups/${backupId}`);
    toast('Backup gelöscht', 'success');
    backupsInit(serverId);
  } catch(e) { toast(e.message, 'error'); }
}


// ─── STARTUP / ENV VARIABLEN EDITOR ──────────────────────────────────────────
let _startupState = {};   // { env_vars: {}, startup_command: '', egg_id: null }

async function startupEditorInit(serverId) {
  const root = document.getElementById('startup-editor-root');
  if (!root) return;
  root.innerHTML = '<div class="empty"><div class="spin"><i data-lucide="loader"></i></div></div>';

  try {
    const [srv, eggs] = await Promise.all([
      API.get(`/servers/${serverId}`),
      API.get('/eggs').catch(() => []),
    ]);
    _startupState = {
      env_vars: srv.env_vars || {},
      startup_command: srv.startup_command || '',
      egg_id: srv.egg_id,
    };

    // Find matching egg for variable definitions
    const egg = eggs.find(e => e.id === srv.egg_id) || null;
    const eggVars = egg?.env_vars ? (typeof egg.env_vars === 'string' ? JSON.parse(egg.env_vars) : egg.env_vars) : [];

    renderStartupEditor(root, srv, egg, eggVars, serverId);
  } catch (e) {
    root.innerHTML = `<div class="empty"><p>Fehler: ${esc(e.message)}</p></div>`;
  }
}

function renderStartupEditor(root, srv, egg, eggVars, serverId) {
  const envVars = _startupState.env_vars || {};

  // Build known vars from egg, then add any extra ones from server
  const knownKeys = new Set(eggVars.map(v => v.key));
  const extraKeys = Object.keys(envVars).filter(k => !knownKeys.has(k));

  root.innerHTML = `
    <!-- Startup Command -->
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="card-title"><i data-lucide="terminal"></i> Startup-Befehl</div>
        ${egg ? `<span class="text-dim text-sm">Egg: ${esc(egg.name)}</span>` : ''}
      </div>
      <div class="startup-cmd-bar">
        <span style="color:var(--text3)">$</span>
        <input class="startup-cmd-input" id="startup-cmd-input"
          value="${esc(_startupState.startup_command)}"
          placeholder="${egg?.startup_command ? esc(egg.startup_command) : 'Standard des Images'}"/>
      </div>
      ${egg?.startup_command ? `<div class="text-dim text-sm" style="margin-top:6px">Standard: <span class="text-mono">${esc(egg.startup_command)}</span></div>` : ''}
    </div>

    <!-- Defined Variables (from Egg) -->
    ${eggVars.length > 0 ? `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div class="card-title"><i data-lucide="list"></i> Variablen</div>
        <button class="btn btn-primary btn-sm" onclick="saveStartupVars('${serverId}')"><i data-lucide="save"></i> Speichern</button>
      </div>
      <div id="env-vars-defined">
        ${eggVars.map(v => envVarRow(v, envVars[v.key] ?? v.default ?? '')).join('')}
      </div>
    </div>` : ''}

    <!-- Extra / Custom Variables -->
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div class="card-title"><i data-lucide="zap"></i> Eigene Variablen</div>
          <div class="text-dim text-sm" style="margin-top:2px">Zusätzliche ENV-Variablen die direkt an den Container übergeben werden</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="addCustomEnvRow()">＋ Variable</button>
          ${eggVars.length === 0 ? `<button class="btn btn-primary btn-sm" onclick="saveStartupVars('${serverId}')"><i data-lucide="save"></i> Speichern</button>` : ''}
        </div>
      </div>
      <div id="env-vars-custom">
        ${extraKeys.length > 0
          ? extraKeys.map(k => customEnvRow(k, envVars[k])).join('')
          : '<div class="text-dim text-sm" style="padding:8px 0" id="env-custom-empty">Keine eigenen Variablen</div>'
        }
      </div>
    </div>

    <!-- Server Details -->
    <div class="card" style="margin-top:12px">
      <div class="card-title" style="margin-bottom:12px">ℹ️ Server Details</div>
      <table class="table"><tbody>
        <tr><td class="text-dim">ID</td><td class="text-mono text-sm">${esc(srv.id)}</td></tr>
        <tr><td class="text-dim">Container</td><td class="text-mono text-sm">${srv.container_id ? esc(srv.container_id.substring(0,12)) : '—'}</td></tr>
        <tr><td class="text-dim">Node</td><td>${esc(srv.node||'–')}</td></tr>
        <tr><td class="text-dim">Work Dir</td><td class="text-mono">${esc(srv.work_dir||'/home/container')}</td></tr>
        <tr><td class="text-dim">Network</td><td class="text-mono">${esc(srv.network||'bridge')}</td></tr>
        <tr><td class="text-dim">Erstellt</td><td>${new Date(srv.created_at).toLocaleString('de-DE')}</td></tr>
      </tbody></table>
    </div>`;
}

function envVarRow(varDef, currentValue) {
  const { key, description = '', required = false, options = null, type = 'text' } = varDef;
  // Detect type from options or key patterns
  const isBool    = currentValue === 'true' || currentValue === 'false' || currentValue === 'TRUE' || currentValue === 'FALSE';
  const hasOptions = options && options.length > 0;
  const isMemory  = key.includes('MEMORY') || key.includes('RAM');

  let input;
  if (hasOptions) {
    input = `<select class="env-var-select" data-key="${esc(key)}" onchange="updateEnvVar('${esc(key)}',this.value)">
      ${options.map(o => `<option value="${esc(o)}" ${currentValue === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
    </select>`;
  } else if (isBool && !isMemory) {
    const checked = currentValue.toUpperCase() === 'TRUE';
    input = `<label class="env-toggle" title="${checked ? 'TRUE' : 'FALSE'}">
      <input type="checkbox" ${checked ? 'checked' : ''} onchange="updateEnvVar('${esc(key)}',this.checked?'TRUE':'FALSE')">
      <span class="env-toggle-slider"></span>
    </label>`;
  } else {
    input = `<input class="form-input" style="font-family:var(--mono);font-size:13px"
      value="${esc(currentValue)}" data-key="${esc(key)}"
      oninput="updateEnvVar('${esc(key)}',this.value)"
      placeholder="${esc(varDef.default||'')}"/>`;
  }

  return `<div class="env-var-row">
    <div>
      <div class="env-var-key">${esc(key)}${required ? '<span class="env-var-badge">Pflicht</span>' : ''}</div>
      ${description ? `<div class="env-var-desc">${esc(description)}</div>` : ''}
    </div>
    <div>${input}</div>
    <div></div>
  </div>`;
}

function customEnvRow(key = '', value = '') {
  return `<div class="env-var-row" id="custom-row-${esc(key)||Date.now()}">
    <input class="form-input" style="font-family:var(--mono);font-size:13px" placeholder="VARIABLE_NAME" value="${esc(key)}"
      oninput="renameCustomEnv(this,'${esc(key)}')"/>
    <input class="form-input" style="font-family:var(--mono);font-size:13px" placeholder="Wert" value="${esc(value)}"
      oninput="updateEnvVar('${esc(key)}',this.value)"/>
    <button class="btn btn-ghost btn-sm text-danger" onclick="removeCustomEnv(this,'${esc(key)}')"><i data-lucide="x"></i></button>
  </div>`;
}

function updateEnvVar(key, value) {
  if (!_startupState.env_vars) _startupState.env_vars = {};
  _startupState.env_vars[key] = value;
}

function renameCustomEnv(input, oldKey) {
  const newKey = input.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  input.value = newKey;
  if (oldKey && _startupState.env_vars?.[oldKey] !== undefined) {
    const val = _startupState.env_vars[oldKey];
    delete _startupState.env_vars[oldKey];
    _startupState.env_vars[newKey] = val;
  }
  // Update sibling value input's oninput reference (can't easily, just use next input)
  const row = input.closest('.env-var-row');
  if (row) {
    const valInput = row.querySelectorAll('input')[1];
    if (valInput) valInput.oninput = () => updateEnvVar(newKey, valInput.value);
    const delBtn = row.querySelector('button');
    if (delBtn) delBtn.onclick = () => removeCustomEnv(delBtn, newKey);
  }
}

function addCustomEnvRow() {
  const container = document.getElementById('env-vars-custom');
  const empty = document.getElementById('env-custom-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.innerHTML = customEnvRow('', '');
  container.appendChild(div.firstElementChild);
}

function removeCustomEnv(btn, key) {
  if (key && _startupState.env_vars) delete _startupState.env_vars[key];
  btn.closest('.env-var-row')?.remove();
  const container = document.getElementById('env-vars-custom');
  if (container && !container.querySelector('.env-var-row')) {
    container.innerHTML = '<div class="text-dim text-sm" style="padding:8px 0" id="env-custom-empty">Keine eigenen Variablen</div>';
  }
}

async function saveStartupVars(serverId) {
  const cmdInput = document.getElementById('startup-cmd-input');
  const startup_command = cmdInput ? cmdInput.value.trim() : _startupState.startup_command;
  try {
    await API.patch(`/servers/${serverId}`, {
      startup_command,
      env_vars: _startupState.env_vars || {},
    });
    toast('Einstellungen gespeichert', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

// ─── SFTP TAB ─────────────────────────────────────────────────────────────────
function sftpTabInit(serverId) {
  const root = document.getElementById('sftp-root');
  if (!root) return;
  const user   = State.user?.username || 'user';
  const prefix = serverId.substring(0, 6);
  const host   = location.hostname;
  const cmd    = `sftp -P 2022 ${user}.${prefix}@${host}`;

  root.innerHTML = `
    <div class="card" style="max-width:640px">
      <div class="card-title" style="margin-bottom:16px"><i data-lucide="terminal-square"></i> SFTP-Zugang</div>

      <div class="sftp-box" style="margin-bottom:16px">
        <div class="sftp-row"><span class="text-dim">Host</span><span class="sftp-val">${esc(host)}</span></div>
        <div class="sftp-row"><span class="text-dim">Port</span><span class="sftp-val">2022</span></div>
        <div class="sftp-row">
          <span class="text-dim">Benutzer</span>
          <span class="sftp-val">${esc(user)}.${esc(prefix)}</span>
        </div>
        <div class="sftp-row">
          <span class="text-dim">Passwort</span>
          <span class="text-dim">Dein NexPanel-Passwort</span>
        </div>
        <div class="sftp-row">
          <span class="text-dim">Protokoll</span>
          <span class="sftp-val">SFTP über SSH2</span>
        </div>
        <div class="sftp-row">
          <span class="text-dim">Root-Verzeichnis</span>
          <span class="sftp-val text-mono">${esc(State.server?.work_dir || '/home/container')}</span>
        </div>
      </div>

      <div style="margin-bottom:12px">
        <div class="text-dim text-sm" style="margin-bottom:6px">Verbindungsbefehl (Terminal)</div>
        <div class="sftp-command-box" onclick="navigator.clipboard.writeText('${esc(cmd)}').then(()=>toast('Kopiert!','success'))">
          ${esc(cmd)}
        </div>
      </div>

      <div class="card" style="background:var(--bg3);border:none;margin-top:16px">
        <div class="card-title" style="margin-bottom:10px;font-size:13px"><i data-lucide="monitor"></i> Client-Konfiguration</div>
        <div class="grid grid-2" style="gap:10px">
          <div style="padding:10px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
            <div style="font-weight:600;margin-bottom:6px">FileZilla</div>
            <div class="text-dim text-sm">Host: <span class="text-mono">${esc(host)}</span></div>
            <div class="text-dim text-sm">Port: <span class="text-mono">2022</span></div>
            <div class="text-dim text-sm">Protokoll: SFTP</div>
            <div class="text-dim text-sm">Benutzer: <span class="text-mono">${esc(user)}.${esc(prefix)}</span></div>
          </div>
          <div style="padding:10px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
            <div style="font-weight:600;margin-bottom:6px">WinSCP / Cyberduck</div>
            <div class="text-dim text-sm">Verbindungstyp: SFTP</div>
            <div class="text-dim text-sm">Host: <span class="text-mono">${esc(host)}</span></div>
            <div class="text-dim text-sm">Port: <span class="text-mono">2022</span></div>
            <div class="text-dim text-sm">Benutzername: <span class="text-mono">${esc(user)}.${esc(prefix)}</span></div>
          </div>
        </div>
      </div>

      <div class="text-dim text-sm" style="margin-top:14px;line-height:1.7">
        ℹ️ Der SFTP-Server ist direkt mit dem Container verbunden — alle Änderungen werden sofort übernommen.
        Der Benutzer <span class="text-mono text-accent">${esc(user)}.${esc(prefix)}</span> hat nur Zugriff auf diesen Server.
      </div>
    </div>`;
}

// ─── BENACHRICHTIGUNGEN TAB ────────────────────────────────────────────────────
const EVENT_LABELS = {
  crash: '<i data-lucide="zap"></i> Absturz', start: '<i data-lucide="play"></i> Start', stop: '<i data-lucide="square"></i> Stop',
  disk_warning: '<i data-lucide="alert-triangle"></i> Disk ≥ 75%', disk_critical: '<i data-lucide="alert-octagon"></i> Disk ≥ 90%', disk_exceeded: '<i data-lucide="ban"></i> Disk voll',
  backup_done: '<i data-lucide="hard-drive"></i> Backup fertig', backup_failed: '<i data-lucide="x-circle"></i> Backup fehlgeschlagen', restore_done: '<i data-lucide="refresh-cw"></i> Wiederherstellung',
  cpu_warn: '<i data-lucide="cpu"></i> CPU ≥ Warn', cpu_crit: '<i data-lucide="cpu"></i> CPU ≥ Kritisch',
  ram_warn: '<i data-lucide="memory-stick"></i> RAM ≥ Warn', ram_crit: '<i data-lucide="memory-stick"></i> RAM ≥ Kritisch',
  disk_warn: '<i data-lucide="hard-drive"></i> Disk ≥ Warn', disk_crit: '<i data-lucide="hard-drive"></i> Disk ≥ Kritisch',
};

let _notifyState = {};
let _alertRule   = {};

async function notifyInit(serverId) {
  const root = document.getElementById('notify-root');
  if (!root) return;
  root.innerHTML = '<div class="empty"><div class="empty-icon spin"><i data-lucide="loader"></i></div></div>';

  try {
    const [data, alertRule] = await Promise.all([
      API.get(`/servers/${serverId}/notifications`),
      API.get(`/servers/${serverId}/alerts`).catch(() => null),
    ]);
    _notifyState = { ...data };
    _alertRule   = alertRule || {};
    renderNotifyTab(root, serverId, data);
    renderAlertRuleSection(serverId, _alertRule);
  } catch(e) {
    root.innerHTML = `<div class="empty"><p>Fehler: ${esc(e.message)}</p></div>`;
  }
}

function renderNotifyTab(root, serverId, d) {
  root.innerHTML = `
    <!-- Discord -->
    <div class="notify-channel">
      <div class="notify-channel-header">
        <span class="notif-brand-icon"><i data-lucide="message-circle"></i></span>
        <div style="flex:1">
          <div style="font-weight:600">Discord</div>
          <div class="text-dim text-sm">Benachrichtigungen via Webhook</div>
        </div>
        <label class="env-toggle">
          <input type="checkbox" id="discord-enabled" ${d.discord_enabled ? 'checked' : ''}
            onchange="toggleNotifyChannel('discord',this.checked)">
          <span class="env-toggle-slider"></span>
        </label>
        <button class="btn btn-ghost btn-sm" onclick="toggleNotifyBody('discord')">⌄</button>
      </div>
      <div class="notify-channel-body ${d.discord_enabled ? 'open' : ''}" id="discord-body">
        <div class="form-group">
          <label class="form-label">Webhook URL</label>
          <input class="form-input" id="discord-webhook" type="url"
            value="${esc(d.discord_webhook || '')}"
            placeholder="https://discord.com/api/webhooks/..."
            oninput="_notifyState.discord_webhook=this.value"/>
        </div>
        <div class="form-group">
          <label class="form-label">Events</label>
          <div style="margin-top:6px">
            ${Object.entries(EVENT_LABELS).map(([key, label]) => {
              const active = (d.discord_events || []).includes(key);
              return `<span class="event-chip ${active ? 'active' : ''}" data-channel="discord" data-event="${key}"
                onclick="toggleEventChip(this,'discord','${key}')">${label}</span>`;
            }).join('')}
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:4px">
          <button class="btn btn-ghost btn-sm" onclick="testNotify('${serverId}','discord')"><i data-lucide="flask-conical"></i> Test senden</button>
          <button class="btn btn-primary btn-sm" onclick="saveNotifySettings('${serverId}')"><i data-lucide="save"></i> Speichern</button>
        </div>
      </div>
    </div>

    <!-- E-Mail -->
    <div class="notify-channel" style="margin-top:10px">
      <div class="notify-channel-header">
        <span class="notif-brand-icon"><i data-lucide="mail"></i></span>
        <div style="flex:1">
          <div style="font-weight:600">E-Mail</div>
          <div class="text-dim text-sm">Benachrichtigungen per E-Mail (SMTP)</div>
        </div>
        <label class="env-toggle">
          <input type="checkbox" id="email-enabled" ${d.email_enabled ? 'checked' : ''}
            onchange="toggleNotifyChannel('email',this.checked)">
          <span class="env-toggle-slider"></span>
        </label>
        <button class="btn btn-ghost btn-sm" onclick="toggleNotifyBody('email')">⌄</button>
      </div>
      <div class="notify-channel-body ${d.email_enabled ? 'open' : ''}" id="email-body">
        <div class="form-group">
          <label class="form-label">Empfänger E-Mail</label>
          <input class="form-input" id="email-to" type="email"
            value="${esc(d.email_to || '')}"
            placeholder="admin@example.com"
            oninput="_notifyState.email_to=this.value"/>
        </div>
        <div class="form-group">
          <label class="form-label">Events</label>
          <div style="margin-top:6px">
            ${Object.entries(EVENT_LABELS).map(([key, label]) => {
              const active = (d.email_events || []).includes(key);
              return `<span class="event-chip ${active ? 'active' : ''}" data-channel="email" data-event="${key}"
                onclick="toggleEventChip(this,'email','${key}')">${label}</span>`;
            }).join('')}
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:4px">
          <button class="btn btn-ghost btn-sm" onclick="testNotify('${serverId}','email')"><i data-lucide="flask-conical"></i> Test senden</button>
          <button class="btn btn-primary btn-sm" onclick="saveNotifySettings('${serverId}')"><i data-lucide="save"></i> Speichern</button>
        </div>
      </div>
    </div>

    <!-- SMTP Config hint (admin only) -->
    ${State.user?.role === 'admin' ? `
    <div class="card" style="margin-top:12px;background:var(--bg3);border-color:var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-weight:600;font-size:13px"><i data-lucide="settings"></i> SMTP-Konfiguration</div>
          <div class="text-dim text-sm">Panel-weite E-Mail-Server Einstellungen</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="showSmtpConfig()">SMTP konfigurieren →</button>
      </div>
    </div>` : ''}`;
}

function toggleNotifyChannel(channel, enabled) {
  _notifyState[`${channel}_enabled`] = enabled;
  const body = document.getElementById(`${channel}-body`);
  if (body) body.classList.toggle('open', enabled);
}

function toggleNotifyBody(channel) {
  const body = document.getElementById(`${channel}-body`);
  if (body) body.classList.toggle('open');
}

function toggleEventChip(chip, channel, event) {
  chip.classList.toggle('active');
  const key = `${channel}_events`;
  if (!_notifyState[key]) _notifyState[key] = [];
  if (chip.classList.contains('active')) {
    if (!_notifyState[key].includes(event)) _notifyState[key].push(event);
  } else {
    _notifyState[key] = _notifyState[key].filter(e => e !== event);
  }
}

async function saveNotifySettings(serverId) {
  try {
    const payload = {
      discord_webhook: _notifyState.discord_webhook || document.getElementById('discord-webhook')?.value || '',
      discord_enabled: _notifyState.discord_enabled ?? false,
      discord_events:  _notifyState.discord_events || [],
      email_to:        _notifyState.email_to || document.getElementById('email-to')?.value || '',
      email_enabled:   _notifyState.email_enabled ?? false,
      email_events:    _notifyState.email_events || [],
    };
    await API.put(`/servers/${serverId}/notifications`, payload);
    toast('Einstellungen gespeichert', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function testNotify(serverId, channel) {
  try {
    await API.post(`/servers/${serverId}/notifications/test`, { channel });
    toast(`Test-Benachrichtigung gesendet (${channel})`, 'success');
  } catch(e) { toast(e.message, 'error'); }
}


// ══════════════════════════════════════════════════════════════════════════════
// RESOURCE ALERTS
// ══════════════════════════════════════════════════════════════════════════════

function renderAlertRuleSection(serverId, rule) {
  // Append the resource-alerts card into notify-root after existing channels
  const root = document.getElementById('notify-root');
  if (!root) return;

  const enabled   = rule.enabled !== 0;
  const cooldown  = rule.cooldown_minutes || 30;

  // last_fired display helper
  const firedAgo = (key) => {
    const t = rule.last_fired?.[key];
    if (!t) return '—';
    const diff = Math.round((Date.now() - new Date(t).getTime()) / 60000);
    if (diff < 1)   return 'gerade eben';
    if (diff < 60)  return `vor ${diff} min`;
    if (diff < 1440) return `vor ${Math.round(diff/60)} h`;
    return `vor ${Math.round(diff/1440)} d`;
  };

  const thresholdRow = (id, label, warnKey, critKey, icon) => `
    <div style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:12px;font-weight:500;color:var(--color-text-secondary)">
        <i data-lucide="${icon}" style="width:12px;height:12px"></i> ${label}
        <span style="margin-left:auto;font-weight:400;color:var(--color-text-tertiary)">
          Zuletzt: Warn ${firedAgo(warnKey)} · Krit ${firedAgo(critKey)}
        </span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>
          <label style="font-size:11px;color:var(--color-text-tertiary);margin-bottom:3px;display:flex;justify-content:space-between">
            <span><i data-lucide="alert-triangle" style="width:11px;height:11px;color:var(--warn)"></i> Warnung</span><span id="${id}-warn-val">${rule[warnKey] ?? '—'}%</span>
          </label>
          <input type="range" id="${id}-warn" min="0" max="99" step="1"
            value="${rule[warnKey] ?? 80}" class="form-input" style="padding:4px 0"
            oninput="document.getElementById('${id}-warn-val').textContent=this.value+'%'"/>
        </div>
        <div>
          <label style="font-size:11px;color:var(--color-text-tertiary);margin-bottom:3px;display:flex;justify-content:space-between">
            <span><i data-lucide="alert-octagon" style="width:11px;height:11px;color:var(--danger)"></i> Kritisch</span><span id="${id}-crit-val">${rule[critKey] ?? '—'}%</span>
          </label>
          <input type="range" id="${id}-crit" min="1" max="100" step="1"
            value="${rule[critKey] ?? 95}" class="form-input" style="padding:4px 0"
            oninput="document.getElementById('${id}-crit-val').textContent=this.value+'%'"/>
        </div>
      </div>
    </div>`;

  const div = document.createElement('div');
  div.id = 'resource-alerts-card';
  div.style.marginTop = '10px';
  div.innerHTML = `
    <div class="notify-channel">
      <div class="notify-channel-header">
        <span class="notif-brand-icon" style="background:rgba(239,68,68,.1);color:#ef4444"><i data-lucide="activity"></i></span>
        <div style="flex:1">
          <div style="font-weight:600">Resource Alerts</div>
          <div class="text-dim text-sm">CPU & RAM Schwellenwerte — löst Discord/E-Mail aus</div>
        </div>
        <label class="env-toggle">
          <input type="checkbox" id="alert-enabled" ${enabled ? 'checked' : ''}
            onchange="_alertRule.enabled=this.checked?1:0">
          <span class="env-toggle-slider"></span>
        </label>
        <button class="btn btn-ghost btn-sm" onclick="toggleNotifyBody('resource-alerts')">⌄</button>
      </div>
      <div class="notify-channel-body ${enabled ? 'open' : ''}" id="resource-alerts-body">

        ${thresholdRow('al-cpu', 'CPU', 'cpu_warn', 'cpu_crit', 'cpu')}
        ${thresholdRow('al-ram', 'RAM', 'ram_warn', 'ram_crit', 'memory-stick')}
        ${thresholdRow('al-disk', 'Disk', 'disk_warn', 'disk_crit', 'hard-drive')}

        <div style="display:flex;align-items:center;gap:10px;margin-top:4px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:180px">
            <label style="font-size:12px;white-space:nowrap;color:var(--color-text-secondary)">
              <i data-lucide="timer" style="width:12px;height:12px;vertical-align:-1px"></i>
              Cooldown
            </label>
            <select id="al-cooldown" class="form-input" style="max-width:140px;padding:4px 8px;font-size:12px">
              ${[5,10,15,30,60,120,240,480,1440].map(m =>
                `<option value="${m}" ${cooldown===m?'selected':''}>${m < 60 ? m+' min' : (m/60)+' h'}</option>`
              ).join('')}
            </select>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost btn-sm" onclick="resetAlertCooldown('${serverId}')">
              <i data-lucide="rotate-ccw"></i> Cooldown zurücksetzen
            </button>
            <button class="btn btn-ghost btn-sm" onclick="testAlertRule('${serverId}')">
              <i data-lucide="flask-conical"></i> Test
            </button>
            <button class="btn btn-primary btn-sm" onclick="saveAlertRule('${serverId}')">
              <i data-lucide="save"></i> Speichern
            </button>
          </div>
        </div>

        <div style="margin-top:12px;padding:10px;background:var(--color-background-secondary);border-radius:6px;font-size:11px;color:var(--color-text-tertiary);line-height:1.6">
          <i data-lucide="info" style="width:11px;height:11px;vertical-align:-1px"></i>
          Alerts werden über die oben konfigurierten Discord/E-Mail-Kanäle versendet.
          Stelle sicher dass mindestens ein Kanal aktiviert und für <em>CPU/RAM-Warn/Kritisch</em>-Events konfiguriert ist.
          Der Cooldown verhindert Alarm-Floods — innerhalb der eingestellten Zeit wird maximal ein Alert pro Metrik+Schwere gesendet.
        </div>
      </div>
    </div>`;

  root.appendChild(div);
  if (window.lucide) lucide.createIcons();
}

async function saveAlertRule(serverId) {
  const get = id => document.getElementById(id);
  const body = {
    enabled:          get('alert-enabled')?.checked ? 1 : 0,
    cpu_warn:         parseInt(get('al-cpu-warn')?.value  || 80),
    cpu_crit:         parseInt(get('al-cpu-crit')?.value  || 95),
    ram_warn:         parseInt(get('al-ram-warn')?.value  || 80),
    ram_crit:         parseInt(get('al-ram-crit')?.value  || 95),
    disk_warn:        parseInt(get('al-disk-warn')?.value || 75),
    disk_crit:        parseInt(get('al-disk-crit')?.value || 90),
    cooldown_minutes: parseInt(get('al-cooldown')?.value  || 30),
  };
  try {
    _alertRule = await API.put(`/servers/${serverId}/alerts`, body);
    toast('Resource Alerts gespeichert', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function resetAlertCooldown(serverId) {
  try {
    await API.post(`/servers/${serverId}/alerts/reset-cooldown`, {});
    toast('Cooldown zurückgesetzt', 'success');
    // Refresh last_fired display
    const rule = await API.get(`/servers/${serverId}/alerts`);
    _alertRule = rule;
    renderAlertRuleSection(serverId, rule);
  } catch(e) { toast(e.message, 'error'); }
}

async function testAlertRule(serverId) {
  try {
    const r = await API.post(`/servers/${serverId}/alerts/test`, {});
    toast(r.message || 'Test-Alert gesendet', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function showSmtpConfig() {
  let cfg = {};
  try { cfg = await API.get('/admin/smtp'); } catch {}
  showModal(`
    <div class="modal-title"><span><i data-lucide="settings"></i> SMTP Konfiguration</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group"><label class="form-label">Host</label><input id="m-smtp-host" class="form-input" value="${esc(cfg.host||'')}" placeholder="smtp.gmail.com"/></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="form-group"><label class="form-label">Port</label><input id="m-smtp-port" class="form-input" type="number" value="${cfg.port||587}"/></div>
      <div class="form-group"><label class="form-label">Sicherheit</label>
        <select id="m-smtp-secure" class="form-input">
          <option value="0" ${!cfg.secure?'selected':''}>STARTTLS (587)</option>
          <option value="1" ${cfg.secure?'selected':''}>SSL/TLS (465)</option>
        </select>
      </div>
    </div>
    <div class="form-group"><label class="form-label">Benutzername</label><input id="m-smtp-user" class="form-input" value="${esc(cfg.user||'')}" placeholder="user@gmail.com"/></div>
    <div class="form-group"><label class="form-label">Passwort</label><input id="m-smtp-pass" class="form-input" type="password" placeholder="Leer lassen um beizubehalten"/></div>
    <div class="form-group"><label class="form-label">Absender (From)</label><input id="m-smtp-from" class="form-input" value="${esc(cfg.from_addr||'')}" placeholder="nexpanel@example.com"/></div>
    <div class="form-group" style="display:flex;align-items:center;gap:10px">
      <label class="env-toggle"><input type="checkbox" id="m-smtp-enabled" ${cfg.enabled?'checked':''}><span class="env-toggle-slider"></span></label>
      <label class="form-label" style="margin:0">SMTP aktiviert</label>
    </div>
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-ghost" onclick="testSmtp()"><i data-lucide="flask-conical"></i> Test</button>
      <button class="btn btn-primary" onclick="saveSmtp()">Speichern</button>
    </div>`);
}

async function saveSmtp() {
  const errEl = document.getElementById('m-error');
  try {
    await API.put('/admin/smtp', {
      host:      document.getElementById('m-smtp-host').value.trim(),
      port:      parseInt(document.getElementById('m-smtp-port').value)||587,
      secure:    document.getElementById('m-smtp-secure').value === '1',
      user:      document.getElementById('m-smtp-user').value.trim(),
      password:  document.getElementById('m-smtp-pass').value,
      from_addr: document.getElementById('m-smtp-from').value.trim(),
      enabled:   document.getElementById('m-smtp-enabled').checked,
    });
    toast('SMTP gespeichert', 'success');
    closeModal();
  } catch(e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
}

async function testSmtp() {
  const to = prompt('Test-E-Mail senden an:');
  if (!to) return;
  try {
    await API.post('/admin/smtp/test', { to });
    toast('Test-E-Mail gesendet!', 'success');
  } catch(e) { toast(e.message, 'error'); }
}


// ══════════════════════════════════════════════════════════════════════════════
// DARK / LIGHT MODE
// ══════════════════════════════════════════════════════════════════════════════
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('nextheme', theme);
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.textContent = theme === 'dark' ? '' : '';
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}
(function(){ applyTheme(localStorage.getItem('nextheme') || 'dark'); })();

// ══════════════════════════════════════════════════════════════════════════════
// GLOBALE SUCHE
// ══════════════════════════════════════════════════════════════════════════════
let _searchIdx = -1;
let _searchDebounce = null;
function openSearch() {
  const ov = document.getElementById('search-overlay');
  ov.style.display = 'flex';
  setTimeout(() => document.getElementById('search-input')?.focus(), 50);
  renderSearchResults([]);
}
function closeSearch() {
  document.getElementById('search-overlay').style.display = 'none';
  document.getElementById('search-input').value = '';
  _searchIdx = -1;
}
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openSearch(); }
  if (e.key === 'Escape' && document.getElementById('search-overlay')?.style.display !== 'none') closeSearch();
});
function onSearchInput(q) {
  clearTimeout(_searchDebounce);
  if (!q.trim()) { renderSearchResults([]); return; }
  _searchDebounce = setTimeout(() => runSearch(q.trim()), 180);
}
async function runSearch(q) {
  const ql = q.toLowerCase();
  const results = [];
  try {
    const servers = await API.get('/servers');
    for (const s of servers) {
      if (s.name.toLowerCase().includes(ql) || (s.image||'').toLowerCase().includes(ql) || s.id.includes(ql))
        results.push({ type:'server', icon:'<i data-lucide="server"></i>', label:s.name, sub:s.image+' · '+(s.status||'offline'), action:()=>{ navigate('server-detail',s.id); closeSearch(); }, status:s.status });
    }
  } catch {}
  if (State.user?.role === 'admin') {
    try { const nodes = await API.get('/nodes'); for (const n of nodes) { if (n.name.toLowerCase().includes(ql)||(n.location||'').toLowerCase().includes(ql)) results.push({ type:'node', icon:'<i data-lucide="globe"></i>', label:n.name, sub:(n.location||'—')+' · '+(n.fqdn||'—'), action:()=>{ navigate('admin-nodes'); closeSearch(); } }); } } catch {}
    try { const users = await API.get('/admin/users'); for (const u of users) { if (u.username.toLowerCase().includes(ql)||u.email.toLowerCase().includes(ql)) results.push({ type:'user', icon:'<i data-lucide="user"></i>', label:u.username, sub:u.email+' · '+u.role, action:()=>{ navigate('admin-users'); closeSearch(); } }); } } catch {}
  }
  const navItems = [
    {kw:'dashboard',icon:'<i data-lucide="layout-dashboard"></i>',label:'Dashboard',action:()=>{navigate('dashboard');closeSearch();}},
    {kw:'server erstellen',icon:'<i data-lucide="plus"></i>',label:'Neuer Server',action:()=>{closeSearch();showCreateServer();}},
    {kw:'gruppen groups',icon:'<i data-lucide="folder-kanban"></i>',label:'Server-Gruppen',action:()=>{navigate('groups');closeSearch();}},
    {kw:'webhooks',icon:'<i data-lucide="link-2"></i>',label:'Webhooks',action:()=>{navigate('webhooks');closeSearch();}},
    {kw:'sessions logins',icon:'<i data-lucide="shield"></i>',label:'Aktive Sessions',action:()=>{navigate('sessions');closeSearch();}},
    {kw:'docker compose import',icon:'<i data-lucide="layers"></i>',label:'Docker Compose Import',action:()=>{closeSearch();showComposeImport();}},
    {kw:'einstellungen settings',icon:'<i data-lucide="settings"></i>',label:'Einstellungen',action:()=>{navigate('settings');closeSearch();}},
    {kw:'audit log',icon:'<i data-lucide="clipboard-list"></i>',label:'Audit Log',action:()=>{navigate('admin-audit');closeSearch();}},
  ];
  for (const n of navItems) { if (n.kw.toLowerCase().split(' ').some(k=>k.includes(ql))) results.push({type:'nav',icon:n.icon,label:n.label,sub:'Navigation',action:n.action}); }
  _searchIdx = -1;
  renderSearchResults(results.slice(0, 12));
}
function renderSearchResults(results) {
  const el = document.getElementById('search-results');
  if (!results.length) { el.innerHTML = `<div class="text-dim text-sm" style="padding:16px;text-align:center">Tippe um zu suchen…</div>`; el._results=[]; return; }
  const sc = s=>s==='running'?'#00f5a0':s==='offline'?'#64748b':'#f59e0b';
  el.innerHTML = results.map((r,i)=>`<div class="sritem" data-idx="${i}" onclick="searchResultClick(${i})" style="display:flex;align-items:center;gap:12px;padding:10px 16px;cursor:pointer;border-radius:8px;margin:2px 6px"><span style="font-size:18px;flex-shrink:0">${r.icon}</span><div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px">${esc(r.label)}</div><div class="text-dim" style="font-size:11px">${esc(r.sub||'')}</div></div>${r.status?`<span style="width:8px;height:8px;border-radius:50%;background:${sc(r.status)};flex-shrink:0"></span>`:''}<span class="text-dim" style="font-size:10px;background:var(--bg3);padding:2px 6px;border-radius:4px">${r.type}</span></div>`).join('');
  el._results = results;
}
function searchResultClick(i) { document.getElementById('search-results')._results?.[i]?.action?.(); }
function searchKeyNav(e) {
  const el = document.getElementById('search-results');
  const items = el.querySelectorAll('.sritem');
  if (!items.length) return;
  if (e.key==='ArrowDown'){e.preventDefault();_searchIdx=Math.min(_searchIdx+1,items.length-1);}
  else if(e.key==='ArrowUp'){e.preventDefault();_searchIdx=Math.max(_searchIdx-1,0);}
  else if(e.key==='Enter'&&_searchIdx>=0){el._results?.[_searchIdx]?.action?.();return;}
  items.forEach((it,i)=>it.style.background=i===_searchIdx?'var(--bg3)':'');
  items[_searchIdx]?.scrollIntoView({block:'nearest'});
}
(function(){ const s=document.createElement('style'); s.textContent='.sritem:hover{background:var(--bg3)!important}'; document.head.appendChild(s); })();

// ══════════════════════════════════════════════════════════════════════════════
// CONSOLE FILTER
// ══════════════════════════════════════════════════════════════════════════════
let _consoleFilter = '';
let _consolePaused = false;
let _consoleBuffer  = [];
const MAX_CONSOLE_LINES = 2000;
