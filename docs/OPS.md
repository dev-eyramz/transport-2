# Operations guide

## 1. Uptime monitoring and alerts
**External (is the whole app down?)** Point an uptime service (UptimeRobot, Better Stack, Pingdom) at
`https://YOUR-DOMAIN/healthz/deep?key=HEALTH_KEY` every 1-5 min. It returns 200 only when the database, backups, messaging queue and scheduler are all healthy, otherwise 503 with the failing checks.
**Backups dead-man's switch:** create a free check at healthchecks.io, put its URL in `BACKUP_PING_URL`; it alerts you if backups stop.
**Internal alerts (app-detected)** go to `ALERT_WEBHOOK` (Slack/Discord/Telegram-bridge URL, works even if SMS is down) and optionally `ALERT_PHONES` (comma-separated). Triggers: backup failure, 5 consecutive message-send failures, OTP SMS failure, stale backup (> 2 intervals), messages stuck > 15 min, 5+ failed messages/hour, scheduler silent > 60 s. Repeats are suppressed for `ALERT_COOLDOWN_MIN` (60). Admins also see "System health" at the top of their screen.
**Test it:** set `ALERT_WEBHOOK`, stop the SMS credentials, make 5 bookings that trigger notifications: you should receive an alert.

## 2. WhatsApp via Twilio (needs your approval steps)
1. Twilio Console > Messaging > Senders > WhatsApp: register your business sender (Meta Business verification). Set `TWILIO_FROM_WA=+233...`.
2. Create a **Content template** (category Utility) with exactly: `{{1}}: {{2}}` (variable 1 = event, 2 = message). Submit for approval; put the resulting ContentSid in `TWILIO_WA_TEMPLATE_SID`.
3. Keep `TWILIO_FROM` (SMS sender) set: failed WhatsApp sends automatically fall back to SMS.
4. Users opt in themselves in the app (My data & privacy > Get updates on WhatsApp). Only opted-in users get WhatsApp; OTPs always go by SMS.
5. Template wording and sender approval are decided by Meta/Twilio, not by this code. Test with one number first.

## 3. Legal checklist before launch (needs a lawyer; this repo cannot supply it)
- Ghana Data Protection Act, 2012 (Act 843): confirm whether you must register as a data controller with the Data Protection Commission, and fill the registration number in `public/terms.html`.
- Replace all [BRACKETS] in the terms page; settle liability wording, lawful bases, cross-border transfer wording for your SMS provider, and retention periods (`NOTIF_DAYS`, `AUDIT_DAYS`).
- Check transport licensing / insurance obligations for passengers and vehicles in your district; decide who carries liability.
- After changes, bump `TERMS_VERSION`; every passenger/driver must re-accept at next login.

## 4. Document expiry
Drivers enter an expiry date with licence/insurance/roadworthy uploads. Warnings at 30 and 7 days (driver, then managers), and on the expiry date the document becomes Expired, a licence un-verifies the driver and a vehicle document revokes the vehicle's dispatch approval until a new document is verified.

## 5. Fee-account setup and reconciliation
- Configure `FEES_EGANOW_BASE_URL`, `FEES_EGANOW_API_USERNAME`, `FEES_EGANOW_API_PASSWORD`, and `FEES_EGANOW_X_AUTH` with credentials dedicated to the fee account. Optional callback, country, language, and partner settings use the `FEES_EGANOW_*` prefix. Do not reuse the passenger-collection or driver-payout credentials.
- Production can start before payment and SMS credentials are configured. The seeded admin can sign in with the initial phone and PIN and configure Eganow and SMS in Platform admin; OTP delivery and provider-backed transactions will fail until setup is complete. Production still rejects mock payments, console messaging, and configured provider URLs that are not HTTPS. Keep `APP_SECRET` stable so saved credentials remain decryptable.
- Production refuses to start if any effective route enables cash while a fee-account credential is missing. Set `cash_enabled` to `1` only after verifying the fee account can collect MoMo. Payment mocks and console messaging are restricted to tests.
- On Render Free, the SQLite database and credentials saved through Platform admin are on an ephemeral filesystem and can be lost on restart or spin-down. For durable settings, use a persistent disk or configure provider credentials in Render's environment settings.
- Review `/reports/fees` by date and station. Match digital `rider_charge` and `driver_deduction` entries against provider settlement records; the fee ledger records the charges but does not initiate transfers to the fee account.
- For cash rides, reconcile `fee_receivables` and driver MoMo collections daily. Check pending/NeedsReview collections with the driver before retrying; successful status checks allocate oldest receivables first. Compare settled receivable amounts with `cash_settlement` ledger rows.
- Record waivers or manual settlements with a reason. When `fee_manual_needs_approval=1`, a different station manager/accountant must approve; review the associated audit entry before closing the reconciliation period.
- Investigate overdue notifications and outstanding balances before enabling `fee_block_cash`. That option prevents new cash assignments to drivers above `fee_max_outstanding_ghs`; digital dispatch remains unaffected.
