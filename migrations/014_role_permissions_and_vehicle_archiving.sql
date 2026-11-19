alter table vehicles add column deleted_at text;
create index vehicles_active_driver on vehicles(driver_id,deleted_at);

create table role_permissions(
 role text not null,
 permission text not null,
 primary key(role,permission)
);

insert into role_permissions(role,permission) values
 ('manager','users.read'),
 ('manager','users.create'),
 ('manager','users.update'),
 ('manager','users.deactivate'),
 ('manager','vehicles.read'),
 ('manager','vehicles.create'),
 ('manager','vehicles.update'),
 ('manager','vehicles.deactivate'),
 ('accountant','users.read'),
 ('accountant','vehicles.read'),
 ('driver','vehicles.read'),
 ('driver','vehicles.create'),
 ('driver','vehicles.update'),
 ('driver','vehicles.deactivate');
