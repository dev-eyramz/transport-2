create table invitation_otp_rate_limits(
 bucket text not null,
 subject_hash text not null,
 window_start integer not null,
 hit_count integer not null check(hit_count>0),
 expires_at integer not null,
 primary key(bucket,subject_hash,window_start)
);
create index invitation_otp_rate_limits_expiry on invitation_otp_rate_limits(expires_at);
