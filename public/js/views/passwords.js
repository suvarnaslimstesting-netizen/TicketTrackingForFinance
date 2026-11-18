import { api, can, esc, icon, fmtDateTime, toast, modal, busy, confirmDialog, showFormError } from '../core.js';

// One screen to reset the password of any user (Admin: everyone; Implementation Manager: Implementation employees).
const view = { q: '', status: 'Active', scope: '' };

export async function renderPasswords(root) {
  const rows = await api('/passwords');
  const selected = new Set();
  const showScope = can('user.manage');
  root.innerHTML = `<div class="page-head"><div><h1>Reset Passwords</h1><p>Give any user a new temporary password. They must change it at their next sign-in; their open sessions are signed out and any lock is cleared.</p></div>
      <div class="actions"><button class="btn btn-primary" data-bulk disabled>${icon('key')} Reset selected (<span data-n>0</span>)</button></div></div>
    <div class="card"><div class="toolbar">
      <input class="input" data-q placeholder="Search name, username, code, role…" aria-label="Search users" value="${esc(view.q)}">
      <select class="input" data-status aria-label="Status" style="max-width:160px"><option value="">All statuses</option><option ${view.status === 'Active' ? 'selected' : ''}>Active</option><option ${view.status === 'Inactive' ? 'selected' : ''}>Inactive</option></select>
      ${showScope ? `<select class="input" data-scope aria-label="Login" style="max-width:220px"><option value="">All logins</option><option value="all" ${view.scope === 'all' ? 'selected' : ''}>Ticket Tracking users</option><option value="impl" ${view.scope === 'impl' ? 'selected' : ''}>Implementation-only users</option></select>` : ''}
      <span class="help" data-count style="margin-left:auto"></span></div>
      <div class="table-wrap" data-t></div></div>`;
  const nEl = root.querySelector('[data-n]');
  const bulkBtn = root.querySelector('[data-bulk]');
  const syncBulk = () => { nEl.textContent = selected.size; bulkBtn.disabled = !selected.size; };

  const list = () => rows.filter((r) => (!view.status || r.status === view.status) && (!view.scope || (r.app_scope || 'all') === view.scope)
    && (!view.q || `${r.employee_name} ${r.username} ${r.employee_code} ${r.role_name} ${r.department_name || ''} ${r.email}`.toLowerCase().includes(view.q.toLowerCase())));

  const draw = () => {
    const l = list();
    const selectable = l.filter((r) => !r.self);
    root.querySelector('[data-count]').textContent = `${l.length} user(s)`;
    root.querySelector('[data-t]').innerHTML = l.length ? `<table class="tbl tbl-compact"><thead><tr>
        <th style="width:36px"><input type="checkbox" data-all aria-label="Select all shown" ${selectable.length && selectable.every((r) => selected.has(r.id)) ? 'checked' : ''}></th>
        <th>Employee</th><th>Username</th><th>Role</th>${showScope ? '<th>Login</th>' : ''}<th>Status</th><th>Password</th><th>Last sign-in</th><th class="row-actions"></th></tr></thead><tbody>
      ${l.map((r) => `<tr class="${r.status !== 'Active' ? 'row-muted' : ''}">
        <td>${r.self ? '' : `<input type="checkbox" data-sel="${r.id}" ${selected.has(r.id) ? 'checked' : ''} aria-label="Select ${esc(r.employee_name)}">`}</td>
        <td><b>${esc(r.employee_name)}</b><span class="sub">${esc(r.employee_code)} · ${esc(r.department_name || '')}</span></td>
        <td>${esc(r.username)}</td><td>${esc(r.role_name)}</td>
        ${showScope ? `<td>${r.app_scope === 'impl' ? '<span class="badge info plain">Implementation only</span>' : '<span class="badge off plain">All</span>'}</td>` : ''}
        <td>${r.status === 'Active' ? '<span class="badge ok">Active</span>' : '<span class="badge off">Inactive</span>'}</td>
        <td>${r.locked ? '<span class="badge bad">Locked</span> ' : ''}${r.must_change_password ? '<span class="badge warn">Temporary</span>' : '<span class="badge ok plain">Set by user</span>'}</td>
        <td>${r.last_login_at ? fmtDateTime(r.last_login_at) : 'Never'}</td>
        <td class="row-actions">${r.self ? '<span class="help">You</span>' : `<button class="btn btn-sm" data-reset="${r.id}">${icon('key')} Reset</button>`}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty"><b>No users found</b>Try other filters.</div>';
    root.querySelectorAll('[data-sel]').forEach((c) => c.addEventListener('change', () => { if (c.checked) selected.add(+c.dataset.sel); else selected.delete(+c.dataset.sel); syncBulk(); draw(); }));
    root.querySelector('[data-all]')?.addEventListener('change', (e) => { selectable.forEach((r) => (e.target.checked ? selected.add(r.id) : selected.delete(r.id))); syncBulk(); draw(); });
    root.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => resetOne(rows.find((r) => r.id === +b.dataset.reset))));
  };

  const after = (results) => {
    results.forEach((x) => { const r = rows.find((y) => y.id === x.id); if (r) { r.must_change_password = 1; r.locked = false; } });
    showPasswords(results);
    selected.clear();
    syncBulk();
    draw();
  };

  function resetOne(r) {
    const m = modal({
      title: `Reset password · ${r.employee_name}`, size: 'narrow',
      body: `<form class="grid" novalidate><div class="alert err" hidden data-err></div>
        <p style="margin:0">User <b>${esc(r.username)}</b> will get a temporary password and must change it at the next sign-in.</p>
        <label class="check"><input type="radio" name="how" value="auto" checked> Generate a temporary password</label>
        <label class="check"><input type="radio" name="how" value="manual"> Type a password</label>
        <div class="field" data-manual hidden><label>New password</label><input class="input" name="password" type="text" autocomplete="off" placeholder="Min. 8 characters, a letter and a number"></div></form>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>Reset password</button>',
    });
    const form = m.$('form');
    form.addEventListener('change', () => { m.$('[data-manual]').hidden = form.querySelector('[name=how]:checked').value !== 'manual'; });
    m.$('[data-save]').addEventListener('click', async () => {
      const btn = m.$('[data-save]');
      const manual = form.querySelector('[name=how]:checked').value === 'manual';
      busy(btn, true);
      try {
        const res = await api(`/passwords/${r.id}/reset`, { method: 'POST', body: { password: manual ? form.password.value : '' } });
        m.close();
        after([res]);
      } catch (err) { showFormError(form, err); busy(btn, false); }
    });
  }

  bulkBtn.addEventListener('click', async () => {
    const names = rows.filter((r) => selected.has(r.id)).map((r) => r.employee_name);
    if (!(await confirmDialog({ title: 'Reset selected passwords', message: `Give <b>${names.length}</b> user(s) a new temporary password each?<br><span class="help">${esc(names.slice(0, 8).join(', '))}${names.length > 8 ? ' …' : ''}</span>`, confirmText: 'Reset passwords', danger: true }))) return;
    busy(bulkBtn, true, 'Resetting…');
    try { after(await api('/passwords/bulk', { method: 'POST', body: { ids: [...selected] } })); } catch (err) { toast(err.message, 'err'); }
    busy(bulkBtn, false);
    syncBulk();
  });

  root.querySelector('[data-q]').addEventListener('input', (e) => { view.q = e.target.value.trim(); draw(); });
  root.querySelector('[data-status]').addEventListener('change', (e) => { view.status = e.target.value; draw(); });
  root.querySelector('[data-scope]')?.addEventListener('change', (e) => { view.scope = e.target.value; draw(); });
  draw();
}

// Shows the new passwords once so they can be shared with the users.
function showPasswords(list) {
  const text = list.map((x) => `${x.name} (${x.username}): ${x.password}`).join('\n');
  const m = modal({
    title: list.length > 1 ? `${list.length} passwords reset` : 'Password reset',
    size: list.length > 1 ? 'wide' : 'narrow',
    body: `<div class="alert warn">Copy these now — they are not shown again. Each user must change it at the next sign-in.</div>
      <div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Employee</th><th>Username</th><th>Temporary password</th></tr></thead><tbody>
      ${list.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.username)}</td><td><span class="mono pw-show">${esc(x.password)}</span></td></tr>`).join('')}</tbody></table></div>`,
    footer: `<button class="btn" data-copy>${icon('file')} Copy all</button><button class="btn btn-primary" data-close>Done</button>`,
  });
  m.$('[data-copy]').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { toast('Copy failed — select the text and copy it.', 'err'); }
  });
}
