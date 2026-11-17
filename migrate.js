// Versioned SQL migrations: migrations/NNN_name.sql applied once, in order, each in a transaction.
const fs=require('fs'),path=require('path');
module.exports=db=>{db.exec('create table if not exists schema_migrations(id text primary key,at text)');
 const dir=path.join(__dirname,'migrations'),done=new Set(db.prepare('select id from schema_migrations').all().map(r=>r.id)),has=t=>db.prepare('select 1 x from sqlite_master where name=?').get(t),ins=db.prepare('insert into schema_migrations values(?,?)');
 if(!done.size&&has('stations')){['001_baseline.sql',...(has('docs')?['002_v12.sql']:[])].forEach(f=>{ins.run(f,'adopted');done.add(f)})} // adopt pre-migration databases
 for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())if(!done.has(f))db.transaction(()=>{db.exec(fs.readFileSync(path.join(dir,f),'utf8'));ins.run(f,new Date().toISOString())})()};
