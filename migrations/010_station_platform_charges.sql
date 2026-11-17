alter table bookings add column payment_method text not null default 'digital';
alter table bookings add column rider_station_pct real not null default 0;
alter table bookings add column rider_platform_pct real not null default 0;
alter table bookings add column driver_station_pct real not null default 0;
alter table bookings add column driver_platform_pct real not null default 0;
alter table bookings add column driver_station_deduction_pesewas integer not null default 0;
alter table bookings add column driver_platform_deduction_pesewas integer not null default 0;

update bookings set driver_platform_deduction_pesewas=platform_fee_pesewas;

create table fee_ledger(
 id integer primary key,
 booking_id integer not null references bookings(id),
 station_id integer not null references stations(id),
 source text not null check(source in('rider_charge','driver_deduction','cash_settlement')),
 kind text not null check(kind in('station','platform')),
 amount_pesewas integer not null,
 created_at text not null,
 unique(booking_id,source,kind)
);
create trigger fee_ledger_no_update before update on fee_ledger
 begin select raise(abort,'fee_ledger is append-only'); end;
create trigger fee_ledger_no_delete before delete on fee_ledger
 begin select raise(abort,'fee_ledger is append-only'); end;

create table fee_receivables(
 id integer primary key,
 booking_id integer not null unique references bookings(id),
 driver_id integer not null references users(id),
 station_id integer not null references stations(id),
 station_pesewas integer not null,
 platform_pesewas integer not null,
 status text not null default 'Open' check(status in('Open','PartiallyPaid','Settled')),
 created_at text not null,
 due_at text not null
);
create index fee_receivables_driver_status on fee_receivables(driver_id,status,due_at,id);
create index fee_receivables_station_status on fee_receivables(station_id,status,due_at,id);

create table fee_collections(
 id integer primary key,
 driver_id integer not null references users(id),
 transaction_id text not null unique,
 amount_pesewas integer not null check(amount_pesewas>0),
 status text not null default 'Pending' check(status in('Pending','Succeeded','Failed','NeedsReview')),
 response_status text,
 created_at text not null,
 updated_at text not null
);
create index fee_collections_driver on fee_collections(driver_id,id desc);

create table fee_allocations(
 id integer primary key,
 collection_id integer references fee_collections(id),
 receivable_id integer not null references fee_receivables(id),
 fee_kind text not null check(fee_kind in('station','platform')),
 amount_pesewas integer not null check(amount_pesewas>0),
 kind text not null check(kind in('collection','waiver','manual_settlement')),
 reason text,
 recorded_by integer references users(id),
 approved_by integer references users(id),
 created_at text not null
);
create index fee_allocations_receivable on fee_allocations(receivable_id,id);

create table fee_adjustments(
 id integer primary key,
 receivable_id integer not null references fee_receivables(id),
 kind text not null check(kind in('waiver','manual_settlement')),
 amount_pesewas integer not null check(amount_pesewas>0),
 reason text not null,
 recorded_by integer not null references users(id),
 approved_by integer references users(id),
 status text not null default 'Pending' check(status in('Pending','Applied','Rejected')),
 created_at text not null,
 updated_at text not null
);
create index fee_adjustments_receivable on fee_adjustments(receivable_id,id);
