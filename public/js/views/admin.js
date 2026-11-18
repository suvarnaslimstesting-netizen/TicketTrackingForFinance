import { api, esc, icon, fmtDate, fmtDateTime, toast, modal, formValues, showFormError, busy, statusBadge, confirmDialog, state, loadLookups } from '../core.js';

/* Generic list page with a search box and an "Add" button. */
function listPage(root, { title, subtitle, addLabel, searchPlaceholder, extraFilters = '' }) {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>
      <div class="actions"><button class="btn btn-primary" data-add>${icon('plus')} ${esc(addLabel)}</button></div>
    </div>
    <div class="card">
      <div class="toolbar"><input class="input" data-search placeholder="${esc(searchPlaceholder)}" aria-label="Search">${extraFilters}<span style="margin-left:auto;color:var(--muted);font-size:13px" data-count></span></div>
      <div class="table-wrap" data-table><div class="empty">Loading…</div></div>
    </div>`;
  return { add: root.querySelector('[data-add]'), search: root.querySelector('[data-search]'), table: root.querySelector('[data-table]'), count: root.querySelector('[data-count]') };
}

let STATE_LIST = [];
const stateLabel = (code) => {
  const s = STATE_LIST.find((x) => x.code === code);
  return s ? `${s.name} (${s.code})` : code;
};
const stateSelect = (states, value, name = 'state_code') => {
  STATE_LIST = states;
  return `<select class="input" name="${name}"><option value="">Select State</option>${states.map((s) => `<option value="${s.code}" ${s.code === value ? 'selected' : ''}>${esc(s.name)} (${s.code})</option>`).join('')}</select>`;
};
// The first two digits of a GSTIN are the GST state code.
function bindGstinState(gstin, state) {
  gstin.addEventListener('input', () => {
    const code = gstin.value.trim().slice(0, 2);
    if (/^\d{2}$/.test(code) && [...state.options].some((o) => o.value === code)) state.value = code;
  });
}

const statusSelect = (v = 'Active') =>
  `<select class="input" name="status"><option ${v === 'Active' ? 'selected' : ''}>Active</option><option ${v === 'Inactive' ? 'selected' : ''}>Inactive</option></select>`;

function formModal({ title, fields, onSubmit, size = '' }) {
  const m = modal({
    title, size,
    body: `<form class="form-grid" novalidate><div class="alert err full" hidden data-err></div>${fields}</form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>Save</button>',
  });
  const form = m.$('form');
  const submit = async () => {
    const btn = m.$('[data-save]');
    showFormError(form, null);
    busy(btn, true);
    try {
      await onSubmit(formValues(form), form);
      m.close();
    } catch (err) {
      showFormError(form, err);
      busy(btn, false);
    }
  };
  m.$('[data-save]').addEventListener('click', submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  return m;
}

const matches = (row, term, keys) => !term || keys.some((k) => String(row[k] ?? '').toLowerCase().includes(term));

/* ------------------------------ Departments ------------------------------ */

