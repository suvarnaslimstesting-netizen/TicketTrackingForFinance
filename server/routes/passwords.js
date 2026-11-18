// /api/passwords — one screen to reset any user's password.
// Admin (user.manage) can reset everyone; the Implementation Manager (impl.users) only Implementation-only users.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { q, tx, audit, NOW } = require('../db');
const { requirePerm } = require('../auth');
const { httpError, validatePassword, asyncRouter } = require('../util');
const authRoutes = require('./auth');

const router = asyncRouter();
router.use(requirePerm('user.manage', 'impl.users'));

const all = (u) => u.permissions.includes('user.manage');

// Readable temporary password that passes the password rules, e.g. "Tmp@k7Pq3x".
function tempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(6)) s += chars[b % chars.length];
  return `Tmp@${s}${crypto.randomInt(2, 10)}`;
}

router.get('/', async (req, res) => {
  const rows = await q.all(
    `SELECT u.id, u.employee_name, u.employee_code, u.username, u.email, u.status, u.must_change_password, u.last_login_at, u.app_scope,
            r.name AS role_name, d.name AS department_name
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN departments d ON d.id = u.department_id
      ${all(req.user) ? '' : "WHERE u.app_scope = 'impl'"}
      ORDER BY u.status, u.employee_name`);
  res.json(rows.map((r) => ({ ...r, locked: authRoutes.isLocked(r.username), self: r.id === req.user.id })));
});

async function resetOne(id, given, user) {
  const u = Number.isInteger(id) && (await q.get('SELECT id, username, employee_name, app_scope FROM users WHERE id = ?', id));
  if (!u || (!all(user) && u.app_scope !== 'impl')) throw httpError(404, 'User not found.');
  if (u.id === user.id) throw httpError(400, 'Use “Change password” in your profile menu to change your own password.');
  const password = given || tempPassword();
  const msg = validatePassword(password);
  if (msg) throw httpError(400, msg);
  await q.run(`UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ${NOW} WHERE id = ?`, bcrypt.hashSync(password, 10), u.id);
  // End their current sessions and clear any sign-in lockout.
  await q.run(`DELETE FROM user_sessions WHERE sess->>'userId' = ?`, String(u.id));
  authRoutes.unlock(u.username);
  await audit({ entity: 'USER', entityId: u.id, action: 'PASSWORD_RESET', remarks: `Password reset for "${u.username}" (must change at next sign-in)`, user });
  return { id: u.id, username: u.username, name: u.employee_name, password };
}

router.post('/:id/reset', async (req, res) => {
  const given = typeof req.body.password === 'string' ? req.body.password.trim() : '';
  const r = await tx(() => resetOne(+req.params.id, given, req.user));
  res.json(r);
});

// Reset several users at once; each gets their own temporary password.
router.post('/bulk', async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => parseInt(x, 10)).filter(Number.isInteger))];
  if (!ids.length) throw httpError(400, 'Select at least one user.');
  if (ids.length > 200) throw httpError(400, 'Select at most 200 users at a time.');
  const results = await tx(async () => {
    const out = [];
    for (const id of ids) out.push(await resetOne(id, '', req.user));
    return out;
  });
  res.json(results);
});

module.exports = router;
