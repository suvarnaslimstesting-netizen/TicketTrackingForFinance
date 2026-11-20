# Ticket Tracking For Finance

Man-Day Approval & Ticket Management portal. Implementation Managers record client-approved man-days against tickets. Finance, Product and Implementation Managers can all see the same records straight away, with search, filters, Excel/PDF export and a full audit history.

This is a standalone application. It has its own database and its own server, and it does not share anything with other applications.

## Requirements

- Windows, macOS or Linux
- Node.js **22.13 or later** (uses the built-in `node:sqlite` database, so no database server is needed)

## Start the application

**Windows:** double-click `start.bat`.

**Command line:**

```
npm install
npm start
```

Then open **http://localhost:4500**.

Other people on the same network can open `http://<this-computer's-IP>:4500`.

## Default sign-in accounts

| Role | Username | Temporary password |
|---|---|---|
| Admin | `admin` | `Admin@123` |
| Implementation Manager | `impl.manager` | `Welcome@123` |
| Finance Manager | `finance.manager` | `Welcome@123` |
| Product Manager | `product.manager` | `Welcome@123` |

Everyone must set a new password the first time they sign in. Accounts that the Admin creates or resets also start with a temporary password.

## Modules

| Screen | Who sees it (by default) | What it does |
|---|---|---|
| Dashboard | All manager roles | Total approved tickets and man-days, plus client-wise, month-wise, department-wise and ticket-type-wise summaries |
| Man-Day Approvals | All manager roles | Shared listing with client (multi-select), ticket number, from/to date, approved date and ticket type filters. Includes Search, Reset, pagination, sorting, Excel/PDF export, and live refresh when someone submits a new approval |
| New Approval | Admin, Implementation Manager | Entry screen: Ticket Number, Client, Approved Man-Days, Approved By, Approved Date, Remarks, plus optional Ticket Type and Department. Created By and Created Date are filled in automatically |
| Audit History | All manager roles | Every create, edit, additional approval, delete and export, with the previous and updated man-days |
| Departments / Roles & Permissions / Users / Clients | Admin | Master data and access control |

## Business rules implemented

- Ticket Number, Client, Approved Man-Days, Approved By and Approved Date are mandatory.
- Every client is mapped to one or more departments. When an approval is created or edited, choosing the client fills in its departments automatically: a single department is selected for you, and if there are several, all are pre-ticked and you can untick any that do not apply. At least one must stay selected.
- Man-days must be a positive number with up to 2 decimals.
- The approved date cannot be in the future.
- **A ticket number can be entered only once (for any client).** As soon as an existing ticket number is typed, a popup shows the existing record and offers to view it or add an **Additional Approval**. That adds man-days to the existing ticket and records the change in its history.
- Editing a record requires Modification Remarks. Deleting a record requires a reason. Deleted records are hidden from the listing, but their audit history is kept.
- Permissions can be configured per role (Roles & Permissions screen). Changes take effect immediately.
- Inactive users cannot sign in. Deactivating a user ends their current session.
- The Admin role always keeps every permission, so the portal cannot be locked out.
- After 5 failed sign-in attempts, that username is locked for 10 minutes.

## Data & backup

All data is stored in `data/ticket-tracking.db`. To back up, copy the `data` folder while the application is stopped.

To start again with a fresh database, stop the app and delete `data/ticket-tracking.db*`. The default departments, roles, users and the sample ticket TKT-1025 are recreated on the next start.

## Configuration (optional environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4500` | HTTP port |
| `HOST` | `0.0.0.0` | Network interface to listen on |
| `DATA_DIR` | `./data` | Database location |
| `SESSION_SECRET` | auto-generated in `data/.session-secret` | Cookie signing secret |
| `COOKIE_SECURE` | `false` | Set to `true` when served over HTTPS |

## Project structure

```
server/
  index.js          Express app, security headers, session
  db.js             SQLite schema, seed data, audit helper
  permissions.js    Permission catalogue and default roles
  auth.js           Session + permission middleware
  export.js         Excel (exceljs) and PDF (pdfkit) reports
  routes/auth.js    Sign in/out, change password
  routes/approvals.js  Approvals, filters, exports, dashboard, audit
  routes/admin.js   Departments, roles, users, clients
public/
  index.html, css/app.css
  js/app.js         Shell, routing, sign-in
  js/core.js        API client and UI helpers
  js/views/*.js     Dashboard, approvals, admin, audit screens
```
