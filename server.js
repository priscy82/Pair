const express = require("express");
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const { Boom } = require("@hapi/boom");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_DIR = "./sessions";
const MAX_COUNT = 500;
const PAIR_DELAY = 1000; // 1s between codes

let sock = null;
let socketReady = false;
let saveCreds = null;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helpers
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const log = {
  boot: (msg) => console.log(chalk.blue(`[BOOT] ${msg}`)),
  sock: (msg) => console.log(chalk.green(`[SOCK] ${msg}`)),
  code: (msg) => console.log(chalk.magenta(`[CODE] ${msg}`)),
  reset: (msg) => console.log(chalk.red(`[RESET] ${msg}`)),
  err: (msg) => console.log(chalk.red(`[ERR] ${msg}`)),
};

// Ensure directories exist
const ensureDirs = () => {
  ["sessions", "generated_codes"].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
};

// Clear session and restart
function clearSessionAndRestart() {
  socketReady = false;
  if (fs.existsSync(SESSION_DIR)) {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    log.reset("🗑️ Session cleared.");
  }
  setTimeout(startSock, 1500);
}

// Start Baileys socket
async function startSock() {
  try {
    ensureDirs();
    const { state, saveCreds: saveCredsFunc } = await useMultiFileAuthState(
      SESSION_DIR
    );
    saveCreds = saveCredsFunc;

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ["PairBot", "Chrome", "1.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        socketReady = true;
        log.sock("✅ Connected (idle, waiting for number)");
      } else if (connection === "close") {
        socketReady = false;
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        log.err(`Socket closed. Reason: ${reason}`);
        switch (reason) {
          case DisconnectReason.badSession:
          case DisconnectReason.loggedOut:
            clearSessionAndRestart();
            break;
          case DisconnectReason.connectionClosed:
          case DisconnectReason.connectionLost:
          case DisconnectReason.timedOut:
          case DisconnectReason.restartRequired:
            setTimeout(startSock, 2000);
            break;
          default:
            log.err("Unknown disconnect, restarting...");
            setTimeout(startSock, 2000);
        }
      }
    });
  } catch (err) {
    log.err(`Start sock failed: ${err.message}`);
    setTimeout(startSock, 3000);
  }
}

// Save codes to disk
async function saveCodes(phone, count, codes) {
  const runId = crypto.randomBytes(4).toString("hex");
  const file = path.join(
    "./generated_codes",
    `${phone}_${Date.now()}_${runId}.json`
  );
  fs.writeFileSync(file, JSON.stringify({ phone, count, codes }, null, 2));
  return file;
}

// Generate pairing codes
async function generateCodes(phone, count) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = await sock.requestPairingCode(phone);
    const formatted = raw.match(/.{1,4}/g)?.join("-") || raw;
    codes.push(formatted);
    log.code(`(${i + 1}/${count}) ${formatted}`);
    if (i < count - 1) await sleep(PAIR_DELAY);
  }
  return codes;
}

// UI Routes
app.get("/ui/generate", (req, res) =>
  res.render("index", { connected: socketReady, error: null, codes: null, lastFile: null })
);

app.post("/ui/generate", async (req, res) => {
  try {
    if (!socketReady) {
      return res.render("index", {
        connected: false,
        error: "Socket not ready. Try again later.",
        codes: null,
        lastFile: null,
      });
    }

    let number, count;
    if (req.body.combined) {
      const [n, c] = req.body.combined.split("|");
      number = n?.trim();
      count = parseInt(c?.trim() || "1");
    } else {
      number = req.body.number?.trim();
      count = parseInt(req.body.count || "1");
    }

    if (!number || !count) {
      return res.render("index", {
        connected: socketReady,
        error: "Missing number or count",
        codes: null,
        lastFile: null,
      });
    }

    const sanitizedCount = Math.min(MAX_COUNT, Math.max(1, count));
    const codes = await generateCodes(number, sanitizedCount);
    const filepath = await saveCodes(number, sanitizedCount, codes);

    // Reset session after spam
    clearSessionAndRestart();

    res.render("index", {
      connected: socketReady,
      error: null,
      codes,
      lastFile: filepath,
    });
  } catch (err) {
    log.err(`UI error: ${err.message}`);
    clearSessionAndRestart();
    res.render("index", {
      connected: socketReady,
      error: err.message,
      codes: null,
      lastFile: null,
    });
  }
});

app.listen(PORT, () => {
  log.boot(`🌍 Server running on port ${PORT}`);
  startSock();
});
