create table tenant_provider_settings(
 tenant_id integer not null references tenants(id) on delete cascade,
 key text not null,
 value text not null,
 encrypted integer not null default 0 check(encrypted in(0,1)),
 primary key(tenant_id,key)
);

alter table notifications add column tenant_id integer references tenants(id) on delete set null;
