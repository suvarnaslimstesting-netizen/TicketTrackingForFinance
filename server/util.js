const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// "Today" in the app's time zone (Render servers run in UTC).
function todayLocal() {
  const tz = process.env.APP_TZ || 'Asia/Kolkata';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  if (extra) err.extra = extra;
  return err;
}

const escLike = (s) => s.replace(/[\\%_]/g, (m) => '\\' + m);

function paging(query, maxSize = 200) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(query.pageSize, 10) || 10));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function validatePassword(pwd) {
  if (typeof pwd !== 'string' || pwd.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(pwd) || !/\d/.test(pwd)) return 'Password must contain at least one letter and one number.';
  if (pwd.length > 128) return 'Password is too long.';
  return null;
}

// Express 4 does not catch errors from async handlers; this router passes them to the error handler.
function asyncRouter() {
  const express = require('express');
  const router = express.Router();
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const original = router[method].bind(router);
    router[method] = (path, ...handlers) =>
      original(path, ...handlers.map((h) => (req, res, next) => {
        try {
          const out = h(req, res, next);
          if (out && typeof out.catch === 'function') out.catch(next);
        } catch (err) {
          next(err);
        }
      }));
  }
  return router;
}

module.exports = { isIsoDate, todayLocal, str, httpError, escLike, paging, validatePassword, asyncRouter };
