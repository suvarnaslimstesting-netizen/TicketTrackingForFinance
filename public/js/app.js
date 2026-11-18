import { state, api, can, esc, icon, initials, toast, modal, formValues, showFormError, busy, clearTips, loadLookups } from './core.js';
import { renderDashboard } from './views/dashboard.js';
import { renderApprovals, openApprovalForm } from './views/approvals.js';
import { renderDepartments, renderRoles, renderUsers, renderClients, renderCompany } from './views/admin.js';
import { renderBilling } from './views/billing.js';
import {
  renderImplDashboard, renderMyDay, renderImplClients, renderTaskApprovals, renderImplReports, renderImplMasters, renderSalesOrders, entityPage, resetImplCache, renderEmployees,
} from './views/impl.js';
import { renderAttendance, renderTeamAttendance, renderAttendanceSettings, startLocationPings, stopLocationPings } from './views/attendance.js';

/* ------------------------------ Modules ------------------------------ */
// The user picks Ticket Tracking or Implementation at sign-in; only that side's menus are shown.
const MODULES = {
  tracking: { label: 'Ticket Tracking', full: 'Ticket Tracking For Finance', icon: 'ticket' },
  impl: { label: 'Implementation', full: 'HIMS Implementation', icon: 'trend' },
};
const TRACKING_PERMS = ['dashboard.view', 'approval.view', 'billing.view', 'audit.view', 'department.manage', 'role.manage', 'user.manage', 'client.manage', 'company.manage'];
const hasModule = (m) => (m === 'impl'
  ? can('impl.view') || can('attendance.view') || can('attendance.config') || !!(state.user && state.user.face_attendance)
  : TRACKING_PERMS.some((p) => can(p)));
const store = {
  get: () => { try { return localStorage.getItem('ttf.module'); } catch { return null; } },
  set: (v) => { try { localStorage.setItem('ttf.module', v); } catch { /* ignore */ } },
};
const hasModuleFor = (user, m) => {
  const prev = state.user;
  state.user = user;
  try { return hasModule(m); } finally { state.user = prev; }
};
let currentModule = store.get() === 'impl' ? 'impl' : 'tracking';
import { renderAudit } from './views/audit.js';
import { renderPasswords } from './views/passwords.js';

const app = document.getElementById('app');

