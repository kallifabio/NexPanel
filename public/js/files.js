/* NexPanel — files.js
 * File manager — list, read, write, upload
 */

// ─── FILE MANAGER ─────────────────────────────────────────────────────────────
State.fmPath = '/home/container';

async function fmLoad(serverId, path) {
  const el = document.getElementById('fm-content'); if (!el) return;
  const pathEl = document.getElementById('fm-path');
  if (pathEl) {
    const _root = ((State.server?.image||'').includes('itzg') || (State.server?.image||'').includes('minecraft-server')) ? '/data' : '/home/container';
    if (path === _root) {
      pathEl.textContent = '/';
    } else if (path.startsWith(_root + '/')) {
      pathEl.textContent = path.slice(_root.length); // z.B. /plugins statt /data/plugins
    } else {
      pathEl.textContent = path;
    }
  }
  el.innerHTML = '<div class="empty" style="padding:24px"><div class="empty-icon spin"><i data-lucide="folder"></i></div></div>';
  try {
    const files = await API.get(`/servers/${serverId}/files/list?path=${encodeURIComponent(path)}`);
    if (!document.getElementById('fm-content')) return; // navigated away
    el.innerHTML = fmRenderTable(files, serverId, path);
  } catch (e) {
    const msg = e.message || '';
    const isNotReady = msg.includes('nicht bereit') || msg.includes('Container') || msg.includes('400');
    el.innerHTML = `<div class="empty" style="padding:32px">
      <div class="empty-icon">${isNotReady ? '<i data-lucide="loader"></i>' : '<i data-lucide="x-circle"></i>'}</div>
      <p>${isNotReady ? 'Container ist noch nicht bereit — Server zuerst starten' : esc(msg)}</p>
      ${isNotReady ? '' : `<button class="btn btn-ghost btn-sm" style="margin-top:12px" onclick="fmLoad('${serverId}','${path}')">↺ Erneut versuchen</button>`}
    </div>`;
  }
}

