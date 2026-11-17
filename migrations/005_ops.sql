alter table docs add column expires_on text;
alter table docs add column expiry_level int default 0;
alter table users add column whatsapp_optin int default 0;
