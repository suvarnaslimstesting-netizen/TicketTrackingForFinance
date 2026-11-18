import {
  api, can, esc, icon, fmtDate, fmtDateTime, fmtNum, fmtMoney, today, addDays, toast, modal, formValues, showFormError, busy,
  pager, multiSelect, qs, download, loadLookups, confirmDialog, readFileBase64,
} from '../core.js';

// Filters survive navigation between screens during the session.
const view = { clientIds: [], search: '', stage: '', page: 1, pageSize: 10 };

const STAGE_CLS = {
  'Quotation Pending': 'off', 'Quotation Draft': 'warn', 'Quotation Rejected': 'bad', 'Awaiting PO': 'info',
  'Ready to Invoice': 'warn', 'Partially Invoiced': 'info', Invoiced: 'info', Paid: 'ok',
};
const QUOTE_CLS = { Draft: 'warn', Sent: 'info', Accepted: 'ok', Rejected: 'bad', Superseded: 'off' };
const INV_CLS = { Raised: 'info', Paid: 'ok', Cancelled: 'bad' };
const TAX_LABEL = { CGST_SGST: 'CGST + SGST', IGST: 'IGST', NONE: 'No GST' };
const badge = (text, cls) => `<span class="badge ${cls || 'off'}">${esc(text)}</span>`;
const quoteNo = (q) => `${q.quote_no}${q.revision ? ` Rev ${q.revision}` : ''}`;
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx,.eml,.msg';

let billingLookups = null;
const loadBillingLookups = async (force = false) => {
  if (!billingLookups || force) billingLookups = await api('/billing/lookups');
  return billingLookups;
};

