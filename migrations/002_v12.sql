create table config(scope text,key text,value text,primary key(scope,key));
create table docs(id integer primary key,owner_id int,vehicle_id int,kind text,filename text,path text,status text default 'Pending',reviewed_by int,note text,at text);
create table idem(user_id int,key text,booking_id int,primary key(user_id,key));
alter table vehicles add column docs_ok int default 0;
alter table drivers add column station_id int;
alter table trips add column exclusive_for int;
alter table excl add column trip_id int;
alter table audit add column station_id int;