const ROUTES = [
  { mod: 'tracking', path: 'dashboard', label: 'Dashboard', icon: 'dashboard', perm: 'dashboard.view', group: 'Overview', render: renderDashboard },
  { mod: 'tracking', path: 'approvals', label: 'Man-Day Approvals', icon: 'ticket', perm: 'approval.view', group: 'Overview', render: renderApprovals },
  { mod: 'tracking', path: 'billing', label: 'Quotation & Billing', icon: 'invoice', perm: 'billing.view', group: 'Billing', render: renderBilling },
  // Attendance (first on the Implementation side; every Implementation user sees Face Attendance)
  { path: 'attendance', label: 'Face Attendance', icon: 'face', show: () => true, group: 'Attendance', render: renderAttendance },
  { path: 'team-attendance', label: 'Team Attendance', icon: 'map', perm: 'attendance.view', group: 'Attendance', render: renderTeamAttendance },
  { path: 'attendance-settings', label: 'Attendance Settings', icon: 'settings', perm: 'attendance.config', group: 'Attendance', render: renderAttendanceSettings },
  // Implementation
  { path: 'myday', label: 'My Day', icon: 'sun', perm: 'impl.work', show: () => can('impl.work') && !can('impl.view_all'), group: 'Implementation', render: renderMyDay },
  { path: 'impl', label: 'Implementation Dashboard', icon: 'trend', perm: 'impl.view', group: 'Implementation', render: renderImplDashboard },
  { path: 'impl-clients', label: 'Clients 360', icon: 'briefcase', perm: 'impl.view', group: 'Implementation', render: renderImplClients },
  { path: 'sales-orders', label: 'Sales Orders', icon: 'file', perm: 'impl.view', show: () => can('impl.view') && (can('impl.view_all') || can('salesorder.manage')), group: 'Implementation', render: renderSalesOrders },
  { path: 'assignments', label: 'Engineer Assignments', icon: 'users', perm: 'impl.view', group: 'Implementation', render: entityPage('assign', 'Engineer Assignments', 'Which engineer works at which client location, and when.') },
  { path: 'tasks', label: 'Module Tasks', icon: 'layers', perm: 'impl.view', group: 'Implementation', render: entityPage('tasks', 'Module Tasks', 'Tasks per client location and module. Completing a task needs evidence; it may need approval.') },
  { path: 'task-approvals', label: 'Task Approvals', icon: 'check', perm: 'task.approve', group: 'Implementation', render: renderTaskApprovals },
  { path: 'daily', label: 'Daily Status', icon: 'calendar', perm: 'impl.view', group: 'Implementation', render: entityPage('daily', 'Daily Status', 'Daily work report of each engineer.') },
  { path: 'visits', label: 'Visits & Communication', icon: 'pin', perm: 'impl.view', group: 'Implementation', render: entityPage('visits', 'Visits & Communication', 'Client visits and the communication log.', ['comms']) },
  { path: 'golive', label: 'Go-Live & Training', icon: 'flag', perm: 'impl.view', group: 'Implementation', render: entityPage('golive', 'Go-Live & Training', 'Go-live stages per location (UAT, Go-Live and Handover need a sign-off document) and the training log.', ['training']) },
  { path: 'issues', label: 'Issues & CRs', icon: 'bug', perm: 'impl.view', group: 'Implementation', render: entityPage('issues', 'Issues & Change Requests', 'Client issues, change requests and queries.') },
  { path: 'infra', label: 'Infra & Servers', icon: 'server', perm: 'impl.view', group: 'Implementation', render: entityPage('infra', 'Infra & Servers', 'Server requirements, credentials (encrypted), hardware readiness and IT contacts.', ['servers', 'hw', 'contacts']) },
  { path: 'templates', label: 'Templates', icon: 'file', perm: 'impl.view', group: 'Implementation', render: entityPage('templates', 'Template Library', 'Master-data, consent and report templates shared with clients.') },
  { path: 'amc', label: 'AMC', icon: 'shield', perm: 'impl.view', show: () => can('impl.view') && (can('impl.view_all') || can('amc.manage')), group: 'Implementation', render: entityPage('amc', 'AMC', 'Annual maintenance contracts and renewals.') },
  { path: 'impl-reports', label: 'Implementation Reports', icon: 'excel', perm: 'impl.view', group: 'Implementation', render: renderImplReports },
  { path: 'impl-employees', label: 'Implementation Employees', icon: 'users', perm: 'impl.users', group: 'Implementation', render: renderEmployees },
  { path: 'impl-masters', label: 'Implementation Masters', icon: 'settings', perm: 'impl.settings', show: () => can('impl.settings') || can('impl.manage'), group: 'Implementation', render: renderImplMasters },
  { mod: 'both', path: 'audit', label: 'Audit History', icon: 'history', perm: 'audit.view', group: 'Overview', render: renderAudit },
  { mod: 'both', path: 'departments', label: 'Departments', icon: 'building', perm: 'department.manage', group: 'Administration', render: renderDepartments },
  { mod: 'both', path: 'roles', label: 'Roles & Permissions', icon: 'shield', perm: 'role.manage', group: 'Administration', render: renderRoles },
  { mod: 'both', path: 'users', label: 'Users', icon: 'users', perm: 'user.manage', group: 'Administration', render: renderUsers },
  { mod: 'both', path: 'passwords', label: 'Reset Passwords', icon: 'key', show: () => can('user.manage') || can('impl.users'), group: 'Administration', render: renderPasswords },
  { mod: 'both', path: 'clients', label: 'Clients', icon: 'briefcase', perm: 'client.manage', group: 'Administration', render: renderClients },
  { mod: 'tracking', path: 'company', label: 'Company Settings', icon: 'settings', perm: 'company.manage', group: 'Administration', render: renderCompany },
];

let cleanup = null; // per-view teardown (timers etc.)

/* --------------------------------- Login -------------------------------- */

