import {
  state, api, can, esc, icon, fmtDate, fmtDateTime, fmtNum, today, toast, modal, formValues, showFormError, busy,
  pager, multiSelect, qs, download, loadLookups, confirmDialog,
} from '../core.js';

// Filters survive navigation between screens during the session.
const view = {
  filters: { clientIds: [], ticket: '', fromDate: '', toDate: '', approvedDate: '', ticketType: '' },
  page: 1, pageSize: 10, sort: 'created_at', dir: 'desc',
};

const COLUMNS = [
  { key: 'ticket_number', label: 'Ticket Number' },
  { key: 'client_name', label: 'Client Name' },
  { key: 'approved_man_days', label: 'Approved Man-Days', cls: 'num' },
  { key: 'given_man_days', label: 'Given Man-Days', cls: 'num' },
  { key: 'approved_by', label: 'Approved By' },
  { key: 'approved_date', label: 'Approved Date' },
  { key: 'remarks', label: 'Remarks', nosort: true },
  { key: 'created_by_name', label: 'Created By' },
  { key: 'created_at', label: 'Created Date' },
  { key: 'updated_by_name', label: 'Last Updated By' },
  { key: 'updated_at', label: 'Last Updated Date' },
];

const ACTION_LABEL = {
  CREATE: 'Approval submitted', UPDATE: 'Approval details modified', ADDITIONAL_APPROVAL: 'Additional man-days approved', DELETE: 'Record deleted',
};
const FIELD_LABEL = {
  ticket_number: 'Ticket Number', client_id: 'Client', ticket_type: 'Ticket Type', department_id: 'Department', approved_man_days: 'Approved Man-Days', given_man_days: 'Given Man-Days',
  approved_by: 'Approved By', approved_date: 'Approved Date', remarks: 'Remarks', additional_man_days: 'Additional Man-Days',
};

