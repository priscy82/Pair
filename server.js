// server.js
/* Hardened, production-ready server that uses @whiskeysockets/baileys
   - Handles disconnect reasons carefully
   - Retries pairing code requests with backoff
   - Clears sessions only when necessary
   - Saves generated codes to disk atomically
   - No process.exit() - runs in-process restart
*/

const express = require('express');
const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const pino = require('pino');

// Environment variables & defaults
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'default-admin-key-change-this';
const MAX_COUNT = Number(process.env.MAX_COUNT) || 500;
const PAIR_DELAY = Number(process.env.PAIR_DELAY) || 1000; // ms between codes
const ALLOWED_PHONES = process.env.ALLOWED_PHONES ? process.env.ALLOWED_PHONES.split(',').map(s => s.trim()) : null;
const SESSIONS_DIR = path.resolve(process.cwd(), './sessions');
const GENERATED_DIR = path.resolve(process.cwd(), './generated_codes');
const BAILEYS_LOG_LEVEL = process.env.BAILEYS_LOG_LEVEL || 'warn';

// Global state
let sock = null;
let socketReady = false;
let saveCredsFn = null;
const phoneQueues = new Map(); // phone -> { requests: [], processing }

// App
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiter for API
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

// Logger helpers
const log = {
  boot: msg => console.log(chalk.cyan(`[BOOT] ${msg}`)),
  sock: msg => console.log(chalk.green(`[SOCK] ${msg}`)),
  req: msg => console.log(chalk.blue(`[REQ] ${msg}`)),
  code: msg => console.log(chalk.magenta(`[CODE] ${msg}`)),
  reset: msg => console.log(chalk.yellow(`[RESET] ${msg}`)),
  err: msg => console.log(chalk.red(`[ERR] ${msg}`)),
};

// ensure dirs
function ensureDirectories() {
  [SESSIONS_DIR, GENERATED_DIR, path.join(process.cwd(), 'views')].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

// small sleep helper
const sleep = ms => new Promise(r => setTimeout(r, ms));

// clear session folder and restart socket in-process
function clearSessionAndRestart() {
  socketReady = false;
  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
      log.reset('Session cleared');
    }
  } catch (err) {
    log.err(`Failed to clear session: ${err?.message || err}`);
  }
  log.reset('🔄 Restarting socket in-process (no process.exit)');
  // small delay so logs flush
  setTimeout(() => startSock().catch(e => log.err(`startSock error: ${e?.message || e}`)), 1200);
}

/**
 * Robust startSock:
 * - fetchLatestBaileysVersion to avoid protocol mismatch
 * - pass pino logger to Baileys with warn level
 * - handle connection.update carefully
 */
async function startSock() {
  try {
    ensureDirectories();

    log.sock('🚀 Starting WhatsApp socket...');
    const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
    saveCredsFn = saveCreds;

    // Try to fetch latest WA Web version (helps avoid some protocol errors)
    let version = [2, 3000, 0];
    try {
      const { version: fetchedVersion } = await fetchLatestBaileysVersion();
      if (Array.isArray(fetchedVersion)) version = fetchedVersion;
      log.sock(`Using Baileys/Web version ${version.join('.')}`);
    } catch (err) {
      log.err(`Failed to fetch latest Baileys version, using default. Err: ${err?.message || err}`);
    }

    const baileysLogger = pino({ level: BAILEYS_LOG_LEVEL });

    // create socket
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: baileysLogger,
      version,
      browser: ['PairingServer', 'Render', '1.0'],
      // increase timeouts to reduce noise on slow networks
      defaultQueryTimeoutMs: 60_000,
      connectTimeoutMs: 60_000
    });

    sock.ev.on('creds.update', saveCredsFn);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log.sock('QR code available in logs (scan to link device)');
      }

      if (connection === 'open') {
        socketReady = true;
        log.sock('✅ Connected and ready');
      } else if (connection === 'close') {
        socketReady = false;

        // If there is an error object, log it fully for debugging
        if (lastDisconnect?.error) {
          log.err(`lastDisconnect.error: ${JSON.stringify(lastDisconnect.error, Object.getOwnPropertyNames(lastDisconnect.error))}`);
        }

        // Safely extract reason (some errors are non-standard)
        let reasonCode = null;
        try {
          reasonCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        } catch (e) {
          log.err(`Failed to extract disconnect reason: ${e?.message || e}`);
        }

        log.err(`Connection closed. Reason code: ${String(reasonCode)}`);

        // Only clear session for explicit badSession or loggedOut
        if (reasonCode === DisconnectReason.badSession || reasonCode === DisconnectReason.loggedOut) {
          log.reset(`Detected ${reasonCode === DisconnectReason.badSession ? 'badSession' : 'loggedOut'} — clearing session`);
          clearSessionAndRestart();
          return;
        }

        // For network/protocol blips, soft reconnect first (don't wipe session)
        if ([DisconnectReason.connectionClosed, DisconnectReason.connectionLost, DisconnectReason.timedOut, DisconnectReason.restartRequired].includes(reasonCode)) {
          log.sock('Soft reconnecting (no session clear)');
          setTimeout(() => startSock().catch(e => log.err(`startSock err: ${e?.message || e}`)), 1500);
          return;
        }

        // Unknown reason: try soft reconnect, and if fails repeatedly, clear session
        log.err(`Unknown disconnect reason: ${String(reasonCode)} — attempting soft reconnect`);
        setTimeout(() => startSock().catch(e => log.err(`startSock err: ${e?.message || e}`)), 2000);
      }
    });

    // catch any socket-level errors
    sock.ev.on('connection.error', (err) => {
      log.err(`Socket-level error: ${err?.message || JSON.stringify(err)}`);
    });

  } catch (err) {
    log.err(`startSock() failed: ${err?.message || err}`);
    // try restarting later
    setTimeout(() => startSock().catch(e => log.err(`startSock err: ${e?.message || e}`)), 5000);
  }
}

