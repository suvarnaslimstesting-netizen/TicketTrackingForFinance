// Quotation & Billing: per approved ticket, Quotation -> Sent -> client PO -> Invoice(s).
const { q, tx, audit, NOW, nextDocNo } = require('../db');
const { requirePerm } = require('../auth');
const { isIsoDate, todayLocal, str, httpError, asyncRouter } = require('../util');
const { finYear, round2, computeTotals, STATES } = require('../gst');
const { billingPdf } = require('../billing-pdf');

const router = asyncRouter();
const TAX_TYPES = ['CGST_SGST', 'IGST', 'NONE'];
const MAX_FILE = 10 * 1024 * 1024;
const FILE_TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  eml: 'message/rfc822', msg: 'application/vnd.ms-outlook',
};
const EPS = 0.001;

/* -------------------------------- Helpers -------------------------------- */

function num(v, label, { required = true, min = 0, max = 1e10, allowZero = false } = {}) {
  const s = str(v);
  if (!s) {
    if (required) throw httpError(400, `${label} is required.`);
    return null;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw httpError(400, `${label} must be a number with up to 2 decimals.`);
  const n = Number(s);
  if (!(allowZero ? n >= min : n > min)) throw httpError(400, `${label} must be greater than ${min}.`);
  if (n > max) throw httpError(400, `${label} looks too large.`);
  return n;
}

function date(v, label, { required = true, notFuture = false } = {}) {
  const s = str(v);
  if (!s) {
    if (required) throw httpError(400, `${label} is required.`);
    return null;
  }
  if (!isIsoDate(s)) throw httpError(400, `${label} must be a valid date.`);
  if (notFuture && s > todayLocal()) throw httpError(400, `${label} cannot be in the future.`);
  return s;
}

function text(v, label, max, required = false) {
  const s = str(v);
  if (required && !s) throw httpError(400, `${label} is required.`);
  if (s.length > max) throw httpError(400, `${label} must be ${max} characters or fewer.`);
  return s || null;
}

const addDays = (iso, days) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const company = () => q.get('SELECT * FROM company_settings WHERE id = 1');

async function getApproval(id) {
  const a = Number.isInteger(id) && (await q.get(
    `SELECT a.id, a.ticket_number, a.ticket_type, a.approved_man_days, a.given_man_days, a.approved_by, a.approved_date, a.remarks,
            a.client_id, c.name AS client_name
       FROM approvals a JOIN clients c ON c.id = a.client_id WHERE a.id = ? AND a.is_deleted = 0`, id));
  if (!a) throw httpError(404, 'Ticket not found.');
  return a;
}

const getClient = (id) => q.get('SELECT * FROM clients WHERE id = ?', id);

const QUOTE_COLS = `qt.*, cu.employee_name AS created_by_name, su.employee_name AS sent_by_name`;
const currentQuote = (approvalId) => q.get(
  `SELECT ${QUOTE_COLS} FROM quotations qt LEFT JOIN users cu ON cu.id = qt.created_by LEFT JOIN users su ON su.id = qt.sent_by
    WHERE qt.approval_id = ? AND qt.status <> 'Superseded'`, approvalId);

const PO_COLS = `p.id, p.approval_id, p.quotation_id, p.po_number, p.po_date, p.received_date, p.po_amount, p.remarks,
  p.file_name, p.file_type, p.file_size, p.created_at, p.updated_at, cu.employee_name AS created_by_name, uu.employee_name AS updated_by_name`;
const getPo = (approvalId) => q.get(
  `SELECT ${PO_COLS} FROM purchase_orders p LEFT JOIN users cu ON cu.id = p.created_by LEFT JOIN users uu ON uu.id = p.updated_by
    WHERE p.approval_id = ?`, approvalId);

const invoicedDays = async (approvalId) =>
  (await q.get("SELECT COALESCE(SUM(man_days),0) AS d FROM invoices WHERE approval_id = ? AND status <> 'Cancelled'", approvalId)).d;

// Where a ticket currently stands in the billing flow.
function stageOf({ quote, po, invoicedMd, invoiceCount, unpaidCount }) {
  if (!quote) return 'Quotation Pending';
  if (quote.status === 'Draft') return 'Quotation Draft';
  if (quote.status === 'Rejected') return 'Quotation Rejected';
  if (!po) return 'Awaiting PO';
  if (!invoiceCount) return 'Ready to Invoice';
  if (invoicedMd + EPS < quote.man_days) return 'Partially Invoiced';
  return unpaidCount ? 'Invoiced' : 'Paid';
}
const STAGES = ['Quotation Pending', 'Quotation Draft', 'Quotation Rejected', 'Awaiting PO', 'Ready to Invoice', 'Partially Invoiced', 'Invoiced', 'Paid'];

// Reads the quotation/invoice pricing fields and works out the totals.
function readPricing(body, co) {
  const man_days = num(body.man_days, 'Man-Days', { max: 100000 });
  const rate = num(body.rate, 'Rate per Man-Day');
  const tax_type = str(body.tax_type) || 'CGST_SGST';
  if (!TAX_TYPES.includes(tax_type)) throw httpError(400, 'Invalid GST type.');
  const gst_rate = tax_type === 'NONE' ? 0 : num(body.gst_rate ?? co.gst_rate, 'GST %', { allowZero: true, max: 100 });
  return { man_days, rate, tax_type, gst_rate, ...computeTotals({ man_days, rate, gst_rate, tax_type }) };
}

// Suggested GST type: CGST+SGST when supplier and client are in the same state, otherwise IGST.
const suggestTax = (co, client) => (co.state_code && client.state_code && co.state_code !== client.state_code ? 'IGST' : 'CGST_SGST');

/* -------------------------------- Listing -------------------------------- */

router.get('/tickets', requirePerm('billing.view'), async (req, res) => {
  const where = ['a.is_deleted = 0'];
  const params = [];
  const clientIds = str(req.query.clientIds).split(',').map((x) => parseInt(x, 10)).filter(Number.isInteger);
  if (clientIds.length) { where.push(`a.client_id IN (${clientIds.map(() => '?').join(',')})`); params.push(...clientIds); }
  const search = str(req.query.search);
  if (search) {
    where.push(`(a.ticket_number ILIKE ? OR qt.quote_no ILIKE ? OR p.po_number ILIKE ?
                 OR EXISTS (SELECT 1 FROM invoices i2 WHERE i2.approval_id = a.id AND i2.invoice_no ILIKE ?))`);
    const like = `%${search.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    params.push(like, like, like, like);
  }
  const rows = await q.all(
    `SELECT a.id, a.ticket_number, a.ticket_type, a.approved_man_days, a.approved_date, c.name AS client_name,
            qt.id AS quote_id, qt.quote_no, qt.revision, qt.status AS quote_status, qt.man_days AS quote_man_days, qt.total AS quote_total,
            qt.sent_date, p.id AS po_id, p.po_number, p.po_date,
            COALESCE(inv.cnt, 0) AS invoice_count, COALESCE(inv.md, 0) AS invoiced_man_days, COALESCE(inv.amt, 0) AS invoiced_amount,
            COALESCE(inv.unpaid, 0) AS unpaid_count, COALESCE(inv.paid_amt, 0) AS paid_amount
       FROM approvals a
       JOIN clients c ON c.id = a.client_id
       LEFT JOIN quotations qt ON qt.approval_id = a.id AND qt.status <> 'Superseded'
       LEFT JOIN purchase_orders p ON p.approval_id = a.id
       LEFT JOIN (SELECT approval_id, COUNT(*) AS cnt, SUM(man_days) AS md, SUM(total) AS amt,
                         SUM(CASE WHEN status = 'Raised' THEN 1 ELSE 0 END) AS unpaid,
                         SUM(CASE WHEN status = 'Paid' THEN total ELSE 0 END) AS paid_amt
                    FROM invoices WHERE status <> 'Cancelled' GROUP BY approval_id) inv ON inv.approval_id = a.id
      WHERE ${where.join(' AND ')}
      ORDER BY a.approved_date DESC, a.id DESC`,
    ...params
  );
  for (const r of rows) {
    r.stage = stageOf({
      quote: r.quote_id ? { status: r.quote_status, man_days: r.quote_man_days } : null,
      po: r.po_id, invoicedMd: r.invoiced_man_days, invoiceCount: r.invoice_count, unpaidCount: r.unpaid_count,
    });
  }
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  rows.forEach((r) => { counts[r.stage] += 1; });
  const stage = str(req.query.stage);
  const list = stage ? rows.filter((r) => r.stage === stage) : rows;
  const totals = {
    quoted: round2(rows.reduce((s, r) => s + (r.quote_total || 0), 0)),
    invoiced: round2(rows.reduce((s, r) => s + r.invoiced_amount, 0)),
    received: round2(rows.reduce((s, r) => s + r.paid_amount, 0)),
  };
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 10));
  res.json({ rows: list.slice((page - 1) * pageSize, page * pageSize), total: list.length, page, pageSize, counts, stages: STAGES, totals });
});

router.get('/lookups', requirePerm('billing.view'), async (req, res) => {
  const co = await company();
  res.json({
    states: STATES,
    company: {
      company_name: co.company_name, state_code: co.state_code, gstin: co.gstin, default_rate: co.default_rate, gst_rate: co.gst_rate,
      quote_validity_days: co.quote_validity_days, payment_terms_days: co.payment_terms_days,
      configured: !!(co.gstin && co.state_code && co.address),
    },
  });
});

router.get('/tickets/:id', requirePerm('billing.view'), async (req, res) => {
  const a = await getApproval(+req.params.id);
  const client = await getClient(a.client_id);
  const quotations = await q.all(
    `SELECT ${QUOTE_COLS} FROM quotations qt LEFT JOIN users cu ON cu.id = qt.created_by LEFT JOIN users su ON su.id = qt.sent_by
      WHERE qt.approval_id = ? ORDER BY qt.revision DESC`, a.id);
  const quote = quotations.find((x) => x.status !== 'Superseded') || null;
  const po = await getPo(a.id);
  const invoices = await q.all(
    `SELECT i.*, cu.employee_name AS created_by_name FROM invoices i LEFT JOIN users cu ON cu.id = i.created_by
      WHERE i.approval_id = ? ORDER BY i.id DESC`, a.id);
  const live = invoices.filter((i) => i.status !== 'Cancelled');
  const invoicedMd = round2(live.reduce((s, i) => s + i.man_days, 0));
  const co = await company();
  res.json({
    approval: a,
    client: {
      id: client.id, name: client.name, billing_address: client.billing_address, gstin: client.gstin, state_code: client.state_code,
      contact_person: client.contact_person, contact_email: client.contact_email,
    },
    quote, history: quotations.filter((x) => x.status === 'Superseded'), po, invoices,
    invoicedMd, remainingMd: quote ? round2(Math.max(0, quote.man_days - invoicedMd)) : 0,
    stage: stageOf({ quote, po, invoicedMd, invoiceCount: live.length, unpaidCount: live.filter((i) => i.status === 'Raised').length }),
    suggestedTax: suggestTax(co, client),
  });
});

/* ------------------------------- Quotations ------------------------------- */

function readQuote(body, co) {
  const quote_date = date(body.quote_date, 'Quotation Date');
  const valid_until = date(body.valid_until, 'Valid Until', { required: false });
  if (valid_until && valid_until < quote_date) throw httpError(400, 'Valid Until cannot be before the Quotation Date.');
  return {
    quote_date, valid_until,
    description: text(body.description, 'Description', 1000),
    terms: text(body.terms, 'Terms', 2000),
    ...readPricing(body, co),
  };
}

const auditQuote = (qt, action, remarks, user, changes) => audit({
  entity: 'QUOTATION', entityId: qt.id, action, ticket: qt.ticket_number, prev: null, next: qt.man_days ?? null,
  changes, remarks: `${qt.quote_no}${qt.revision ? ` Rev ${qt.revision}` : ''}: ${remarks}`, user,
});

router.post('/tickets/:id/quotation', requirePerm('quotation.manage'), async (req, res) => {
  const a = await getApproval(+req.params.id);
  if (await currentQuote(a.id)) throw httpError(409, 'A quotation already exists for this ticket. Edit or revise it instead.');
  const co = await company();
  const v = readQuote(req.body, co);
  const id = await tx(async () => {
    const quote_no = await nextDocNo('QTN', 'QTN', finYear(v.quote_date));
    const r = await q.insert(
      `INSERT INTO quotations (approval_id, quote_no, revision, quote_date, valid_until, description, man_days, rate, tax_type, gst_rate,
                               subtotal, cgst, sgst, igst, total, terms, created_by)
       VALUES (?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      a.id, quote_no, v.quote_date, v.valid_until, v.description, v.man_days, v.rate, v.tax_type, v.gst_rate,
      v.subtotal, v.cgst, v.sgst, v.igst, v.total, v.terms, req.user.id
    );
    await auditQuote({ id: r.lastInsertRowid, quote_no, revision: 0, ticket_number: a.ticket_number, man_days: v.man_days },
      'CREATE', `quotation created for Rs. ${v.total}`, req.user);
    return r.lastInsertRowid;
  });
  res.status(201).json({ id });
});

