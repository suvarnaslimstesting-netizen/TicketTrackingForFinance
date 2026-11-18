import {
  api, can, esc, icon, fmtDate, fmtDateTime, fmtNum, fmtMoney, today, toast, modal, showFormError, busy, download, confirmDialog,
  readFileBase64, loadScript, qs, state,
} from '../core.js';

/* ------------------------------ Shared data ------------------------------ */

let META = null;
let LK = null;
async function boot(force = false) {
  if (!META || force) [META, LK] = await Promise.all([api('/impl/meta'), api('/impl/lookups')]);
  return { meta: META, lk: LK };
}
export const resetImplCache = () => { META = null; LK = null; };
const refreshLookups = async () => { LK = await api('/impl/lookups'); };

const BADGE = {
  'Not Started': 'off', 'In Progress': 'info', Pending: 'warn', Completed: 'ok', 'On Hold': 'bad', Open: 'bad', Resolved: 'ok', Closed: 'off',
  Critical: 'bad', High: 'warn', Medium: 'info', Low: 'off', 'Pending approval': 'warn', Approved: 'ok', Rejected: 'bad', Ready: 'ok', Partial: 'warn',
  'Not Ready': 'bad', Active: 'ok', Expired: 'bad', 'Renewal Pending': 'warn', Inside: 'ok', Outside: 'bad', Remote: 'info', 'No geofence': 'off',
};
const badge = (v) => (v ? `<span class="badge ${BADGE[v] || 'off'}">${esc(v)}</span>` : '—');
const bar = (p) => `<span class="pbar"><i style="width:${Math.max(0, Math.min(100, p || 0))}%"></i></span> ${fmtNum(p || 0)}%`;

function refLabel(ref, v) {
  if (v === null || v === undefined || v === '') return '';
  const list = { clients: LK.clients, locations: LK.locations, users: LK.users, templates: LK.templates, sorders: LK.sorders }[ref] || [];
  const x = list.find((y) => y.id === v);
  if (!x) return `#${v}`;
  return ref === 'templates' ? `${x.name} ${x.version || ''}` : x.name;
}
const fileBtn = (id, name) => `<button type="button" class="btn btn-sm btn-ghost file-btn" data-file="${id}" title="Download ${esc(name || 'file')}">${icon('download')} <span>${esc(name || 'File')}</span></button>`;

function cell(f, row) {
  const v = row[f.key];
  if (f.type === 'f') return v ? fileBtn(v, row[`${f.key}_name`]) : '—';
  if (f.type === 'p') return row[`${f.key}_set`] ? `•••••• ${can('credential.view') ? `<button type="button" class="btn btn-sm btn-ghost" data-reveal="${row.id}">Reveal</button>` : ''}` : '—';
  if (v === null || v === undefined || v === '') return f.type === 'c' ? 'No' : '—';
  if (f.type === 'r' || f.type === 'h') return esc(refLabel(f.ref, v));
  if (f.type === 'x') return (v || []).map((m) => `<span class="tag">${esc(m)}</span>`).join(' ');
  if (f.type === 'd') return fmtDate(v);
  if (f.type === 'c') return v ? 'Yes' : 'No';
  if (f.key === 'pct') return bar(v);
  if (f.key === 'amount') return fmtMoney(v);
  if (f.type === 'u') return `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>`;
  if (BADGE[v]) return badge(v);
  return esc(v);
}

async function fileClick(root) {
  root.querySelectorAll('[data-file]').forEach((b) => b.addEventListener('click', async () => {
    try { await download(`/impl/files/${b.dataset.file}`); } catch (err) { toast(err.message, 'err'); }
  }));
  root.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api(`/impl/servers/${b.dataset.reveal}/reveal`, { method: 'POST', body: {} });
      modal({ title: 'Credential', size: 'narrow', body: `<dl class="details" style="grid-template-columns:1fr"><div><dt>Username</dt><dd>${esc(r.username)}</dd></div><div><dt>Password</dt><dd class="mono">${esc(r.password)}</dd></div></dl><p class="help">This view has been recorded in the audit log.</p>`, footer: '<button class="btn" data-close>Close</button>' });
    } catch (err) { toast(err.message, 'err'); }
  }));
}

/* ------------------------------ Generic table ----------------------------- */

/**
 * Renders a record list with search, Excel export, add / edit / delete.
 * fixed: values pinned by the page (e.g. {client: 5}); those columns are hidden and pre-filled.
 */
export async function crudCard(host, key, { fixed = {}, title, onChange, extraActions } = {}) {
  const e = META.entities[key];
  if (!e) { host.innerHTML = ''; return; }
  const cols = e.cols.filter((c) => fixed[c] === undefined).map((c) => e.fields.find((f) => f.key === c)).filter(Boolean);
  const canEdit = (row) => e.canWrite && (!e.owner || can('impl.manage') || row[e.owner] === META.userId);
  let rows = [];
  host.innerHTML = `<div class="card crud">
      <div class="crud-head"><h3>${esc(title || e.title)} <span class="count" data-count></span></h3>
        <div class="actions"><input class="input input-sm" data-q placeholder="Search…" aria-label="Search ${esc(e.title)}">
          <button class="btn btn-sm" data-x>${icon('excel')} Excel</button>
          ${e.canWrite ? `<button class="btn btn-sm btn-primary" data-add>${icon('plus')} Add</button>` : ''}</div></div>
      ${e.canWrite ? '' : '<div class="help" style="padding:0 16px 8px">View only for your role.</div>'}
      <div class="table-wrap" data-t><div class="empty">Loading…</div></div></div>`;
  const t = host.querySelector('[data-t]');
  const draw = () => {
    const term = host.querySelector('[data-q]').value.trim().toLowerCase();
    const list = term ? rows.filter((r) => JSON.stringify(Object.values(r)).toLowerCase().includes(term)
      || cols.some((f) => (f.type === 'r' || f.type === 'h') && refLabel(f.ref, r[f.key]).toLowerCase().includes(term))) : rows;
    host.querySelector('[data-count]').textContent = `(${list.length})`;
    t.innerHTML = list.length ? `<table class="tbl tbl-compact"><thead><tr>${cols.map((f) => `<th>${esc(f.label)}</th>`).join('')}<th class="row-actions"><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${list.map((r) => `<tr>${cols.map((f) => `<td data-l="${esc(f.label)}">${cell(f, r)}</td>`).join('')}<td class="row-actions">
        ${extraActions ? extraActions(r) : ''}
        ${canEdit(r) ? `<button class="icon-btn" data-edit="${r.id}" title="Edit" aria-label="Edit">${icon('edit')}</button><button class="icon-btn danger" data-del="${r.id}" title="Delete" aria-label="Delete">${icon('trash')}</button>` : ''}
      </td></tr>`).join('')}</tbody></table>` : '<div class="empty small"><b>No records yet</b></div>';
    t.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openForm(key, rows.find((x) => x.id === +b.dataset.edit), fixed, reload)));
    t.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: `Delete ${e.title}`, message: 'Delete this record? This cannot be undone.', confirmText: 'Delete', danger: true }))) return;
      try { await api(`/impl/e/${key}/${b.dataset.del}`, { method: 'DELETE', body: {} }); toast('Deleted.'); reload(); } catch (err) { toast(err.message, 'err'); }
    }));
    fileClick(t);
    host.dispatchEvent(new CustomEvent('crud:drawn', { detail: { rows } }));
  };
  async function reload(changed = true) {
    try { rows = await api(`/impl/e/${key}${qs(fixed)}`); } catch (err) { t.innerHTML = `<div class="alert err">${esc(err.message)}</div>`; return; }
    draw();
    if (changed && onChange) onChange();
  }
  host.querySelector('[data-q]').addEventListener('input', draw);
  host.querySelector('[data-x]').addEventListener('click', () => download(`/impl/export/${key}${qs(fixed)}`).catch((err) => toast(err.message, 'err')));
  host.querySelector('[data-add]')?.addEventListener('click', () => openForm(key, null, fixed, reload));
  await reload(false);
  return { reload };
}

