# Just the Diff mailer (Buttondown)

Local waitlist rows live in Postgres (`waitlist_emails`). Delivery and double opt-in (DOI) run through [Buttondown](https://buttondown.com) when `BUTTONDOWN_API_KEY` is set on the Railway API service.

## Free signup

1. Create a free Buttondown account for the Just the Diff newsletter.
2. Set the newsletter name / from display to **Just the Diff**.
3. Prefer sending from `digest@justthediff.com` or `hello@justthediff.com` (see DNS below).
4. In Buttondown → Settings → API, create an API key. Store it only in Railway — never commit it.
5. Leave double opt-in enabled (default). The API creates subscribers **without** setting `type`, so new addresses stay `unactivated` until they confirm.

## DNS (custom from-domain)

In your DNS host for `justthediff.com`, add the records Buttondown shows under Settings → Domains (SPF, DKIM, and any verification CNAME/TXT). Aim for:

- From: `digest@justthediff.com` (weekly digests) and/or `hello@justthediff.com` (transactional / waitlist)
- Reply-to: same inbox you monitor

Wait until Buttondown marks the domain verified before live sends.

## Railway env vars

Set on the API service (Railway project that runs `api/`):

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres (already required) |
| `BUTTONDOWN_API_KEY` | for mailer | Auth to `https://api.buttondown.com/v1` |
| `MAILER_ADMIN_TOKEN` | for `/admin/send` | Bearer token for draft/live sends |
| `BUTTONDOWN_WEBHOOK_SECRET` | optional | HMAC secret matching the webhook signing key in Buttondown |
| `CORS_ORIGINS` | optional | Comma-separated origins (defaults include justthediff.com + local preview) |

If `BUTTONDOWN_API_KEY` is missing, `POST /waitlist` still saves locally and returns `{ ok: true, mailer_unconfigured: true }`. `/health` reports `buttondown: false`.

## How DOI and unsubscribe work

1. Visitor submits the waitlist form → API inserts/ignores duplicate in `waitlist_emails` (`status` default `pending`).
2. If the API key is set, API `POST /v1/subscribers` with `email_address`, optional `ip_address`, header `X-Buttondown-Collision-Behavior: add`. Tags try `["digest-email"]`; on free-plan `feature_disabled`, retry without tags.
3. Buttondown emails a confirmation link (DOI). Subscriber stays unactivated until click.
4. Optional webhook `POST /webhooks/buttondown` on `subscriber.confirmed` / `subscriber.unsubscribed` updates local `status`, `confirm_note`, and `unsubscribed_at`. Match is by `buttondown_id` (and email if resolvable).
5. Unsubscribes: Buttondown appends a footer automatically, and `/admin/send` also appends an explicit `[Unsubscribe]({{ unsubscribe_url }})` line unless the body already includes that variable. Webhook mirrors unsubs into Postgres when configured.

### Webhook verification (simple / weak if unset)

- If `BUTTONDOWN_WEBHOOK_SECRET` is set, the handler requires `X-Buttondown-Signature: sha256=<hmac-sha256(raw body)>`.
- If the secret is **unset**, the endpoint accepts payloads without signature checks. That is weak — fine for early dogfood only. Prefer enabling a signing key in Buttondown and setting the same value as `BUTTONDOWN_WEBHOOK_SECRET`.

Point the Buttondown webhook URL at: `https://api.justthediff.com/webhooks/buttondown` (or your Railway public URL).

## Health

```bash
curl -sS https://api.justthediff.com/health
# { "ok": true, "db": true, "buttondown": true }
```

## Admin send (`POST /admin/send`)

Requires:

- Header `Authorization: Bearer $MAILER_ADMIN_TOKEN`
- Env `BUTTONDOWN_API_KEY`
- JSON body: `{ "subject", "body", "kind"?: "digest"|"flash", "dry_run"?: boolean }`

Behavior:

- `dry_run: true` → create Buttondown email with `status: "draft"` (no send).
- `dry_run: false` (or omitted) → `status: "about_to_send"` plus header `X-Buttondown-Live-Dangerously: true` (required by current Buttondown API for immediate send / first confirmation per key).
- Successful sends are logged to stdout as JSON (`event: "admin_send"`, subject, id, dry_run, kind).

### Dry-run draft (safe)

```bash
curl -sS -X POST https://api.justthediff.com/admin/send \
  -H "Authorization: Bearer $MAILER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "[Just the Diff] Pilot digest #1 (draft)",
    "body": "## What actually mattered\n\n- Example change with link.\n",
    "kind": "digest",
    "dry_run": true
  }'
```

### Live digest send

```bash
curl -sS -X POST https://api.justthediff.com/admin/send \
  -H "Authorization: Bearer $MAILER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "[Just the Diff] What actually mattered this week",
    "body": "## Digest\n\nYour markdown body here.\n",
    "kind": "digest",
    "dry_run": false
  }'
```

### Live flash send

```bash
curl -sS -X POST https://api.justthediff.com/admin/send \
  -H "Authorization: Bearer $MAILER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "[Just the Diff] Flash: vendor changed pricing",
    "body": "Short flash note with link.\n",
    "kind": "flash",
    "dry_run": false
  }'
```

Always dry-run first and open the draft in the Buttondown UI before a live send.

## What to do in the Buttondown UI

- Confirm newsletter branding and from-address.
- Verify DNS / domain.
- Create API key; paste into Railway only.
- (Optional) Create webhook for `subscriber.confirmed` and `subscriber.unsubscribed` with a signing key.
- Review drafts created via `dry_run` before flipping to live `about_to_send`.
- On free plan, tags may be disabled — the API already retries without tags.