async function loadQuote(id) {
  const qt = Number.isInteger(id) && (await q.get(
    `SELECT qt.*, a.ticket_number FROM quotations qt JOIN approvals a ON a.id = qt.approval_id WHERE qt.id = ? AND a.is_deleted = 0`, id));
  if (!qt) throw httpError(404, 'Quotation not found.');
  return qt;
}

router.put('/quotations/:id', requirePerm('quotation.manage'), async (req, res) => {
  const qt = await loadQuote(+req.params.id);
  if (qt.status !== 'Draft') throw httpError(400, 'Only a Draft quotation can be edited. Use Revise to change a sent quotation.');
  const v = readQuote(req.body, await company());
  const fields = ['quote_date', 'valid_until', 'description', 'man_days', 'rate', 'tax_type', 'gst_rate', 'total', 'terms'];
  const changes = {};
  for (const f of fields) if (String(qt[f] ?? '') !== String(v[f] ?? '')) changes[f] = { from: qt[f], to: v[f] };
  await tx(async () => {
    await q.run(
      `UPDATE quotations SET quote_date = ?, valid_until = ?, description = ?, man_days = ?, rate = ?, tax_type = ?, gst_rate = ?,
              subtotal = ?, cgst = ?, sgst = ?, igst = ?, total = ?, terms = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`,
      v.quote_date, v.valid_until, v.description, v.man_days, v.rate, v.tax_type, v.gst_rate,
      v.subtotal, v.cgst, v.sgst, v.igst, v.total, v.terms, req.user.id, qt.id
    );
    await auditQuote({ ...qt, man_days: v.man_days }, 'UPDATE', 'draft quotation updated', req.user, changes);
  });
  res.json({ ok: true });
});

