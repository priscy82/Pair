const express = require('express');
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

// Environment variables
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'default-admin-key-change-this';
const MAX_COUNT = parseInt(process.env.MAX_COUNT) || 500;
const PAIR_DELAY = parseInt(process.env.PAIR_DELAY) || 1000;
const ALLOWED_PHONES = process.env.ALLOWED_PHONES ? process.env.ALLOWED_PHONES.split(',') : null;

// Global state
let sock = null;
let socketReady = false;
let saveCreds = null;
const phoneQueues = new Map();

// App setup
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting for API
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Utility functions
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const log = {
  boot: (msg) => console.log(chalk.blue(`[BOOT] ${msg}`)),
  sock: (msg) => console.log(chalk.green(`[SOCK] ${msg}`)),
  req: (msg) => console.log(chalk.yellow(`[REQ] ${msg}`)),
  code: (msg) => console.log(chalk.magenta(`[CODE] ${msg}`)),
  reset: (msg) => console.log(chalk.red(`[RESET] ${msg}`)),
  err: (msg) => console.log(chalk.red(`[ERR] ${msg}`))
};

// Ensure directories exist
const ensureDirectories = () => {
  const dirs = ['./sessions', './generated_codes', './views'];
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
};

// Clear session and restart
const clearSessionAndRestart = () => {
  socketReady = false;
  if (fs.existsSync('./sessions')) {
    try {
      fs.rmSync('./sessions', { recursive: true, force: true });
      log.reset('Session cleared');
    } catch (error) {
      log.err(`Failed to clear session: ${error.message}`);
    }
  }
  setTimeout(() => {
    startSock();
  }, 1200);
};

// Start WhatsApp socket (live but idle)
const startSock = async () => {
  try {
    log.sock('🚀 Starting WhatsApp socket (live, idle)...');

    ensureDirectories();

    const { state, saveCreds: saveCredsFunc } = await useMultiFileAuthState('./sessions');
    saveCreds = saveCredsFunc;

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // never show QR
      browser: ['WhatsApp Pairing Code Generator', 'Chrome', '1.0.0'],
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        socketReady = true;
        log.sock('✅ Connected and idle, waiting for phone numbers');
      }

      if (connection === 'close') {
        socketReady = false;

        if (lastDisconnect?.error) {
          const reason = new Boom(lastDisconnect.error)?.output?.statusCode;

          switch (reason) {
            case DisconnectReason.badSession:
            case DisconnectReason.loggedOut:
              log.reset('Clearing session due to disconnect');
              clearSessionAndRestart();
              break;
            case DisconnectReason.connectionClosed:
            case DisconnectReason.connectionLost:
            case DisconnectReason.timedOut:
            case DisconnectReason.restartRequired:
              log.sock('Reconnecting...');
              setTimeout(startSock, 2000);
              break;
            default:
              log.err(`Unknown disconnect reason: ${reason}`);
              setTimeout(startSock, 5000);
              break;
          }
        } else {
          log.sock('Reconnecting...');
          setTimeout(startSock, 2000);
        }
      }
    });

  } catch (error) {
    log.err(`Failed to start socket: ${error.message}`);
    setTimeout(startSock, 5000);
  }
};

// Save codes to disk
const saveCodesToDisk = async (phone, count, codes) => {
  try {
    ensureDirectories();

    const timestamp = new Date().toISOString();
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' +
                    new Date().toTimeString().split(' ')[0].replace(/:/g, '');
    const runId = crypto.randomBytes(8).toString('hex');
    const filename = `${phone}_${dateStr}_${runId}.json`;
    const filepath = path.join('./generated_codes', filename);

    const data = { phone, count, codes, timestamp, runId };

    const tempFilepath = filepath + '.tmp';
    fs.writeFileSync(tempFilepath, JSON.stringify(data, null, 2));
    fs.renameSync(tempFilepath, filepath);

    const logEntry = `${phone},${timestamp},${count},${filename}\n`;
    const logPath = path.join('./generated_codes', 'log.csv');

    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, 'phone,timestamp,count,file\n');
    }
    fs.appendFileSync(logPath, logEntry);

    log.reset(`✅ Session saved to ${filepath}`);
    return filepath;

  } catch (error) {
    log.err(`Failed to save codes: ${error.message}`);
    throw error;
  }
};

// Generate pairing codes only when requested
const generatePairingCodes = async (phone, count) => {
  const codes = [];
  log.req(`/api/generate -> ${phone} (count=${count})`);

  for (let i = 0; i < count; i++) {
    try {
      const rawCode = await sock.requestPairingCode(phone);
      const formattedCode = rawCode.match(/.{1,4}/g)?.join('-') || rawCode;
      codes.push(formattedCode);
      log.code(`${i + 1}/${count}: ${formattedCode}`);
      if (i < count - 1) await sleep(PAIR_DELAY);
    } catch (error) {
      log.err(`Failed to generate code ${i + 1}: ${error.message}`);
      codes.push('failed');
    }
  }
  return codes;
};