export async function renderBilling(root) {
  const [lookups, bl] = await Promise.all([loadLookups(true), loadBillingLookups(true)]);
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Quotation &amp; Billing</h1><p>For every approved ticket: prepare the quotation, send it to the client, record the client's purchase order, then raise invoices.</p></div>
    </div>
    ${bl.company.configured ? '' : `<div class="alert warn" style="margin-bottom:16px">Company details (address, State and GSTIN) are not complete yet, so they will be missing on quotations and invoices.
      ${can('company.manage') ? '<a href="#/company"><b>Open Company Settings</b></a>' : 'Please ask the administrator to fill in Company Settings.'}</div>`}
    <div class="grid kpis" data-kpis></div>
    <form class="card card-body" data-filters style="margin-bottom:16px" novalidate>
      <div class="filters billing-filters">
        <div class="field"><label>Client</label><div data-clients></div></div>
        <div class="field"><label for="b-search">Search</label><input id="b-search" class="input" name="search" placeholder="Ticket, quotation, PO or invoice no." value="${esc(view.search)}"></div>
        <div class="btns"><button type="button" class="btn" data-reset>${icon('reset')} Reset</button><button type="submit" class="btn btn-primary">${icon('search')} Search</button></div>
      </div>
    </form>
    <div class="card">
      <div class="stage-tabs" data-stages role="tablist" aria-label="Billing stage"></div>
      <div class="table-wrap" data-table><div class="empty">Loading…</div></div>
      <div data-pager></div>
    </div>`;

  const clientSel = multiSelect(root.querySelector('[data-clients]'), {
    options: lookups.clients.map((c) => ({ value: c.id, label: c.name, note: c.status === 'Inactive' ? 'Inactive' : '' })),
    selected: view.clientIds, placeholder: 'All clients',
  });
  const form = root.querySelector('[data-filters]');

  async function load() {
    const data = await api('/billing/tickets' + qs(view));
    const t = data.totals;
    root.querySelector('[data-kpis]').innerHTML = `
      <div class="card kpi k1"><span class="kpi-icon">${icon('file')}</span><div class="label">Quoted Value</div><div class="value money">${fmtMoney(t.quoted)}</div><div class="hint">current quotations, incl. GST</div></div>
      <div class="card kpi k3"><span class="kpi-icon">${icon('invoice')}</span><div class="label">Invoiced</div><div class="value money">${fmtMoney(t.invoiced)}</div><div class="hint">excluding cancelled invoices</div></div>
      <div class="card kpi k2"><span class="kpi-icon">${icon('rupee')}</span><div class="label">Received</div><div class="value money">${fmtMoney(t.received)}</div><div class="hint">invoices marked paid</div></div>
      <div class="card kpi k4"><span class="kpi-icon">${icon('calendar')}</span><div class="label">Outstanding</div><div class="value money">${fmtMoney(t.invoiced - t.received)}</div><div class="hint">invoiced, not yet paid</div></div>`;

    const all = Object.values(data.counts).reduce((s, n) => s + n, 0);
    const tabs = [['', 'All', all], ...data.stages.map((s) => [s, s, data.counts[s]])];
    const st = root.querySelector('[data-stages]');
    st.innerHTML = tabs.map(([k, label, n]) =>
      `<button type="button" role="tab" class="stage-tab ${view.stage === k ? 'active' : ''}" aria-selected="${view.stage === k}" data-stage="${esc(k)}">${esc(label)}<span>${n}</span></button>`).join('');
    st.querySelectorAll('[data-stage]').forEach((b) => b.addEventListener('click', () => { view.stage = b.dataset.stage; view.page = 1; load(); }));

    const tbl = root.querySelector('[data-table]');
    const start = (data.page - 1) * data.pageSize;
    tbl.innerHTML = data.rows.length ? `<table class="tbl tbl-billing"><thead><tr>
        <th>S.No</th><th>Ticket Number</th><th>Client Name</th><th>Quotation</th>
        <th>Purchase Order</th><th class="num">Invoiced</th><th>Stage</th><th class="row-actions"><span class="sr-only">Open</span></th></tr></thead><tbody>
      ${data.rows.map((r, i) => `<tr>
        <td>${start + i + 1}</td>
        <td class="nowrap"><button class="ticket ticket-link" data-open="${r.id}">${esc(r.ticket_number)}</button><span class="sub">${fmtNum(r.approved_man_days)} man-days${r.ticket_type ? ` · ${esc(r.ticket_type)}` : ''}</span></td>
        <td>${esc(r.client_name)}<span class="sub">Approved ${fmtDate(r.approved_date)}</span></td>
        <td class="nowrap">${r.quote_id ? `${esc(quoteNo(r))} ${badge(r.quote_status, QUOTE_CLS[r.quote_status])}<span class="sub">${fmtMoney(r.quote_total)} · ${fmtNum(r.quote_man_days)} man-days</span>` : '<span class="muted">—</span>'}</td>
        <td class="nowrap">${r.po_id ? `${esc(r.po_number)}<span class="sub">${fmtDate(r.po_date)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="num nowrap">${r.invoice_count ? `${fmtMoney(r.invoiced_amount)}<span class="sub">${fmtNum(r.invoiced_man_days)} of ${fmtNum(r.quote_man_days)} man-days</span>` : '<span class="muted">—</span>'}</td>
        <td>${badge(r.stage, STAGE_CLS[r.stage])}</td>
        <td class="row-actions"><button class="icon-btn" data-open="${r.id}" title="Open quotation, PO &amp; invoices" aria-label="Open billing for ${esc(r.ticket_number)}">${icon('arrow')}</button></td>
      </tr>`).join('')}</tbody></table>`
      : `<div class="empty"><b>No tickets found</b>${view.stage || view.search || view.clientIds.length ? 'Try clearing the filters.' : 'Approved tickets appear here automatically.'}</div>`;
    tbl.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openTicket(+b.dataset.open, load)));
    const pg = root.querySelector('[data-pager]');
    pg.innerHTML = '';
    if (data.total) pg.appendChild(pager(data, ({ page, pageSize }) => { view.page = page; view.pageSize = pageSize; load(); }));
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    view.search = form.search.value.trim();
    view.clientIds = clientSel.value;
    view.page = 1;
    load();
  });
  root.querySelector('[data-reset]').addEventListener('click', () => {
    Object.assign(view, { clientIds: [], search: '', stage: '', page: 1 });
    form.search.value = '';
    clientSel.set([]);
    load();
  });
  await load();
}

/* --------------------------- Ticket billing window --------------------------- */

