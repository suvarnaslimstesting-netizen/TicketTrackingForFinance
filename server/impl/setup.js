// Creates the Implementation + Attendance tables and applies one-off role updates.
const { pool, q, tx } = require('../db');
const { schemaSql, seedImpl } = require('./engine');
const attendance = require('../attendance');

const IMPL_ROLES = [
  {
    name: 'Implementation Engineer', description: 'Field engineer: tasks, daily status, visits, training, face attendance',
    permissions: ['impl.view', 'impl.work', 'attendance.self'],
  },
  {
    name: 'IT Coordinator', description: 'Infra, servers, hardware and IT contacts at client sites; face attendance',
    permissions: ['impl.view', 'impl.infra', 'credential.view', 'attendance.self'],
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
    'salesorder.manage', 'amc.manage', 'attendance.view', 'client.manage'],
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

async function setup() {
  await pool.query(schemaSql());
  await pool.query(attendance.SCHEMA);
  await seedImpl();
  await migrateRoles();
  const run = () => attendance.prune().catch((err) => console.error('Attendance cleanup failed:', err.message));
  run();
  setInterval(run, 12 * 60 * 60 * 1000).unref();
}

module.exports = { setup };
