create table ledger_accounts(
 id integer primary key,
 code text not null unique,
 name text not null,
 account_type text not null check(account_type in('asset','liability','revenue','expense')),
 active integer not null default 1 check(active in(0,1))
);

insert into ledger_accounts(code,name,account_type) values
 ('1000','Payment provider clearing','asset'),
 ('1010','Cash and manual settlements','asset'),
 ('1100','Driver fee receivable','asset'),
 ('2000','Driver payable','liability'),
 ('2990','Unallocated receipts','liability'),
 ('4000','Platform fee revenue','revenue'),
 ('4100','Tenant fee revenue','revenue'),
 ('4200','Organization fee revenue','revenue'),
 ('6100','Fee waivers','expense'),
 ('6200','Operating expenses','expense');

create table ledger_transactions(
 id integer primary key,
 source_type text not null,
 source_id text not null,
 tenant_id integer references tenants(id),
 organization_id integer references organizations(id),
 station_id integer references stations(id),
 effective_at text not null,
 memo text not null,
 reference text,
 created_by integer references users(id),
 created_at text not null,
 unique(source_type,source_id)
);
create index ledger_transactions_date on ledger_transactions(effective_at,id);
create index ledger_transactions_tenant_date on ledger_transactions(tenant_id,effective_at,id);
create index ledger_transactions_organization_date on ledger_transactions(organization_id,effective_at,id);
create index ledger_transactions_station_date on ledger_transactions(station_id,effective_at,id);

create table ledger_entries(
 id integer primary key,
 transaction_id integer not null references ledger_transactions(id),
 line_number integer not null,
 account_id integer not null references ledger_accounts(id),
 debit_pesewas integer not null default 0 check(debit_pesewas>=0),
 credit_pesewas integer not null default 0 check(credit_pesewas>=0),
 check((debit_pesewas>0 and credit_pesewas=0) or (credit_pesewas>0 and debit_pesewas=0)),
 unique(transaction_id,line_number)
);
create index ledger_entries_account_transaction on ledger_entries(account_id,transaction_id);

create trigger ledger_transactions_no_update before update on ledger_transactions
 begin select raise(abort,'ledger transactions are append-only'); end;
create trigger ledger_transactions_no_delete before delete on ledger_transactions
 begin select raise(abort,'ledger transactions are append-only'); end;
create trigger ledger_entries_no_update before update on ledger_entries
 begin select raise(abort,'ledger entries are append-only'); end;
create trigger ledger_entries_no_delete before delete on ledger_entries
 begin select raise(abort,'ledger entries are append-only'); end;

insert into role_permissions(role,permission) values
 ('accountant','accounting.read'),
 ('accountant','accounting.expense');
