create table organizations(
 id integer primary key,
 name text not null unique,
 created_at text not null default current_timestamp
);
insert into organizations(id,name,created_at)
 select id,name,created_at from tenants;

create table org_tenants(
 organization_id integer not null references organizations(id),
 tenant_id integer not null references tenants(id),
 created_at text not null default current_timestamp,
 primary key(organization_id,tenant_id)
);

create temp table legacy_station_scope(
 station_id integer primary key,
 organization_id integer not null,
 tenant_id integer
);
insert into legacy_station_scope(station_id,organization_id)
 select id,tenant_id from stations where tenant_id is not null;

alter table tenants add column hub_station_id integer references stations(id);
alter table stations add column code text;
alter table users add column organization_id integer references organizations(id);
alter table drivers add column organization_id integer references organizations(id);
alter table audit add column organization_id integer references organizations(id);
alter table routes add column organization_id integer references organizations(id);
alter table bookings add column organization_id integer references organizations(id);
alter table bookings add column loading_fee_pesewas integer not null default 0;
alter table bookings add column driver_loading_deduction_pesewas integer not null default 0;
alter table bookings add column rider_loading_pct real not null default 0;
alter table bookings add column driver_loading_pct real not null default 0;

update tenants set name='__legacy_tenant_'||id;
update tenants set name=coalesce(
 (select s.name from legacy_station_scope m join stations s on s.id=m.station_id
  where m.organization_id=tenants.id order by m.station_id limit 1),
 'Legacy hub '||id
);
insert into tenants(name,created_at)
 select s.name,coalesce((select created_at from tenants where id=m.organization_id),current_timestamp)
 from legacy_station_scope m join stations s on s.id=m.station_id
 where m.station_id<>(select min(x.station_id) from legacy_station_scope x where x.organization_id=m.organization_id);
update legacy_station_scope set tenant_id=case
 when station_id=(select min(x.station_id) from legacy_station_scope x where x.organization_id=legacy_station_scope.organization_id)
 then organization_id
 else (select id from tenants where name=(select name from stations where id=legacy_station_scope.station_id))
 end;
insert into org_tenants(organization_id,tenant_id)
 select organization_id,tenant_id from legacy_station_scope;
update tenants set hub_station_id=(
 select station_id from legacy_station_scope where legacy_station_scope.tenant_id=tenants.id
);
update stations set tenant_id=(
 select tenant_id from legacy_station_scope where legacy_station_scope.station_id=stations.id
);

with recursive station_words(station_id,rest,initials) as(
 select id,trim(name)||' ',''
 from stations
 union all
 select station_id,substr(rest,instr(rest,' ')+1),
  initials||case when length(initials)<4 then upper(substr(rest,1,1)) else '' end
 from station_words where rest<>''
),station_initials as(
 select station_id,initials from station_words where rest=''
)
update stations set code=(
 select initials||'-'||upper(hex(randomblob(4)))
 from station_initials where station_initials.station_id=stations.id
);
create unique index stations_code on stations(code);
create unique index tenants_hub_station on tenants(hub_station_id);
create index org_tenants_tenant on org_tenants(tenant_id,organization_id);

update routes set organization_id=tenant_id;
update routes set organization_id=(
 select organization_id from legacy_station_scope where station_id=routes.origin_id
) where organization_id is null;
update routes set tenant_id=(select tenant_id from legacy_station_scope where station_id=routes.origin_id);
pragma defer_foreign_keys=on;
create table routes_new(
 id integer primary key,
 tenant_id integer references tenants(id),
 organization_id integer references organizations(id),
 origin_id integer,
 dest_id integer,
 name text
);
insert into routes_new(id,tenant_id,organization_id,origin_id,dest_id,name)
 select id,tenant_id,organization_id,origin_id,dest_id,name from routes;