/**
 * Save generated codes atomically to ./generated_codes
 */
async function saveCodesToDisk(phone, count, codes) {
  ensureDirectories();
  const timestamp = new Date().toISOString();
  const dateStr = timestamp.replace(/[:.]/g, '-').replace('T', '_').split('Z')[0];
  const runId = crypto.randomBytes(8).toString('hex');
  const filename = `${phone}_${dateStr}_${runId}.json`;
  const filepath = path.join(GENERATED_DIR, filename);
  const data = { phone, count, codes, timestamp, runId };

  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filepath);

  // append master csv
  const logFile = path.join(GENERATED_DIR, 'log.csv');
  if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, 'phone,timestamp,count,file\n');
  const entry = `${phone},${timestamp},${count},${filename}\n`;
  fs.appendFileSync(logFile, entry);

  log.reset(`Saved run to ${filepath}`);
  return filepath;
}

/**
 * generatePairingCodes - real calls to sock.requestPairingCode with retries
 */
async function generatePairingCodes(phone, count) {
  const codes = [];
  log.req(`Generating ${count} codes for ${phone}`);

  for (let i = 0; i < count; i++) {
    let attempt = 0;
    const maxAttempts = 3;
    let ok = false;
    let lastError = null;

    while (!ok && attempt < maxAttempts) {
      attempt++;
      try {
        if (!sock || !socketReady) throw new Error('Socket not ready');
        const raw = await sock.requestPairingCode(phone);
        const formatted = (typeof raw === 'string') ? (raw.match(/.{1,4}/g)?.join('-') || raw) : String(raw);
        codes.push(formatted);
        log.code(`${i + 1}/${count}: ${formatted} (attempt ${attempt})`);
        ok = true;
      } catch (err) {
        lastError = err;
        log.err(`Attempt ${attempt} failed for ${phone}: ${err?.message || err}`);
        // transient network/protocol errors should backoff then retry
        if (attempt < maxAttempts) {
          const backoff = 1000 * attempt;
          log.err(`Retrying in ${backoff}ms...`);
          await sleep(backoff);
          continue;
        } else {
          // give up for this slot, record failure placeholder
          codes.push('failed');
          log.err(`Giving up on code #${i + 1} for ${phone} after ${maxAttempts} attempts`);
        }
      }
    }

    if (i < count - 1) await sleep(PAIR_DELAY);
  }

  return codes;
}

/**
 * Queue system: one worker per phone
 */
function ensurePhoneQueue(phone) {
  if (!phoneQueues.has(phone)) {
    phoneQueues.set(phone, { requests: [], processing: false });
  }
  return phoneQueues.get(phone);
}

async function processPhoneQueue(phone) {
  const queue = ensurePhoneQueue(phone);
  if (queue.processing) return;
  queue.processing = true;

  while (queue.requests.length > 0) {
    const req = queue.requests.shift(); // { count, resolve, reject }
    try {
      if (!sock || !socketReady) throw new Error('Socket not ready');

      const codes = await generatePairingCodes(phone, req.count);
      const filepath = await saveCodesToDisk(phone, req.count, codes);

      // schedule a soft session restart (clear session) shortly after successful run
      setTimeout(() => {
        log.reset('⚡ Session cleared — restarting socket (post-run)');
        clearSessionAndRestart();
      }, 200);

      req.resolve({ codes, filepath });

      // small cooldown before next queued request
      if (queue.requests.length > 0) await sleep(1500);
    } catch (err) {
      req.reject(err);
      // on error, also clear and restart to ensure fresh state
      setTimeout(() => {
        log.reset('⚠ Error during queue processing — clearing session & restarting');
        clearSessionAndRestart();
      }, 200);
    }
  }

  queue.processing = false;
}

