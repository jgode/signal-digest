"use strict";

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT) || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

const allowedOrigins = (process.env.CORS_ORIGINS || "https://justthediff.com,http://localhost:4173,http://127.0.0.1:4173").split(",").map((s) => s.trim()).filter(Boolean);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(cors({ origin(origin, cb) { if (!origin || allowedOrigins.includes(origin)) return cb(null, true); return cb(new Error("CORS blocked")); } }));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function ensureSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS waitlist_emails (id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), source TEXT, user_agent TEXT);`);
}

app.get("/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true }); }
  catch (err) { console.error("health failed", err); res.status(503).json({ ok: false }); }
});

app.post("/waitlist", async (req, res) => {
  const raw = typeof req.body?.email === "string" ? req.body.email : "";
  const email = raw.trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email) || email.length > 320) return res.status(400).json({ ok: false, error: "invalid_email" });
  const source = typeof req.body?.source === "string" ? req.body.source.slice(0, 120) : "web";
  const userAgent = String(req.get("user-agent") || "").slice(0, 400);
  try {
    const result = await pool.query("INSERT INTO waitlist_emails (email, source, user_agent) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id", [email, source, userAgent || null]);
    const created = result.rowCount > 0;
    return res.status(created ? 201 : 200).json({ ok: true, created });
  } catch (err) {
    console.error("waitlist insert failed", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.use((err, _req, res, _next) => {
  if (err && String(err.message).includes("CORS")) return res.status(403).json({ ok: false, error: "cors" });
  console.error(err);
  res.status(500).json({ ok: false, error: "server_error" });
});

ensureSchema().then(() => { app.listen(PORT, () => console.log("justthediff waitlist api listening on :" + PORT)); }).catch((err) => { console.error("schema init failed", err); process.exit(1); });
