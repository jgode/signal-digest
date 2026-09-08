"use strict";

const BUTTONDOWN_BASE = "https://api.buttondown.com/v1";

function isConfigured() {
  return Boolean(process.env.BUTTONDOWN_API_KEY && String(process.env.BUTTONDOWN_API_KEY).trim());
}

function authHeaders(extra = {}) {
  const key = String(process.env.BUTTONDOWN_API_KEY || "").trim();
  return {
    Authorization: `Token ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function parseJsonSafe(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function errorCode(body) {
  if (!body || typeof body !== "object") return null;
  if (typeof body.code === "string") return body.code;
  if (Array.isArray(body) && body[0] && typeof body[0].code === "string") return body[0].code;
  if (body.detail && typeof body.detail === "object" && typeof body.detail.code === "string") {
    return body.detail.code;
  }
  return null;
}

/**
 * Create (or merge) a subscriber. Leave type unset so Buttondown sends DOI (unactivated).
 * Tries tags: ['waitlist']; on feature_disabled, retries without tags (free plan).
 */
async function createSubscriber({ email, ipAddress }) {
  if (!isConfigured()) {
    return { ok: false, skipped: true, reason: "mailer_unconfigured" };
  }

  const baseBody = { email_address: email };
  if (ipAddress) baseBody.ip_address = ipAddress;

  const headers = authHeaders({
    "X-Buttondown-Collision-Behavior": "add",
  });

  async function post(body) {
    const res = await fetch(`${BUTTONDOWN_BASE}/subscribers`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data = await parseJsonSafe(res);
    return { res, data };
  }

  let { res, data } = await post({ ...baseBody, tags: ["waitlist"] });
  if (!res.ok && errorCode(data) === "feature_disabled") {
    ({ res, data } = await post(baseBody));
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      code: errorCode(data),
      data,
    };
  }

  const id = data && (data.id || data.subscriber_id) ? String(data.id || data.subscriber_id) : null;
  return { ok: true, id, data, status: res.status };
}

/**
 * Create an email. dry_run -> draft; otherwise about_to_send with live-dangerously header.
 */
async function createEmail({ subject, body, dryRun }) {
  if (!isConfigured()) {
    return { ok: false, skipped: true, reason: "mailer_unconfigured" };
  }

  const footer = [
    "",
    "---",
    "",
    "You're getting Just the Diff because you signed up at justthediff.com.",
    "",
    "[Unsubscribe]({{ unsubscribe_url }})",
  ].join("\n");
  const bodyText = String(body || "");
  const withFooter =
    bodyText.includes("{{ unsubscribe_url }}") || bodyText.includes("{{unsubscribe_url}}")
      ? bodyText
      : `${bodyText.trimEnd()}\n${footer}\n`;

  const payload = {
    subject,
    body: withFooter,
    status: dryRun ? "draft" : "about_to_send",
  };

  const headers = authHeaders();
  if (!dryRun) {
    headers["X-Buttondown-Live-Dangerously"] = "true";
  }

  const res = await fetch(`${BUTTONDOWN_BASE}/emails`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const data = await parseJsonSafe(res);

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      code: errorCode(data),
      data,
    };
  }

  const id = data && data.id ? String(data.id) : null;
  return { ok: true, id, data, status: res.status, dryRun: Boolean(dryRun) };
}

/**
 * Fetch a subscriber by id (for webhook email resolution).
 */
async function getSubscriber(idOrEmail) {
  if (!isConfigured() || !idOrEmail) {
    return { ok: false, skipped: !isConfigured(), reason: isConfigured() ? "missing_id" : "mailer_unconfigured" };
  }
  const res = await fetch(`${BUTTONDOWN_BASE}/subscribers/${encodeURIComponent(idOrEmail)}`, {
    method: "GET",
    headers: authHeaders(),
  });
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    return { ok: false, status: res.status, code: errorCode(data), data };
  }
  return { ok: true, data, status: res.status };
}

/**
 * Verify X-Buttondown-Signature: sha256=<hex> using BUTTONDOWN_WEBHOOK_SECRET.
 * Weak note: if secret is set but signature header is missing, reject.
 * Uses timing-safe compare when crypto is available.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = String(process.env.BUTTONDOWN_WEBHOOK_SECRET || "").trim();
  if (!secret) return { configured: false, ok: true };

  const crypto = require("crypto");
  const header = String(signatureHeader || "");
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedHeader = `sha256=${expected}`;

  const a = Buffer.from(expectedHeader);
  const b = Buffer.from(header);
  if (a.length !== b.length) {
    return { configured: true, ok: false };
  }
  return { configured: true, ok: crypto.timingSafeEqual(a, b) };
}

module.exports = {
  isConfigured,
  createSubscriber,
  createEmail,
  getSubscriber,
  verifyWebhookSignature,
};
