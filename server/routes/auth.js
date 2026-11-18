const bcrypt = require('bcryptjs');
const { q, audit, NOW } = require('../db');
const { requireAuth, loadUserById } = require('../auth');
const { PERMISSIONS } = require('../permissions');
const { str, validatePassword, asyncRouter } = require('../util');

const router = asyncRouter();

// Simple brute-force protection: 5 failed attempts locks the username for 10 minutes.
const failures = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_MS = 10 * 60 * 1000;

function publicUser(u) {
  return {
    id: u.id,
    user_code: u.user_code,
    employee_name: u.employee_name,
    employee_code: u.employee_code,
    email: u.email,
    username: u.username,
    department_name: u.department_name,
    role_name: u.role_name,
    permissions: u.permissions,
    must_change_password: !!u.must_change_password,
    face_attendance: !!u.face_attendance,
    last_login_at: u.last_login_at,
  };
}

router.post('/login', async (req, res) => {
  const username = str(req.body.username).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  const f = failures.get(username);
  if (f && f.lockedUntil > Date.now()) {
    const mins = Math.ceil((f.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute(s).` });
  }

  const row = await q.get('SELECT id, password_hash, status FROM users WHERE username = ?', username);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    const next = { count: (f && f.lockedUntil <= Date.now() ? 0 : f ? f.count : 0) + 1, lockedUntil: 0 };
    if (next.count >= MAX_ATTEMPTS) next.lockedUntil = Date.now() + LOCK_MS;
    failures.set(username, next);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  failures.delete(username);

  const user = await loadUserById(row.id);
  if (user.status !== 'Active') {
    return res.status(403).json({ error: 'Your account is inactive. Please contact the administrator.' });
  }
  if (user.role_status !== 'Active') {
    return res.status(403).json({ error: 'Your role is inactive. Please contact the administrator.' });
  }

  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = user.id;
  await q.run(`UPDATE users SET last_login_at = ${NOW} WHERE id = ?`, user.id);
  await audit({ entity: 'AUTH', entityId: user.id, action: 'LOGIN', remarks: `${user.username} signed in`, user });
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('ttf.sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), permissions: PERMISSIONS });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const row = await q.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (typeof currentPassword !== 'string' || !bcrypt.compareSync(currentPassword, row.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  const msg = validatePassword(newPassword);
  if (msg) return res.status(400).json({ error: msg });
  if (currentPassword === newPassword) return res.status(400).json({ error: 'New password must be different from the current password.' });

  await q.run(
    `UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ${NOW} WHERE id = ?`,
    bcrypt.hashSync(newPassword, 10), req.user.id
  );
  await audit({ entity: 'USER', entityId: req.user.id, action: 'PASSWORD_CHANGE', remarks: 'User changed own password', user: req.user });
  res.json({ ok: true });
});

module.exports = router;
