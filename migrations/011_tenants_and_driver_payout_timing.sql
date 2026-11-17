create table tenants(
 id integer primary key,
 name text not null unique,
 created_at text not null default current_timestamp
);

insert into tenants(name)
 select s.name || ' #' || s.id from stations s
 where exists(select 1 from stations x where x.name=s.name and x.id<s.id);
insert into tenants(name)
 select s.name from stations s
 where not exists(select 1 from stations x where x.name=s.name and x.id<s.id);

alter table stations add column tenant_id integer references tenants(id);
update stations set tenant_id=(
 select id from tenants where tenants.name=case
  when exists(select 1 from stations x where x.name=stations.name and x.id<stations.id) then stations.name || ' #' || stations.id
  else stations.name end
);

alter table users add column tenant_id integer references tenants(id);
update users set tenant_id=(select tenant_id from stations where stations.id=users.station_id)
 where station_id is not null;

alter table drivers add column tenant_id integer references tenants(id);
alter table drivers add column payout_gate text;
alter table drivers add column payout_gate_override text;
update drivers set tenant_id=(select tenant_id from stations where stations.id=drivers.station_id)
 where station_id is not null;
update users set tenant_id=(select tenant_id from drivers where drivers.user_id=users.id)
 where role='driver' and exists(select 1 from drivers where drivers.user_id=users.id);

alter table audit add column tenant_id integer references tenants(id);
update audit set tenant_id=coalesce(
 (select tenant_id from users where users.id=audit.actor),
 (select tenant_id from stations where stations.id=audit.station_id)
);

alter table routes add column tenant_id integer references tenants(id);
update routes set tenant_id=(select tenant_id from stations where stations.id=routes.origin_id);
create unique index routes_tenant_origin_dest on routes(tenant_id,origin_id,dest_id);

create index stations_tenant on stations(tenant_id,id);
create index routes_tenant on routes(tenant_id,id);
create index users_tenant on users(tenant_id,role);
create index drivers_tenant on drivers(tenant_id,station_id);
create index audit_tenant on audit(tenant_id,id);
