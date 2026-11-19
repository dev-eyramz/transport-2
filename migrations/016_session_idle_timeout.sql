alter table sessions add column last_activity integer;
update sessions set last_activity=created where last_activity is null;
create index sessions_last_activity on sessions(last_activity);