/* ------------------------------- Generic form ------------------------------ */

function options(f) {
  if (f.master) return LK.masters[f.master] || [];
  return f.options || [];
}
function refOptions(f, value, clientId) {
  let list = { clients: LK.clients, locations: LK.locations, users: LK.users.filter((u) => u.status === 'Active' || u.id === value), templates: LK.templates, sorders: LK.sorders }[f.ref] || [];
  if (f.ref === 'locations') list = clientId ? list.filter((l) => l.client === +clientId) : [];
  return `<option value="">— Select —</option>${list.map((x) => `<option value="${x.id}" ${x.id === value ? 'selected' : ''}>${esc(f.ref === 'templates' ? `${x.name} ${x.version}` : x.name)}${f.ref === 'users' && x.role ? ` · ${esc(x.role)}` : ''}</option>`).join('')}`;
}

function input(f, v, row, fixed) {
  const n = `name="${f.key}" id="fi-${f.key}"`;
  switch (f.type) {
    case 'a': return `<textarea class="input" ${n} rows="3" maxlength="3000">${esc(v)}</textarea>`;
    case 's': return `<select class="input" ${n}><option value="">— Select —</option>${[...new Set([...options(f), ...(v ? [v] : [])])].map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    case 'o': return `<input class="input" ${n} list="dl-${f.key}" value="${esc(v)}" placeholder="Pick or type" maxlength="150"><datalist id="dl-${f.key}">${options(f).map((o) => `<option value="${esc(o)}">`).join('')}</datalist>`;
    case 'r': return `<select class="input" ${n}>${refOptions(f, v, fixed.client ?? row.client)}</select>`;
    case 'x': return `<div class="dept-chips" id="fi-${f.key}">${options(f).map((o) => `<label class="dept-chip"><input type="checkbox" name="${f.key}" value="${esc(o)}" ${(v || []).includes(o) ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')}</div>`;
    case 'c': return `<label class="check"><input type="checkbox" ${n} ${v || (v === undefined && ['enabled'].includes(f.key)) ? 'checked' : ''}> Yes</label>`;
    case 'f': return `<input class="input" type="file" ${n} accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx,.csv,.txt">${v ? `<span class="help">Current: ${esc(row[`${f.key}_name`] || 'file')} <label class="check inline"><input type="checkbox" name="${f.key}_remove"> remove</label></span>` : ''}`;
    case 'p': return `<input class="input" type="password" ${n} autocomplete="new-password" placeholder="${row[`${f.key}_set`] ? 'Leave blank to keep the current password' : ''}">`;
    case 'd': return `<input class="input" type="date" ${n} value="${esc(v)}">`;
    case 'n': return `<input class="input" ${n} inputmode="decimal" value="${esc(v)}">`;
    case 'tm': return `<input class="input" type="time" ${n} value="${esc(v)}">`;
    case 'e': return `<input class="input" type="email" ${n} value="${esc(v)}" maxlength="300">`;
    case 'm': return `<input class="input" type="tel" ${n} value="${esc(v)}" maxlength="10" inputmode="numeric">`;
    case 'z': return `<input class="input" ${n} value="${esc(v)}" maxlength="6" inputmode="numeric">`;
    default: return `<input class="input" ${n} value="${esc(v)}" maxlength="300">`;
  }
}

export function openForm(key, row, fixed = {}, onSaved, defaults = {}) {
  const e = META.entities[key];
  const r = row || { ...defaults };
  const fields = e.fields.filter((f) => !['sys', 'h'].includes(f.type) && fixed[f.key] === undefined);
  const wide = (f) => ['a', 'x'].includes(f.type);
  const m = modal({
    title: `${row ? 'Edit' : 'Add'} ${e.title}`, size: 'wide',
    body: `<form class="form-grid" novalidate><div class="alert err full" hidden data-err></div>
      ${key === 'tasks' && r.reject_reason ? `<div class="alert warn full">Rejected: ${esc(r.reject_reason)}</div>` : ''}
      ${fields.map((f) => `<div class="field ${wide(f) ? 'full' : ''}" data-fw="${f.key}"><label for="fi-${f.key}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>${input(f, r[f.key] ?? (f.type === 'd' && f.required && !row && ['work_date', 'comm_date', 'train_date', 'raised_on', 'informed_on'].includes(f.key) ? today() : r[f.key]), r, fixed)}</div>`).join('')}
      ${key === 'locations' ? `<div class="field full"><button type="button" class="btn btn-sm" data-gps>${icon('pin')} Use my current location for latitude / longitude</button><span class="help">Stand at the client site and tap this to set the check-in geofence centre.</span></div>` : ''}
      </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>Save</button>',
  });
  const form = m.$('form');
  const clientSel = form.querySelector('[name=client]');
  const locField = e.fields.find((f) => f.key === 'loc');
  if (clientSel && locField) {
    clientSel.addEventListener('change', () => { form.querySelector('[name=loc]').innerHTML = refOptions(locField, null, clientSel.value); });
  }
  m.$('[data-gps]')?.addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    busy(b, true, 'Getting location…');
    try {
      const p = await getPosition();
      form.lat.value = p.coords.latitude.toFixed(6);
      form.lng.value = p.coords.longitude.toFixed(6);
      toast(`Location set (accuracy about ${Math.round(p.coords.accuracy)} m).`);
    } catch (err) { toast(err.message, 'err'); }
    busy(b, false);
  });

  m.$('[data-save]').addEventListener('click', async () => {
    const btn = m.$('[data-save]');
    showFormError(form, null);
    form.querySelectorAll('.field.bad').forEach((x) => x.classList.remove('bad'));
    const body = { ...fixed };
    try {
      for (const f of fields) {
        if (f.type === 'x') body[f.key] = [...form.querySelectorAll(`[name="${f.key}"]:checked`)].map((x) => x.value);
        else if (f.type === 'c') body[f.key] = form.querySelector(`[name="${f.key}"]`).checked ? 1 : 0;
        else if (f.type === 'f') {
          const file = form.querySelector(`[name="${f.key}"]`).files[0];
          if (file) {
            if (file.size > 10 * 1024 * 1024) throw Object.assign(new Error(`${f.label}: the file is larger than 10 MB.`), { data: { field: f.key } });
            body[f.key] = { name: file.name, data: await readFileBase64(file) };
          } else body[f.key] = '';
          if (form.querySelector(`[name="${f.key}_remove"]`)?.checked) body[`${f.key}_remove`] = 1;
        } else body[f.key] = form.querySelector(`[name="${f.key}"]`).value;
      }
      busy(btn, true);
      const res = await api(row ? `/impl/e/${key}/${row.id}` : `/impl/e/${key}`, { method: row ? 'PUT' : 'POST', body });
      m.close();
      toast(res.approval === 'Pending approval' ? 'Saved and sent for approval.' : res.generated ? `Saved. ${res.generated} standard task(s) created.` : row ? 'Updated.' : 'Saved.');
      if (['locations', 'templates', 'sorders', 'masters'].includes(key)) await refreshLookups();
      onSaved && onSaved();
    } catch (err) {
      showFormError(form, err);
      const fk = err.data && err.data.field;
      const w = fk && form.querySelector(`[data-fw="${fk}"]`);
      if (w) { w.classList.add('bad'); w.querySelector('input,select,textarea')?.focus(); }
      busy(btn, false);
    }
  });
}

