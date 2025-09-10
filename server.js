const express = require('express');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Global state
let sock = null;
let isConnected = false;
let connectionStatus = 'disconnected';
let userInfo = null;

// Helper function for delays
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Colored logging system with specific prefixes as requested
const log = {
  boot: (msg) => console.log(chalk.cyan('[BOOT]'), msg),
  sock: (msg, isError = false) => console.log(
    isError ? chalk.red('[SOCK]') : chalk.green('[SOCK]'), 
    msg
  ),
  req: (msg) => console.log(chalk.blue('[REQ]'), msg),
  code: (msg) => console.log(chalk.yellow('[CODE]'), msg),
  err: (msg) => console.log(chalk.red('[ERR]'), msg),
  reset: (msg) => console.log(chalk.yellow('[RESET]'), msg)
};

// Session management
const sessionsDir = path.join(__dirname, 'sessions');

const clearSessionAndRestart = () => {
  try {
    // Force delete sessions folder using rmSync as recommended
    if (fs.existsSync(sessionsDir)) {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
      log.reset('🗑️ Session cleared');
    }
  } catch (error) {
    log.err(`Failed to clear session: ${error.message}`);
  }
  
  log.reset('🔄 Restarting socket...');
  setTimeout(() => startSock(), 2000);
};

// WhatsApp socket initialization - renamed from connectToWhatsApp to startSock
const startSock = async () => {
  try {
    log.sock('Initializing WhatsApp connection...');
    
    // Ensure sessions directory exists
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionsDir);
    
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: {
        level: 'silent',
        child: () => ({ level: 'silent' })
      },
      browser: ['Pairing Code Tool', 'Chrome', '1.0.0']
    });

    // Handle connection updates
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        log.sock('QR Code generated - scan with WhatsApp');
      }
      
      if (connection === 'close') {
        isConnected = false;
        connectionStatus = 'disconnected';
        userInfo = null;
        
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = Object.keys(DisconnectReason).find(
          key => DisconnectReason[key] === statusCode
        ) || 'unknown';
        
        log.sock(`❌ Connection closed: ${reason} (${statusCode})`, true);
        
        // Handle ALL disconnect reasons - NEVER use process.exit()
        switch (statusCode) {
          case DisconnectReason.badSession:
            log.err('❌ Bad session detected - clearing and restarting');
            clearSessionAndRestart();
            break;
            
          case DisconnectReason.loggedOut:
            log.err('❌ Logged out - clearing session and restarting');
            clearSessionAndRestart();
            break;
            
          case DisconnectReason.connectionClosed:
            log.sock('❌ Connection closed - restarting socket', true);
            setTimeout(() => startSock(), 3000);
            break;
            
          case DisconnectReason.connectionLost:
            log.sock('❌ Connection lost - restarting socket', true);
            setTimeout(() => startSock(), 3000);
            break;
            
          case DisconnectReason.timedOut:
            log.sock('❌ Connection timed out - restarting socket', true);
            setTimeout(() => startSock(), 5000);
            break;
            
          case DisconnectReason.restartRequired:
            log.sock('❌ Restart required - restarting socket', true);
            setTimeout(() => startSock(), 2000);
            break;
            
          default:
            log.err(`❌ Unknown disconnect reason: ${reason} - restarting anyway`);
            setTimeout(() => startSock(), 3000);
            break;
        }
      } else if (connection === 'open') {
        isConnected = true;
        connectionStatus = 'connected';
        userInfo = sock.user;
        
        const userName = userInfo?.name || userInfo?.verifiedName || 'Unknown';
        const userPhone = userInfo?.id?.split('@')[0] || 'Unknown';
        
        log.sock(`✅ Connected and ready as ${userName} (${userPhone})`);
      } else if (connection === 'connecting') {
        connectionStatus = 'connecting';
        log.sock('🔄 Connecting to WhatsApp...');
      }
    });

    // Save credentials
    sock.ev.on('creds.update', saveCreds);

  } catch (error) {
    log.err(`Socket initialization error: ${error.message}`);
    connectionStatus = 'error';
    setTimeout(() => startSock(), 10000);
  }
};

