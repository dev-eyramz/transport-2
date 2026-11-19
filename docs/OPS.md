# Operations guide

## 1. Uptime monitoring and alerts
**External (is the whole app down?)** Point an uptime service (UptimeRobot, Better Stack, Pingdom) at
`https://YOUR-DOMAIN/healthz/deep?key=HEALTH_KEY` every 1-5 min. It returns 200 only when the database, backups, messaging queue and scheduler are all healthy, otherwise 503 with the failing checks.
**Backups dead-man's switch:** create a free check at healthchecks.io, put its URL in `BACKUP_PING_URL`; it alerts you if backups stop.
**Internal alerts (app-detected)** go to `ALERT_WEBHOOK` (Slack/Discord/Telegram-bridge URL). Triggers: backup failure, 5 consecutive message-send failures, OTP SMS failure, stale backup (> 2 intervals), messages stuck > 15 min, 5+ failed messages/hour, scheduler silent > 60 s. Repeats are suppressed for `ALERT_COOLDOWN_MIN` (60). Admins also see "System health" at the top of their screen.
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
- Configure each tenant's Eganow, SMS, and SMTP settings in Admin > API settings. Collections, payouts, and fee collections use the route tenant's Eganow credentials; SMS and WhatsApp use the notification tenant's settings. Missing tenant settings block provider calls, and unscoped notifications stay in-app.
- Country code, language, and mobile-money partners are system-supplied Eganow payload defaults (`EGANOW_DEFAULT_COUNTRY_CODE`, `EGANOW_DEFAULT_LANGUAGE`, and `EGANOW_MOMO_PARTNERS`). These cannot be set in a tenant's API settings.
- Provider credentials are encrypted with `APP_SECRET`. Use HTTPS for configured provider URLs in production, and keep `APP_SECRET` stable so saved tenant credentials remain decryptable.
- On Render Free, tenant settings live in SQLite and can be lost on restart or spin-down. Use a persistent disk for durable settings.
- Review `/reports/fees` by date and station. Match digital `rider_charge` and `driver_deduction` entries against provider settlement records; the fee ledger records the charges but does not initiate transfers to the fee account.
- For cash rides, reconcile `fee_receivables` and driver MoMo collections daily. Check pending/NeedsReview collections with the driver before retrying; successful status checks allocate oldest receivables first. Compare settled receivable amounts with `cash_settlement` ledger rows.
- Record waivers or manual settlements with a reason. When `fee_manual_needs_approval=1`, a different station manager/accountant must approve; review the associated audit entry before closing the reconciliation period.
- Investigate overdue notifications and outstanding balances before enabling `fee_block_cash`. That option prevents new cash assignments to drivers above `fee_max_outstanding_ghs`; digital dispatch remains unaffected.

## 6. Tenant, organization, and fee setup
- Treat each major station/location as a tenant and create its terminals under that tenant. The terminal list includes both the major station and its smaller pickup/destination stations.
- Create organizations/unions and link each to the tenant stations where it operates. Organizations—not tenants—own routes and set fares. Organization managers create routes from a tenant they serve; tenant managers can add terminals but do not set organization fares.
- Configure station/platform rate defaults or overrides at tenant scope and loading rates at organization scope. Configure payer shares separately: platform shares are global, station shares are global or tenant-scoped, and loading shares are global or organization-scoped. Shares must total 100% for each fee and charge stream.
- Review the daily fee settlement balances by service date. A recorded settlement logs the parties, amount, and optional reference; it does not initiate a transfer. Reconcile those records against actual payment/provider evidence before closing the day.
- Migrations `011_tenants_and_driver_payout_timing.sql`, `012_organizations_and_fee_allocations.sql`, and `014_role_permissions_and_vehicle_archiving.sql` are applied automatically at startup. They preserve existing station and route data while adding tenant/organization relationships, fee allocations, settlement records, role permissions, and vehicle archive state.
- Drivers choose their payout timing during onboarding. A tenant/station manager may override it for one driver or clear the override to restore the driver's choice.
- User and vehicle lists are tenant/organization scoped. Platform admins manage users across tenants; managers can manage only driver, passenger, or porter accounts in their scope. Role permissions are configurable by admins and are checked together with the caller's role and scope.
- Drivers manage their own vehicles; managers can manage and transfer vehicles within their scope. Deactivation/archive is reversible and preserves history. The system blocks deactivation or archiving while a user has active trips/bookings or a vehicle has an active trip.
