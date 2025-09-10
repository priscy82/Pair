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

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again later' },
});

// Utilities
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const log = {
  boot: (msg) => console.log(chalk.blue(`[BOOT] ${msg}`)),
  sock: (msg) => console.log(chalk.green(`[SOCK] ${msg}`)),
  req: (msg) => console.log(chalk.yellow(`[REQ] ${msg}`)),
  code: (msg) => console.log(chalk.magenta(`[CODE] ${msg}`)),
  reset: (msg) => console.log(chalk.red(`[RESET] ${msg}`)),
  err: (msg) => console.log(chalk.red(`[ERR] ${msg}`))
};

// Ensure directories
const ensureDirectories = () => {
  ['sessions', 'generated_codes', 'views'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
};

// Clear session and restart
const clearSessionAndRestart = () => {
  socketReady = false;
  if (fs.existsSync('./sessions')) fs.rmSync('./sessions', { recursive: true, force: true });
  log.reset('Session cleared, restarting socket...');
  setTimeout(startSock, 1200);
};

// Start WhatsApp socket
const startSock = async () => {
  try {
    ensureDirectories();
    const { state, saveCreds: saveCredsFunc } = await useMultiFileAuthState('./sessions');
    saveCreds = saveCredsFunc;

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ['WhatsApp Pairing Code Generator', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) log.sock('QR Code received - scan with WhatsApp');
      if (connection === 'open') {
        socketReady = true;
        log.sock('✅ Connected and ready');
      }
      if (connection === 'close') {
        socketReady = false;
        const reason = lastDisconnect?.error ? new Boom(lastDisconnect.error)?.output?.statusCode : null;

        switch (reason) {
          case DisconnectReason.badSession:
          case DisconnectReason.loggedOut:
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
        }
      }
    });

  } catch (error) {
    log.err(`Failed to start socket: ${error.message}`);
    setTimeout(startSock, 5000);
  }
};

// Save codes
const saveCodesToDisk = async (phone, count, codes) => {
  ensureDirectories();
  const timestamp = new Date().toISOString();
  const runId = crypto.randomBytes(6).toString('hex');
  const filename = `${phone}_${Date.now()}_${runId}.json`;
  const filepath = path.join('./generated_codes', filename);
  fs.writeFileSync(filepath, JSON.stringify({ phone, count, codes, timestamp, runId }, null, 2));

  const logPath = path.join('./generated_codes', 'log.csv');
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, 'phone,timestamp,count,file\n');
  fs.appendFileSync(logPath, `${phone},${timestamp},${count},${filename}\n`);

  return filepath;
};

// Generate codes
const generatePairingCodes = async (phone, count) => {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = await sock.requestPairingCode(phone);
    const formatted = raw.match(/.{1,4}/g)?.join('-') || raw;
    codes.push(formatted);
    log.code(`(${i + 1}/${count}) ${formatted}`);
    if (i < count - 1) await sleep(PAIR_DELAY);
  }
  return codes;
};

// Queue handling
const processPhoneQueue = async (phone) => {
  const queue = phoneQueues.get(phone);
  if (!queue || queue.processing) return;
  queue.processing = true;

  while (queue.requests.length > 0) {
    const { resolve, reject, count } = queue.requests.shift();
    try {
      if (!socketReady) throw new Error('Socket not ready');
      const codes = await generatePairingCodes(phone, count);
      const filepath = await saveCodesToDisk(phone, count, codes);
      resolve({ codes, filepath });
      clearSessionAndRestart();
    } catch (err) {
      log.err(err.message);
      reject(err);
      clearSessionAndRestart();
    }
    await sleep(1500);
  }

  queue.processing = false;
};

const queuePairingRequest = (phone, count) => {
  if (!phoneQueues.has(phone)) phoneQueues.set(phone, { requests: [], processing: false });
  const queue = phoneQueues.get(phone);
  queue.requests.push({ resolve: null, reject: null, count });
  return new Promise((resolve, reject) => {
    queue.requests[queue.requests.length - 1].resolve = resolve;
    queue.requests[queue.requests.length - 1].reject = reject;
    processPhoneQueue(phone);
  });
};

// Middleware
const requireAdminKey = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || token !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
};

// Routes
app.get('/api/status', (req, res) => {
  res.json({ socketReady, user: sock?.user || null });
});

app.post('/api/generate', apiLimiter, requireAdminKey, async (req, res) => {
  const { number, count } = req.body;
  if (!number || !count) return res.status(400).json({ error: 'Missing fields' });
  if (ALLOWED_PHONES && !ALLOWED_PHONES.includes(number)) return res.status(403).json({ error: 'Phone not allowed' });
  try {
    const { codes, filepath } = await queuePairingRequest(number, Math.min(MAX_COUNT, Math.max(1, parseInt(count))));
    res.json({ success: true, codes, file: filepath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.render('index', { codes: null, error: null, connected: socketReady, lastFile: null }));

app.post('/ui/generate', async (req, res) => {
  try {
    let { number, count, combined } = req.body;
    if (combined?.includes('|')) {
      [number, count] = combined.split('|').map(x => x.trim());
      count = parseInt(count);
    } else count = parseInt(count);

    if (!number || !count) throw new Error('Missing phone number or count');
    if (ALLOWED_PHONES && !ALLOWED_PHONES.includes(number)) throw new Error('Phone not allowed');
    if (!socketReady) throw new Error('Socket not connected');

    const { codes, filepath } = await queuePairingRequest(number, Math.min(MAX_COUNT, count));
    res.render('index', { codes, error: null, connected: socketReady, lastFile: filepath });

  } catch (err) {
    res.render('index', { codes: null, error: err.message, connected: socketReady, lastFile: null });
  }
});

// Start server
app.listen(PORT, () => {
  log.boot(`Server running on port ${PORT}`);
  startSock();
});
