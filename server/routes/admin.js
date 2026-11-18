const bcrypt = require('bcryptjs');
const { q, tx, audit, code, NOW } = require('../db');
const { requirePerm, safeJson } = require('../auth');
const { ALL_KEYS } = require('../permissions');
const { str, httpError, validatePassword, asyncRouter } = require('../util');
const { STATES, GSTIN_RE } = require('../gst');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function optText(v, label, max) {
  const s = str(v);
  if (s.length > max) throw httpError(400, `${label} must be ${max} characters or fewer.`);
  return s || null;
}
function optGstin(v, label = 'GSTIN') {
  const s = str(v).toUpperCase();
  if (s && !GSTIN_RE.test(s)) throw httpError(400, `${label} is not valid (15 characters, e.g. 27ABCDE1234F1Z5).`);
  return s || null;
}
function optState(v) {
  const s = str(v);
  if (s && !STATES.some((x) => x.code === s)) throw httpError(400, 'Invalid State.');
  return s || null;
}
function optEmails(v, label) {
  const s = str(v);
  if (s && !s.split(/[,;]\s*/).filter(Boolean).every((e) => EMAIL_RE.test(e.trim()))) throw httpError(400, `${label} is not a valid email address.`);
  if (s.length > 300) throw httpError(400, `${label} is too long.`);
  return s || null;
}

const router = asyncRouter();
const STATUSES = ['Active', 'Inactive'];

function diff(before, after, fields) {
  const changes = {};
  for (const f of fields) {
    const a = before[f] === undefined ? null : before[f];
    const b = after[f] === undefined ? null : after[f];
    if (String(a ?? '') !== String(b ?? '')) changes[f] = { from: a, to: b };
  }
  return changes;
}

function statusOf(v, fallback = 'Active') {
  const s = str(v) || fallback;
  if (!STATUSES.includes(s)) throw httpError(400, 'Status must be Active or Inactive.');
  return s;
}

const intIds = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => parseInt(x, 10)).filter(Number.isInteger))].sort((a, b) => a - b);
const inList = (ids) => ids.map(() => '?').join(',');

/* ----------------------------- Departments ----------------------------- */

router.get('/departments', requirePerm('department.manage', 'user.manage'), async (req, res) => {
  res.json(
    await q.all(`SELECT d.*, (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id) AS user_count
                   FROM departments d ORDER BY d.name`)
  );
});

function readDepartment(body) {
  const name = str(body.name);
  const description = str(body.description);
  if (!name) throw httpError(400, 'Department Name is required.');
  if (name.length > 100) throw httpError(400, 'Department Name must be 100 characters or fewer.');
  if (description.length > 500) throw httpError(400, 'Description must be 500 characters or fewer.');
  return { name, description, status: statusOf(body.status) };
}

router.post('/departments', requirePerm('department.manage'), async (req, res) => {
  const d = readDepartment(req.body);
  const id = await tx(async () => {
    const r = await q.insert('INSERT INTO departments (name, description, status) VALUES (?,?,?)', d.name, d.description, d.status);
    const id = r.lastInsertRowid;
    await q.run('UPDATE departments SET code = ? WHERE id = ?', code('DEPT', id, 3), id);
    await audit({ entity: 'DEPARTMENT', entityId: id, action: 'CREATE', remarks: `Department "${d.name}" created`, user: req.user });
    return id;
  });
  res.status(201).json(await q.get('SELECT * FROM departments WHERE id = ?', id));
});

router.put('/departments/:id', requirePerm('department.manage'), async (req, res) => {
  const before = await q.get('SELECT * FROM departments WHERE id = ?', +req.params.id);
  if (!before) throw httpError(404, 'Department not found.');
  const d = readDepartment(req.body);
  await q.run(
    `UPDATE departments SET name = ?, description = ?, status = ?, updated_at = ${NOW} WHERE id = ?`,
    d.name, d.description, d.status, before.id
  );
  const changes = diff(before, d, ['name', 'description', 'status']);
  if (Object.keys(changes).length) {
    await audit({ entity: 'DEPARTMENT', entityId: before.id, action: 'UPDATE', changes, remarks: `Department "${d.name}" updated`, user: req.user });
  }
  res.json(await q.get('SELECT * FROM departments WHERE id = ?', before.id));
});

