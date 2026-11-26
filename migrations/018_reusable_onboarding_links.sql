create table onboarding_invitation_links(
 id integer primary key,
 token_hash text not null unique,
 token_encrypted text not null,
 role text not null check(role in('driver','porter')),
 tenant_id integer not null references tenants(id),
 station_id integer not null references stations(id),
 organization_id integer references organizations(id),
 created_by integer not null references users(id),
 created_at text not null,
 expires_at text not null,
 revoked_at text,
 use_mode text not null check(use_mode in('single','multiple')),
 use_count integer not null default 0 check(use_count>=0)
);
create index onboarding_invitation_links_scope on onboarding_invitation_links(tenant_id,organization_id,station_id,expires_at);

alter table onboarding_invitations add column link_id integer references onboarding_invitation_links(id);
create unique index onboarding_invitations_link_applicant on onboarding_invitations(link_id,applicant_phone);