export async function renderApprovals(root) {
  const lookups = await loadLookups(true);
  const f = view.filters;
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Man-Day Approvals</h1><p>Client-approved man-days against tickets — shared with Implementation, Finance and Product Managers.</p></div>
      <div class="actions">
        ${can('approval.export') ? `<button class="btn" data-x="excel">${icon('excel')} Export to Excel</button><button class="btn" data-x="pdf">${icon('pdf')} Export to PDF</button>` : ''}
      </div>
    </div>

    <form class="card card-body" data-filters style="margin-bottom:16px" novalidate>
      <div class="filters">
        <div class="field"><label>Client</label><div data-clients></div></div>
        <div class="field"><label for="f-ticket">Ticket Number</label><input id="f-ticket" class="input" name="ticket" placeholder="e.g. TKT-1025" value="${esc(f.ticket)}"></div>
        <div class="field"><label for="f-from">From Date</label><input id="f-from" class="input" type="date" name="fromDate" value="${esc(f.fromDate)}"></div>
        <div class="field"><label for="f-to">To Date</label><input id="f-to" class="input" type="date" name="toDate" value="${esc(f.toDate)}"></div>
        <div class="field"><label for="f-ad">Approved Date</label><input id="f-ad" class="input" type="date" name="approvedDate" value="${esc(f.approvedDate)}"></div>
        <div class="field"><label for="f-type">Ticket Type</label>
          <select id="f-type" class="input" name="ticketType"><option value="">All types</option>${lookups.ticketTypes.map((t) => `<option ${t === f.ticketType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      </div>
      <div class="actions" style="margin-top:14px;justify-content:flex-end">
        <button type="button" class="btn" data-reset>${icon('reset')} Reset</button>
        <button type="submit" class="btn btn-primary">${icon('search')} Search</button>
      </div>
    </form>

    <div class="card">
      <div class="summary-bar" data-summary></div>
      <div class="table-wrap" data-table></div>
      <div data-pager></div>
    </div>`;

  const clientSel = multiSelect(root.querySelector('[data-clients]'), {
    options: lookups.clients.map((c) => ({ value: c.id, label: c.name, note: c.status === 'Inactive' ? 'Inactive' : '' })),
    selected: f.clientIds,
    placeholder: 'All clients',
  });

  const form = root.querySelector('[data-filters]');
  let seenIds = null;
  let version = null;

  const readFilters = () => {
    const v = formValues(form);
    view.filters = { clientIds: clientSel.value, ticket: v.ticket.trim(), fromDate: v.fromDate, toDate: v.toDate, approvedDate: v.approvedDate, ticketType: v.ticketType };
  };

  async function load({ silent = false } = {}) {
    const params = { ...view.filters, page: view.page, pageSize: view.pageSize, sort: view.sort, dir: view.dir };
    let data;
    try {
      data = await api('/approvals' + qs(params));
    } catch (err) {
      if (!silent) toast(err.message, 'err');
      return;
    }
    version = data.version;
    const fresh = seenIds ? data.rows.filter((r) => !seenIds.has(r.id)).map((r) => r.id) : [];
    seenIds = new Set([...(seenIds || []), ...data.rows.map((r) => r.id)]);
    renderTable(root, data, fresh, reload);
    root.querySelector('[data-summary]').innerHTML = `
      <span>Records: <b>${data.total}</b></span>
      <span>Total Approved Man-Days: <b>${fmtNum(data.totalManDays)}</b></span>
      <span class="live"><span class="live-dot"></span>Live · updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>`;
    const pg = root.querySelector('[data-pager]');
    pg.innerHTML = '';
    if (data.total > 0) {
      pg.appendChild(pager(data, ({ page, pageSize }) => { view.page = page; view.pageSize = pageSize; load(); }));
    }
    if (silent && fresh.length) toast(`${fresh.length} new approval record(s) received.`);
  }
  const reload = () => load();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    readFilters();
    if (view.filters.fromDate && view.filters.toDate && view.filters.fromDate > view.filters.toDate) {
      toast('From Date cannot be after To Date.', 'err');
      return;
    }
    view.page = 1;
    load();
  });
  root.querySelector('[data-reset]').addEventListener('click', () => {
    form.reset();
    form.querySelectorAll('input').forEach((i) => (i.value = ''));
    form.querySelector('select').value = '';
    clientSel.set([]);
    readFilters();
    view.page = 1;
    load();
  });

  root.querySelector('[data-table]').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      view.dir = view.sort === key && view.dir === 'asc' ? 'desc' : 'asc';
      view.sort = key;
      load();
    }
  });

  root.querySelectorAll('[data-x]').forEach((b) =>
    b.addEventListener('click', async () => {
      readFilters();
      busy(b, true, 'Preparing…');
      try {
        await download(`/approvals/export/${b.dataset.x}` + qs({ ...view.filters, sort: view.sort, dir: view.dir }));
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        busy(b, false);
      }
    })
  );

  await load();

  // Live visibility: pick up approvals submitted by other users within seconds.
  const timer = setInterval(async () => {
    if (document.hidden || document.querySelector('.modal-backdrop')) return;
    try {
      const v = await api('/approvals/version');
      if (version !== null && v.version !== version) load({ silent: true });
    } catch { /* ignore */ }
  }, 10000);
  return () => clearInterval(timer);
}