async function openTicket(id, onChange) {
  const m = modal({ title: 'Ticket Billing', size: 'wide', body: '<div class="empty">Loading…</div>', footer: '<button class="btn" data-close>Close</button>' });
  const body = m.$('.modal-body');

  async function refresh(changed = true) {
    let d;
    try { d = await api(`/billing/tickets/${id}`); } catch (err) { body.innerHTML = `<div class="alert err">${esc(err.message)}</div>`; return; }
    m.$('.modal-head h2').textContent = `Ticket ${d.approval.ticket_number} · Billing`;
    render(d);
    if (changed && onChange) onChange();
  }

  function render(d) {
    const { approval: a, client, quote, po, invoices } = d;
    const sentOk = quote && ['Sent', 'Accepted'].includes(quote.status);
    const steps = [
      ['Quotation', !!quote],
      ['Sent to client', sentOk],
      ['PO received', !!po],
      ['Invoiced', invoices.some((i) => i.status !== 'Cancelled')],
      ['Paid', d.stage === 'Paid'],
    ];
    const missing = [!client.billing_address && 'billing address', !client.state_code && 'State', !client.gstin && 'GSTIN'].filter(Boolean);
    body.innerHTML = `
      <dl class="details" style="margin:0 0 14px">
        <div><dt>Ticket Number</dt><dd class="ticket">${esc(a.ticket_number)}</dd></div>
        <div><dt>Client</dt><dd>${esc(client.name)}</dd></div>
        <div><dt>Stage</dt><dd>${badge(d.stage, STAGE_CLS[d.stage])}</dd></div>
        <div><dt>Approved Man-Days</dt><dd>${fmtNum(a.approved_man_days)}</dd></div>
        <div><dt>Given Man-Days</dt><dd>${a.given_man_days == null ? '—' : fmtNum(a.given_man_days)}</dd></div>
        <div><dt>Approved By / Date</dt><dd>${esc(a.approved_by)} · ${fmtDate(a.approved_date)}</dd></div>
      </dl>
      ${missing.length ? `<div class="alert warn" style="margin-bottom:14px">Client ${esc(missing.join(', '))} not set, so it will be missing on the quotation and invoice. ${can('client.manage') ? 'Update it under <a href="#/clients">Clients</a>.' : ''}</div>` : ''}
      <ol class="stepper">${steps.map(([label, done], i) => `<li class="${done ? 'done' : ''}"><span>${done ? '✓' : i + 1}</span>${esc(label)}</li>`).join('')}</ol>
      <section class="bill-sec" data-q></section>
      <section class="bill-sec" data-po></section>
      <section class="bill-sec" data-inv></section>`;
    renderQuote(d);
    renderPo(d);
    renderInvoices(d);
  }

  /* ----- Quotation ----- */
  function renderQuote(d) {
    const el = body.querySelector('[data-q]');
    const qt = d.quote;
    const manage = can('quotation.manage');
    if (!qt) {
      el.innerHTML = `<div class="bill-head"><h3><span class="num-dot">1</span> Quotation</h3></div>
        <div class="bill-empty">No quotation yet for this ticket.${manage ? '' : ' Implementation or Finance will prepare it.'}
        ${manage ? `<div><button class="btn btn-primary" data-new-q>${icon('plus')} Create Quotation</button></div>` : ''}</div>`;
      el.querySelector('[data-new-q]')?.addEventListener('click', () => quoteForm(d));
      return;
    }
    const mdDiff = qt.man_days !== d.approval.approved_man_days;
    el.innerHTML = `<div class="bill-head"><h3><span class="num-dot">1</span> Quotation ${esc(quoteNo(qt))} ${badge(qt.status, QUOTE_CLS[qt.status])}</h3>
        <div class="actions">
          <button class="btn btn-sm" data-pdf>${icon('pdf')} Download PDF</button>
          ${manage && qt.status === 'Draft' ? `<button class="btn btn-sm" data-edit>${icon('edit')} Edit</button><button class="btn btn-sm btn-primary" data-sent>${icon('send')} Mark as Sent</button><button class="icon-btn danger" data-del title="Delete draft" aria-label="Delete draft">${icon('trash')}</button>` : ''}
          ${manage && qt.status === 'Sent' && !d.po ? `<button class="btn btn-sm" data-reject>Client Rejected</button>` : ''}
          ${manage && ['Sent', 'Rejected'].includes(qt.status) && !d.po ? `<button class="btn btn-sm" data-revise>${icon('refresh')} Revise</button>` : ''}
        </div></div>
      <dl class="details compact">
        <div><dt>Quotation Date</dt><dd>${fmtDate(qt.quote_date)}</dd></div>
        <div><dt>Valid Until</dt><dd>${fmtDate(qt.valid_until)}</dd></div>
        <div><dt>Man-Days × Rate</dt><dd>${fmtNum(qt.man_days)} × ${fmtMoney(qt.rate)}</dd></div>
        <div><dt>Taxable Value</dt><dd>${fmtMoney(qt.subtotal)}</dd></div>
        <div><dt>GST</dt><dd>${esc(TAX_LABEL[qt.tax_type])}${qt.tax_type !== 'NONE' ? ` @ ${fmtNum(qt.gst_rate)}% · ${fmtMoney(qt.cgst + qt.sgst + qt.igst)}` : ''}</dd></div>
        <div><dt>Total</dt><dd class="money-lg">${fmtMoney(qt.total)}</dd></div>
        ${qt.sent_date ? `<div class="full"><dt>Sent</dt><dd>${fmtDate(qt.sent_date)} to ${esc(qt.sent_to)} by ${esc(qt.sent_by_name || '')}${qt.status_remarks ? ` · ${esc(qt.status_remarks)}` : ''}</dd></div>` : ''}
        ${qt.status === 'Rejected' ? `<div class="full"><dt>Rejection reason</dt><dd>${esc(qt.status_remarks)}</dd></div>` : ''}
        ${qt.description ? `<div class="full"><dt>Description</dt><dd style="white-space:pre-wrap">${esc(qt.description)}</dd></div>` : ''}
      </dl>
      ${mdDiff && qt.status === 'Draft' ? `<div class="help" style="margin-top:8px">Note: quoted man-days (${fmtNum(qt.man_days)}) differ from the approved man-days (${fmtNum(d.approval.approved_man_days)}).</div>` : ''}
      ${d.history.length ? `<details class="history"><summary>Earlier revisions (${d.history.length})</summary>
        <ul>${d.history.map((h) => `<li><button class="link" data-hpdf="${h.id}">${esc(quoteNo(h))}</button> · ${fmtDate(h.quote_date)} · ${fmtMoney(h.total)} · was ${esc(h.prior_status || 'Sent')}</li>`).join('')}</ul></details>` : ''}`;
    el.querySelector('[data-pdf]').addEventListener('click', () => dl(`/billing/quotations/${qt.id}/pdf`));
    el.querySelectorAll('[data-hpdf]').forEach((b) => b.addEventListener('click', () => dl(`/billing/quotations/${b.dataset.hpdf}/pdf`)));
    el.querySelector('[data-edit]')?.addEventListener('click', () => quoteForm(d, qt));
    el.querySelector('[data-sent]')?.addEventListener('click', () => sentForm(d, qt));
    el.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Delete draft quotation', message: `Delete draft <b>${esc(quoteNo(qt))}</b>?${qt.revision ? ' The previous revision becomes current again.' : ''}`, confirmText: 'Delete', danger: true }))) return;
      act(`/billing/quotations/${qt.id}`, 'DELETE', {}, 'Draft quotation deleted.');
    });
    el.querySelector('[data-reject]')?.addEventListener('click', async () => {
      const reason = await confirmDialog({ title: 'Quotation rejected by client', message: `Mark <b>${esc(quoteNo(qt))}</b> as rejected? You can create a revised quotation afterwards.`, confirmText: 'Mark Rejected', danger: true, reasonLabel: 'Reason' });
      if (reason) act(`/billing/quotations/${qt.id}/reject`, 'POST', { reason }, 'Quotation marked as rejected.');
    });
    el.querySelector('[data-revise]')?.addEventListener('click', async () => {
      const reason = await confirmDialog({ title: 'Revise quotation', message: `Create revision ${qt.revision + 1} of <b>${esc(qt.quote_no)}</b>? The current version is kept in the history and the new revision opens as a draft for editing.`, confirmText: 'Create Revision', reasonLabel: 'Reason for revision' });
      if (reason) act(`/billing/quotations/${qt.id}/revise`, 'POST', { reason }, 'New revision created as a draft. Edit it and mark it as sent.');
    });
  }

  /* ----- Purchase order ----- */
  function renderPo(d) {
    const el = body.querySelector('[data-po]');
    const po = d.po;
    const manage = can('po.manage');
    const ready = d.quote && ['Sent', 'Accepted'].includes(d.quote.status);
    if (!po) {
      el.innerHTML = `<div class="bill-head"><h3><span class="num-dot">2</span> Client Purchase Order</h3></div>
        <div class="bill-empty">${ready ? `Waiting for the client's purchase order.${manage ? `<div><button class="btn btn-primary" data-new-po>${icon('upload')} Record &amp; Upload PO</button></div>` : ''}` : 'Available once the quotation has been sent to the client.'}</div>`;
      el.querySelector('[data-new-po]')?.addEventListener('click', () => poForm(d));
      return;
    }
    const diff = d.quote && po.po_amount != null && Math.abs(po.po_amount - d.quote.total) > 0.5;
    el.innerHTML = `<div class="bill-head"><h3><span class="num-dot">2</span> Purchase Order ${esc(po.po_number)} ${badge('Received', 'ok')}</h3>
        <div class="actions"><button class="btn btn-sm" data-file>${icon('download')} ${esc(po.file_name)}</button>
        ${manage ? `<button class="btn btn-sm" data-edit-po>${icon('edit')} Edit / Replace File</button>` : ''}</div></div>
      <dl class="details compact">
        <div><dt>PO Date</dt><dd>${fmtDate(po.po_date)}</dd></div>
        <div><dt>Received On</dt><dd>${fmtDate(po.received_date)}</dd></div>
        <div><dt>PO Amount</dt><dd>${po.po_amount == null ? '—' : fmtMoney(po.po_amount)}</dd></div>
        <div><dt>Recorded By</dt><dd>${esc(po.created_by_name)} · ${fmtDateTime(po.created_at)}</dd></div>
        <div><dt>File</dt><dd>${esc(po.file_name)} (${fmtSize(po.file_size)})</dd></div>
        ${po.remarks ? `<div class="full"><dt>Remarks</dt><dd style="white-space:pre-wrap">${esc(po.remarks)}</dd></div>` : ''}
      </dl>
      ${diff ? `<div class="help warn-text" style="margin-top:8px">PO amount (${fmtMoney(po.po_amount)}) differs from the quotation total (${fmtMoney(d.quote.total)}).</div>` : ''}`;
    el.querySelector('[data-file]').addEventListener('click', () => dl(`/billing/po/${po.id}/file`));
    el.querySelector('[data-edit-po]')?.addEventListener('click', () => poForm(d, po));
  }

  /* ----- Invoices ----- */
  function renderInvoices(d) {
    const el = body.querySelector('[data-inv]');
    const manage = can('invoice.manage');
    if (!d.po) {
      el.innerHTML = `<div class="bill-head"><h3><span class="num-dot">3</span> Invoices</h3></div><div class="bill-empty">Invoices can be raised after the client's purchase order is recorded.</div>`;
      return;
    }
    const q = d.quote;
    el.innerHTML = `<div class="bill-head"><h3><span class="num-dot">3</span> Invoices</h3>
        <div class="actions">${manage && d.remainingMd > 0 ? `<button class="btn btn-sm btn-primary" data-new-inv>${icon('plus')} Create Invoice</button>` : ''}</div></div>
      <div class="inv-progress"><div class="bar"><i style="width:${Math.min(100, (d.invoicedMd / q.man_days) * 100)}%"></i></div>
        <span><b>${fmtNum(d.invoicedMd)}</b> of ${fmtNum(q.man_days)} quoted man-days invoiced${d.remainingMd > 0 ? ` · <b>${fmtNum(d.remainingMd)}</b> remaining` : ' · fully invoiced'}</span></div>
      ${d.invoices.length ? `<div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Invoice No</th><th>Date</th><th class="num">Man-Days</th><th class="num">Total</th><th>Due Date</th><th>Status</th><th class="row-actions">Actions</th></tr></thead><tbody>
        ${d.invoices.map((i) => `<tr class="${i.status === 'Cancelled' ? 'row-muted' : ''}">
          <td class="nowrap"><b>${esc(i.invoice_no)}</b>${i.description ? `<span class="sub">${esc(i.description)}</span>` : ''}</td>
          <td class="nowrap">${fmtDate(i.invoice_date)}</td><td class="num">${fmtNum(i.man_days)}</td><td class="num nowrap">${fmtMoney(i.total)}</td>
          <td class="nowrap">${fmtDate(i.due_date)}${i.status === 'Raised' && i.due_date && i.due_date < today() ? ' <span class="badge bad plain">Overdue</span>' : ''}</td>
          <td>${badge(i.status, INV_CLS[i.status])}${i.status === 'Paid' ? `<span class="sub">${fmtDate(i.paid_date)}${i.payment_ref ? ` · ${esc(i.payment_ref)}` : ''}</span>` : ''}${i.status === 'Cancelled' ? `<span class="sub">${esc(i.status_remarks)}</span>` : ''}</td>
          <td class="row-actions">
            <button class="icon-btn" data-ipdf="${i.id}" title="Download invoice PDF" aria-label="Download PDF">${icon('pdf')}</button>
            ${manage && i.status === 'Raised' ? `<button class="icon-btn" data-paid="${i.id}" title="Mark as paid" aria-label="Mark as paid">${icon('rupee')}</button>
              <button class="icon-btn danger" data-cancel="${i.id}" title="Cancel invoice" aria-label="Cancel invoice">${icon('close')}</button>` : ''}
          </td></tr>`).join('')}</tbody></table></div>` : '<div class="bill-empty">No invoices yet.</div>'}`;
    el.querySelector('[data-new-inv]')?.addEventListener('click', () => invoiceForm(d));
    el.querySelectorAll('[data-ipdf]').forEach((b) => b.addEventListener('click', () => dl(`/billing/invoices/${b.dataset.ipdf}/pdf`)));
    el.querySelectorAll('[data-paid]').forEach((b) => b.addEventListener('click', () => paidForm(d.invoices.find((i) => i.id === +b.dataset.paid))));
    el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      const inv = d.invoices.find((i) => i.id === +b.dataset.cancel);
      const reason = await confirmDialog({ title: 'Cancel invoice', message: `Cancel invoice <b>${esc(inv.invoice_no)}</b> (${fmtMoney(inv.total)})? Its man-days become available to invoice again. The number is not reused.`, confirmText: 'Cancel Invoice', danger: true, reasonLabel: 'Reason' });
      if (reason) act(`/billing/invoices/${inv.id}/cancel`, 'POST', { reason }, 'Invoice cancelled.');
    }));
  }

  /* ----- Actions & forms ----- */
  async function act(path, method, payload, msg) {
    try { await api(path, { method, body: payload }); toast(msg); refresh(); } catch (err) { toast(err.message, 'err'); }
  }
  async function dl(path) {
    try { await download(path); } catch (err) { toast(err.message, 'err'); }
  }

  function subForm({ title, fields, saveLabel = 'Save', size = 'wide', onSubmit, setup }) {
    const f = modal({
      title, size,
      body: `<form class="form-grid" novalidate><div class="alert err full" hidden data-err></div>${fields}</form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>${esc(saveLabel)}</button>`,
    });
    const form = f.$('form');
    if (setup) setup(form, f);
    const submit = async () => {
      const btn = f.$('[data-save]');
      showFormError(form, null);
      busy(btn, true);
      try {
        await onSubmit(formValues(form), form);
        f.close();
        refresh();
      } catch (err) {
        showFormError(form, err);
        busy(btn, false);
      }
    };
    f.$('[data-save]').addEventListener('click', submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  const totalsBox = () => '<div class="field full"><div class="calc" data-calc></div></div>';
  function bindTotals(form, get) {
    const box = form.querySelector('[data-calc]');
    const upd = () => {
      const { md, rate, type, gst } = get();
      const sub = Math.round(md * rate * 100) / 100;
      const half = type === 'CGST_SGST' ? Math.round(sub * gst / 2) / 100 : 0;
      const igst = type === 'IGST' ? Math.round(sub * gst) / 100 : 0;
      const total = sub + half * 2 + igst;
      box.innerHTML = `<div><span>Taxable value</span><b>${fmtMoney(sub)}</b></div>
        ${type === 'CGST_SGST' ? `<div><span>CGST @ ${fmtNum(gst / 2)}%</span><b>${fmtMoney(half)}</b></div><div><span>SGST @ ${fmtNum(gst / 2)}%</span><b>${fmtMoney(half)}</b></div>` : ''}
        ${type === 'IGST' ? `<div><span>IGST @ ${fmtNum(gst)}%</span><b>${fmtMoney(igst)}</b></div>` : ''}
        <div class="grand"><span>Total</span><b>${fmtMoney(total)}</b></div>`;
    };
    form.addEventListener('input', upd);
    form.addEventListener('change', upd);
    upd();
  }

  async function quoteForm(d, qt = null) {
    const { company: co } = await loadBillingLookups();
    const v = qt || {
      quote_date: today(), valid_until: addDays(today(), co.quote_validity_days || 30), man_days: d.approval.approved_man_days,
      rate: co.default_rate ?? '', tax_type: d.suggestedTax, gst_rate: co.gst_rate ?? 18, description: '', terms: '',
    };
    subForm({
      title: qt ? `Edit Quotation ${quoteNo(qt)}` : `New Quotation · ${d.approval.ticket_number}`,
      saveLabel: qt ? 'Save Changes' : 'Create Quotation',
      fields: `
        <div class="field"><label>Quotation Date <span class="req">*</span></label><input class="input" type="date" name="quote_date" value="${esc(v.quote_date)}"></div>
        <div class="field"><label>Valid Until</label><input class="input" type="date" name="valid_until" value="${esc(v.valid_until || '')}"></div>
        <div class="field"><label>Man-Days <span class="req">*</span></label><input class="input" name="man_days" inputmode="decimal" value="${esc(v.man_days)}">
          <span class="help">Approved man-days: ${fmtNum(d.approval.approved_man_days)}</span></div>
        <div class="field"><label>Rate per Man-Day (₹) <span class="req">*</span></label><input class="input" name="rate" inputmode="decimal" placeholder="e.g. 8000" value="${esc(v.rate)}"></div>
        <div class="field"><label>GST Type <span class="req">*</span></label><select class="input" name="tax_type">
          ${Object.entries(TAX_LABEL).map(([k, l]) => `<option value="${k}" ${k === v.tax_type ? 'selected' : ''}>${l}${k === d.suggestedTax ? ' (suggested)' : ''}</option>`).join('')}</select>
          <span class="help">CGST + SGST when the client is in the same State as us, IGST for other States.</span></div>
        <div class="field"><label>GST %</label><input class="input" name="gst_rate" inputmode="decimal" value="${esc(v.gst_rate)}"></div>
        <div class="field full"><label>Description / Scope</label><textarea class="input" name="description" maxlength="1000" placeholder="Shown under the line item, e.g. module configuration and training">${esc(v.description || '')}</textarea></div>
        <div class="field full"><label>Additional Terms</label><textarea class="input" name="terms" maxlength="2000" placeholder="Printed above the standard terms from Company Settings">${esc(v.terms || '')}</textarea></div>
        ${totalsBox()}`,
      setup: (form) => bindTotals(form, () => ({ md: +form.man_days.value || 0, rate: +form.rate.value || 0, type: form.tax_type.value, gst: +form.gst_rate.value || 0 })),
      onSubmit: async (val) => {
        await api(qt ? `/billing/quotations/${qt.id}` : `/billing/tickets/${d.approval.id}/quotation`, { method: qt ? 'PUT' : 'POST', body: val });
        toast(qt ? 'Quotation updated.' : 'Quotation created as a draft. Download the PDF, send it to the client, then mark it as sent.');
      },
    });
  }

  function sentForm(d, qt) {
    subForm({
      title: `Mark ${quoteNo(qt)} as Sent`, size: 'narrow', saveLabel: 'Mark as Sent',
      fields: `
        <div class="field full"><label>Sent Date <span class="req">*</span></label><input class="input" type="date" name="sent_date" max="${today()}" value="${today()}"></div>
        <div class="field full"><label>Sent To (email) <span class="req">*</span></label><input class="input" name="sent_to" maxlength="300" value="${esc(d.client.contact_email || '')}" placeholder="client@example.com"></div>
        <div class="field full"><label>Remarks</label><textarea class="input" name="remarks" maxlength="500" placeholder="e.g. sent by email, cc project lead"></textarea></div>`,
      onSubmit: async (val) => { await api(`/billing/quotations/${qt.id}/sent`, { method: 'POST', body: val }); toast('Quotation marked as sent. Record the PO when the client sends it.'); },
    });
  }

  function poForm(d, po = null) {
    const v = po || { po_number: '', po_date: '', received_date: today(), po_amount: d.quote.total, remarks: '' };
    subForm({
      title: po ? `Edit Purchase Order ${po.po_number}` : `Record Purchase Order · ${d.approval.ticket_number}`,
      saveLabel: po ? 'Save Changes' : 'Save Purchase Order',
      fields: `
        <div class="field"><label>PO Number <span class="req">*</span></label><input class="input" name="po_number" maxlength="100" value="${esc(v.po_number)}"></div>
        <div class="field"><label>PO Amount (₹)</label><input class="input" name="po_amount" inputmode="decimal" value="${esc(v.po_amount ?? '')}">
          <span class="help">Quotation total: ${fmtMoney(d.quote.total)}</span></div>
        <div class="field"><label>PO Date <span class="req">*</span></label><input class="input" type="date" name="po_date" max="${today()}" value="${esc(v.po_date)}"></div>
        <div class="field"><label>Received Date <span class="req">*</span></label><input class="input" type="date" name="received_date" max="${today()}" value="${esc(v.received_date)}"></div>
        <div class="field full"><label>PO File ${po ? '(leave empty to keep the current file)' : '<span class="req">*</span>'}</label>
          <input class="input" type="file" name="po_file" accept="${ACCEPT}">
          <span class="help">${po ? `Current file: ${esc(po.file_name)} · ` : ''}PDF, image, Word, Excel or email file, up to 10 MB.</span></div>
        <div class="field full"><label>Remarks</label><textarea class="input" name="remarks" maxlength="1000">${esc(v.remarks || '')}</textarea></div>`,
      onSubmit: async (val, form) => {
        const fileEl = form.querySelector('[name=po_file]');
        const file = fileEl.files[0];
        if (!po && !file) throw new Error('Please attach the purchase order file.');
        if (file && file.size > 10 * 1024 * 1024) throw new Error('The file is larger than 10 MB.');
        delete val.po_file;
        if (file) val.file = { name: file.name, data: await readFileBase64(file) };
        await api(po ? `/billing/po/${po.id}` : `/billing/tickets/${d.approval.id}/po`, { method: po ? 'PUT' : 'POST', body: val });
        toast(po ? 'Purchase order updated.' : 'Purchase order saved. The quotation is now accepted and the ticket is ready to invoice.');
      },
    });
  }

  async function invoiceForm(d) {
    const { company: co } = await loadBillingLookups();
    const q = d.quote;
    subForm({
      title: `New Invoice · ${d.approval.ticket_number}`, saveLabel: 'Create Invoice',
      fields: `
        <div class="field"><label>Invoice Date <span class="req">*</span></label><input class="input" type="date" name="invoice_date" max="${today()}" value="${today()}"></div>
        <div class="field"><label>Due Date</label><input class="input" type="date" name="due_date" value="${addDays(today(), co.payment_terms_days || 30)}"></div>
        <div class="field"><label>Man-Days to Invoice <span class="req">*</span></label><input class="input" name="man_days" inputmode="decimal" value="${esc(d.remainingMd)}">
          <span class="help">Remaining: ${fmtNum(d.remainingMd)} of ${fmtNum(q.man_days)} quoted man-days</span></div>
        <div class="field"><label>Rate &amp; GST (from quotation)</label><input class="input" disabled value="${fmtMoney(q.rate)} per man-day · ${TAX_LABEL[q.tax_type]}${q.tax_type !== 'NONE' ? ` @ ${fmtNum(q.gst_rate)}%` : ''}"></div>
        <div class="field full"><label>Description</label><input class="input" name="description" maxlength="1000" placeholder="e.g. Phase 1 – configuration (optional)"></div>
        <div class="field full"><label>Remarks</label><textarea class="input" name="remarks" maxlength="1000" placeholder="Printed on the invoice"></textarea></div>
        ${totalsBox()}`,
      setup: (form) => bindTotals(form, () => ({ md: +form.man_days.value || 0, rate: q.rate, type: q.tax_type, gst: q.gst_rate })),
      onSubmit: async (val) => {
        await api(`/billing/tickets/${d.approval.id}/invoices`, { method: 'POST', body: val });
        toast('Invoice created. Download the PDF to send it to the client.');
      },
    });
  }

  function paidForm(inv) {
    subForm({
      title: `Mark ${inv.invoice_no} as Paid`, size: 'narrow', saveLabel: 'Mark as Paid',
      fields: `
        <div class="field full"><label>Amount</label><input class="input" disabled value="${fmtMoney(inv.total)}"></div>
        <div class="field full"><label>Payment Date <span class="req">*</span></label><input class="input" type="date" name="paid_date" max="${today()}" value="${today()}"></div>
        <div class="field full"><label>Payment Reference</label><input class="input" name="payment_ref" maxlength="200" placeholder="UTR / cheque no. (optional)"></div>`,
      onSubmit: async (val) => { await api(`/billing/invoices/${inv.id}/paid`, { method: 'POST', body: val }); toast('Invoice marked as paid.'); },
    });
  }

  refresh(false);
}

function fmtSize(b) {
  return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}
