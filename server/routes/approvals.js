const { q, tx, audit, NOW } = require('../db');
const { requirePerm } = require('../auth');
const { isIsoDate, todayLocal, str, httpError, escLike, paging, asyncRouter } = require('../util');
const { exportExcel, exportPdf } = require('../export');
const { STATES } = require('../gst');

const router = asyncRouter();
const TICKET_TYPES = ['Support', 'Development', 'Implementation', 'Enhancement'];
const MAX_MAN_DAYS = 100000;

const SELECT = `
  SELECT a.id, a.ticket_number, a.client_id, c.name AS client_name, a.ticket_type,
         (SELECT string_agg(d.name::text, ', ' ORDER BY d.name) FROM approval_departments ad JOIN departments d ON d.id = ad.department_id
           WHERE ad.approval_id = a.id) AS department_names,
         (SELECT string_agg(ad.department_id::text, ',') FROM approval_departments ad WHERE ad.approval_id = a.id) AS department_ids_csv,
         a.approved_man_days, a.given_man_days, a.approved_by, a.approved_date, a.remarks,
         a.created_by, cu.employee_name AS created_by_name, a.created_at,
         a.updated_by, uu.employee_name AS updated_by_name, a.updated_at
    FROM approvals a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN users cu ON cu.id = a.created_by
    LEFT JOIN users uu ON uu.id = a.updated_by`;

// Turns the CSV of department ids into an array for the client.
function hydrate(row) {
  if (!row) return row;
  const { department_ids_csv: csv, ...rest } = row;
  return { ...rest, department_ids: csv ? String(csv).split(',').map(Number).sort((x, y) => x - y) : [] };
}
const all = async (sql, ...p) => (await q.all(sql, ...p)).map(hydrate);
const one = async (sql, ...p) => hydrate(await q.get(sql, ...p));
const inList = (ids) => ids.map(() => '?').join(',');

function parseIds(v) {
  const list = Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : String(v).split(',');
  return [...new Set(list.map((x) => parseInt(x, 10)).filter(Number.isInteger))].sort((x, y) => x - y);
}

const clientDeptIds = async (clientId) =>
  (await q.all('SELECT department_id FROM client_departments WHERE client_id = ? ORDER BY department_id', clientId)).map((r) => r.department_id);

const deptNames = async (ids) =>
  ids.length ? (await q.all(`SELECT name FROM departments WHERE id IN (${inList(ids)}) ORDER BY name`, ...ids)).map((r) => r.name) : [];

// Departments on an approval must come from the client's departments (when the client has any mapped).
async function checkDepartments(ids, clientId, previous = []) {
  const allowed = await clientDeptIds(clientId);
  if (allowed.length) {
    if (!ids.length) throw httpError(400, 'Please select at least one Department for this client.');
    const bad = ids.filter((id) => !allowed.includes(id) && !previous.includes(id));
    if (bad.length) throw httpError(400, 'One or more selected departments are not mapped to this client.');
  }
  if (ids.length && (await q.get(`SELECT COUNT(*) c FROM departments WHERE id IN (${inList(ids)})`, ...ids)).c !== ids.length) {
    throw httpError(400, 'Invalid Department.');
  }
}

async function saveDepartments(approvalId, ids) {
  await q.run('DELETE FROM approval_departments WHERE approval_id = ?', approvalId);
  for (const id of ids) await q.run('INSERT INTO approval_departments (approval_id, department_id) VALUES (?, ?)', approvalId, id);
}

const SORTS = {
  ticket_number: 'a.ticket_number', client_name: 'c.name', approved_man_days: 'a.approved_man_days', given_man_days: 'a.given_man_days',
  approved_by: 'a.approved_by', approved_date: 'a.approved_date', created_at: 'a.created_at', updated_at: 'a.updated_at',
  created_by_name: 'cu.employee_name', updated_by_name: 'uu.employee_name',
};