// Generate pairing codes with automatic cleanup after EVERY run
const generatePairingCodes = async (phoneNumber, count) => {
  if (!sock || !isConnected) {
    throw new Error('WhatsApp not connected. Please wait for connection.');
  }

  // Validate phone number
  const cleanNumber = phoneNumber.replace(/\D/g, '');
  if (!cleanNumber || cleanNumber.length < 10 || cleanNumber.length > 15) {
    throw new Error('Invalid phone number. Use format: 233xxxxxxxxx (10-15 digits)');
  }

  // Validate count
  const codeCount = parseInt(count);
  if (codeCount < 1 || codeCount > 500) {
    throw new Error('Count must be between 1 and 500');
  }

  const codes = [];
  const startTime = Date.now();
  
  log.req(`🚀 Starting generation of ${codeCount} pairing codes for ${cleanNumber}`);

  try {
    for (let i = 0; i < codeCount; i++) {
      // Check connection before each request
      if (!sock || !isConnected) {
        throw new Error('Connection lost during code generation');
      }

      try {
        const code = await sock.requestPairingCode(cleanNumber);
        codes.push(code);
        
        log.code(`📱 [${i + 1}/${codeCount}] Generated: ${code} for ${cleanNumber}`);
        
        // Add required 1-second delay between requests (except for last one)
        if (i < codeCount - 1) {
          await sleep(1000);
        }
      } catch (codeError) {
        log.err(`Failed to generate code ${i + 1}: ${codeError.message}`);
        
        // Handle rate limiting
        if (codeError.message.includes('rate') || codeError.message.includes('limit')) {
          log.reset('⏳ Rate limited - waiting 5 seconds...');
          await sleep(5000);
          i--; // Retry this iteration
          continue;
        }
        
        throw new Error(`Code generation failed at ${i + 1}/${codeCount}: ${codeError.message}`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    log.sock(`✅ Generated ${codes.length} codes in ${duration}s`);
    
    return codes;

  } finally {
    // CRITICAL: Always clear session after spam run (success OR error)
    // This prevents the app from hanging and ensures fresh state
    log.reset('🧹 Cleaning up after code generation...');
    setTimeout(() => {
      clearSessionAndRestart();
    }, 1000);
  }
};

// API Routes
app.post('/api/generate', async (req, res) => {
  try {
    const { number, count } = req.body;
    
    log.req(`📥 API request: Generate ${count} codes for ${number}`);
    
    if (!number || !count) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: number, count'
      });
    }

    const codes = await generatePairingCodes(number, count);
    
    res.json({
      success: true,
      phone: number.replace(/\D/g, ''),
      codes: codes,
      count: codes.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    log.err(`API Generate error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/status', (req, res) => {
  log.req('📊 API status check');
  
  res.json({
    ok: true,
    connected: isConnected,
    status: connectionStatus,
    user: userInfo,
    timestamp: new Date().toISOString()
  });
});

// Web UI Routes
app.get('/', (req, res) => {
  log.req('🌐 Web UI accessed');
  
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
  let { number, count } = req.body;
  
  log.req(`📥 UI request: Generate ${count} codes for ${number}`);
  
  try {
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

    const codes = await generatePairingCodes(number, count);
    
    res.render('index', {
      connected: isConnected,
      status: connectionStatus,
      user: userInfo,
      error: null,
      success: `✅ Generated ${codes.length} pairing codes for ${number.replace(/\D/g, '')}`,
      codes: codes
    });

  } catch (error) {
    log.err(`UI Generate error: ${error.message}`);
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

// Error handling middleware
app.use((err, req, res, next) => {
  log.err(`Server error: ${err.message}`);
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

// Graceful shutdown handling - REMOVED process.exit()!
const gracefulShutdown = (signal) => {
  log.reset(`🛑 Received ${signal} - shutting down gracefully...`);
  
  if (sock) {
    try {
      sock.end();
      log.sock('WhatsApp connection closed');
    } catch (error) {
      log.err(`Error closing WhatsApp connection: ${error.message}`);
    }
  }
  
  // CRITICAL FIX: Don't use process.exit() - let process manager handle it
  log.boot('Shutdown complete - process manager will handle restart');
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Global error handlers - REMOVED process.exit()!
process.on('uncaughtException', (error) => {
  log.err(`Uncaught Exception: ${error.message}`);
  log.err(error.stack);
  // CRITICAL FIX: DON'T exit - just log and continue
});

process.on('unhandledRejection', (reason, promise) => {
  log.err(`Unhandled Rejection at: ${promise}`);
  log.err(`Reason: ${reason}`);
  // CRITICAL FIX: DON'T exit - just log and continue
});

// Start the server
app.listen(PORT, () => {
  log.boot(`🚀 WhatsApp Pairing Tool running on port ${PORT}`);
  log.boot(`📱 Web UI: http://localhost:${PORT}`);
  log.boot(`🔌 API: http://localhost:${PORT}/api`);
  log.boot('🎯 Designed for bug bounty pairing code testing');
  log.boot('');
  
  // Initialize WhatsApp connection
  startSock();
});

module.exports = app;
