/* NexPanel — admin.js
 * Admin area: nodes, users, eggs, allocations, audit, docker, scaling
 */

// ─── ADMIN: NODES (v2 vollständig) ───────────────────────────────────────────
async function loadAdminNodes() {
  document.getElementById('page-actions').innerHTML = `<button class="btn btn-primary" onclick="showCreateNode()"><i data-lucide="plus"></i> Node hinzufügen</button>`;
  const nodes = await API.get('/nodes').catch(() => []);
  nodes.forEach(n => { State.nodes[n.id] = n; });

  if (nodes.length === 0) {
    document.getElementById('page-content').innerHTML = `<div class="empty"><div class="empty-icon"><i data-lucide="globe"></i></div><h3>Keine Nodes</h3><p>Füge deinen ersten Node hinzu und starte den Daemon darauf.</p><button class="btn btn-primary" style="margin-top:16px" onclick="showCreateNode()"><i data-lucide="plus"></i> Node hinzufügen</button></div>`;
    return;
  }

  const html = nodes.map(n => {
    const on = n.connected;
    const si = n.system_info || {};
    const memGB = si.memory_total ? (si.memory_total/1024**3).toFixed(1)+'GB' : '?';
    return `
      <div class="node-card ${on ? (n.is_local?'local':'online') : 'offline'}">
        <div class="node-header">
          <div>
            <div class="node-name">${esc(n.name)} ${n.is_local?'<span class="chip chip-local text-xs">Lokal</span>':''} ${n.is_default?'<span class="chip chip-local text-xs"><i data-lucide="star" style="width:10px;height:10px"></i> Standard</span>':''}</div>
            <div class="node-fqdn">${esc(n.fqdn)}</div>
            <div class="text-dim text-xs" style="margin-top:3px">${esc(n.location)}</div>
          </div>
          <span class="chip ${on ? (n.is_local?'chip-local':'chip-online') : 'chip-offline'}">${n.is_local ? '<i data-lucide="zap"></i> Lokal' : on ? '● Online' : '○ Offline'}</span>
        </div>
        ${on && si.cpus ? `
          <div class="node-stats-row">
            <div class="node-stat"><div class="node-stat-val">${si.cpus}</div><div class="node-stat-lbl">CPUs</div></div>
            <div class="node-stat"><div class="node-stat-val">${memGB}</div><div class="node-stat-lbl">RAM</div></div>
            <div class="node-stat"><div class="node-stat-val">${si.containers_running||0}</div><div class="node-stat-lbl">Container</div></div>
            <div class="node-stat"><div class="node-stat-val">${n.server_count||0}</div><div class="node-stat-lbl">Server</div></div>
          </div>
          ${si.os ? `<div class="text-dim text-xs mt-8"><i data-lucide="terminal"></i> ${esc(si.os)} • Docker ${esc(si.docker_version||'?')} • ${esc(si.hostname||'')}</div>` : ''}
        ` : !on && !n.is_local ? `<div class="warn-msg" style="margin:10px 0 0">Daemon nicht verbunden. Starte den Daemon auf dem Node-Server.</div>` : ''}
        <div class="node-actions">
          ${!n.is_local?`<button class="btn btn-ghost btn-sm" onclick="showNodeImages('${n.id}','${esc(n.name)}')"><i data-lucide="box"></i> Images</button>`:''}
          ${!n.is_local?`<button class="btn btn-ghost btn-sm" onclick="showRotateToken('${n.id}','${esc(n.name)}')"><i data-lucide="rotate-ccw"></i> Token</button>`:''}
          <button class="btn btn-ghost btn-sm" onclick="showEditNode('${n.id}')"><i data-lucide="pencil"></i> Edit</button>
          ${!n.is_local?`<button class="btn btn-ghost btn-sm text-danger" onclick="confirmDeleteNode('${n.id}','${esc(n.name)}')"><i data-lucide="trash-2"></i></button>`:''}
        </div>
        <div class="mt-8 text-xs" style="display:flex;justify-content:space-between">
          ${!n.is_local ? `<span class="text-dim">Token: <span class="text-mono text-accent">${esc(n.token_prefix||'?')}…</span></span>` : '<span></span>'}
          ${n.last_seen ? `<span class="text-dim">Zuletzt: ${new Date(n.last_seen).toLocaleString('de-DE')}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  document.getElementById('page-content').innerHTML = `<div class="grid grid-2">${html}</div>`;
}

function showCreateNode() {
  showModal(`
    <div class="modal-title"><span><i data-lucide="plus"></i> Neuer Node</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="info-msg">Nach dem Erstellen erhältst du ein Token, das du <strong>nur einmal</strong> siehst. Sofort kopieren!</div>
    <div class="grid grid-2">
      <div class="form-group"><label class="form-label">Name *</label><input type="text" id="m-nname" class="form-input" placeholder="EU-Node-1"/></div>
      <div class="form-group"><label class="form-label">FQDN / IP *</label><input type="text" id="m-fqdn" class="form-input" placeholder="node1.example.com oder 1.2.3.4"/></div>
    </div>
    <div class="grid grid-2">
      <div class="form-group"><label class="form-label">Standort</label><input type="text" id="m-loc" class="form-input" value="Default" placeholder="Frankfurt, DE"/></div>
      <div class="form-group"><label class="form-label">Max. RAM (MB)</label><input type="number" id="m-nmem" class="form-input" value="4096"/></div>
    </div>
    <div id="m-error" class="error-msg hidden"></div>
    <div id="node-result" class="hidden"></div>
    <div class="modal-footer" id="m-ft">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitCreateNode()">Node erstellen</button>
    </div>`, true);
}

async function submitCreateNode() {
  const name = document.getElementById('m-nname').value.trim();
  const fqdn = document.getElementById('m-fqdn').value.trim();
  if (!name || !fqdn) { mErr('Name und FQDN erforderlich'); return; }
  try {
    const d = await API.post('/nodes', { name, fqdn, location: document.getElementById('m-loc').value.trim()||'Default', memory_mb: parseInt(document.getElementById('m-nmem').value)||4096 });
    document.getElementById('m-error').classList.add('hidden');
    document.getElementById('m-ft').innerHTML = `<button class="btn btn-primary" onclick="closeModal();navigate('admin-nodes')">Fertig → Nodes anzeigen</button>`;
    document.getElementById('node-result').innerHTML = `
      <div class="success-msg"><i data-lucide="check-circle"></i> Node <strong>${esc(d.name)}</strong> erstellt!</div>
      <div class="setup-box">
        <h4><i data-lucide="key"></i> Token (nur jetzt sichtbar!)</h4>
        <div class="token-box">${esc(d.token)}</div>
        <h4 style="margin-top:16px"><i data-lucide="clipboard-list"></i> Daemon starten</h4>
        <div class="env-display">
          <span class="env-key">NODE_ID</span>=<span class="env-val">"${esc(d.id)}"</span><br>
          <span class="env-key">NODE_TOKEN</span>=<span class="env-val">"${esc(d.token)}"</span><br>
          <span class="env-key">PANEL_URL</span>=<span class="env-val">"ws://&lt;dein-panel-ip&gt;:3000"</span>
        </div>
        <div class="code-box">cd daemon && npm install && node daemon.js</div>
      </div>`;
    document.getElementById('node-result').classList.remove('hidden');
    loadAdminNodes();
  } catch (e) { mErr(e.message); }
}

async function showRotateToken(id, name) {
  showModal(`
    <div class="modal-title"><span><i data-lucide="rotate-ccw"></i> Token rotieren</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="warn-msg">Achtung: Der Daemon auf <strong>${esc(name)}</strong> muss danach neu gestartet werden!</div>
    <div id="rotate-result" class="hidden"></div>
    <div class="modal-footer" id="rotate-ft">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-warn" onclick="doRotateToken('${id}')">Neues Token generieren</button>
    </div>`);
}
async function doRotateToken(id) {
  try {
    const d = await API.post(`/nodes/${id}/rotate-token`, {});
    document.getElementById('rotate-ft').innerHTML = `<button class="btn btn-primary" onclick="closeModal()">Fertig</button>`;
    document.getElementById('rotate-result').innerHTML = `
      <div class="success-msg mt-8">Neues Token generiert!</div>
      <div class="setup-box">
        <h4>Neues Token</h4><div class="token-box">${esc(d.token)}</div>
        <div class="code-box" style="margin-top:12px">NODE_TOKEN="${esc(d.token)}" node daemon.js</div>
      </div>`;
    document.getElementById('rotate-result').classList.remove('hidden');
  } catch (e) { mErr(e.message); }
}

async function showNodeImages(id, name) {
  showModal(`<div class="modal-title"><span><i data-lucide="box"></i> Images — ${esc(name)}</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div><div class="empty" style="padding:32px"><div class="spin"><i data-lucide="loader"></i></div></div>`, true);
  try {
    const images = await API.get(`/nodes/${id}/images`);
    document.querySelector('.modal').innerHTML = `
      <div class="modal-title"><span><i data-lucide="box"></i> Images — ${esc(name)}</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
      <div style="display:flex;gap:8px;margin-bottom:14px"><input type="text" id="pull-img" class="form-input flex-1" placeholder="nginx:latest"/><button class="btn btn-primary" onclick="doPullOnNode('${id}')"><i data-lucide="download"></i> Pull</button></div>
      <div id="pull-status"></div>
      <div style="max-height:360px;overflow-y:auto">
        <table class="table"><thead><tr><th>Image</th><th>Größe</th><th>ID</th></tr></thead>
        <tbody>${images.map(img => `<tr><td class="text-mono text-accent text-sm">${esc((img.tags||['<none>']).join(', '))}</td><td class="text-mono">${fmtBytes(img.size||0)}</td><td class="text-mono text-dim text-sm">${esc(img.id||'')}</td></tr>`).join('')}</tbody></table>
      </div>
      <div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal()">Schließen</button></div>`;
  } catch (e) { document.querySelector('.modal').querySelector('.empty').innerHTML = `<p class="text-danger">${esc(e.message)}</p>`; }
}
async function doPullOnNode(nodeId) {
  const img = document.getElementById('pull-img').value.trim(); if (!img) return;
  const st = document.getElementById('pull-status');
  st.innerHTML = `<div class="info-msg"><i data-lucide="loader-2" class="spin"></i> Ziehe ${esc(img)}…</div>`;
  try { await API.post(`/nodes/${nodeId}/images/pull`, { image: img }); st.innerHTML = `<div class="success-msg"><i data-lucide="check-circle"></i>  ${esc(img)} gepullt!</div>`; } catch (e) { st.innerHTML = `<div class="error-msg"><i data-lucide="x-circle"></i> ${esc(e.message)}</div>`; }
}

async function showEditNode(id) {
  const nodes = await API.get('/nodes'); const n = nodes.find(x=>x.id===id); if(!n) return;
  showModal(`
    <div class="modal-title"><span><i data-lucide="pencil"></i> Node bearbeiten</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="grid grid-2">
      <div class="form-group"><label class="form-label">Name</label><input type="text" id="m-nname" class="form-input" value="${esc(n.name)}"/></div>
      <div class="form-group"><label class="form-label">Standort</label><input type="text" id="m-loc" class="form-input" value="${esc(n.location)}"/></div>
    </div>
    <div class="grid grid-2">
      <div class="form-group"><label class="form-label">Max. RAM (MB)</label><input type="number" id="m-nmem" class="form-input" value="${n.memory_mb}"/></div>
      <div class="form-group"><label class="form-label">Max. Disk (MB)</label><input type="number" id="m-ndisk" class="form-input" value="${n.disk_mb}"/></div>
    </div>
    <div class="form-group"><label class="form-label"><input type="checkbox" id="m-def" ${n.is_default?'checked':''}/> Als Standard-Node setzen</label></div>
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitEditNode('${id}')">Speichern</button>
    </div>`);
}
async function submitEditNode(id) {
  try {
    await API.patch(`/nodes/${id}`, { name:document.getElementById('m-nname').value.trim(), location:document.getElementById('m-loc').value.trim(), memory_mb:parseInt(document.getElementById('m-nmem').value), disk_mb:parseInt(document.getElementById('m-ndisk').value), is_default:document.getElementById('m-def').checked });
    toast('Node gespeichert!','success'); closeModal(); navigate('admin-nodes');
  } catch (e) { mErr(e.message); }
}
function confirmDeleteNode(id, name) {
  showModal(`
    <div class="modal-title"><span style="color:var(--danger)"><i data-lucide="trash-2"></i> Node löschen</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <p>Node <strong>${esc(name)}</strong> löschen? Alle Server müssen zuerst entfernt werden.</p>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-danger" onclick="doDeleteNode('${id}')">Löschen</button>
    </div>`);
}
async function doDeleteNode(id) {
  try { await API.delete(`/nodes/${id}`); toast('Node gelöscht','success'); closeModal(); navigate('admin-nodes'); } catch (e) { toast(e.message,'error'); closeModal(); }
}

// ─── ADMIN: USERS ────────────────────────────────────────────────────────────
async function loadAdminUsers() {
  document.getElementById('page-actions').innerHTML = `<button class="btn btn-primary" onclick="showCreateUser()"><i data-lucide="plus"></i> Neuer Benutzer</button>`;
  try {
    const users = await API.get('/admin/users');
    document.getElementById('page-content').innerHTML = `
      <div class="card"><table class="table">
        <thead><tr><th>Benutzer</th><th>Email</th><th>Rolle</th><th>Server</th><th>Status</th><th>Erstellt</th><th></th></tr></thead>
        <tbody>${users.map(u => `<tr>
          <td><div style="display:flex;align-items:center;gap:10px"><div style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent3));display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#000;flex-shrink:0">${u.username[0].toUpperCase()}</div>${esc(u.username)}</div></td>
          <td class="text-muted text-sm">${esc(u.email)}</td>
          <td><span class="chip ${u.role==='admin'?'chip-admin':'chip-offline'}">${u.role}</span></td>
          <td class="text-mono">${u.server_count||0}</td>
          <td><span class="chip ${u.is_suspended?'chip-offline':'chip-online'}">${u.is_suspended?'Gesperrt':'Aktiv'}</span>${u.is_suspended&&u.suspend_reason?`<div class="text-dim" style="font-size:11px;margin-top:2px">${esc(u.suspend_reason)}</div>`:''}</td>
          <td class="text-dim text-sm">${new Date(u.created_at).toLocaleDateString('de-DE')}</td>
          <td><div style="display:flex;gap:6px">
            <button class="btn btn-ghost btn-sm" onclick="showEditUser('${u.id}','${esc(u.username)}','${esc(u.email)}','${u.role}',${u.is_suspended},'${esc(u.suspend_reason||'')}')">Edit</button>
            ${u.id!==State.user.id?`<button class="btn btn-ghost btn-sm text-danger" onclick="confirmDeleteUser('${u.id}','${esc(u.username)}')">Löschen</button>`:''}
          </div></td>
        </tr>`).join('')}</tbody>
      </table></div>`;
  } catch (e) { document.getElementById('page-content').innerHTML = `<div class="empty"><p class="text-danger">${esc(e.message)}</p></div>`; }
}
function showCreateUser() {
  showModal(`
    <div class="modal-title"><span><i data-lucide="plus"></i> Neuer Benutzer</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group"><label class="form-label">Username</label><input type="text" id="m-uname" class="form-input"/></div>
    <div class="form-group"><label class="form-label">Email</label><input type="email" id="m-uemail" class="form-input"/></div>
    <div class="form-group"><label class="form-label">Passwort</label><input type="password" id="m-upass" class="form-input"/></div>
    <div class="form-group"><label class="form-label">Rolle</label><select id="m-urole" class="form-input"><option value="user">User</option><option value="admin">Admin</option></select></div>
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button><button class="btn btn-primary" onclick="submitCreateUser()">Erstellen</button></div>`);
}
async function submitCreateUser() {
  try { await API.post('/admin/users', { username:document.getElementById('m-uname').value.trim(), email:document.getElementById('m-uemail').value.trim(), password:document.getElementById('m-upass').value, role:document.getElementById('m-urole').value }); toast('Benutzer erstellt!','success'); closeModal(); loadAdminUsers(); } catch (e) { mErr(e.message); }
}
function showEditUser(id, username, email, role, suspended, suspendReason='') {
  showModal(`
    <div class="modal-title"><span><i data-lucide="pencil"></i> Benutzer bearbeiten</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group"><label class="form-label">Username</label><input type="text" id="m-uname" class="form-input" value="${esc(username)}"/></div>
    <div class="form-group"><label class="form-label">Email</label><input type="email" id="m-uemail" class="form-input" value="${esc(email)}"/></div>
    <div class="form-group"><label class="form-label">Neues Passwort (leer = unverändert)</label><input type="password" id="m-upass" class="form-input"/></div>
    <div class="grid grid-2">
      <div class="form-group"><label class="form-label">Rolle</label><select id="m-urole" class="form-input"><option value="user" ${role==='user'?'selected':''}>User</option><option value="admin" ${role==='admin'?'selected':''}>Admin</option></select></div>
      <div class="form-group"><label class="form-label">Status</label><select id="m-ususp" class="form-input"><option value="0" ${!suspended?'selected':''}>Aktiv</option><option value="1" ${suspended?'selected':''}>Gesperrt</option></select></div>
    </div>
    <div class="form-group" id="suspend-reason-row" style="${suspended?'':'display:none'}">
      <label class="form-label">Sperr-Begründung (für den User sichtbar)</label>
      <input type="text" id="m-suspreason" class="form-input" value="${esc(suspendReason||'')}" placeholder="z.B. Verstoß gegen Nutzungsbedingungen"/>
    </div>
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button><button class="btn btn-primary" onclick="submitEditUser('${id}')">Speichern</button></div>`);
  document.getElementById('m-ususp')?.addEventListener('change', function(){ document.getElementById('suspend-reason-row').style.display = this.value==='1'?'':'none'; });
}
async function submitEditUser(id) {
  const body = { username:document.getElementById('m-uname').value.trim(), email:document.getElementById('m-uemail').value.trim(), role:document.getElementById('m-urole').value, is_suspended:parseInt(document.getElementById('m-ususp').value), suspend_reason: document.getElementById('m-suspreason')?.value||'' };
  const p = document.getElementById('m-upass').value; if(p) body.password=p;
  try { await API.patch(`/admin/users/${id}`,body); toast('Gespeichert!','success'); closeModal(); loadAdminUsers(); } catch (e) { mErr(e.message); }
}
function confirmDeleteUser(id, name) {
  showModal(`<div class="modal-title"><span style="color:var(--danger)">Benutzer löschen</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div><p><strong>${esc(name)}</strong> und alle Server löschen?</p><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button><button class="btn btn-danger" onclick="deleteUser('${id}')">Löschen</button></div>`);
}
async function deleteUser(id) {
  try { await API.delete(`/admin/users/${id}`); toast('Gelöscht','success'); closeModal(); loadAdminUsers(); } catch (e) { toast(e.message,'error'); }
}

