# Community Transport Reservation & Dispatch (Node + Express + SQLite)
Run: configure `APP_SECRET`, `SEED_ADMIN_PHONE`, and `SEED_ADMIN_PIN` in the environment, then `npm install && npm start` → http://localhost:3000 · Test: `npm test`
No demo accounts are created for fresh databases. Existing databases retain their data, so review and rotate any legacy demo users manually. On a fresh database, set `SEED_ADMIN_PHONE` and a unique `SEED_ADMIN_PIN` (6+ characters) to provision the initial admin. Set `APP_SECRET` to a unique random value of at least 32 characters in every environment; the app does not use a built-in secret fallback. Create station-scoped managers through the admin workflow.
Env: PORT, DB, CUTOFF_MIN(30), TRIP_MIN(60), SURGE_SEATS(4), SURGE_WAIT(30), JOB_MS(10000).
Implements v1.1 policies: manager-controlled driver availability, mandatory weekly recurring confirmation (idempotent), automatic fair allocation + logged manager override, transactional capacity control, breakdown requeue, surge alerts, outbox notifications, audit log, station scoping.
Architecture: server.js modules = auth, bookings, recurring, fleet, dispatch, manager, admin; SQLite constraints (unique refs/occurrences, partial unique index = one active assignment per booking, CHECKs). Frontend: public/index.html (vanilla, Bootstrap CDN, mobile first).
Not included: real SMS gateway, SignalR-style push (UI polls every 20s), password login, DB backups (copy transport.db).

## v1.2 additions
- PATCH `/bookings/:id` (re-queues and reallocates; assigned seats are released), PATCH `/recurring/:id` (applies to unconfirmed weeks only), manager `POST /manager/bookings/:id/no-show` (before departure).
- Config per global / `station:ID` / `route:ID` (route overrides station overrides global): `cutoff_min`, `cancel_deadline_min`, `confirm_hours_before` (default 78 = Fri 18:00 before Monday), `surge_seats`, `surge_wait`, `max_vehicles`. `PUT /config` (admin for global; managers within their scope).
- Documents: upload (`POST /documents`, pdf/jpg/png ≤4MB, stored in `uploads/`), manager verify/reject, licence doc required before driver verification, vehicle needs verified registration + insurance (`docs_ok`) to be dispatchable. Max vehicles per driver; manager vehicle transfer (re-verification required).
- Station scoping: managers with a station see only that station's drivers/vehicles/docs/exceptions/audit. Create via `POST /admin/managers`. Drivers pick a home station at registration.
- Surge: shortfall = queued seats - free seats on open trips - expected seats from returning vehicles with matching availability (today only).
- Full-vehicle approval auto-reserves an exclusive trip (or pass `vehicleId`); passengers can cancel the request.
- Reports `/reports/route-demand`, `/reports/driver-utilisation`, `/reports/daily-operations` with `?from=&to=&format=csv`.
- `GET /bookings?page=&limit=` (+ `X-Total-Count`), `Idempotency-Key` header or `idempotencyKey` body on `POST /bookings`.

## v1.3 – going live
- **Messaging:** `gateway.js` (`SMS_PROVIDER=twilio|http`; console delivery is test-only; WhatsApp via `NOTIFY_CHANNEL=whatsapp` with Twilio, needs approved templates). Notifications go through a DB outbox: retries with backoff (5 attempts → Failed), per-user hourly SMS cap, delivery callbacks at `POST /webhooks/sms-status?key=WEBHOOK_KEY`. OTPs are sent directly (retried once), never stored in plaintext.
- **Auth:** OTP hashed, 5 wrong tries burns it, 3 OTP requests/10 min/phone, IP limits, sessions table (hashed tokens, expiry 7d users / 12h staff, `/auth/logout`, `/auth/logout-all`, revoked on role/PIN change). Registration requires a 6+ character PIN. Passengers can recover a forgotten PIN using phone OTP; successful reset revokes existing sessions. Managers/admins also need a PIN (scrypt, lock after 5 failures); `POST /admin/users/:id/pin`, `POST /admin/managers` takes `pin`.
- **Deploy:** `cp .env.example .env`, set distinct random values for `APP_SECRET`, `WEBHOOK_KEY`, and `HEALTH_KEY` (for example, generate each with `openssl rand -hex 32`), and provide the initial admin phone/PIN before `docker compose up -d` (Caddy gives automatic HTTPS). Production can start before payment/SMS credentials are configured; sign in with the seeded admin phone/PIN and add provider credentials in the Platform admin panel. OTP delivery and payment operations are unavailable until their providers are configured. `APP_SECRET` and first-admin settings are required on fresh databases in every environment; OTP is never echoed in production.
- **Payments:** `PAYMENT_PROVIDER=mock` is test-only. Eganow-backed actions require credentials and HTTPS provider URLs, which an admin can configure after first login; failed driver payouts can be retried by an in-scope manager, and each failed attempt is retained in payout history for audit.
- **Data:** versioned `migrations/*.sql` (existing DBs are adopted automatically). Verified online backups every `BACKUP_EVERY_H` hours (keeps `BACKUP_KEEP`), `npm run backup`, `npm run restore -- <file>` (stop the app first; also back up `/data/uploads` and copy backups off-server). SQLite is single-node; move to Postgres only if you outgrow one server.
- **Live + offline:** Server-Sent Events replace polling (60 s fallback); PWA manifest + service worker cache the app shell and last-seen data (cleared on logout).
- Limits are in-memory (single process). Run one instance.