function fmRenderTable(files, serverId, path) {
  if (!files.length) return '<div class="empty" style="padding:24px"><div class="empty-icon"><i data-lucide="folder-open"></i></div><p>Verzeichnis ist leer</p></div>';
  const sorted = [...files].sort((a,b) => {
    if (a.type==='directory' && b.type!=='directory') return -1;
    if (a.type!=='directory' && b.type==='directory') return 1;
    return a.name.localeCompare(b.name);
  });
  return `<table class="fm-table">
    <thead><tr><th>Name</th><th>Größe</th><th>Geändert</th><th style="width:80px"></th></tr></thead>
    <tbody>
      ${(() => {
    const _srvRoot = ((State.server?.image||'').includes('itzg') || (State.server?.image||'').includes('minecraft-server')) ? '/data' : '/home/container';
    return path !== _srvRoot ? `<tr onclick="fmNavigateUp()" style="cursor:pointer"><td colspan="4"><span class="fm-icon"><i data-lucide="arrow-up"></i></span><span class="fm-name dir">..</span></td></tr>` : '';
  })()}
      ${sorted.map(f => {
        const icon = f.type==='directory'?'<i data-lucide="folder"></i>':f.name.endsWith('.yml')||f.name.endsWith('.yaml')?'<i data-lucide="settings"></i>':f.name.endsWith('.json')?'<i data-lucide="clipboard-list"></i>':f.name.endsWith('.log')?'<i data-lucide="file-code"></i>':f.name.endsWith('.sh')?'<i data-lucide="zap"></i>':'<i data-lucide="file-text"></i>';
        const isDir = f.type==='directory';
        const click = isDir
          ? `fmNavigate('${serverId}','${(path.endsWith('/')?path:path+'/').replace(/\/\//g,'/')}${f.name}')`
          : `fmOpenFile('${serverId}','${(path.endsWith('/')?path:path+'/').replace(/\/\//g,'/')}${f.name}')`;
        return `<tr>
          <td onclick="${click}"><span class="fm-icon">${icon}</span><span class="fm-name ${isDir?'dir':''}">${esc(f.name)}</span></td>
          <td class="fm-size">${isDir?'–':fmtBytes(f.size)}</td>
          <td class="fm-date">${f.modified||'–'}</td>
          <td><div class="fm-actions">
            ${!isDir?`<button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();fmOpenFile('${serverId}','${(path.endsWith('/')?path:path+'/').replace(/\/\//g,'/')}${f.name}')"><i data-lucide="pencil"></i></button>`:''}
            <button class="btn btn-ghost btn-xs text-danger" onclick="event.stopPropagation();fmDelete('${serverId}','${(path.endsWith('/')?path:path+'/').replace(/\/\//g,'/')}${f.name}','${f.type}')"><i data-lucide="trash-2"></i></button>
          </div></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

function fmNavigate(serverId, newPath) {
  State.fmPath = newPath.replace(/\/\//g, '/');
  const pathEl = document.getElementById('fm-path'); if (pathEl) pathEl.textContent = State.fmPath;
  fmLoad(serverId, State.fmPath);
}

function fmNavigateUp() {
  if (!State.serverDetail) return;
  // Root für diesen Server ermitteln
  const srvRoot = ((State.server?.image||'').includes('itzg') || (State.server?.image||'').includes('minecraft-server'))
    ? '/data' : '/home/container';
  // Nicht über das Server-Root hinaus navigieren
  if (State.fmPath === srvRoot || State.fmPath === '/') return;
  const parts = State.fmPath.split('/').filter(Boolean);
  parts.pop();
  const newPath = '/' + parts.join('/');
  State.fmPath = newPath.length <= srvRoot.length ? srvRoot : newPath;
  fmLoad(State.serverDetail, State.fmPath);
}

function fmRefresh() { if (State.serverDetail) fmLoad(State.serverDetail, State.fmPath); }

async function fmOpenFile(serverId, filePath) {
  try {
    const data = await API.get(`/servers/${serverId}/files/read?path=${encodeURIComponent(filePath)}`);
    showModal(`
      <div class="modal-title">
        <span><i data-lucide="pencil"></i> ${esc(filePath.split('/').pop())}</span>
        <button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button>
      </div>
      <div class="form-group">
        <label class="form-label text-mono" style="color:var(--text3)">${esc(filePath)}</label>
        <textarea id="fm-edit-content" class="form-input" style="height:360px;font-family:var(--mono);font-size:12px;line-height:1.6">${esc(data.content)}</textarea>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="fmSaveFile('${serverId}','${filePath}')"><i data-lucide="save"></i> Speichern</button>
      </div>`, true);
  } catch (e) { toast('Fehler: '+e.message,'error'); }
}

async function fmSaveFile(serverId, filePath) {
  const content = document.getElementById('fm-edit-content')?.value;
  if (content === undefined) return;
  try {
    await API.post(`/servers/${serverId}/files/write`, { path: filePath, content });
    toast('Gespeichert!', 'success'); closeModal();
  } catch (e) { toast('Fehler: '+e.message,'error'); }
}

async function fmCreateFile() {
  if (!State.serverDetail) return;
  const name = prompt('Dateiname:'); if (!name) return;
  const path = (State.fmPath.endsWith('/')?State.fmPath:State.fmPath+'/') + name;
  try {
    await API.post(`/servers/${State.serverDetail}/files/create`, { path, type: 'file' });
    toast('Datei erstellt', 'success'); fmRefresh();
  } catch (e) { toast('Fehler: '+e.message,'error'); }
}

async function fmCreateDir() {
  if (!State.serverDetail) return;
  const name = prompt('Ordnername:'); if (!name) return;
  const path = (State.fmPath.endsWith('/')?State.fmPath:State.fmPath+'/') + name;
  try {
    await API.post(`/servers/${State.serverDetail}/files/create`, { path, type: 'directory' });
    toast('Ordner erstellt', 'success'); fmRefresh();
  } catch (e) { toast('Fehler: '+e.message,'error'); }
}

async function fmDelete(serverId, path, type) {
  if (!confirm(`${type==='directory'?'Ordner':'Datei'} "${path.split('/').pop()}" wirklich löschen?`)) return;
  try {
    await API.delete(`/servers/${serverId}/files/delete`, { path });
    toast('Gelöscht', 'success'); fmLoad(serverId, State.fmPath);
  } catch (e) { toast('Fehler: '+e.message,'error'); }
}