drop table routes;
alter table routes_new rename to routes;
create unique index routes_org_origin_dest on routes(organization_id,origin_id,dest_id);
create index routes_tenant on routes(tenant_id,id);
create index routes_organization on routes(organization_id,id);

update users set organization_id=case
 when role='driver' then (select organization_id from legacy_station_scope where station_id=users.station_id)
 when station_id is null and role in('manager','accountant') then tenant_id
 else null end;
update users set tenant_id=(select tenant_id from legacy_station_scope where station_id=users.station_id)
 where station_id is not null;
update users set tenant_id=null where organization_id is not null and station_id is null;
create index users_organization on users(organization_id,role);

update drivers set organization_id=(
 select organization_id from legacy_station_scope where station_id=drivers.station_id
);
update drivers set tenant_id=(
 select tenant_id from legacy_station_scope where station_id=drivers.station_id
) where station_id is not null;
create index drivers_organization on drivers(organization_id,station_id);

update audit set organization_id=(select organization_id from users where users.id=audit.actor);
update audit set tenant_id=coalesce(
 (select tenant_id from users where users.id=audit.actor),
 (select tenant_id from stations where stations.id=audit.station_id)
);
create index audit_organization on audit(organization_id,id);

insert or replace into config(scope,key,value)
 select 'tenant:'||m.tenant_id,c.key,c.value
 from config c join legacy_station_scope m on c.scope='station:'||m.station_id;

alter table fee_receivables add column loading_pesewas integer not null default 0;
alter table fee_allocations rename to fee_allocations_legacy;
create table fee_allocations(
 id integer primary key,
 collection_id integer references fee_collections(id),
 receivable_id integer not null references fee_receivables(id),
 fee_kind text not null check(fee_kind in('station','platform','loading')),
 amount_pesewas integer not null check(amount_pesewas>0),
 kind text not null check(kind in('collection','waiver','manual_settlement')),
 reason text,
 recorded_by integer references users(id),
 approved_by integer references users(id),
 created_at text not null
);
insert into fee_allocations select * from fee_allocations_legacy;
drop table fee_allocations_legacy;
create index fee_allocations_receivable on fee_allocations(receivable_id,id);

update bookings set organization_id=(select organization_id from routes where routes.id=bookings.route_id);

create table fee_share_config(
 scope_type text not null check(scope_type in('global','tenant','organization')),
 scope_id integer not null default 0,
 fee_kind text not null check(fee_kind in('station','platform','loading')),
 stream text not null check(stream in('rider','driver')),
 payer_type text not null check(payer_type in('rider','driver','organization','tenant')),
 percentage integer not null check(percentage between 0 and 100),
 updated_at text not null,
 primary key(scope_type,scope_id,fee_kind,stream,payer_type)
);
insert into fee_share_config(scope_type,scope_id,fee_kind,stream,payer_type,percentage,updated_at)
 select 'global',0,k.kind,s.stream,
  case s.stream when 'rider' then 'rider' else 'driver' end,100,current_timestamp
 from (select 'station' kind union all select 'platform' union all select 'loading') k
 cross join (select 'rider' stream union all select 'driver') s;

create table booking_fee_allocations(
 id integer primary key,
 booking_id integer not null references bookings(id),
 organization_id integer references organizations(id),
 origin_tenant_id integer references tenants(id),
 fee_kind text not null check(fee_kind in('station','platform','loading')),
 stream text not null check(stream in('rider','driver')),
 payer_type text not null check(payer_type in('rider','driver','organization','tenant')),
 payer_id integer,
 recipient_type text not null check(recipient_type in('platform','tenant','organization')),
 recipient_id integer,
 amount_pesewas integer not null check(amount_pesewas<>0),
 payer_percentage integer not null check(payer_percentage between 0 and 100),
 entry_type text not null default 'charge' check(entry_type in('charge','reversal')),
 created_at text not null
);
create index booking_fee_allocations_day on booking_fee_allocations(created_at,fee_kind,stream);
create index booking_fee_allocations_scope on booking_fee_allocations(origin_tenant_id,organization_id,booking_id);
create trigger booking_fee_allocations_no_update before update on booking_fee_allocations
 begin select raise(abort,'booking fee allocations are append-only'); end;