// Queue system per phone
const processPhoneQueue = async (phone) => {
  if (phoneQueues.get(phone)?.processing) return;

  const queue = phoneQueues.get(phone) || { requests: [], processing: false };
  queue.processing = true;
  phoneQueues.set(phone, queue);

  while (queue.requests.length > 0) {
    const { resolve, reject, count } = queue.requests.shift();

    try {
      if (!socketReady || !sock) throw new Error('Socket not ready');

      const codes = await generatePairingCodes(phone, count);
      const filepath = await saveCodesToDisk(phone, count, codes);

      resolve({ codes, filepath });

      // Clear session after generation
      setTimeout(() => {
        log.reset('⚡ Session cleared — restarting socket...');
        clearSessionAndRestart();
      }, 100);

    } catch (error) {
      reject(error);
    }

    if (queue.requests.length > 0) await sleep(2000);
  }

  queue.processing = false;
};

const queuePairingRequest = (phone, count) => {
  return new Promise((resolve, reject) => {
    if (!phoneQueues.has(phone)) phoneQueues.set(phone, { requests: [], processing: false });
    const queue = phoneQueues.get(phone);
    queue.requests.push({ resolve, reject, count });
    processPhoneQueue(phone);
  });
};

// Middleware
const requireAdminKey = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing or invalid authorization header' });
  const token = authHeader.substring(7);
  if (token !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key' });
  next();
};

// Routes
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    connected: !!sock?.user,
    user: sock?.user || null,
    socketReady,
    queueSize: Array.from(phoneQueues.values()).reduce((sum, q) => sum + q.requests.length, 0)
  });
});

app.post('/api/generate', apiLimiter, requireAdminKey, async (req, res) => {
  try {
    const { number, count } = req.body;
    if (!number || !count) return res.status(400).json({ error: 'Missing number or count' });
    if (typeof number !== 'string' || typeof count !== 'number') return res.status(400).json({ error: 'Invalid number or count type' });

    const sanitizedCount = Math.max(1, Math.min(count, MAX_COUNT));
    if (!socketReady || !sock) return res.status(503).json({ error: 'Socket not ready' });
    if (ALLOWED_PHONES && !ALLOWED_PHONES.includes(number)) return res.status(403).json({ error: 'Phone number not allowed' });

    const { codes, filepath } = await queuePairingRequest(number, sanitizedCount);
    res.json({ success: true, phone: number, codes, file: filepath, generated_at: new Date().toISOString() });

  } catch (error) {
    log.err(`API generate error: ${error.message}`);
    setTimeout(() => clearSessionAndRestart(), 100);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/reset', requireAdminKey, (req, res) => {
  log.req('/api/reset triggered');
  clearSessionAndRestart();
  res.json({ success: true, message: 'Session cleared and socket restarting' });
});

// Web UI
app.get('/', (req, res) => res.render('index', { codes: null, error: null, connected: socketReady, lastFile: null }));

app.post('/ui/generate', async (req, res) => {
  try {
    let { number, count, combined } = req.body;
    if (combined && combined.includes('|')) {
      [number, count] = combined.split('|').map(s => s.trim());
      count = parseInt(count);
    } else count = parseInt(count);

    if (!number || !count) return res.render('index', { codes: null, error: 'Missing phone number or count', connected: socketReady, lastFile: null });

    const sanitizedCount = Math.max(1, Math.min(count, MAX_COUNT));
    if (!socketReady || !sock) return res.render('index', { codes: null, error: 'WhatsApp socket not connected - please wait', connected: socketReady, lastFile: null });
    if (ALLOWED_PHONES && !ALLOWED_PHONES.includes(number)) return res.render('index', { codes: null, error: 'Phone number not allowed', connected: socketReady, lastFile: null });

    const { codes, filepath } = await queuePairingRequest(number, sanitizedCount);
    res.render('index', { codes, error: null, connected: socketReady, lastFile: filepath });

  } catch (error) {
    log.err(`UI generate error: ${error.message}`);
    res.render('index', { codes: null, error: `Error: ${error.message}`, connected: socketReady, lastFile: null });
  }
});

// Start server
const startServer = () => {
  ensureDirectories();
  app.listen(PORT, () => {
    log.boot(`Server started on port ${PORT}`);
    log.boot(`Admin key: ${ADMIN_KEY === 'default-admin-key-change-this' ? 'DEFAULT (CHANGE THIS!)' : 'SET'}`);
    log.boot(`Environment: MAX_COUNT=${MAX_COUNT}, PAIR_DELAY=${PAIR_DELAY}ms`);
    if (ALLOWED_PHONES) log.boot(`Allowed phones: ${ALLOWED_PHONES.join(', ')}`);
    startSock(); // start socket in idle mode
  });
};

// Graceful shutdown
process.on('SIGINT', () => { log.boot('Received SIGINT, shutting down'); sock?.end(); process.exit(0); });
process.on('SIGTERM', () => { log.boot('Received SIGTERM, shutting down'); sock?.end(); process.exit(0); });

// Prevent crashes
process.on('unhandledRejection', (reason, promise) => log.err(`Unhandled Rejection at: ${promise}, reason: ${reason}`));
process.on('uncaughtException', (error) => { log.err(`Uncaught Exception: ${error.message}`); log.err(error.stack); });

// Start the application
startServer();
