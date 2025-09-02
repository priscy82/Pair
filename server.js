// server.js
const express = require("express");
const bodyParser = require("body-parser");
const { Boom } = require("@hapi/boom");
const { makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "changeme";
const PAIR_DELAY = parseInt(process.env.PAIR_DELAY || "1000", 10); // ms

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.set("view engine", "ejs");

// --- Setup Baileys socket ---
let sock;
(async () => {
  const { state, saveCreds } = await useMultiFileAuthState("baileys_auth");
  sock = makeWASocket({ auth: state });
  sock.ev.on("creds.update", saveCreds);
  console.log("[INIT] Socket ready for pairing code requests.");
})();

// --- Middleware: API key check ---
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.body.adminKey || req.query.adminKey;
  if (key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
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

    console.log(`[REQ][UI] Phone: ${phone}, Count: ${count}`);
    const codes = [];

    for (let i = 0; i < count; i++) {
      const code = await sock.requestPairingCode(phone);
      console.log(`[CODE][UI] ${phone} -> ${code}`);
      codes.push(code);
      if (i < count - 1) await new Promise(r => setTimeout(r, PAIR_DELAY));
    }

    res.render("index", { codes, error: null });
  } catch (err) {
    console.error("[ERR][UI]", err);
    res.render("index", { codes: null, error: "Failed to get codes" });
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

    console.log(`[REQ][API] Phone: ${phone}, Count: ${count}`);
    const codes = [];

    for (let i = 0; i < count; i++) {
      const code = await sock.requestPairingCode(phone);
      console.log(`[CODE][API] ${phone} -> ${code}`);
      codes.push(code);
      if (i < count - 1) await new Promise(r => setTimeout(r, PAIR_DELAY));
    }

    res.json({ phone, codes });
  } catch (err) {
    console.error("[ERR][API]", err);
    res.status(500).json({ error: "Failed to get codes" });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`[BOOT] Server running on http://localhost:${PORT}`);
});
