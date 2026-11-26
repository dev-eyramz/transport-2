# Community Transport Reservation & Dispatch (Node + Express)
Run: configure `APP_SECRET`, `SEED_ADMIN_PHONE`, and `SEED_ADMIN_PIN` in the environment, then `npm install && npm start` → http://localhost:3000 · Test: `npm test`
No demo accounts, stations, or routes are created for fresh databases. Existing databases retain their data, so review and rotate any legacy demo users manually. On a fresh database, set `SEED_ADMIN_PHONE` and a unique `SEED_ADMIN_PIN` (6+ characters) to provision the initial admin. Set `APP_SECRET` to a unique random value of at least 32 characters in every environment; the app does not use a built-in secret fallback. Create station-scoped managers through the admin workflow.
Env: PORT, DB, DB_BACKEND (`sqlite` by default; optional `postgres`), DATABASE_URL, POSTGRES_SCHEMA, CUTOFF_MIN(30), TRIP_MIN(60), SURGE_SEATS(4), SURGE_WAIT(30), JOB_MS(10000).
Passenger signup verification is required by default. To temporarily bypass OTP and Ghana Card checks for new passenger registrations only, set `PASSENGER_SIGNUP_VERIFICATION=disabled`; set it back to `required` when verification services are ready. Bypass-created accounts remain explicitly unverified.
Implements v1.1 policies: manager-controlled driver availability, mandatory weekly recurring confirmation (idempotent), automatic fair allocation + logged manager override, transactional capacity control, breakdown requeue, surge alerts, outbox notifications, audit log, station scoping.
Architecture: server.js modules = auth, bookings, recurring, fleet, dispatch, manager, admin; SQLite constraints (unique refs/occurrences, partial unique index = one active assignment per booking, CHECKs). Frontend: public/index.html (vanilla, Bootstrap CDN, mobile first).
Not included: SignalR-style push (UI polls every 20s), password login.

## v1.2 additions
- PATCH `/bookings/:id` (re-queues and reallocates; assigned seats are released), PATCH `/recurring/:id` (applies to unconfirmed weeks only), manager `POST /manager/bookings/:id/no-show` (before departure).
- Config per global / `station:ID` / `route:ID` (route overrides station overrides global): `cutoff_min`, `cancel_deadline_min`, `confirm_hours_before` (default 78 = Fri 18:00 before Monday), `surge_seats`, `surge_wait`, `max_vehicles`. `PUT /config` (admin for global; managers within their scope).
- Documents: upload (`POST /documents`, pdf/jpg/png ≤4MB, stored in `uploads/`), manager verify/reject. Driver approval is automatic after a valid licence and an approved vehicle with verified registration and insurance; no separate driver verification action is required. Max vehicles per driver; manager vehicle transfer (re-verification required).
- Station scoping: managers with a station see only that station's drivers/vehicles/docs/exceptions/audit. Create via `POST /admin/managers`. Drivers and porters receive their fixed station/organization scope through a tenant-issued invitation and approval.
- Surge: shortfall = queued seats - free seats on open trips - expected seats from returning vehicles with matching availability (today only).
- Full-vehicle approval auto-reserves an exclusive trip (or pass `vehicleId`); passengers can cancel the request.
- Reports `/reports/route-demand`, `/reports/driver-utilisation`, `/reports/daily-operations` with `?from=&to=&format=csv`.
- `GET /bookings?page=&limit=` (+ `X-Total-Count`), `Idempotency-Key` header or `idempotencyKey` body on `POST /bookings`.

## v1.3 – going live
- **Messaging:** SMS/WhatsApp credentials are configured per tenant under Admin > API settings. Notifications go through a DB outbox: retries with backoff (5 attempts → Failed), per-user hourly SMS cap, tenant-keyed delivery callbacks at `POST /webhooks/sms-status`. Notifications without a tenant or configured SMS provider remain in-app; there is no console or development OTP delivery.
- **Auth:** OTPs are hashed; five wrong code attempts burn a code. Auth OTP requests are limited to 3 per phone per 10 minutes and by source IP. Invitation OTP sends use shared database-backed caps: 10 per IP/10 minutes, 3 per phone/10 minutes, 20 per invitation/10 minutes, 100 per tenant/hour, and 500 per tenant/day; over-limit requests do not send SMS. Sessions use hashed tokens; browser sessions are HttpOnly, SameSite=Strict cookies with a 2-minute idle timeout and expiry of 7 days for users / 12 hours for staff; sessions are revoked on role/PIN change. Browser code does not store session tokens in web storage. Passenger registration requires phone OTP, Ghana Card verification, and a 6+ character PIN. Passengers can recover a forgotten PIN using phone OTP; successful reset revokes existing sessions. Managers/admins also need a PIN (scrypt, lock after 5 failures); `POST /admin/users/:id/pin`, `POST /admin/managers` takes `pin`.
- **Deploy:** `cp .env.example .env`, set distinct random values for `APP_SECRET` and `HEALTH_KEY` (for example, generate each with `openssl rand -hex 32`), set `APP_BASE_URL` to the public HTTPS address for Docker/Caddy or custom domains (Render and Railway public domains are detected automatically), and provide the initial admin phone/PIN before `docker compose up -d` (Caddy gives automatic HTTPS). Sign in with the provisioned admin phone/PIN. Platform OTP SMS is configured under Admin > API settings; operational SMS and payment providers are configured per tenant. OTP and payment operations remain unavailable until the relevant provider is configured. `APP_SECRET` and first-admin settings are required on fresh databases; OTP codes are never echoed.
- **Payments:** Eganow credentials are encrypted and configured independently for each tenant under Admin > API settings. A route uses its tenant's credentials for collections, payouts, and fee collections; missing tenant credentials prevent a provider request. Country code, language, and mobile-money partners are system-supplied payload values, not tenant-entered fields. Failed driver payouts can be retried by an in-scope manager, and each failed attempt is retained in payout history for audit.
- **Data:** versioned `migrations/*.sql` (existing DBs are adopted automatically). Verified online backups every `BACKUP_EVERY_H` hours (keeps `BACKUP_KEEP`), `npm run backup`, `npm run restore -- <file>` (stop the app first; also back up `/data/uploads` and copy backups off-server). SQLite is single-node; move to Postgres only if you outgrow one server.
- **Live + offline:** Server-Sent Events replace polling (60 s fallback); PWA manifest + service worker cache the app shell and last-seen data (cleared on logout).
- Limits are in-memory (single process). Run one instance.

