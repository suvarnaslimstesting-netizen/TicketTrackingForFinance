// Implementation module: every record type is described here once. The generic
// engine (engine.js) builds the tables, validation, permissions and the forms from it.
//
// Field spec: 'key|Label|type[*]|options'   (* = required)
// Types: t text, a long text, e email(s), m mobile, n number, d date, tm time (HH:MM),
//        s select, o select-or-type, x multi-select, c yes/no, r reference, f file,
//        p secret (encrypted), i IP address, u URL, z PIN code,
//        h current user (set automatically), sys (system-managed, not in forms)
// Options: 'A,B,C' fixed list | 'm:Master type' (from Masters) | 'ref:entity' for references

const STATUS = 'Not Started,In Progress,Pending,Completed,On Hold';
const GO_LIVE_STAGES = 'Kickoff,Infra ready,Master data done,Installation,Training,UAT,Go-Live,Hypercare,Handover';

// Masters seeded on first run (Admin / Implementation Manager can edit them).
const MASTER_SEED = {
  Module: 'Registration/OPD,IPD/ADT,Billing,Laboratory,Radiology,Pharmacy,OT,Store,Accounts,HR,Go-Live,Common/Setup,Academics,Student Fees,Library,Hostel',
  'Sales order source': 'Management,Marketing,Accounts,Others',
  Designation: 'IT Head,Network Admin,System Admin,Doctor,Accounts,Other',
  'Cloud provider': 'Azure,AWS,TATA,IBM,Bharat Cloud,Others',
  OS: 'Windows Server 2019,Windows Server 2022,Linux',
  'Template category': 'Master data,Consent form,Report format,Other',
  'Document type': 'Sales order copy,Purchase order copy,Quotation,Agreement,Other',
  'Hardware item': 'Workstation (PC),Printer,Label printer,Barcode scanner,Biometric device,UPS,Network switch / LAN,Tablet',
};

const STD_TASKS = {
  'Common/Setup': ['Kickoff meeting', 'Server and VPN access received', 'Software installation', 'Master data import', 'User and role creation', 'Printer and hardware setup'],
  'Registration/OPD': ['Department and doctor master', 'Consultation tariff setup', 'Appointment config', 'Registration form and card print', 'OPD billing testing', 'Staff training'],
  'IPD/ADT': ['Ward bed and room master', 'Bed tariff setup', 'Admission transfer discharge flow', 'Discharge summary template', 'Staff training'],
  Billing: ['Tariff master', 'Package setup', 'Insurance TPA panel setup', 'Discount and credit rules', 'Deposit and refund flow', 'Billing testing', 'Staff training'],
  Laboratory: ['Test master and rates', 'Sample types and containers', 'Reference ranges', 'Result report formats', 'Analyzer interface', 'Testing', 'Staff training'],
  Radiology: ['Investigation master', 'Modality setup', 'Report templates', 'PACS integration', 'Testing', 'Staff training'],
  Pharmacy: ['Item master', 'Vendor master', 'Opening stock', 'Purchase and GRN flow', 'Sales and returns', 'Testing', 'Staff training'],
  OT: ['OT and surgeon master', 'Procedure master', 'Scheduling flow', 'Consumables mapping', 'Staff training'],
  Store: ['Item categories', 'Indent and issue flow', 'Opening stock', 'Staff training'],
  Accounts: ['Chart of accounts', 'Ledger mapping', 'Voucher flow', 'Staff training'],
  HR: ['Employee master', 'Attendance setup', 'Salary structure', 'Staff training'],
  'Go-Live': ['UAT', 'Sign-off obtained', 'Go-live checklist', 'Hypercare support'],
  Academics: ['Course and batch master', 'Student admission flow', 'Staff training'],
  'Student Fees': ['Fee structure', 'Fee collection flow'],
  Library: ['Book master', 'Issue and return flow'],
  Hostel: ['Room master', 'Allotment flow'],
};