// ─── EGGS PAGE ────────────────────────────────────────────────────────────────
async function loadAdminEggs() {
  document.getElementById('page-actions').innerHTML = `
    <button class="btn btn-ghost" onclick="showPteroImportEgg()"><i data-lucide="download"></i> Pterodactyl Import</button>
    <button class="btn btn-ghost" onclick="showPteroImportHistory()"><i data-lucide="history"></i> Import-Verlauf</button>
    <button class="btn btn-primary" onclick="showCreateEgg()"><i data-lucide="plus"></i> Neues Egg</button>
  `;
  const eggs = await API.get('/eggs').catch(() => []);
  const categories = [...new Set(eggs.map(e => e.category))].sort();
  const byCategory = cat => eggs.filter(e => e.category === cat);
  const catLabels = { minecraft:'<i data-lucide="pickaxe"></i> Minecraft', gameserver:'<i data-lucide="gamepad-2"></i> Game Server', monitoring:'<i data-lucide="activity"></i> Monitoring', webserver:'<i data-lucide="globe"></i> Webserver', generic:'<i data-lucide="wrench"></i> Generic', other:'<i data-lucide="wrench"></i> Sonstige' };
  document.getElementById('page-content').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:28px">
      ${categories.map(cat => `
        <div>
          <div class="card-header" style="margin-bottom:14px">
            <h3 style="font-size:14px;font-weight:600;color:var(--text2)">${catLabels[cat] || cat}</h3>
            <span class="text-dim text-sm">${byCategory(cat).length} Templates</span>
          </div>
          <div class="egg-grid">
            ${byCategory(cat).map(egg => `
              <div class="egg-card" onclick="showEggDetail('${egg.id}')">
                <div class="egg-icon">${egg.icon}</div>
                <div class="egg-name">${esc(egg.name)}</div>
                <div class="egg-image">${esc(egg.docker_image)}</div>
                <div class="egg-desc">${esc(egg.description||'')}</div>
                <span class="egg-category">${egg.category}</span>
                ${egg.is_builtin ? '<span class="chip chip-local" style="float:right;margin-top:8px">built-in</span>' : ''}
              </div>`).join('')}
          </div>
        </div>`).join('')}
      ${eggs.length === 0 ? '<div class="empty"><div class="empty-icon"><i data-lucide="egg"></i></div><h3>Keine Eggs</h3><p>Erstelle das erste Template</p></div>' : ''}
    </div>`;
}

async function showEggDetail(id) {
  const egg = await API.get(`/eggs/${id}`).catch(() => null);
  if (!egg) return;
  showModal(`
    <div class="modal-title">
      <span>${egg.icon} ${esc(egg.name)}</span>
      <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
    </div>
    <div class="info-msg" style="margin-bottom:16px">
      <strong>Docker Image:</strong> <span class="text-mono">${esc(egg.docker_image)}</span>
    </div>
    <p class="text-dim text-sm" style="margin-bottom:16px">${esc(egg.description||'')}</p>
    ${egg.env_vars?.length ? `
      <div class="form-group">
        <label class="form-label">Umgebungsvariablen</label>
        ${egg.env_vars.map(v => `
          <div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
            <span class="text-mono text-accent text-sm" style="min-width:140px">${esc(v.key)}</span>
            <span class="text-dim text-sm">=</span>
            <span class="text-mono text-sm">${esc(v.default||'')}</span>
            ${v.required?'<span class="chip" style="background:rgba(255,59,92,.1);color:var(--danger);font-size:10px">required</span>':''}
          </div>`).join('')}
      </div>` : ''}
    <div class="modal-footer">
      ${!egg.is_builtin ? `<button class="btn btn-danger btn-sm" onclick="deleteEgg('${egg.id}')"><i data-lucide="trash-2"></i> Löschen</button>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="exportEggAsPtdl('${egg.id}')" title="Als Pterodactyl JSON exportieren"><i data-lucide="upload"></i> Exportieren</button>
      <button class="btn btn-ghost" onclick="closeModal()">Schließen</button>
      <button class="btn btn-primary" onclick="closeModal();showCreateServerFromEgg('${egg.id}')"><i data-lucide="plus"></i> Server mit Egg erstellen</button>
    </div>`, true);
}

function showCreateEgg() {
  showModal(`
    <div class="modal-title"><span><i data-lucide="egg"></i> Neues Egg</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="grid grid-2">
      <div class="form-group"><label class="form-label">Name *</label><input type="text" id="egg-name" class="form-input" placeholder="Mein Server Template"/></div>
      <div class="form-group"><label class="form-label">Icon</label><input type="text" id="egg-icon" class="form-input" value=""/></div>
    </div>
    <div class="form-group"><label class="form-label">Docker Image *</label><input type="text" id="egg-image" class="form-input" placeholder="nginx:alpine"/></div>
    <div class="grid grid-2">
      <div class="form-group"><label class="form-label">Kategorie</label>
        <select id="egg-cat" class="form-input">
          <option value="generic">Generic</option><option value="gameserver">Game Server</option>
          <option value="minecraft">Minecraft</option><option value="webserver">Web Server</option>
          <option value="monitoring">Monitoring</option><option value="other">Andere</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Stop-Command</label><input type="text" id="egg-stop" class="form-input" placeholder="stop" value=""/></div>
    </div>
    <div class="form-group"><label class="form-label">Startup Command</label><input type="text" id="egg-startup" class="form-input" placeholder="node index.js"/></div>
    <div class="form-group"><label class="form-label">Beschreibung</label><textarea id="egg-desc" class="form-input" rows="2" placeholder="Kurzbeschreibung..."></textarea></div>
    <div class="form-group"><label class="form-label">ENV Variables (JSON Array)</label>
      <textarea id="egg-envvars" class="form-input" style="font-family:var(--mono);font-size:12px" rows="4" placeholder='[{"key":"PORT","default":"3000","description":"HTTP Port","required":false}]'>[]</textarea>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="doCreateEgg()">Egg erstellen</button>
    </div>`, true);
}

