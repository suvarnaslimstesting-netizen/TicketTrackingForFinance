const { AsyncLocalStorage } = require('async_hooks');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const { DEFAULT_ROLES, ALL_KEYS, IMPL_BILLING, FINANCE_BILLING } = require('./permissions');

// COUNT(*) and SUM() come back as strings by default; the app wants numbers.
types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8
types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Put the Supabase connection string in .env (local) or in the Render environment.');
  process.exit(1);
}

// App time zone for all "Created / Updated" timestamps (servers on Render run in UTC).
const APP_TZ = /^[A-Za-z_]+\/[A-Za-z_]+$/.test(process.env.APP_TZ || '') ? process.env.APP_TZ : 'Asia/Kolkata';
const NOW = `to_char(now() AT TIME ZONE '${APP_TZ}', 'YYYY-MM-DD HH24:MI:SS')`;

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 5,
  idleTimeoutMillis: 30000,
});
pool.on('error', (err) => console.error('Postgres pool error:', err.message));

// Inside tx() every q.* call automatically runs on the transaction's connection.
const txStore = new AsyncLocalStorage();

// Converts "?" placeholders to Postgres "$1, $2…" (none of the app's SQL contains a literal "?").
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
const clean = (params) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

async function exec(sql, params) {
  const client = txStore.getStore() || pool;
  return client.query(toPg(sql), clean(params));
}

const q = {
  all: async (sql, ...p) => (await exec(sql, p)).rows,
  get: async (sql, ...p) => (await exec(sql, p)).rows[0],
  run: async (sql, ...p) => ({ changes: (await exec(sql, p)).rowCount }),
  // INSERT into a table with an "id" column; returns the new id.
  insert: async (sql, ...p) => {
    const r = await exec(`${sql} RETURNING id`, p);
    return { lastInsertRowid: r.rows[0].id, changes: r.rowCount };
  },
};

