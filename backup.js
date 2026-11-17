// Online SQLite backup + verified restore. CLI: node backup.js backup | node backup.js restore <file>
const fs=require('fs'),path=require('path'),D=require('better-sqlite3');
const check=f=>{const c=new D(f,{readonly:true});try{return c.pragma('integrity_check',{simple:true})=='ok'&&c.prepare("select count(*) n from sqlite_master where name='users'").get().n==1}finally{c.close()}};
async function backup(db,dir,keep=28){fs.mkdirSync(dir,{recursive:true});const f=path.join(dir,'transport-'+new Date().toISOString().replace(/[:.]/g,'-')+'.db');await db.backup(f);
 if(!check(f)){fs.unlinkSync(f);throw new Error('backup failed verification')}
 fs.readdirSync(dir).filter(x=>x.endsWith('.db')).sort().slice(0,-keep).forEach(x=>fs.unlinkSync(path.join(dir,x)));return f}
function restore(src,dest){if(!check(src))throw new Error('Backup file is corrupt or not a transport DB');
 if(fs.existsSync(dest))fs.copyFileSync(dest,dest+'.pre-restore-'+Date.now());for(const s of['-wal','-shm'])fs.rmSync(dest+s,{force:true});fs.copyFileSync(src,dest);
 const d=new D(dest);require('./migrate')(d);const n=d.prepare('select count(*) n from users').get().n;d.close();return n}
module.exports={backup,restore,check};
if(require.main===module){const[,,cmd,file]=process.argv,dbp=process.env.DB||'transport.db',dir=path.resolve(process.env.BACKUP_DIR||'backups');
 if(cmd=='backup'){const d=new D(dbp);backup(d,dir,+process.env.BACKUP_KEEP||28).then(f=>{console.log('Backup OK',f);d.close()})}
 else if(cmd=='restore'&&file)console.log('Restore OK, users:',restore(file,dbp),'(STOP the app first; restore uploads/ separately)');else console.log('usage: node backup.js backup | restore <file>')}