export async function renderDepartments(root) {
  const ui = listPage(root, { title: 'Departments', subtitle: 'Create and manage the departments users belong to.', addLabel: 'Add Department', searchPlaceholder: 'Search departments…' });
  let rows = [];
  const draw = () => {
    const term = ui.search.value.trim().toLowerCase();
    const list = rows.filter((r) => matches(r, term, ['code', 'name', 'description']));
    ui.count.textContent = `${list.length} department(s)`;
    ui.table.innerHTML = list.length ? `<table class="tbl"><thead><tr><th>Department ID</th><th>Department Name</th><th>Description</th><th class="num">Users</th><th>Status</th><th>Created Date</th><th class="row-actions">Actions</th></tr></thead><tbody>
      ${list.map((d) => `<tr><td class="ticket">${esc(d.code)}</td><td><b>${esc(d.name)}</b></td><td>${esc(d.description) || '—'}</td><td class="num">${d.user_count}</td><td>${statusBadge(d.status)}</td><td>${fmtDate(d.created_at)}</td>
        <td class="row-actions"><button class="icon-btn" data-edit="${d.id}" title="Edit" aria-label="Edit">${icon('edit')}</button><button class="icon-btn danger" data-del="${d.id}" title="Delete" aria-label="Delete">${icon('trash')}</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty"><b>No departments found</b></div>';
    ui.table.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => open(rows.find((r) => r.id === +b.dataset.edit))));
    ui.table.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => del(rows.find((r) => r.id === +b.dataset.del))));
  };
  const load = async () => { rows = await api('/admin/departments'); draw(); };
  const open = (d = {}) => formModal({
    title: d.id ? `Edit Department · ${d.code}` : 'Add Department',
    fields: `
      <div class="field"><label>Department ID</label><input class="input" disabled value="${esc(d.code || 'Auto-generated')}"></div>
      <div class="field"><label>Department Name <span class="req">*</span></label><input class="input" name="name" maxlength="100" value="${esc(d.name)}"></div>
      <div class="field full"><label>Description</label><textarea class="input" name="description" maxlength="500">${esc(d.description)}</textarea></div>
      <div class="field"><label>Status</label>${statusSelect(d.status)}</div>
      <div class="field"><label>Created Date</label><input class="input" disabled value="${d.created_at ? fmtDateTime(d.created_at) : 'On save'}"></div>`,
    onSubmit: async (v) => {
      await api(d.id ? `/admin/departments/${d.id}` : '/admin/departments', { method: d.id ? 'PUT' : 'POST', body: v });
      toast(d.id ? 'Department updated.' : 'Department created.');
      load();
    },
  });
  const del = async (d) => {
    if (!(await confirmDialog({ title: 'Delete department', message: `Delete department <b>${esc(d.name)}</b>?`, confirmText: 'Delete', danger: true }))) return;
    try { await api(`/admin/departments/${d.id}`, { method: 'DELETE', body: {} }); toast('Department deleted.'); load(); } catch (err) { toast(err.message, 'err'); }
  };
  ui.add.addEventListener('click', () => open());
  ui.search.addEventListener('input', draw);
  await load();
}

/* --------------------------------- Roles --------------------------------- */