async function tx(fn) {
  if (txStore.getStore()) return fn(); // already inside a transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await txStore.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const code = (prefix, id, width) => `${prefix}-${String(id).padStart(width, '0')}`;

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS departments (
  id          SERIAL PRIMARY KEY,
  code        TEXT UNIQUE,
  name        CITEXT NOT NULL UNIQUE,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
  created_at  TEXT NOT NULL DEFAULT ${NOW},
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS roles (
  id          SERIAL PRIMARY KEY,
  name        CITEXT NOT NULL UNIQUE,
  description TEXT,
  permissions TEXT NOT NULL DEFAULT '[]',
  is_system   INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
  created_at  TEXT NOT NULL DEFAULT ${NOW},
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id                   SERIAL PRIMARY KEY,
  user_code            TEXT UNIQUE,
  employee_name        TEXT NOT NULL,
  employee_code        CITEXT NOT NULL UNIQUE,
  email                CITEXT NOT NULL UNIQUE,
  mobile               TEXT,
  department_id        INTEGER NOT NULL REFERENCES departments(id),
  role_id              INTEGER NOT NULL REFERENCES roles(id),
  username             CITEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
  last_login_at        TEXT,
  created_at           TEXT NOT NULL DEFAULT ${NOW},
  updated_at           TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id          SERIAL PRIMARY KEY,
  name        CITEXT NOT NULL UNIQUE,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
  created_at  TEXT NOT NULL DEFAULT ${NOW},
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id                SERIAL PRIMARY KEY,
  ticket_number     CITEXT NOT NULL,
  client_id         INTEGER NOT NULL REFERENCES clients(id),
  ticket_type       TEXT,
  approved_man_days DOUBLE PRECISION NOT NULL CHECK (approved_man_days > 0),
  approved_by       TEXT NOT NULL,
  approved_date     TEXT NOT NULL,
  remarks           TEXT,
  created_by        INTEGER NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT ${NOW},
  updated_by        INTEGER REFERENCES users(id),
  updated_at        TEXT,
  is_deleted        INTEGER NOT NULL DEFAULT 0,
  deleted_by        INTEGER REFERENCES users(id),
  deleted_at        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_approvals_ticket_client ON approvals (ticket_number, client_id) WHERE is_deleted = 0;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS given_man_days DOUBLE PRECISION CHECK (given_man_days > 0);
CREATE INDEX IF NOT EXISTS ix_approvals_date ON approvals (approved_date);
CREATE INDEX IF NOT EXISTS ix_approvals_client ON approvals (client_id);

CREATE TABLE IF NOT EXISTS client_departments (
  client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  PRIMARY KEY (client_id, department_id)
);
CREATE TABLE IF NOT EXISTS approval_departments (
  approval_id   INTEGER NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  PRIMARY KEY (approval_id, department_id)
);
CREATE INDEX IF NOT EXISTS ix_approval_departments_dept ON approval_departments (department_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id            SERIAL PRIMARY KEY,
  entity        TEXT NOT NULL,
  entity_id     INTEGER,
  action        TEXT NOT NULL,
  ticket_number TEXT,
  prev_man_days DOUBLE PRECISION,
  new_man_days  DOUBLE PRECISION,
  changes       TEXT,
  remarks       TEXT,
  user_id       INTEGER,
  user_name     TEXT,
  created_at    TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_log (entity, entity_id);

/* ---------------------------- Quotation & Billing ---------------------------- */

CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS company_settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  company_name    TEXT NOT NULL DEFAULT 'Suvarna Technosoft Pvt Ltd',
  address         TEXT,
  state_code      TEXT,
  gstin           TEXT,
  pan             TEXT,
  email           TEXT,
  phone           TEXT,
  website         TEXT,
  bank_name       TEXT,
  bank_account    TEXT,
  bank_ifsc       TEXT,
  bank_branch     TEXT,
  sac_code        TEXT NOT NULL DEFAULT '998314',
  default_rate    DOUBLE PRECISION,
  gst_rate        DOUBLE PRECISION NOT NULL DEFAULT 18,
  quote_validity_days INTEGER NOT NULL DEFAULT 30,
  payment_terms_days  INTEGER NOT NULL DEFAULT 30,
  quotation_terms TEXT,
  invoice_terms   TEXT,
  updated_at      TEXT
);
INSERT INTO company_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_address TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS gstin TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS state_code TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS contact_person TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS contact_email TEXT;

CREATE TABLE IF NOT EXISTS doc_counters (
  kind TEXT NOT NULL,
  fy   TEXT NOT NULL,
  last INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, fy)
);

CREATE TABLE IF NOT EXISTS quotations (
  id            SERIAL PRIMARY KEY,
  approval_id   INTEGER NOT NULL REFERENCES approvals(id),
  quote_no      TEXT NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 0,
  quote_date    TEXT NOT NULL,
  valid_until   TEXT,
  description   TEXT,
  man_days      DOUBLE PRECISION NOT NULL CHECK (man_days > 0),
  rate          DOUBLE PRECISION NOT NULL CHECK (rate > 0),
  tax_type      TEXT NOT NULL CHECK (tax_type IN ('CGST_SGST','IGST','NONE')),
  gst_rate      DOUBLE PRECISION NOT NULL DEFAULT 18,
  subtotal      DOUBLE PRECISION NOT NULL,
  cgst          DOUBLE PRECISION NOT NULL DEFAULT 0,
  sgst          DOUBLE PRECISION NOT NULL DEFAULT 0,
  igst          DOUBLE PRECISION NOT NULL DEFAULT 0,
  total         DOUBLE PRECISION NOT NULL,
  terms         TEXT,
  status        TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Sent','Accepted','Rejected','Superseded')),
  sent_date     TEXT,
  sent_to       TEXT,
  sent_by       INTEGER REFERENCES users(id),
  status_remarks TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  updated_by    INTEGER REFERENCES users(id),
  updated_at    TEXT,
  UNIQUE (quote_no, revision)
);
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS prior_status TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_quotations_current ON quotations (approval_id) WHERE status <> 'Superseded';

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            SERIAL PRIMARY KEY,
  approval_id   INTEGER NOT NULL UNIQUE REFERENCES approvals(id),
  quotation_id  INTEGER REFERENCES quotations(id),
  po_number     TEXT NOT NULL,
  po_date       TEXT NOT NULL,
  received_date TEXT NOT NULL,
  po_amount     DOUBLE PRECISION,
  remarks       TEXT,
  file_name     TEXT NOT NULL,
  file_type     TEXT NOT NULL,
  file_size     INTEGER NOT NULL,
  file_data     BYTEA NOT NULL,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  updated_by    INTEGER REFERENCES users(id),
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id            SERIAL PRIMARY KEY,
  invoice_no    TEXT NOT NULL UNIQUE,
  approval_id   INTEGER NOT NULL REFERENCES approvals(id),
  quotation_id  INTEGER NOT NULL REFERENCES quotations(id),
  po_id         INTEGER REFERENCES purchase_orders(id),
  invoice_date  TEXT NOT NULL,
  due_date      TEXT,
  description   TEXT,
  man_days      DOUBLE PRECISION NOT NULL CHECK (man_days > 0),
  rate          DOUBLE PRECISION NOT NULL CHECK (rate > 0),
  tax_type      TEXT NOT NULL CHECK (tax_type IN ('CGST_SGST','IGST','NONE')),
  gst_rate      DOUBLE PRECISION NOT NULL DEFAULT 18,
  subtotal      DOUBLE PRECISION NOT NULL,
  cgst          DOUBLE PRECISION NOT NULL DEFAULT 0,
  sgst          DOUBLE PRECISION NOT NULL DEFAULT 0,
  igst          DOUBLE PRECISION NOT NULL DEFAULT 0,
  total         DOUBLE PRECISION NOT NULL,
  remarks       TEXT,
  status        TEXT NOT NULL DEFAULT 'Raised' CHECK (status IN ('Raised','Paid','Cancelled')),
  paid_date     TEXT,
  payment_ref   TEXT,
  status_remarks TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  updated_by    INTEGER REFERENCES users(id),
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_invoices_approval ON invoices (approval_id);
`;

async function audit({ entity, entityId, action, ticket, prev, next, changes, remarks, user }) {
  await q.run(
    `INSERT INTO audit_log (entity, entity_id, action, ticket_number, prev_man_days, new_man_days, changes, remarks, user_id, user_name)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    entity, entityId, action, ticket, prev, next,
    changes ? JSON.stringify(changes) : null, remarks,
    user ? user.id : null, user ? user.employee_name : 'System'
  );
}