export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This device does not support location.'));
    navigator.geolocation.getCurrentPosition(resolve, (err) => reject(new Error(err.code === 1
      ? 'Location permission was denied. Allow location for this site in the browser settings.'
      : 'Could not get your location. Turn on GPS / location and try again.')), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}

/* ------------------------------- Simple pages ------------------------------ */

function pageHead(title, sub, actions = '') {
  return `<div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div><div class="actions">${actions}</div></div>`;
}

export function entityPage(key, title, sub, extraKeys = []) {
  return async (root) => {
    await boot();
    root.innerHTML = pageHead(title, sub) + [key, ...extraKeys].filter((k) => META.entities[k]).map((k) => `<div data-c="${k}"></div>`).join('');
    for (const k of [key, ...extraKeys]) if (META.entities[k]) await crudCard(root.querySelector(`[data-c="${k}"]`), k);
  };
}

/* -------------------------------- Dashboard -------------------------------- */

const COLORS = ['#2c6a98', '#12932f', '#0ea5e9', '#f59e0b', '#dc2626', '#64748b', '#7c5cfc'];
const STATUS_COLORS = ['#94a3b8', '#2c6a98', '#f59e0b', '#12932f', '#7c5cfc'];
let charts = [];
async function chart(canvas, type, labels, datasets) {
  await loadScript('/vendor/chart/chart.umd.js');
  const c = new window.Chart(canvas, {
    type, data: { labels, datasets },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: /pie|doughnut/.test(type) || datasets.length > 1, position: 'bottom' } },
      ...(/pie|doughnut/.test(type) ? {} : { scales: { y: { beginAtZero: true } } }) },
  });
  charts.push(c);
  return c;
}
const clearCharts = () => { charts.forEach((c) => c.destroy()); charts = []; };

function engineerCard(s) {
  const tone = s.progress >= 75 ? 'var(--green)' : s.progress >= 40 ? 'var(--primary)' : 'var(--warning)';
  return `<div class="card eng-card">
    <div class="eng-top"><span class="avatar">${esc(s.name.split(' ').map((x) => x[0]).join('').slice(0, 2))}</span>
      <div><b>${esc(s.name)}</b><div class="help">${esc(s.clients.join(', ') || 'Not assigned')}</div></div>
      <span class="spacer"></span>${s.today ? badge('Completed').replace('Completed', 'Report submitted') : '<span class="badge bad">Report missing</span>'}</div>
    <div class="eng-mid"><div class="ring" style="--p:${s.progress};--c:${tone}"><b>${s.progress}%</b></div>
      <div><div class="eng-tags">${badge('Completed')} ${s.done} ${badge('Pending')} ${s.pending} ${s.overdue ? `<span class="badge bad">Overdue ${s.overdue}</span>` : ''}</div>
        <div class="help">${icon('pin')} ${esc(s.locations.join(', ') || '—')}</div>
        <div class="help">Today: ${s.today ? esc(`${s.today.module} – ${s.today.task} (${s.today.pct}%, ${s.today.hours} h, ${s.today.mode})`) : 'No update yet'}</div>
        <div class="help">Attendance: ${s.attendance ? `in ${esc((s.attendance.in || '').slice(11, 16))}${s.attendance.out ? `, out ${esc(s.attendance.out.slice(11, 16))}` : ''}` : 'not checked in'}</div></div></div>
    <div class="eng-foot"><span>${fmtNum(s.hours)} h</span><span>${s.reports} reports</span><span>${s.visits} visits</span><span>${s.calls} calls</span></div></div>`;
}