router.delete('/departments/:id', requirePerm('department.manage'), async (req, res) => {
  const d = await q.get('SELECT * FROM departments WHERE id = ?', +req.params.id);
  if (!d) throw httpError(404, 'Department not found.');
  const used = (await q.get(
    `SELECT (SELECT COUNT(*) FROM users WHERE department_id = ?)
          + (SELECT COUNT(*) FROM approval_departments WHERE department_id = ?)
          + (SELECT COUNT(*) FROM client_departments WHERE department_id = ?) AS c`,
    d.id, d.id, d.id
  )).c;
  if (used) throw httpError(409, 'This department is in use by users, clients or approvals. Mark it Inactive instead.');
  await q.run('DELETE FROM departments WHERE id = ?', d.id);
  await audit({ entity: 'DEPARTMENT', entityId: d.id, action: 'DELETE', remarks: `Department "${d.name}" deleted`, user: req.user });
  res.json({ ok: true });
});

/* -------------------------------- Roles -------------------------------- */

router.get('/roles', requirePerm('role.manage', 'user.manage'), async (req, res) => {
  const rows = await q.all(
    `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count FROM roles r ORDER BY r.is_system DESC, r.name`
  );
  res.json(rows.map((r) => ({ ...r, permissions: safeJson(r.permissions) })));
});

function readRole(body) {
  const name = str(body.name);
  const description = str(body.description);
  if (!name) throw httpError(400, 'Role Name is required.');
  if (name.length > 100) throw httpError(400, 'Role Name must be 100 characters or fewer.');
  const permissions = Array.isArray(body.permissions) ? [...new Set(body.permissions.filter((k) => ALL_KEYS.includes(k)))] : [];
  return { name, description, permissions, status: statusOf(body.status) };
}

router.post('/roles', requirePerm('role.manage'), async (req, res) => {
  const r = readRole(req.body);
  const id = (await q.insert(
    'INSERT INTO roles (name, description, permissions, status) VALUES (?,?,?,?)', r.name, r.description, JSON.stringify(r.permissions), r.status
  )).lastInsertRowid;
  await audit({ entity: 'ROLE', entityId: id, action: 'CREATE', changes: { permissions: { from: null, to: r.permissions } }, remarks: `Role "${r.name}" created`, user: req.user });
  res.status(201).json({ id });
});

router.put('/roles/:id', requirePerm('role.manage'), async (req, res) => {
  const before = await q.get('SELECT * FROM roles WHERE id = ?', +req.params.id);
  if (!before) throw httpError(404, 'Role not found.');
  const r = readRole(req.body);
  if (before.is_system) {
    // The Admin role always keeps every permission and stays active, so the portal can never be locked out.
    r.permissions = ALL_KEYS;
    r.status = 'Active';
    r.name = before.name;
  }
  if (before.id === req.user.role_id && r.status !== 'Active') throw httpError(400, 'You cannot deactivate your own role.');
  await q.run(
    `UPDATE roles SET name = ?, description = ?, permissions = ?, status = ?, updated_at = ${NOW} WHERE id = ?`,
    r.name, r.description, JSON.stringify(r.permissions), r.status, before.id
  );
  const changes = diff(before, { ...r, permissions: JSON.stringify(r.permissions) }, ['name', 'description', 'status', 'permissions']);
  if (changes.permissions) changes.permissions = { from: safeJson(before.permissions), to: r.permissions };
  if (Object.keys(changes).length) {
    await audit({ entity: 'ROLE', entityId: before.id, action: 'UPDATE', changes, remarks: `Role "${r.name}" updated`, user: req.user });
  }
  res.json({ ok: true });
});

