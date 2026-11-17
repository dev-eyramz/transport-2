alter table excl add column seats integer not null default 1 check(seats >= 1);