export async function renderImplDashboard(root) {
  await boot();
  clearCharts();
  const d = await api('/impl/dashboard');
  const k = d.kpi;
  const kpi = (v, label, cls, ic) => `<div class="card kpi ${cls}"><span class="kpi-icon">${icon(ic)}</span><div class="label">${label}</div><div class="value">${fmtNum(v)}</div></div>`;
  root.innerHTML = pageHead('Implementation Dashboard', 'Progress across clients, locations and engineers.') + `
    <div class="grid kpis kpis-6">
      ${kpi(k.clients, 'Clients', 'k1', 'briefcase')}${kpi(k.locations, 'Locations', 'k3', 'pin')}${kpi(k.pendingTasks, 'Pending tasks', 'k4', 'layers')}
      ${kpi(k.overdueTasks, 'Overdue tasks', 'k5', 'calendar')}${kpi(k.openIssues, 'Open issues / CRs', 'k4', 'bug')}
      ${k.missingReports !== null ? kpi(k.missingReports, 'Missing daily reports today', 'k5', 'file') : ''}
      ${META.entities.amc ? kpi(k.amcExpiring, 'AMC expiring soon', 'k6', 'shield') : ''}${META.entities.sorders ? kpi(k.todaysSalesOrders, "Today's sales orders", 'k2', 'invoice') : ''}
      ${can('task.approve') ? kpi(k.pendingApprovals, 'Tasks waiting approval', 'k1', 'check') : ''}
    </div>
    <div class="chart-grid">
      <div class="card"><div class="card-head"><h3>Task status</h3></div><div class="chart-box"><canvas data-c1></canvas></div></div>
      <div class="card"><div class="card-head"><h3>Location-wise progress %</h3></div><div class="chart-box"><canvas data-c2></canvas></div></div>
      <div class="card"><div class="card-head"><h3>Engineer progress % and hours</h3></div><div class="chart-box"><canvas data-c3></canvas></div></div>
      <div class="card"><div class="card-head"><h3>Daily hours (last 14 days)</h3></div><div class="chart-box"><canvas data-c4></canvas></div></div>
      ${d.salesBySource ? '<div class="card"><div class="card-head"><h3>Sales orders by source</h3></div><div class="chart-box"><canvas data-c5></canvas></div></div>' : ''}
    </div>
    <h2 class="section-h">Engineer status</h2>
    <div class="eng-grid">${d.engineers.map(engineerCard).join('') || '<div class="card empty small">No engineers assigned yet.</div>'}</div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h3>Location-wise progress</h3></div><div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Client</th><th>Location</th><th class="num">Tasks</th><th class="num">Completed</th><th>Progress</th></tr></thead><tbody>
      ${d.locationProgress.map((l) => `<tr><td>${esc(l.client)}</td><td>${esc(l.name)}</td><td class="num">${l.tasks}</td><td class="num">${l.done}</td><td>${bar(l.progress)}</td></tr>`).join('') || '<tr><td colspan="5">No locations yet.</td></tr>'}</tbody></table></div></div>
    ${d.latestSalesOrders.length ? `<div class="card" style="margin-top:16px"><div class="card-head"><h3>Latest sales orders</h3></div><div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Sales order</th><th>Date</th><th>Clients</th><th>Source</th><th class="num">Amount</th></tr></thead><tbody>
      ${d.latestSalesOrders.map((s) => `<tr><td><b>${esc(s.so_no)}</b></td><td>${fmtDate(s.so_date)}</td><td>${esc(s.clients || '—')}</td><td>${esc(s.source)}</td><td class="num">${fmtMoney(s.amount)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
  const $ = (s) => root.querySelector(s);
  await chart($('[data-c1]'), 'doughnut', d.statuses, [{ data: d.taskStatus, backgroundColor: STATUS_COLORS }]);
  await chart($('[data-c2]'), 'bar', d.locationProgress.map((l) => l.name), [{ label: 'Progress %', data: d.locationProgress.map((l) => l.progress), backgroundColor: COLORS[0], borderRadius: 6 }]);
  await chart($('[data-c3]'), 'bar', d.engineers.map((s) => s.name), [{ label: 'Avg progress %', data: d.engineers.map((s) => s.progress), backgroundColor: COLORS[0], borderRadius: 6 }, { label: 'Hours', data: d.engineers.map((s) => s.hours), backgroundColor: COLORS[3], borderRadius: 6 }]);
  await chart($('[data-c4]'), 'line', d.dailyHours.days.map(fmtDate), [{ label: 'Hours', data: d.dailyHours.hours, borderColor: COLORS[0], backgroundColor: COLORS[0], tension: 0.3 }]);
  if (d.salesBySource) await chart($('[data-c5]'), 'pie', d.salesBySource.map((x) => x[0]), [{ data: d.salesBySource.map((x) => x[1]), backgroundColor: COLORS }]);
  return clearCharts;
}

/* --------------------------------- My Day ---------------------------------- */

export async function renderMyDay(root) {
  await boot();
  const d = await api('/impl/myday');
  const nl = (c, l) => `${esc(refLabel('clients', c))}${l ? ` / ${esc(refLabel('locations', l))}` : ''}`;
  const tbl = (head, rows) => (rows.length ? `<div class="table-wrap"><table class="tbl tbl-compact"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="empty small">Nothing here.</div>');
  const btn = (k, id, label) => `<button class="btn btn-sm" data-ed="${k}:${id}">${label}</button>`;
  const ent = (k) => META.entities[k];
  root.innerHTML = pageHead(`My Day`, `${fmtDate(d.today)} · your plan for today`) + `
    <div class="card card-body myday-top">
      <div>${d.todayReports.length ? '<span class="badge ok">Daily report submitted</span>' : '<span class="badge bad">Daily report not submitted</span>'}</div>
      <div class="actions">
        ${ent('daily')?.canWrite ? `<button class="btn btn-primary" data-new="daily">${icon('plus')} Submit daily report</button>` : ''}
        ${ent('comms')?.canWrite ? `<button class="btn" data-new="comms">+ Communication</button>` : ''}
        ${ent('training')?.canWrite ? `<button class="btn" data-new="training">+ Training</button>` : ''}
        ${ent('issues')?.canWrite ? `<button class="btn" data-new="issues">+ Issue / CR</button>` : ''}
        ${ent('visits')?.canWrite ? `<button class="btn" data-new="visits">+ Plan visit</button>` : ''}
        ${state.user.face_attendance ? `<a class="btn" href="#/attendance">${icon('user')} Attendance</a>` : ''}
      </div></div>
    <div class="card"><div class="card-head"><h3>Tasks due or overdue (next 3 days)</h3></div>${tbl(['Location', 'Module', 'Task', 'Target', 'Status', ''], d.tasks.map((t) => [nl(t.client, t.loc), esc(t.module), esc(t.task), fmtDate(t.target_on) + (t.target_on < d.today ? ' <span class="badge bad">Overdue</span>' : ''), badge(t.status), btn('tasks', t.id, 'Update')]))}</div>
    <div class="card"><div class="card-head"><h3>Visits to do</h3></div>${tbl(['Location', 'Planned', 'Purpose', ''], d.visits.map((v) => [nl(v.client, v.loc), fmtDate(v.planned_on), esc(v.purpose), btn('visits', v.id, 'Check in / update')]))}</div>
    <div class="card"><div class="card-head"><h3>Follow-ups due</h3></div>${tbl(['Location', 'Spoke to', 'Follow-up', ''], d.followUps.map((c) => [nl(c.client, c.loc), esc(c.spoke_to), fmtDate(c.next_on), btn('comms', c.id, 'Update')]))}</div>
    <div class="card"><div class="card-head"><h3>Open issues and CRs</h3></div>${tbl(['Location', 'Type', 'Title', 'Priority', 'Status', ''], d.issues.map((i) => [nl(i.client, i.loc), esc(i.issue_type), esc(i.title), badge(i.priority), badge(i.status), btn('issues', i.id, 'Update')]))}</div>
    <div class="card"><div class="card-head"><h3>Today's report entries</h3></div>${tbl(['Location', 'Module', 'Task', '%', 'Status', ''], d.todayReports.map((r) => [nl(r.client, r.loc), esc(r.module), esc(r.task), fmtNum(r.pct), badge(r.status), btn('daily', r.id, 'Edit')]))}</div>`;
  const all = { tasks: d.tasks, visits: d.visits, comms: d.followUps, issues: d.issues, daily: d.todayReports };
  const again = () => renderMyDay(root);
  root.querySelectorAll('[data-ed]').forEach((b) => b.addEventListener('click', () => {
    const [k, id] = b.dataset.ed.split(':');
    openForm(k, all[k].find((x) => x.id === +id), {}, again);
  }));
  root.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => openForm(b.dataset.new, null, {}, again, { work_date: d.today })));
}

/* ------------------------------- Clients / 360 ------------------------------ */