async function buildFilters(qs) {
  const where = ['a.is_deleted = 0'];
  const params = [];
  const desc = [];

  if (qs.clientIds) {
    const ids = parseIds(qs.clientIds);
    if (ids.length) {
      where.push(`a.client_id IN (${inList(ids)})`);
      params.push(...ids);
      const names = (await q.all(`SELECT name FROM clients WHERE id IN (${inList(ids)}) ORDER BY name`, ...ids)).map((r) => r.name);
      desc.push(`Client: ${names.join(', ')}`);
    }
  }
  const ticket = str(qs.ticket);
  if (ticket) {
    where.push("a.ticket_number ILIKE ? ESCAPE '\\'");
    params.push(`%${escLike(ticket)}%`);
    desc.push(`Ticket: ${ticket}`);
  }
  for (const [key, op, label] of [['fromDate', '>=', 'From'], ['toDate', '<=', 'To'], ['approvedDate', '=', 'Approved Date']]) {
    if (qs[key]) {
      if (!isIsoDate(qs[key])) throw httpError(400, `${label} date is invalid.`);
      where.push(`a.approved_date ${op} ?`);
      params.push(qs[key]);
      desc.push(`${label}: ${qs[key].split('-').reverse().join('-')}`);
    }
  }
  if (qs.fromDate && qs.toDate && qs.fromDate > qs.toDate) throw httpError(400, 'From Date cannot be after To Date.');
  if (qs.ticketType && TICKET_TYPES.includes(qs.ticketType)) {
    where.push('a.ticket_type = ?');
    params.push(qs.ticketType);
    desc.push(`Ticket Type: ${qs.ticketType}`);
  }
  if (qs.departmentId && Number.isInteger(+qs.departmentId)) {
    where.push('EXISTS (SELECT 1 FROM approval_departments ad WHERE ad.approval_id = a.id AND ad.department_id = ?)');
    params.push(+qs.departmentId);
    desc.push(`Department: ${(await deptNames([+qs.departmentId])).join('')}`);
  }
  return { sql: `WHERE ${where.join(' AND ')}`, params, desc };
}