router.delete('/roles/:id', requirePerm('role.manage'), async (req, res) => {
  const r = await q.get('SELECT * FROM roles WHERE id = ?', +req.params.id);
  if (!r) throw httpError(404, 'Role not found.');
  if (r.is_system) throw httpError(400, 'The Admin role cannot be deleted.');
  if ((await q.get('SELECT COUNT(*) c FROM users WHERE role_id = ?', r.id)).c) {
    throw httpError(409, 'This role is assigned to users. Reassign them or mark the role Inactive.');
  }
  await q.run('DELETE FROM roles WHERE id = ?', r.id);
  await audit({ entity: 'ROLE', entityId: r.id, action: 'DELETE', remarks: `Role "${r.name}" deleted`, user: req.user });
  res.json({ ok: true });
});

/* -------------------------------- Users -------------------------------- */

const USER_SELECT = `
  SELECT u.id, u.user_code, u.employee_name, u.employee_code, u.email, u.mobile, u.department_id, d.name AS department_name,
         u.role_id, r.name AS role_name, u.username, u.status, u.must_change_password, u.last_login_at, u.created_at, u.updated_at
    FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN departments d ON d.id = u.department_id`;

router.get('/users', requirePerm('user.manage'), async (req, res) => {
  res.json(await q.all(`${USER_SELECT} ORDER BY u.employee_name`));
});