create trigger booking_fee_allocations_no_delete before delete on booking_fee_allocations
 begin select raise(abort,'booking fee allocations are append-only'); end;

insert into booking_fee_allocations(
 booking_id,organization_id,origin_tenant_id,fee_kind,stream,payer_type,payer_id,recipient_type,recipient_id,
 amount_pesewas,payer_percentage,entry_type,created_at
)
 select b.id,r.organization_id,r.tenant_id,'station','rider','rider',b.passenger_id,'tenant',r.tenant_id,
  b.station_fee_pesewas,100,'charge',coalesce(b.created,current_timestamp)
 from bookings b join routes r on r.id=b.route_id where b.station_fee_pesewas>0;
insert into booking_fee_allocations(
 booking_id,organization_id,origin_tenant_id,fee_kind,stream,payer_type,payer_id,recipient_type,recipient_id,
 amount_pesewas,payer_percentage,entry_type,created_at
)
 select b.id,r.organization_id,r.tenant_id,'platform','rider','rider',b.passenger_id,'platform',null,
  b.platform_fee_pesewas,100,'charge',coalesce(b.created,current_timestamp)
 from bookings b join routes r on r.id=b.route_id where b.platform_fee_pesewas>0;
insert into booking_fee_allocations(
 booking_id,organization_id,origin_tenant_id,fee_kind,stream,payer_type,payer_id,recipient_type,recipient_id,
 amount_pesewas,payer_percentage,entry_type,created_at
)
 select b.id,r.organization_id,r.tenant_id,'station','driver','driver',t.driver_id,'tenant',r.tenant_id,
  b.driver_station_deduction_pesewas,100,'charge',coalesce(b.created,current_timestamp)
 from bookings b join routes r on r.id=b.route_id
 join assignments a on a.booking_id=b.id
  and a.id=(select max(a2.id) from assignments a2 where a2.booking_id=b.id)
 join trips t on t.id=a.trip_id
 where b.driver_station_deduction_pesewas>0;
insert into booking_fee_allocations(
 booking_id,organization_id,origin_tenant_id,fee_kind,stream,payer_type,payer_id,recipient_type,recipient_id,
 amount_pesewas,payer_percentage,entry_type,created_at
)
 select b.id,r.organization_id,r.tenant_id,'platform','driver','driver',t.driver_id,'platform',null,
  b.driver_platform_deduction_pesewas,100,'charge',coalesce(b.created,current_timestamp)
 from bookings b join routes r on r.id=b.route_id join assignments a on a.booking_id=b.id
  and a.id=(select max(a2.id) from assignments a2 where a2.booking_id=b.id)
 join trips t on t.id=a.trip_id
 where b.driver_platform_deduction_pesewas>0;

create table fee_settlement_entries(
 id integer primary key,
 settlement_date text not null,
 payer_type text not null check(payer_type in('rider','driver','organization','tenant')),
 payer_id integer,
 recipient_type text not null check(recipient_type in('platform','tenant','organization')),
 recipient_id integer,
 fee_kind text not null check(fee_kind in('station','platform','loading')),
 stream text not null check(stream in('rider','driver')),
 amount_pesewas integer not null check(amount_pesewas>0),
 reference text,
 recorded_by integer not null references users(id),
 created_at text not null
);
create index fee_settlement_entries_day on fee_settlement_entries(settlement_date,payer_type,payer_id);
create trigger fee_settlement_entries_no_update before update on fee_settlement_entries
 begin select raise(abort,'fee settlement entries are append-only'); end;
create trigger fee_settlement_entries_no_delete before delete on fee_settlement_entries
 begin select raise(abort,'fee settlement entries are append-only'); end;

drop table legacy_station_scope;