router.post('/quotations/:id/sent', requirePerm('quotation.manage'), async (req, res) => {
  const qt = await loadQuote(+req.params.id);
  if (qt.status !== 'Draft') throw httpError(400, 'This quotation has already been sent.');
  const sent_date = date(req.body.sent_date, 'Sent Date', { notFuture: true });
  if (sent_date < qt.quote_date) throw httpError(400, 'Sent Date cannot be before the Quotation Date.');
  const sent_to = text(req.body.sent_to, 'Sent To', 300, true);
  const remarks = text(req.body.remarks, 'Remarks', 500);
  await tx(async () => {
    await q.run(`UPDATE quotations SET status = 'Sent', sent_date = ?, sent_to = ?, sent_by = ?, status_remarks = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`,
      sent_date, sent_to, req.user.id, remarks, req.user.id, qt.id);
    await auditQuote(qt, 'SENT', `sent to ${sent_to}${remarks ? ` (${remarks})` : ''}`, req.user);
  });
  res.json({ ok: true });
});

router.post('/quotations/:id/reject', requirePerm('quotation.manage'), async (req, res) => {
  const qt = await loadQuote(+req.params.id);
  if (qt.status !== 'Sent') throw httpError(400, 'Only a sent quotation can be marked as rejected.');
  const reason = text(req.body.reason, 'Reason', 500, true);
  await tx(async () => {
    await q.run(`UPDATE quotations SET status = 'Rejected', status_remarks = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`, reason, req.user.id, qt.id);
    await auditQuote(qt, 'REJECTED', `rejected by client: ${reason}`, req.user);
  });
  res.json({ ok: true });
});

