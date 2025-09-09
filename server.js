const express = require('express');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const cors = require('cors');
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Global WhatsApp state
let sock = null;
let isConnected = false;
let connectionStatus = 'disconnected';
let userInfo = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Helper functions
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const log = {
  info: (msg) => console.log(chalk.blue('ℹ'), chalk.white(msg)),
  success: (msg) => console.log(chalk.green('✓'), chalk.white(msg)),
  warning: (msg) => console.log(chalk.yellow('⚠'), chalk.white(msg)),
  error: (msg) => console.log(chalk.red('✗'), chalk.white(msg)),
  debug: (msg) => console.log(chalk.gray('🔍'), chalk.white(msg)),
  code: (msg) => console.log(chalk.magenta('📱'), chalk.yellow(msg))
};

// Session management
const sessionsDir = path.join(__dirname, 'sessions');

const ensureSessionsDir = () => {
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    log.info('Created sessions directory');
  }
};

const clearSession = () => {
  try {
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir);
      files.forEach(file => {
        const filePath = path.join(sessionsDir, file);
        fs.unlinkSync(filePath);
      });
      log.warning('Session files cleared');
    }
  } catch (error) {
    log.error(`Failed to clear session: ${error.message}`);
  }
};

// WhatsApp connection management
const connectToWhatsApp = async () => {
  try {
    ensureSessionsDir();
    
    log.info('Initializing WhatsApp connection...');
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionsDir);
    
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: {
        level: 'silent',
        child: () => ({ level: 'silent' })
      },
      browser: ['WhatsApp Pairing Tool', 'Chrome', '1.0.0']
    });

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        log.debug('QR Code generated - scan to connect');
      }
      
      if (connection === 'close') {
        isConnected = false;
        connectionStatus = 'disconnected';
        userInfo = null;
        
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = Object.keys(DisconnectReason).find(
          key => DisconnectReason[key] === statusCode
        ) || 'unknown';
        
        log.warning(`Connection closed: ${reason} (${statusCode})`);
        
        // Handle different disconnect reasons
        if (statusCode === DisconnectReason.badSession || 
            statusCode === DisconnectReason.loggedOut) {
          log.warning('Bad session or logged out - clearing session');
          clearSession();
          reconnectAttempts = 0;
          setTimeout(connectToWhatsApp, 3000);
        } else if (statusCode !== DisconnectReason.loggedOut && 
                   reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          log.info(`Attempting reconnection ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);
          setTimeout(connectToWhatsApp, 5000 * reconnectAttempts);
        } else {
          log.error('Max reconnection attempts reached');
          connectionStatus = 'failed';
        }
      } else if (connection === 'open') {
        isConnected = true;
        connectionStatus = 'connected';
        userInfo = sock.user;
        reconnectAttempts = 0;
        
        const userName = userInfo?.name || userInfo?.verifiedName || 'Unknown';
        const userPhone = userInfo?.id?.split('@')[0] || 'Unknown';
        
        log.success(`Connected to WhatsApp as ${userName} (${userPhone})`);
      } else if (connection === 'connecting') {
        connectionStatus = 'connecting';
        log.info('Connecting to WhatsApp...');
      }
    });

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

  } catch (error) {
    log.error(`Connection error: ${error.message}`);
    connectionStatus = 'error';
    
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      setTimeout(connectToWhatsApp, 10000);
    }
  }
};

// Pairing code generation
const generatePairingCodes = async (phoneNumber, count) => {
  if (!sock || !isConnected) {
    throw new Error('WhatsApp not connected. Please wait for connection or scan QR code.');
  }

  if (!phoneNumber || !phoneNumber.match(/^\d{10,15}$/)) {
    throw new Error('Invalid phone number. Use format: 233xxxxxxxxx (10-15 digits)');
  }

  if (count < 1 || count > 500) {
    throw new Error('Count must be between 1 and 500');
  }

  const codes = [];
  const startTime = Date.now();
  
  log.info(`Starting generation of ${count} pairing codes for ${phoneNumber}`);

  for (let i = 0; i < count; i++) {
    try {
      if (!sock || !isConnected) {
        throw new Error('Connection lost during code generation');
      }

      const code = await sock.requestPairingCode(phoneNumber);
      codes.push(code);
      
      log.code(`Code ${i + 1}/${count}: ${code} (${phoneNumber})`);
      
      // Add delay between requests (except for last one)
      if (i < count - 1) {
        await sleep(1000);
      }
    } catch (error) {
      log.error(`Failed to generate code ${i + 1}: ${error.message}`);
      
      // If it's a rate limit or connection issue, wait longer
      if (error.message.includes('rate') || error.message.includes('limit')) {
        log.warning('Rate limited - waiting 5 seconds...');
        await sleep(5000);
        i--; // Retry this iteration
        continue;
      }
      
      throw new Error(`Code generation failed at ${i + 1}/${count}: ${error.message}`);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  log.success(`Generated ${codes.length} codes in ${duration}s`);

  return codes;
};

// API Routes
app.post('/api/generate', async (req, res) => {
  try {
    const { number, count } = req.body;
    
    if (!number || !count) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: number, count'
      });
    }

    const phoneNumber = String(number).replace(/\D/g, '');
    const codeCount = parseInt(count);

    const codes = await generatePairingCodes(phoneNumber, codeCount);
    
    res.json({
      success: true,
      phone: phoneNumber,
      codes: codes,
      count: codes.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    log.error(`API Generate error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    connected: isConnected,
    status: connectionStatus,
    user: userInfo,
    reconnectAttempts: reconnectAttempts,
    maxReconnects: MAX_RECONNECT_ATTEMPTS,
    timestamp: new Date().toISOString()
  });
});

