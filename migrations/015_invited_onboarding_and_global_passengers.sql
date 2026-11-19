alter table stations add column latitude real;
alter table stations add column longitude real;
alter table routes add column published integer not null default 1 check(published in(0,1));
alter table users add column ghana_card_verified integer not null default 0;
alter table users add column ghana_card_verified_at text;

create table system_provider_settings(
 key text primary key,
 value text not null,
 encrypted integer not null default 0 check(encrypted in(0,1))
);

create table onboarding_invitations(
 id integer primary key,
 token_hash text not null unique,
 role text not null check(role in('driver','porter')),
 tenant_id integer not null references tenants(id),
 station_id integer not null references stations(id),
 organization_id integer references organizations(id),
 created_by integer not null references users(id),
 created_at text not null,
 expires_at text not null,
 revoked_at text,
 applicant_phone text,
 submitted_at text
);
create index onboarding_invitations_scope on onboarding_invitations(tenant_id,organization_id,station_id,expires_at);

create table onboarding_applications(
 id integer primary key,
 invitation_id integer not null unique references onboarding_invitations(id),
 name text not null,
 phone text not null,
 form_json text not null,
 status text not null default 'pending_review' check(status in('pending_review','needs_changes','approved','rejected')),
 review_comment text,
 reviewed_by integer references users(id),
 user_id integer references users(id),
 submitted_at text not null,
 updated_at text not null
);
create index onboarding_applications_status on onboarding_applications(status,submitted_at);

create table onboarding_application_documents(
 id integer primary key,
 application_id integer not null references onboarding_applications(id) on delete cascade,
 kind text not null check(kind in('licence','vehicle_registration','insurance')),
 filename text not null,
 path text not null,
 expires_on text,
 uploaded_at text not null,
 unique(application_id,kind)
);

create table onboarding_review_history(
 id integer primary key,
 application_id integer not null references onboarding_applications(id),
 status text not null check(status in('pending_review','needs_changes','approved','rejected')),
 comment text not null default '',
 reviewer_id integer references users(id),
 created_at text not null
);

insert into role_permissions(role,permission) values
 ('manager','onboarding.invite'),
 ('manager','onboarding.read'),
 ('manager','onboarding.review'),
 ('manager','routes.publish');

delete from role_permissions where role='manager' and permission='users.create';