function orderBy(qs) {
  const col = SORTS[qs.sort] || 'a.created_at';
  const dir = String(qs.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${col} ${dir} NULLS LAST, a.id DESC`;
}

function parseManDays(v, label = 'Approved Man-Days') {
  const s = str(v);
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw httpError(400, `${label} must be a positive number (up to 2 decimals).`);
  const n = Number(s);
  if (!(n > 0)) throw httpError(400, `${label} must be greater than zero.`);
  if (n > MAX_MAN_DAYS) throw httpError(400, `${label} looks too large.`);
  return n;
}

function parseApprovedDate(v) {
  if (!isIsoDate(v)) throw httpError(400, 'Approved Date is required and must be a valid date.');
  if (v > todayLocal()) throw httpError(400, 'Approved Date cannot be in the future.');
  return v;
}

function readApproval(body) {
  const ticket_number = str(body.ticket_number).toUpperCase();
  if (!ticket_number) throw httpError(400, 'Ticket Number is required.');
  if (!/^[A-Z0-9][A-Z0-9\-_/.]{0,49}$/.test(ticket_number)) {
    throw httpError(400, 'Ticket Number may contain letters, numbers, - _ / . (max 50 characters).');
  }
  const client_id = parseInt(body.client_id, 10);
  if (!Number.isInteger(client_id)) throw httpError(400, 'Client Name is required.');
  const approved_by = str(body.approved_by);
  if (!approved_by) throw httpError(400, 'Approved By is required.');
  if (approved_by.length > 150) throw httpError(400, 'Approved By must be 150 characters or fewer.');
  const remarks = str(body.remarks);
  if (remarks.length > 2000) throw httpError(400, 'Remarks must be 2000 characters or fewer.');
  const ticket_type = str(body.ticket_type) || null;
  if (ticket_type && !TICKET_TYPES.includes(ticket_type)) throw httpError(400, 'Invalid Ticket Type.');

  return {
    ticket_number, client_id, approved_by, remarks, ticket_type, department_ids: parseIds(body.department_ids),
    approved_man_days: parseManDays(body.approved_man_days),
    given_man_days: str(body.given_man_days) ? parseManDays(body.given_man_days, 'Given Man-Days') : null,
    approved_date: parseApprovedDate(body.approved_date),
  };
}

const findDuplicate = (ticket, clientId, excludeId = 0) =>
  one(`${SELECT} WHERE a.is_deleted = 0 AND a.ticket_number = ? AND a.client_id = ? AND a.id <> ?`, ticket, clientId, excludeId);

async function getApproval(id) {
  if (!Number.isInteger(id)) throw httpError(404, 'Approval record not found.');
  const row = await one(`${SELECT} WHERE a.id = ? AND a.is_deleted = 0`, id);
  if (!row) throw httpError(404, 'Approval record not found.');
  return row;
}

/* -------------------------------- Lookups -------------------------------- */

router.get('/lookups', async (req, res) => {
  const clients = await q.all(
    `SELECT c.id, c.name, c.status, (SELECT string_agg(cd.department_id::text, ',') FROM client_departments cd WHERE cd.client_id = c.id) AS dept_csv
       FROM clients c ORDER BY c.name`
  );
  res.json({
    clients: clients.map(({ dept_csv: csv, ...c }) => ({ ...c, department_ids: csv ? String(csv).split(',').map(Number) : [] })),
    departments: await q.all("SELECT id, name FROM departments WHERE status = 'Active' ORDER BY name"),
    ticketTypes: TICKET_TYPES,
    states: STATES,
  });
});

/* -------------------------------- Listing -------------------------------- */

// Cheap change token so open listing screens can pick up new submissions straight away.
async function dataVersion() {
  return String((await q.get("SELECT MAX(id) AS v FROM audit_log WHERE entity = 'APPROVAL' AND action NOT LIKE 'EXPORT%'")).v || 0);
}

router.get('/approvals', requirePerm('approval.view'), async (req, res) => {
  const f = await buildFilters(req.query);
  const { page, pageSize, offset } = paging(req.query);
  const totals = await q.get(
    `SELECT COUNT(*) AS total, COALESCE(SUM(a.approved_man_days), 0) AS man_days FROM approvals a JOIN clients c ON c.id = a.client_id ${f.sql}`,
    ...f.params
  );
  const rows = await all(`${SELECT} ${f.sql} ${orderBy(req.query)} LIMIT ? OFFSET ?`, ...f.params, pageSize, offset);
  res.json({ rows, page, pageSize, total: totals.total, totalManDays: totals.man_days, version: await dataVersion() });
});

router.get('/approvals/version', requirePerm('approval.view'), async (req, res) => res.json({ version: await dataVersion() }));

router.get('/approvals/check', requirePerm('approval.add', 'approval.edit'), async (req, res) => {
  const ticket = str(req.query.ticket).toUpperCase();
  const clientId = parseInt(req.query.clientId, 10);
  if (!ticket || !Number.isInteger(clientId)) return res.json({ duplicate: null });
  res.json({ duplicate: (await findDuplicate(ticket, clientId, parseInt(req.query.excludeId, 10) || 0)) || null });
});

async function runExport(req, res, kind) {
  const f = await buildFilters(req.query);
  const rows = await all(`${SELECT} ${f.sql} ${orderBy(req.query)} LIMIT 50000`, ...f.params);
  await audit({ entity: 'APPROVAL', action: kind === 'excel' ? 'EXPORT_EXCEL' : 'EXPORT_PDF', remarks: `${rows.length} record(s) exported${f.desc.length ? ' — ' + f.desc.join('; ') : ''}`, user: req.user });
  if (kind === 'excel') await exportExcel(res, rows, f.desc, req.user);
  else exportPdf(res, rows, f.desc, req.user);
}

router.get('/approvals/export/excel', requirePerm('approval.export'), (req, res) => runExport(req, res, 'excel'));
router.get('/approvals/export/pdf', requirePerm('approval.export'), (req, res) => runExport(req, res, 'pdf'));

router.get('/approvals/:id', requirePerm('approval.view'), async (req, res) => {
  const row = await getApproval(+req.params.id);
  const history = (await q.all("SELECT * FROM audit_log WHERE entity = 'APPROVAL' AND entity_id = ? ORDER BY id DESC", row.id))
    .map((h) => ({ ...h, changes: h.changes ? JSON.parse(h.changes) : null }));
  res.json({ ...row, history });
});

/* ------------------------------ Create / edit ----------------------------- */

router.post('/approvals', requirePerm('approval.add'), async (req, res) => {
  const a = readApproval(req.body);
  const client = await q.get('SELECT * FROM clients WHERE id = ?', a.client_id);
  if (!client) throw httpError(400, 'Client Name is required.');
  if (client.status !== 'Active') throw httpError(400, 'The selected client is inactive.');

  const dup = await findDuplicate(a.ticket_number, a.client_id);
  if (dup) {
    throw httpError(409, `An approval for ticket ${a.ticket_number} and client ${client.name} already exists.`, { code: 'DUPLICATE', existing: dup });
  }
  await checkDepartments(a.department_ids, a.client_id);

  const id = await tx(async () => {
    const r = await q.insert(
      `INSERT INTO approvals (ticket_number, client_id, ticket_type, approved_man_days, given_man_days, approved_by, approved_date, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      a.ticket_number, a.client_id, a.ticket_type, a.approved_man_days, a.given_man_days, a.approved_by, a.approved_date, a.remarks, req.user.id
    );
    const id = r.lastInsertRowid;
    await saveDepartments(id, a.department_ids);
    await audit({
      entity: 'APPROVAL', entityId: id, action: 'CREATE', ticket: a.ticket_number, prev: null, next: a.approved_man_days,
      changes: {
        given_man_days: { from: null, to: a.given_man_days },
        approved_by: { from: null, to: a.approved_by }, approved_date: { from: null, to: a.approved_date },
        departments: { from: null, to: (await deptNames(a.department_ids)).join(', ') || null },
      },
      remarks: a.remarks || null, user: req.user,
    });
    return id;
  });
  res.status(201).json(await getApproval(id));
});