export async function renderRoles(root) {
  const ui = listPage(root, { title: 'Roles & Permissions', subtitle: 'Create roles and configure exactly what each role can do.', addLabel: 'Add Role', searchPlaceholder: 'Search roles…' });
  const catalog = (await api('/auth/me')).permissions;
  let rows = [];
  const draw = () => {
    const term = ui.search.value.trim().toLowerCase();
    const list = rows.filter((r) => matches(r, term, ['name', 'description']));
    ui.count.textContent = `${list.length} role(s)`;
    ui.table.innerHTML = `<table class="tbl"><thead><tr><th>Role</th><th>Description</th><th>Permissions</th><th class="num">Users</th><th>Status</th><th class="row-actions">Actions</th></tr></thead><tbody>
      ${list.map((r) => `<tr><td><b>${esc(r.name)}</b>${r.is_system ? ' <span class="badge info plain">System</span>' : ''}</td><td>${esc(r.description) || '—'}</td>
        <td>${r.permissions.length === catalog.length ? '<span class="tag">All permissions</span>' : r.permissions.map((k) => `<span class="tag" style="margin:0 4px 4px 0">${esc((catalog.find((p) => p.key === k) || {}).label?.split(' (')[0] || k)}</span>`).join('') || '—'}</td>
        <td class="num">${r.user_count}</td><td>${statusBadge(r.status)}</td>
        <td class="row-actions"><button class="icon-btn" data-edit="${r.id}" title="Edit" aria-label="Edit">${icon('edit')}</button>${r.is_system ? '' : `<button class="icon-btn danger" data-del="${r.id}" title="Delete" aria-label="Delete">${icon('trash')}</button>`}</td></tr>`).join('')}
      </tbody></table>`;
    ui.table.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => open(rows.find((r) => r.id === +b.dataset.edit))));
    ui.table.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => del(rows.find((r) => r.id === +b.dataset.del))));
  };
  const load = async () => { rows = await api('/admin/roles'); draw(); };
  const open = (r = { permissions: [] }) => {
    const groups = [...new Set(catalog.map((p) => p.group))];
    const locked = !!r.is_system;
    const m = formModal({
      title: r.id ? `Edit Role · ${r.name}` : 'Add Role',
      size: 'wide',
      fields: `
        <div class="field"><label>Role Name <span class="req">*</span></label><input class="input" name="name" maxlength="100" value="${esc(r.name)}" ${locked ? 'disabled' : ''}></div>
        <div class="field"><label>Status</label>${locked ? '<input class="input" disabled value="Active">' : statusSelect(r.status)}</div>
        <div class="field full"><label>Description</label><input class="input" name="description" maxlength="300" value="${esc(r.description)}"></div>
        ${locked ? '<div class="alert info full">The Admin role always has every permission so the portal can never be locked out.</div>' : ''}
        <div class="full grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
          ${groups.map((g) => `<div class="perm-group"><h4>${esc(g)} ${locked ? '' : `<button type="button" class="btn btn-sm btn-ghost" data-all="${esc(g)}">Toggle all</button>`}</h4>
            ${catalog.filter((p) => p.group === g).map((p) => `<label><input type="checkbox" name="permissions" value="${p.key}" data-group="${esc(g)}" ${r.permissions.includes(p.key) || locked ? 'checked' : ''} ${locked ? 'disabled' : ''}> <span>${esc(p.label)}</span></label>`).join('')}
          </div>`).join('')}
        </div>`,
      onSubmit: async (v) => {
        if (locked) v.name = r.name;
        await api(r.id ? `/admin/roles/${r.id}` : '/admin/roles', { method: r.id ? 'PUT' : 'POST', body: v });
        toast(r.id ? 'Role updated. Changes apply to its users immediately.' : 'Role created.');
        load();
      },
    });
    m.$$('[data-all]').forEach((b) => b.addEventListener('click', () => {
      const boxes = m.$$(`input[data-group="${b.dataset.all}"]`);
      const on = !boxes.every((x) => x.checked);
      boxes.forEach((x) => (x.checked = on));
    }));
  };
  const del = async (r) => {
    if (!(await confirmDialog({ title: 'Delete role', message: `Delete role <b>${esc(r.name)}</b>?`, confirmText: 'Delete', danger: true }))) return;
    try { await api(`/admin/roles/${r.id}`, { method: 'DELETE', body: {} }); toast('Role deleted.'); load(); } catch (err) { toast(err.message, 'err'); }
  };
  ui.add.addEventListener('click', () => open());
  ui.search.addEventListener('input', draw);
  await load();
}

/* --------------------------------- Users --------------------------------- */