// Web UI Routes
app.get('/', (req, res) => {
  res.render('index', {
    connected: isConnected,
    status: connectionStatus,
    user: userInfo,
    error: null,
    success: null,
    codes: []
  });
});

app.post('/ui/generate', async (req, res) => {
  let { number, count, combined } = req.body;
  
  try {
    // Handle combined input (number|count)
    if (combined && combined.includes('|')) {
      const parts = combined.split('|');
      number = parts[0]?.trim();
      count = parts[1]?.trim();
    }
    
    if (!number || !count) {
      return res.render('index', {
        connected: isConnected,
        status: connectionStatus,
        user: userInfo,
        error: 'Please provide both phone number and count',
        success: null,
        codes: []
      });
    }

    const phoneNumber = String(number).replace(/\D/g, '');
    const codeCount = parseInt(count);

    const codes = await generatePairingCodes(phoneNumber, codeCount);
    
    res.render('index', {
      connected: isConnected,
      status: connectionStatus,
      user: userInfo,
      error: null,
      success: `Generated ${codes.length} pairing codes for ${phoneNumber}`,
      codes: codes
    });

  } catch (error) {
    log.error(`UI Generate error: ${error.message}`);
    res.render('index', {
      connected: isConnected,
      status: connectionStatus,
      user: userInfo,
      error: error.message,
      success: null,
      codes: []
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    whatsapp: {
      connected: isConnected,
      status: connectionStatus
    }
  });
});

// Error handling
app.use((err, req, res, next) => {
  log.error(`Server error: ${err.message}`);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error' 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Endpoint not found' 
  });
});

// Graceful shutdown
const gracefulShutdown = () => {
  log.warning('Shutting down gracefully...');
  
  if (sock) {
    try {
      sock.end();
      log.info('WhatsApp connection closed');
    } catch (error) {
      log.error(`Error closing WhatsApp connection: ${error.message}`);
    }
  }
  
  process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Unhandled errors
process.on('uncaughtException', (error) => {
  log.error(`Uncaught Exception: ${error.message}`);
  log.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

// Start server
app.listen(PORT, () => {
  log.success(`🚀 WhatsApp Pairing Tool running on port ${PORT}`);
  log.info(`📱 Web UI: http://localhost:${PORT}`);
  log.info(`🔌 API: http://localhost:${PORT}/api`);
  log.info('');
  
  // Start WhatsApp connection
  connectToWhatsApp();
});

module.exports = app;