router.put('/approvals/:id', requirePerm('approval.edit'), async (req, res) => {
  const before = await getApproval(+req.params.id);
  const a = readApproval(req.body);
  const reason = str(req.body.modification_remarks);
  if (!reason) throw httpError(400, 'Modification Remarks are required when editing an approval.');

  const client = await q.get('SELECT * FROM clients WHERE id = ?', a.client_id);
  if (!client) throw httpError(400, 'Client Name is required.');
  if (client.id !== before.client_id && client.status !== 'Active') throw httpError(400, 'The selected client is inactive.');
  if (await findDuplicate(a.ticket_number, a.client_id, before.id)) {
    throw httpError(409, `Another approval for ticket ${a.ticket_number} and client ${client.name} already exists.`);
  }
  await checkDepartments(a.department_ids, a.client_id, a.client_id === before.client_id ? before.department_ids : []);

  const fields = ['ticket_number', 'client_id', 'ticket_type', 'approved_man_days', 'given_man_days', 'approved_by', 'approved_date', 'remarks'];
  const changes = {};
  for (const f of fields) {
    if (String(before[f] ?? '') !== String(a[f] ?? '')) changes[f] = { from: before[f], to: a[f] };
  }
  if (changes.client_id) changes.client_id = { from: before.client_name, to: client.name };
  if (before.department_ids.join(',') !== a.department_ids.join(',')) {
    changes.departments = { from: before.department_names || null, to: (await deptNames(a.department_ids)).join(', ') || null };
  }
  if (!Object.keys(changes).length) throw httpError(400, 'No changes were made.');

  await tx(async () => {
    await q.run(
      `UPDATE approvals SET ticket_number = ?, client_id = ?, ticket_type = ?, approved_man_days = ?, given_man_days = ?, approved_by = ?,
              approved_date = ?, remarks = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`,
      a.ticket_number, a.client_id, a.ticket_type, a.approved_man_days, a.given_man_days, a.approved_by, a.approved_date, a.remarks, req.user.id, before.id
    );
    await saveDepartments(before.id, a.department_ids);
    await audit({
      entity: 'APPROVAL', entityId: before.id, action: 'UPDATE', ticket: a.ticket_number,
      prev: before.approved_man_days, next: a.approved_man_days, changes, remarks: reason, user: req.user,
    });
  });
  res.json(await getApproval(before.id));
});

// Controlled additional approval against an existing ticket (FRD business rule 8).
router.post('/approvals/:id/additional', requirePerm('approval.edit'), async (req, res) => {
  const before = await getApproval(+req.params.id);
  const extra = parseManDays(req.body.additional_man_days, 'Additional Man-Days');
  const approvedBy = str(req.body.approved_by);
  if (!approvedBy) throw httpError(400, 'Approved By is required.');
  const approvedDate = parseApprovedDate(req.body.approved_date);
  const remarks = str(req.body.remarks);
  if (!remarks) throw httpError(400, 'Remarks are required for an additional approval.');

  const total = Math.round((before.approved_man_days + extra) * 100) / 100;
  if (total > MAX_MAN_DAYS) throw httpError(400, 'Total man-days looks too large.');

  await tx(async () => {
    await q.run(
      `UPDATE approvals SET approved_man_days = ?, approved_by = ?, approved_date = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`,
      total, approvedBy, approvedDate, req.user.id, before.id
    );
    await audit({
      entity: 'APPROVAL', entityId: before.id, action: 'ADDITIONAL_APPROVAL', ticket: before.ticket_number,
      prev: before.approved_man_days, next: total,
      changes: {
        additional_man_days: { from: null, to: extra },
        approved_by: { from: before.approved_by, to: approvedBy },
        approved_date: { from: before.approved_date, to: approvedDate },
      },
      remarks, user: req.user,
    });
  });
  res.json(await getApproval(before.id));
});

router.delete('/approvals/:id', requirePerm('approval.delete'), async (req, res) => {
  const before = await getApproval(+req.params.id);
  const reason = str(req.body && req.body.reason);
  if (!reason) throw httpError(400, 'A reason is required to delete an approval.');
  await tx(async () => {
    await q.run(`UPDATE approvals SET is_deleted = 1, deleted_by = ?, deleted_at = ${NOW} WHERE id = ?`, req.user.id, before.id);
    await audit({
      entity: 'APPROVAL', entityId: before.id, action: 'DELETE', ticket: before.ticket_number,
      prev: before.approved_man_days, next: null, remarks: reason, user: req.user,
    });
  });
  res.json({ ok: true });
});