## PostgreSQL backend and one-time SQLite copy

SQLite remains the default and is unchanged unless `DB_BACKEND=postgres` is explicitly selected. PostgreSQL uses `DATABASE_URL` and an optional `POSTGRES_SCHEMA` (default `public`). Remote PostgreSQL connections in production must explicitly use TLS (`sslmode=require` or stricter). The selected PostgreSQL schema is created if needed, and the app initializes its current schema on an empty target. A schema-version mismatch fails startup rather than silently using an incompatible schema.

To copy a SQLite database without modifying its source, point `DATABASE_URL` at a **new, empty** PostgreSQL database/schema and run:

```sh
DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require' \
POSTGRES_SCHEMA=transport \
npm run db:copy:postgres -- --source /path/to/transport.db
```

The copy tool snapshots the SQLite file read-only, applies SQLite migrations to the temporary snapshot, imports all rows into PostgreSQL in a transaction, defers and verifies foreign keys, checks row counts, and resets generated-ID sequences. It refuses to merge into tables containing application data. Stop writes to the source before the final copy; writes made after its snapshot will not be present in PostgreSQL.

After verifying the copy, select PostgreSQL in the app environment with `DB_BACKEND=postgres`, `DATABASE_URL`, and `POSTGRES_SCHEMA`, then restart. The app uses **one database at a time**: there is no continuous replication, dual-write, automatic failover, or automatic reverse-copy. Switching back to SQLite after PostgreSQL has accepted writes would discard those newer writes unless you perform a separate migration.

PostgreSQL backups use `pg_dump` custom archives and are verified with `pg_restore --list`. The `restore` CLI remains SQLite-only; use your database host's recovery features or a deliberate, verified `pg_restore` procedure for PostgreSQL.

**Performance note:** PostgreSQL currently uses the synchronous `pg-native` interface to preserve the app's synchronous SQLite query model. Each database round trip blocks that Node.js process until the remote PostgreSQL host responds. This backend is functionally tested, but measure latency and load in a staging environment before production cutover; a high-latency remote host can delay requests.

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
- Monitoring: `/healthz/deep?key=`, admin "System health", webhook alerts, backup dead-man's-switch ping.

## v1.6
- Fare-based station and platform charges are snapshotted for each new booking. Riders see one total; administrators configure independent rider and driver percentages globally or by station. The driver payout uses the saved driver-side deductions.
- Cash is opt-in by route/station/global configuration. Cash rides enter dispatch immediately; boarding creates a driver receivable for rider-side charges plus driver-side deductions. Drivers settle receivables with MoMo through their tenant's Eganow configuration.
- Append-only fee ledger, station-scoped accountant role, fee reconciliation/reporting, approval-controlled waivers/manual settlements, and configurable overdue reminders.
- Tenant Eganow settings are used for collections, payouts, and fee collections. See [docs/OPS.md](docs/OPS.md) for reconciliation procedures.
- The Accounting ledger adds an append-only, double-entry GHS journal: digital fares are driver payables, allocated fees are credited separately to Platform, Tenant, or Organization revenue accounts based on the recipient (not the payer), successful payouts/fee collections and cash-trip fee receivables are posted automatically, and approved waivers/manual settlements are recorded. A tenant or organization may fund a platform fee; that income still credits Platform revenue. Admins see the consolidated books; accountants see their assigned station, tenant, or organization scope. The ledger card includes account balances, income/expense summaries, reconciliation alerts, CSV exports, and manual operating-expense entries with reversal support. This management ledger is not a substitute for professional review of tax, statutory, or entity-specific accounting treatment.