export async function renderImplClients(root) {
  await boot(true);
  const id = +new URLSearchParams(location.hash.split('?')[1] || '').get('id');
  if (id) return client360(root, id);
  const counts = {};
  LK.locations.forEach((l) => { counts[l.client] = (counts[l.client] || 0) + 1; });
  root.innerHTML = pageHead('Clients', META.seesAll ? 'All clients. Open one for its locations, modules, go-live and documents.' : 'Clients you are assigned to.',
    can('client.manage') ? `<a class="btn" href="#/clients">${icon('edit')} Client master</a>` : '') + `
    <div class="card"><div class="toolbar"><input class="input" data-q placeholder="Search clients…" aria-label="Search clients"></div><div class="table-wrap" data-t></div></div>`;
  const draw = () => {
    const term = root.querySelector('[data-q]').value.trim().toLowerCase();
    const list = LK.clients.filter((c) => !term || `${c.name} ${c.client_code || ''} ${c.city || ''}`.toLowerCase().includes(term));
    root.querySelector('[data-t]').innerHTML = list.length ? `<table class="tbl tbl-compact"><thead><tr><th>Client</th><th>Code</th><th>Type</th><th>City</th><th class="num">Locations</th><th>Status</th><th class="row-actions"></th></tr></thead><tbody>
      ${list.map((c) => `<tr><td><a href="#/impl-clients?id=${c.id}"><b>${esc(c.name)}</b></a></td><td>${esc(c.client_code || '—')}</td><td>${esc(c.client_type || '—')}</td><td>${esc(c.city || '—')}</td><td class="num">${counts[c.id] || 0}</td><td>${badge(c.status)}</td>
        <td class="row-actions"><a class="btn btn-sm" href="#/impl-clients?id=${c.id}">${icon('arrow')} Open</a></td></tr>`).join('')}</tbody></table>` : '<div class="empty"><b>No clients</b>Clients are added in the client master.</div>';
  };
  root.querySelector('[data-q]').addEventListener('input', draw);
  draw();
}

const TABS = [
  ['Overview'], ['Locations', 'locations'], ['Modules', 'cmods'], ['Tasks', 'tasks'], ['Contacts', 'contacts'], ['Sales orders', 'solines'],
  ['Engineers', 'assign'], ['Templates', 'ctemplates'], ['Infra', 'infra'], ['Hardware', 'hw'], ['Servers', 'servers'], ['Go-Live', 'golive'],
  ['Training', 'training'], ['Visits', 'visits'], ['Communication', 'comms'], ['Issues', 'issues'], ['AMC', 'amc'], ['Documents'], ['Timeline'],
];
const c360 = { tab: 'Overview', loc: '' };