/* ------------------------------- Dashboard ------------------------------- */

router.get('/dashboard', requirePerm('dashboard.view'), async (req, res) => {
  const f = await buildFilters(req.query);
  const base = `FROM approvals a JOIN clients c ON c.id = a.client_id ${f.sql}`;
  const deptBase = `FROM approvals a JOIN clients c ON c.id = a.client_id
    LEFT JOIN approval_departments ad ON ad.approval_id = a.id LEFT JOIN departments d ON d.id = ad.department_id ${f.sql}`;
  const month = todayLocal().slice(0, 7);

  const [totals, thisMonth, byClient, byMonth, byDepartment, byType, recent] = await Promise.all([
    q.get(`SELECT COUNT(*) AS tickets, COALESCE(SUM(a.approved_man_days),0) AS man_days, COUNT(DISTINCT a.client_id) AS clients ${base}`, ...f.params),
    q.get(`SELECT COUNT(*) AS tickets, COALESCE(SUM(a.approved_man_days),0) AS man_days ${base} AND substr(a.approved_date,1,7) = ?`, ...f.params, month),
    q.all(`SELECT c.name AS label, COUNT(*) AS tickets, SUM(a.approved_man_days) AS man_days ${base} GROUP BY c.id, c.name ORDER BY man_days DESC`, ...f.params),
    q.all(`SELECT substr(a.approved_date,1,7) AS label, COUNT(*) AS tickets, SUM(a.approved_man_days) AS man_days ${base}
             GROUP BY substr(a.approved_date,1,7) ORDER BY label DESC LIMIT 12`, ...f.params),
    q.all(`SELECT COALESCE(d.name::text,'Not specified') AS label, COUNT(*) AS tickets, SUM(a.approved_man_days) AS man_days ${deptBase}
             GROUP BY d.id, d.name ORDER BY tickets DESC`, ...f.params),
    q.all(`SELECT COALESCE(a.ticket_type,'Not specified') AS label, COUNT(*) AS tickets, SUM(a.approved_man_days) AS man_days ${base}
             GROUP BY a.ticket_type ORDER BY man_days DESC`, ...f.params),
    all(`${SELECT} ${f.sql} ORDER BY COALESCE(a.updated_at, a.created_at) DESC LIMIT 6`, ...f.params),
  ]);

  res.json({
    totals: { ...totals, month_tickets: thisMonth.tickets, month_man_days: thisMonth.man_days },
    byClient, byMonth: byMonth.reverse(), byDepartment, byType, recent,
  });
});

/* ------------------------------- Audit log ------------------------------- */

router.get('/audit', requirePerm('audit.view'), async (req, res) => {
  const where = [];
  const params = [];
  const isAdmin = req.user.permissions.includes('user.manage') || req.user.permissions.includes('role.manage');
  // Non-admin users only see the approval trail, not user/role administration events.
  if (!isAdmin) where.push("entity IN ('APPROVAL','QUOTATION','PO','INVOICE')");
  if (req.query.entity) { where.push('entity = ?'); params.push(String(req.query.entity)); }
  if (req.query.action) { where.push('action = ?'); params.push(String(req.query.action)); }
  const ticket = str(req.query.ticket);
  if (ticket) { where.push("ticket_number ILIKE ? ESCAPE '\\'"); params.push(`%${escLike(ticket)}%`); }
  const search = str(req.query.search);
  if (search) { where.push("(remarks ILIKE ? ESCAPE '\\' OR user_name ILIKE ? ESCAPE '\\')"); params.push(`%${escLike(search)}%`, `%${escLike(search)}%`); }
  if (req.query.fromDate && isIsoDate(req.query.fromDate)) { where.push('substr(created_at,1,10) >= ?'); params.push(req.query.fromDate); }
  if (req.query.toDate && isIsoDate(req.query.toDate)) { where.push('substr(created_at,1,10) <= ?'); params.push(req.query.toDate); }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { page, pageSize, offset } = paging(req.query);
  const total = (await q.get(`SELECT COUNT(*) c FROM audit_log ${sql}`, ...params)).c;
  const rows = (await q.all(`SELECT * FROM audit_log ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, pageSize, offset))
    .map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : null }));
  res.json({ rows, total, page, pageSize, isAdmin });
});

module.exports = router;