## Tenant stations, organizations, and fee allocation
- A tenant represents a major station/location; terminals belong to that tenant. Organizations/unions can operate across one or more tenants.
- Organizations own routes and set fares. An organization can serve the same origin/destination pair as another organization. Tenant managers add terminals; organization managers create routes and fares.
- Tenant-scoped rates configure station/platform fees; organization-scoped rates configure loading fees. Fee payer shares are configurable by fee type and rider-charge/driver-deduction stream, and each booking snapshots the applicable allocation.
- Daily settlement balances group amounts due between configured payers and recipients. Recording a settlement logs the payment and reference; it does not initiate a bank or mobile-money transfer.
- Migration `012_organizations_and_fee_allocations.sql` adds the organization/tenant relationships, fee allocations, and settlement records while preserving existing station and route data.
- Tenant managers are assigned a tenant; station-scoped managers remain limited to their assigned station. Drivers and Porters remain assigned to a terminal. Tenant- and organization-scoped dashboards, reports, audit entries, and route operations stay within their scope.
- Drivers select their payout timing during onboarding: after each rider confirms boarding, or after trip completion and manager settlement. A manager can override the selection per driver and clear the override to restore the driver's choice.
- Migration `011_tenants_and_driver_payout_timing.sql` preserves existing stations and routes, assigns existing stations their own tenant scope, and adds payout preference/override fields.
- User management is role- and permission-based: platform admins can manage users across tenants, while managers can edit, deactivate, and restore driver, passenger, and porter accounts only in their assigned tenant/organization. New drivers and porters must use scoped invitations and tenant review; platform admins provision tenant managers through the admin workflow. Direct driver/porter creation is disabled. Passengers are global accounts, and bookings—not passenger profiles—are scoped to a tenant, station, and route. Admins configure per-role permissions in the Role permissions card; API requests also enforce tenant scope.
- Drivers can register, edit, and archive their own vehicles. Managers can manage vehicles and transfer them only within their assigned scope. Vehicle archives and user deactivations are soft deletes that preserve operational history; vehicles with active trips and users with active driver trips or passenger bookings cannot be deactivated.
- Migration `014_role_permissions_and_vehicle_archiving.sql` adds the role-permission matrix and vehicle archive state.

## Platform administration
- Platform admins have a dedicated settings panel for Eganow, Twilio/HTTP SMS, WhatsApp and SMTP configuration, and existing user/station setup. Provider credentials are encrypted in SQLite with AES-256-GCM using a key derived from `APP_SECRET`; the API only reports whether a secret is configured. Keep `APP_SECRET` unchanged while encrypted settings exist and back up the database securely.
- Platform-wide OTP SMS and Ghana Card verification are configured in the system provider settings. The identity connector sends `POST {idType:"GHANA_CARD", idNumber, fullName, phone}` with a Bearer token and expects JSON `{verified:true|false}`. Use an approved provider endpoint; production endpoints must use HTTPS. The card number and provider response are not persisted. Platform secrets are encrypted at rest and are only reported as configured/not configured.
- Tenant provider settings entered in Admin > API settings are encrypted where secret and persist in SQLite. In production, provider URLs must use HTTPS. The system payload defaults `EGANOW_DEFAULT_COUNTRY_CODE`, `EGANOW_DEFAULT_LANGUAGE`, and `EGANOW_MOMO_PARTNERS` can be set in the environment. On ephemeral hosts such as Render Free, database settings can be lost when the service restarts; use persistent storage.
- Fee percentage settings are maintained in the admin “Fees & charges” card and apply to new bookings only. Fee payer shares are configured separately by platform, tenant, or organization scope. The quote endpoint and passenger screens expose one total rather than a breakdown.
- SMTP settings can be managed by an admin, but user notifications are currently delivered through the SMS/WhatsApp notification pipeline; email delivery is not yet attached to user accounts.

## Staff onboarding and passenger route discovery
- Platform admins create tenants and connect stations/organizations. Tenant administrators invite drivers or porters for a fixed role and scope. Invitation links support configurable 1–365 day expiry, single- or multiple-use, and revocation. Invitation URLs use `APP_BASE_URL` when it is a public address, otherwise Render/Railway deployment domains are detected automatically; other production deployments must configure a public HTTPS origin.
- Applicants verify their phone by OTP and submit details/documents without choosing or changing their tenant, station, organization, or role. Tenant administrators can approve, reject, or request changes with a comment. Applicants verify their phone to view the decision and can resubmit only after “Needs changes.” Approval creates the scoped account; driver approval is then automatic after the licence and vehicle documents are verified and the vehicle is approved. The applicant sets their PIN after application approval. Review history is retained for both sides.
- Passengers register globally with phone OTP and Ghana Card verification; the card number is sent to the configured identity provider and is not stored. Booking records carry the selected route/station/tenant scope. Only published routes are shown to passengers; new routes are published by default, and platform admins or in-scope organization managers can unpublish or republish them.
- Nearby route sorting is optional. Station coordinates are managed by administrators; “Use my location” reads browser location only to sort nearby routes. Passengers can also search route names and origin/destination stations manually, without location access. Precise passenger location is not sent to or stored by the server.
- Migration `015_invited_onboarding_and_global_passengers.sql` adds the invitation/review flow, platform provider settings, station coordinates, and route publication state.

