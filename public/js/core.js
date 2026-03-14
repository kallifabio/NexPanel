/* NexPanel — core.js
 * State, API client, utilities, keyboard shortcuts, app bootstrap
 */

// ─── STATE ────────────────────────────────────────────────────────────────────
const State = {
  token:       localStorage.getItem('hp_token') || null,
  user:        null,
  currentPage: 'dashboard',
  serverDetail: null,
  wsConn:      null,
  nodes:       {},   // nodeId → node-info
};

// ─── API ─────────────────────────────────────────────────────────────────────
const API = {
  async req(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (State.token) opts.headers['Authorization'] = `Bearer ${State.token}`;
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res  = await fetch('/api' + path, opts);
    const data = await res.json();
    if (!res.ok) {
      const msg = data.error || `HTTP ${res.status}`;
      if (msg.startsWith('SUSPENDED:')) { showSuspensionScreen(msg.slice(10)); throw new Error(msg); }
      throw new Error(msg);
    }
    return data;
  },
  get:    p     => API.req('GET', p),
  post:   (p,b) => API.req('POST', p, b),
  put:    (p,b) => API.req('PUT', p, b),
  patch:  (p,b) => API.req('PATCH', p, b),
  delete: (p,b) => API.req('DELETE', p, b),
};

// ─── API KEYS ────────────────────────────────────────────────────────────────
async function loadApiKeys() {
  document.getElementById('page-actions').innerHTML = `<button class="btn btn-primary" onclick="showCreateApiKey()"><i data-lucide="plus"></i> Neuer API Key</button>`;
  const keys = await API.get('/account/api-keys').catch(() => []);
  document.getElementById('page-content').innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-title" style="margin-bottom:8px">API verwenden</div>
      <p class="text-muted text-sm">Header: <code style="background:var(--bg);padding:2px 6px;border-radius:4px;font-family:var(--mono);color:var(--accent)">Authorization: Bearer hpk_...</code></p>
      <p class="text-muted text-sm" style="margin-top:4px">Basis-URL: <code style="background:var(--bg);padding:2px 6px;border-radius:4px;font-family:var(--mono);color:var(--accent)">${location.origin}/api</code></p>
    </div>
    <div class="card">
      ${keys.length===0 ? '<div class="empty" style="padding:24px"><p>Noch keine API Keys</p></div>' : `
      <table class="table"><thead><tr><th>Name</th><th>Prefix</th><th>Zuletzt benutzt</th><th>Erstellt</th><th></th></tr></thead>
      <tbody>${keys.map(k=>`<tr><td><strong>${esc(k.name)}</strong></td><td class="text-mono text-accent">${esc(k.key_prefix)}…</td><td class="text-dim text-sm">${k.last_used_at?new Date(k.last_used_at).toLocaleString('de-DE'):'Nie'}</td><td class="text-dim text-sm">${new Date(k.created_at).toLocaleDateString('de-DE')}</td><td><button class="btn btn-ghost btn-sm text-danger" onclick="deleteApiKey('${k.id}','${esc(k.name)}')">Widerrufen</button></td></tr>`).join('')}</tbody></table>`}
    </div>`;
}
function showCreateApiKey() {
  showModal(`
    <div class="modal-title"><span><i data-lucide="key"></i> Neuer API Key</span><button class="modal-close" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="form-group"><label class="form-label">Name</label><input type="text" id="m-kname" class="form-input" placeholder="Meine Anwendung"/></div>
    <div id="m-new-key" class="success-msg hidden"></div>
    <div id="m-error" class="error-msg hidden"></div>
    <div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button><button class="btn btn-primary" onclick="submitCreateApiKey()">Generieren</button></div>`);
}
async function submitCreateApiKey() {
  const name = document.getElementById('m-kname').value.trim(); if (!name) return;
  try {
    const d = await API.post('/account/api-keys', { name });
    document.getElementById('m-new-key').innerHTML = `<strong>Key erstellt! Sofort kopieren:</strong><div class="code-box" style="margin-top:8px">${esc(d.key)}</div>`;
    document.getElementById('m-new-key').classList.remove('hidden');
    document.querySelector('.modal-footer .btn-primary').textContent = 'Fertig';
    document.querySelector('.modal-footer .btn-primary').onclick = () => { closeModal(); loadApiKeys(); };
  } catch (e) { document.getElementById('m-error').textContent=e.message; document.getElementById('m-error').classList.remove('hidden'); }
}
async function deleteApiKey(id, name) {
  if (!confirm(`API Key "${name}" widerrufen?`)) return;
  try { await API.delete(`/account/api-keys/${id}`); toast('Key widerrufen','success'); loadApiKeys(); } catch (e) { toast(e.message,'error'); }
}

// ─── UTILS ───────────────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (!b || b===0) return '0 B';
  const k=1024, s=['B','KB','MB','GB','TB'], i=Math.floor(Math.log(b)/Math.log(k));
  return (b/k**i).toFixed(1)+' '+s[i];
}
function esc(s) {
  if (s==null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}
function toast(msg, type='info') {
  const el = document.createElement('div');
  const icons = {success:'<i data-lucide="check-circle"></i>',error:'<i data-lucide="x-circle"></i>',info:'<i data-lucide="info"></i>',warn:'<i data-lucide="alert-triangle"></i>'};
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]||'•'}</span><span>${esc(msg)}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => { el.style.animation='slideOut .25s forwards'; setTimeout(()=>el.remove(),250); }, 3500);
}
function showModal(html, large=false) {
  document.getElementById('modal-container').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal${large?' modal-lg':''}">${html}</div></div>`;
}
function closeModal() { document.getElementById('modal-container').innerHTML = ''; }
function mErr(m) { const el=document.getElementById('m-error'); if(el){el.textContent=m;el.classList.remove('hidden');}else toast(m,'error'); }
// Helper für Text-Klassen inline
function text_danger(el) { el.style.color='var(--danger)'; }

// Keyboard shortcuts for auth moved to auth.js

// Bootstrap moved to nav.js (runs after initApp is defined)

// ═══════════════════════════════════════════════════════════════════════════════