// write: permission keys allowed to add/edit/delete (any of them).
// owner: field holding the user who owns the row; users without impl.manage may only change their own rows.
// label: field used in audit messages. needsAll: hidden from users limited to their assigned clients.
const ENTITIES = {
  locations: {
    title: 'Locations', write: ['impl.manage'], label: 'name', cols: 'client,name,city,pin,radius_m',
    fields: ['client|Client|r*|ref:clients', 'name|Location / branch|t*', 'address|Address|a*', 'city|City|t*', 'pin|PIN code|z',
      'contact|Contact number|m', 'lat|Latitude|n', 'lng|Longitude|n', 'radius_m|Check-in radius (metres)|n'],
  },
  contacts: {
    title: 'IT persons', write: ['impl.manage', 'impl.infra'], label: 'name', cols: 'client,loc,name,designation,email,mobile',
    fields: ['client|Client|r*|ref:clients', 'loc|Location|r|ref:locations', 'name|Name|t*', 'designation|Designation|s*|m:Designation',
      'email|Email|e*', 'mobile|Mobile|m*'],
  },
  sorders: {
    title: 'Sales orders', write: ['salesorder.manage'], label: 'so_no', needsAll: true, cols: 'so_no,so_date,source,person,amount',
    fields: ['so_no|Sales order number|t*', 'so_date|Order date|d*', 'amount|Amount (Rs)|n*', 'source|Received from|s*|m:Sales order source',
      'person|Person name|t*', 'remarks|Remarks|t'],
  },
  solines: {
    title: 'Sales order clients and locations', write: ['salesorder.manage'], needsAll: true, cols: 'so,client,loc,beds,user_licences,modules',
    fields: ['so|Sales order|r*|ref:sorders', 'client|Client|r*|ref:clients', 'loc|Location|r*|ref:locations', 'beds|Beds|n',
      'user_licences|Users (licences)|n', 'modules|Applicable modules|x*|m:Module'],
  },
  sodocs: {
    title: 'Sales order documents', write: ['salesorder.manage'], needsAll: true, cols: 'so,doc_type,file,remarks',
    fields: ['so|Sales order|r*|ref:sorders', 'doc_type|Document type|s*|m:Document type', 'file|File|f*', 'remarks|Remarks|t'],
  },
  assign: {
    title: 'Engineer assignments', write: ['impl.manage'], cols: 'client,loc,eng,work_mode,assign_role,from_date,to_date',
    fields: ['client|Client|r*|ref:clients', 'loc|Location|r|ref:locations', 'eng|Engineer|r*|ref:users', 'work_mode|Work mode|s*|Onsite,Offsite',
      'assign_role|Role|s|Lead,Support', 'from_date|From date|d*', 'to_date|To date (blank = ongoing)|d'],
  },
  abreaks: {
    title: 'Break requests', write: ['impl.manage', 'impl.work'], owner: 'eng', label: 'reason', cols: 'client,eng,from_date,to_date,days,reason,status,decision',
    fields: ['client|Client|r*|ref:clients', 'eng|Engineer|r*|ref:users', 'from_date|Break from|d*', 'to_date|Break to|d*',
      'days|Break days|sys', 'reason|Reason|t*', 'status|Status|sys', 'decision|Approver remarks|sys', 'decided_by|Decided by|sys'],
  },
  templates: {
    title: 'Template library', write: ['impl.manage'], label: 'name', cols: 'name,category,version,file',
    fields: ['name|Template name|t*', 'category|Category|s*|m:Template category', 'version|Version|t*', 'file|File|f*'],
  },
  ctemplates: {
    title: 'Client templates', write: ['impl.manage'], cols: 'client,loc,template,enabled,sent_on,received_on,file',
    fields: ['client|Client|r*|ref:clients', 'loc|Location (blank = all)|r|ref:locations', 'template|Template|r*|ref:templates',
      'enabled|Enabled|c', 'sent_on|Sent to client|d', 'received_on|Received back|d', 'file|Filled file|f'],
  },
  cmods: {
    title: 'Client modules', write: ['impl.manage'], label: 'module', cols: 'client,loc,module,source,enabled,plan_end,status',
    fields: ['client|Client|r*|ref:clients', 'loc|Location|r*|ref:locations', 'module|Module|o*|m:Module',
      'source|Source|s*|Standard HIMS,Manual,Integrated', 'enabled|Applicable|c', 'plan_start|Planned start|d', 'plan_end|Planned end|d',
      `status|Status|s*|${STATUS}`, 'remarks|Remarks|t'],
  },
  golive: {
    title: 'Go-Live stages', write: ['impl.manage'], label: 'stage', cols: 'client,loc,stage,planned_on,actual_on,status,signoff',
    fields: ['client|Client|r*|ref:clients', 'loc|Location|r*|ref:locations', `stage|Stage|s*|${GO_LIVE_STAGES}`, 'planned_on|Planned date|d*',
      'actual_on|Actual date|d', `status|Status|s*|${STATUS}`, 'signoff|Sign-off document|f', 'remarks|Remarks|t'],
  },
  training: {
    title: 'Training log', write: ['impl.work', 'impl.manage'], owner: 'eng', label: 'topic', cols: 'train_date,client,loc,module,topic,eng,attendees,sheet',
    fields: ['client|Client|r*|ref:clients', 'loc|Location|r*|ref:locations', 'eng|Trainer|h|ref:users', 'train_date|Date|d*',
      'module|Module|o*|m:Module', 'topic|Topic|t*', 'attendees|Attendees|n*', 'hours|Duration (hours)|n', 'sheet|Attendance sheet|f', 'remarks|Remarks|t'],
  },
  issues: {
    title: 'Issues and change requests', write: ['impl.work', 'impl.manage', 'impl.infra'], label: 'title',
    cols: 'issue_type,client,loc,title,priority,status,raised_on,resolved_on',
    fields: ['client|Client|r*|ref:clients', 'loc|Location|r|ref:locations', 'module|Module|o|m:Module', 'issue_type|Type|s*|Issue,Change request,Query',
      'title|Title|t*', 'description|Description|a', 'priority|Priority|s*|Low,Medium,High,Critical', 'status|Status|s*|Open,In Progress,Resolved,Closed',
      'raised_by|Raised by|t*', 'raised_on|Raised date|d*', 'resolved_on|Resolved date|d', 'assigned_to|Assigned to|r|ref:users',
      'est_man_days|Estimated man-days (for CRs)|n'],
  },
  infra: {
    title: 'Infra requirements', write: ['impl.infra', 'impl.manage'], cols: 'client,loc,server_role,cpu,cores,ram_gb,given_on,ack_on',
    fields: ['client|Client|r*|ref:clients', 'loc|Location|r|ref:locations', 'server_role|Server role|s*|Application,Database', 'cpu|CPU model|t*',
      'cores|CPU cores|n*', 'ram_gb|RAM (GB)|n*', 'disk_gb|Storage (GB)|n*', 'os|OS|s*|m:OS', 'given_on|Given date|d*', 'informed_to|Informed to|t*',
      'ack_on|Acknowledged date|d'],
  },
  servers: {
    title: 'Servers and credentials', write: ['impl.infra', 'impl.manage'], cols: 'client,loc,hosting,app_url,cred_type,username,secret',
    fields: ['client|Client|r*|ref:clients', 'loc|Location|r|ref:locations', 'hosting|Hosting|s*|Inhouse,Cloud', 'provider|Cloud provider|s|m:Cloud provider',
      'vpn_ip|VPN IP|i', 'rdp_ip|Remote desktop IP|i', 'app_url|Application URL|u', 'db_name|Database name|t', 'cred_type|Credential type|s*|VPN,RDP,DB,App',
      'username|Username|t*', 'secret|Password|p*'],
  },
  hw: {
    title: 'Hardware checklist', write: ['impl.infra', 'impl.manage'], label: 'item', cols: 'client,loc,item,required,available,status',
    fields: ['client|Client|r*|ref:clients', 'loc|Location|r*|ref:locations', 'item|Item|o*|m:Hardware item', 'required|Required|n*',
      'available|Available|n*', 'status|Status|s*|Ready,Partial,Not Ready', 'checked_on|Checked on|d', 'remarks|Remarks|t'],
  },
  tasks: {
    title: 'Module tasks', write: ['impl.work', 'impl.manage'], label: 'task', cols: 'client,loc,module,task,target_on,status,pct,evidence,approval',
    fields: ['client|Client|r*|ref:clients', 'loc|Location|r|ref:locations', 'module|Module|o*|m:Module', 'task|Task|t*',
      'informed_on|Informed to IT date|d*', 'target_on|Target date|d*', 'done_on|Completed date|d', `status|Status|s*|${STATUS}`,
      'pct|Progress %|n*', 'evidence|Evidence|f', 'approval|Approval|sys', 'reject_reason|Rejection reason|sys'],
  },
  daily: {
    title: 'Daily status', write: ['impl.work'], owner: 'eng', label: 'task', cols: 'work_date,eng,client,module,task,pct,status,hours',
    fields: ['work_date|Date|d*', 'eng|Engineer|h|ref:users', 'client|Client|r*|ref:clients', 'loc|Location|r|ref:locations', 'module|Module|o*|m:Module',
      'task|Task|t*', 'work_done|Work done|a*', 'pct|Progress %|n*', `status|Status|s*|${STATUS}`, 'work_mode|Work mode|s*|Onsite,Offsite',
      'hours|Hours|n*', 'blockers|Blockers|t'],
  },
  visits: {
    title: 'Client visits', write: ['impl.work', 'impl.manage'], owner: 'eng', label: 'purpose', cols: 'planned_on,actual_on,client,loc,eng,purpose,report',
    fields: ['client|Client|r*|ref:clients', 'loc|Location|r|ref:locations', 'eng|Engineer|h|ref:users', 'planned_on|Planned date|d*',
      'actual_on|Actual date|d', 'purpose|Purpose|t*', 'check_in|Check-in time|tm', 'check_out|Check-out time|tm', 'report|Visit report|f',
      'signature|Client signature|f'],
  },
  comms: {
    title: 'Communication log', write: ['impl.work', 'impl.manage'], owner: 'eng', label: 'spoke_to', cols: 'comm_date,client,loc,eng,spoke_to,mode,next_on',
    fields: ['client|Client|r*|ref:clients', 'loc|Location|r|ref:locations', 'eng|Engineer|h|ref:users', 'comm_date|Date|d*', 'spoke_to|Spoke to|t*',
      'mode|Mode|s*|Call,Email,WhatsApp,Meeting', 'summary|Summary|a*', 'next_on|Next follow-up|d'],
  },
  amc: {
    title: 'AMC', write: ['amc.manage'], needsAll: true, cols: 'client,amc_type,start_on,end_on,amount,invoice_no,status',
    fields: ['client|Client|r*|ref:clients', 'amc_type|AMC type|s*|Yearly,Monthly', 'start_on|Start date|d*', 'end_on|End date|d*', 'amount|Amount (Rs)|n*',
      'invoice_no|Invoice no|t', 'status|Status|s*|Active,Expired,Renewal Pending'],
  },
  masters: {
    title: 'Masters', write: ['impl.settings', 'impl.manage'], label: 'name', cols: 'mtype,name,enabled',
    fields: [`mtype|Master type|s*|${Object.keys(MASTER_SEED).join(',')}`, 'name|Name|t*', 'enabled|Active|c'],
  },
  stdtasks: {
    title: 'Standard tasks', write: ['impl.settings', 'impl.manage'], label: 'task', cols: 'module,task,days',
    fields: ['module|Module|o*|m:Module', 'task|Standard task|t*', 'days|Target days|n*'],
  },
};

// Pairs [later, earlier]: the first date may not be before the second.
const DATE_ORDER = [['to_date', 'from_date'], ['target_on', 'informed_on'], ['end_on', 'start_on'], ['plan_end', 'plan_start'],
  ['resolved_on', 'raised_on'], ['received_on', 'sent_on']];

function parseField(spec) {
  const [key, label, rawType, opts] = spec.split('|');
  const required = rawType.endsWith('*');
  const type = required ? rawType.slice(0, -1) : rawType;
  const f = { key, label, type, required };
  if (opts && opts.startsWith('ref:')) f.ref = opts.slice(4);
  else if (opts && opts.startsWith('m:')) f.master = opts.slice(2);
  else if (opts) f.options = opts.split(',');
  return f;
}

for (const [key, e] of Object.entries(ENTITIES)) {
  e.key = key;
  e.table = `im_${key}`;
  e.fields = e.fields.map(parseField);
  e.cols = e.cols.split(',');
  e.hasClient = e.fields.some((f) => f.key === 'client');
}

module.exports = { ENTITIES, DATE_ORDER, MASTER_SEED, STD_TASKS, STATUS: STATUS.split(','), GO_LIVE_STAGES: GO_LIVE_STAGES.split(',') };