async function doCreateEgg() {
  try {
    const body = {
      name:            document.getElementById('egg-name').value,
      icon:            document.getElementById('egg-icon').value || 'egg',
      docker_image:    document.getElementById('egg-image').value,
      category:        document.getElementById('egg-cat').value,
      config_stop:     document.getElementById('egg-stop').value,
      startup_command: document.getElementById('egg-startup').value,
      description:     document.getElementById('egg-desc').value,
      env_vars:        JSON.parse(document.getElementById('egg-envvars').value || '[]'),
    };
    if (!body.name || !body.docker_image) return toast('Name und Image erforderlich', 'error');
    await API.post('/eggs', body);
    toast('Egg erstellt!', 'success'); closeModal(); loadAdminEggs();
  } catch (e) { toast('Fehler: '+e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// PTERODACTYL IMPORT — Egg Import Modal + Server Import
// ═══════════════════════════════════════════════════════════════

// ── Warnungs-Badge ─────────────────────────────────────────────
function renderWarnings(warnings = []) {
  if (!warnings.length) return '';
  return `<div style="margin-top:12px;display:flex;flex-direction:column;gap:6px">
    ${warnings.map(w => `
      <div style="display:flex;gap:8px;align-items:flex-start;padding:7px 10px;border-radius:6px;
        background:${w.level==='error'?'rgba(255,59,92,.1)':w.level==='warn'?'rgba(245,158,11,.1)':'rgba(0,212,255,.07)'};
        border:1px solid ${w.level==='error'?'rgba(255,59,92,.25)':w.level==='warn'?'rgba(245,158,11,.25)':'rgba(0,212,255,.15)'}">
        <i data-lucide="${w.level==='error'?'alert-circle':w.level==='warn'?'alert-triangle':'info'}"
           style="width:13px;height:13px;flex-shrink:0;margin-top:1px;
           color:${w.level==='error'?'var(--danger)':w.level==='warn'?'var(--warn)':'var(--accent)'}"></i>
        <span style="font-size:12px;color:var(--text2)">${esc(w.msg)}</span>
      </div>`).join('')}
  </div>`;
}

// ── Preview-Karte für ein Egg ──────────────────────────────────
function renderEggPreviewCard(egg, warnings = [], index = 0, showImport = false) {
  const req = (egg.env_vars||[]).filter(v=>v.required).length;
  const opt = (egg.env_vars||[]).length - req;
  return `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:10px" id="egg-prev-${index}">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <span class="egg-preview-icon">${egg.icon && egg.icon.length<=4 ? egg.icon : '<i data-lucide="package"></i>'}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:14px">${esc(egg.name)}</div>
          <div style="font-size:11px;color:var(--text3);font-family:var(--mono)">${esc(egg.docker_image)}</div>
        </div>
        <span style="font-size:10px;background:var(--card2);padding:3px 8px;border-radius:8px;color:var(--text2)">${esc(egg.category)}</span>
      </div>
      ${egg.description ? `<p style="font-size:12px;color:var(--text2);margin-bottom:8px">${esc(egg.description.split('\n')[0])}</p>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        ${egg.startup_command ? `<span style="font-size:11px;font-family:var(--mono);background:rgba(0,212,255,.08);color:var(--accent);padding:2px 8px;border-radius:4px">${esc(egg.startup_command.slice(0,60))}${egg.startup_command.length>60?'…':''}</span>` : ''}
        ${req > 0  ? `<span style="font-size:11px;background:rgba(245,158,11,.1);color:var(--warn);padding:2px 8px;border-radius:4px">${req} Pflichtvar.</span>` : ''}
        ${opt > 0  ? `<span style="font-size:11px;background:rgba(0,212,255,.07);color:var(--text2);padding:2px 8px;border-radius:4px">${opt} opt. Var.</span>` : ''}
        ${(egg._meta?.image_count||0)>1 ? `<span style="font-size:11px;background:rgba(99,102,241,.1);color:#c084fc;padding:2px 8px;border-radius:4px">${egg._meta.image_count} Images</span>` : ''}
      </div>
      ${(egg.env_vars||[]).length ? `
        <details style="margin-top:8px">
          <summary style="font-size:12px;color:var(--text3);cursor:pointer">ENV Variablen (${(egg.env_vars||[]).length})</summary>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">
            ${(egg.env_vars||[]).map(v => `
              <div style="display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)">
                <code style="font-size:11px;color:var(--accent);min-width:160px;flex-shrink:0">${esc(v.key)}</code>
                <code style="font-size:11px;color:var(--text2);flex:1">${esc(v.default||'—')}</code>
                ${v.required?'<span style="font-size:10px;color:var(--danger)">required</span>':''}
              </div>`).join('')}
          </div>
        </details>` : ''}
      ${renderWarnings(warnings)}
      ${showImport ? `
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="pteroSkipEgg(${index})"><i data-lucide="x"></i> Überspringen</button>
          <button class="btn btn-primary btn-sm" id="egg-import-btn-${index}" onclick="pteroDoImportEgg(${index})"><i data-lucide="download"></i> Importieren</button>
        </div>` : ''}
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE EGG IMPORT
// ─────────────────────────────────────────────────────────────────────────────
let _pteroEggPreviewData = null;

async function showPteroImportEgg() {
  _pteroEggPreviewData = null;
  showModal(`
    <div class="modal-title">
      <span><i data-lucide="download"></i> Pterodactyl Egg importieren</span>
      <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
    </div>
    <div class="info-msg" style="margin-bottom:16px">
      Füge das JSON eines Pterodactyl Eggs ein (PTDL_v1 / PTDL_v2) oder lade eine <code>.json</code> Datei hoch.
      <br><a href="https://github.com/pterodactyl/eggs" target="_blank" style="color:var(--accent);font-size:12px">
        <i data-lucide="external-link" style="width:11px;height:11px"></i> Offizielle Pterodactyl Eggs auf GitHub</a>
    </div>

    <!-- Tabs: Einfügen / Datei -->
    <div style="display:flex;gap:4px;background:var(--bg2);border-radius:8px;padding:4px;margin-bottom:16px">
      <button class="btn btn-ghost btn-sm" style="flex:1" id="ptero-tab-paste" onclick="pteroSwitchTab('paste')"
        style="background:var(--card2);color:var(--text)"><i data-lucide="clipboard"></i> JSON einfügen</button>
      <button class="btn btn-ghost btn-sm" style="flex:1" id="ptero-tab-file" onclick="pteroSwitchTab('file')">
        <i data-lucide="file-up"></i> Datei hochladen</button>
      <button class="btn btn-ghost btn-sm" style="flex:1" id="ptero-tab-bulk" onclick="pteroSwitchTab('bulk')">
        <i data-lucide="layers"></i> Bulk (mehrere)</button>
    </div>

    <!-- JSON Paste -->
    <div id="ptero-panel-paste">
      <div class="form-group">
        <label class="form-label">Egg JSON</label>
        <textarea id="ptero-egg-json" class="form-input"
          style="font-family:var(--mono);font-size:11px;height:180px"
          placeholder='{"meta":{"version":"PTDL_v1"},"name":"My Egg","docker_images":{"Default":"image:tag"},...}'
          oninput="pteroEggJsonChanged()"></textarea>
      </div>
    </div>

    <!-- File Upload -->
    <div id="ptero-panel-file" class="hidden">
      <div class="form-group">
        <label class="form-label">JSON-Datei wählen</label>
        <div id="ptero-drop-zone" style="border:2px dashed var(--border);border-radius:10px;padding:32px;text-align:center;cursor:pointer"
          onclick="document.getElementById('ptero-file-input').click()"
          ondragover="event.preventDefault();this.style.borderColor='var(--accent)'"
          ondragleave="this.style.borderColor='var(--border)'"
          ondrop="pteroHandleFileDrop(event)">
          <i data-lucide="file-json" style="width:32px;height:32px;opacity:.4;margin-bottom:8px;display:block;margin:0 auto 8px"></i>
          <div style="color:var(--text2);font-size:13px">Datei hierher ziehen oder <span style="color:var(--accent)">auswählen</span></div>
          <div style="font-size:11px;color:var(--text3);margin-top:4px">Unterstützt: .json, PTDL_v1, PTDL_v2, NexPanel Re-Export</div>
        </div>
        <input type="file" id="ptero-file-input" accept=".json" class="hidden" onchange="pteroHandleFileSelect(event)"/>
      </div>
    </div>

    <!-- Bulk -->
    <div id="ptero-panel-bulk" class="hidden">
      <div class="info-msg" style="margin-bottom:12px;font-size:12px">
        Mehrere Egg-JSONs importieren — füge ein JSON-Array ein oder wähle mehrere Dateien.
      </div>
      <div class="form-group">
        <label class="form-label">JSON Array (mehrere Eggs)</label>
        <textarea id="ptero-bulk-json" class="form-input"
          style="font-family:var(--mono);font-size:11px;height:160px"
          placeholder='[{"name":"Egg 1",...}, {"name":"Egg 2",...}]'></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Oder mehrere Dateien</label>
        <input type="file" id="ptero-bulk-files" accept=".json" multiple class="form-input"
          onchange="pteroHandleBulkFiles(event)"/>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <label class="toggle-wrap"><input type="checkbox" id="ptero-bulk-overwrite" class="toggle-cb"/><div class="toggle-track"><div class="toggle-thumb"></div></div></label>
        <span style="font-size:13px;color:var(--text2)">Bestehende Eggs überschreiben</span>
      </div>
    </div>

    <!-- Preview Area -->
    <div id="ptero-preview-area"></div>

    <!-- Overwrite toggle (single) -->
    <div style="display:flex;align-items:center;gap:8px;margin-top:12px" id="ptero-overwrite-row" class="hidden">
      <label class="toggle-wrap"><input type="checkbox" id="ptero-overwrite" class="toggle-cb"/><div class="toggle-track"><div class="toggle-thumb"></div></div></label>
      <span style="font-size:13px;color:var(--text2)">Bestehendes Egg überschreiben falls vorhanden</span>
    </div>

    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-ghost" id="ptero-server-import-btn" class="hidden" onclick="showPteroServerImport()" style="display:none">
        <i data-lucide="server"></i> Stattdessen Server importieren
      </button>
      <button class="btn btn-primary" id="ptero-import-btn" onclick="doPteroEggImport()" disabled>
        <i data-lucide="download"></i> Importieren
      </button>
    </div>`, true);

  pteroSwitchTab('paste');
  // Update topbar area badge
  const badge = document.getElementById('area-badge');
  if (badge) badge.classList.toggle('hidden', area !== 'admin');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

let _pteroCurrentTab = 'paste';
let _pteroBulkEggs   = [];

function pteroSwitchTab(tab) {
  _pteroCurrentTab = tab;
  ['paste','file','bulk'].forEach(t => {
    const panel = document.getElementById('ptero-panel-'+t);
    const btn   = document.getElementById('ptero-tab-'+t);
    if (panel) panel.classList.toggle('hidden', t !== tab);
    if (btn) {
      btn.style.background = t === tab ? 'var(--card2)' : '';
      btn.style.color      = t === tab ? 'var(--text)'  : '';
    }
  });
  document.getElementById('ptero-preview-area').innerHTML = '';
  const btn = document.getElementById('ptero-import-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="download"></i> Importieren'; }
  _pteroEggPreviewData = null;
  _pteroBulkEggs = [];
}

function pteroEggJsonChanged() {
  // Auto-preview nach kurzer Pause
  clearTimeout(window._pteroPreviewTimer);
  window._pteroPreviewTimer = setTimeout(pteroDoPreview, 600);
}

async function pteroDoPreview() {
  const jsonStr = (document.getElementById('ptero-egg-json')?.value || '').trim();
  if (!jsonStr) return;
  const area = document.getElementById('ptero-preview-area');
  area.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px 0">Analysiere…</div>';
  try {
    const result = await API.post('/ptero/egg/preview', { json: jsonStr });
    _pteroEggPreviewData = result;
    area.innerHTML = `
      <div style="margin-top:16px">
        <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px">Vorschau</div>
        ${result.duplicate ? `<div class="warn-msg" style="margin-bottom:8px;font-size:12px">
          <i data-lucide="alert-triangle"></i> Egg existiert bereits: <strong>${esc(result.duplicate.name)}</strong> — aktiviere "Überschreiben" um fortzufahren
        </div>` : ''}
        ${renderEggPreviewCard(result.egg, result.warnings||[])}
      </div>`;
    document.getElementById('ptero-overwrite-row')?.classList.toggle('hidden', !result.duplicate);
    const btn = document.getElementById('ptero-import-btn');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="download"></i> Importieren'; }
    if (typeof lucide !== 'undefined') lucide.createIcons();
  } catch (e) {
    area.innerHTML = `<div class="error-msg" style="margin-top:12px;font-size:12px">${esc(e.message)}</div>`;
  }
}

function pteroHandleFileDrop(e) {
  e.preventDefault();
  document.getElementById('ptero-drop-zone').style.borderColor = 'var(--border)';
  const file = e.dataTransfer.files[0];
  if (file) pteroLoadFile(file);
}
function pteroHandleFileSelect(e) {
  const file = e.target.files[0];
  if (file) pteroLoadFile(file);
}
function pteroLoadFile(file) {
  const reader = new FileReader();
  reader.onload = async ev => {
    const jsonStr = ev.target.result;
    // Try as single or bulk
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        // Multiple eggs in one file
        pteroSwitchTab('bulk');
        document.getElementById('ptero-bulk-json').value = jsonStr;
        await pteroPreviewBulk(parsed);
        return;
      }
    } catch(_) {}
    pteroSwitchTab('paste');
    document.getElementById('ptero-egg-json').value = jsonStr;
    await pteroDoPreview();
    document.getElementById('ptero-drop-zone') && (document.getElementById('ptero-drop-zone').style.borderColor = 'var(--accent3)');
  };
  reader.readAsText(file);
}

async function pteroHandleBulkFiles(e) {
  const files = Array.from(e.target.files);
  const jsons = [];
  await Promise.all(files.map(f => new Promise(res => {
    const r = new FileReader();
    r.onload = ev => { jsons.push(ev.target.result); res(); };
    r.readAsText(f);
  })));
  const eggs = jsons.flatMap(j => { try { const p=JSON.parse(j); return Array.isArray(p)?p:[p]; } catch(_){return [];} });
  if (eggs.length) {
    document.getElementById('ptero-bulk-json').value = JSON.stringify(eggs, null, 2);
    await pteroPreviewBulk(eggs);
  }
}

async function pteroPreviewBulk(eggs) {
  const area = document.getElementById('ptero-preview-area');
  area.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px 0">Analysiere…</div>';
  try {
    // Client-side preview via bulk endpoint with dry-run not available — parse each individually via preview
    const previews = [];
    for (const raw of eggs.slice(0, 20)) {
      try {
        const r = await API.post('/ptero/egg/preview', { json: JSON.stringify(raw) });
        previews.push(r);
      } catch (e) {
        previews.push({ error: e.message, egg: { name: raw?.name || '?', docker_image: '', icon: 'err', category: '?', env_vars: [] } });
      }
    }
    _pteroBulkEggs = previews;
    const moreCount = eggs.length - previews.length;
    area.innerHTML = `
      <div style="margin-top:16px">
        <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px">${previews.length} Eggs erkannt${moreCount>0?` (${moreCount} weitere nicht angezeigt)`:''}</div>
        ${previews.map((p,i) => p.error
          ? `<div class="error-msg" style="font-size:12px;margin-bottom:6px"><i data-lucide="x-circle"></i> ${esc(p.egg?.name||'?')}: ${esc(p.error)}</div>`
          : renderEggPreviewCard(p.egg, p.warnings||[])
        ).join('')}
      </div>`;
    const btn = document.getElementById('ptero-import-btn');
    if (btn) { btn.disabled = false; btn.innerHTML = `<i data-lucide="download"></i> Alle ${previews.filter(p=>!p.error).length} importieren`; }
    if (typeof lucide !== 'undefined') lucide.createIcons();
  } catch(e) {
    area.innerHTML = `<div class="error-msg" style="margin-top:12px">${esc(e.message)}</div>`;
  }
}

async function doPteroEggImport() {
  const btn = document.getElementById('ptero-import-btn');
  if (btn) btn.disabled = true;

  // Bulk mode
  if (_pteroCurrentTab === 'bulk') {
    const jsonStr  = document.getElementById('ptero-bulk-json')?.value?.trim();
    const overwrite= document.getElementById('ptero-bulk-overwrite')?.checked || false;
    if (!jsonStr) return;
    try {
      const eggs = JSON.parse(jsonStr);
      const r    = await API.post('/ptero/egg/bulk', { eggs, overwrite });
      toast(`${r.imported} importiert, ${r.skipped} übersprungen${r.errors?' / '+r.errors+' Fehler':''}`, r.errors?'warn':'success');
      closeModal(); loadAdminEggs();
    } catch(e) { toast('Fehler: '+e.message,'error'); if(btn) btn.disabled=false; }
    return;
  }

  // Single mode
  const jsonStr  = document.getElementById('ptero-egg-json')?.value?.trim();
  const overwrite= document.getElementById('ptero-overwrite')?.checked || false;
  if (!jsonStr) { toast('Kein JSON eingegeben','error'); if(btn) btn.disabled=false; return; }
  try {
    const r = await API.post('/ptero/egg/import', { json: jsonStr, overwrite });
    toast(`"${r.egg.name}" importiert!`+(r.warnings?.length?` (${r.warnings.length} Hinweise)`:''), 'success');
    closeModal(); loadAdminEggs();
  } catch(e) {
    toast('Fehler: '+e.message,'error');
    if(btn) btn.disabled=false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVER IMPORT
// ─────────────────────────────────────────────────────────────────────────────
async function showPteroServerImport() {
  const nodes = await API.get('/nodes').catch(() => []);
  showModal(`
    <div class="modal-title">
      <span><i data-lucide="server"></i> Pterodactyl Server importieren</span>
      <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
    </div>
    <div class="info-msg" style="margin-bottom:14px;font-size:12px">
      Server-Konfigurationen aus dem Pterodactyl Application API Export importieren.
      <br><code style="font-size:11px">GET https://pterodactyl.example.com/api/application/servers</code>
    </div>
    <div class="form-group">
      <label class="form-label">Server JSON (Einzelner Server oder Array)</label>
      <textarea id="ptero-srv-json" class="form-input"
        style="font-family:var(--mono);font-size:11px;height:180px"
        placeholder='{"attributes":{"name":"My Server","limits":{"memory":1024,"cpu":200},"container":{"image":"itzg/minecraft-server"},...}}'
        oninput="pteroServerJsonChanged()"></textarea>
    </div>
    <div class="grid grid-2">
      <div class="form-group">
        <label class="form-label">Ziel-Node</label>
        <select id="ptero-srv-node" class="form-input">
          <option value="">Auto (Standard-Node)</option>
          ${nodes.map(n=>`<option value="${n.id}">${esc(n.name)} (${esc(n.fqdn)})</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Ziel-Benutzer</label>
        <input type="text" id="ptero-srv-user" class="form-input" placeholder="Leer = dein Account"/>
      </div>
    </div>
    <div id="ptero-srv-preview" style="margin-top:4px"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="showPteroImportEgg()"><i data-lucide="egg"></i> Stattdessen Egg importieren</button>
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" id="ptero-srv-btn" onclick="doPteroServerImport()" disabled>
        <i data-lucide="download"></i> Server importieren
      </button>
    </div>`, true);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

let _pteroSrvPreviewTimer;
function pteroServerJsonChanged() {
  clearTimeout(_pteroSrvPreviewTimer);
  _pteroSrvPreviewTimer = setTimeout(pteroDoServerPreview, 700);
}

async function pteroDoServerPreview() {
  const jsonStr = (document.getElementById('ptero-srv-json')?.value||'').trim();
  if (!jsonStr) return;
  const area = document.getElementById('ptero-srv-preview');
  area.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:6px 0">Analysiere…</div>';
  try {
    const r = await API.post('/ptero/server/preview', { json: jsonStr });
    area.innerHTML = `
      <div style="margin-top:8px">
        <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px">${r.count} Server erkannt</div>
        ${r.servers.map((s,i) => `
          <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:8px">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
              <i data-lucide="server" style="width:16px;height:16px;color:var(--accent)"></i>
              <strong style="font-size:13px">${esc(s.name)}</strong>
              <span style="font-size:11px;font-family:var(--mono);color:var(--text3)">${esc(s.docker_image)}</span>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--text2)">
              <span><i data-lucide="cpu"></i> ${s.memory_limit} MB RAM</span>
              <span><i data-lucide="hard-drive"></i> ${s.disk_limit} MB Disk</span>
              <span><i data-lucide="zap"></i> ${s.cpu_limit} vCPU</span>
              ${s.ports?.length ? `<span><i data-lucide="plug"></i> Ports: ${s.ports.map(p=>p.host).join(', ')}</span>` : ''}
              <span><i data-lucide="code-2"></i> ${Object.keys(s.env_vars||{}).length} ENV Vars</span>
            </div>
            ${renderWarnings((r.warnings||[]).filter(w=>w.server===i))}
          </div>`).join('')}
      </div>`;
    const btn = document.getElementById('ptero-srv-btn');
    if (btn) { btn.disabled = false; btn.innerHTML = `<i data-lucide="download"></i> ${r.count} Server importieren`; }
    if (typeof lucide !== 'undefined') lucide.createIcons();
  } catch(e) {
    area.innerHTML = `<div class="error-msg" style="margin-top:8px;font-size:12px">${esc(e.message)}</div>`;
  }
}

async function doPteroServerImport() {
  const btn     = document.getElementById('ptero-srv-btn');
  const jsonStr = document.getElementById('ptero-srv-json')?.value?.trim();
  const nodeId  = document.getElementById('ptero-srv-node')?.value;
  const userId  = document.getElementById('ptero-srv-user')?.value?.trim() || undefined;
  if (!jsonStr) return;
  if (btn) btn.disabled = true;
  try {
    const r = await API.post('/ptero/server/import', { json: jsonStr, node_id: nodeId||undefined, user_id: userId });
    toast(`${r.imported} Server werden erstellt…${r.errors?' / '+r.errors+' Fehler':''}`, r.errors?'warn':'success');
    closeModal();
    if (typeof loadServers === 'function') loadServers();
  } catch(e) {
    toast('Fehler: '+e.message,'error');
    if(btn) btn.disabled=false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT VERLAUF
// ─────────────────────────────────────────────────────────────────────────────
async function showPteroImportHistory() {
  const history = await API.get('/ptero/import/history').catch(() => []);
  const typeLabel = t => ({ egg:'Egg', bulk_egg:'Bulk Eggs', server:'Server' }[t] || t);
  showModal(`
    <div class="modal-title">
      <span><i data-lucide="history"></i> Pterodactyl Import-Verlauf</span>
      <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
    </div>
    ${history.length === 0
      ? '<div class="empty" style="padding:32px"><div class="empty-icon"><i data-lucide="inbox"></i></div><p>Noch keine Imports</p></div>'
      : `<div style="display:flex;flex-direction:column;gap:6px;max-height:420px;overflow-y:auto">
          ${history.map(h => `
            <div style="background:var(--bg2);border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center">
              <div>
                <span style="font-size:12px;font-weight:600">${typeLabel(h.type)}</span>
                ${h.name ? `<span style="font-size:12px;color:var(--text2);margin-left:8px">${esc(h.name)}</span>` : ''}
                ${h.imported !== undefined ? `<span style="font-size:11px;color:var(--accent3);margin-left:8px">${h.imported} importiert</span>` : ''}
                ${h.skipped ? `<span style="font-size:11px;color:var(--text3);margin-left:6px">${h.skipped} übersprungen</span>` : ''}
                ${h.errors  ? `<span style="font-size:11px;color:var(--danger);margin-left:6px">${h.errors} Fehler</span>` : ''}
                ${h.overwritten ? `<span style="font-size:11px;color:var(--warn);margin-left:6px">überschrieben</span>` : ''}
              </div>
              <span style="font-size:11px;color:var(--text3)">${new Date(h.at).toLocaleString('de-DE')}</span>
            </div>`).join('')}
        </div>`}
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Schließen</button>
    </div>`, true);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ─────────────────────────────────────────────────────────────────────────────
// EGG EXPORT (PTDL_v1 JSON Download)
// ─────────────────────────────────────────────────────────────────────────────
async function exportEggAsPtdl(eggId) {
  try {
    const resp = await fetch(`/api/ptero/egg/export/${eggId}`, {
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('nextoken') || '') }
    });
    if (!resp.ok) throw new Error(await resp.text());
    const blob     = await resp.blob();
    const url      = URL.createObjectURL(blob);
    const a        = document.createElement('a');
    const cd       = resp.headers.get('content-disposition') || '';
    const filename = cd.match(/filename="([^"]+)"/)?.[1] || 'nexpanel-egg.json';
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    toast('Egg exportiert: ' + filename, 'success');
  } catch(e) { toast('Export-Fehler: '+e.message,'error'); }
}

async function deleteEgg(id) {
  if (!confirm('Egg wirklich löschen?')) return;
  try { await API.delete(`/eggs/${id}`); toast('Egg gelöscht','success'); closeModal(); loadAdminEggs(); }
  catch (e) { toast(e.message,'error'); }
}

async function showCreateServerFromEgg(eggId) {
  const egg = await API.get(`/eggs/${eggId}`).catch(() => null);
  if (!egg) return;
  // Pre-fill create server modal with egg data
  await showCreateServer(egg);
}

// ─── ALLOCATIONS PAGE ─────────────────────────────────────────────────────────
async function loadAdminAllocations() {
  document.getElementById('page-actions').innerHTML = `<button class="btn btn-primary" onclick="showAddAllocation()"><i data-lucide="plus"></i> Ports hinzufügen</button>`;
  const [allocs, nodes] = await Promise.all([
    API.get('/allocations').catch(() => []),
    API.get('/nodes').catch(() => []),
  ]);
  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));
  const grouped = {};
  allocs.forEach(a => { if (!grouped[a.node_id]) grouped[a.node_id] = []; grouped[a.node_id].push(a); });

  document.getElementById('page-content').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:20px">
      ${Object.entries(grouped).map(([nid, ports]) => {
        const node = nodeMap[nid] || { name: nid };
        const free = ports.filter(p => !p.server_id).length;
        return `
          <div class="card">
            <div class="card-header">
              <div><div class="card-title"><i data-lucide="globe"></i> ${esc(node.name)}</div><div class="text-dim text-sm">${esc(node.fqdn||'')}</div></div>
              <div style="display:flex;gap:12px;align-items:center">
                <span class="text-dim text-sm">${free} frei / ${ports.length} gesamt</span>
                <button class="btn btn-ghost btn-xs" onclick="showAddAllocation('${nid}')"><i data-lucide="plus"></i> Ports</button>
              </div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">
              ${ports.slice(0,80).map(p => `
                <div style="position:relative;display:inline-block">
                  <span class="port-badge ${p.server_id?'used':'free'}" title="${p.server_id?'Belegt: '+esc(p.server_name||p.server_id):'Frei'}" onclick="!${!!p.server_id} && confirmDeleteAlloc('${p.id}',${p.port})">
                    ${p.port}${p.alias?` (${esc(p.alias)})`:''}
                  </span>
                </div>`).join('')}
              ${ports.length > 80 ? `<span class="text-dim text-sm" style="padding:4px 8px">... +${ports.length-80} weitere</span>` : ''}
            </div>
          </div>`;
      }).join('')}
      ${allocs.length === 0 ? '<div class="empty"><div class="empty-icon"><i data-lucide="plug"></i></div><h3>Keine Port-Allocations</h3><p>Füge Ports für deine Nodes hinzu</p></div>' : ''}
    </div>`;
}

async function showAddAllocation(preNodeId) {
  const nodes = await API.get('/nodes').catch(() => []);
  showModal(`
    <div class="modal-title"><span><i data-lucide="plug"></i> Ports hinzufügen</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group"><label class="form-label">Node</label>
      <select id="alloc-node" class="form-input">
        ${nodes.map(n => `<option value="${n.id}" ${n.id===preNodeId?'selected':''}>${esc(n.name)} (${esc(n.fqdn||'')})</option>`).join('')}
      </select>
    </div>
    <div class="form-group"><label class="form-label">IP-Adresse</label><input type="text" id="alloc-ip" class="form-input" value="0.0.0.0" placeholder="0.0.0.0"/></div>
    <div class="grid grid-2">
      <div class="form-group"><label class="form-label">Start Port</label><input type="number" id="alloc-start" class="form-input" placeholder="25565"/></div>
      <div class="form-group"><label class="form-label">End Port (optional)</label><input type="number" id="alloc-end" class="form-input" placeholder="Leer = einzelner Port"/></div>
    </div>
    <div class="form-group"><label class="form-label">Alias (optional)</label><input type="text" id="alloc-alias" class="form-input" placeholder="minecraft-1"/></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="doAddAllocation()">Ports hinzufügen</button>
    </div>`);
}

async function doAddAllocation() {
  try {
    const nodeId = document.getElementById('alloc-node').value;
    const ip     = document.getElementById('alloc-ip').value || '0.0.0.0';
    const start  = parseInt(document.getElementById('alloc-start').value);
    const end    = parseInt(document.getElementById('alloc-end').value) || start;
    const alias  = document.getElementById('alloc-alias').value;
    if (!nodeId || !start) return toast('Node und Start-Port erforderlich', 'error');
    if (start === end) {
      await API.post('/allocations', { node_id: nodeId, ip, port: start, alias });
    } else {
      await API.post('/allocations/bulk', { node_id: nodeId, ip, start_port: start, end_port: end });
    }
    toast('Ports hinzugefügt!', 'success'); closeModal(); loadAdminAllocations();
  } catch (e) { toast('Fehler: '+e.message,'error'); }
}

async function confirmDeleteAlloc(id, port) {
  if (!confirm(`Port ${port} wirklich entfernen?`)) return;
  try { await API.delete(`/allocations/${id}`); toast('Port entfernt','success'); loadAdminAllocations(); }
  catch (e) { toast(e.message,'error'); }
}

// ─── AUDIT LOG ───────────────────────────────────────────────────────────────
let _auditAll = [];
async function loadAuditLog() {
  document.getElementById('page-actions').innerHTML = `
    <input id="audit-search" class="form-input" style="width:220px" placeholder="Suche..." oninput="auditFilter()"/>
    <select id="audit-action-filter" class="form-input" style="width:160px" onchange="auditFilter()">
      <option value="">Alle Aktionen</option>
      ${['LOGIN','SERVER_CREATE','SERVER_DELETE','SERVER_START','SERVER_STOP','SERVER_CLONE','PORT_ASSIGN','TASK_CREATE','FILE_WRITE','USER_CREATE'].map(a=>`<option>${a}</option>`).join('')}
    </select>`;
  _auditAll = await API.get('/admin/audit-log').catch(() => []);
  auditFilter();
}

function auditFilter() {
  const q   = (document.getElementById('audit-search')?.value || '').toLowerCase();
  const act = document.getElementById('audit-action-filter')?.value || '';
  const filtered = _auditAll.filter(l =>
    (!act || l.action === act) &&
    (!q || l.action?.toLowerCase().includes(q) || l.username?.toLowerCase().includes(q) || l.ip?.includes(q))
  );
  const ac = {
    LOGIN:'#00d4ff',SERVER_CREATE:'#00f5a0',SERVER_DELETE:'#ff4757',SERVER_START:'#00f5a0',
    SERVER_STOP:'#f59e0b',SERVER_RESTART:'#f59e0b',SERVER_CLONE:'#a78bfa',
    USER_CREATE:'#a78bfa',PORT_ASSIGN:'#60a5fa',TASK_CREATE:'#34d399',
    FILE_WRITE:'#fbbf24',FILE_DELETE:'#ff4757',
  };
  document.getElementById('page-content').innerHTML = `
    <div class="card">
      <div style="margin-bottom:8px;font-size:12px;color:var(--text3)">${filtered.length} von ${_auditAll.length} Einträgen</div>
      <table class="table">
        <thead><tr><th>Zeit</th><th>Benutzer</th><th>Aktion</th><th>Details</th><th>IP</th></tr></thead>
        <tbody>${filtered.map(l => {
          let details = '';
          try { const d = JSON.parse(l.details||'{}'); details = Object.entries(d).map(([k,v])=>`<span class="text-dim">${k}:</span> ${esc(String(v)).substring(0,30)}`).join(' '); } catch {}
          return `<tr>
            <td class="text-mono text-sm text-dim" style="white-space:nowrap">${new Date(l.created_at).toLocaleString('de-DE')}</td>
            <td><span style="font-weight:500">${esc(l.username||'system')}</span></td>
            <td><span class="audit-badge" style="background:${ac[l.action]||'#64748b'}22;color:${ac[l.action]||'#94a3b8'};border-color:${ac[l.action]||'#334155'}">${l.action}</span></td>
            <td class="text-sm" style="max-width:260px;overflow:hidden">${details || (l.target_type ? `${l.target_type}:${(l.target_id||'').substring(0,8)}` : '—')}</td>
            <td class="text-mono text-sm text-dim">${l.ip||'-'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
}

// ─── DOCKER IMAGES ───────────────────────────────────────────────────────────
async function loadDockerImages() {
  document.getElementById('page-actions').innerHTML = `<button class="btn btn-primary" onclick="showPullImage()"><i data-lucide="download"></i> Image ziehen</button>`;
  const images = await API.get('/admin/docker/images').catch(e => { document.getElementById('page-content').innerHTML=`<div class="empty"><p class="text-danger">${esc(e.message)}</p></div>`; return null; });
  if (!images) return;
  document.getElementById('page-content').innerHTML = `
    <div class="card"><table class="table">
      <thead><tr><th>Image</th><th>Größe</th><th>ID</th></tr></thead>
      <tbody>${images.map(img => `<tr><td class="text-mono text-accent">${esc((img.RepoTags||img.tags||['<none>']).join(', '))}</td><td class="text-mono">${fmtBytes(img.Size||img.size||0)}</td><td class="text-mono text-dim text-sm">${esc((img.Id||img.id||'').substring(7,19))}</td></tr>`).join('')}</tbody>
    </table></div>`;
}
function showPullImage() {
  showModal(`
    <div class="modal-title"><span><i data-lucide="download"></i> Docker Image ziehen</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group"><label class="form-label">Image Name</label><input type="text" id="m-imgname" class="form-input" placeholder="nginx:latest"/></div>
    <div id="m-error" class="error-msg hidden"></div>
    <div id="m-success" class="success-msg hidden"></div>
    <div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button><button class="btn btn-primary" onclick="doPullImage()">Pull</button></div>`);
}
async function doPullImage() {
  const img = document.getElementById('m-imgname').value.trim(); if (!img) return;
  document.getElementById('m-success').textContent='Ziehe '+img+'…'; document.getElementById('m-success').classList.remove('hidden');
  document.getElementById('m-error').classList.add('hidden');
  try { await API.post('/admin/docker/images/pull', { image: img }); document.getElementById('m-success').textContent='<i data-lucide="check-circle"></i> '+img+' gepullt!'; setTimeout(()=>{closeModal();loadDockerImages();},2000); }
  catch (e) { document.getElementById('m-success').classList.add('hidden'); document.getElementById('m-error').textContent=e.message; document.getElementById('m-error').classList.remove('hidden'); }
}

// ─── STATUS-PAGE LINK IM ADMIN-BEREICH ────────────────────────────────────────
function openStatusPage() {
  window.open('/status', '_blank');
}


// ── Lucide auto-reinit ─────────────────────────────────────────────────────
(function() {
  const _obs = new MutationObserver(function(muts) {
    let hasI = false;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && (n.tagName === 'I' || n.querySelector && n.querySelector('i[data-lucide]'))) {
          hasI = true; break;
        }
      }
      if (hasI) break;
    }
    if (hasI && window.lucide) lucide.createIcons();
  });
  document.addEventListener('DOMContentLoaded', function() {
    const pc = document.getElementById('page-content');
    const mo = document.getElementById('modal-overlay');
    if (pc) _obs.observe(pc, { childList: true, subtree: true });
    if (mo) _obs.observe(mo, { childList: true, subtree: true });
    if (window.lucide) lucide.createIcons();
  });
})();

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-SCALING ADMIN-SEITE
// ══════════════════════════════════════════════════════════════════════════════

async function loadAdminScaling() {
  document.getElementById('page-actions').innerHTML = `
    <button class="btn btn-ghost btn-sm" onclick="loadAdminScaling()"><i data-lucide="rotate-ccw"></i> Aktualisieren</button>`;

  try {
    const [cfg, scores] = await Promise.all([
      API.get('/admin/scaling/config'),
      API.get('/admin/scaling/scores').catch(() => ({ nodes: [], best_node_id: null })),
    ]);

    const strategyLabels = {
      least_loaded: 'Least Loaded — Node mit niedrigster Auslastung',
      round_robin:  'Round Robin — gleichmäßige Serververteilung',
      first_fit:    'First Fit — erster passender Node',
      bin_packing:  'Bin Packing — Nodes erst füllen, dann nächster',
    };

    document.getElementById('page-content').innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px;max-width:900px">

        <!-- TOGGLE + STRATEGIE -->
        <div class="card">
          <div class="card-header">
            <div class="card-title"><i data-lucide="git-branch"></i> Auto-Scaling Konfiguration</div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
              <span style="color:var(--color-text-secondary)">Auto-Scaling</span>
              <div class="toggle-wrap">
                <input type="checkbox" id="sc-enabled" class="toggle-cb" ${cfg.enabled ? 'checked' : ''} onchange="scalingToggleEnabled(this.checked)">
                <div class="toggle-track"><div class="toggle-thumb"></div></div>
              </div>
              <span id="sc-enabled-label" style="font-weight:500;color:${cfg.enabled?'var(--color-text-success)':'var(--color-text-secondary)'}">${cfg.enabled ? 'Aktiv' : 'Deaktiviert'}</span>
            </label>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px">
            <div class="form-group">
              <label class="form-label">Strategie</label>
              <select id="sc-strategy" class="form-input" onchange="scalingSave()">
                ${Object.entries(strategyLabels).map(([v,l]) => `<option value="${v}" ${cfg.strategy===v?'selected':''}>${l}</option>`).join('')}
              </select>
            </div>
            <div></div>
            <div class="form-group">
              <label class="form-label">RAM-Auslastung Limit (%)</label>
              <input type="range" id="sc-mem-thr" min="50" max="100" value="${cfg.mem_threshold}" class="form-input" style="padding:6px 0" oninput="document.getElementById('sc-mem-thr-val').textContent=this.value+'%'">
              <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--color-text-secondary);margin-top:2px"><span>50%</span><span id="sc-mem-thr-val" style="font-weight:500">${cfg.mem_threshold}%</span><span>100%</span></div>
            </div>
            <div class="form-group">
              <label class="form-label">Disk-Auslastung Limit (%)</label>
              <input type="range" id="sc-disk-thr" min="50" max="100" value="${cfg.disk_threshold}" class="form-input" style="padding:6px 0" oninput="document.getElementById('sc-disk-thr-val').textContent=this.value+'%'">
              <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--color-text-secondary);margin-top:2px"><span>50%</span><span id="sc-disk-thr-val" style="font-weight:500">${cfg.disk_threshold}%</span><span>100%</span></div>
            </div>
          </div>

          <div style="display:flex;gap:12px;margin-top:4px;flex-wrap:wrap">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
              <input type="checkbox" id="sc-prefer-conn" ${cfg.prefer_connected?'checked':''} onchange="scalingSave()">
              Verbundene Nodes bevorzugen
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
              <input type="checkbox" id="sc-allow-offline" ${cfg.allow_offline?'checked':''} onchange="scalingSave()">
              Offline-Nodes erlauben
            </label>
          </div>
          <div style="margin-top:14px;text-align:right">
            <button class="btn btn-primary btn-sm" onclick="scalingSave(true)"><i data-lucide="save"></i> Speichern</button>
          </div>
        </div>

        <!-- NODE SCORES (Live) -->
        <div class="card">
          <div class="card-header">
            <div class="card-title"><i data-lucide="bar-chart-2"></i> Node-Scores (Live)</div>
            <span style="font-size:12px;color:var(--color-text-secondary)">${scores.best_node_id ? `→ Aktuell gewählt: <strong>${esc(scores.nodes.find(n=>n.id===scores.best_node_id)?.name||'?')}</strong> · ${esc(scores.best_reason||'')}` : 'Auto-Scaling inaktiv'}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
            ${(scores.nodes || []).map(n => {
              const score = n.score >= 0 ? n.score : 0;
              const eligible = n.eligible;
              const isBest = n.id === scores.best_node_id;
              const memPct  = n.pct?.mem  || 0;
              const diskPct = n.pct?.disk || 0;
              const color = !n.connected ? 'var(--color-text-tertiary)' : isBest ? 'var(--color-text-success)' : eligible ? 'var(--color-text-primary)' : 'var(--color-text-secondary)';
              return `
              <div style="background:var(--color-background-secondary);border:1px solid ${isBest?'var(--color-border-success)':'var(--color-border-tertiary)'};border-radius:8px;padding:10px 14px">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                  <i data-lucide="${n.connected?'server':'server-off'}" style="width:14px;height:14px;flex-shrink:0;color:${color}"></i>
                  <span style="font-weight:500;font-size:13px;color:${color};flex:1">${esc(n.name)}</span>
                  ${isBest ? '<span style="font-size:10px;background:var(--color-background-success);color:var(--color-text-success);padding:2px 8px;border-radius:10px;font-weight:500">→ Nächster</span>' : ''}
                  ${!n.connected ? '<span style="font-size:10px;color:var(--color-text-tertiary)">[offline]</span>' : ''}
                  ${!eligible && n.connected ? '<span style="font-size:10px;color:var(--color-text-warning)">[ausgelastet]</span>' : ''}
                  <span style="font-size:12px;color:var(--color-text-secondary)">${n.server_count} Server · ${n.location}</span>
                  <span style="font-size:13px;font-weight:500;color:${color};min-width:38px;text-align:right">Score ${Math.round(score)}</span>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                  <div>
                    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--color-text-secondary);margin-bottom:3px">
                      <span>RAM alloc</span><span>${memPct}% · ${Math.round((n.free?.mem_mb||0)/1024*10)/10} GB frei</span>
                    </div>
                    <div style="background:var(--color-border-tertiary);border-radius:3px;height:5px">
                      <div style="width:${memPct}%;background:${memPct>85?'var(--color-text-danger)':memPct>65?'var(--color-text-warning)':'var(--color-text-success)'};height:5px;border-radius:3px"></div>
                    </div>
                  </div>
                  <div>
                    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--color-text-secondary);margin-bottom:3px">
                      <span>Disk alloc</span><span>${diskPct}% · ${Math.round((n.free?.disk_mb||0)/1024)} GB frei</span>
                    </div>
                    <div style="background:var(--color-border-tertiary);border-radius:3px;height:5px">
                      <div style="width:${diskPct}%;background:${diskPct>85?'var(--color-text-danger)':diskPct>65?'var(--color-text-warning)':'var(--color-text-success)'};height:5px;border-radius:3px"></div>
                    </div>
                  </div>
                </div>
              </div>`;
            }).join('') || '<div class="text-muted" style="padding:12px">Keine Nodes vorhanden</div>'}
          </div>
        </div>

        <!-- AUTO-REGISTER -->
        <div class="card">
          <div class="card-header">
            <div class="card-title"><i data-lucide="plug"></i> Auto-Register</div>
            <span style="font-size:12px;color:var(--color-text-secondary)">Nodes registrieren sich selbst via API</span>
          </div>
          <div style="font-size:13px;color:var(--color-text-secondary);margin-bottom:12px;line-height:1.6">
            Neue Daemon-Instanzen können sich eigenständig registrieren indem sie
            <code style="background:var(--color-background-secondary);padding:1px 5px;border-radius:4px">POST /api/admin/nodes/auto-register</code>
            mit dem Register-Key aufrufen. Der Daemon erhält daraufhin seine <code>node_id</code> und sein Token.
          </div>

          <div style="background:var(--color-background-secondary);border:1px solid var(--color-border-tertiary);border-radius:8px;padding:12px;margin-bottom:14px">
            <div style="font-size:12px;font-weight:500;color:var(--color-text-secondary);margin-bottom:6px">Aktueller Register-Key</div>
            ${cfg.auto_register_key_set
              ? `<div style="display:flex;align-items:center;gap:8px">
                  <code id="sc-key-display" style="font-family:var(--font-mono);font-size:13px;background:var(--color-background-primary);padding:4px 10px;border-radius:4px;flex:1;letter-spacing:.04em">${esc(cfg.auto_register_key_prefix)} (nicht vollständig sichtbar)</code>
                  <button class="btn btn-ghost btn-sm" onclick="scalingDeleteKey()"><i data-lucide="trash-2"></i> Löschen</button>
                </div>`
              : '<span style="color:var(--color-text-tertiary)">Kein Key gesetzt — Auto-Register deaktiviert</span>'
            }
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <button class="btn btn-primary btn-sm" onclick="scalingGenerateKey()"><i data-lucide="refresh-cw"></i> Neuen Key generieren</button>
            <span style="font-size:12px;color:var(--color-text-tertiary)">Ein bestehender Key wird damit ungültig.</span>
          </div>

          <div id="sc-key-result" style="margin-top:12px;display:none"></div>

          <div style="margin-top:16px;border-top:1px solid var(--color-border-tertiary);padding-top:14px">
            <div style="font-size:12px;font-weight:500;color:var(--color-text-secondary);margin-bottom:8px">Beispiel: Daemon-Selbstregistrierung</div>
            <pre style="font-family:var(--font-mono);font-size:11px;background:var(--color-background-secondary);padding:10px;border-radius:6px;overflow-x:auto;line-height:1.6;color:var(--color-text-primary)">curl -X POST https://panel.example.com/api/admin/nodes/auto-register \\
  -H "Content-Type: application/json" \\
  -d '{
    "name":         "Node-Frankfurt-01",
    "fqdn":         "node1.example.com",
    "location":     "Frankfurt",
    "memory_mb":    16384,
    "disk_mb":      204800,
    "cpu_overalloc": 2,
    "register_key": "&lt;AUTO_REGISTER_KEY&gt;"
  }'</pre>
          </div>
        </div>

      </div>`;

    if (window.lucide) lucide.createIcons();

    // Slider live speichern
    document.getElementById('sc-mem-thr')?.addEventListener('change', scalingSave);
    document.getElementById('sc-disk-thr')?.addEventListener('change', scalingSave);

  } catch (e) {
    document.getElementById('page-content').innerHTML =
      `<div class="empty"><p class="text-danger">${esc(e.message)}</p></div>`;
  }
}

async function scalingToggleEnabled(val) {
  document.getElementById('sc-enabled-label').textContent = val ? 'Aktiv' : 'Deaktiviert';
  document.getElementById('sc-enabled-label').style.color = val ? 'var(--color-text-success)' : 'var(--color-text-secondary)';
  await scalingSave();
}

async function scalingSave(showToast = false) {
  const body = {
    enabled:         document.getElementById('sc-enabled')?.checked ? 1 : 0,
    strategy:        document.getElementById('sc-strategy')?.value,
    mem_threshold:   parseInt(document.getElementById('sc-mem-thr')?.value  || 90),
    disk_threshold:  parseInt(document.getElementById('sc-disk-thr')?.value || 85),
    prefer_connected: document.getElementById('sc-prefer-conn')?.checked  ? 1 : 0,
    allow_offline:    document.getElementById('sc-allow-offline')?.checked ? 1 : 0,
  };
  try {
    await API.put('/admin/scaling/config', body);
    if (showToast) toast('Gespeichert!', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function scalingGenerateKey() {
  if (!confirm('Einen neuen Register-Key generieren? Der alte Key wird sofort ungültig.')) return;
  try {
    const r = await API.post('/admin/scaling/generate-key', {});
    const resultEl = document.getElementById('sc-key-result');
    if (resultEl) {
      resultEl.style.display = 'block';
      resultEl.innerHTML = `
        <div style="background:var(--color-background-success);border:1px solid var(--color-border-success);border-radius:8px;padding:12px">
          <div style="font-size:12px;font-weight:500;color:var(--color-text-success);margin-bottom:6px"><i data-lucide="check-circle"></i> Neuer Key generiert — nur einmal sichtbar!</div>
          <code style="font-family:var(--font-mono);font-size:13px;word-break:break-all;color:var(--color-text-primary)">${esc(r.key)}</code>
          <button class="btn btn-ghost btn-sm" style="margin-top:8px;display:block" onclick="navigator.clipboard.writeText('${esc(r.key)}').then(()=>toast('Kopiert!','success'))"><i data-lucide="clipboard"></i> Kopieren</button>
        </div>`;
      if (window.lucide) lucide.createIcons();
    }
    toast('Neuer Key generiert', 'success');
    setTimeout(() => loadAdminScaling(), 2000);
  } catch (e) { toast(e.message, 'error'); }
}

async function scalingDeleteKey() {
  if (!confirm('Register-Key löschen? Auto-Register wird damit deaktiviert.')) return;
  try {
    await API.delete('/admin/scaling/auto-register-key');
    toast('Key gelöscht', 'success');
    loadAdminScaling();
  } catch (e) { toast(e.message, 'error'); }
}


// ═══════════════════════════════════════════════════════════════
// AREA SWITCHER — Client Area / Admin Area
// ═══════════════════════════════════════════════════════════════
function switchArea(area, silent = false) {
  if (!State.user) return;
  State.currentArea = area;
  localStorage.setItem('nex_area', area);

  const navClient  = document.getElementById('nav-client');
  const navAdmin   = document.getElementById('nav-admin');
  const btnClient  = document.getElementById('btn-area-client');
  const btnAdmin   = document.getElementById('btn-area-admin');
  const verLabel   = document.getElementById('area-ver-label');
  const appEl      = document.getElementById('app');

  if (area === 'admin') {
    navClient?.classList.add('hidden');
    navAdmin?.classList.remove('hidden');
    btnClient?.classList.remove('active-client');
    btnAdmin?.classList.add('active-admin');
    if (verLabel) verLabel.textContent = 'Admin Area';
    appEl?.classList.add('admin-area');
    if (!silent) navigate('admin-nodes');
  } else {
    navAdmin?.classList.add('hidden');
    navClient?.classList.remove('hidden');
    btnAdmin?.classList.remove('active-admin');
    btnClient?.classList.add('active-client');
    if (verLabel) verLabel.textContent = 'Client Area';
    appEl?.classList.remove('admin-area');
    if (!silent) navigate('dashboard');
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ═══════════════════════════════════════════════════════════════
// FAVORITES
// ═══════════════════════════════════════════════════════════════
async function toggleFavorite(serverId, btn) {
  // Optimistic update immediately
  const curFav = btn.classList.contains('fav-active');
  const newFav = !curFav;

  // Update btn visually right away
  _applyFavBtn(btn, newFav);

  // Update localStorage cache immediately
  if (newFav) addFavCache(serverId); else removeFavCache(serverId);

  // Update State._allServers if available
  if (State._allServers) {
    const srv = State._allServers.find(s => s.id === serverId);
    if (srv) srv.is_favorite = newFav;
    renderServerList();
  }

  try {
    const res = await API.patch(`/servers/${serverId}/favorite`);
    const confirmed = res.is_favorite;
    // Sync if server returned different value
    if (confirmed !== newFav) {
      _applyFavBtn(btn, confirmed);
      if (confirmed) addFavCache(serverId); else removeFavCache(serverId);
      if (State._allServers) {
        const srv = State._allServers.find(s => s.id === serverId);
        if (srv) srv.is_favorite = confirmed;
        renderServerList();
      }
    }
    toast(confirmed ? '<i data-lucide="star" style="width:13px;height:13px;fill:#facc15;stroke:#facc15;vertical-align:-2px"></i> Favorit gesetzt' : 'Favorit entfernt', 'success');
  } catch(e) {
    // Rollback on error
    _applyFavBtn(btn, curFav);
    if (curFav) addFavCache(serverId); else removeFavCache(serverId);
    if (State._allServers) {
      const srv = State._allServers.find(s => s.id === serverId);
      if (srv) srv.is_favorite = curFav;
      renderServerList();
    }
    toast(e.message, 'error');
  }
}

function _applyFavBtn(btn, active) {
  btn.classList.toggle('fav-active', active);
  btn.title = active ? 'Favorit entfernen' : 'Als Favorit markieren';
  const svg = btn.querySelector('svg');
  if (svg) {
    svg.setAttribute('fill',   active ? '#facc15' : 'none');
    svg.setAttribute('stroke', active ? '#facc15' : 'var(--text3)');
  }
}

// ═══════════════════════════════════════════════════════════════
// CONSOLE ALIASES
// ═══════════════════════════════════════════════════════════════
let _aliases = [];

async function aliasesInit(serverId) {
  _aliases = await API.get(`/servers/${serverId}/aliases`).catch(() => []);
}

// ─── Alias-Auflösung (genutzt von sendConsoleCommand) ────────────────────────
function resolveAlias(serverId, input) {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const name = trimmed.slice(1).split(' ')[0].toLowerCase();
  const alias = _aliases.find(a => a.name === name);
  return alias ? alias.command : null;
}

// ─── Inline-Hint / Dropdown beim Tippen ──────────────────────────────────────
let _aliasHintSelected = -1;

function updateAliasHint(value, serverId) {
  const container = document.getElementById('alias-hint-container');
  if (!container) return;

  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || !_aliases.length) {
    container.innerHTML = '';
    _aliasHintSelected = -1;
    return;
  }

  const typed   = trimmed.slice(1).toLowerCase();
  const matches = _aliases.filter(a => a.name.startsWith(typed) || typed === '');

  if (matches.length === 0) {
    // Show "unknown alias" hint
    container.innerHTML = `<div style="font-size:11px;color:var(--text3);padding:3px 14px;font-family:var(--mono)">
      <i data-lucide="x-circle" style="width:10px;height:10px;color:var(--danger)"></i>
      Unbekannter Alias — <span style="color:var(--accent)">Tab</span> für Übersicht
    </div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  // Exact match → show expanded command preview
  const exact = matches.find(a => a.name === typed);
  if (exact && !typed.includes(' ') && trimmed === '/' + typed) {
    container.innerHTML = `<div style="font-size:11px;color:var(--accent3);padding:3px 14px;font-family:var(--mono);display:flex;align-items:center;gap:6px">
      <i data-lucide="zap" style="width:10px;height:10px"></i>
      <span style="color:var(--text3)">→</span>
      <code style="color:var(--text)">${esc(exact.command)}</code>
      <span style="color:var(--text3);font-size:10px">[Enter senden · Tab wechseln]</span>
    </div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    _aliasHintSelected = -1;
    return;
  }

  // Multiple partial matches → dropdown
  _aliasHintSelected = -1;
  container.innerHTML = `<div id="alias-dropdown" style="
    position:absolute;bottom:100%;left:0;right:0;
    background:var(--card2);border:1px solid var(--border2);
    border-radius:8px 8px 0 0;overflow:hidden;
    box-shadow:0 -4px 16px rgba(0,0,0,.4);z-index:200;
    max-height:180px;overflow-y:auto">
    ${matches.slice(0, 8).map((a, i) => `
      <div class="alias-dd-item" data-idx="${i}" data-name="${esc(a.name)}" data-cmd="${esc(a.command)}"
        style="display:flex;align-items:center;gap:10px;padding:7px 14px;cursor:pointer;font-family:var(--mono)"
        onmouseover="aliasDropdownSelect(${i})"
        onclick="aliasDropdownApply('${serverId}',${i})">
        <code style="font-size:12px;color:var(--accent);min-width:80px">/${esc(a.name)}</code>
        <span style="flex:1;font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.command)}</span>
        <kbd style="font-size:9px;color:var(--text3);background:var(--bg3);padding:1px 5px;border-radius:3px">Tab</kbd>
      </div>`).join('')}
  </div>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function hideAliasHint() {
  const el = document.getElementById('alias-hint-container');
  if (el) el.innerHTML = '';
  _aliasHintSelected = -1;
}

function aliasDropdownSelect(idx) {
  _aliasHintSelected = idx;
  document.querySelectorAll('.alias-dd-item').forEach((el, i) => {
    el.style.background = i === idx ? 'var(--bg3)' : '';
    el.style.color      = i === idx ? 'var(--accent)' : '';
  });
}

function aliasDropdownNavigate(dir) {
  const items = document.querySelectorAll('.alias-dd-item');
  if (!items.length) return false;
  _aliasHintSelected = Math.max(-1, Math.min(items.length - 1, _aliasHintSelected + dir));
  items.forEach((el, i) => {
    el.style.background = i === _aliasHintSelected ? 'var(--bg3)' : '';
  });
  return true;
}

function aliasTabComplete(input, serverId) {
  const items = document.querySelectorAll('.alias-dd-item');
  if (items.length === 0 && _aliases.length > 0) {
    // No dropdown open yet → show all aliases
    updateAliasHint('/', serverId);
    input.value = '/';
    return;
  }

  const idx = _aliasHintSelected >= 0 ? _aliasHintSelected : 0;
  if (!items[idx]) return;
  aliasDropdownApply(serverId, idx);
}

function aliasDropdownApply(serverId, idx) {
  const items = document.querySelectorAll('.alias-dd-item');
  const item  = items[idx];
  if (!item) return;
  const name = item.dataset.name;
  const input = document.getElementById('console-input');
  if (input) {
    input.value = '/' + name + ' ';
    input.focus();
    // Show preview of expanded command
    updateAliasHint(input.value, serverId);
  }
}

// ─── Alias-Manager Modal ─────────────────────────────────────────────────────
function showAliasManager(serverId) {
  _renderAliasModal(serverId);
}

function _aliasRowHtml(a, serverId) {
  return `<div class="alias-row" id="alias-row-${a.id}"
    style="display:flex;align-items:center;gap:8px;background:var(--bg3);border-radius:8px;padding:8px 12px;border:1px solid transparent;transition:.15s"
    onmouseover="this.style.borderColor='var(--border)'" onmouseout="this.style.borderColor='transparent'">
    <code style="color:var(--accent);font-size:13px;min-width:90px;flex-shrink:0">/${esc(a.name)}</code>
    <span style="flex:1;font-size:12px;color:var(--text2);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
      title="${esc(a.command)}">${esc(a.command)}</span>
    <div style="display:flex;gap:4px;flex-shrink:0">
      <button class="btn btn-ghost btn-xs" title="Bearbeiten"
        onclick="aliasStartEdit('${serverId}','${a.id}','${esc(a.name)}','${esc(a.command).replace(/'/g,"\\'")}')"
        ><i data-lucide="pencil" style="width:11px;height:11px"></i></button>
      <button class="btn btn-ghost btn-xs text-danger" title="Löschen"
        onclick="deleteAlias('${serverId}','${a.id}')">
        <i data-lucide="trash-2" style="width:11px;height:11px"></i></button>
    </div>
  </div>`;
}

function _renderAliasModal(serverId) {
  const listHtml = _aliases.length
    ? `<div style="display:flex;flex-direction:column;gap:5px;max-height:240px;overflow-y:auto;margin-bottom:14px">
        ${_aliases.map(a => _aliasRowHtml(a, serverId)).join('')}
       </div>`
    : `<div style="text-align:center;padding:20px 0;margin-bottom:14px">
        <div style="font-size:28px;margin-bottom:8px">⌨</div>
        <p style="font-size:13px;color:var(--text3)">Noch keine Aliases — erstelle deinen ersten!</p>
       </div>`;

  showModal(`
    <div class="modal-title">
      <span><i data-lucide="terminal"></i> Console Aliases</span>
      <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
    </div>

    <div style="background:var(--bg3);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:var(--text2);line-height:1.6">
      <div style="font-weight:600;margin-bottom:4px;color:var(--text)"><i data-lucide="info" style="width:12px;height:12px"></i> Verwendung</div>
      Tippe <code style="background:var(--bg);padding:1px 6px;border-radius:4px;color:var(--accent)">/aliasname</code> in der Konsole.<br>
      <span style="color:var(--text3)">Tab</span> öffnet Auto-Completion · Argumente werden angehängt:
      <code style="background:var(--bg);padding:1px 6px;border-radius:4px;color:var(--accent3)">/op Steve</code> → <code style="background:var(--bg);padding:1px 6px;border-radius:4px">op Steve</code>
    </div>

    <div id="alias-list">${listHtml}</div>

    <div id="alias-edit-section" style="border-top:1px solid var(--border);padding-top:14px">
      <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:10px;display:flex;align-items:center;gap:6px">
        <i data-lucide="plus-circle" style="width:13px;height:13px"></i>
        <span id="alias-form-title">Neuer Alias</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1.8fr auto;gap:8px;align-items:end">
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Name</label>
          <div style="display:flex;align-items:center;gap:3px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:0 8px">
            <span style="color:var(--accent);font-weight:700;font-family:var(--mono)">/</span>
            <input id="alias-name" class="form-input"
              style="background:transparent;border:none;padding:8px 4px;font-family:var(--mono)"
              placeholder="save" maxlength="32"
              oninput="this.value=this.value.replace(/[^a-z0-9_-]/gi,'').toLowerCase()"/>
          </div>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Befehl</label>
          <input id="alias-cmd" class="form-input" placeholder="save-all" style="font-family:var(--mono)"/>
        </div>
        <div style="display:flex;gap:5px">
          <button class="btn btn-primary btn-sm" id="alias-submit-btn" onclick="submitAlias('${serverId}')">
            <i data-lucide="plus"></i>
          </button>
          <button class="btn btn-ghost btn-sm" id="alias-cancel-btn" style="display:none" onclick="aliasCancelEdit()">
            <i data-lucide="x"></i>
          </button>
        </div>
      </div>
      <div id="alias-form-error" class="error-msg hidden" style="margin-top:6px"></div>

      <!-- Quick-Presets -->
      <div style="margin-top:10px">
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Schnell-Presets</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px">
          ${[
            ['save',    'save-all'],
            ['day',     'time set day'],
            ['night',   'time set night'],
            ['sun',     'weather clear'],
            ['rain',    'weather rain'],
            ['gmc',     'gamemode creative'],
            ['gms',     'gamemode survival'],
            ['gma',     'gamemode adventure'],
            ['tpa',     'tp'],
            ['heal',    'effect give @a minecraft:instant_health 1 10'],
            ['spawnmob','summon '],
            ['lag',     'timings report'],
          ].map(([name, cmd]) =>
            `<button class="btn btn-ghost btn-xs" style="font-size:10px;font-family:var(--mono)"
              onclick="aliasPreset('${serverId}','${name}','${cmd.replace(/'/g,"\\'")}')">
              /${name}</button>`
          ).join('')}
        </div>
      </div>
    </div>`, true);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Preset einfügen
function aliasPreset(serverId, name, cmd) {
  document.getElementById('alias-name').value = name;
  document.getElementById('alias-cmd').value  = cmd;
  document.getElementById('alias-name').focus();
  // Check if already exists
  const exists = _aliases.find(a => a.name === name);
  if (exists) {
    const errEl = document.getElementById('alias-form-error');
    if (errEl) { errEl.textContent = `"/${name}" existiert bereits — du kannst ihn unten bearbeiten.`; errEl.classList.remove('hidden'); }
  }
}

let _editingAliasId = null;

function aliasStartEdit(serverId, id, name, command) {
  _editingAliasId = id;
  document.getElementById('alias-name').value  = name;
  document.getElementById('alias-cmd').value   = command;
  document.getElementById('alias-form-title').textContent = `Alias bearbeiten: /${name}`;
  document.getElementById('alias-submit-btn').innerHTML   = '<i data-lucide="save"></i>';
  document.getElementById('alias-cancel-btn').style.display = '';
  if (typeof lucide !== 'undefined') lucide.createIcons();
  document.getElementById('alias-name').focus();
  // Highlight editing row
  document.querySelectorAll('.alias-row').forEach(r => r.style.background = 'var(--bg3)');
  const row = document.getElementById(`alias-row-${id}`);
  if (row) row.style.background = 'rgba(0,212,255,.08)';
}

function aliasCancelEdit() {
  _editingAliasId = null;
  document.getElementById('alias-name').value = '';
  document.getElementById('alias-cmd').value  = '';
  document.getElementById('alias-form-title').textContent = 'Neuer Alias';
  document.getElementById('alias-submit-btn').innerHTML   = '<i data-lucide="plus"></i>';
  document.getElementById('alias-cancel-btn').style.display = 'none';
  document.getElementById('alias-form-error')?.classList.add('hidden');
  if (typeof lucide !== 'undefined') lucide.createIcons();
  document.querySelectorAll('.alias-row').forEach(r => r.style.background = 'var(--bg3)');
}

async function submitAlias(serverId) {
  const name    = document.getElementById('alias-name').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const command = document.getElementById('alias-cmd').value.trim();
  const errEl   = document.getElementById('alias-form-error');

  if (!name)    { errEl.textContent = 'Name erforderlich'; errEl.classList.remove('hidden'); return; }
  if (!command) { errEl.textContent = 'Befehl erforderlich'; errEl.classList.remove('hidden'); return; }
  errEl.classList.add('hidden');

  try {
    if (_editingAliasId) {
      await API.patch(`/servers/${serverId}/aliases/${_editingAliasId}`, { name, command });
      toast(`Alias /${name} aktualisiert`, 'success');
    } else {
      await API.post(`/servers/${serverId}/aliases`, { name, command });
      toast(`Alias /${name} erstellt`, 'success');
    }
    _aliases = await API.get(`/servers/${serverId}/aliases`);
    aliasCancelEdit();
    // Re-render list in-place
    const listEl = document.getElementById('alias-list');
    if (listEl) {
      listEl.innerHTML = _aliases.length
        ? `<div style="display:flex;flex-direction:column;gap:5px;max-height:240px;overflow-y:auto;margin-bottom:14px">
            ${_aliases.map(a => _aliasRowHtml(a, serverId)).join('')}
           </div>`
        : `<div style="text-align:center;padding:20px 0;margin-bottom:14px"><p style="font-size:13px;color:var(--text3)">Noch keine Aliases.</p></div>`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  } catch(e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

// Kept as createAlias for backward compat (buttons generated in old HTML)
async function createAlias(serverId) { return submitAlias(serverId); }

async function deleteAlias(serverId, aliasId) {
  const alias = _aliases.find(a => a.id === aliasId);
  if (!confirm(`Alias "/${alias?.name || aliasId}" wirklich löschen?`)) return;
  try {
    await API.delete(`/servers/${serverId}/aliases/${aliasId}`);
    _aliases = _aliases.filter(a => a.id !== aliasId);
    toast('Alias gelöscht', 'success');
    // Remove from DOM in-place
    const row = document.getElementById(`alias-row-${aliasId}`);
    if (row) row.remove();
    if (_editingAliasId === aliasId) aliasCancelEdit();
    if (_aliases.length === 0) {
      const listEl = document.getElementById('alias-list');
      if (listEl) listEl.innerHTML = `<div style="text-align:center;padding:20px 0;margin-bottom:14px"><p style="font-size:13px;color:var(--text3)">Noch keine Aliases.</p></div>`;
    }
  } catch(e) { toast(e.message, 'error'); }
}


// ═══════════════════════════════════════════════════════════════
// AUTO-BACKUP SCHEDULE (in Backups Tab)
// ═══════════════════════════════════════════════════════════════
async function loadBackupSchedule(serverId) {
  const [sched, history] = await Promise.all([
    API.get(`/servers/${serverId}/backups/schedule`).catch(() => null),
    API.get(`/servers/${serverId}/backups/schedule/history`).catch(() => []),
  ]);
  if (!sched) return '';

  const nextRun = sched.enabled && sched.cron ? cronNextRun(sched.cron) : null;
  const failures = sched.consecutive_failures || 0;

  return `
    <div class="card" style="margin-bottom:12px;${failures >= 2 ? 'border-color:rgba(255,59,92,.35)' : ''}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div class="card-title" style="display:flex;align-items:center;gap:8px">
          <i data-lucide="calendar-clock"></i> Automatisches Backup
          ${sched.enabled
            ? `<span style="font-size:11px;padding:2px 8px;border-radius:8px;background:rgba(0,245,160,.1);color:var(--accent3);border:1px solid rgba(0,245,160,.2)">Aktiv</span>`
            : `<span style="font-size:11px;padding:2px 8px;border-radius:8px;background:var(--bg3);color:var(--text3)">Inaktiv</span>`}
          ${failures >= 2 ? `<span style="font-size:11px;padding:2px 8px;border-radius:8px;background:rgba(255,59,92,.1);color:var(--danger);border:1px solid rgba(255,59,92,.25)"><i data-lucide="alert-triangle" style="width:10px;height:10px"></i> ${failures} Fehler</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          ${sched.enabled ? `<button class="btn btn-ghost btn-sm" onclick="runBackupScheduleNow('${serverId}')"><i data-lucide="play"></i> Jetzt</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="showBackupScheduleModal('${serverId}')"><i data-lucide="settings"></i> Konfigurieren</button>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:${sched.last_run_at || history.length ? '12px' : '0'}">
        <div style="background:var(--bg3);border-radius:6px;padding:9px 12px">
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Zeitplan</div>
          <code style="font-size:12px">${esc(sched.cron || '–')}</code>
        </div>
        <div style="background:var(--bg3);border-radius:6px;padding:9px 12px">
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Aufbewahren</div>
          <strong style="font-size:13px">${sched.keep_count}</strong><span style="font-size:11px;color:var(--text3)"> Backups</span>
        </div>
        <div style="background:var(--bg3);border-radius:6px;padding:9px 12px">
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Nächste</div>
          <span style="font-size:12px;color:${sched.enabled ? 'var(--accent)' : 'var(--text3)'}">${sched.enabled && nextRun ? nextRun : 'Deaktiviert'}</span>
        </div>
        <div style="background:var(--bg3);border-radius:6px;padding:9px 12px">
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Benachrichtigung</div>
          <span style="font-size:12px">${sched.notify_on_fail
            ? `<span style="color:var(--accent3)"><i data-lucide="mail" style="width:11px;height:11px"></i> ${sched.notify_email ? esc(sched.notify_email.slice(0,20)) : 'Discord/Mail'}</span>`
            : '<span style="color:var(--text3)">Deaktiviert</span>'}</span>
        </div>
      </div>

      ${sched.last_run_at ? `
      <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text3);padding-top:8px;border-top:1px solid var(--border)">
        <i data-lucide="clock" style="width:12px;height:12px"></i>
        Letzter Lauf: ${new Date(sched.last_run_at).toLocaleString('de-DE')}
        ${sched.last_result ? `<span style="margin-left:4px;color:${sched.last_result.includes('Fehler') || sched.last_result.includes('❌') ? 'var(--danger)' : 'var(--accent3)'}">— ${esc(sched.last_result.slice(0,80))}</span>` : ''}
        ${sched.last_success_at && sched.last_run_at !== sched.last_success_at ? `<span style="color:var(--accent3)">· Letzter Erfolg: ${new Date(sched.last_success_at).toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>` : ''}
      </div>` : ''}

      ${history.length > 0 ? `
      <details style="margin-top:10px">
        <summary style="font-size:12px;color:var(--text3);cursor:pointer;user-select:none">
          <i data-lucide="history" style="width:12px;height:12px"></i> Verlauf (${history.length} Einträge)
        </summary>
        <div style="display:flex;flex-direction:column;gap:4px;margin-top:8px;max-height:200px;overflow-y:auto">
          ${history.map(h => `
            <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:var(--bg3);border-radius:6px;font-size:12px">
              <span style="color:${h.status==='ready'?'var(--accent3)':h.status==='failed'?'var(--danger)':'var(--text3)'};flex-shrink:0">
                ${h.status==='ready' ? '✓' : h.status==='failed' ? '✗' : '…'}
              </span>
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.name)}</span>
              ${h.size_bytes > 0 ? `<span style="color:var(--text3);font-family:var(--mono);flex-shrink:0">${(h.size_bytes/1024/1024).toFixed(1)}MB</span>` : ''}
              <span style="color:var(--text3);flex-shrink:0">${new Date(h.created_at).toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
            </div>`).join('')}
        </div>
      </details>` : ''}
    </div>`;
}

function cronNextRun(expr) {
  try {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return '?';
    const [min, hour, dom, mon, dow] = parts;

    const now  = new Date();
    const next = new Date(now);
    next.setSeconds(0, 0);

    // Try up to 8 days ahead
    for (let i = 0; i < 8 * 24 * 60; i++) {
      next.setMinutes(next.getMinutes() + 1);
      if (next <= now) continue;
      const matches = (e, v) => {
        if (e === '*') return true;
        const step = e.match(/^\*\/(\d+)$/); if (step) return v % parseInt(step[1]) === 0;
        const range = e.match(/^(\d+)-(\d+)$/); if (range) return v >= +range[1] && v <= +range[2];
        return parseInt(e) === v;
      };
      if (matches(min, next.getMinutes()) && matches(hour, next.getHours()) &&
          matches(dom, next.getDate()) && matches(mon, next.getMonth()+1) &&
          matches(dow, next.getDay())) {
        const diff = Math.round((next - now) / 60000);
        if (diff < 60)   return `in ${diff} Min`;
        if (diff < 1440) return `heute ${next.getHours().toString().padStart(2,'0')}:${next.getMinutes().toString().padStart(2,'0')}`;
        if (diff < 2880) return `morgen ${next.getHours().toString().padStart(2,'0')}:${next.getMinutes().toString().padStart(2,'0')}`;
        return next.toLocaleDateString('de-DE',{weekday:'short',hour:'2-digit',minute:'2-digit'});
      }
    }
    return 'benutzerdefiniert';
  } catch { return '?'; }
}

function showBackupScheduleModal(serverId) {
  API.get(`/servers/${serverId}/backups/schedule`).then(sched => {
    showModal(`
      <div class="modal-title">
        <span><i data-lucide="calendar-clock"></i> Auto-Backup Konfiguration</span>
        <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
      </div>

      <!-- Enable toggle -->
      <div style="display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--border);margin-bottom:16px">
        <label class="toggle-wrap">
          <input type="checkbox" id="bs-enabled" class="toggle-cb" ${sched.enabled ? 'checked' : ''}/>
          <div class="toggle-track"><div class="toggle-thumb"></div></div>
        </label>
        <div>
          <div style="font-weight:600;font-size:13px">Auto-Backup aktivieren</div>
          <div style="font-size:11px;color:var(--text3)">Erstellt automatisch Backups nach dem Zeitplan</div>
        </div>
      </div>

      <!-- Zeitplan & Aufbewahrung -->
      <div class="grid grid-2" style="gap:12px;margin-bottom:16px">
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label">Cron-Zeitplan</label>
          <input id="bs-cron" class="form-input" style="font-family:var(--mono)" value="${esc(sched.cron)}" placeholder="0 4 * * *"/>
          <div style="font-size:10px;color:var(--text3);margin-top:4px">
            <a href="https://crontab.guru" target="_blank" style="color:var(--accent)">crontab.guru</a>
          </div>
          <!-- Presets -->
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">
            ${[['täglich 04:00','0 4 * * *'],['täglich 02:00','0 2 * * *'],['alle 6h','0 */6 * * *'],
               ['alle 12h','0 */12 * * *'],['wöchentlich Mo','0 3 * * 1'],['monatlich','0 3 1 * *']].map(([label,v]) =>
              `<button type="button" class="btn btn-ghost btn-xs" style="font-size:10px"
                onclick="document.getElementById('bs-cron').value='${v}'">${label}</button>`
            ).join('')}
          </div>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label">Aufbewahrung</label>
          <div style="display:flex;align-items:center;gap:8px">
            <input id="bs-keep" class="form-input" type="number" min="1" max="100" value="${sched.keep_count}" style="width:80px"/>
            <span style="font-size:13px;color:var(--text2)">Backups behalten</span>
          </div>
          <div style="font-size:11px;color:var(--text3);margin-top:4px">Älteste Auto-Backups werden automatisch gelöscht</div>
        </div>
      </div>

      <!-- Name Template -->
      <div class="form-group">
        <label class="form-label">Name-Template</label>
        <input id="bs-tmpl" class="form-input" value="${esc(sched.name_template)}" placeholder="Auto {date} {time}"/>
        <div style="font-size:11px;color:var(--text3);margin-top:3px">
          Platzhalter: <code>{date}</code> · <code>{time}</code> · <code>{server}</code>
        </div>
      </div>

      <!-- Backup vor Update -->
      <div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <label class="toggle-wrap">
            <input type="checkbox" id="bs-before-update" class="toggle-cb" ${sched.backup_before_update ? 'checked' : ''}/>
            <div class="toggle-track"><div class="toggle-thumb"></div></div>
          </label>
          <div>
            <div style="font-weight:600;font-size:13px"><i data-lucide="shield" style="width:12px;height:12px"></i> Backup vor Mod-Updates</div>
            <div style="font-size:11px;color:var(--text3)">Erstellt automatisch ein Backup bevor Mods installiert/aktualisiert werden</div>
          </div>
        </div>
      </div>

      <!-- Benachrichtigungen -->
      <div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <label class="toggle-wrap">
            <input type="checkbox" id="bs-notify" class="toggle-cb" ${sched.notify_on_fail ? 'checked' : ''}
              onchange="document.getElementById('bs-notify-email-row').classList.toggle('hidden',!this.checked)"/>
            <div class="toggle-track"><div class="toggle-thumb"></div></div>
          </label>
          <div>
            <div style="font-weight:600;font-size:13px"><i data-lucide="mail" style="width:12px;height:12px"></i> E-Mail bei Backup-Fehler</div>
            <div style="font-size:11px;color:var(--text3)">Sendet eine E-Mail wenn ein Auto-Backup fehlschlägt</div>
          </div>
        </div>
        <div id="bs-notify-email-row" class="${sched.notify_on_fail ? '' : 'hidden'}">
          <label class="form-label">E-Mail-Adresse</label>
          <input id="bs-email" class="form-input" type="email" placeholder="admin@example.com"
            value="${esc(sched.notify_email || '')}"/>
          <div style="font-size:11px;color:var(--text3);margin-top:3px">
            SMTP muss in .env konfiguriert sein (SMTP_HOST, SMTP_USER, SMTP_PASS)
          </div>
        </div>
      </div>

      <div id="bs-error" class="error-msg hidden"></div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveBackupSchedule('${serverId}')">
          <i data-lucide="save"></i> Speichern
        </button>
      </div>`, true);
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }).catch(() => toast('Fehler beim Laden', 'error'));
}

async function saveBackupSchedule(serverId) {
  const enabled              = document.getElementById('bs-enabled')?.checked ? 1 : 0;
  const cron                 = document.getElementById('bs-cron')?.value?.trim();
  const keep                 = parseInt(document.getElementById('bs-keep')?.value) || 5;
  const tmpl                 = document.getElementById('bs-tmpl')?.value?.trim() || 'Auto {date} {time}';
  const notify_on_fail       = document.getElementById('bs-notify')?.checked ? 1 : 0;
  const notify_email         = document.getElementById('bs-email')?.value?.trim() || '';
  const backup_before_update = document.getElementById('bs-before-update')?.checked ? 1 : 0;
  const errEl                = document.getElementById('bs-error');

  if (cron && cron.split(/\s+/).length !== 5) {
    errEl.textContent = 'Ungültiges Cron-Format (5 Felder: min h dom mon dow)';
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');

  try {
    await API.put(`/servers/${serverId}/backups/schedule`, {
      enabled, cron, keep_count: keep, name_template: tmpl,
      notify_on_fail, notify_email, backup_before_update,
    });
    toast(enabled ? 'Auto-Backup aktiviert' : 'Auto-Backup deaktiviert', 'success');
    closeModal();
    backupsInit(serverId);
  } catch(e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

async function runBackupScheduleNow(serverId) {
  try {
    await API.post(`/servers/${serverId}/backups/schedule/run`, {});
    toast('Backup wird erstellt…', 'success');
    setTimeout(() => backupsInit(serverId), 3000);
  } catch(e) { toast(e.message, 'error'); }
}


// ═══════════════════════════════════════════════════════════════
// BROADCAST PAGE
// ═══════════════════════════════════════════════════════════════
async function loadBroadcasts() {
  document.getElementById('page-actions').innerHTML =
    `<button class="btn btn-primary" onclick="showCreateSchedule()">
       <i data-lucide="calendar-plus"></i> Zeitplan erstellen
     </button>`;

  const [servers, history, schedules] = await Promise.all([
    API.get('/servers').catch(() => []),
    API.get('/servers/broadcast/history').catch(() => []),
    API.get('/servers/announce/schedules').catch(() => []),
  ]);
  const running = servers.filter(s => s.status === 'running');

  document.getElementById('page-content').innerHTML = `
    <!-- Tabs -->
    <div class="tabs" style="margin-bottom:16px" id="bc-tabs">
      <button class="tab active" onclick="bcTab('announce',this)">
        <i data-lucide="megaphone"></i> Ankündigung
      </button>
      <button class="tab" onclick="bcTab('schedules',this)">
        <i data-lucide="calendar-clock"></i> Zeitpläne
        ${schedules.filter(s=>s.enabled).length
          ? `<span style="margin-left:4px;font-size:10px;background:rgba(0,212,255,.2);color:var(--accent);padding:1px 6px;border-radius:8px">${schedules.filter(s=>s.enabled).length}</span>`
          : ''}
      </button>
      <button class="tab" onclick="bcTab('raw',this)">
        <i data-lucide="terminal"></i> Raw-Befehl
      </button>
      <button class="tab" onclick="bcTab('history',this)">
        <i data-lucide="history"></i> Verlauf
        ${history.length ? `<span style="margin-left:4px;font-size:10px;background:var(--bg3);color:var(--text3);padding:1px 6px;border-radius:8px">${history.length}</span>` : ''}
      </button>
    </div>

    <!-- ANNOUNCE TAB -->
    <div id="bc-panel-announce">
      <div style="display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start">
        <div style="display:flex;flex-direction:column;gap:14px">

          <!-- Nachricht -->
          <div class="card">
            <div class="card-title" style="margin-bottom:14px"><i data-lucide="megaphone"></i> Ankündigung senden</div>

            <div class="form-group">
              <label class="form-label" style="display:flex;justify-content:space-between">
                <span>Nachricht</span>
                <span id="ann-char-count" style="color:var(--text3);font-size:11px">0 Zeichen</span>
              </label>
              <textarea id="ann-msg" class="form-input" rows="3"
                placeholder="Wartung in 10 Minuten! Server wird neu gestartet."
                oninput="document.getElementById('ann-char-count').textContent=this.value.length+' Zeichen';annUpdatePreview()"
                style="resize:vertical"></textarea>
            </div>

            <!-- Live-Vorschau -->
            <div id="ann-preview" style="background:var(--bg3);border-radius:8px;padding:10px 14px;font-family:var(--mono);font-size:12px;color:var(--accent3);margin-bottom:14px;display:none">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Vorschau (Konsole)</div>
              <span id="ann-preview-text"></span>
            </div>

            <div class="grid grid-2" style="gap:12px;margin-bottom:14px">
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label">Konsolen-Befehl Template</label>
                <input id="ann-cmd" class="form-input" value="say {message}"
                  placeholder="say {message}" oninput="annUpdatePreview()"/>
                <div style="font-size:11px;color:var(--text3);margin-top:3px">
                  <code>{message}</code> wird durch deine Nachricht ersetzt
                </div>
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label">Verzögerung zwischen Servern</label>
                <select id="ann-delay" class="form-input">
                  <option value="0">Kein Delay</option>
                  <option value="200">200 ms</option>
                  <option value="500">500 ms</option>
                  <option value="1000">1 Sek.</option>
                  <option value="2000">2 Sek.</option>
                </select>
              </div>
            </div>

            <!-- Ziel -->
            <div class="form-group">
              <label class="form-label">Ziel</label>
              <div style="display:flex;flex-direction:column;gap:6px">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                  <input type="radio" name="ann-target" value="running" checked/>
                  <span style="font-size:13px">Alle laufenden Server
                    <strong style="color:var(--accent)">(${running.length})</strong>
                  </span>
                </label>
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                  <input type="radio" name="ann-target" value="all"/>
                  <span style="font-size:13px">Alle Server (${servers.length})</span>
                </label>
              </div>
            </div>
          </div>

          <!-- Discord -->
          <div class="card">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
              <label class="toggle-wrap">
                <input type="checkbox" id="ann-discord-enabled" class="toggle-cb"
                  onchange="document.getElementById('ann-discord-row').classList.toggle('hidden', !this.checked)"/>
                <div class="toggle-track"><div class="toggle-thumb"></div></div>
              </label>
              <div>
                <div style="font-weight:600;font-size:13px"><i data-lucide="message-square"></i> Discord-Webhook</div>
                <div style="font-size:11px;color:var(--text3)">Nachricht auch als Discord Embed senden</div>
              </div>
            </div>
            <div id="ann-discord-row" class="hidden">
              <div class="form-group" style="margin-bottom:8px">
                <label class="form-label">Webhook-URL</label>
                <input id="ann-discord-url" class="form-input" type="url"
                  placeholder="https://discord.com/api/webhooks/…"/>
              </div>
              <div class="info-msg" style="font-size:11px">
                <i data-lucide="info"></i>
                Discord → Server-Einstellungen → Integrationen → Webhook erstellen → URL kopieren
              </div>
            </div>
          </div>

          <button class="btn btn-primary btn-block" id="ann-send-btn" onclick="doAnnounce()">
            <i data-lucide="send"></i> Ankündigung senden
          </button>
          <div id="ann-result" class="hidden" style="margin-top:0"></div>
        </div>

        <!-- Letzte Ankündigungen -->
        <div class="card" style="position:sticky;top:16px">
          <div class="card-header" style="margin-bottom:12px">
            <div class="card-title"><i data-lucide="history"></i> Letzte Ankündigungen</div>
          </div>
          ${history.filter(h=>h.type==='announce'||h.type==='announce_schedule').length === 0
            ? '<div class="empty" style="padding:24px"><p>Noch keine Ankündigungen</p></div>'
            : `<div style="display:flex;flex-direction:column;gap:6px;max-height:520px;overflow-y:auto">
                ${history.filter(h=>h.type==='announce'||h.type==='announce_schedule').slice(0,20).map(h => bcHistoryCard(h)).join('')}
              </div>`}
        </div>
      </div>
    </div>

    <!-- SCHEDULES TAB -->
    <div id="bc-panel-schedules" class="hidden">
      <div style="display:flex;flex-direction:column;gap:12px">
        ${schedules.length === 0
          ? `<div class="card">
               <div class="empty" style="padding:40px">
                 <div class="empty-icon"><i data-lucide="calendar-clock"></i></div>
                 <h3>Keine Zeitpläne</h3>
                 <p>Erstelle einen Zeitplan für regelmäßige Ankündigungen</p>
                 <button class="btn btn-primary" style="margin-top:14px" onclick="showCreateSchedule()">
                   <i data-lucide="plus"></i> Zeitplan erstellen
                 </button>
               </div>
             </div>`
          : schedules.map(s => bcScheduleCard(s)).join('')}
      </div>
    </div>

    <!-- RAW BROADCAST TAB -->
    <div id="bc-panel-raw" class="hidden">
      <div style="display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start">
        <div class="card">
          <div class="card-title" style="margin-bottom:14px"><i data-lucide="terminal"></i> Raw-Befehl senden</div>
          <div class="info-msg" style="margin-bottom:14px;font-size:12px">
            Sendet einen beliebigen Befehl direkt an die Server-Konsole — ohne Formatierung oder Discord.
          </div>
          <div class="form-group">
            <label class="form-label">Befehl</label>
            <input id="bc-cmd" class="form-input" placeholder="say Hallo Welt"
              onkeydown="if(event.key==='Enter')doBroadcast()"/>
          </div>
          <div class="form-group">
            <label class="form-label">Ziel</label>
            <div style="display:flex;flex-direction:column;gap:6px">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="radio" name="bc-target" value="running" checked id="bc-t-running"/>
                <span style="font-size:13px">Alle laufenden Server (<strong>${running.length}</strong>)</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="radio" name="bc-target" value="all" id="bc-t-all"/>
                <span style="font-size:13px">Alle Server (<strong>${servers.length}</strong>)</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="radio" name="bc-target" value="select" id="bc-t-select"/>
                <span style="font-size:13px">Server auswählen</span>
              </label>
            </div>
          </div>
          <div id="bc-server-select" class="hidden" style="margin-bottom:14px">
            <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:3px">
              ${servers.map(s => `
                <label style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer"
                  onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''">
                  <input type="checkbox" class="bc-srv-cb" value="${s.id}" style="accent-color:var(--accent)"/>
                  <span class="server-status-dot ${s.status}" style="width:8px;height:8px;flex-shrink:0"></span>
                  <span style="flex:1;font-size:13px">${esc(s.name)}</span>
                  <span style="font-size:11px;color:var(--text3)">${s.status}</span>
                </label>`).join('')}
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" style="display:flex;justify-content:space-between">
              <span>Verzögerung</span>
              <span id="bc-delay-val" style="color:var(--accent)">0 ms</span>
            </label>
            <input type="range" id="bc-delay" min="0" max="2000" step="100" value="0"
              class="form-input" style="padding:4px 0"
              oninput="document.getElementById('bc-delay-val').textContent=this.value+' ms'"/>
          </div>
          <button class="btn btn-primary btn-block" id="bc-send-btn" onclick="doBroadcast()">
            <i data-lucide="terminal"></i> Befehl senden
          </button>
          <div id="bc-result" class="hidden" style="margin-top:10px"></div>
        </div>
        <div class="card" style="position:sticky;top:16px">
          <div class="card-title" style="margin-bottom:12px"><i data-lucide="history"></i> Raw-Verlauf</div>
          ${history.filter(h=>h.type==='broadcast').length === 0
            ? '<div class="empty" style="padding:24px"><p>Noch keine Raw-Broadcasts</p></div>'
            : `<div style="display:flex;flex-direction:column;gap:6px;max-height:500px;overflow-y:auto">
                ${history.filter(h=>h.type==='broadcast').slice(0,25).map(h => bcHistoryCard(h)).join('')}
              </div>`}
        </div>
      </div>
    </div>

    <!-- HISTORY TAB -->
    <div id="bc-panel-history" class="hidden">
      ${history.length === 0
        ? '<div class="card"><div class="empty" style="padding:40px"><p>Noch keine Broadcasts</p></div></div>'
        : `<div style="display:flex;flex-direction:column;gap:8px">
            ${history.slice(0,100).map(h => bcHistoryCard(h, true)).join('')}
           </div>`}
    </div>`;

  // Tab-Switcher
  document.querySelectorAll('input[name="bc-target"]').forEach(r => {
    r.addEventListener('change', () => {
      document.getElementById('bc-server-select').classList.toggle('hidden', r.value !== 'select');
    });
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ── Tab-Switcher ──────────────────────────────────────────────────────────────
function bcTab(tab, btn) {
  document.querySelectorAll('#bc-tabs .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  ['announce','schedules','raw','history'].forEach(t => {
    const el = document.getElementById('bc-panel-'+t);
    if (el) el.classList.toggle('hidden', t !== tab);
  });
}

// ── History-Karte ─────────────────────────────────────────────────────────────
function bcHistoryCard(h, full = false) {
  const typeLabel = { announce:'Ankündigung', announce_schedule:'Zeitplan', broadcast:'Raw' }[h.type] || h.type;
  const typeColor = { announce:'var(--accent)', announce_schedule:'#c084fc', broadcast:'var(--warn)' }[h.type] || 'var(--text3)';
  return `
    <div style="background:var(--bg3);border-radius:8px;padding:10px 14px;border-left:3px solid ${typeColor}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px">
        <div style="flex:1;min-width:0">
          <span style="font-size:10px;font-weight:700;color:${typeColor};text-transform:uppercase;letter-spacing:.5px">${typeLabel}</span>
          ${h.schedule_name ? `<span style="font-size:11px;color:var(--text3);margin-left:6px">${esc(h.schedule_name)}</span>` : ''}
          ${full ? `<div style="font-size:12px;color:var(--text);margin-top:2px;word-break:break-word">${esc(h.command?.slice(0,120)||'?')}${(h.command?.length||0)>120?'…':''}</div>` : `<div style="font-size:12px;color:var(--text2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.command?.slice(0,60)||'?')}${(h.command?.length||0)>60?'…':''}</div>`}
        </div>
        <span style="font-size:10px;color:var(--text3);flex-shrink:0">${new Date(h.at).toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
      </div>
      <div style="display:flex;gap:10px;font-size:11px;flex-wrap:wrap">
        <span style="color:var(--accent3)"><i data-lucide="check-circle-2" style="width:10px;height:10px"></i> ${h.sent||0} gesendet</span>
        ${h.failed ? `<span style="color:var(--danger)"><i data-lucide="x-circle" style="width:10px;height:10px"></i> ${h.failed} Fehler</span>` : ''}
        <span style="color:var(--text3)">/ ${h.target_count||0} Ziel${h.target_count!==1?'e':''}</span>
        ${h.discord_ok === true ? '<span style="color:#7289DA"><i data-lucide="message-square" style="width:10px;height:10px"></i> Discord</span>' : ''}
        ${h.discord_ok === false ? '<span style="color:var(--danger)">Discord fehlgeschlagen</span>' : ''}
      </div>
    </div>`;
}

// ── Schedule-Karte ────────────────────────────────────────────────────────────
function bcScheduleCard(s) {
  const nextCron = s.enabled ? scheduleNextRun(s.cron) : null;
  return `
    <div class="card" style="border-left:3px solid ${s.enabled?'var(--accent)':'var(--border)'}">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="width:38px;height:38px;border-radius:8px;background:${s.enabled?'rgba(0,212,255,.1)':'var(--bg3)'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i data-lucide="calendar-clock" style="width:18px;height:18px;color:${s.enabled?'var(--accent)':'var(--text3)'}"></i>
        </div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
            <strong style="font-size:14px">${esc(s.name)}</strong>
            <span style="font-size:10px;padding:2px 8px;border-radius:8px;font-weight:700;
              background:${s.enabled?'rgba(0,245,160,.1)':'rgba(100,116,139,.15)'};
              color:${s.enabled?'var(--accent3)':'var(--text3)'};
              border:1px solid ${s.enabled?'rgba(0,245,160,.2)':'rgba(100,116,139,.2)'}">
              ${s.enabled ? 'Aktiv' : 'Deaktiviert'}
            </span>
          </div>
          <div style="font-size:12px;color:var(--text2);margin-bottom:8px;word-break:break-word">
            ${esc(s.message.slice(0,120))}${s.message.length>120?'…':''}
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--text3)">
            <span><i data-lucide="clock" style="width:10px;height:10px"></i> <code>${esc(s.cron)}</code></span>
            ${nextCron ? `<span style="color:var(--accent)"><i data-lucide="timer" style="width:10px;height:10px"></i> Nächste: ${nextCron}</span>` : ''}
            <span><i data-lucide="target" style="width:10px;height:10px"></i> ${s.target === 'running' ? 'Laufende Server' : 'Alle Server'}</span>
            ${s.discord_enabled ? '<span style="color:#7289DA"><i data-lucide="message-square" style="width:10px;height:10px"></i> Discord</span>' : ''}
            ${s.last_run_at ? `<span>Zuletzt: ${new Date(s.last_run_at).toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>` : ''}
            ${s.last_result ? `<span style="color:${s.last_result.includes('Fehler')?'var(--danger)':'var(--accent3)'}">${esc(s.last_result.slice(0,60))}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn btn-ghost btn-sm" onclick="runScheduleNow('${s.id}','${esc(s.name)}')" title="Jetzt ausführen">
            <i data-lucide="play"></i>
          </button>
          <button class="btn btn-ghost btn-sm" onclick="editSchedule('${s.id}')" title="Bearbeiten">
            <i data-lucide="pencil"></i>
          </button>
          <button class="btn btn-ghost btn-sm" onclick="toggleSchedule('${s.id}',${s.enabled?0:1})" title="${s.enabled?'Deaktivieren':'Aktivieren'}">
            <i data-lucide="${s.enabled?'pause':'play-circle'}"></i>
          </button>
          <button class="btn btn-ghost btn-sm text-danger" onclick="deleteSchedule('${s.id}','${esc(s.name)}')" title="Löschen">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      </div>
    </div>`;
}

// ── Nächsten Cron-Zeitpunkt berechnen (simpel) ────────────────────────────────
function scheduleNextRun(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour] = parts;
  if (min !== '*' && hour !== '*') {
    const h = parseInt(hour), m = parseInt(min);
    if (!isNaN(h) && !isNaN(m)) {
      const now   = new Date();
      const next  = new Date();
      next.setHours(h, m, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      return next.toLocaleString('de-DE', { weekday:'short', hour:'2-digit', minute:'2-digit' });
    }
  }
  if (hour !== '*' && min === '*') return `jede Stunde in Std. ${hour}`;
  if (min !== '*' && hour === '*') return `täglich Minute ${min}`;
  return 'benutzerdefiniert';
}

// ── Live-Vorschau ─────────────────────────────────────────────────────────────
function annUpdatePreview() {
  const msg = document.getElementById('ann-msg')?.value || '';
  const cmd = document.getElementById('ann-cmd')?.value || 'say {message}';
  const prev = document.getElementById('ann-preview');
  const prevText = document.getElementById('ann-preview-text');
  if (!msg.trim()) { if (prev) prev.style.display = 'none'; return; }
  const result = cmd.includes('{message}') ? cmd.replace(/\{message\}/g, msg) : cmd + ' ' + msg;
  if (prev) prev.style.display = 'block';
  if (prevText) prevText.textContent = '> ' + result;
}

// ── Announce senden ───────────────────────────────────────────────────────────
async function doAnnounce() {
  const msg = document.getElementById('ann-msg')?.value?.trim();
  if (!msg) { toast('Nachricht erforderlich', 'error'); return; }

  const target          = document.querySelector('input[name="ann-target"]:checked')?.value || 'running';
  const delay_ms        = parseInt(document.getElementById('ann-delay')?.value) || 0;
  const server_command  = document.getElementById('ann-cmd')?.value?.trim() || 'say {message}';
  const discord_enabled = document.getElementById('ann-discord-enabled')?.checked || false;
  const discord_webhook = document.getElementById('ann-discord-url')?.value?.trim() || '';

  if (discord_enabled && !discord_webhook) {
    toast('Webhook-URL erforderlich wenn Discord aktiv', 'error'); return;
  }

  const btn = document.getElementById('ann-send-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> Sende…'; }
  if (typeof lucide !== 'undefined') lucide.createIcons();

  try {
    const res = await API.post('/servers/announce', {
      message: msg, target, delay_ms, server_command,
      discord_enabled, discord_webhook,
    });

    const el = document.getElementById('ann-result');
    if (el) {
      el.className = 'success-msg';
      el.innerHTML = `<i data-lucide="check-circle-2"></i> Ankündigung wird gesendet…`;
      el.classList.remove('hidden');
    }
    toast('Ankündigung wird gesendet', 'success');
    document.getElementById('ann-msg').value = '';
    annUpdatePreview();
    setTimeout(() => loadBroadcasts(), 3500);
  } catch(e) {
    toast(e.message, 'error');
    const el = document.getElementById('ann-result');
    if (el) { el.className = 'error-msg'; el.textContent = e.message; el.classList.remove('hidden'); }
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="send"></i> Ankündigung senden'; }
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

// ── Raw-Broadcast senden ──────────────────────────────────────────────────────
async function doBroadcast() {
  const cmd = document.getElementById('bc-cmd')?.value?.trim();
  if (!cmd) { toast('Befehl erforderlich', 'error'); return; }

  const target    = document.querySelector('input[name="bc-target"]:checked')?.value || 'running';
  const delayMs   = parseInt(document.getElementById('bc-delay')?.value) || 0;
  let serverIds;
  if (target === 'select') {
    serverIds = [...document.querySelectorAll('.bc-srv-cb:checked')].map(cb => cb.value);
    if (!serverIds.length) { toast('Mindestens einen Server auswählen', 'error'); return; }
  }

  const btn = document.getElementById('bc-send-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> Sende…'; }
  if (typeof lucide !== 'undefined') lucide.createIcons();

  try {
    const res = await API.post('/servers/broadcast', {
      command: cmd,
      target: target === 'select' ? 'running' : target,
      server_ids: serverIds,
      delay_ms: delayMs,
    });
    const el = document.getElementById('bc-result');
    if (el) {
      el.className = 'success-msg';
      el.innerHTML = `<i data-lucide="check-circle-2"></i> Befehl wird an <strong>${res.target_count}</strong> Server gesendet…`;
      el.classList.remove('hidden');
    }
    toast(`Broadcast → ${res.target_count} Server`, 'success');
    document.getElementById('bc-cmd').value = '';
    setTimeout(() => loadBroadcasts(), 3000);
  } catch(e) {
    toast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="terminal"></i> Befehl senden'; }
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

// ── Schedule erstellen / bearbeiten ──────────────────────────────────────────
function scheduleModalHtml(s = {}) {
  return `
    <div class="form-group">
      <label class="form-label">Name *</label>
      <input id="sch-name" class="form-input" value="${esc(s.name||'')}" placeholder="Tägliche Wartungsankündigung"/>
    </div>
    <div class="form-group">
      <label class="form-label" style="display:flex;justify-content:space-between">
        <span>Nachricht *</span>
        <span id="sch-char" style="font-size:11px;color:var(--text3)">${(s.message||'').length} Zeichen</span>
      </label>
      <textarea id="sch-msg" class="form-input" rows="3"
        oninput="document.getElementById('sch-char').textContent=this.value.length+' Zeichen'"
        placeholder="Der Server wird in 5 Minuten neu gestartet.">${esc(s.message||'')}</textarea>
    </div>
    <div class="grid grid-2" style="gap:12px;margin-bottom:12px">
      <div class="form-group">
        <label class="form-label">Cron-Ausdruck *</label>
        <input id="sch-cron" class="form-input" value="${esc(s.cron||'0 20 * * *')}" placeholder="0 20 * * *"/>
        <div style="font-size:11px;color:var(--text3);margin-top:3px">
          <a href="https://crontab.guru" target="_blank" style="color:var(--accent)">crontab.guru</a>
          — Beispiel: <code>0 20 * * *</code> = täglich 20:00
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Konsolen-Befehl</label>
        <input id="sch-cmd" class="form-input" value="${esc(s.server_command||'say {message}')}" placeholder="say {message}"/>
      </div>
    </div>
    <div class="grid grid-2" style="gap:12px;margin-bottom:12px">
      <div class="form-group">
        <label class="form-label">Ziel</label>
        <select id="sch-target" class="form-input">
          <option value="running" ${(s.target||'running')==='running'?'selected':''}>Laufende Server</option>
          <option value="all"     ${s.target==='all'?'selected':''}>Alle Server</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Verzögerung</label>
        <select id="sch-delay" class="form-input">
          ${[0,200,500,1000,2000].map(d =>
            `<option value="${d}" ${(s.delay_ms||0)===d?'selected':''}>${d===0?'Kein Delay':d+' ms'}</option>`
          ).join('')}
        </select>
      </div>
    </div>

    <!-- Discord -->
    <div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <label class="toggle-wrap">
          <input type="checkbox" id="sch-discord-enabled" class="toggle-cb"
            ${s.discord_enabled?'checked':''}
            onchange="document.getElementById('sch-discord-row').classList.toggle('hidden',!this.checked)"/>
          <div class="toggle-track"><div class="toggle-thumb"></div></div>
        </label>
        <span style="font-size:13px;font-weight:500"><i data-lucide="message-square"></i> Discord-Webhook</span>
      </div>
      <div id="sch-discord-row" class="${s.discord_enabled?'':'hidden'}">
        <input id="sch-discord-url" class="form-input" type="url"
          value="${esc(s.discord_webhook||'')}" placeholder="https://discord.com/api/webhooks/…"/>
      </div>
    </div>

    <div style="display:flex;align-items:center;gap:8px">
      <label class="toggle-wrap">
        <input type="checkbox" id="sch-enabled" class="toggle-cb" ${(s.enabled===undefined||s.enabled)?'checked':''}/>
        <div class="toggle-track"><div class="toggle-thumb"></div></div>
      </label>
      <span style="font-size:13px">Zeitplan aktivieren</span>
    </div>`;
}

function showCreateSchedule() {
  showModal(`
    <div class="modal-title">
      <span><i data-lucide="calendar-plus"></i> Zeitplan erstellen</span>
      <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
    </div>
    ${scheduleModalHtml()}
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitCreateSchedule()">
        <i data-lucide="calendar-plus"></i> Erstellen
      </button>
    </div>`, true);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function submitCreateSchedule() {
  const errEl = document.getElementById('m-error');
  const body  = scheduleFormData();
  if (!body.name) { errEl.textContent = 'Name erforderlich'; errEl.classList.remove('hidden'); return; }
  if (!body.message) { errEl.textContent = 'Nachricht erforderlich'; errEl.classList.remove('hidden'); return; }
  if (body.cron.trim().split(/\s+/).length !== 5) { errEl.textContent = 'Ungültiges Cron-Format (5 Felder)'; errEl.classList.remove('hidden'); return; }
  try {
    await API.post('/servers/announce/schedules', body);
    toast('Zeitplan erstellt', 'success');
    closeModal();
    loadBroadcasts();
  } catch(e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
}

async function editSchedule(id) {
  const schedules = await API.get('/servers/announce/schedules').catch(() => []);
  const s = schedules.find(x => x.id === id);
  if (!s) { toast('Zeitplan nicht gefunden', 'error'); return; }

  showModal(`
    <div class="modal-title">
      <span><i data-lucide="pencil"></i> Zeitplan bearbeiten</span>
      <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
    </div>
    ${scheduleModalHtml(s)}
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitEditSchedule('${id}')">
        <i data-lucide="save"></i> Speichern
      </button>
    </div>`, true);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function submitEditSchedule(id) {
  const errEl = document.getElementById('m-error');
  const body  = scheduleFormData();
  if (!body.name || !body.message) { errEl.textContent = 'Name und Nachricht erforderlich'; errEl.classList.remove('hidden'); return; }
  try {
    await API.patch(`/servers/announce/schedules/${id}`, body);
    toast('Zeitplan gespeichert', 'success');
    closeModal();
    loadBroadcasts();
  } catch(e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
}

function scheduleFormData() {
  return {
    name:             document.getElementById('sch-name')?.value?.trim() || '',
    message:          document.getElementById('sch-msg')?.value?.trim()  || '',
    cron:             document.getElementById('sch-cron')?.value?.trim()  || '0 20 * * *',
    server_command:   document.getElementById('sch-cmd')?.value?.trim()   || 'say {message}',
    target:           document.getElementById('sch-target')?.value        || 'running',
    delay_ms:         parseInt(document.getElementById('sch-delay')?.value) || 0,
    discord_enabled:  document.getElementById('sch-discord-enabled')?.checked || false,
    discord_webhook:  document.getElementById('sch-discord-url')?.value?.trim() || '',
    enabled:          document.getElementById('sch-enabled')?.checked ?? true,
  };
}

async function runScheduleNow(id, name) {
  try {
    await API.post(`/servers/announce/schedules/${id}/run`, {});
    toast(`"${name}" wird ausgeführt…`, 'success');
    setTimeout(() => loadBroadcasts(), 3000);
  } catch(e) { toast(e.message, 'error'); }
}

async function toggleSchedule(id, enabled) {
  try {
    await API.patch(`/servers/announce/schedules/${id}`, { enabled: !!enabled });
    toast(enabled ? 'Zeitplan aktiviert' : 'Zeitplan deaktiviert', 'success');
    loadBroadcasts();
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteSchedule(id, name) {
  if (!confirm(`Zeitplan "${name}" wirklich löschen?`)) return;
  try {
    await API.delete(`/servers/announce/schedules/${id}`);
    toast('Zeitplan gelöscht', 'success');
    loadBroadcasts();
  } catch(e) { toast(e.message, 'error'); }
}


// ═══════════════════════════════════════════════════════════════
// ADMIN: DATENBANK-HOSTS
// ═══════════════════════════════════════════════════════════════
async function loadAdminDbHosts() {
  document.getElementById('page-actions').innerHTML =
    `<button class="btn btn-primary" onclick="showAddDbHost()"><i data-lucide="plus"></i> Host hinzufügen</button>`;

  const hosts = await API.get('/admin/database-hosts').catch(() => []);

  document.getElementById('page-content').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px">
      <!-- Info Card -->
      <div class="card">
        <div class="card-title" style="margin-bottom:8px"><i data-lucide="info"></i> Datenbank-Hosts</div>
        <p style="font-size:13px;color:var(--text2);margin-bottom:10px">
          Verwalte MySQL/MariaDB-Hosts auf denen NexPanel automatisch Datenbanken und Benutzer anlegen kann.
          Pro Server-Datenbank wird ein separater Datenbanknutzer mit eingeschränkten Berechtigungen erstellt.
        </p>
        <div class="info-msg" style="font-size:12px">
          <i data-lucide="package"></i>
          MySQL-Unterstützung benötigt <code>npm install mysql2</code>.
          Ohne <code>mysql2</code> werden Datenbanken in NexPanel gespeichert, müssen aber manuell im MySQL-Server angelegt werden.
        </div>
      </div>

      <!-- Hosts List -->
      ${hosts.length === 0
        ? `<div class="card">
             <div class="empty" style="padding:32px">
               <div class="empty-icon"><i data-lucide="server"></i></div>
               <h3>Keine Hosts konfiguriert</h3>
               <p>Füge einen MySQL/MariaDB-Host hinzu</p>
               <button class="btn btn-primary" style="margin-top:14px" onclick="showAddDbHost()">
                 <i data-lucide="plus"></i> Host hinzufügen
               </button>
             </div>
           </div>`
        : hosts.map(h => `
            <div class="card" style="border-left:3px solid ${h.is_default?'var(--accent)':'var(--border)'}">
              <div style="display:flex;align-items:center;gap:12px">
                <div style="width:40px;height:40px;border-radius:8px;background:rgba(0,212,255,.08);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                  <i data-lucide="database" style="width:20px;height:20px;color:var(--accent)"></i>
                </div>
                <div style="flex:1">
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                    <strong style="font-size:14px">${esc(h.name)}</strong>
                    ${h.is_default ? '<span style="font-size:10px;background:rgba(0,212,255,.15);color:var(--accent);padding:2px 8px;border-radius:8px;font-weight:700">Standard</span>' : ''}
                  </div>
                  <div style="font-size:12px;color:var(--text3);display:flex;gap:14px;flex-wrap:wrap">
                    <span><code>${esc(h.host)}:${h.port}</code></span>
                    <span>Benutzer: <code>${esc(h.root_user)}</code></span>
                    ${h.phpmyadmin_url ? `<span><a href="${esc(h.phpmyadmin_url)}" target="_blank" style="color:var(--accent)">phpMyAdmin</a></span>` : ''}
                  </div>
                </div>
                <div style="display:flex;gap:6px">
                  <button class="btn btn-ghost btn-sm" onclick="testDbHost('${h.id}')" title="Verbindung testen">
                    <i data-lucide="plug"></i>
                  </button>
                  <button class="btn btn-ghost btn-sm" onclick="showEditDbHost('${h.id}')" title="Bearbeiten">
                    <i data-lucide="pencil"></i>
                  </button>
                  <button class="btn btn-ghost btn-sm text-danger" onclick="deleteDbHost('${h.id}','${esc(h.name)}')" title="Löschen">
                    <i data-lucide="trash-2"></i>
                  </button>
                </div>
              </div>
            </div>`).join('')}

      <!-- mysql2 Install Hint -->
      <div class="card" style="background:var(--bg3)">
        <div class="card-title" style="margin-bottom:8px"><i data-lucide="terminal"></i> Installation</div>
        <pre style="font-size:12px;font-family:var(--mono);background:var(--bg);padding:12px;border-radius:8px;overflow-x:auto">npm install mysql2</pre>
        <p style="font-size:12px;color:var(--text3);margin-top:8px">
          Nach der Installation können Datenbanken automatisch in MySQL/MariaDB angelegt und gelöscht werden.
        </p>
      </div>
    </div>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function dbHostForm(h = {}) {
  return `
    <div class="grid grid-2" style="gap:12px;margin-bottom:12px">
      <div class="form-group">
        <label class="form-label">Name *</label>
        <input id="dbh-name" class="form-input" placeholder="Lokale DB" value="${esc(h.name||'')}"/>
      </div>
      <div class="form-group">
        <label class="form-label">Host *</label>
        <input id="dbh-host" class="form-input" placeholder="127.0.0.1" value="${esc(h.host||'127.0.0.1')}"/>
      </div>
    </div>
    <div class="grid grid-2" style="gap:12px;margin-bottom:12px">
      <div class="form-group">
        <label class="form-label">Port</label>
        <input id="dbh-port" class="form-input" type="number" value="${h.port||3306}"/>
      </div>
      <div class="form-group">
        <label class="form-label">Root-Benutzer</label>
        <input id="dbh-user" class="form-input" placeholder="root" value="${esc(h.root_user||'root')}"/>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Root-Passwort</label>
      <input id="dbh-pass" class="form-input" type="password" placeholder="${h.id ? '(unverändert lassen)' : 'Passwort'}"/>
    </div>
    <div class="form-group">
      <label class="form-label">phpMyAdmin URL <span style="color:var(--text3)">(optional)</span></label>
      <input id="dbh-pma" class="form-input" placeholder="https://phpmyadmin.example.com" value="${esc(h.phpmyadmin_url||'')}"/>
      <div style="font-size:11px;color:var(--text3);margin-top:3px">
        Wenn angegeben, wird ein direkter Link zu phpMyAdmin in der Datenbank-Übersicht angezeigt.
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <label class="toggle-wrap">
        <input type="checkbox" id="dbh-default" class="toggle-cb" ${h.is_default?'checked':''}/>
        <div class="toggle-track"><div class="toggle-thumb"></div></div>
      </label>
      <span style="font-size:13px">Als Standard-Host verwenden</span>
    </div>`;
}

function showAddDbHost() {
  showModal(`
    <div class="modal-title">
      <span><i data-lucide="database"></i> Datenbank-Host hinzufügen</span>
      <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
    </div>
    ${dbHostForm()}
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitAddDbHost()"><i data-lucide="plus"></i> Hinzufügen</button>
    </div>`, true);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function submitAddDbHost() {
  const errEl = document.getElementById('m-error');
  const body = {
    name:           document.getElementById('dbh-name').value.trim(),
    host:           document.getElementById('dbh-host').value.trim(),
    port:           parseInt(document.getElementById('dbh-port').value) || 3306,
    root_user:      document.getElementById('dbh-user').value.trim() || 'root',
    root_password:  document.getElementById('dbh-pass').value,
    phpmyadmin_url: document.getElementById('dbh-pma').value.trim(),
    is_default:     document.getElementById('dbh-default').checked,
  };
  if (!body.name || !body.host) { errEl.textContent='Name und Host erforderlich'; errEl.classList.remove('hidden'); return; }
  try {
    await API.post('/admin/database-hosts', body);
    toast('Host hinzugefügt', 'success');
    closeModal();
    loadAdminDbHosts();
  } catch(e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
}

async function showEditDbHost(id) {
  const hosts = await API.get('/admin/database-hosts').catch(() => []);
  const h = hosts.find(x => x.id === id);
  if (!h) return toast('Host nicht gefunden', 'error');

  showModal(`
    <div class="modal-title">
      <span><i data-lucide="pencil"></i> Host bearbeiten</span>
      <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
    </div>
    ${dbHostForm(h)}
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitEditDbHost('${id}')"><i data-lucide="save"></i> Speichern</button>
    </div>`, true);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function submitEditDbHost(id) {
  const errEl = document.getElementById('m-error');
  const pass = document.getElementById('dbh-pass').value;
  const body = {
    name:           document.getElementById('dbh-name').value.trim(),
    host:           document.getElementById('dbh-host').value.trim(),
    port:           parseInt(document.getElementById('dbh-port').value) || 3306,
    root_user:      document.getElementById('dbh-user').value.trim(),
    phpmyadmin_url: document.getElementById('dbh-pma').value.trim(),
    is_default:     document.getElementById('dbh-default').checked,
    ...(pass ? { root_password: pass } : {}),
  };
  try {
    await API.patch(`/admin/database-hosts/${id}`, body);
    toast('Host gespeichert', 'success');
    closeModal();
    loadAdminDbHosts();
  } catch(e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
}

async function testDbHost(id) {
  toast('Teste Verbindung…', 'info');
  try {
    const res = await API.post(`/admin/database-hosts/${id}/test`, {});
    if (res.success) toast(`Verbunden! MySQL ${res.version}`, 'success');
    else toast(`Verbindung fehlgeschlagen: ${res.error}`, 'error');
  } catch(e) { toast(`Fehler: ${e.message}`, 'error'); }
}

async function deleteDbHost(id, name) {
  if (!confirm(`Host "${name}" wirklich entfernen?\n\nBestehende Datenbank-Einträge bleiben erhalten, können aber nicht mehr automatisch verwaltet werden.`)) return;
  try {
    await API.delete(`/admin/database-hosts/${id}`);
    toast('Host entfernt', 'success');
    loadAdminDbHosts();
  } catch(e) { toast(e.message, 'error'); }
}


// ═══════════════════════════════════════════════════════════════
// ADMIN: USER-QUOTAS
// ═══════════════════════════════════════════════════════════════

async function loadAdminQuotas() {
  document.getElementById('page-actions').innerHTML = '';
  const users = await API.get('/admin/quotas').catch(() => []);

  function bar(used, max, color='var(--accent)') {
    const pct = max > 0 ? Math.min(100, Math.round(used/max*100)) : 0;
    const col  = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : color;
    return `<div style="background:var(--bg3);border-radius:4px;height:6px;margin-top:3px;overflow:hidden">
      <div style="height:100%;width:${pct}%;background:${col};border-radius:4px;transition:.3s"></div>
    </div><div style="font-size:10px;color:var(--text3);margin-top:2px">${used} / ${max}</div>`;
  }

  document.getElementById('page-content').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="card">
        <div class="card-title" style="margin-bottom:6px"><i data-lucide="gauge"></i> User-Ressourcen-Quotas</div>
        <p style="font-size:13px;color:var(--text2)">
          Setze Ressourcenlimits pro Benutzer. Admins sind von Quotas ausgenommen.
          Server-Erstellung wird blockiert wenn die Quota überschritten wird.
        </p>
      </div>

      <div class="card" style="padding:0;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--bg3)">
              <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase">Benutzer</th>
              <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase">Server</th>
              <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase">RAM</th>
              <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase">CPU</th>
              <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase">Disk</th>
              <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase">DBs</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;color:var(--text3)"></th>
            </tr>
          </thead>
          <tbody>
            ${users.filter(u => u.role !== 'admin').map(u => `
              <tr style="border-top:1px solid var(--border)" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''">
                <td style="padding:10px 16px">
                  <div style="font-weight:600;font-size:13px">${esc(u.username)}</div>
                  <div style="font-size:11px;color:var(--text3)">${esc(u.email)}</div>
                </td>
                <td style="padding:8px 12px;text-align:center;min-width:80px">
                  ${bar(u.usage.servers, u.quota.max_servers)}
                </td>
                <td style="padding:8px 12px;text-align:center;min-width:90px">
                  ${bar(Math.round(u.usage.ram_mb/1024*10)/10, Math.round(u.quota.max_ram_mb/1024*10)/10)}
                  <div style="font-size:9px;color:var(--text3)">GB</div>
                </td>
                <td style="padding:8px 12px;text-align:center;min-width:80px">
                  ${bar(u.usage.cpu_cores, u.quota.max_cpu_cores, 'var(--warn)')}
                  <div style="font-size:9px;color:var(--text3)">Kerne</div>
                </td>
                <td style="padding:8px 12px;text-align:center;min-width:90px">
                  ${bar(Math.round(u.usage.disk_mb/1024), Math.round(u.quota.max_disk_mb/1024), 'var(--accent3)')}
                  <div style="font-size:9px;color:var(--text3)">GB</div>
                </td>
                <td style="padding:8px 12px;text-align:center;min-width:60px">
                  ${bar(u.usage.dbs, u.quota.max_dbs, '#a78bfa')}
                </td>
                <td style="padding:8px 12px;text-align:right">
                  <button class="btn btn-ghost btn-sm" onclick="editQuota('${u.id}','${esc(u.username)}')">
                    <i data-lucide="pencil"></i>
                  </button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${users.filter(u=>u.role!=='admin').length===0
          ? '<div class="empty" style="padding:32px"><p>Keine regulären Benutzer</p></div>'
          : ''}
      </div>
    </div>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function editQuota(userId, username) {
  const data = await API.get(`/admin/quotas/${userId}`).catch(() => null);
  if (!data) { toast('Quota nicht geladen', 'error'); return; }
  const q = data.quota;
  const u = data.usage;

  showModal(`
    <div class="modal-title">
      <span><i data-lucide="gauge"></i> Quota: ${esc(username)}</span>
      <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
    </div>
    <div class="info-msg" style="margin-bottom:14px;font-size:12px">
      Aktuell: ${u.servers} Server · ${Math.round(u.ram_mb/1024*10)/10} GB RAM · ${u.cpu_cores} CPU · ${Math.round(u.disk_mb/1024)} GB Disk · ${u.dbs} DBs
    </div>
    <div class="grid grid-2" style="gap:10px;margin-bottom:12px">
      ${[
        ['q-servers',   'Max. Server',      q.max_servers,   1, 100,  1],
        ['q-ram',       'Max. RAM (GB)',     Math.round(q.max_ram_mb/1024), 1, 512, 1],
        ['q-cpu',       'Max. CPU Kerne',    q.max_cpu_cores, 1, 64,   0.5],
        ['q-disk',      'Max. Disk (GB)',    Math.round(q.max_disk_mb/1024), 1, 2048, 1],
        ['q-dbs',       'Max. Datenbanken',  q.max_dbs,       0, 100,  1],
        ['q-backups',   'Max. Backups',      q.max_backups,   0, 200,  1],
      ].map(([id, label, val, min, max, step]) => `
        <div class="form-group">
          <label class="form-label">${label}</label>
          <input id="${id}" class="form-input" type="number" min="${min}" max="${max}" step="${step}" value="${val}"/>
        </div>`).join('')}
    </div>
    <div class="form-group">
      <label class="form-label">Notiz</label>
      <input id="q-note" class="form-input" value="${esc(q.note||'')}" placeholder="optional"/>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost btn-sm text-danger" onclick="resetQuota('${userId}','${esc(username)}')">Zurücksetzen</button>
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="saveQuota('${userId}')"><i data-lucide="save"></i> Speichern</button>
    </div>`, true);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function saveQuota(userId) {
  const ramGb  = parseFloat(document.getElementById('q-ram')?.value)   || 8;
  const diskGb = parseFloat(document.getElementById('q-disk')?.value)  || 50;
  try {
    await API.put(`/admin/quotas/${userId}`, {
      max_servers:   parseInt(document.getElementById('q-servers')?.value)  || 10,
      max_ram_mb:    Math.round(ramGb * 1024),
      max_cpu_cores: parseFloat(document.getElementById('q-cpu')?.value)    || 8,
      max_disk_mb:   Math.round(diskGb * 1024),
      max_dbs:       parseInt(document.getElementById('q-dbs')?.value)      || 5,
      max_backups:   parseInt(document.getElementById('q-backups')?.value)  || 10,
      note:          document.getElementById('q-note')?.value || '',
    });
    toast('Quota gespeichert', 'success');
    closeModal();
    loadAdminQuotas();
  } catch(e) { toast(e.message, 'error'); }
}

async function resetQuota(userId, username) {
  if (!confirm(`Quota für "${username}" auf Standard-Werte zurücksetzen?`)) return;
  try {
    await API.delete(`/admin/quotas/${userId}`);
    toast('Quota zurückgesetzt', 'success');
    closeModal();
    loadAdminQuotas();
  } catch(e) { toast(e.message, 'error'); }
}

