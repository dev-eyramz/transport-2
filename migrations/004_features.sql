alter table confirmations add column reminded int default 0;
alter table bookings add column reminded int default 0;
alter table trips add column reminded int default 0;
alter table assignments add column seat_label text;
alter table users add column consent_at text;
alter table users add column consent_ver text;
alter table users add column noshow_blocked_until int default 0;
alter table users add column deleted_at text;
