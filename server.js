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

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const PERSIST_DIR = process.env.PERSIST_DIR || "./session";
fs.mkdirSync(PERSIST_DIR, { recursive: true });

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100, // 100 requests/minute
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!ADMIN_API_KEY || token !== ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

let sock;
let authState, saveCreds;
let ready = false;

(async () => {
  ({ state: authState, saveCreds } = await useMultiFileAuthState(PERSIST_DIR));

  sock = makeWASocket({
    auth: authState,
    printQRInTerminal: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect } = u;
    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => process.exit(0), 1000); // Render will restart
      }
    } else if (connection === "open") {
      ready = true;
      console.log("✅ WhatsApp connected");
    }
  });
})();

// --- Web UI ---
app.get("/", (req, res) => {
  res.render("index", { codes: null, error: null });
});

app.post("/ui/pair", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const input = req.body.numberInput || "";
    const [rawPhone, rawCount] = input.split("|");
    const phone = rawPhone.replace(/\D/g, "");
    const count = Math.min(parseInt(rawCount || "1"), 5); // max 5 at once

    if (!phone) {
      return res.render("index", { codes: null, error: "Invalid phone input" });
    }

    const codes = [];
    for (let i = 0; i < count; i++) {
      const code = await sock.requestPairingCode(phone);
      codes.push(code);
    }
    res.render("index", { codes, error: null });
  } catch (err) {
    console.error("UI error", err);
    res.render("index", { codes: null, error: "Failed to get code" });
  }
});

// --- API endpoint ---
app.post("/api/pair", requireAdmin, async (req, res) => {
  try {
    const input = req.body.input || "";
    const [rawPhone, rawCount] = input.split("|");
    const phone = rawPhone.replace(/\D/g, "");
    const count = Math.min(parseInt(rawCount || "1"), 5);

    if (!phone) return res.status(400).json({ error: "Invalid phone" });

    const codes = [];
    for (let i = 0; i < count; i++) {
      const code = await sock.requestPairingCode(phone);
      codes.push(code);
    }
    res.json({ phone, codes });
  } catch (err) {
    console.error("API error", err);
    res.status(500).json({ error: "Failed to get code" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`HTTP server running on :${port}`));
