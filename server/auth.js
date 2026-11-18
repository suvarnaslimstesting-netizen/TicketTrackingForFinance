const { q } = require('./db');

async function loadUserById(id) {
  const u = await q.get(
    `SELECT u.id, u.user_code, u.employee_name, u.employee_code, u.email, u.mobile, u.username,
            u.department_id, d.name AS department_name, u.role_id, r.name AS role_name,
            r.permissions, r.status AS role_status, u.status, u.must_change_password, u.last_login_at, u.face_attendance
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.id = ?`,
    id
  );
  if (!u) return null;
  u.permissions = safeJson(u.permissions);
  return u;
}

function safeJson(text) {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Re-reads the user on every request so deactivation or permission changes
// take effect immediately, not at the next login.
async function requireAuth(req, res, next) {
  try {
    const id = req.session && req.session.userId;
    if (!id) return res.status(401).json({ error: 'Please sign in to continue.' });
    const user = await loadUserById(id);
    if (!user || user.status !== 'Active' || user.role_status !== 'Active') {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Your account is inactive. Please contact the administrator.' });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requirePerm(...keys) {
  return (req, res, next) => {
    if (req.user.must_change_password) {
      return res.status(403).json({ error: 'Please change your password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    if (!keys.some((k) => req.user.permissions.includes(k))) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

module.exports = { requireAuth, requirePerm, loadUserById, safeJson };