// A sent or rejected quotation is never changed; a new revision (Draft) replaces it.
router.post('/quotations/:id/revise', requirePerm('quotation.manage'), async (req, res) => {
  const qt = await loadQuote(+req.params.id);
  if (!['Sent', 'Rejected'].includes(qt.status)) throw httpError(400, 'Only a sent or rejected quotation can be revised.');
  if (await q.get('SELECT 1 AS x FROM purchase_orders WHERE approval_id = ?', qt.approval_id)) {
    throw httpError(400, 'A purchase order has already been received against this quotation, so it can no longer be revised.');
  }
  const reason = text(req.body.reason, 'Reason for revision', 500, true);
  const id = await tx(async () => {
    await q.run(`UPDATE quotations SET prior_status = status, status = 'Superseded', updated_by = ?, updated_at = ${NOW} WHERE id = ?`, req.user.id, qt.id);
    const r = await q.insert(
      `INSERT INTO quotations (approval_id, quote_no, revision, quote_date, valid_until, description, man_days, rate, tax_type, gst_rate,
                               subtotal, cgst, sgst, igst, total, terms, created_by)
       SELECT approval_id, quote_no, revision + 1, ?, valid_until, description, man_days, rate, tax_type, gst_rate,
              subtotal, cgst, sgst, igst, total, terms, ? FROM quotations WHERE id = ?`,
      todayLocal(), req.user.id, qt.id
    );
    await auditQuote({ ...qt, revision: qt.revision + 1, id: r.lastInsertRowid }, 'REVISED', `new revision created: ${reason}`, req.user);
    return r.lastInsertRowid;
  });
  res.status(201).json({ id });
});

