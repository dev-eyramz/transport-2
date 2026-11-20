// Online SQLite backup + verified restore. CLI: node backup.js backup | node backup.js restore <file>
const fs=require('fs'),path=require('path'),D=require('better-sqlite3'),{execFile}=require('child_process'),{promisify}=require('util');
const execFileAsync=promisify(execFile);
const check=f=>{const c=new D(f,{readonly:true});try{return c.pragma('integrity_check',{simple:true})=='ok'&&c.prepare("select count(*) n from sqlite_master where name='users'").get().n==1}finally{c.close()}};
async function backup(db,dir,keep=28){fs.mkdirSync(dir,{recursive:true});const f=path.join(dir,'transport-'+new Date().toISOString().replace(/[:.]/g,'-')+'.db');await db.backup(f);
 if(!check(f)){fs.unlinkSync(f);throw new Error('backup failed verification')}
 fs.readdirSync(dir).filter(x=>x.endsWith('.db')).sort().slice(0,-keep).forEach(x=>fs.unlinkSync(path.join(dir,x)));return f}
const postgresEnvironment=(url,schema)=>{
 const parsed=new URL(url);
 if(!['postgres:','postgresql:'].includes(parsed.protocol))throw new Error('DATABASE_URL must use the postgres:// or postgresql:// scheme');
 if(schema&&!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema))throw new Error('POSTGRES_SCHEMA must be a PostgreSQL identifier');
 const env={...process.env,PGHOST:parsed.hostname,PGPORT:parsed.port||'5432',PGDATABASE:decodeURIComponent(parsed.pathname.slice(1)),PGUSER:decodeURIComponent(parsed.username),PGPASSWORD:decodeURIComponent(parsed.password)};
 const libpqOptions={sslmode:'PGSSLMODE',sslrootcert:'PGSSLROOTCERT',sslcert:'PGSSLCERT',sslkey:'PGSSLKEY',connect_timeout:'PGCONNECT_TIMEOUT',application_name:'PGAPPNAME',target_session_attrs:'PGTARGETSESSIONATTRS',gssencmode:'PGGSSENCMODE'};
 for(const[key,name]of Object.entries(libpqOptions)){const value=parsed.searchParams.get(key);if(value)env[name]=value}
 if(schema)env.PGOPTIONS=`-c search_path=${schema}`;
 return env
};
async function backupPostgres(dir,keep=28){
 const schema=process.env.POSTGRES_SCHEMA||'public',url=process.env.DATABASE_URL;
 fs.mkdirSync(dir,{recursive:true});
 const f=path.join(dir,'transport-'+new Date().toISOString().replace(/[:.]/g,'-')+'.dump'),env=postgresEnvironment(url,schema);
 try{
  await execFileAsync('pg_dump',['--no-owner','--no-privileges','--schema',schema,'--format=custom','--file',f],{env,maxBuffer:1024*1024});
  const{stdout}=await execFileAsync('pg_restore',['--list',f],{env,maxBuffer:1024*1024});
  if(!stdout.includes(`TABLE ${schema} users`))throw new Error('PostgreSQL backup verification did not find the users table')
 }catch(error){fs.rmSync(f,{force:true});throw new Error(`PostgreSQL backup failed: ${error.message}`)}
 fs.readdirSync(dir).filter(x=>x.endsWith('.dump')).sort().slice(0,-keep).forEach(x=>fs.unlinkSync(path.join(dir,x)));
 return f
}
function restore(src,dest){if(!check(src))throw new Error('Backup file is corrupt or not a transport DB');
 if(fs.existsSync(dest))fs.copyFileSync(dest,dest+'.pre-restore-'+Date.now());for(const s of['-wal','-shm'])fs.rmSync(dest+s,{force:true});fs.copyFileSync(src,dest);
 const d=new D(dest);require('./migrate')(d);const n=d.prepare('select count(*) n from users').get().n;d.close();return n}
module.exports={backup,backupPostgres,restore,check};
if(require.main===module){const[,,cmd,file]=process.argv,dbp=process.env.DB||'transport.db',dir=path.resolve(process.env.BACKUP_DIR||'backups');
 if(cmd=='backup'){
  if(process.env.DB_BACKEND==='postgres')backupPostgres(dir,+process.env.BACKUP_KEEP||28).then(f=>console.log('Backup OK',f)).catch(error=>{console.error(error.message);process.exitCode=1});
  else{const d=new D(dbp);backup(d,dir,+process.env.BACKUP_KEEP||28).then(f=>{console.log('Backup OK',f);d.close()},error=>{d.close();console.error(error.message);process.exitCode=1})}
 }
 else if(cmd=='restore'&&file&&process.env.DB_BACKEND!=='postgres')console.log('Restore OK, users:',restore(file,dbp),'(STOP the app first; restore uploads/ separately)');
 else if(cmd=='restore'&&process.env.DB_BACKEND==='postgres'){console.error('PostgreSQL restore is intentionally not automated; verify the dump and use pg_restore against the configured schema.');process.exitCode=1}
 else console.log('usage: node backup.js backup | restore <file>')}