async function client360(root, id) {
  const client = LK.clients.find((c) => c.id === id);
  if (!client) { root.innerHTML = '<div class="alert err">Client not found or not assigned to you.</div>'; return; }
  if (c360.client !== id) Object.assign(c360, { client: id, tab: 'Overview', loc: '' });
  const tabs = TABS.filter((t) => !t[1] || META.entities[t[1]]);
  const locs = LK.locations.filter((l) => l.client === id);
  root.innerHTML = `<a class="btn btn-sm btn-ghost" href="#/impl-clients">← All clients</a>
    <div class="card card-body c360-head"><div><h1>${esc(client.name)} ${client.client_type ? `<span class="badge info plain">${esc(client.client_type)}</span>` : ''}</h1>
      <div class="help">${esc([client.client_code, client.city].filter(Boolean).join(' · '))}</div></div>
      <div class="field"><label for="c360-loc">Location</label><select id="c360-loc" class="input"><option value="">All locations</option>${locs.map((l) => `<option value="${l.id}" ${String(l.id) === String(c360.loc) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div></div>
    <div class="stage-tabs c360-tabs" role="tablist">${tabs.map((t) => `<button type="button" role="tab" class="stage-tab ${t[0] === c360.tab ? 'active' : ''}" data-tab="${t[0]}">${t[0]}</button>`).join('')}</div>
    <div data-body style="margin-top:14px"><div class="empty">Loading…</div></div>`;
  root.querySelector('#c360-loc').addEventListener('change', (ev) => { c360.loc = ev.target.value; client360(root, id); });
  root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { c360.tab = b.dataset.tab; client360(root, id); }));
  const body = root.querySelector('[data-body]');
  const tab = tabs.find((t) => t[0] === c360.tab) || tabs[0];
  const fixed = { client: id };
  if (c360.loc && tab[1] && META.entities[tab[1]].fields.some((f) => f.key === 'loc') && tab[1] !== 'locations') fixed.loc = +c360.loc;

  if (tab[0] === 'Overview' || tab[0] === 'Documents' || tab[0] === 'Timeline') {
    const d = await api(`/impl/client/${id}`);
    const byLoc = (x) => !c360.loc || x.id === +c360.loc;
    if (tab[0] === 'Overview') {
      const c = d.client;
      body.innerHTML = `<div class="card card-body"><dl class="details">
          <div><dt>Code</dt><dd>${esc(c.client_code || '—')}</dd></div><div><dt>GSTIN</dt><dd>${esc(c.gstin || '—')}</dd></div><div><dt>Phone</dt><dd>${esc(c.phone || '—')}</dd></div>
          <div><dt>Contact</dt><dd>${esc(c.contact_person || '—')}</dd></div><div><dt>Email</dt><dd>${esc(c.contact_email || '—')}</dd></div><div><dt>Task approval</dt><dd>${esc(c.task_approval || 'Default')}</dd></div></dl></div>
        <div class="card"><div class="card-head"><h3>Locations</h3></div><div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Location</th><th>Engineers</th><th class="num">Modules (done)</th><th class="num">Templates (back)</th><th>Current go-live stage</th><th class="num">Beds</th><th class="num">Licences</th><th>Progress</th><th>Geofence</th></tr></thead><tbody>
        ${d.overview.filter(byLoc).map((l) => `<tr><td><b>${esc(l.name)}</b><span class="sub">${esc(l.address)}</span></td><td>${esc(l.engineers || '—')}</td><td class="num">${l.modules} (${l.modulesDone})</td><td class="num">${l.templates} (${l.templatesBack})</td><td>${esc(l.stage)}</td><td class="num">${fmtNum(l.beds)}</td><td class="num">${fmtNum(l.licences)}</td><td>${bar(l.progress)}</td><td>${esc(l.geofence)}</td></tr>`).join('') || '<tr><td colspan="9">No locations yet. Add them in the Locations tab.</td></tr>'}
        </tbody></table></div></div>
        <div class="card"><div class="card-head"><h3>Go-Live stage tracker</h3></div><div class="card-body">${d.overview.filter(byLoc).map((l) => `<div class="gl-row"><b>${esc(l.name)}</b><div class="gl-steps">${META.goLiveStages.map((g) => {
          const r = d.goLive.find((x) => x.loc === l.id && x.stage === g);
          const s = r ? r.status : 'Not Started';
          return `<div class="gl-step ${BADGE[s] || 'off'}"><span>${esc(g)}</span><small>${r ? fmtDate(r.actual_on || r.planned_on) : '—'}</small></div>`;
        }).join('')}</div></div>`).join('') || '<div class="help">No locations.</div>'}</div></div>`;
    } else if (tab[0] === 'Documents') {
      const locName = c360.loc ? (locs.find((l) => l.id === +c360.loc) || {}).name : '';
      const docs = d.documents.filter((x) => !locName || x.location === locName || x.location === 'All');
      body.innerHTML = `<div class="card"><div class="card-head"><h3>Documents (${docs.length})</h3></div><div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Type</th><th>Record</th><th>Location</th><th>Date</th><th>File</th></tr></thead><tbody>
        ${docs.map((x) => `<tr><td>${esc(x.type)}</td><td>${esc(x.record || '')}</td><td>${esc(x.location)}</td><td>${fmtDate(x.date)}</td><td>${fileBtn(x.file, x.name)}</td></tr>`).join('') || '<tr><td colspan="5">No documents yet.</td></tr>'}</tbody></table></div></div>`;
      fileClick(body);
    } else {
      const locName = c360.loc ? (locs.find((l) => l.id === +c360.loc) || {}).name : '';
      const ev = d.timeline.filter((x) => !locName || x.location === locName);
      const ICON = { order: 'invoice', rocket: 'trend', pin: 'pin', cap: 'users', chat: 'send', bug: 'bug', check: 'check', file: 'file' };
      body.innerHTML = `<div class="card"><div class="card-head"><h3>Timeline (${ev.length})</h3></div><ul class="tl">${ev.map((x) => `<li><span class="tl-date">${fmtDate(x.date)}</span><span class="tl-ico">${icon(ICON[x.icon] || 'file')}</span><span class="tl-text">${esc(x.text)}</span><span class="help">${esc(x.location)}</span></li>`).join('') || '<li class="help">No events yet.</li>'}</ul></div>`;
    }
    return;
  }

  const tools = [];
  if (tab[1] === 'cmods' && can('impl.manage')) tools.push(`<button class="btn btn-sm" data-bulk="modules">${icon('plus')} Quick add modules</button>`, `<button class="btn btn-sm" data-gen>${icon('layers')} Generate standard tasks</button>`);
  if (tab[1] === 'ctemplates' && can('impl.manage')) tools.push(`<button class="btn btn-sm" data-bulk="templates">${icon('plus')} Quick enable templates</button>`);
  body.innerHTML = `${tools.length ? `<div class="actions" style="margin-bottom:10px">${tools.join('')}</div>` : ''}<div data-crud></div>`;
  const crud = await crudCard(body.querySelector('[data-crud]'), tab[1], {
    fixed,
    onChange: async () => { if (tab[1] === 'locations') { await refreshLookups(); client360(root, id); } },
  });
  body.querySelector('[data-gen]')?.addEventListener('click', async () => {
    try { const r = await api('/impl/generate-tasks', { method: 'POST', body: { client: id, loc: c360.loc || '' } }); toast(`${r.created} standard task(s) created.`); crud.reload(); } catch (err) { toast(err.message, 'err'); }
  });
  body.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', () => bulkAdd(b.dataset.bulk, id, locs, () => crud.reload())));
}

function bulkAdd(kind, clientId, locs, done) {
  const items = kind === 'modules' ? (LK.masters.Module || []).map((m) => [m, m]) : LK.templates.map((t) => [t.id, `${t.name} ${t.version}`]);
  const m = modal({
    title: kind === 'modules' ? 'Quick add modules' : 'Quick enable templates', size: 'wide',
    body: `<form class="grid" novalidate><div class="alert err" hidden data-err></div>
      <div class="field"><label>Locations</label><div class="dept-chips">${locs.map((l) => `<label class="dept-chip"><input type="checkbox" name="locs" value="${l.id}" ${String(l.id) === String(c360.loc) || !c360.loc ? 'checked' : ''}><span>${esc(l.name)}</span></label>`).join('') || '<span class="help">Add a location first.</span>'}</div></div>
      <div class="field"><label>${kind === 'modules' ? 'Modules' : 'Templates'}</label><div class="dept-chips">${items.map(([v, n]) => `<label class="dept-chip"><input type="checkbox" name="values" value="${esc(v)}"><span>${esc(n)}</span></label>`).join('')}</div></div>
      ${kind === 'modules' ? '<div class="field"><label>New module (optional)</label><input class="input" name="custom" maxlength="150" placeholder="Type a module name not in the list"></div>' : ''}</form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>Add</button>',
  });
  m.$('[data-save]').addEventListener('click', async () => {
    const form = m.$('form');
    const values = [...form.querySelectorAll('[name=values]:checked')].map((x) => x.value);
    const custom = form.custom && form.custom.value.trim();
    if (custom) values.push(custom);
    try {
      const r = await api('/impl/bulk', { method: 'POST', body: { kind, client: clientId, locs: [...form.querySelectorAll('[name=locs]:checked')].map((x) => x.value), values } });
      m.close();
      toast(`${r.added} added${r.tasks ? `, ${r.tasks} standard tasks created` : ''}.`);
      done();
    } catch (err) { showFormError(form, err); }
  });
}

/* ------------------------------ Task approvals ------------------------------ */