router.delete('/quotations/:id', requirePerm('quotation.manage'), async (req, res) => {
  const qt = await loadQuote(+req.params.id);
  if (qt.status !== 'Draft') throw httpError(400, 'Only a Draft quotation can be deleted.');
  await tx(async () => {
    await q.run('DELETE FROM quotations WHERE id = ?', qt.id);
    // Deleting a draft revision brings back the previous revision.
    if (qt.revision > 0) {
      await q.run(`UPDATE quotations SET status = COALESCE(prior_status, 'Sent'), prior_status = NULL
                     WHERE quote_no = ? AND revision = ? AND status = 'Superseded'`, qt.quote_no, qt.revision - 1);
    }
    await auditQuote(qt, 'DELETE', 'draft quotation deleted', req.user);
  });
  res.json({ ok: true });
});

async function pdfContext(approvalId) {
  const approval = await getApproval(approvalId);
  return { approval, client: await getClient(approval.client_id), company: await company() };
}

router.get('/quotations/:id/pdf', requirePerm('billing.view'), async (req, res) => {
  const qt = await loadQuote(+req.params.id);
  billingPdf(res, 'quotation', qt, await pdfContext(qt.approval_id));
});

/* ---------------------------- Purchase orders ---------------------------- */

function readFile(f, required) {
  if (!f || !f.data) {
    if (required) throw httpError(400, 'Please attach the purchase order file.');
    return null;
  }
  const name = str(f.name).replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 200);
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
  const type = ext && FILE_TYPES[ext.toLowerCase()];
  if (!type) throw httpError(400, 'Allowed file types: PDF, JPG, PNG, Word, Excel, EML/MSG.');
  const data = Buffer.from(String(f.data), 'base64');
  if (!data.length) throw httpError(400, 'The attached file is empty.');
  if (data.length > MAX_FILE) throw httpError(400, 'The file is larger than 10 MB.');
  return { name, type, size: data.length, data };
}

function readPo(body) {
  const po_date = date(body.po_date, 'PO Date', { notFuture: true });
  const received_date = date(body.received_date, 'Received Date', { notFuture: true });
  if (received_date < po_date) throw httpError(400, 'Received Date cannot be before the PO Date.');
  return {
    po_number: text(body.po_number, 'PO Number', 100, true),
    po_date, received_date,
    po_amount: num(body.po_amount, 'PO Amount', { required: false }),
    remarks: text(body.remarks, 'Remarks', 1000),
  };
}

