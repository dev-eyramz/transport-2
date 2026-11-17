create table platform_settings(
 key text primary key,
 value text not null,
 encrypted integer not null default 0 check(encrypted in(0,1))
);

alter table bookings add column station_fee_pesewas integer not null default 0;
