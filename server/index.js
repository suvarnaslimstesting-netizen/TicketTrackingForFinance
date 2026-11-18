const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { setup: setupImpl } = require('./impl/setup');
const { pool, init } = require('./db');
const { requireAuth } = require('./auth');

const PORT = Number(process.env.PORT) || 4500;
const HOST = process.env.HOST || '0.0.0.0';
const PROD = process.env.NODE_ENV === 'production';

let secret = process.env.SESSION_SECRET;
if (!secret) {
  if (PROD) {
    console.error('SESSION_SECRET must be set in production.');
    process.exit(1);
  }
  secret = crypto.randomBytes(48).toString('hex');
  console.warn('SESSION_SECRET not set: using a temporary secret (everyone is signed out when the server restarts).');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render terminates HTTPS in front of the app

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  // Map tiles come from OpenStreetMap; face recognition runs on WebGL/WASM in the browser.
  res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https://*.tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; media-src 'self' blob:; frame-ancestors 'none'");
  res.set('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
  if (PROD) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// Purchase order uploads arrive as base64 inside JSON (10 MB file ≈ 13.4 MB encoded).
const jsonSmall = express.json({ limit: '1mb' });
const jsonLarge = express.json({ limit: '15mb' });
const LARGE_BODY = /^\/api\/(billing\/(tickets\/\d+\/po|po\/\d+)|impl\/e\/\w+(\/\d+)?|attendance\/(enrol|punch))$/;
app.use((req, res, next) => (LARGE_BODY.test(req.path) ? jsonLarge : jsonSmall)(req, res, next));
app.use(
  session({
    name: 'ttf.sid',
    store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true, pruneSessionInterval: 60 * 15 }),
    secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : PROD,
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);

// CSRF guard: state-changing API calls must come from the app's own fetch() calls.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'TTF') return res.status(403).json({ error: 'Invalid request origin.' });
  next();
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api', requireAuth, require('./routes/approvals'));
app.use('/api/admin', requireAuth, require('./routes/admin'));
app.use('/api/billing', requireAuth, require('./routes/billing'));
app.use('/api/impl', requireAuth, require('./impl/routes'));
app.use('/api/attendance', requireAuth, require('./attendance').router);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Browser libraries served from our own origin (the CSP blocks external scripts).
const vendor = (p) => express.static(path.join(__dirname, '..', 'node_modules', p), { maxAge: '7d', fallthrough: false });
app.use('/vendor/chart', vendor('chart.js/dist'));
app.use('/vendor/leaflet', vendor('leaflet/dist'));
app.use('/vendor/face-api', vendor('@vladmandic/face-api/dist'));
app.use('/vendor/face-models', vendor('@vladmandic/face-api/model'));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err.code === '23505') {
    const field = ((err.constraint || '').match(/_(\w+?)_key$/) || [])[1];
    return res.status(409).json({ error: `A record with the same ${field ? field.replace(/_/g, ' ') : 'value'} already exists.` });
  }
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The file is too large. The maximum size is 10 MB.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

init()
  .then(setupImpl)
  .then(() => {
    app.listen(PORT, HOST, () => console.log(`Ticket Tracking For Finance is running at http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Could not start:', err.message);
    process.exit(1);
  });
