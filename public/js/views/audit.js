import { api, esc, fmtDate, fmtDateTime, fmtNum, qs, pager, icon } from '../core.js';

const view = { entity: '', ticket: '', search: '', fromDate: '', toDate: '', page: 1, pageSize: 25 };

const ENTITY = { APPROVAL: 'Approval', USER: 'User', ROLE: 'Role', DEPARTMENT: 'Department', CLIENT: 'Client', AUTH: 'Sign-in' };
const ACTION_CLS = { CREATE: 'ok', UPDATE: 'info', ADDITIONAL_APPROVAL: 'info', DELETE: 'bad', DEACTIVATE: 'bad', ACTIVATE: 'ok', LOGIN: 'off' };

function describe(changes) {
  if (!changes) return '';
  return Object.entries(changes).filter(([k, c]) => k === 'additional_man_days' || JSON.stringify(c.from ?? null) !== JSON.stringify(c.to ?? null)).map(([k, c]) => {
    const f = (v) => (Array.isArray(v) ? `${v.length} permission(s)` : /date/.test(k) && typeof v === 'string' ? fmtDate(v) : v ?? '—');
    if (k === 'additional_man_days') return `+${fmtNum(c.to)} man-days`;
    return `${esc(k.replace(/_/g, ' '))}: <s>${esc(f(c.from))}</s> → ${esc(f(c.to))}`;
  }).join('<br>');
}

export async function renderAudit(root) {
  root.innerHTML = `
    <div class="page-head"><div><h1>Audit History</h1><p>Every creation, modification and deletion is recorded with user and timestamp.</p></div></div>
    <form class="card card-body" style="margin-bottom:16px" data-f novalidate>
      <div class="filters">
        <div class="field" data-entity-wrap><label>Record Type</label><select class="input" name="entity"><option value="">All</option>${Object.entries(ENTITY).map(([k, v]) => `<option value="${k}" ${view.entity === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label>Ticket Number</label><input class="input" name="ticket" value="${esc(view.ticket)}"></div>
        <div class="field"><label>User / Remarks</label><input class="input" name="search" value="${esc(view.search)}"></div>
        <div class="field"><label>From Date</label><input class="input" type="date" name="fromDate" value="${esc(view.fromDate)}"></div>
        <div class="field"><label>To Date</label><input class="input" type="date" name="toDate" value="${esc(view.toDate)}"></div>
        <div class="btns"><button class="btn btn-primary" type="submit">${icon('search')} Search</button><button class="btn" type="button" data-reset>Reset</button></div>
      </div>
    </form>
    <div class="card"><div class="table-wrap" data-table></div><div data-pager></div></div>`;
  const form = root.querySelector('[data-f]');

  async function load() {
    const data = await api('/audit' + qs(view));
    root.querySelector('[data-entity-wrap]').hidden = !data.isAdmin;
    const t = root.querySelector('[data-table]');
    t.innerHTML = data.rows.length ? `<table class="tbl"><thead><tr><th>Date &amp; Time</th><th>User</th><th>Record</th><th>Action</th><th>Ticket</th><th class="num">Previous Man-Days</th><th class="num">Updated Man-Days</th><th>Changes</th><th>Remarks</th></tr></thead><tbody>
      ${data.rows.map((r) => `<tr><td class="nowrap">${fmtDateTime(r.created_at)}</td><td>${esc(r.user_name)}</td><td>${esc(ENTITY[r.entity] || r.entity)}</td>
        <td><span class="badge ${ACTION_CLS[r.action] || 'off'}">${esc(r.action.replace(/_/g, ' '))}</span></td>
        <td class="ticket">${esc(r.ticket_number) || ''}</td><td class="num">${r.prev_man_days === null ? '—' : fmtNum(r.prev_man_days)}</td><td class="num">${r.new_man_days === null ? '—' : fmtNum(r.new_man_days)}</td>
        <td style="font-size:12.5px;max-width:280px">${describe(r.changes)}</td><td class="remarks">${esc(r.remarks)}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty"><b>No audit entries found</b></div>';
    const pg = root.querySelector('[data-pager]');
    pg.innerHTML = '';
    if (data.total) pg.appendChild(pager(data, ({ page, pageSize }) => { view.page = page; view.pageSize = pageSize; load(); }));
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    Object.assign(view, Object.fromEntries(new FormData(form)), { page: 1 });
    load();
  });
  root.querySelector('[data-reset]').addEventListener('click', () => {
    Object.assign(view, { entity: '', ticket: '', search: '', fromDate: '', toDate: '', page: 1 });
    form.querySelectorAll('input, select').forEach((i) => (i.value = ''));
    load();
  });
  await load();
}
