const D=require('better-sqlite3'),fs=require('fs'),os=require('os'),path=require('path');
const{PostgresDatabase,createSchemaTemplate,ensureSchema,quoteId,quoteValue}=require('./postgres');
const appTables=db=>db.query("select table_name from information_schema.tables where table_schema=current_schema() and table_type='BASE TABLE' and table_name not in('_transport_schema_version')").map(row=>row.table_name);
const assertEmpty=async(db,tables)=>{
 for(const table of tables){
  if(table==='schema_migrations')continue;
  const rows=db.query(`select exists(select 1 from ${quoteId(table)} limit 1) present`)[0];
  if(rows.present)throw new Error(`PostgreSQL table ${table} already contains data; refusing to merge or overwrite it.`);
 }
};
async function copySQLiteToPostgres(sourcePath,url=process.env.DATABASE_URL,{schema=process.env.POSTGRES_SCHEMA||'public'}={}){
 if(!sourcePath)throw new Error('Provide --source <sqlite-file> to copy the SQLite database.');
 if(!url)throw new Error('DATABASE_URL is required for the PostgreSQL destination.');
 const source=path.resolve(sourcePath);
 if(!fs.existsSync(source)||!fs.statSync(source).isFile())throw new Error(`SQLite source file does not exist: ${source}`);
 const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'transport-pg-copy-')),snapshot=path.join(tempDir,'source.sqlite');
 let readonly,working,postgres;
 try{
  readonly=new D(source,{readonly:true,fileMustExist:true});
  await readonly.backup(snapshot);
  readonly.close();readonly=null;
  working=new D(snapshot);require('./migrate')(working);
  const template=createSchemaTemplate();
  postgres=new PostgresDatabase(url,{schema});
  ensureSchema(postgres,template,{seed:false});
  await assertEmpty(postgres,appTables(postgres));
  const tables=working.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all().map(row=>row.name);
  postgres.query('BEGIN');
  try{
   postgres.query('SET CONSTRAINTS ALL DEFERRED');
   for(const table of tables){
    const columns=working.prepare(`pragma table_info(${quoteId(table)})`).all().map(row=>row.name);
    if(!columns.length)continue;
    const rows=working.prepare(`select * from ${quoteId(table)}`).all();
    if(!rows.length)continue;
    const columnSql=columns.map(quoteId).join(', ');
    const placeholders=columns.map((_,index)=>'$'+(index+1)).join(', ');
    const insert=`insert into ${quoteId(table)} (${columnSql}) values (${placeholders})`;
    for(const row of rows)postgres.query(insert,columns.map(column=>quoteValue(row[column])));
   }
   for(const table of tables){
    const count=working.prepare(`select count(*) n from ${quoteId(table)}`).get().n;
    const copied=postgres.query(`select count(*) n from ${quoteId(table)}`)[0].n;
    if(count!==copied)throw new Error(`Row count mismatch for ${table}: SQLite ${count}, PostgreSQL ${copied}`);
   }
   for(const table of template.tables.filter(item=>item.columns.some(column=>column.name==='id'&&column.pk===1))){
    const sequence=postgres.query('select pg_get_serial_sequence($1,$2) sequence',[`${schema}.${table.name}`,'id'])[0].sequence;
    if(sequence)postgres.query(`select setval($1,coalesce((select max(id) from ${quoteId(table.name)}),1),exists(select 1 from ${quoteId(table.name)}))`,[sequence]);
   }
   postgres.query('COMMIT')
  }catch(error){try{postgres.query('ROLLBACK')}catch(rollbackError){error.rollbackError=rollbackError}throw error}
  return{source,tables:tables.length,rows:tables.reduce((sum,table)=>sum+working.prepare(`select count(*) n from ${quoteId(table)}`).get().n,0),schemaHash:template.hash}
 }finally{
  working?.close();readonly?.close();postgres?.close();
  for(const name of['source.sqlite','source.sqlite-wal','source.sqlite-shm'])fs.rmSync(path.join(tempDir,name),{force:true});
  fs.rmdirSync(tempDir)
 }
}
if(require.main===module){
 const args=process.argv.slice(2),sourceIndex=args.indexOf('--source');
 const source=sourceIndex>=0?args[sourceIndex+1]:null;
 copySQLiteToPostgres(source).then(result=>console.log(`SQLite copy verified: ${result.rows} rows across ${result.tables} tables (${result.source})`)).catch(error=>{console.error('PostgreSQL copy failed:',error.message);process.exitCode=1})
}
module.exports={copySQLiteToPostgres};
