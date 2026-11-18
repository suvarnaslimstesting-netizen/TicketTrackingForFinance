// Every permission the portal understands. Roles are configured by the Admin
// by ticking any combination of these keys.
const PERMISSIONS = [
  { key: 'dashboard.view', label: 'View Dashboard & Summary', group: 'Dashboard' },

  { key: 'approval.view', label: 'View Approved Tickets (listing, search & filters)', group: 'Man-Day Approvals' },
  { key: 'approval.add', label: 'Add Man-Day Approval', group: 'Man-Day Approvals' },
  { key: 'approval.edit', label: 'Edit Approval Details / Add Additional Approval', group: 'Man-Day Approvals' },
  { key: 'approval.delete', label: 'Delete Approval Records', group: 'Man-Day Approvals' },
  { key: 'approval.export', label: 'Export Reports (Excel / PDF)', group: 'Man-Day Approvals' },
  { key: 'audit.view', label: 'View Audit History', group: 'Man-Day Approvals' },

  { key: 'billing.view', label: 'View Quotations, Purchase Orders & Invoices', group: 'Quotation & Billing' },
  { key: 'quotation.manage', label: 'Create, Send & Revise Quotations', group: 'Quotation & Billing' },
  { key: 'po.manage', label: 'Record & Upload Client Purchase Orders', group: 'Quotation & Billing' },
  { key: 'invoice.manage', label: 'Create Invoices, Mark Paid / Cancel', group: 'Quotation & Billing' },

  { key: 'impl.view', label: 'Open the Implementation section', group: 'Implementation' },
  { key: 'impl.view_all', label: 'See all clients (otherwise only clients the user is assigned to)', group: 'Implementation' },
  { key: 'impl.manage', label: 'Plan implementation: locations, modules, templates, assignments, go-live', group: 'Implementation' },
  { key: 'impl.work', label: 'Field work: module tasks, daily status, visits, communication, training, issues', group: 'Implementation' },
  { key: 'impl.infra', label: 'Infra, servers, hardware and IT contacts', group: 'Implementation' },
  { key: 'credential.view', label: 'Reveal server passwords (every view is logged)', group: 'Implementation' },
  { key: 'task.approve', label: 'Approve / reject completed tasks', group: 'Implementation' },
  { key: 'break.approve', label: 'Approve / reject break requests', group: 'Implementation' },
  { key: 'salesorder.manage', label: 'Sales orders and their documents', group: 'Implementation' },
  { key: 'amc.manage', label: 'AMC contracts', group: 'Implementation' },
  { key: 'impl.settings', label: 'Implementation masters, standard tasks and settings', group: 'Implementation' },
  { key: 'impl.users', label: 'Create & manage Implementation employees (Implementation login only)', group: 'Implementation' },

  { key: 'attendance.view', label: 'Team attendance, live location map, reset face enrolment', group: 'Attendance' },
  { key: 'attendance.config', label: 'Attendance Settings: switch face attendance ON / OFF per user', group: 'Attendance' },

  { key: 'department.manage', label: 'Create & Manage Departments', group: 'Administration' },
  { key: 'role.manage', label: 'Create Roles & Manage Access Permissions', group: 'Administration' },
  { key: 'user.manage', label: 'Create Users, Assign Roles & Departments, Activate / Deactivate', group: 'Administration' },
  { key: 'client.manage', label: 'Manage Client Master', group: 'Administration' },
  { key: 'company.manage', label: 'Manage Company Settings (GSTIN, bank details, rates)', group: 'Administration' },
];

const ALL_KEYS = PERMISSIONS.map((p) => p.key);

const VIEWER = ['dashboard.view', 'approval.view', 'approval.export', 'audit.view'];

// Billing defaults: Implementation prepares quotations and records POs; Finance also raises invoices.
const IMPL_BILLING = ['billing.view', 'quotation.manage', 'po.manage'];
const FINANCE_BILLING = [...IMPL_BILLING, 'invoice.manage'];

// Defaults applied when the database is first created (matches FRD section 7).
const DEFAULT_ROLES = [
  { name: 'Admin', description: 'Complete access to manage the module', permissions: ALL_KEYS, is_system: 1 },
  {
    name: 'Implementation Manager',
    description: 'Updates client-approved man-day details against tickets',
    permissions: [...VIEWER, 'approval.add', 'approval.edit', ...IMPL_BILLING],
  },
  { name: 'Finance Manager', description: 'Views approved man-days for billing and finance', permissions: [...VIEWER, ...FINANCE_BILLING] },
  { name: 'Product Manager', description: 'Reviews approved development & enhancement effort', permissions: VIEWER },
  { name: 'Support Manager', description: 'Views approved support tickets', permissions: VIEWER },
  { name: 'Department User', description: 'Read-only access to approved tickets', permissions: ['approval.view'] },
];

module.exports = { PERMISSIONS, ALL_KEYS, DEFAULT_ROLES, IMPL_BILLING, FINANCE_BILLING };