function queuePairingRequest(phone, count) {
  const queue = ensurePhoneQueue(phone);
  return new Promise((resolve, reject) => {
    queue.requests.push({ count, resolve, reject });
    // start processing if not already
    processPhoneQueue(phone).catch(e => log.err(`processPhoneQueue err: ${e?.message || e}`));
  });
}

// Admin key middleware
function requireAdminKey(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization: Bearer <ADMIN_KEY>' });
  const token = auth.slice(7);
  if (token !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid ADMIN_KEY' });
  next();
}

// Routes

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    connected: !!sock?.user && socketReady,
    user: sock?.user || null,
    queueSize: Array.from(phoneQueues.values()).reduce((s, q) => s + q.requests.length, 0)
  });
});

app.post('/api/generate', apiLimiter, requireAdminKey, async (req, res) => {
  try {
    const { number, count } = req.body;
    if (!number || !count) return res.status(400).json({ error: 'Missing number or count' });
    if (typeof number !== 'string' || typeof count !== 'number') return res.status(400).json({ error: 'Invalid payload' });

    if (!socketReady || !sock) return res.status(503).json({ error: 'Socket not ready' });

    const sanitizedCount = Math.max(1, Math.min(count, MAX_COUNT));
    if (ALLOWED_PHONES && !ALLOWED_PHONES.includes(number)) return res.status(403).json({ error: 'Phone not allowed' });

    log.req(`/api/generate -> ${number} (count=${sanitizedCount})`);
    const { codes, filepath } = await queuePairingRequest(number, sanitizedCount);
    return res.json({ success: true, phone: number, codes, file: filepath, generated_at: new Date().toISOString() });
  } catch (err) {
    log.err(`API generate error: ${err?.message || err}`);
    // attempt restart (non-blocking)
    setTimeout(() => clearSessionAndRestart(), 200);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

app.post('/api/reset', requireAdminKey, (req, res) => {
  log.req('/api/reset called');
  clearSessionAndRestart();
  res.json({ success: true, message: 'Session cleared and restart scheduled' });
});

// EJS UI routes
app.get('/', (req, res) => {
  res.render('index', { codes: null, error: null, connected: socketReady, lastFile: null });
});

app.post('/ui/generate', async (req, res) => {
  try {
    let { combined, number, count } = req.body;

    if (combined && combined.includes('|')) {
      const [p, c] = combined.split('|').map(s => s.trim());
      number = p;
      count = parseInt(c || '1', 10);
    } else {
      count = parseInt(count || '1', 10);
    }

    if (!number || !count) return res.render('index', { codes: null, error: 'Missing number or count', connected: socketReady, lastFile: null });
    if (!socketReady || !sock) return res.render('index', { codes: null, error: 'Socket not ready, try again later', connected: socketReady, lastFile: null });

    const sanitizedCount = Math.max(1, Math.min(count, MAX_COUNT));
    if (ALLOWED_PHONES && !ALLOWED_PHONES.includes(number)) return res.render('index', { codes: null, error: 'Phone not allowed', connected: socketReady, lastFile: null });

    const { codes, filepath } = await queuePairingRequest(number, sanitizedCount);
    res.render('index', { codes, error: null, connected: socketReady, lastFile: filepath });
  } catch (err) {
    log.err(`UI generate error: ${err?.message || err}`);
    // schedule restart
    setTimeout(() => clearSessionAndRestart(), 200);
    res.render('index', { codes: null, error: `Error: ${err?.message || 'Internal'}`, connected: socketReady, lastFile: null });
  }
});

// Start server and socket
function startServer() {
  ensureDirectories();
  app.listen(PORT, () => {
    log.boot(`Server listening on :${PORT}`);
    log.boot(`Admin key: ${ADMIN_KEY === 'default-admin-key-change-this' ? 'DEFAULT (change it!)' : 'SET'}`);
    log.boot(`Config: MAX_COUNT=${MAX_COUNT}, PAIR_DELAY=${PAIR_DELAY}ms`);
    if (ALLOWED_PHONES) log.boot(`Allowed phones: ${ALLOWED_PHONES.join(',')}`);
    // start socket after server is live
    startSock().catch(e => log.err(`startSock initial error: ${e?.message || e}`));
  });
}

// graceful shutdown handlers (attempt to close socket)
process.on('SIGINT', () => {
  log.boot('SIGINT received — shutting down gracefully');
  try { sock?.end?.(); } catch (e) { /* ignore */ }
  process.exit(0);
});
process.on('SIGTERM', () => {
  log.boot('SIGTERM received — shutting down gracefully');
  try { sock?.end?.(); } catch (e) { /* ignore */ }
  process.exit(0);
});

// global handlers to prevent crash loops
process.on('unhandledRejection', (reason, p) => {
  log.err(`Unhandled Rejection: ${reason}`);
});
process.on('uncaughtException', (err) => {
  log.err(`Uncaught Exception: ${err?.message || err}`);
  log.err(err?.stack || '');
});

startServer();
