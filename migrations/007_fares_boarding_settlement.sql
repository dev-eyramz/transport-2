alter table drivers add column payout_partner text;
alter table drivers add column payout_msisdn text;
alter table bookings add column fare_pesewas integer not null default 0;
alter table bookings add column platform_fee_pesewas integer not null default 0;
alter table bookings add column paid_pesewas integer not null default 0;
alter table bookings add column payment_status text not null default 'Due';
alter table assignments add column onboard_confirmed integer not null default 0;
alter table assignments add column onboard_confirmed_at text;
alter table trips add column settlement_confirmed_by integer;
alter table trips add column settlement_confirmed_at text;
alter table trips add column departed_at text;

create table booking_payments(
 id integer primary key,
 booking_id integer not null references bookings(id),
 transaction_id text not null unique,
 amount_pesewas integer not null check(amount_pesewas>0),
 status text not null default 'Pending',
 response_status text,
 created_at text not null,
 updated_at text not null
);
create index booking_payments_booking on booking_payments(booking_id,id desc);

create table booking_credits(
 id integer primary key,
 booking_id integer not null references bookings(id),
 passenger_id integer not null references users(id),
 amount_pesewas integer not null,
 entry_type text not null check(entry_type in('NoShow','Applied')),
 created_at text not null,
 unique(booking_id,entry_type)
);

create table driver_payouts(
 id integer primary key,
 booking_id integer not null unique references bookings(id),
 trip_id integer not null references trips(id),
 transaction_id text not null unique,
 amount_pesewas integer not null check(amount_pesewas>0),
 gate text not null check(gate in('onboard','manager_completion')),
 status text not null default 'Pending',
 response_status text,
 created_at text not null,
 updated_at text not null
);
