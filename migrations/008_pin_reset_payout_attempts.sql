alter table otps add column purpose text not null default 'verify';

create table driver_payout_attempts(
 id integer primary key,
 payout_id integer not null references driver_payouts(id),
 transaction_id text not null unique,
 amount_pesewas integer not null,
 status text not null,
 response_status text,
 created_at text not null,
 updated_at text not null
);