// First start on an empty database: departments, roles and one administrator.
// The administrator's password is read from INITIAL_ADMIN_PASSWORD, never stored in the code.
async function seed() {
  if ((await q.get('SELECT COUNT(*) AS c FROM roles')).c > 0) return;

  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error('Empty database: set INITIAL_ADMIN_PASSWORD so the first administrator account can be created.');
  }

  await tx(async () => {
    const depts = [
      ['Implementation', 'Client implementation and onboarding team'],
      ['Finance', 'Billing, invoicing and finance team'],
      ['Product Development', 'Product engineering and enhancements'],
      ['Support', 'Client support and maintenance'],
      ['Quality Assurance', 'Testing and quality assurance'],
      ['Management', 'Management and administration'],
    ];
    const deptId = {};
    for (const [name, description] of depts) {
      const r = await q.insert('INSERT INTO departments (name, description) VALUES (?, ?)', name, description);
      await q.run('UPDATE departments SET code = ? WHERE id = ?', code('DEPT', r.lastInsertRowid, 3), r.lastInsertRowid);
      deptId[name] = r.lastInsertRowid;
    }

    const roleId = {};
    for (const role of DEFAULT_ROLES) {
      const r = await q.insert(
        'INSERT INTO roles (name, description, permissions, is_system) VALUES (?,?,?,?)',
        role.name, role.description, JSON.stringify(role.permissions), role.is_system || 0
      );
      roleId[role.name] = r.lastInsertRowid;
    }

    const username = (process.env.INITIAL_ADMIN_USERNAME || 'karthik').toLowerCase();
    const r = await q.insert(
      `INSERT INTO users (employee_name, employee_code, email, department_id, role_id, username, password_hash, must_change_password)
       VALUES (?,?,?,?,?,?,?,?)`,
      process.env.INITIAL_ADMIN_NAME || 'Karthik',
      process.env.INITIAL_ADMIN_EMP_CODE || 'EMP0001',
      process.env.INITIAL_ADMIN_EMAIL || `${username}@company.local`,
      deptId.Management, roleId.Admin, username, bcrypt.hashSync(adminPassword, 10),
      process.env.INITIAL_ADMIN_MUST_CHANGE === 'false' ? 0 : 1
    );
    await q.run('UPDATE users SET user_code = ? WHERE id = ?', code('USR', r.lastInsertRowid, 4), r.lastInsertRowid);
    await audit({ entity: 'USER', entityId: r.lastInsertRowid, action: 'CREATE', remarks: `Administrator "${username}" created during setup` });
  });
  console.log('Database initialised with default departments, roles and the administrator account.');
}

// One-off data migrations, each applied once and recorded in app_meta.
async function migrate() {
  const done = async (key) => !!(await q.get('SELECT 1 AS x FROM app_meta WHERE key = ?', key));
  const mark = (key) => q.run(`INSERT INTO app_meta (key, value) VALUES (?, ${NOW}) ON CONFLICT (key) DO NOTHING`, key);

  // The Admin role always carries every permission, including ones added in later versions.
  await q.run('UPDATE roles SET permissions = ? WHERE is_system = 1', JSON.stringify(ALL_KEYS));

  if (!(await done('billing_permissions_v1'))) {
    for (const [name, keys] of [['Implementation Manager', IMPL_BILLING], ['Finance Manager', FINANCE_BILLING]]) {
      const role = await q.get('SELECT id, permissions FROM roles WHERE name = ?', name);
      if (!role) continue;
      let perms = [];
      try { perms = JSON.parse(role.permissions || '[]'); } catch { perms = []; }
      await q.run('UPDATE roles SET permissions = ? WHERE id = ?', JSON.stringify([...new Set([...perms, ...keys])]), role.id);
    }
    await mark('billing_permissions_v1');
  }
}

// Next document number in the financial year, e.g. QTN/2026-27/0001. Safe under concurrent use.
async function nextDocNo(kind, prefix, fy) {
  const r = await q.get(
    `INSERT INTO doc_counters (kind, fy, last) VALUES (?, ?, 1)
     ON CONFLICT (kind, fy) DO UPDATE SET last = doc_counters.last + 1 RETURNING last`,
    kind, fy
  );
  return `${prefix}/${fy}/${String(r.last).padStart(4, '0')}`;
}

async function init() {
  await pool.query(SCHEMA);
  await seed();
  await migrate();
}

module.exports = { pool, q, tx, audit, code, init, NOW, nextDocNo };