function renderLogin(message) {
  if (cleanup) { cleanup(); cleanup = null; }
  document.title = 'Sign in · Ticket Tracking For Finance';
  app.innerHTML = `
    <div class="login-wrap">
      <section class="login-hero">
        <div class="orb orb-1"></div><div class="orb orb-2"></div><div class="orb orb-3"></div>
        <div class="hero-copy">
          <span class="eyebrow">Man-Day Approval &amp; Ticket Management</span>
          <h1>Every approved man-day,<br><span class="grad-text">tracked in one place.</span></h1>
          <p>Implementation records the client's approval once. Finance and Product see it straight away, with a full audit trail.</p>
        </div>
        <div class="hero-preview" aria-hidden="true">
          <div class="glass glass-main">
            <div class="gm-head"><span>Approved man-days</span><span class="pill-up">▲ live</span></div>
            <div class="gm-value">128.5</div>
            <div class="gm-bars">${[38, 52, 44, 66, 58, 80, 72, 94].map((h) => `<i style="height:${h}%"></i>`).join('')}</div>
          </div>
          <div class="glass glass-ticket">
            <span class="gt-icon">${icon('ticket')}</span>
            <div><b>TKT-1025</b><small>Ruby Hall Clinic · 5 man-days</small></div>
            <span class="gt-ok">Approved</span>
          </div>
          <div class="glass glass-roles">
            <span class="av a1">IM</span><span class="av a2">FM</span><span class="av a3">PM</span>
            <small>Shared instantly</small>
          </div>
        </div>
        <small class="hero-foot">© ${new Date().getFullYear()} Suvarna Technosoft Pvt Ltd · Ticket Tracking For Finance</small>
      </section>
      <section class="login-panel">
        <form class="login-card" novalidate>
          <img class="login-brand" src="/img/suvarna-logo.png" alt="Suvarna Technosoft Pvt Ltd">
          <div class="mod-pick" role="radiogroup" aria-label="Sign in to">
            ${Object.entries(MODULES).map(([k, m]) => `<label class="mod-opt"><input type="radio" name="module" value="${k}" ${k === currentModule ? 'checked' : ''}><span>${icon(m.icon)}<b>${m.label}</b></span></label>`).join('')}
          </div>
          <h2>Welcome back</h2>
          <p class="sub">Sign in with the username and password from your administrator.</p>
          <div class="grid">
            ${message ? `<div class="alert info">${esc(message)}</div>` : ''}
            <div class="alert err" hidden data-err></div>
            <div class="field"><label for="u">Username</label>
              <div class="input-icon">${icon('user')}<input id="u" class="input" name="username" autocomplete="username" placeholder="Enter your username" required></div></div>
            <div class="field"><label for="p">Password</label>
              <div class="input-icon">${icon('lock')}<input id="p" class="input" type="password" name="password" autocomplete="current-password" placeholder="Enter your password" required>
                <button type="button" class="pw-toggle" aria-label="Show password" data-pw>${icon('eye')}</button></div></div>
            <button class="btn btn-primary btn-lg btn-block" type="submit">Sign in <span aria-hidden="true">→</span></button>
          </div>
          <div class="login-secure">${icon('shield')} Your access depends on your role. Every change is recorded.</div>
        </form>
      </section>
    </div>`;
  const form = app.querySelector('form');
  form.querySelector('#u').focus();
  const pw = form.querySelector('#p');
  form.querySelector('[data-pw]').addEventListener('click', (e) => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    e.currentTarget.classList.toggle('on', show);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    showFormError(form, null);
    busy(btn, true, 'Signing in…');
    try {
      const v = formValues(form);
      const { user } = await api('/auth/login', { method: 'POST', body: { username: v.username, password: v.password } });
      state.user = user;
      const picked = form.querySelector('input[name=module]:checked');
      const want = picked && picked.value === 'impl' ? 'impl' : 'tracking';
      if (!hasModule(want)) {
        const other = want === 'impl' ? 'tracking' : 'impl';
        await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
        state.user = null;
        throw new Error(`Your account does not have access to ${MODULES[want].label}.${hasModuleFor(user, other) ? ` Choose ${MODULES[other].label}.` : ''}`);
      }
      currentModule = want;
      store.set(want);
      await start();
    } catch (err) {
      showFormError(form, err);
      busy(btn, false);
    }
  });
}

