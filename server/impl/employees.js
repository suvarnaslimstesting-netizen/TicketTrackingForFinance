// /api/impl/employees — Implementation Manager creates and manages Implementation-only users.
// Users created here get app_scope = 'impl': they can never use the Ticket Tracking side,
// whatever role they are given later (see auth.js).
const bcrypt = require('bcryptjs');
const { q, tx, audit, code, NOW } = require('../db');
const { requirePerm } = require('../auth');
const { httpError, asyncRouter, str } = require('../util');
const { PERMISSIONS } = require('../permissions');
const { readUser } = require('../routes/admin');

const router = asyncRouter();
router.use(requirePerm('impl.users'));

// Permission keys that belong to the Implementation side.
const IMPL_KEYS = PERMISSIONS.filter((p) => ['Implementation', 'Attendance'].includes(p.group)).map((p) => p.key);

// Roles that only carry Implementation permissions (safe for Implementation-only users).
async function implRoles() {
  const roles = await q.all("SELECT id, name, description, permissions, status FROM roles WHERE is_system = 0 ORDER BY name");
  return roles
    .map((r) => ({ ...r, permissions: JSON.parse(r.permissions || '[]') }))
    .filter((r) => r.permissions.length && r.permissions.every((k) => IMPL_KEYS.includes(k)))
    .map(({ permissions, ...r }) => r);
}

const SELECT = `SELECT u.id, u.user_code, u.employee_name, u.employee_code, u.email, u.mobile, u.username, u.status, u.face_attendance,
    u.department_id, d.name AS department_name, u.role_id, r.name AS role_name, u.last_login_at, u.created_at,
    (SELECT enrolled_at FROM att_enrol e WHERE e.user_id = u.id) AS enrolled_at
  FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN departments d ON d.id = u.department_id`;

router.get('/', async (req, res) => {
  res.json({
    rows: await q.all(`${SELECT} WHERE u.app_scope = 'impl' ORDER BY u.status, u.employee_name`),
    roles: await implRoles(),
    departments: await q.all("SELECT id, name FROM departments WHERE status = 'Active' ORDER BY name"),
  });
});

async function readEmployee(body, isNew) {
  const u = await readUser(body, isNew);
  const roles = await implRoles();
  if (!roles.some((r) => r.id === u.role_id)) throw httpError(400, 'Please choose an Implementation role (for example Implementation Employee).');
  u.face_attendance = body.face_attendance === true || body.face_attendance === 1 || body.face_attendance === '1' ? 1 : 0;
  return u;
}

async function getEmployee(id) {
  const u = Number.isInteger(id) && (await q.get("SELECT * FROM users WHERE id = ? AND app_scope = 'impl'", id));
  if (!u) throw httpError(404, 'Implementation employee not found.');
  return u;
}

router.post('/', async (req, res) => {
  const u = await readEmployee(req.body, true);
  const id = await tx(async () => {
    const r = await q.insert(
      `INSERT INTO users (employee_name, employee_code, email, mobile, department_id, role_id, username, password_hash, status, must_change_password, app_scope, face_attendance)
       VALUES (?,?,?,?,?,?,?,?,?,1,'impl',?)`,
      u.employee_name, u.employee_code, u.email, u.mobile || null, u.department_id, u.role_id, u.username, bcrypt.hashSync(u.password, 10), u.status, u.face_attendance
    );
    const id = r.lastInsertRowid;
    await q.run('UPDATE users SET user_code = ? WHERE id = ?', code('USR', id, 4), id);
    await audit({ entity: 'USER', entityId: id, action: 'CREATE', remarks: `Implementation employee "${u.username}" created${u.face_attendance ? ' (face attendance ON)' : ''}`, user: req.user });
    return id;
  });
  res.status(201).json(await q.get(`${SELECT} WHERE u.id = ?`, id));
});

router.put('/:id', async (req, res) => {
  const before = await getEmployee(+req.params.id);
  const u = await readEmployee(req.body, false);
  if (before.id === req.user.id && u.status !== 'Active') throw httpError(400, 'You cannot deactivate your own account.');
  await tx(async () => {
    await q.run(
      `UPDATE users SET employee_name = ?, employee_code = ?, email = ?, mobile = ?, department_id = ?, role_id = ?, username = ?, status = ?, face_attendance = ?,
              updated_at = ${NOW} WHERE id = ?`,
      u.employee_name, u.employee_code, u.email, u.mobile || null, u.department_id, u.role_id, u.username, u.status, u.face_attendance, before.id
    );
    if (u.password) await q.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', bcrypt.hashSync(u.password, 10), before.id);
    const changes = {};
    for (const k of ['employee_name', 'employee_code', 'email', 'mobile', 'department_id', 'role_id', 'username', 'status', 'face_attendance']) {
      if (String(before[k] ?? '') !== String(u[k] ?? '')) changes[k] = { from: before[k], to: u[k] };
    }
    if (u.password) changes.password = { from: '••••', to: 'reset' };
    if (Object.keys(changes).length) await audit({ entity: 'USER', entityId: before.id, action: 'UPDATE', changes, remarks: `Implementation employee "${u.username}" updated`, user: req.user });
  });
  res.json(await q.get(`${SELECT} WHERE u.id = ?`, before.id));
});

router.patch('/:id/status', async (req, res) => {
  const before = await getEmployee(+req.params.id);
  const status = str(req.body.status) === 'Inactive' ? 'Inactive' : 'Active';
  if (before.id === req.user.id && status !== 'Active') throw httpError(400, 'You cannot deactivate your own account.');
  await q.run(`UPDATE users SET status = ?, updated_at = ${NOW} WHERE id = ?`, status, before.id);
  await audit({ entity: 'USER', entityId: before.id, action: status === 'Active' ? 'ACTIVATE' : 'DEACTIVATE', remarks: `Implementation employee "${before.username}" ${status === 'Active' ? 'activated' : 'deactivated'}`, user: req.user });
  res.json({ ok: true });
});

module.exports = { router, IMPL_KEYS };
