// Creates the Implementation + Attendance tables and applies one-off role updates.
const { pool, q, tx } = require('../db');
const { schemaSql, seedImpl, ensureDefaultLocation } = require('./engine');
const attendance = require('../attendance');

const IMPL_ROLES = [
  {
    name: 'Implementation Engineer', description: 'Field engineer: tasks, daily status, visits, training, face attendance',
    permissions: ['impl.view', 'impl.work'],
  },
  {
    name: 'IT Coordinator', description: 'Infra, servers, hardware and IT contacts at client sites; face attendance',
    permissions: ['impl.view', 'impl.infra', 'credential.view'],
  },
  {
    name: 'Management', description: 'Read-only view of everything: implementation, billing, attendance',
    permissions: ['dashboard.view', 'approval.view', 'approval.export', 'audit.view', 'billing.view', 'impl.view', 'impl.view_all', 'attendance.view'],
  },
  {
    name: 'Marketing/Accounts', description: 'Sales orders, AMC and client master',
    permissions: ['impl.view', 'impl.view_all', 'salesorder.manage', 'amc.manage', 'client.manage'],
  },
];

// Added once to roles that already exist.
const GRANTS = {
  'Implementation Manager': ['impl.view', 'impl.view_all', 'impl.manage', 'impl.work', 'impl.infra', 'impl.settings', 'task.approve', 'credential.view',
    'salesorder.manage', 'amc.manage', 'attendance.view', 'attendance.config', 'client.manage'],
  'Finance Manager': ['impl.view', 'impl.view_all', 'salesorder.manage', 'amc.manage'],
};

async function migrateRoles() {
  const key = 'impl_roles_v1';
  if (await q.get('SELECT 1 AS x FROM app_meta WHERE key = ?', key)) return;
  await tx(async () => {
    for (const r of IMPL_ROLES) {
      if (!(await q.get('SELECT id FROM roles WHERE name = ?', r.name))) {
        await q.run('INSERT INTO roles (name, description, permissions) VALUES (?,?,?)', r.name, r.description, JSON.stringify(r.permissions));
      }
    }
    for (const [name, keys] of Object.entries(GRANTS)) {
      const role = await q.get('SELECT id, permissions FROM roles WHERE name = ?', name);
      if (!role) continue;
      let perms = [];
      try { perms = JSON.parse(role.permissions || '[]'); } catch { perms = []; }
      await q.run('UPDATE roles SET permissions = ? WHERE id = ?', JSON.stringify([...new Set([...perms, ...keys])]), role.id);
    }
    await q.run("INSERT INTO app_meta (key, value) VALUES (?, 'done') ON CONFLICT (key) DO NOTHING", key);
  });
}

// Face attendance became a per-user switch (set by the Implementation Manager) instead of a role permission.
async function migrateFaceFlag() {
  const key = 'face_attendance_flag_v1';
  if (await q.get('SELECT 1 AS x FROM app_meta WHERE key = ?', key)) return;
  await tx(async () => {
    const roles = await q.all('SELECT id, permissions FROM roles WHERE is_system = 0');
    for (const r of roles) {
      const perms = JSON.parse(r.permissions || '[]');
      if (perms.includes('attendance.self')) await q.run('UPDATE users SET face_attendance = 1 WHERE role_id = ?', r.id);
      const next = perms.filter((p) => p !== 'attendance.self');
      if (r.permissions.includes('attendance.view') && !next.includes('attendance.config') && (await q.get("SELECT 1 AS x FROM roles WHERE id = ? AND name = 'Implementation Manager'", r.id))) next.push('attendance.config');
      await q.run('UPDATE roles SET permissions = ? WHERE id = ?', JSON.stringify(next), r.id);
    }
    await q.run("INSERT INTO app_meta (key, value) VALUES (?, 'done') ON CONFLICT (key) DO NOTHING", key);
  });
}

// "Implementation Employee" role + employee management for the Implementation Manager.
async function migrateEmployees() {
  const key = 'impl_employee_role_v1';
  if (await q.get('SELECT 1 AS x FROM app_meta WHERE key = ?', key)) return;
  await tx(async () => {
    if (!(await q.get("SELECT id FROM roles WHERE name = 'Implementation Employee'"))) {
      await q.run('INSERT INTO roles (name, description, permissions) VALUES (?,?,?)', 'Implementation Employee',
        'Implementation staff: Implementation login only (no Ticket Tracking). Tasks, daily status, visits, training, issues.',
        JSON.stringify(['impl.view', 'impl.work']));
    }
    const im = await q.get("SELECT id, permissions FROM roles WHERE name = 'Implementation Manager'");
    if (im) {
      const p = JSON.parse(im.permissions || '[]');
      if (!p.includes('impl.users')) p.push('impl.users');
      await q.run('UPDATE roles SET permissions = ? WHERE id = ?', JSON.stringify(p), im.id);
    }
    await q.run("INSERT INTO app_meta (key, value) VALUES (?, 'done') ON CONFLICT (key) DO NOTHING", key);
  });
}

async function setup() {
  await pool.query(schemaSql());
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS face_attendance INTEGER NOT NULL DEFAULT 0; ALTER TABLE users ADD COLUMN IF NOT EXISTS app_scope TEXT NOT NULL DEFAULT 'all';");
  await pool.query(attendance.SCHEMA);
  await seedImpl();
  await migrateRoles();
  await migrateFaceFlag();
  await migrateEmployees();
  // One-off: existing clients without any location get their main location from the client master.
  if (!(await q.get("SELECT 1 AS x FROM app_meta WHERE key = 'default_locations_v1'"))) {
    for (const c of await q.all('SELECT id FROM clients')) await ensureDefaultLocation(c.id, null);
    await q.run("INSERT INTO app_meta (key, value) VALUES ('default_locations_v1', 'done') ON CONFLICT (key) DO NOTHING");
  }
  const run = () => attendance.prune().catch((err) => console.error('Attendance cleanup failed:', err.message));
  run();
  setInterval(run, 12 * 60 * 60 * 1000).unref();
}

module.exports = { setup };