/* ---------------------------- Change password --------------------------- */

function openChangePassword(forced = false) {
  const m = modal({
    title: forced ? 'Set a new password' : 'Change password',
    size: 'narrow',
    dismissible: !forced,
    body: `
      <form class="grid" novalidate>
        ${forced ? '<div class="alert info">For security, please replace the temporary password given to you before continuing.</div>' : ''}
        <div class="alert err" hidden data-err></div>
        <div class="field"><label>Current password <span class="req">*</span></label><input class="input" type="password" name="currentPassword" autocomplete="current-password"></div>
        <div class="field"><label>New password <span class="req">*</span></label><input class="input" type="password" name="newPassword" autocomplete="new-password"><span class="help">At least 8 characters, including a letter and a number.</span></div>
        <div class="field"><label>Confirm new password <span class="req">*</span></label><input class="input" type="password" name="confirm" autocomplete="new-password"></div>
      </form>`,
    footer: `${forced ? '<button class="btn" data-logout>Sign out</button>' : '<button class="btn" data-close>Cancel</button>'}<button class="btn btn-primary" data-save>Update password</button>`,
  });
  if (forced) m.$('[data-logout]').addEventListener('click', logout);
  const form = m.$('form');
  const submit = async () => {
    const v = formValues(form);
    if (v.newPassword !== v.confirm) return showFormError(form, new Error('New password and confirmation do not match.'));
    const btn = m.$('[data-save]');
    busy(btn, true);
    try {
      await api('/auth/change-password', { method: 'POST', body: v });
      state.user.must_change_password = false;
      m.close();
      toast('Password updated successfully.');
      if (forced) start();
    } catch (err) {
      showFormError(form, err);
      busy(btn, false);
    }
  };
  m.$('[data-save]').addEventListener('click', submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  form.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
  state.user = null;
  stopLocationPings();
  resetImplCache();
  document.getElementById('modal-root').innerHTML = '';
  location.hash = '';
  renderLogin('You have been signed out.');
}

/* --------------------------------- Shell -------------------------------- */

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function allowedRoutes() {
  return ROUTES.filter((r) => ((r.mod || 'impl') === currentModule || r.mod === 'both') && (r.show ? r.show() : can(r.perm)));
}

function renderShell() {
  const routes = allowedRoutes();
  const groups = [...new Set(routes.map((r) => r.group))];
  const u = state.user;
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="side-brand">
          <img src="/img/suvarna-logo.png" alt="Suvarna Technosoft Pvt Ltd">
          <div class="app-name">${icon(MODULES[currentModule].icon)} ${MODULES[currentModule].full}</div>
        </div>
        <nav class="nav">
          ${groups.map((g) => `<div class="nav-group">${esc(g)}</div>${routes.filter((r) => r.group === g).map((r) => `<a href="#/${r.path}" data-path="${r.path}">${icon(r.icon)}<span>${esc(r.label)}</span></a>`).join('')}`).join('')}
        </nav>
        <div class="sidebar-foot">${esc(u.department_name || '')} department</div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn menu-btn" aria-label="Open menu">${icon('menu')}</button>
          <div class="greet"><b>${greeting()}, ${esc(u.employee_name.split(' ')[0])}</b><span>${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span></div>
          <div class="spacer"></div>
          ${hasModule(currentModule === 'impl' ? 'tracking' : 'impl') ? `<button class="btn btn-ghost mod-switch" data-switch>${icon(MODULES[currentModule === 'impl' ? 'tracking' : 'impl'].icon)} Switch to ${MODULES[currentModule === 'impl' ? 'tracking' : 'impl'].label}</button>` : ''}
          ${currentModule === 'tracking' && can('approval.add') ? `<button class="btn btn-primary" data-new>${icon('plus')} New Approval</button>` : ''}
          <button class="user-chip" aria-haspopup="menu"><span class="avatar">${esc(initials(u.employee_name))}</span><span class="meta"><b>${esc(u.employee_name)}</b><span>${esc(u.role_name)}</span></span></button>
        </header>
        <main class="content" id="view"></main>
      </div>
    </div>`;

  const shell = app.querySelector('.shell');
  app.querySelector('.menu-btn').addEventListener('click', () => shell.classList.toggle('nav-open'));
  app.querySelector('.nav').addEventListener('click', () => shell.classList.remove('nav-open'));
  app.querySelector('[data-switch]')?.addEventListener('click', () => {
    currentModule = currentModule === 'impl' ? 'tracking' : 'impl';
    store.set(currentModule);
    history.replaceState(null, '', '#/');
    renderShell();
    route();
  });
  const newBtn = app.querySelector('[data-new]');
  if (newBtn) newBtn.addEventListener('click', () => openApprovalForm({ onSaved: () => { if (location.hash !== '#/approvals') location.hash = '#/approvals'; else route(); } }));

  const chip = app.querySelector('.user-chip');
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = app.querySelector('.menu');
    if (existing) return existing.remove();
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <div style="padding:8px 12px 10px;border-bottom:1px solid var(--border);margin-bottom:4px">
        <b>${esc(u.employee_name)}</b><div style="font-size:12px;color:var(--muted)">${esc(u.username)} · ${esc(u.employee_code)}</div>
        <div style="font-size:12px;color:var(--muted)">${esc(u.role_name)} · ${esc(u.department_name || '')}</div>
      </div>
      <button data-pwd>Change password</button><button data-out>Sign out</button>`;
    app.querySelector('.topbar').appendChild(menu);
    menu.querySelector('[data-pwd]').addEventListener('click', () => { menu.remove(); openChangePassword(false); });
    menu.querySelector('[data-out]').addEventListener('click', logout);
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', off); } }));
  });
}

