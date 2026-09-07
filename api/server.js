"use strict";

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const buttondown = require("./buttondown");

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

const allowedOrigins = (process.env.CORS_ORIGINS || "https://justthediff.com,http://localhost:4173,http://127.0.0.1:4173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.disable("x-powered-by");

// Capture raw body for webhook HMAC verification (must run before json parser consumes it).
app.use(
  express.json({
    limit: "32kb",
    verify(req, _res, buf) {
      if (req.originalUrl === "/webhooks/buttondown" || req.url === "/webhooks/buttondown") {
        req.rawBody = buf;
      }
    },
  })
);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"));
    },
  })
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clientIp(req) {
  const xff = req.get("x-forwarded-for");
  if (xff) {
    const first = String(xff).split(",")[0].trim();
    if (first) return first.slice(0, 64);
  }
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || "";
  return String(ip).slice(0, 64) || null;
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist_emails (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT,
      user_agent TEXT
    );
  `);

  // Extend waitlist_emails for Buttondown sync / DOI status (idempotent).
  await pool.query(`ALTER TABLE waitlist_emails ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`);
  await pool.query(`ALTER TABLE waitlist_emails ADD COLUMN IF NOT EXISTS buttondown_id TEXT`);
  await pool.query(`ALTER TABLE waitlist_emails ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE waitlist_emails ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE waitlist_emails ADD COLUMN IF NOT EXISTS confirm_note TEXT`);
}

app.get("/health", async (_req, res) => {
  let dbOk = false;
  try {
    await pool.query("SELECT 1");
    dbOk = true;
  } catch (err) {
    console.error("health db failed", err);
  }
  const payload = {
    ok: dbOk,
    db: dbOk,
    buttondown: buttondown.isConfigured(),
  };
  if (!dbOk) return res.status(503).json(payload);
  return res.json(payload);
});

app.post("/waitlist", async (req, res) => {
  const raw = typeof req.body?.email === "string" ? req.body.email : "";
  const email = raw.trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email) || email.length > 320) {
    return res.status(400).json({ ok: false, error: "invalid_email" });
  }
  const source = typeof req.body?.source === "string" ? req.body.source.slice(0, 120) : "web";
  const userAgent = String(req.get("user-agent") || "").slice(0, 400);
  const ip = clientIp(req);

  try {
    const result = await pool.query(
      `INSERT INTO waitlist_emails (email, source, user_agent, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email, source, userAgent || null]
    );
    const created = result.rowCount > 0;

    const response = { ok: true, created };

    if (!buttondown.isConfigured()) {
      response.mailer_unconfigured = true;
      return res.status(created ? 201 : 200).json(response);
    }

    try {
      const sync = await buttondown.createSubscriber({ email, ipAddress: ip });
      if (sync.ok) {
        await pool.query(
          `UPDATE waitlist_emails
           SET buttondown_id = COALESCE($2, buttondown_id),
               synced_at = NOW(),
               confirm_note = COALESCE(confirm_note, 'doi_sent')
           WHERE email = $1`,
          [email, sync.id]
        );
      } else if (!sync.skipped) {
        console.error("buttondown subscriber sync failed", {
          email,
          status: sync.status,
          code: sync.code,
        });
        response.mailer_warning = sync.code || "sync_failed";
      }
    } catch (syncErr) {
      console.error("buttondown subscriber sync error", syncErr);
      response.mailer_warning = "sync_error";
    }

    return res.status(created ? 201 : 200).json(response);
  } catch (err) {
    console.error("waitlist insert failed", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/admin/send", async (req, res) => {
  const adminToken = String(process.env.MAILER_ADMIN_TOKEN || "").trim();
  const auth = String(req.get("authorization") || "");
  const expected = adminToken ? `Bearer ${adminToken}` : "";

  if (!adminToken || auth !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  if (!buttondown.isConfigured()) {
    return res.status(503).json({ ok: false, error: "mailer_unconfigured" });
  }

  const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
  const body = typeof req.body?.body === "string" ? req.body.body : "";
  const kindRaw = typeof req.body?.kind === "string" ? req.body.kind.trim().toLowerCase() : "";
  const kind = kindRaw === "flash" || kindRaw === "digest" ? kindRaw : undefined;
  const dryRun = Boolean(req.body?.dry_run);

  if (!subject || !body) {
    return res.status(400).json({ ok: false, error: "missing_subject_or_body" });
  }

  try {
    const result = await buttondown.createEmail({ subject, body, dryRun });
    if (!result.ok) {
      console.error("admin send failed", { kind, dryRun, status: result.status, code: result.code });
      return res.status(502).json({
        ok: false,
        error: "buttondown_error",
        code: result.code || null,
        status: result.status || null,
      });
    }

    console.log(
      JSON.stringify({
        event: "admin_send",
        kind: kind || null,
        dry_run: dryRun,
        subject,
        buttondown_email_id: result.id,
        status: dryRun ? "draft" : "about_to_send",
      })
    );

    return res.status(dryRun ? 200 : 201).json({
      ok: true,
      dry_run: dryRun,
      kind: kind || null,
      id: result.id,
      status: dryRun ? "draft" : "about_to_send",
    });
  } catch (err) {
    console.error("admin send error", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/**
 * Optional Buttondown webhook.
 * Verification: if BUTTONDOWN_WEBHOOK_SECRET is set, require matching
 * X-Buttondown-Signature: sha256=<hmac>. If secret unset, accept payloads
 * (weak — document in docs/MAILER.md; prefer setting the secret).
 * Payload typically has data.subscriber (id); we match waitlist_emails.buttondown_id
 * and optionally resolve email via Buttondown GET when needed.
 */
app.post("/webhooks/buttondown", async (req, res) => {
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const sig = req.get("x-buttondown-signature");
  const verified = buttondown.verifyWebhookSignature(raw, sig);

  if (verified.configured && !verified.ok) {
    return res.status(401).json({ ok: false, error: "invalid_signature" });
  }

  const eventType = typeof req.body?.event_type === "string" ? req.body.event_type : "";
  const data = req.body?.data && typeof req.body.data === "object" ? req.body.data : {};
  const subscriberId = data.subscriber ? String(data.subscriber) : null;
  let email =
    (typeof data.email_address === "string" && data.email_address.trim().toLowerCase()) ||
    (typeof data.email === "string" && data.email.trim().toLowerCase()) ||
    null;

  try {
    if (!email && subscriberId && buttondown.isConfigured()) {
      const look = await buttondown.getSubscriber(subscriberId);
      if (look.ok && look.data && look.data.email_address) {
        email = String(look.data.email_address).trim().toLowerCase();
      }
    }

    if (eventType === "subscriber.confirmed") {
      if (subscriberId || email) {
        await pool.query(
          `UPDATE waitlist_emails
           SET status = 'confirmed',
               buttondown_id = COALESCE(buttondown_id, $1),
               confirm_note = 'confirmed',
               unsubscribed_at = NULL
           WHERE ($1::text IS NOT NULL AND buttondown_id = $1)
              OR ($2::text IS NOT NULL AND email = $2)`,
          [subscriberId, email]
        );
      }
    } else if (eventType === "subscriber.unsubscribed") {
      if (subscriberId || email) {
        await pool.query(
          `UPDATE waitlist_emails
           SET status = 'unsubscribed',
               unsubscribed_at = NOW(),
               confirm_note = 'unsubscribed'
           WHERE ($1::text IS NOT NULL AND buttondown_id = $1)
              OR ($2::text IS NOT NULL AND email = $2)`,
          [subscriberId, email]
        );
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("buttondown webhook failed", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.use((err, _req, res, _next) => {
  if (err && String(err.message).includes("CORS")) {
    return res.status(403).json({ ok: false, error: "cors" });
  }
  console.error(err);
  res.status(500).json({ ok: false, error: "server_error" });
});

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log("justthediff waitlist api listening on :" + PORT));
  })
  .catch((err) => {
    console.error("schema init failed", err);
    process.exit(1);
  });
