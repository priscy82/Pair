import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(helmet());
app.use(express.json());
app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "views"));

// Enhanced environment variables
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const PERSIST_DIR = process.env.PERSIST_DIR || "./session";
const MAX_COUNT = parseInt(process.env.MAX_COUNT) || 500;
const PAIR_DELAY = parseInt(process.env.PAIR_DELAY) || 2000; // Increased delay
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 30000; // 30 second timeout

// Ensure directories exist
fs.mkdirSync(PERSIST_DIR, { recursive: true });
fs.mkdirSync("./logs", { recursive: true });
fs.mkdirSync("./generated_codes", { recursive: true });

// Enhanced rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // Reduced from 100
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait before trying again." }
});

app.use(limiter);

// Admin middleware
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!ADMIN_API_KEY || token !== ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Enhanced global state
let sock;
let authState, saveCreds;
let ready = false;
let connecting = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 10;

// Request queue system to prevent overlapping requests
const requestQueue = [];
let processingQueue = false;

// Utility functions
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const log = (level, message, extra = {}) => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...extra
  };
  
  console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}`);
  
  // Write to log file
  try {
    const logFile = path.join("./logs", `app-${new Date().toISOString().split('T')[0]}.log`);
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
  } catch (error) {
    // Fail silently on log write errors
  }
};

// Enhanced socket initialization with proper error handling
const initializeSocket = async () => {
  if (connecting) {
    log('info', 'Socket initialization already in progress');
    return;
  }

  connecting = true;
  
  try {
    log('info', 'Initializing WhatsApp socket...');
    
    ({ state: authState, saveCreds } = await useMultiFileAuthState(PERSIST_DIR));
    
    sock = makeWASocket({
      auth: authState,
      printQRInTerminal: true,
      syncFullHistory: false,
      defaultQueryTimeoutMs: REQUEST_TIMEOUT,
      connectTimeoutMs: REQUEST_TIMEOUT,
      browser: ['WhatsApp Pairing Generator', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);
    
    sock.ev.on("connection.update", (u) => {
      const { connection, lastDisconnect, qr } = u;
      
      if (qr) {
        log('info', 'QR code received - scan with WhatsApp');
      }
      
      if (connection === "close") {
        ready = false;
        connecting = false;
        
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        
        log('warn', 'Connection closed', { 
          reason: DisconnectReason[code] || code,
          shouldReconnect,
          reconnectAttempts 
        });
        
        if (shouldReconnect && reconnectAttempts < maxReconnectAttempts) {
          scheduleReconnect();
        } else if (code === DisconnectReason.loggedOut) {
          log('error', 'Logged out from WhatsApp - clearing session');
          clearSession();
          scheduleReconnect();
        } else {
          log('error', 'Max reconnection attempts reached');
        }
      } else if (connection === "open") {
        ready = true;
        connecting = false;
        reconnectAttempts = 0;
        log('info', '✅ WhatsApp connected and ready');
      }
    });

  } catch (error) {
    log('error', 'Failed to initialize socket', { error: error.message, stack: error.stack });
    connecting = false;
    scheduleReconnect();
  }
};

const clearSession = () => {
  try {
    if (fs.existsSync(PERSIST_DIR)) {
      fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
      log('info', 'Session data cleared');
    }
  } catch (error) {
    log('error', 'Failed to clear session', { error: error.message });
  }
};

const scheduleReconnect = () => {
  if (reconnectAttempts >= maxReconnectAttempts) {
    log('error', 'Max reconnection attempts reached, stopping');
    return;
  }
  
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // Exponential backoff
  
  log('info', `Scheduling reconnect attempt ${reconnectAttempts}/${maxReconnectAttempts} in ${delay}ms`);
  
  setTimeout(() => {
    initializeSocket();
  }, delay);
};

// Enhanced pairing code generation with timeout protection
const generatePairingCode = async (phone) => {
  return new Promise(async (resolve, reject) => {
    if (!ready || !sock) {
      reject(new Error('WhatsApp socket not ready'));
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error('Request timeout'));
    }, REQUEST_TIMEOUT);

    try {
      log('info', `Requesting pairing code for ${phone}`);
      const code = await sock.requestPairingCode(phone);
      clearTimeout(timeout);
      
      // Format code with dashes for better readability
      const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
      
      log('info', `Generated pairing code for ${phone}: ${formattedCode}`);
      resolve(formattedCode);
    } catch (error) {
      clearTimeout(timeout);
      log('error', `Failed to generate pairing code for ${phone}`, { 
        error: error.message, 
        stack: error.stack 
      });
      reject(error);
    }
  });
};

// Save codes to disk
const saveCodesToDisk = async (phone, count, codes) => {
  try {
    const timestamp = new Date().toISOString();
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + 
                    new Date().toTimeString().split(' ')[0].replace(/:/g, '');
    const runId = Math.random().toString(36).substring(2, 15);
    const filename = `${phone}_${dateStr}_${runId}.json`;
    const filepath = path.join('./generated_codes', filename);
    
    const data = {
      phone,
      count,
      codes,
      timestamp,
      runId
    };
    
    // Atomic write
    const tempFilepath = filepath + '.tmp';
    fs.writeFileSync(tempFilepath, JSON.stringify(data, null, 2));
    fs.renameSync(tempFilepath, filepath);
    
    log('info', `Codes saved to ${filepath}`);
    return filepath;
    
  } catch (error) {
    log('error', `Failed to save codes: ${error.message}`);
    throw error;
  }
};

// Enhanced queue processing system
const processQueue = async () => {
  if (processingQueue || requestQueue.length === 0) {
    return;
  }

  processingQueue = true;
  log('info', `Processing queue: ${requestQueue.length} requests`);
  
  while (requestQueue.length > 0) {
    const { phone, count, resolve, reject, timestamp } = requestQueue.shift();
    
    // Check if request is too old (5 minutes)
    if (Date.now() - timestamp > 300000) {
      reject(new Error('Request expired'));
      continue;
    }
    
    try {
      if (!ready || !sock) {
        throw new Error('WhatsApp socket not ready');
      }

      const codes = [];
      
      for (let i = 0; i < count; i++) {
        try {
          const code = await generatePairingCode(phone);
          codes.push(code);
          
          // Add delay between requests to prevent being rate limited
          if (i < count - 1) {
            await sleep(PAIR_DELAY);
          }
        } catch (error) {
          log('error', `Failed to generate code ${i + 1}/${count} for ${phone}`, { error: error.message });
          codes.push(`ERROR-${i + 1}`);
        }
      }
      
      const filepath = await saveCodesToDisk(phone, count, codes);
      resolve({ codes, filepath });
      
    } catch (error) {
      log('error', `Queue processing error for ${phone}`, { error: error.message });
      reject(error);
    }
    
    // Small delay between different phone requests
    if (requestQueue.length > 0) {
      await sleep(1000);
    }
  }
  
  processingQueue = false;
  log('info', 'Queue processing completed');
};

// Add request to queue
const queuePairingRequest = (phone, count) => {
  return new Promise((resolve, reject) => {
    const request = { 
      phone, 
      count, 
      resolve, 
      reject, 
      timestamp: Date.now() 
    };
    
    requestQueue.push(request);
    log('info', `Added to queue: ${phone} (${count} codes) - Queue size: ${requestQueue.length}`);
    
    processQueue();
    
    // Add timeout for the entire request
    setTimeout(() => {
      const index = requestQueue.findIndex(req => req.timestamp === request.timestamp);
      if (index > -1) {
        requestQueue.splice(index, 1);
        reject(new Error('Request timeout - removed from queue'));
      }
    }, REQUEST_TIMEOUT * 2);
  });
};

// Routes

// Enhanced status endpoint
app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    ready,
    connecting,
    queueSize: requestQueue.length,
    processingQueue,
    reconnectAttempts,
    maxReconnectAttempts,
    timestamp: new Date().toISOString()
  });
});

// Web UI
app.get("/", (req, res) => {
  res.render("index", { 
    codes: null, 
    error: null,
    ready,
    connecting,
    queueSize: requestQueue.length,
    processingQueue
  });
});

app.post("/ui/pair", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const input = req.body.numberInput || "";
    
    if (!input.trim()) {
      return res.render("index", { 
        codes: null, 
        error: "Please enter a phone number",
        ready,
        connecting,
        queueSize: requestQueue.length,
        processingQueue
      });
    }

    const [rawPhone, rawCount] = input.split("|");
    const phone = rawPhone.replace(/\D/g, "");
    const count = Math.min(parseInt(rawCount || "1"), MAX_COUNT);

    if (!phone || phone.length < 10) {
      return res.render("index", { 
        codes: null, 
        error: "Please enter a valid phone number (minimum 10 digits)",
        ready,
        connecting,
        queueSize: requestQueue.length,
        processingQueue
      });
    }

    if (!ready) {
      return res.render("index", { 
        codes: null, 
        error: connecting ? "WhatsApp is connecting... Please wait." : "WhatsApp is not connected. Please wait for connection to be established.",
        ready,
        connecting,
        queueSize: requestQueue.length,
        processingQueue
      });
    }

    log('info', `UI request for ${phone} (${count} codes)`);
    
    const { codes, filepath } = await queuePairingRequest(phone, count);
    
    res.render("index", { 
      codes, 
      error: null,
      ready,
      connecting,
      queueSize: requestQueue.length,
      processingQueue,
      phone,
      filepath,
      generatedAt: new Date().toISOString()
    });
    
  } catch (err) {
    log('error', 'UI error', { error: err.message, stack: err.stack });
    res.render("index", { 
      codes: null, 
      error: `Failed to generate codes: ${err.message}`,
      ready,
      connecting,
      queueSize: requestQueue.length,
      processingQueue
    });
  }
});

// API endpoint
app.post("/api/pair", requireAdmin, async (req, res) => {
  try {
    const input = req.body.input || "";
    
    if (!input.trim()) {
      return res.status(400).json({ error: "Input is required" });
    }

    const [rawPhone, rawCount] = input.split("|");
    const phone = rawPhone.replace(/\D/g, "");
    const count = Math.min(parseInt(rawCount || "1"), MAX_COUNT);

    if (!phone || phone.length < 10) {
      return res.status(400).json({ error: "Invalid phone number" });
    }

    if (!ready) {
      return res.status(503).json({ error: "WhatsApp not connected" });
    }

    log('info', `API request for ${phone} (${count} codes)`);
    
    const { codes, filepath } = await queuePairingRequest(phone, count);
    
    res.json({ 
      phone, 
      codes, 
      count: codes.length,
      filepath,
      generatedAt: new Date().toISOString(),
      queueSize: requestQueue.length
    });
    
  } catch (err) {
    log('error', 'API error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: `Failed to generate codes: ${err.message}` });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('info', 'Received SIGINT, shutting down gracefully');
  if (sock) {
    sock.end();
  }
  process.exit(0);
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  log('error', 'Unhandled Rejection', { reason: reason.toString() });
});

// Start server and initialize socket
const port = process.env.PORT || 3000;
app.listen(port, () => {
  log('info', `HTTP server running on port ${port}`);
  initializeSocket();
});
