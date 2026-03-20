/* NexPanel — dashboard.js
 * Dashboard page
 */

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
async function loadDashboard() {
  const [servers, adminStats] = await Promise.all([
    API.get('/servers').catch(() => []),
    State.user.role === 'admin' ? API.get('/admin/stats').catch(() => null) : Promise.resolve(null),
  ]);
  const running = servers.filter(s => s.status === 'running').length;

  let nodesHtml = '';
  if (adminStats?.nodes_detail?.length) {
    nodesHtml = `
      <div class="card mt-16">
        <div class="card-header"><div class="card-title"><i data-lucide="globe"></i> Node-Status</div><button class="btn btn-ghost btn-sm" onclick="navigate('admin-nodes')">Verwalten →</button></div>
        <div class="grid grid-${Math.min(adminStats.nodes_detail.length,3)}">
          ${adminStats.nodes_detail.map(n => nodeCardSmall(n)).join('')}
        </div>
      </div>`;
  }

  let dockerHtml = '';
  if (adminStats?.docker && !adminStats.docker.note) {
    const d = adminStats.docker;
    dockerHtml = `
      <div class="card mt-16">
        <div class="card-header"><div class="card-title"><i data-lucide="box"></i> Lokaler Docker</div><span class="chip ${d.mock?'chip-offline':'chip-online'}">${d.mock?'Mock':'● Online'}</span></div>
        <div class="grid grid-4">
          <div><div class="text-dim text-sm">Version</div><div class="text-mono mt-8">${d.docker_version||d.version||'N/A'}</div></div>
          <div><div class="text-dim text-sm">OS</div><div class="mt-8">${d.os||'N/A'}</div></div>
          <div><div class="text-dim text-sm">CPUs</div><div class="text-mono mt-8">${d.cpus||'N/A'}</div></div>
          <div><div class="text-dim text-sm">RAM</div><div class="text-mono mt-8">${d.memory_total ? fmtBytes(d.memory_total) : 'N/A'}</div></div>
        </div>
      </div>`;
  }

  document.getElementById('page-content').innerHTML = `
    <div id="quota-widget"></div>
    <div class="grid grid-4">
      <div class="stat-card"><div class="stat-icon"><i data-lucide="server"></i></div><div class="stat-value">${servers.length}</div><div class="stat-label">Server gesamt</div><div class="stat-sub">${running} laufen</div></div>
      <div class="stat-card"><div class="stat-icon"><i data-lucide="check-circle"></i></div><div class="stat-value" style="color:var(--success)">${running}</div><div class="stat-label">Laufend</div><div class="stat-sub">${servers.length-running} offline</div></div>
      ${adminStats ? `
        <div class="stat-card"><div class="stat-icon"><i data-lucide="globe"></i></div><div class="stat-value">${adminStats.nodes_online}/${adminStats.nodes}</div><div class="stat-label">Nodes online</div><div class="stat-sub">Multi-Node</div></div>
        <div class="stat-card"><div class="stat-icon"><i data-lucide="users"></i></div><div class="stat-value">${adminStats.users}</div><div class="stat-label">Benutzer</div><div class="stat-sub">${adminStats.suspended} gesperrt</div></div>
      ` : `
        <div class="stat-card"><div class="stat-icon"><i data-lucide="moon"></i></div><div class="stat-value">${servers.length-running}</div><div class="stat-label">Offline</div></div>
        <div class="stat-card"><div class="stat-icon"><i data-lucide="user"></i></div><div class="stat-value" style="color:var(--accent);font-size:16px">${State.user.role}</div><div class="stat-label">Deine Rolle</div><div class="stat-sub">${State.user.email}</div></div>
      `}
    </div>
    ${nodesHtml}
    ${dockerHtml}
    <div class="card mt-16">
      <div class="card-header"><div class="card-title">Aktuelle Server</div><button class="btn btn-ghost btn-sm" onclick="navigate('servers')">Alle →</button></div>
      ${servers.length === 0 ? '<div class="empty" style="padding:24px"><p>Noch keine Server</p></div>' :
        `<div style="display:flex;flex-direction:column;gap:8px">${servers.slice(0,6).map(s => serverItemHtml(s, true)).join('')}</div>`}
    </div>`;
}

function nodeCardSmall(n) {
  const on = n.connected;
  const si = n.system_info || {};
  return `
    <div class="node-card ${on ? (n.is_local ? 'local' : 'online') : 'offline'}">
      <div class="node-header">
        <div><div class="node-name">${esc(n.name)}</div><div class="node-fqdn">${esc(n.fqdn)}</div></div>
        <span class="chip ${on ? (n.is_local ? 'chip-local' : 'chip-online') : 'chip-offline'}">${n.is_local ? '<i data-lucide="zap"></i> Lokal' : on ? '● Online' : '○ Offline'}</span>
      </div>
      ${on && si.cpus ? `<div class="node-stats-row">
        <div class="node-stat"><div class="node-stat-val">${si.cpus}</div><div class="node-stat-lbl">CPUs</div></div>
        <div class="node-stat"><div class="node-stat-val">${si.memory_total ? fmtBytes(si.memory_total) : '?'}</div><div class="node-stat-lbl">RAM</div></div>
        <div class="node-stat"><div class="node-stat-val">${n.server_count||0}</div><div class="node-stat-lbl">Server</div></div>
      </div>` : `<div class="text-dim text-sm mt-8">${n.server_count||0} Server · ${esc(n.location)}</div>`}
    </div>`;
}