async function route() {
  if (!state.user) return;
  clearTips();
  if (cleanup) { cleanup(); cleanup = null; }
  const routes = allowedRoutes();
  const path = (location.hash.replace(/^#\/?/, '') || '').split('?')[0];
  const r = routes.find((x) => x.path === path) || routes[0];
  if (!r) {
    document.getElementById('view').innerHTML = '<div class="card empty"><b>No modules assigned</b>Your role has no permissions yet. Please contact the administrator.</div>';
    return;
  }
  if (r.path !== path) { history.replaceState(null, '', `#/${r.path}`); }
  app.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.path === r.path));
  document.title = `${r.label} · ${MODULES[currentModule].full}`;
  // Each screen renders into its own container, so a slow screen that finishes
  // after the user has already moved on cannot overwrite the current one.
  const view = document.getElementById('view');
  const host = document.createElement('div');
  host.innerHTML = '<div class="empty">Loading…</div>';
  view.replaceChildren(host);
  try {
    const result = await r.render(host);
    const teardown = typeof result === 'function' ? result : null;
    if (host.isConnected) cleanup = teardown;
    else if (teardown) teardown();
  } catch (err) {
    host.innerHTML = `<div class="alert err">${esc(err.message)}</div>`;
  }
}

async function start() {
  if (state.user.must_change_password) {
    app.innerHTML = '<div class="boot"></div>';
    openChangePassword(true);
    return;
  }
  if (!hasModule(currentModule)) currentModule = hasModule('impl') ? 'impl' : 'tracking';
  store.set(currentModule);
  await loadLookups(true);
  resetImplCache();
  renderShell();
  // Opening a page of the other module by link switches to that module (when allowed).
  const target = ROUTES.find((x) => x.path === (location.hash.replace(/^#\/?/, '') || '').split('?')[0]);
  if (target && target.mod !== 'both' && (target.mod || 'impl') !== currentModule && hasModule(target.mod || 'impl')) { currentModule = target.mod || 'impl'; store.set(currentModule); renderShell(); }
  route();
  if (state.user.face_attendance) startLocationPings();
}

window.addEventListener('hashchange', route);
window.addEventListener('ttf:logout', () => { if (state.user) { state.user = null; document.getElementById('modal-root').innerHTML = ''; renderLogin('Your session has ended. Please sign in again.'); } });
window.addEventListener('ttf:pwd', () => { if (state.user) { state.user.must_change_password = true; start(); } });

(async function boot() {
  try {
    const { user } = await api('/auth/me');
    state.user = user;
    await start();
  } catch {
    renderLogin();
  }
})();
