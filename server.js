const express = require('express');
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'default-admin-key-change-this';
const MAX_COUNT = parseInt(process.env.MAX_COUNT) || 500;
const PAIR_DELAY = parseInt(process.env.PAIR_DELAY) || 1000;
const ALLOWED_PHONES = process.env.ALLOWED_PHONES ? process.env.ALLOWED_PHONES.split(',') : null;

let sock = null;
let socketReady = false;
let saveCreds = null;
const phoneQueues = new Map();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again later' }
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const log = {
  boot: (msg) => console.log(chalk.blue(`[BOOT] ${msg}`)),
  sock: (msg) => console.log(chalk.green(`[SOCK] ${msg}`)),
  req: (msg) => console.log(chalk.yellow(`[REQ] ${msg}`)),
  code: (msg) => console.log(chalk.magenta(`[CODE] ${msg}`)),
  reset: (msg) => console.log(chalk.red(`[RESET] ${msg}`)),
  err: (msg) => console.log(chalk.red(`[ERR] ${msg}`))
};

const ensureDirectories = () => {
  ['sessions', 'generated_codes', 'views'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
};

const clearSessionAndRestart = () => {
  socketReady = false;
  if (fs.existsSync('./sessions')) fs.rmSync('./sessions', { recursive: true, force: true });
  log.reset('🗑️ Session cleared, restarting socket...');
  setTimeout(startSock, 1200);
};

const startSock = async () => {
  try {
    ensureDirectories();
    const { state, saveCreds: saveCredsFunc } = await useMultiFileAuthState('./sessions');
    saveCreds = saveCredsFunc;

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // ⬅️ No auto QR spam
      browser: ['CodeGen', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        socketReady = true;
        log.sock('✅ Socket connected (idle, waiting for number)');
      }
      if (connection === 'close') {
        socketReady = false;
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        log.err(`Socket closed. Reason: ${reason}`);
        if ([DisconnectReason.connectionClosed, DisconnectReason.connectionLost].includes(reason)) {
          setTimeout(startSock, 3000);
        }
      }
    });
  } catch (e) {
    log.err(`Failed to start socket: ${e.message}`);
    setTimeout(startSock, 5000);
  }
};

const saveCodesToDisk = async (phone, count, codes) => {
  const runId = crypto.randomBytes(6).toString('hex');
  const filename = `${phone}_${Date.now()}_${runId}.json`;
  const filepath = path.join('./generated_codes', filename);
  fs.writeFileSync(filepath, JSON.stringify({ phone, count, codes }, null, 2));
  return filepath;
};

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

const queuePairingRequest = (phone, count) => new Promise((resolve, reject) => {
  if (!phoneQueues.has(phone)) phoneQueues.set(phone, { requests: [], processing: false });
  const queue = phoneQueues.get(phone);
  queue.requests.push({ resolve, reject, count });
  processPhoneQueue(phone);
});

const processPhoneQueue = async (phone) => {
  const queue = phoneQueues.get(phone);
  if (queue.processing) return;
  queue.processing = true;

  while (queue.requests.length > 0) {
    const { resolve, reject, count } = queue.requests.shift();
    try {
      if (!socketReady) throw new Error('Socket not ready, try again later');
      const codes = await generatePairingCodes(phone, count);
      const filepath = await saveCodesToDisk(phone, count, codes);
      resolve({ codes, filepath });
      clearSessionAndRestart();
    } catch (err) {
      log.err(`Code gen error: ${err.message}`);
      reject(err);
      clearSessionAndRestart();
    }
    await sleep(1500);
  }
  queue.processing = false;
};

const requireAdminKey = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || token !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
};

app.get('/api/status', (req, res) => res.json({ socketReady, user: sock?.user || null }));

app.post('/api/generate', apiLimiter, requireAdminKey, async (req, res) => {
  try {
    const { number, count } = req.body;
    if (!number || !count) return res.status(400).json({ error: 'Missing fields' });
    const sanitizedCount = Math.min(MAX_COUNT, Math.max(1, parseInt(count)));
    const { codes, filepath } = await queuePairingRequest(number, sanitizedCount);
    res.json({ success: true, codes, file: filepath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/ui/generate', (req, res) => res.render('index', { connected: socketReady }));

app.listen(PORT, () => {
  log.boot(`Server running on port ${PORT}`);
  startSock();
});