router.post('/tickets/:id/po', requirePerm('po.manage'), async (req, res) => {
  const a = await getApproval(+req.params.id);
  const qt = await currentQuote(a.id);
  if (!qt || !['Sent', 'Accepted'].includes(qt.status)) throw httpError(400, 'Send the quotation to the client before recording a purchase order.');
  if (await getPo(a.id)) throw httpError(409, 'A purchase order is already recorded for this ticket. Edit it instead.');
  const v = readPo(req.body);
  const file = readFile(req.body.file, true);
  await tx(async () => {
    const r = await q.insert(
      `INSERT INTO purchase_orders (approval_id, quotation_id, po_number, po_date, received_date, po_amount, remarks,
                                    file_name, file_type, file_size, file_data, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      a.id, qt.id, v.po_number, v.po_date, v.received_date, v.po_amount, v.remarks, file.name, file.type, file.size, file.data, req.user.id
    );
    await q.run(`UPDATE quotations SET status = 'Accepted', updated_by = ?, updated_at = ${NOW} WHERE id = ?`, req.user.id, qt.id);
    await audit({
      entity: 'PO', entityId: r.lastInsertRowid, action: 'CREATE', ticket: a.ticket_number,
      remarks: `PO ${v.po_number} dated ${v.po_date} received (${file.name}); quotation ${qt.quote_no} accepted`, user: req.user,
    });
  });
  res.status(201).json({ ok: true });
});

router.put('/po/:id', requirePerm('po.manage'), async (req, res) => {
  const po = Number.isInteger(+req.params.id) && (await q.get(
    `SELECT p.id, p.approval_id, p.po_number, p.po_date, p.received_date, p.po_amount, p.remarks, p.file_name, a.ticket_number
       FROM purchase_orders p JOIN approvals a ON a.id = p.approval_id WHERE p.id = ?`, +req.params.id));
  if (!po) throw httpError(404, 'Purchase order not found.');
  const v = readPo(req.body);
  const file = readFile(req.body.file, false);
  const changes = {};
  for (const f of ['po_number', 'po_date', 'received_date', 'po_amount', 'remarks']) {
    if (String(po[f] ?? '') !== String(v[f] ?? '')) changes[f] = { from: po[f], to: v[f] };
  }
  if (file) changes.file = { from: po.file_name, to: file.name };
  if (!Object.keys(changes).length) throw httpError(400, 'No changes were made.');
  await tx(async () => {
    await q.run(
      `UPDATE purchase_orders SET po_number = ?, po_date = ?, received_date = ?, po_amount = ?, remarks = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`,
      v.po_number, v.po_date, v.received_date, v.po_amount, v.remarks, req.user.id, po.id
    );
    if (file) {
      await q.run('UPDATE purchase_orders SET file_name = ?, file_type = ?, file_size = ?, file_data = ? WHERE id = ?', file.name, file.type, file.size, file.data, po.id);
    }
    await audit({ entity: 'PO', entityId: po.id, action: 'UPDATE', ticket: po.ticket_number, changes, remarks: `PO ${v.po_number} updated`, user: req.user });
  });
  res.json({ ok: true });
});

router.get('/po/:id/file', requirePerm('billing.view'), async (req, res) => {
  const po = Number.isInteger(+req.params.id) && (await q.get('SELECT file_name, file_type, file_data FROM purchase_orders WHERE id = ?', +req.params.id));
  if (!po) throw httpError(404, 'File not found.');
  res.setHeader('Content-Type', po.file_type);
  res.setHeader('Content-Disposition', `attachment; filename="${po.file_name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(po.file_name)}`);
  res.send(po.file_data);
});

/* -------------------------------- Invoices -------------------------------- */

router.post('/tickets/:id/invoices', requirePerm('invoice.manage'), async (req, res) => {
  const a = await getApproval(+req.params.id);
  const qt = await currentQuote(a.id);
  const po = await getPo(a.id);
  if (!qt || !po) throw httpError(400, 'An invoice can be raised only after the client purchase order is recorded.');
  const co = await company();
  const invoice_date = date(req.body.invoice_date, 'Invoice Date', { notFuture: true });
  const due_date = date(req.body.due_date, 'Due Date', { required: false });
  if (due_date && due_date < invoice_date) throw httpError(400, 'Due Date cannot be before the Invoice Date.');
  const man_days = num(req.body.man_days, 'Man-Days to invoice', { max: 100000 });
  // Rate and GST always come from the accepted quotation.
  const p = { man_days, rate: qt.rate, tax_type: qt.tax_type, gst_rate: qt.gst_rate };
  const totals = computeTotals(p);
  const description = text(req.body.description, 'Description', 1000);
  const remarks = text(req.body.remarks, 'Remarks', 1000);

  const id = await tx(async () => {
    // Lock the ticket so two people cannot over-invoice it at the same time.
    await q.get('SELECT id FROM approvals WHERE id = ? FOR UPDATE', a.id);
    const remaining = round2(qt.man_days - (await invoicedDays(a.id)));
    if (man_days > remaining + EPS) {
      throw httpError(400, `Only ${remaining} man-day(s) remain to be invoiced against quotation ${qt.quote_no}.`);
    }
    const invoice_no = await nextDocNo('INV', 'INV', finYear(invoice_date));
    const r = await q.insert(
      `INSERT INTO invoices (invoice_no, approval_id, quotation_id, po_id, invoice_date, due_date, description, man_days, rate, tax_type, gst_rate,
                             subtotal, cgst, sgst, igst, total, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      invoice_no, a.id, qt.id, po.id, invoice_date, due_date || addDays(invoice_date, co.payment_terms_days || 30), description,
      man_days, p.rate, p.tax_type, p.gst_rate, totals.subtotal, totals.cgst, totals.sgst, totals.igst, totals.total, remarks, req.user.id
    );
    await audit({
      entity: 'INVOICE', entityId: r.lastInsertRowid, action: 'CREATE', ticket: a.ticket_number, prev: null, next: man_days,
      remarks: `Invoice ${invoice_no} raised for ${man_days} man-day(s), Rs. ${totals.total}`, user: req.user,
    });
    return r.lastInsertRowid;
  });
  res.status(201).json({ id });
});

async function loadInvoice(id) {
  const inv = Number.isInteger(id) && (await q.get(
    `SELECT i.*, a.ticket_number FROM invoices i JOIN approvals a ON a.id = i.approval_id WHERE i.id = ?`, id));
  if (!inv) throw httpError(404, 'Invoice not found.');
  return inv;
}

router.post('/invoices/:id/paid', requirePerm('invoice.manage'), async (req, res) => {
  const inv = await loadInvoice(+req.params.id);
  if (inv.status !== 'Raised') throw httpError(400, `This invoice is already ${inv.status.toLowerCase()}.`);
  const paid_date = date(req.body.paid_date, 'Payment Date', { notFuture: true });
  if (paid_date < inv.invoice_date) throw httpError(400, 'Payment Date cannot be before the Invoice Date.');
  const payment_ref = text(req.body.payment_ref, 'Payment Reference', 200);
  await tx(async () => {
    await q.run(`UPDATE invoices SET status = 'Paid', paid_date = ?, payment_ref = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`,
      paid_date, payment_ref, req.user.id, inv.id);
    await audit({ entity: 'INVOICE', entityId: inv.id, action: 'PAID', ticket: inv.ticket_number,
      remarks: `Invoice ${inv.invoice_no} marked paid on ${paid_date}${payment_ref ? ` (ref ${payment_ref})` : ''}`, user: req.user });
  });
  res.json({ ok: true });
});

router.post('/invoices/:id/cancel', requirePerm('invoice.manage'), async (req, res) => {
  const inv = await loadInvoice(+req.params.id);
  if (inv.status !== 'Raised') throw httpError(400, `A ${inv.status.toLowerCase()} invoice cannot be cancelled.`);
  const reason = text(req.body.reason, 'Reason', 500, true);
  await tx(async () => {
    await q.run(`UPDATE invoices SET status = 'Cancelled', status_remarks = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`, reason, req.user.id, inv.id);
    await audit({ entity: 'INVOICE', entityId: inv.id, action: 'CANCELLED', ticket: inv.ticket_number, prev: inv.man_days, next: null,
      remarks: `Invoice ${inv.invoice_no} cancelled: ${reason}`, user: req.user });
  });
  res.json({ ok: true });
});

router.get('/invoices/:id/pdf', requirePerm('billing.view'), async (req, res) => {
  const inv = await loadInvoice(+req.params.id);
  const ctx = await pdfContext(inv.approval_id);
  ctx.quotation = await q.get('SELECT quote_no, revision FROM quotations WHERE id = ?', inv.quotation_id);
  ctx.po = inv.po_id ? await q.get('SELECT po_number, po_date FROM purchase_orders WHERE id = ?', inv.po_id) : null;
  billingPdf(res, 'invoice', inv, ctx);
});

module.exports = router;