async function readUser(body, isNew) {
  const u = {
    employee_name: str(body.employee_name),
    employee_code: str(body.employee_code),
    email: str(body.email).toLowerCase(),
    mobile: str(body.mobile),
    department_id: parseInt(body.department_id, 10),
    role_id: parseInt(body.role_id, 10),
    username: str(body.username).toLowerCase(),
    status: statusOf(body.status),
  };
  if (!u.employee_name) throw httpError(400, 'Employee Name is required.');
  if (!u.employee_code) throw httpError(400, 'Employee Code is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email)) throw httpError(400, 'A valid Email ID is required.');
  if (u.mobile && !/^\+?[0-9 \-]{7,15}$/.test(u.mobile)) throw httpError(400, 'Mobile Number must contain 7 to 15 digits.');
  if (!/^[a-z0-9._-]{3,50}$/.test(u.username)) throw httpError(400, 'Username must be 3-50 characters: letters, numbers, dot, dash or underscore.');
  if (!Number.isInteger(u.department_id) || !(await q.get('SELECT id FROM departments WHERE id = ?', u.department_id))) throw httpError(400, 'Please select a Department.');
  if (!Number.isInteger(u.role_id) || !(await q.get('SELECT id FROM roles WHERE id = ?', u.role_id))) throw httpError(400, 'Please select a Role.');
  const pwd = typeof body.password === 'string' ? body.password : '';
  if (isNew || pwd) {
    const msg = validatePassword(pwd);
    if (msg) throw httpError(400, msg);
    u.password = pwd;
  }
  return u;
}

router.post('/users', requirePerm('user.manage'), async (req, res) => {
  const u = await readUser(req.body, true);
  const id = await tx(async () => {
    const r = await q.insert(
      `INSERT INTO users (employee_name, employee_code, email, mobile, department_id, role_id, username, password_hash, status, must_change_password)
       VALUES (?,?,?,?,?,?,?,?,?,1)`,
      u.employee_name, u.employee_code, u.email, u.mobile, u.department_id, u.role_id, u.username, bcrypt.hashSync(u.password, 10), u.status
    );
    const id = r.lastInsertRowid;
    await q.run('UPDATE users SET user_code = ? WHERE id = ?', code('USR', id, 4), id);
    await audit({ entity: 'USER', entityId: id, action: 'CREATE', remarks: `User "${u.username}" created`, user: req.user });
    return id;
  });
  res.status(201).json(await q.get(`${USER_SELECT} WHERE u.id = ?`, id));
});

router.put('/users/:id', requirePerm('user.manage'), async (req, res) => {
  const before = await q.get('SELECT * FROM users WHERE id = ?', +req.params.id);
  if (!before) throw httpError(404, 'User not found.');
  const u = await readUser(req.body, false);
  if (before.id === req.user.id && u.status !== 'Active') throw httpError(400, 'You cannot deactivate your own account.');
  if (before.id === req.user.id && u.role_id !== before.role_id) throw httpError(400, 'You cannot change your own role.');

  await tx(async () => {
    await q.run(
      `UPDATE users SET employee_name = ?, employee_code = ?, email = ?, mobile = ?, department_id = ?, role_id = ?, username = ?, status = ?,
              updated_at = ${NOW} WHERE id = ?`,
      u.employee_name, u.employee_code, u.email, u.mobile, u.department_id, u.role_id, u.username, u.status, before.id
    );
    if (u.password) {
      await q.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', bcrypt.hashSync(u.password, 10), before.id);
    }
    const changes = diff(before, u, ['employee_name', 'employee_code', 'email', 'mobile', 'department_id', 'role_id', 'username', 'status']);
    if (u.password) changes.password = { from: '••••', to: 'reset by admin' };
    if (Object.keys(changes).length) {
      await audit({ entity: 'USER', entityId: before.id, action: 'UPDATE', changes, remarks: `User "${u.username}" updated`, user: req.user });
    }
  });
  res.json(await q.get(`${USER_SELECT} WHERE u.id = ?`, before.id));
});

router.patch('/users/:id/status', requirePerm('user.manage'), async (req, res) => {
  const before = await q.get('SELECT * FROM users WHERE id = ?', +req.params.id);
  if (!before) throw httpError(404, 'User not found.');
  const status = statusOf(req.body.status);
  if (before.id === req.user.id && status !== 'Active') throw httpError(400, 'You cannot deactivate your own account.');
  await q.run(`UPDATE users SET status = ?, updated_at = ${NOW} WHERE id = ?`, status, before.id);
  await audit({
    entity: 'USER', entityId: before.id, action: status === 'Active' ? 'ACTIVATE' : 'DEACTIVATE',
    changes: { status: { from: before.status, to: status } }, remarks: `User "${before.username}" ${status === 'Active' ? 'activated' : 'deactivated'}`, user: req.user,
  });
  res.json({ ok: true });
});

/* ------------------------------- Clients ------------------------------- */

const clientDepts = (clientId) =>
  q.all(
    'SELECT d.id, d.name FROM client_departments cd JOIN departments d ON d.id = cd.department_id WHERE cd.client_id = ? ORDER BY d.name',
    clientId
  );

router.get('/clients', requirePerm('client.manage'), async (req, res) => {
  const rows = await q.all(`SELECT c.*, (SELECT COUNT(*) FROM approvals a WHERE a.client_id = c.id AND a.is_deleted = 0) AS ticket_count
                              FROM clients c ORDER BY c.name`);
  const links = await q.all(
    'SELECT cd.client_id, d.id, d.name FROM client_departments cd JOIN departments d ON d.id = cd.department_id ORDER BY d.name'
  );
  res.json(rows.map((c) => {
    const depts = links.filter((l) => l.client_id === c.id);
    return { ...c, department_ids: depts.map((d) => d.id), department_names: depts.map((d) => d.name) };
  }));
});

async function readClient(body) {
  const name = str(body.name);
  if (!name) throw httpError(400, 'Client Name is required.');
  if (name.length > 150) throw httpError(400, 'Client Name must be 150 characters or fewer.');
  const department_ids = intIds(body.department_ids);
  if (!department_ids.length) throw httpError(400, 'Please select at least one Department for the client.');
  const found = (await q.get(`SELECT COUNT(*) c FROM departments WHERE id IN (${inList(department_ids)})`, ...department_ids)).c;
  if (found !== department_ids.length) throw httpError(400, 'Invalid Department selected.');
  const gstin = optGstin(body.gstin);
  let state_code = optState(body.state_code);
  if (gstin && !state_code) state_code = optState(gstin.slice(0, 2));
  if (gstin && state_code && gstin.slice(0, 2) !== state_code) throw httpError(400, 'The GSTIN does not belong to the selected State (first 2 digits are the state code).');
  const task_approval = str(body.task_approval) || 'Default';
  if (!['Default', 'On', 'Off'].includes(task_approval)) throw httpError(400, 'Invalid task approval setting.');
  const client_type = str(body.client_type) || null;
  if (client_type && !['Hospital', 'Medical College', 'Clinic', 'Other'].includes(client_type)) throw httpError(400, 'Invalid client type.');
  const phone = str(body.phone);
  if (phone && !/^[0-9+\-\s]{6,20}$/.test(phone)) throw httpError(400, 'Phone number is not valid.');
  return {
    name, description: str(body.description), status: statusOf(body.status), department_ids,
    client_code: optText(body.client_code, 'Client Code', 30), client_type, city: optText(body.city, 'City', 100), phone: phone || null, task_approval,
    billing_address: optText(body.billing_address, 'Billing Address', 500), gstin, state_code,
    contact_person: optText(body.contact_person, 'Contact Person', 150), contact_email: optEmails(body.contact_email, 'Contact Email'),
  };
}
const CLIENT_BILLING = ['billing_address', 'gstin', 'state_code', 'contact_person', 'contact_email', 'client_code', 'client_type', 'city', 'phone', 'task_approval'];

async function saveClientDepts(clientId, ids) {
  await q.run('DELETE FROM client_departments WHERE client_id = ?', clientId);
  for (const id of ids) await q.run('INSERT INTO client_departments (client_id, department_id) VALUES (?, ?)', clientId, id);
}

router.post('/clients', requirePerm('client.manage'), async (req, res) => {
  const c = await readClient(req.body);
  const id = await tx(async () => {
    const id = (await q.insert(
      `INSERT INTO clients (name, description, status, billing_address, gstin, state_code, contact_person, contact_email, client_code, client_type, city, phone, task_approval)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      c.name, c.description, c.status, c.billing_address, c.gstin, c.state_code, c.contact_person, c.contact_email, c.client_code, c.client_type, c.city, c.phone, c.task_approval
    )).lastInsertRowid;
    await saveClientDepts(id, c.department_ids);
    await audit({
      entity: 'CLIENT', entityId: id, action: 'CREATE', remarks: `Client "${c.name}" created`, user: req.user,
      changes: { departments: { from: null, to: (await clientDepts(id)).map((d) => d.name).join(', ') } },
    });
    return id;
  });
  res.status(201).json({ id });
});

router.put('/clients/:id', requirePerm('client.manage'), async (req, res) => {
  const before = await q.get('SELECT * FROM clients WHERE id = ?', +req.params.id);
  if (!before) throw httpError(404, 'Client not found.');
  const c = await readClient(req.body);
  const beforeNames = (await clientDepts(before.id)).map((d) => d.name).join(', ');
  await tx(async () => {
    await q.run(
      `UPDATE clients SET name = ?, description = ?, status = ?, billing_address = ?, gstin = ?, state_code = ?, contact_person = ?, contact_email = ?,
              client_code = ?, client_type = ?, city = ?, phone = ?, task_approval = ?, updated_at = ${NOW} WHERE id = ?`,
      c.name, c.description, c.status, c.billing_address, c.gstin, c.state_code, c.contact_person, c.contact_email,
      c.client_code, c.client_type, c.city, c.phone, c.task_approval, before.id
    );
    await saveClientDepts(before.id, c.department_ids);
    const changes = diff(before, c, ['name', 'description', 'status', ...CLIENT_BILLING]);
    const afterNames = (await clientDepts(before.id)).map((d) => d.name).join(', ');
    if (afterNames !== beforeNames) changes.departments = { from: beforeNames || null, to: afterNames };
    if (Object.keys(changes).length) {
      await audit({ entity: 'CLIENT', entityId: before.id, action: 'UPDATE', changes, remarks: `Client "${c.name}" updated`, user: req.user });
    }
  });
  res.json({ ok: true });
});

router.delete('/clients/:id', requirePerm('client.manage'), async (req, res) => {
  const c = await q.get('SELECT * FROM clients WHERE id = ?', +req.params.id);
  if (!c) throw httpError(404, 'Client not found.');
  if ((await q.get('SELECT COUNT(*) c FROM approvals WHERE client_id = ?', c.id)).c) {
    throw httpError(409, 'This client has approval records. Mark it Inactive instead.');
  }
  if (await require('../impl/engine').clientInUse(c.id)) {
    throw httpError(409, 'This client has implementation records. Mark it Inactive instead.');
  }
  await q.run('DELETE FROM clients WHERE id = ?', c.id);
  await audit({ entity: 'CLIENT', entityId: c.id, action: 'DELETE', remarks: `Client "${c.name}" deleted`, user: req.user });
  res.json({ ok: true });
});

/* ---------------------------- Company settings ---------------------------- */

const COMPANY_FIELDS = ['company_name', 'address', 'state_code', 'gstin', 'pan', 'email', 'phone', 'website', 'bank_name', 'bank_account',
  'bank_ifsc', 'bank_branch', 'sac_code', 'default_rate', 'gst_rate', 'quote_validity_days', 'payment_terms_days', 'quotation_terms', 'invoice_terms'];

router.get('/company', requirePerm('company.manage'), async (req, res) => {
  res.json(await q.get('SELECT * FROM company_settings WHERE id = 1'));
});

function numField(v, label, { int = false, max = 1e9, required = false } = {}) {
  const s = str(v);
  if (!s) { if (required) throw httpError(400, `${label} is required.`); return null; }
  if (!(int ? /^\d+$/ : /^\d+(\.\d{1,2})?$/).test(s)) throw httpError(400, `${label} must be a ${int ? 'whole number' : 'number with up to 2 decimals'}.`);
  const n = Number(s);
  if (n > max) throw httpError(400, `${label} is too large.`);
  return n;
}

router.put('/company', requirePerm('company.manage'), async (req, res) => {
  const b = req.body;
  const company_name = str(b.company_name);
  if (!company_name) throw httpError(400, 'Company Name is required.');
  const pan = str(b.pan).toUpperCase();
  if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) throw httpError(400, 'PAN is not valid (e.g. ABCDE1234F).');
  const ifsc = str(b.bank_ifsc).toUpperCase();
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw httpError(400, 'IFSC is not valid (e.g. HDFC0001234).');
  const v = {
    company_name: optText(company_name, 'Company Name', 150),
    address: optText(b.address, 'Address', 500),
    state_code: optState(b.state_code),
    gstin: optGstin(b.gstin, 'Company GSTIN'),
    pan: pan || null,
    email: optEmails(b.email, 'Email'),
    phone: optText(b.phone, 'Phone', 50),
    website: optText(b.website, 'Website', 150),
    bank_name: optText(b.bank_name, 'Bank Name', 150),
    bank_account: optText(b.bank_account, 'Account Number', 40),
    bank_ifsc: ifsc || null,
    bank_branch: optText(b.bank_branch, 'Branch', 150),
    sac_code: optText(b.sac_code, 'SAC Code', 10) || '998314',
    default_rate: numField(b.default_rate, 'Default Rate per Man-Day'),
    gst_rate: numField(b.gst_rate, 'GST %', { max: 100, required: true }),
    quote_validity_days: numField(b.quote_validity_days, 'Quotation Validity (days)', { int: true, max: 365, required: true }),
    payment_terms_days: numField(b.payment_terms_days, 'Payment Terms (days)', { int: true, max: 365, required: true }),
    quotation_terms: optText(b.quotation_terms, 'Quotation Terms', 3000),
    invoice_terms: optText(b.invoice_terms, 'Invoice Terms', 3000),
  };
  if (v.gstin && v.state_code && v.gstin.slice(0, 2) !== v.state_code) throw httpError(400, 'The company GSTIN does not belong to the selected State.');
  if (v.gstin && !v.state_code) v.state_code = optState(v.gstin.slice(0, 2));
  const before = await q.get('SELECT * FROM company_settings WHERE id = 1');
  const changes = diff(before, v, COMPANY_FIELDS);
  if (!Object.keys(changes).length) return res.json(before);
  await tx(async () => {
    await q.run(
      `UPDATE company_settings SET ${COMPANY_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = ${NOW} WHERE id = 1`,
      ...COMPANY_FIELDS.map((f) => v[f])
    );
    await audit({ entity: 'COMPANY', entityId: 1, action: 'UPDATE', changes, remarks: 'Company settings updated', user: req.user });
  });
  res.json(await q.get('SELECT * FROM company_settings WHERE id = 1'));
});

module.exports = router;