export async function renderUsers(root) {
  const [departments, roles] = await Promise.all([api('/admin/departments'), api('/admin/roles')]);
  const opt = (list, sel, all) => `<option value="">${all}</option>` + list.map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}${x.status === 'Inactive' ? ' (Inactive)' : ''}</option>`).join('');
  const ui = listPage(root, {
    title: 'Users', subtitle: 'Create users, map them to departments, assign roles and control access.', addLabel: 'Add User', searchPlaceholder: 'Search name, code, email, username…',
    extraFilters: `<select class="input" data-fd style="max-width:200px" aria-label="Department">${opt(departments, null, 'All departments')}</select>
      <select class="input" data-fr style="max-width:200px" aria-label="Role">${opt(roles, null, 'All roles')}</select>
      <select class="input" data-fs style="max-width:150px" aria-label="Status"><option value="">All statuses</option><option>Active</option><option>Inactive</option></select>`,
  });
  const fd = root.querySelector('[data-fd]'); const fr = root.querySelector('[data-fr]'); const fs = root.querySelector('[data-fs]');
  let rows = [];
  const draw = () => {
    const term = ui.search.value.trim().toLowerCase();
    const list = rows.filter((u) => matches(u, term, ['employee_name', 'employee_code', 'email', 'username', 'user_code', 'mobile'])
      && (!fd.value || u.department_id === +fd.value) && (!fr.value || u.role_id === +fr.value) && (!fs.value || u.status === fs.value));
    ui.count.textContent = `${list.length} user(s)`;
    ui.table.innerHTML = list.length ? `<table class="tbl"><thead><tr><th>User ID</th><th>Employee</th><th>Email / Mobile</th><th>Department</th><th>Role</th><th>Username</th><th>Status</th><th>Last Login</th><th class="row-actions">Actions</th></tr></thead><tbody>
      ${list.map((u) => `<tr><td class="ticket">${esc(u.user_code)}</td><td><b>${esc(u.employee_name)}</b><span class="sub">${esc(u.employee_code)}</span></td>
        <td>${esc(u.email)}<span class="sub">${esc(u.mobile) || '—'}</span></td><td>${esc(u.department_name)}</td><td>${esc(u.role_name)}</td>
        <td>${esc(u.username)}${u.must_change_password ? '<span class="sub">Temporary password</span>' : ''}</td><td>${statusBadge(u.status)}</td><td class="nowrap">${fmtDateTime(u.last_login_at)}</td>
        <td class="row-actions"><button class="icon-btn" data-edit="${u.id}" title="Edit" aria-label="Edit">${icon('edit')}</button>
          ${u.id === state.user.id ? '' : `<button class="icon-btn ${u.status === 'Active' ? 'danger' : ''}" data-tog="${u.id}" title="${u.status === 'Active' ? 'Deactivate' : 'Activate'}" aria-label="${u.status === 'Active' ? 'Deactivate' : 'Activate'}">${icon('power')}</button>`}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty"><b>No users found</b></div>';
    ui.table.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => open(rows.find((r) => r.id === +b.dataset.edit))));
    ui.table.querySelectorAll('[data-tog]').forEach((b) => b.addEventListener('click', () => toggle(rows.find((r) => r.id === +b.dataset.tog))));
  };
  const load = async () => { rows = await api('/admin/users'); draw(); };
  const activeOr = (list, id) => list.filter((x) => x.status === 'Active' || x.id === id);
  const open = (u = {}) => formModal({
    title: u.id ? `Edit User · ${u.user_code}` : 'Add User',
    size: 'wide',
    fields: `
      <div class="field"><label>User ID</label><input class="input" disabled value="${esc(u.user_code || 'Auto-generated')}"></div>
      <div class="field"><label>Employee Name <span class="req">*</span></label><input class="input" name="employee_name" maxlength="150" value="${esc(u.employee_name)}"></div>
      <div class="field"><label>Employee Code <span class="req">*</span></label><input class="input" name="employee_code" maxlength="50" value="${esc(u.employee_code)}"></div>
      <div class="field"><label>Email ID <span class="req">*</span></label><input class="input" type="email" name="email" maxlength="150" value="${esc(u.email)}"></div>
      <div class="field"><label>Mobile Number</label><input class="input" name="mobile" inputmode="tel" maxlength="15" value="${esc(u.mobile)}"></div>
      <div class="field"><label>Department <span class="req">*</span></label><select class="input" name="department_id">${opt(activeOr(departments, u.department_id), u.department_id, 'Select department')}</select></div>
      <div class="field"><label>Role <span class="req">*</span></label><select class="input" name="role_id" ${u.id === state.user.id ? 'disabled' : ''}>${opt(activeOr(roles, u.role_id), u.role_id, 'Select role')}</select></div>
      <div class="field"><label>Username <span class="req">*</span></label><input class="input" name="username" maxlength="50" autocomplete="off" value="${esc(u.username)}"></div>
      <div class="field"><label>${u.id ? 'Reset Password' : 'Password <span class="req">*</span>'}</label><input class="input" type="password" name="password" autocomplete="new-password" placeholder="${u.id ? 'Leave blank to keep current password' : ''}">
        <span class="help">Min. 8 characters with a letter and a number. The user must change it at first sign-in.</span></div>
      <div class="field"><label>Status</label>${u.id === state.user.id ? '<input class="input" disabled value="Active"><input type="hidden" name="status" value="Active">' : statusSelect(u.status)}</div>`,
    onSubmit: async (v) => {
      if (u.id === state.user.id) v.role_id = u.role_id;
      await api(u.id ? `/admin/users/${u.id}` : '/admin/users', { method: u.id ? 'PUT' : 'POST', body: v });
      toast(u.id ? 'User updated.' : 'User created.');
      load();
    },
  });
  const toggle = async (u) => {
    const to = u.status === 'Active' ? 'Inactive' : 'Active';
    const ok = await confirmDialog({
      title: to === 'Active' ? 'Activate user' : 'Deactivate user',
      message: to === 'Active' ? `Allow <b>${esc(u.employee_name)}</b> to sign in again?` : `<b>${esc(u.employee_name)}</b> will be signed out and will not be able to sign in.`,
      confirmText: to === 'Active' ? 'Activate' : 'Deactivate', danger: to !== 'Active',
    });
    if (!ok) return;
    try { await api(`/admin/users/${u.id}/status`, { method: 'PATCH', body: { status: to } }); toast(`User ${to === 'Active' ? 'activated' : 'deactivated'}.`); load(); } catch (err) { toast(err.message, 'err'); }
  };
  ui.add.addEventListener('click', () => open());
  [ui.search, fd, fr, fs].forEach((el) => el.addEventListener(el === ui.search ? 'input' : 'change', draw));
  await load();
}

/* -------------------------------- Clients -------------------------------- */

export async function renderClients(root) {
  const ui = listPage(root, { title: 'Clients', subtitle: 'Client master used in the Man-Day Approval entry screen.', addLabel: 'Add Client', searchPlaceholder: 'Search clients…' });
  let rows = [];
  const draw = () => {
    const term = ui.search.value.trim().toLowerCase();
    const list = rows.filter((r) => matches(r, term, ['name', 'description']));
    ui.count.textContent = `${list.length} client(s)`;
    ui.table.innerHTML = list.length ? `<table class="tbl"><thead><tr><th>Client Name</th><th>Department(s)</th><th>GSTIN / State</th><th class="num">Approved Tickets</th><th>Status</th><th>Created Date</th><th class="row-actions">Actions</th></tr></thead><tbody>
      ${list.map((c) => `<tr><td><b>${esc(c.name)}</b></td>
        <td>${(c.department_names || []).length ? c.department_names.map((n) => `<span class="tag" style="margin:2px 4px 2px 0">${esc(n)}</span>`).join('') : '<span class="badge warn">Not mapped</span>'}</td>
        <td>${c.gstin ? `<span class="nowrap">${esc(c.gstin)}</span>` : '<span class="badge warn">No GSTIN</span>'}${c.state_code ? `<span class="sub">${esc(stateLabel(c.state_code))}</span>` : ''}</td><td class="num">${c.ticket_count}</td><td>${statusBadge(c.status)}</td><td>${fmtDate(c.created_at)}</td>
        <td class="row-actions"><button class="icon-btn" data-edit="${c.id}" title="Edit" aria-label="Edit">${icon('edit')}</button><button class="icon-btn danger" data-del="${c.id}" title="Delete" aria-label="Delete">${icon('trash')}</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty"><b>No clients found</b></div>';
    ui.table.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => open(rows.find((r) => r.id === +b.dataset.edit))));
    ui.table.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => del(rows.find((r) => r.id === +b.dataset.del))));
  };
  const load = async () => { STATE_LIST = (await loadLookups(true)).states; rows = await api('/admin/clients'); draw(); };
  const open = async (c = {}) => {
    c = { department_ids: [], department_names: [], ...c };
    const { departments, states } = await loadLookups(true);
    // Show active departments, plus any inactive one the client is already mapped to.
    const extra = (c.department_ids || []).filter((id) => !departments.some((d) => d.id === id))
      .map((id) => ({ id, name: (c.department_names || [])[c.department_ids.indexOf(id)] || `Department #${id}` }));
    const options = [...departments, ...extra];
    const m = formModal({
    title: c.id ? 'Edit Client' : 'Add Client',
    size: 'wide',
    fields: `
      <div class="field full"><label>Client Name <span class="req">*</span></label><input class="input" name="name" maxlength="150" value="${esc(c.name)}"></div>
      <div class="field full"><label>Department(s) <span class="req">*</span></label>
        <div class="dept-picker">
          <div class="dept-hint">Select every department that works with this client. They are filled in automatically when an approval is created for this client.</div>
          <div class="dept-chips">${options.map((d) => `<label class="dept-chip"><input type="checkbox" name="department_ids" value="${d.id}" ${(c.department_ids || []).includes(d.id) ? 'checked' : ''}><span>${esc(d.name)}</span></label>`).join('')}</div>
          <div class="dept-tools"><button type="button" class="btn btn-sm btn-ghost" data-dall>Select all</button><button type="button" class="btn btn-sm btn-ghost" data-dnone>Clear</button></div>
        </div></div>
      <div class="field full"><div class="section-title" style="margin-top:4px">Billing details (used on quotations &amp; invoices)</div></div>
      <div class="field full"><label>Billing Address</label><textarea class="input" name="billing_address" maxlength="500" placeholder="Registered / billing address">${esc(c.billing_address)}</textarea></div>
      <div class="field"><label>GSTIN</label><input class="input" name="gstin" maxlength="15" style="text-transform:uppercase" placeholder="e.g. 27ABCDE1234F1Z5" value="${esc(c.gstin)}"></div>
      <div class="field"><label>State</label>${stateSelect(states, c.state_code)}<span class="help">Filled from the GSTIN automatically.</span></div>
      <div class="field"><label>Contact Person</label><input class="input" name="contact_person" maxlength="150" value="${esc(c.contact_person)}"></div>
      <div class="field"><label>Contact Email</label><input class="input" name="contact_email" maxlength="300" placeholder="Quotations / invoices are sent here" value="${esc(c.contact_email)}"></div>
      <div class="field full"><label>Description</label><textarea class="input" name="description" maxlength="500">${esc(c.description)}</textarea></div>
      <div class="field"><label>Status</label>${statusSelect(c.status)}</div>`,
    onSubmit: async (v) => {
      if (!(v.department_ids || []).length) throw new Error('Please select at least one Department for the client.');
      await api(c.id ? `/admin/clients/${c.id}` : '/admin/clients', { method: c.id ? 'PUT' : 'POST', body: v });
      toast(c.id ? 'Client updated.' : 'Client created.');
      load();
    },
    });
    bindGstinState(m.$('[name=gstin]'), m.$('[name=state_code]'));
    m.$('[data-dall]').addEventListener('click', () => m.$$('input[name=department_ids]').forEach((x) => (x.checked = true)));
    m.$('[data-dnone]').addEventListener('click', () => m.$$('input[name=department_ids]').forEach((x) => (x.checked = false)));
  };
  const del = async (c) => {
    if (!(await confirmDialog({ title: 'Delete client', message: `Delete client <b>${esc(c.name)}</b>?`, confirmText: 'Delete', danger: true }))) return;
    try { await api(`/admin/clients/${c.id}`, { method: 'DELETE', body: {} }); toast('Client deleted.'); load(); } catch (err) { toast(err.message, 'err'); }
  };
  ui.add.addEventListener('click', () => open());
  ui.search.addEventListener('input', draw);
  await load();
}

/* ---------------------------- Company settings ---------------------------- */

export async function renderCompany(root) {
  const [co, { states }] = await Promise.all([api('/admin/company'), loadLookups()]);
  const f = (name, label, opts = {}) => `<div class="field ${opts.full ? 'full' : ''}"><label>${label}${opts.req ? ' <span class="req">*</span>' : ''}</label>
    ${opts.area ? `<textarea class="input" name="${name}" maxlength="${opts.max || 500}" rows="${opts.rows || 3}" placeholder="${esc(opts.ph || '')}">${esc(co[name])}</textarea>`
      : `<input class="input" name="${name}" maxlength="${opts.max || 150}" ${opts.num ? 'inputmode="decimal"' : ''} ${opts.upper ? 'style="text-transform:uppercase"' : ''} placeholder="${esc(opts.ph || '')}" value="${esc(co[name] ?? '')}">`}
    ${opts.help ? `<span class="help">${opts.help}</span>` : ''}</div>`;
  root.innerHTML = `
    <div class="page-head"><div><h1>Company Settings</h1><p>Our details printed on every quotation and tax invoice, plus billing defaults.</p></div></div>
    <form class="card card-body company-form" novalidate>
      <div class="alert err" hidden data-err></div>
      <div class="section-title">Company</div>
      <div class="form-grid">
        ${f('company_name', 'Company Name', { req: true })}
        ${f('website', 'Website')}
        ${f('address', 'Registered Address', { full: true, area: true })}
        <div class="field"><label>State</label>${stateSelect(states, co.state_code)}<span class="help">Decides CGST + SGST (same State) or IGST (other States).</span></div>
        ${f('gstin', 'GSTIN', { max: 15, upper: true, ph: 'e.g. 27ABCDE1234F1Z5' })}
        ${f('pan', 'PAN', { max: 10, upper: true, ph: 'e.g. ABCDE1234F' })}
        ${f('email', 'Accounts Email', { max: 300 })}
        ${f('phone', 'Phone', { max: 50 })}
      </div>
      <div class="section-title">Bank details (printed on invoices)</div>
      <div class="form-grid">
        ${f('bank_name', 'Bank Name')}
        ${f('bank_branch', 'Branch')}
        ${f('bank_account', 'Account Number', { max: 40 })}
        ${f('bank_ifsc', 'IFSC', { max: 11, upper: true, ph: 'e.g. HDFC0001234' })}
      </div>
      <div class="section-title">Billing defaults</div>
      <div class="form-grid">
        ${f('default_rate', 'Default Rate per Man-Day (₹)', { num: true, help: 'Pre-filled on new quotations; can be changed per quotation.' })}
        ${f('gst_rate', 'GST %', { num: true, req: true })}
        ${f('sac_code', 'SAC Code', { max: 10, help: '998314 = IT design &amp; development services. Check with your accountant.' })}
        ${f('quote_validity_days', 'Quotation Validity (days)', { num: true, req: true })}
        ${f('payment_terms_days', 'Payment Terms (days)', { num: true, req: true, help: 'Invoice due date = invoice date + these days.' })}
        ${f('quotation_terms', 'Quotation Terms &amp; Conditions', { full: true, area: true, max: 3000, rows: 4, ph: 'One term per line' })}
        ${f('invoice_terms', 'Invoice Terms &amp; Conditions', { full: true, area: true, max: 3000, rows: 4, ph: 'One term per line' })}
      </div>
      <div class="actions" style="justify-content:flex-end;margin-top:6px">
        <span class="help" style="margin-right:auto">${co.updated_at ? `Last updated ${fmtDateTime(co.updated_at)}` : 'Not saved yet'}</span>
        <button class="btn btn-primary" type="submit">Save Settings</button>
      </div>
    </form>`;
  const form = root.querySelector('form');
  bindGstinState(form.gstin, form.state_code);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    showFormError(form, null);
    busy(btn, true);
    try {
      await api('/admin/company', { method: 'PUT', body: formValues(form) });
      toast('Company settings saved.');
      renderCompany(root);
    } catch (err) {
      showFormError(form, err);
      busy(btn, false);
      form.querySelector('[data-err]').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}