function renderTable(root, data, freshIds, reload) {
  const host = root.querySelector('[data-table]');
  if (!data.rows.length) {
    host.innerHTML = `<div class="empty"><b>No approval records found</b>Try changing or resetting the filters.</div>`;
    return;
  }
  const canEdit = can('approval.edit');
  const canDel = can('approval.delete');
  const start = (data.page - 1) * data.pageSize;
  host.innerHTML = `
    <table class="tbl">
      <thead><tr>
        <th>S.No</th>
        ${COLUMNS.map((c) => (c.nosort ? `<th>${c.label}</th>` : `<th class="sortable ${c.cls || ''}" data-sort="${c.key}" aria-sort="${view.sort === c.key ? (view.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${c.label}${view.sort === c.key ? `<span class="arrow">${view.dir === 'asc' ? '▲' : '▼'}</span>` : ''}</th>`)).join('')}
        <th class="row-actions">Actions</th>
      </tr></thead>
      <tbody>
        ${data.rows.map((r, i) => `
          <tr data-id="${r.id}" class="${freshIds.includes(r.id) ? 'flash' : ''}">
            <td>${start + i + 1}</td>
            <td class="nowrap"><button class="ticket ticket-link" data-view="${r.id}">${esc(r.ticket_number)}</button>${r.ticket_type ? `<span class="sub">${esc(r.ticket_type)}</span>` : ''}</td>
            <td>${esc(r.client_name)}${r.department_names ? `<span class="sub">${esc(r.department_names)}</span>` : ''}</td>
            <td class="num"><span class="md-pill">${fmtNum(r.approved_man_days)}</span></td>
            <td class="num">${r.given_man_days == null ? '—' : fmtNum(r.given_man_days)}</td>
            <td>${esc(r.approved_by)}</td>
            <td class="nowrap">${fmtDate(r.approved_date)}</td>
            <td class="remarks"><span class="clip" title="${esc(r.remarks)}">${esc(r.remarks) || '—'}</span></td>
            <td>${esc(r.created_by_name)}</td>
            <td class="nowrap">${fmtDateTime(r.created_at)}</td>
            <td>${esc(r.updated_by_name) || '—'}</td>
            <td class="nowrap">${fmtDateTime(r.updated_at)}</td>
            <td class="row-actions">
              <button class="icon-btn" data-view="${r.id}" title="View details & history" aria-label="View">${icon('eye')}</button>
              ${canEdit ? `<button class="icon-btn" data-edit="${r.id}" title="Edit approval" aria-label="Edit">${icon('edit')}</button>
                <button class="icon-btn" data-more="${r.id}" title="Add additional approved man-days" aria-label="Additional approval">${icon('addmore')}</button>` : ''}
              ${canDel ? `<button class="icon-btn danger" data-del="${r.id}" title="Delete record" aria-label="Delete">${icon('trash')}</button>` : ''}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  const byId = (id) => data.rows.find((r) => r.id === +id);
  host.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => openDetails(+b.dataset.view, reload)));
  host.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openApprovalForm({ record: byId(b.dataset.edit), onSaved: reload })));
  host.querySelectorAll('[data-more]').forEach((b) => b.addEventListener('click', () => openAdditional(byId(b.dataset.more), reload)));
  host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => deleteRecord(byId(b.dataset.del), reload)));
}

/* -------------------------- Entry / edit form -------------------------- */

export async function openApprovalForm({ record = null, onSaved } = {}) {
  const lookups = await loadLookups(true);
  const editing = !!record;
  const r = record || {};
  const clients = lookups.clients.filter((c) => c.status === 'Active' || c.id === r.client_id);
  const u = state.user;

  const m = modal({
    title: editing ? `Edit Approval · ${r.ticket_number}` : 'New Man-Day Approval',
    size: 'wide',
    body: `
      <form class="form-grid" novalidate>
        <div class="alert err full" hidden data-err></div>
        <div class="alert warn full" hidden data-dup></div>
        <div class="field"><label for="a-ticket">Ticket Number <span class="req">*</span></label>
          <input id="a-ticket" class="input" name="ticket_number" maxlength="50" placeholder="e.g. TKT-1025" value="${esc(r.ticket_number)}" autocomplete="off"></div>
        <div class="field"><label for="a-client">Client Name <span class="req">*</span></label>
          <select id="a-client" class="input" name="client_id"><option value="">Select client</option>
            ${clients.map((c) => `<option value="${c.id}" ${c.id === r.client_id ? 'selected' : ''}>${esc(c.name)}${c.status === 'Inactive' ? ' (Inactive)' : ''}</option>`).join('')}
          </select>
          ${!clients.length ? '<span class="help">No active clients. Ask the administrator to add clients.</span>' : ''}</div>
        <div class="field"><label for="a-md">Approved Man-Days <span class="req">*</span></label>
          <input id="a-md" class="input" name="approved_man_days" inputmode="decimal" placeholder="e.g. 5 or 2.5" value="${r.approved_man_days ?? ''}"></div>
        <div class="field"><label for="a-gmd">Given Man-Days</label>
          <input id="a-gmd" class="input" name="given_man_days" inputmode="decimal" placeholder="e.g. 5 or 2.5 (optional)" value="${r.given_man_days ?? ''}"></div>
        <div class="field"><label for="a-by">Approved By <span class="req">*</span></label>
          <input id="a-by" class="input" name="approved_by" maxlength="150" placeholder="Client person who approved" value="${esc(r.approved_by)}"></div>
        <div class="field"><label for="a-date">Approved Date <span class="req">*</span></label>
          <input id="a-date" class="input" type="date" name="approved_date" max="${today()}" value="${esc(r.approved_date || '')}"></div>
        <div class="field"><label for="a-type">Ticket Type</label>
          <select id="a-type" class="input" name="ticket_type"><option value="">Select type</option>
            ${lookups.ticketTypes.map((t) => `<option ${t === r.ticket_type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
        <div class="field"><label>Created By</label><input class="input" disabled value="${esc(editing ? r.created_by_name : u.employee_name)}"></div>
        <div class="field full"><label>Department(s) <span class="req" data-dept-req hidden>*</span></label>
          <div class="dept-picker" data-depts></div></div>
        <div class="field full"><label for="a-rem">Remarks</label>
          <textarea id="a-rem" class="input" name="remarks" maxlength="2000" placeholder="Additional approval details">${esc(r.remarks)}</textarea></div>
        ${editing ? `<div class="field full"><label for="a-mod">Modification Remarks <span class="req">*</span></label>
          <textarea id="a-mod" class="input" name="modification_remarks" maxlength="1000" placeholder="Why is this approval being changed? (recorded in the audit history)"></textarea></div>` : ''}
        <div class="help full">Created Date is recorded automatically ${editing ? `(${fmtDateTime(r.created_at)})` : 'on submission'}.</div>
      </form>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>${editing ? 'Save Changes' : 'Submit'}</button>`,
  });

  const form = m.$('form');
  const dupBox = m.$('[data-dup]');
  let duplicate = null;

  const checkDup = async () => {
    const ticket = form.ticket_number.value.trim();
    const clientId = form.client_id.value;
    duplicate = null;
    dupBox.hidden = true;
    if (!ticket || !clientId) return;
    try {
      const res = await api('/approvals/check' + qs({ ticket, clientId, excludeId: editing ? r.id : '' }));
      duplicate = res.duplicate;
    } catch { return; }
    if (!duplicate) return;
    dupBox.hidden = false;
    dupBox.innerHTML = `<div class="grow"><b>Ticket ${esc(duplicate.ticket_number)} already has an approval for ${esc(duplicate.client_name)}</b>
      — ${fmtNum(duplicate.approved_man_days)} man-days approved on ${fmtDate(duplicate.approved_date)} by ${esc(duplicate.approved_by)}.
      ${editing ? 'Choose a different ticket or client.' : 'To record more man-days for this ticket, add an additional approval to the existing record.'}</div>
      ${!editing && can('approval.edit') ? '<button type="button" class="btn btn-sm" data-goadd>Add additional approval</button>' : ''}`;
    const go = dupBox.querySelector('[data-goadd]');
    if (go) go.addEventListener('click', () => { m.close(); openAdditional(duplicate, onSaved, { man_days: form.approved_man_days.value, approved_by: form.approved_by.value, approved_date: form.approved_date.value, remarks: form.remarks.value }); });
  };
  form.ticket_number.addEventListener('blur', () => { form.ticket_number.value = form.ticket_number.value.trim().toUpperCase(); checkDup(); });
  form.client_id.addEventListener('change', checkDup);

  // Department(s) follow the selected client: a single department is filled in automatically,
  // several are all pre-ticked so the user can keep or untick any of them.
  const deptBox = m.$('[data-depts]');
  const deptReq = m.$('[data-dept-req]');
  const deptName = (id) => (lookups.departments.find((d) => d.id === id) || {}).name || `Department #${id}`;
  let clientHasDepts = false;
  const renderDepts = (keepSelection) => {
    const clientId = +form.client_id.value;
    const client = lookups.clients.find((c) => c.id === clientId);
    if (!client) {
      clientHasDepts = false;
      deptReq.hidden = true;
      deptBox.innerHTML = '<div class="dept-empty">Select a client first. Its departments will appear here automatically.</div>';
      return;
    }
    const mapped = client.department_ids || [];
    clientHasDepts = mapped.length > 0;
    deptReq.hidden = !clientHasDepts;
    const keep = keepSelection ? (r.department_ids || []) : null;
    // While editing, keep departments already on the record even if the client mapping changed since.
    const ids = clientHasDepts
      ? [...new Set([...mapped, ...(keep && clientId === r.client_id ? keep : [])])]
      : lookups.departments.map((d) => d.id);
    const checked = (id) => (keep && clientId === r.client_id ? keep.includes(id) : clientHasDepts);
    const sorted = ids.sort((a, b) => deptName(a).localeCompare(deptName(b)));
    deptBox.innerHTML = `
      ${clientHasDepts
        ? `<div class="dept-hint">${mapped.length === 1 ? 'Filled in automatically from the client.' : `This client has ${mapped.length} departments. All are selected; untick any that don't apply.`}</div>`
        : '<div class="dept-hint warn">No departments are mapped to this client yet. Select any that apply (optional).</div>'}
      <div class="dept-chips">${sorted.map((id) => `
        <label class="dept-chip"><input type="checkbox" name="department_ids" value="${id}" ${checked(id) ? 'checked' : ''}><span>${esc(deptName(id))}</span></label>`).join('')}
      </div>`;
  };
  form.client_id.addEventListener('change', () => renderDepts(false));
  renderDepts(editing);
  let t = null;
  form.ticket_number.addEventListener('input', () => { dupBox.hidden = true; duplicate = null; clearTimeout(t); t = setTimeout(checkDup, 400); });
  if (editing) checkDup();

  const validate = (v) => {
    if (!v.ticket_number.trim()) return 'Ticket Number is required.';
    if (!v.client_id) return 'Client Name is required.';
    if (clientHasDepts && !(v.department_ids || []).length) return 'Please select at least one Department.';
    if (!/^\d+(\.\d{1,2})?$/.test(v.approved_man_days.trim()) || !(Number(v.approved_man_days) > 0)) return 'Approved Man-Days must be a positive number (up to 2 decimals).';
    if (v.given_man_days.trim() && (!/^\d+(\.\d{1,2})?$/.test(v.given_man_days.trim()) || !(Number(v.given_man_days) > 0))) return 'Given Man-Days must be a positive number (up to 2 decimals).';
    if (!v.approved_by.trim()) return 'Approved By is required.';
    if (!v.approved_date) return 'Approved Date is required.';
    if (v.approved_date > today()) return 'Approved Date cannot be in the future.';
    if (editing && !v.modification_remarks.trim()) return 'Modification Remarks are required when editing.';
    return null;
  };

  m.$('[data-save]').addEventListener('click', async () => {
    const v = formValues(form);
    const msg = validate(v);
    if (msg) return showFormError(form, new Error(msg));
    if (duplicate) return showFormError(form, new Error('A record for this ticket and client already exists. See the notice above.'));
    showFormError(form, null);
    const btn = m.$('[data-save]');
    busy(btn, true, editing ? 'Saving…' : 'Submitting…');
    try {
      const saved = await api(editing ? `/approvals/${r.id}` : '/approvals', { method: editing ? 'PUT' : 'POST', body: v });
      m.close();
      toast(editing ? `Approval ${saved.ticket_number} updated.` : `Approval for ${saved.ticket_number} submitted — now visible to Finance and Product Managers.`);
      onSaved && onSaved(saved);
    } catch (err) {
      busy(btn, false);
      if (err.data && err.data.code === 'DUPLICATE') { await checkDup(); }
      showFormError(form, err);
    }
  });
}

/* ------------------------- Additional approval ------------------------- */

function openAdditional(record, onSaved, prefill = {}) {
  const m = modal({
    title: `Additional Approval · ${record.ticket_number}`,
    body: `
      <form class="form-grid" novalidate>
        <div class="alert info full">Client <b>${esc(record.client_name)}</b> has <b>${fmtNum(record.approved_man_days)}</b> man-days approved so far.
          The additional man-days are added to this ticket and recorded in its approval history.</div>
        <div class="alert err full" hidden data-err></div>
        <div class="field"><label>Additional Man-Days <span class="req">*</span></label><input class="input" name="additional_man_days" inputmode="decimal" value="${esc(prefill.man_days || '')}"></div>
        <div class="field"><label>New Total</label><input class="input" disabled data-total value="${fmtNum(record.approved_man_days)}"></div>
        <div class="field"><label>Approved By <span class="req">*</span></label><input class="input" name="approved_by" maxlength="150" value="${esc(prefill.approved_by || '')}"></div>
        <div class="field"><label>Approved Date <span class="req">*</span></label><input class="input" type="date" name="approved_date" max="${today()}" value="${esc(prefill.approved_date || '')}"></div>
        <div class="field full"><label>Remarks <span class="req">*</span></label><textarea class="input" name="remarks" maxlength="1000" placeholder="e.g. Phase 2 scope approved by client">${esc(prefill.remarks || '')}</textarea></div>
      </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>Add Approval</button>',
  });
  const form = m.$('form');
  const upd = () => {
    const n = Number(form.additional_man_days.value);
    m.$('[data-total]').value = fmtNum(record.approved_man_days + (n > 0 ? n : 0));
  };
  form.additional_man_days.addEventListener('input', upd);
  upd();
  m.$('[data-save]').addEventListener('click', async () => {
    const v = formValues(form);
    if (!/^\d+(\.\d{1,2})?$/.test(v.additional_man_days.trim()) || !(Number(v.additional_man_days) > 0)) return showFormError(form, new Error('Additional Man-Days must be a positive number.'));
    if (!v.approved_by.trim()) return showFormError(form, new Error('Approved By is required.'));
    if (!v.approved_date) return showFormError(form, new Error('Approved Date is required.'));
    if (!v.remarks.trim()) return showFormError(form, new Error('Remarks are required.'));
    const btn = m.$('[data-save]');
    busy(btn, true);
    try {
      const saved = await api(`/approvals/${record.id}/additional`, { method: 'POST', body: v });
      m.close();
      toast(`${fmtNum(v.additional_man_days)} man-days added to ${saved.ticket_number}. New total: ${fmtNum(saved.approved_man_days)}.`);
      onSaved && onSaved(saved);
    } catch (err) {
      busy(btn, false);
      showFormError(form, err);
    }
  });
}

/* ------------------------------- Delete ------------------------------- */

async function deleteRecord(record, reload) {
  const reason = await confirmDialog({
    title: 'Delete approval record',
    message: `Delete the approval for <b>${esc(record.ticket_number)}</b> (${esc(record.client_name)}, ${fmtNum(record.approved_man_days)} man-days)? It will be removed from all listings; the audit history is kept.`,
    confirmText: 'Delete',
    danger: true,
    reasonLabel: 'Reason for deletion',
  });
  if (!reason) return;
  try {
    await api(`/approvals/${record.id}`, { method: 'DELETE', body: { reason } });
    toast(`Approval ${record.ticket_number} deleted.`);
    reload();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------ Details ------------------------------ */

function changeText(h) {
  if (!h.changes) return '';
  return Object.entries(h.changes)
    .filter(([k, c]) => h.action !== 'CREATE' && (k === 'additional_man_days' || String(c.from ?? '') !== String(c.to ?? '')))
    .map(([k, c]) => {
      const fmt = (v) => (k === 'approved_date' ? fmtDate(v) : k.includes('man_days') ? fmtNum(v) : v ?? '—');
      if (k === 'additional_man_days') return `+${fmtNum(c.to)} man-days`;
      if (k === 'department_id') return 'Department changed';
      if (k === 'departments') return `Department(s): <s>${esc(c.from || '—')}</s> → ${esc(c.to || '—')}`;
      return `${FIELD_LABEL[k] || k}: <s>${esc(fmt(c.from))}</s> → ${esc(fmt(c.to))}`;
    })
    .join('<br>');
}

async function openDetails(id, reload) {
  let r;
  try { r = await api(`/approvals/${id}`); } catch (err) { return toast(err.message, 'err'); }
  const m = modal({
    title: `Ticket ${r.ticket_number}`,
    size: 'wide',
    body: `
      <dl class="details" style="margin:0">
        <div><dt>Ticket Number</dt><dd class="ticket">${esc(r.ticket_number)}</dd></div>
        <div><dt>Client Name</dt><dd>${esc(r.client_name)}</dd></div>
        <div><dt>Approved Man-Days</dt><dd style="font-size:20px;font-weight:700">${fmtNum(r.approved_man_days)}</dd></div>
        <div><dt>Given Man-Days</dt><dd>${r.given_man_days == null ? '—' : fmtNum(r.given_man_days)}</dd></div>
        <div><dt>Approved By</dt><dd>${esc(r.approved_by)}</dd></div>
        <div><dt>Approved Date</dt><dd>${fmtDate(r.approved_date)}</dd></div>
        <div><dt>Ticket Type</dt><dd>${esc(r.ticket_type || '—')}</dd></div>
        <div class="full"><dt>Department(s)</dt><dd>${esc(r.department_names || '—')}</dd></div>
        <div class="full"><dt>Remarks</dt><dd style="white-space:pre-wrap">${esc(r.remarks) || '—'}</dd></div>
        <div><dt>Created By</dt><dd>${esc(r.created_by_name)}</dd></div>
        <div><dt>Created Date</dt><dd>${fmtDateTime(r.created_at)}</dd></div>
        <div><dt>Last Updated</dt><dd>${r.updated_at ? `${esc(r.updated_by_name)} · ${fmtDateTime(r.updated_at)}` : '—'}</dd></div>
      </dl>
      <div class="section-title">Approval &amp; audit history</div>
      <ul class="timeline">
        ${r.history.map((h) => `
          <li>
            <div class="when">${fmtDateTime(h.created_at)} · ${esc(h.user_name)}</div>
            <div class="what">${esc(ACTION_LABEL[h.action] || h.action)}
              ${h.prev_man_days !== null || h.new_man_days !== null ? `<span class="tag">${h.prev_man_days !== null ? `${fmtNum(h.prev_man_days)} → ` : ''}${h.new_man_days !== null ? fmtNum(h.new_man_days) : '—'} man-days</span>` : ''}</div>
            ${changeText(h) ? `<div class="chg">${changeText(h)}</div>` : ''}
            ${h.remarks ? `<div class="chg">“${esc(h.remarks)}”</div>` : ''}
          </li>`).join('')}
      </ul>`,
    footer: `${can('approval.edit') ? `<button class="btn" data-more>${icon('addmore')} Additional Approval</button><button class="btn" data-edit>${icon('edit')} Edit</button>` : ''}<button class="btn btn-primary" data-close>Close</button>`,
  });
  const e = m.$('[data-edit]');
  if (e) e.addEventListener('click', () => { m.close(); openApprovalForm({ record: r, onSaved: reload }); });
  const a = m.$('[data-more]');
  if (a) a.addEventListener('click', () => { m.close(); openAdditional(r, reload); });
}