export async function renderTaskApprovals(root) {
  await boot();
  const rows = await api('/impl/approvals');
  root.innerHTML = pageHead('Task Approvals', `Completed tasks waiting for approval (global setting: ${META.settings.approval_global === '1' ? 'ON' : 'OFF'}).`) + `
    <div class="card"><div class="table-wrap">${rows.length ? `<table class="tbl tbl-compact"><thead><tr><th>Client</th><th>Location</th><th>Module</th><th>Task</th><th>Completed</th><th>Evidence</th><th class="row-actions">Action</th></tr></thead><tbody>
      ${rows.map((t) => `<tr><td>${esc(refLabel('clients', t.client))}</td><td>${esc(refLabel('locations', t.loc) || '—')}</td><td>${esc(t.module)}</td><td><b>${esc(t.task)}</b></td><td>${fmtDate(t.done_on)}</td><td>${t.evidence ? fileBtn(t.evidence, t.evidence_name) : '—'}</td>
        <td class="row-actions">${can('task.approve') ? `<button class="btn btn-sm btn-primary" data-ok="${t.id}">Approve</button> <button class="btn btn-sm btn-danger" data-no="${t.id}">Reject</button>` : 'No permission'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty"><b>Nothing to approve</b>Completed tasks needing approval appear here.</div>'}</div></div>`;
  fileClick(root);
  const again = () => renderTaskApprovals(root);
  root.querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/impl/tasks/${b.dataset.ok}/approve`, { method: 'POST', body: {} }); toast('Approved.'); again(); } catch (err) { toast(err.message, 'err'); }
  }));
  root.querySelectorAll('[data-no]').forEach((b) => b.addEventListener('click', async () => {
    const reason = await confirmDialog({ title: 'Reject task', message: 'The task goes back to In Progress with your reason.', confirmText: 'Reject', danger: true, reasonLabel: 'Reason' });
    if (!reason) return;
    try { await api(`/impl/tasks/${b.dataset.no}/reject`, { method: 'POST', body: { reason } }); toast('Rejected.'); again(); } catch (err) { toast(err.message, 'err'); }
  }));
}

/* -------------------------------- Reports --------------------------------- */

const rep = { key: 'eng', client: '', loc: '', eng: '', from: '', to: '' };
export async function renderImplReports(root) {
  await boot();
  clearCharts();
  const list = await api('/impl/reports');
  if (!list.some((r) => r.key === rep.key)) rep.key = list[0].key;
  const f = { client: rep.client, loc: rep.loc, eng: rep.eng, from: rep.from, to: rep.to };
  const d = await api(`/impl/reports/${rep.key}${qs(f)}`);
  root.innerHTML = pageHead('Implementation Reports', 'Pick a report, filter it, and download it as Excel or PDF.') + `
    <div class="stage-tabs card" style="margin-bottom:14px">${list.map((r) => `<button type="button" class="stage-tab ${r.key === rep.key ? 'active' : ''}" data-rk="${r.key}">${esc(r.title)}</button>`).join('')}</div>
    <form class="card card-body" style="margin-bottom:16px" data-f novalidate><div class="filters">
      <div class="field"><label>Client</label><select class="input" name="client"><option value="">All clients</option>${LK.clients.map((c) => `<option value="${c.id}" ${String(c.id) === String(rep.client) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Location</label><select class="input" name="loc"><option value="">All locations</option>${LK.locations.filter((l) => !rep.client || l.client === +rep.client).map((l) => `<option value="${l.id}" ${String(l.id) === String(rep.loc) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      ${META.seesAll ? `<div class="field"><label>Engineer</label><select class="input" name="eng"><option value="">All engineers</option>${LK.users.map((u) => `<option value="${u.id}" ${String(u.id) === String(rep.eng) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>From date</label><input class="input" type="date" name="from" value="${esc(rep.from)}"></div>
      <div class="field"><label>To date</label><input class="input" type="date" name="to" value="${esc(rep.to)}"></div>
      <div class="btns"><button type="button" class="btn" data-xl>${icon('excel')} Excel</button><button type="button" class="btn" data-pdf>${icon('pdf')} PDF</button></div>
    </div></form>
    <div class="card"><div class="card-head"><h3>${esc(d.title)}</h3><small>${d.rows.length} rows</small></div><div class="chart-box"><canvas data-chart></canvas></div></div>
    <div class="card"><div class="table-wrap">${d.rows.length ? `<table class="tbl tbl-compact"><thead><tr>${d.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${d.rows.map((r) => `<tr>${r.map((c) => `<td>${BADGE[c] ? badge(c) : esc(c ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<div class="empty small"><b>No rows</b>Try different filters.</div>'}</div></div>`;
  root.querySelectorAll('[data-rk]').forEach((b) => b.addEventListener('click', () => { rep.key = b.dataset.rk; renderImplReports(root); }));
  root.querySelector('[data-f]').addEventListener('change', (ev) => {
    rep[ev.target.name] = ev.target.value;
    if (ev.target.name === 'client') rep.loc = '';
    renderImplReports(root);
  });
  root.querySelector('[data-xl]').addEventListener('click', () => download(`/impl/reports/${rep.key}${qs({ ...f, format: 'xlsx' })}`).catch((err) => toast(err.message, 'err')));
  root.querySelector('[data-pdf]').addEventListener('click', () => download(`/impl/reports/${rep.key}${qs({ ...f, format: 'pdf' })}`).catch((err) => toast(err.message, 'err')));
  const c = d.chart;
  const pie = /pie|doughnut/.test(c.type);
  await chart(root.querySelector('[data-chart]'), c.type, c.labels, c.data.map((data, i) => ({
    label: (c.series || [])[i] || '', data, backgroundColor: pie ? (c.labels.length === 5 ? STATUS_COLORS : COLORS) : COLORS[i * 3 % COLORS.length],
    borderColor: COLORS[i], tension: 0.3, borderRadius: pie ? 0 : 6,
  })));
  return clearCharts;
}

/* --------------------------------- Masters --------------------------------- */

let masterTab = 'Module';
export async function renderImplMasters(root) {
  await boot(true);
  const types = (META.entities.masters.fields.find((f) => f.key === 'mtype').options);
  const tabs = [...types, 'Standard tasks', ...(can('impl.settings') ? ['Settings'] : [])];
  root.innerHTML = pageHead('Implementation Masters', 'Drop-down lists, standard tasks per module and implementation settings.') + `
    <div class="stage-tabs card" style="margin-bottom:14px">${tabs.map((t) => `<button type="button" class="stage-tab ${t === masterTab ? 'active' : ''}" data-mt="${esc(t)}">${esc(t)}</button>`).join('')}</div><div data-b></div>`;
  root.querySelectorAll('[data-mt]').forEach((b) => b.addEventListener('click', () => { masterTab = b.dataset.mt; renderImplMasters(root); }));
  const b = root.querySelector('[data-b]');
  if (masterTab === 'Standard tasks') return crudCard(b, 'stdtasks', { title: 'Standard tasks (created automatically when a module is added)' });
  if (masterTab === 'Settings') {
    const s = META.settings;
    b.innerHTML = `<form class="card card-body" novalidate><div class="alert err" hidden data-err></div><div class="form-grid">
      <div class="field"><label>Approval for completed tasks (global)</label><select class="input" name="approval_global"><option value="1" ${s.approval_global === '1' ? 'selected' : ''}>ON – tasks completed by engineers need approval</option><option value="0" ${s.approval_global === '0' ? 'selected' : ''}>OFF</option></select><span class="help">Each client can override this in the client master (Task approval: On / Off / Default).</span></div>
      <div class="field"><label>AMC alert days</label><input class="input" name="amc_alert_days" value="${esc(s.amc_alert_days)}"><span class="help">e.g. 30,15,7 — AMC ending within the largest number shows on the dashboard.</span></div>
      </div><div class="actions" style="justify-content:flex-end;margin-top:10px"><button class="btn btn-primary" type="submit">Save settings</button></div></form>`;
    b.querySelector('form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      try { META.settings = await api('/impl/settings', { method: 'PUT', body: { approval_global: form.approval_global.value, amc_alert_days: form.amc_alert_days.value } }); toast('Settings saved.'); } catch (err) { showFormError(form, err); }
    });
    return;
  }
  return crudCard(b, 'masters', { fixed: { mtype: masterTab }, title: masterTab });
}

/* ------------------------------- Sales orders ------------------------------- */

export const renderSalesOrders = entityPage('sorders', 'Sales Orders', 'HIMS sale orders. Add the clients and locations it covers; their modules and standard tasks are created automatically.', ['solines', 'sodocs']);

/* -------------------------- Implementation employees -------------------------- */

export async function renderEmployees(root) {
  const d = await api('/impl/employees');
  root.innerHTML = pageHead('Implementation Employees', 'Users who sign in to Implementation only. They have no access to Ticket Tracking.',
    `<button class="btn btn-primary" data-add>${icon('plus')} Add Employee</button>`) + `
    <div class="card"><div class="toolbar"><input class="input" data-q placeholder="Search employees…" aria-label="Search employees"><span class="help" data-count style="margin-left:auto"></span></div>
    <div class="table-wrap" data-t></div></div>`;
  const draw = () => {
    const term = root.querySelector('[data-q]').value.trim().toLowerCase();
    const list = d.rows.filter((r) => !term || `${r.employee_name} ${r.employee_code} ${r.username} ${r.email} ${r.role_name}`.toLowerCase().includes(term));
    root.querySelector('[data-count]').textContent = `${list.length} employee(s)`;
    root.querySelector('[data-t]').innerHTML = list.length ? `<table class="tbl tbl-compact"><thead><tr><th>Employee</th><th>Username</th><th>Role</th><th>Department</th><th>Mobile</th><th>Face attendance</th><th>Status</th><th>Last sign-in</th><th class="row-actions"></th></tr></thead><tbody>
      ${list.map((r) => `<tr class="${r.status !== 'Active' ? 'row-muted' : ''}"><td><b>${esc(r.employee_name)}</b><span class="sub">${esc(r.employee_code)} · ${esc(r.email)}</span></td>
        <td>${esc(r.username)}</td><td>${esc(r.role_name)}</td><td>${esc(r.department_name || '—')}</td><td>${esc(r.mobile || '—')}</td>
        <td>${r.face_attendance ? `<span class="badge ok">ON</span>${r.enrolled_at ? '<span class="sub">Face enrolled</span>' : '<span class="sub">Not enrolled yet</span>'}` : '<span class="badge off">OFF</span>'}</td>
        <td>${badge(r.status)}</td><td>${r.last_login_at ? fmtDateTime(r.last_login_at) : 'Never'}</td>
        <td class="row-actions"><button class="icon-btn" data-edit="${r.id}" title="Edit" aria-label="Edit">${icon('edit')}</button>
          <button class="btn btn-sm btn-ghost" data-st="${r.id}">${r.status === 'Active' ? 'Deactivate' : 'Activate'}</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty"><b>No Implementation employees yet</b>Use "Add Employee" to create one.</div>';
    root.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => employeeForm(d, d.rows.find((x) => x.id === +b.dataset.edit), () => renderEmployees(root))));
    root.querySelectorAll('[data-st]').forEach((b) => b.addEventListener('click', async () => {
      const r = d.rows.find((x) => x.id === +b.dataset.st);
      const to = r.status === 'Active' ? 'Inactive' : 'Active';
      if (to === 'Inactive' && !(await confirmDialog({ title: 'Deactivate employee', message: `Deactivate <b>${esc(r.employee_name)}</b>? They will be signed out and cannot sign in.`, confirmText: 'Deactivate', danger: true }))) return;
      try { await api(`/impl/employees/${r.id}/status`, { method: 'PATCH', body: { status: to } }); toast(`Employee ${to === 'Active' ? 'activated' : 'deactivated'}.`); renderEmployees(root); } catch (err) { toast(err.message, 'err'); }
    }));
  };
  root.querySelector('[data-q]').addEventListener('input', draw);
  root.querySelector('[data-add]').addEventListener('click', () => employeeForm(d, null, () => renderEmployees(root)));
  draw();
}

function employeeForm(d, r, done) {
  const v = r || { status: 'Active', face_attendance: 1, role_id: (d.roles.find((x) => x.name === 'Implementation Employee') || {}).id,
    department_id: (d.departments.find((x) => /implement/i.test(x.name)) || {}).id };
  const m = modal({
    title: r ? `Edit ${r.employee_name}` : 'Add Implementation Employee', size: 'wide',
    body: `<form class="form-grid" novalidate><div class="alert err full" hidden data-err></div>
      <div class="alert info full">This employee can sign in to <b>Implementation</b> only. Ticket Tracking stays blocked for them.</div>
      <div class="field"><label>Employee Name <span class="req">*</span></label><input class="input" name="employee_name" maxlength="150" value="${esc(v.employee_name)}"></div>
      <div class="field"><label>Employee Code <span class="req">*</span></label><input class="input" name="employee_code" maxlength="30" value="${esc(v.employee_code)}"></div>
      <div class="field"><label>Email ID <span class="req">*</span></label><input class="input" type="email" name="email" maxlength="150" value="${esc(v.email)}"></div>
      <div class="field"><label>Mobile Number</label><input class="input" type="tel" name="mobile" maxlength="15" value="${esc(v.mobile)}"></div>
      <div class="field"><label>Role <span class="req">*</span></label><select class="input" name="role_id"><option value="">Select role</option>${d.roles.map((x) => `<option value="${x.id}" ${x.id === v.role_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Department <span class="req">*</span></label><select class="input" name="department_id"><option value="">Select department</option>${d.departments.map((x) => `<option value="${x.id}" ${x.id === v.department_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Username <span class="req">*</span></label><input class="input" name="username" maxlength="50" autocomplete="off" value="${esc(v.username)}"></div>
      <div class="field"><label>${r ? 'New password (leave blank to keep)' : 'Password <span class="req">*</span>'}</label><input class="input" type="password" name="password" autocomplete="new-password"><span class="help">Min. 8 characters with a letter and a number. They must change it at first sign-in.</span></div>
      <div class="field"><label>Status</label><select class="input" name="status"><option ${v.status === 'Active' ? 'selected' : ''}>Active</option><option ${v.status === 'Inactive' ? 'selected' : ''}>Inactive</option></select></div>
      <div class="field"><label>Face attendance</label><label class="switch"><input type="checkbox" name="face_attendance" ${v.face_attendance ? 'checked' : ''}><span></span><b>Required</b></label><span class="help">Face check-in / check-out with live location.</span></div>
    </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>Save</button>',
  });
  const form = m.$('form');
  m.$('[data-save]').addEventListener('click', async () => {
    const btn = m.$('[data-save]');
    const body = Object.fromEntries(['employee_name', 'employee_code', 'email', 'mobile', 'role_id', 'department_id', 'username', 'password', 'status'].map((k) => [k, form[k].value]));
    body.face_attendance = form.face_attendance.checked ? 1 : 0;
    showFormError(form, null);
    busy(btn, true);
    try {
      await api(r ? `/impl/employees/${r.id}` : '/impl/employees', { method: r ? 'PUT' : 'POST', body });
      m.close();
      toast(r ? 'Employee updated.' : 'Employee created. Share the username and temporary password; they sign in with "Implementation".');
      await refreshLookups();
      done();
    } catch (err) { showFormError(form, err); busy(btn, false); }
  });
}
