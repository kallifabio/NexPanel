/* NexPanel — nav.js
 * App init, navigation, area switcher (Client / Admin)
 */

// ─── INIT ─────────────────────────────────────────────────────────────────────

// ─── Docker-Status-Banner ─────────────────────────────────────────────────────
async function checkDockerStatus() {
  try {
    const status = await API.get('/system/docker-status').catch(() => null);
    if (!status) return;
    if (!status.local_docker) {
      showDockerWarning();
    }
  } catch (_) {}
}

function showDockerWarning() {
  // Don't show twice
  if (document.getElementById('docker-warning-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'docker-warning-banner';
  banner.style.cssText = `
    position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
    background: var(--card2); border: 1px solid var(--warn);
    border-radius: 10px; padding: 12px 18px; z-index: 9000;
    display: flex; align-items: center; gap: 12px; max-width: 520px;
    box-shadow: 0 4px 20px rgba(0,0,0,.4); font-size: 13px;`;
  banner.innerHTML = `
    <i data-lucide="alert-triangle" style="width:18px;height:18px;color:var(--warn);flex-shrink:0"></i>
    <div style="flex:1">
      <strong style="color:var(--warn)">Docker nicht erreichbar</strong><br>
      <span style="font-size:12px;color:var(--text2)">
        Docker Desktop starten oder <code style="background:var(--bg3);padding:1px 5px;border-radius:4px">DOCKER_SOCKET</code> in .env prüfen.
        Server-Status kann veraltet sein.
      </span>
    </div>
    <button onclick="this.closest('#docker-warning-banner').remove()"
      style="background:none;border:none;cursor:pointer;color:var(--text3);padding:4px;flex-shrink:0">
      <i data-lucide="x" style="width:14px;height:14px"></i>
    </button>`;
  document.body.appendChild(banner);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function initApp() {
  // Check Docker availability (non-blocking, just shows a banner if unavailable)
  checkDockerStatus();
  try {
    if (!State.user) State.user = await API.get('/auth/me');
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('sidebar-name').textContent = State.user.username;
    document.getElementById('sidebar-role').textContent = State.user.role;
    document.getElementById('sidebar-avatar').textContent = State.user.username[0].toUpperCase();
    if (State.user.role === 'admin') {
      document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
    }
    // Restore last area preference
    const savedArea = localStorage.getItem('nex_area') || 'client';
    switchArea(savedArea, true);
    connectWS();
    navigate('dashboard');
    loadServerCount();
  } catch { logout(); }
}
async function loadServerCount() {
  try { const s = await API.get('/servers'); document.getElementById('server-count-badge').textContent = s.length; } catch {}
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────
function navigate(page, data) {
  State.currentPage = page; State.serverDetail = data || null;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  // Auto-switch area based on page
  if (State.user?.role === 'admin') {
    const adminPages = ['admin-nodes','admin-eggs','admin-allocations','admin-users','admin-audit','admin-docker','admin-node-resources','admin-scaling','admin-oauth','admin-prometheus','admin-status-page','admin-db-hosts','admin-quotas'];
    const targetArea = adminPages.includes(page) ? 'admin' : 'client';
    if (targetArea !== (State.currentArea || 'client')) switchArea(targetArea, true);
  }
  const titles = { dashboard:'Dashboard', servers:'Server', 'server-detail':'Server Detail', 'admin-nodes':'Nodes', 'admin-eggs':'Eggs / Templates', 'admin-allocations':'Port Allocations', 'admin-users':'Benutzerverwaltung', 'admin-audit':'Audit Log', 'admin-docker':'Docker Images', 'api-keys':'API Keys', settings:'Einstellungen', sessions:'Aktive Sessions', groups:'Server-Gruppen', webhooks:'Webhooks', 'admin-node-resources':'Node Ressourcen', 'admin-status-page':'Status-Page Verwaltung', 'admin-scaling':'Auto-Scaling', 'admin-oauth':'OAuth / Social Login', 'admin-prometheus':'Prometheus Metrics', 'admin-db-hosts':'Datenbank-Hosts', broadcasts:'Ankündigung & Broadcast', 'admin-quotas':'User-Quotas' };
  document.getElementById('page-title').textContent = titles[page] || page;
  document.getElementById('page-meta').innerHTML = '';
  document.getElementById('page-actions').innerHTML = '';
  if (window.lucide) lucide.createIcons();
  document.getElementById('page-content').innerHTML = '<div class="empty"><div class="empty-icon spin"><i data-lucide="loader"></i></div><p>Lädt...</p></div>';
  if (window.lucide) setTimeout(() => lucide.createIcons(), 0);
  const pages = { dashboard:loadDashboard, servers:loadServers, 'server-detail':loadServerDetail, 'admin-nodes':loadAdminNodes, 'admin-eggs':loadAdminEggs, 'admin-allocations':loadAdminAllocations, 'admin-users':loadAdminUsers, 'admin-audit':loadAuditLog, 'admin-docker':loadDockerImages, 'api-keys':loadApiKeys, settings:loadSettings, sessions:loadSessions, groups:loadGroups, webhooks:loadWebhooks, 'admin-node-resources':loadNodeResources, 'admin-status-page':loadAdminStatusPage, 'admin-scaling':loadAdminScaling, 'admin-oauth':loadAdminOAuth, 'admin-prometheus':loadAdminPrometheus, broadcasts:loadBroadcasts, 'admin-db-hosts':loadAdminDbHosts, 'admin-quotas':loadAdminQuotas };
  if (pages[page]) pages[page](data);
}

// ─── BOOTSTRAP ───────────────────────────────────────────────────────────────
// Runs after all functions are defined across all JS files via DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  if (State.token) initApp();
  else             initOAuthButtons();
});