## v1.4
- Admin screens: create station manager, set any user's PIN; staff change their own PIN (`/me/pin`).
- Reminders (job-driven, SMS): weekly-review reminder at `remind_hours` (24) and final at `final_remind_hours` (3) before the deadline; ride reminder to passengers and trip reminder to drivers `ride_remind_min` (60) before departure. All configurable via `/config`.
- Manager: manual assign/move of a booking to a trip with reason (+ optional seat label; the system tracks seat counts, labels are informational), trip reschedule and delay (status `Delayed`), passengers + driver notified. Driver can report own breakdown (boarded passengers are never silently reassigned; manager must set driver/vehicle Available again afterwards).
- Passenger bookings show plain-language queue/ETA text, vehicle plate and seat label.
- Privacy: consent recorded at sign-up (`public/terms.html` is a DRAFT for legal review), `/me/export`, `/me/delete` (anonymises, removes documents/messages, blocked while a trip is active), retention job (`NOTIF_DAYS`=90, `AUDIT_DAYS`=730).
- No-show rule: `noshow_limit` (3) within `noshow_days` (30) suspends booking for `noshow_block_days` (14); warnings before that; `POST /manager/users/:id/lift-block`.
- Bootstrap is served locally (gzipped, cached 30 days, precached by the service worker). No CDN needed.
- Server timezone should be Africa/Accra (UTC) so cut-offs and reminders line up.

## v1.5
- Manager screens: no-show suspension list with Lift button; config overrides table (view/add/remove) with built-in defaults; audit log with filters, paging and CSV export; reports with charts (by route, day, hour, outcomes, driver).
- Booking and trip scheduling APIs validate real calendar dates and 24-hour times server-side. Weekly recurring confirmations are limited to the next upcoming Monday-starting week.
- Document expiry: expiry dates on uploads, 30/7-day warnings, automatic un-verify on expiry (see docs/OPS.md).
- WhatsApp: per-user opt-in, approved-template sending, automatic SMS fallback (needs Twilio/Meta approval, see docs/OPS.md).
- Terms: fuller DRAFT with placeholders + versioned re-consent (`TERMS_VERSION`). It still needs a lawyer.
- Monitoring: `/healthz/deep?key=`, admin "System health", alerts via webhook/SMS, backup dead-man's-switch ping.

## v1.6
- Fare-based station and platform charges are snapshotted for each new booking. Riders see one total; administrators configure independent rider and driver percentages globally or by station. The driver payout uses the saved driver-side deductions.
- Cash is opt-in by route/station/global configuration. Cash rides enter dispatch immediately; boarding creates a driver receivable for rider-side charges plus driver-side deductions. Drivers settle receivables with MoMo through the separate fee account.
- Append-only fee ledger, station-scoped accountant role, fee reconciliation/reporting, approval-controlled waivers/manual settlements, and configurable overdue reminders.
- Configure fee-account Eganow credentials with `FEES_EGANOW_*`. Production startup requires these credentials whenever cash is enabled. See [docs/OPS.md](docs/OPS.md) for reconciliation procedures.

## Tenant stations, organizations, and fee allocation
- A tenant represents a major station/location; terminals belong to that tenant. Organizations/unions can operate across one or more tenants.
- Organizations own routes and set fares. An organization can serve the same origin/destination pair as another organization. Tenant managers add terminals; organization managers create routes and fares.
- Tenant-scoped rates configure station/platform fees; organization-scoped rates configure loading fees. Fee payer shares are configurable by fee type and rider-charge/driver-deduction stream, and each booking snapshots the applicable allocation.
- Daily settlement balances group amounts due between configured payers and recipients. Recording a settlement logs the payment and reference; it does not initiate a bank or mobile-money transfer.
- Migration `012_organizations_and_fee_allocations.sql` adds the organization/tenant relationships, fee allocations, and settlement records while preserving existing station and route data.
- Tenant managers are assigned a tenant; station-scoped managers remain limited to their assigned station. Drivers and Porters remain assigned to a terminal. Tenant- and organization-scoped dashboards, reports, audit entries, and route operations stay within their scope.
- Drivers select their payout timing during onboarding: after each rider confirms boarding, or after trip completion and manager settlement. A manager can override the selection per driver and clear the override to restore the driver's choice.
- Migration `011_tenants_and_driver_payout_timing.sql` preserves existing stations and routes, assigns existing stations their own tenant scope, and adds payout preference/override fields.

## Platform administration
- Platform admins have a dedicated settings panel for Eganow, Twilio/HTTP SMS, WhatsApp and SMTP configuration, and existing user/station setup. Provider credentials are encrypted in SQLite with AES-256-GCM using a key derived from `APP_SECRET`; the API only reports whether a secret is configured. Keep `APP_SECRET` unchanged while encrypted settings exist and back up the database securely.
- Settings entered in the admin panel are applied to the running process and persist in the database. `.env` values remain supported as deployment defaults. Production rejects mock/console providers and non-HTTPS provider URLs. On ephemeral hosts such as Render Free, settings stored in SQLite can be lost when the service restarts; use persistent storage or configure provider variables in the host environment for durable operation.
- Fee percentage settings are maintained in the admin “Fees & charges” card and apply to new bookings only. Fee payer shares are configured separately by platform, tenant, or organization scope. The quote endpoint and passenger screens expose one total rather than a breakdown.
- SMTP settings can be managed by an admin, but user notifications are currently delivered through the SMS/WhatsApp notification pipeline; email delivery is not yet attached to user accounts.

