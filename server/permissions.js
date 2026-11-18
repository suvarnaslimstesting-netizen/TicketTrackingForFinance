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

  { key: 'department.manage', label: 'Create & Manage Departments', group: 'Administration' },
  { key: 'role.manage', label: 'Create Roles & Manage Access Permissions', group: 'Administration' },
  { key: 'user.manage', label: 'Create Users, Assign Roles & Departments, Activate / Deactivate', group: 'Administration' },
  { key: 'client.manage', label: 'Manage Client Master', group: 'Administration' },
];

const ALL_KEYS = PERMISSIONS.map((p) => p.key);

const VIEWER = ['dashboard.view', 'approval.view', 'approval.export', 'audit.view'];

// Defaults applied when the database is first created (matches FRD section 7).
const DEFAULT_ROLES = [
  { name: 'Admin', description: 'Complete access to manage the module', permissions: ALL_KEYS, is_system: 1 },
  {
    name: 'Implementation Manager',
    description: 'Updates client-approved man-day details against tickets',
    permissions: [...VIEWER, 'approval.add', 'approval.edit'],
  },
  { name: 'Finance Manager', description: 'Views approved man-days for billing and finance', permissions: VIEWER },
  { name: 'Product Manager', description: 'Reviews approved development & enhancement effort', permissions: VIEWER },
  { name: 'Support Manager', description: 'Views approved support tickets', permissions: VIEWER },
  { name: 'Department User', description: 'Read-only access to approved tickets', permissions: ['approval.view'] },
];

module.exports = { PERMISSIONS, ALL_KEYS, DEFAULT_ROLES };
