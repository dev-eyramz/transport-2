// Community Transport Reservation & Dispatch - Node + Express + SQLite (modular single file)
const express=require('express'),D=require('better-sqlite3'),cr=require('crypto'),QRCode=require('qrcode');
const { createPaymentProvider, normalizeMsisdn, isSupportedPayPartner } = require('./payment');
const { riderCharges, driverDeductions, percentageCharge, totalDue } = require('./fees');
const PROD=process.env.NODE_ENV=='production',gw=require('./gateway'),SECRET=process.env.APP_SECRET;
if(!SECRET||SECRET.length<32)throw new Error('APP_SECRET must be set to a random value of at least 32 characters');
const DB_BACKEND=String(process.env.DB_BACKEND||'sqlite').toLowerCase();
let db;
if(DB_BACKEND==='sqlite'){
 db=new D(process.env.DB||'transport.db');db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.pragma('busy_timeout=5000');db.pragma('foreign_keys=ON');
}else if(DB_BACKEND==='postgres'){
 const{PostgresDatabase,ensureSchema}=require('./postgres');
 db=new PostgresDatabase(process.env.DATABASE_URL,{schema:process.env.POSTGRES_SCHEMA||'public'});ensureSchema(db)
}else throw new Error('DB_BACKEND must be either sqlite or postgres');
const DUR=+process.env.TRIP_MIN||60,CUTOFF=+process.env.CUTOFF_MIN||30,SURGE_SEATS=+process.env.SURGE_SEATS||4,SURGE_WAIT=+process.env.SURGE_WAIT||30,SESSION_IDLE_TIMEOUT_MS=2*60*1000;
if(DB_BACKEND==='sqlite')require('./migrate')(db);
const q=(s,...a)=>db.prepare(s).all(...a),one=(s,...a)=>db.prepare(s).get(...a),run=(s,...a)=>db.prepare(s).run(...a);
const TENANT_SETTING_KEYS=[
 'PAYMENT_PROVIDER','EGANOW_BASE_URL','EGANOW_API_USERNAME','EGANOW_API_PASSWORD','EGANOW_X_AUTH','EGANOW_CALLBACK_URL',
 'SMS_PROVIDER','TWILIO_SID','TWILIO_TOKEN','TWILIO_FROM','TWILIO_API_BASE_URL','NOTIFY_CHANNEL','WEBHOOK_KEY','TWILIO_FROM_WA',
 'TWILIO_WA_TEMPLATE_SID','SMS_URL','SMS_AUTH','SMS_FROM','EMAIL_PROVIDER','SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','SMTP_FROM'
],TENANT_SECRET_KEYS=new Set(['EGANOW_API_PASSWORD','EGANOW_X_AUTH','TWILIO_TOKEN','WEBHOOK_KEY','SMS_AUTH','SMTP_PASSWORD']);
const settingsKey=cr.hkdfSync('sha256',Buffer.from(SECRET),'platform-settings','v1',32);
const encryptSetting=value=>{const iv=cr.randomBytes(12),cipher=cr.createCipheriv('aes-256-gcm',settingsKey,iv),data=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);return['v1',iv.toString('hex'),cipher.getAuthTag().toString('hex'),data.toString('hex')].join(':')};
const decryptSetting=value=>{const[version,iv,tag,data]=String(value).split(':');if(version!='v1'||!iv||!tag||!data)throw new Error('Invalid encrypted platform setting');const decipher=cr.createDecipheriv('aes-256-gcm',settingsKey,Buffer.from(iv,'hex'));decipher.setAuthTag(Buffer.from(tag,'hex'));return Buffer.concat([decipher.update(Buffer.from(data,'hex')),decipher.final()]).toString('utf8')};
let paymentProviderOverride=null;
const tenantProviderSettings=tenantId=>Object.fromEntries(q('select key,value,encrypted from tenant_provider_settings where tenant_id=?',tenantId).map(row=>[row.key,row.encrypted?decryptSetting(row.value):row.value]));
const SYSTEM_SECRET_KEYS=new Set(['SMS_AUTH','TWILIO_TOKEN','IDENTITY_API_TOKEN']);
const SYSTEM_PROVIDER_KEYS=['SMS_PROVIDER','SMS_URL','SMS_AUTH','SMS_FROM','TWILIO_SID','TWILIO_TOKEN','TWILIO_FROM','TWILIO_API_BASE_URL','IDENTITY_VERIFY_URL','IDENTITY_API_TOKEN'];
const systemProviderSettings=()=>Object.fromEntries(q('select key,value,encrypted from system_provider_settings').map(row=>[row.key,row.encrypted?decryptSetting(row.value):row.value]));
const authSmsSettings=()=>{const settings=systemProviderSettings();return Object.fromEntries(SYSTEM_PROVIDER_KEYS.filter(k=>k.startsWith('SMS_')||k.startsWith('TWILIO_')).map(k=>[k,settings[k]||'']))};
const passengerSignupVerificationRequired=()=>String(process.env.PASSENGER_SIGNUP_VERIFICATION||'required').trim().toLowerCase()!=='disabled';
const configuredAppBaseUrl=String(process.env.APP_BASE_URL||'').trim(),isLoopbackBaseUrl=value=>{const hostname=new URL(value).hostname;return hostname=='localhost'||hostname=='[::1]'||hostname=='::1'||/^127\./.test(hostname)||hostname=='0.0.0.0'},renderBaseUrl=String(process.env.RENDER_EXTERNAL_URL||'').trim(),railwayDomain=String(process.env.RAILWAY_PUBLIC_DOMAIN||'').trim(),railwayBaseUrl=railwayDomain?(/^https?:\/\//i.test(railwayDomain)?railwayDomain:`https://${railwayDomain}`):'',configuredPublicBaseUrl=configuredAppBaseUrl&&!isLoopbackBaseUrl(configuredAppBaseUrl)?configuredAppBaseUrl:'';
const PUBLIC_BASE_URL=(configuredPublicBaseUrl||renderBaseUrl||railwayBaseUrl).trim().replace(/\/+$/,'');
const publicBaseUrl=PUBLIC_BASE_URL?new URL(PUBLIC_BASE_URL):null;
if(publicBaseUrl&&(publicBaseUrl.search||publicBaseUrl.hash||PROD&&publicBaseUrl.protocol!='https:'))throw new Error('APP_BASE_URL must be a base HTTPS URL in production');
const invitationBaseUrl=req=>publicBaseUrl||(!PROD&&req.get('host')?new URL(`${req.protocol}://${req.get('host')}`):null);
const tenantProviderEnv=tenantId=>({
 ...tenantProviderSettings(tenantId),
 EGANOW_DEFAULT_COUNTRY_CODE:process.env.EGANOW_DEFAULT_COUNTRY_CODE||'GH0233',
 EGANOW_DEFAULT_LANGUAGE:process.env.EGANOW_DEFAULT_LANGUAGE||'en',
 EGANOW_MOMO_PARTNERS:process.env.EGANOW_MOMO_PARTNERS||'MTNGH,ATGH,TCELGH'
});
const tenantPaymentProvider=tenantId=>{
 if(!tenantId||!one('select 1 x from tenants where id=?',tenantId))E(503,'This route has no tenant provider configuration.');
 const settings=tenantProviderSettings(tenantId);
 if(process.env.NODE_ENV=='test'){
  const provider=paymentProviderOverride||paymentProvider;
  if(typeof provider.getApiUsername=='function'&&(!provider.getApiUsername()||!provider.getApiPassword()))E(503,'Payment provider credentials are not configured for this tenant.');
  return provider
 }
 if(settings.PAYMENT_PROVIDER!='eganow'||!settings.EGANOW_API_USERNAME||!settings.EGANOW_API_PASSWORD)E(503,'Payment provider credentials are not configured for this tenant.');
 return createPaymentProvider('eganow',{config:tenantProviderEnv(tenantId)});
};
const E=(s,m)=>{throw Object.assign(new Error(m),{s})},now=()=>new Date().toISOString().slice(0,16),mins=t=>{const[a,b]=t.split(':');return+a*60+ +b};
const validDate=d=>typeof d=='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)==d;
const validTime=t=>typeof t=='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const validDateTime=(d,t)=>validDate(d)&&validTime(t);
const hhmm=m=>{m=Math.min(m,1439);return String(m/60|0).padStart(2,'0')+':'+String(m%60).padStart(2,'0')};
const stationCode=name=>{const initials=String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').split(/[^A-Za-z0-9]+/).filter(Boolean).map(x=>x[0]).join('').slice(0,4).toUpperCase()||'ST';return initials+'-'+cr.randomBytes(4).toString('hex').toUpperCase()};
const audit=(u,a,e,id,m)=>{const actor=one('select station_id,tenant_id,organization_id from users where id=?',u)||{},driver=one('select station_id,tenant_id,organization_id from drivers where user_id=?',u)||{},stationId=actor.station_id||driver.station_id||null;run('insert into audit(actor,action,entity,eid,meta,at,station_id,tenant_id,organization_id) values(?,?,?,?,?,?,?,?,?)',u,a,e,id,JSON.stringify(m||{}),new Date().toISOString(),stationId,actor.tenant_id||driver.tenant_id||tenantForStation(stationId),actor.organization_id||driver.organization_id||null)};
const tenantForNotification=userId=>one('select coalesce(u.tenant_id,d.tenant_id) tenant_id from users u left join drivers d on d.user_id=u.id where u.id=?',userId)?.tenant_id||null;
const tenantForRoute=routeId=>one('select tenant_id from routes where id=?',routeId)?.tenant_id||null;
const notify=(u,ev,msg,tenantId=null)=>{const scope=tenantId||tenantForNotification(u);run('insert into notifications(user_id,event,msg,at,tenant_id) values(?,?,?,?,?)',u,ev,msg,now(),scope);push(u,'notify')};
const notifyMgrs=(ev,msg,routeId=null,stationId=null)=>{const owner=routeId?one('select tenant_id,origin_id station_id,organization_id from routes where id=?',routeId):stationId?one('select tenant_id,id station_id,null organization_id from stations where id=?',stationId):null,recipients=owner?q("select id from users where role='admin' or role in('manager','accountant') and ((organization_id=? and organization_id is not null) or (tenant_id=? and tenant_id is not null) or station_id=?)",owner.organization_id,owner.tenant_id,owner.station_id):q("select id from users where role='admin'");recipients.forEach(m=>notify(m.id,ev,msg))};
const setB=(id,st,by,why)=>{const b=one('select status from bookings where id=?',id);run('update bookings set status=? where id=?',st,id);run('insert into history(booking_id,old,new,by,reason,at) values(?,?,?,?,?,?)',id,b.status,st,String(by),why||'',now())};
const cfg=(k,rid,def)=>{const r=one('select r.origin_id,s.tenant_id,r.organization_id from routes r join stations s on s.id=r.origin_id where r.id=?',rid)||{},tenantFee=['station_fee_pct','platform_fee_pct','driver_station_fee_pct','driver_platform_fee_pct'].includes(k),organizationFee=['loading_fee_pct','driver_loading_fee_pct'].includes(k),scopes=['route:'+rid,...(r.tenant_id&&tenantFee?['tenant:'+r.tenant_id,'station:'+r.origin_id]:[]),...(r.organization_id&&organizationFee?['organization:'+r.organization_id]:[]),...(!tenantFee&&!organizationFee?[r.tenant_id?'tenant:'+r.tenant_id:null,'station:'+r.origin_id,r.organization_id?'organization:'+r.organization_id:null].filter(Boolean):[]),'global'];for(const s of scopes){const c=one('select value from config where scope=? and key=?',s,k);if(c){const n=Number(c.value);return c.value.trim()!==''&&Number.isFinite(n)?n:c.value}}return def};
const toPesewas=value=>Math.round(Number(value)*100),ghs=value=>(Number(value||0)/100).toFixed(2),bookingTotal=totalDue;
const DISPATCHABLE=['Paid','Credit','Cash'],DISPATCHABLE_SQL="('"+DISPATCHABLE.join("','")+"')",FEE_CONFIG_KEYS=['station_fee_pct','platform_fee_pct','driver_station_fee_pct','driver_platform_fee_pct','loading_fee_pct','driver_loading_fee_pct'];
const routeFare=routeId=>{const route=one('select origin_id,tenant_id,organization_id from routes where id=?',routeId),fare=cfg('fare_ghs',routeId,null);
 if(!(fare>0))E(409,'This route has no fare configured yet');return{farePesewas:toPesewas(fare),fareGhs:Number(fare),stationId:route?.origin_id,tenantId:route?.tenant_id,organizationId:route?.organization_id}};
const feeShareScope=(kind,route)=>kind=='station'?['tenant',route.tenantId]:kind=='loading'?['organization',route.organizationId]:['global',0];
function feeShares(kind,stream,route){
 const[scopeType,scopeId]=feeShareScope(kind,route),rows=scopeId?q('select payer_type,percentage from fee_share_config where scope_type=? and scope_id=? and fee_kind=? and stream=? order by payer_type',scopeType,scopeId,kind,stream):[];
 const shares=rows.length?rows:q('select payer_type,percentage from fee_share_config where scope_type=? and scope_id=0 and fee_kind=? and stream=? order by payer_type','global',kind,stream);
 if(shares.reduce((sum,row)=>sum+row.percentage,0)!=100)throw new Error(`Invalid ${kind}/${stream} payer percentages`);
 return shares;
}
function snapshotBookingFees(booking,route,entryType='charge'){
 const driver=booking.driver_station_deduction_pesewas||0,fees=[
  ['station','rider',booking.station_fee_pesewas||0],['platform','rider',booking.platform_fee_pesewas||0],['loading','rider',booking.loading_fee_pesewas||0],
  ['station','driver',driver],['platform','driver',booking.driver_platform_deduction_pesewas||0],['loading','driver',booking.driver_loading_deduction_pesewas||0]
 ];
 for(const[kind,stream,amount]of fees){if(!amount)continue;const shares=feeShares(kind,stream,route),recipient=kind=='platform'?['platform',null]:kind=='station'?['tenant',route.tenantId]:['organization',route.organizationId];let assigned=0;
  for(let i=0;i<shares.length;i++){const share=shares[i],part=i==shares.length-1?amount-assigned:Math.floor(amount*share.percentage/100);assigned+=part;if(!part)continue;
   const payerId=share.payer_type=='rider'?booking.passenger_id:share.payer_type=='organization'?route.organization_id:share.payer_type=='tenant'?route.tenant_id:null;
   run('insert into booking_fee_allocations(booking_id,organization_id,origin_tenant_id,fee_kind,stream,payer_type,payer_id,recipient_type,recipient_id,amount_pesewas,payer_percentage,entry_type,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)',booking.id,route.organizationId,route.tenantId,kind,stream,share.payer_type,payerId,recipient[0],recipient[1],entryType=='reversal'?-part:part,share.percentage,entryType,booking.created||now())
  }
 }
}
function reverseBookingFees(booking){q(`select organization_id,origin_tenant_id,fee_kind,stream,payer_type,payer_id,recipient_type,recipient_id,payer_percentage,sum(amount_pesewas) amount
 from booking_fee_allocations where booking_id=? group by organization_id,origin_tenant_id,fee_kind,stream,payer_type,payer_id,recipient_type,recipient_id,payer_percentage having sum(amount_pesewas)<>0`,booking.id).forEach(row=>run('insert into booking_fee_allocations(booking_id,organization_id,origin_tenant_id,fee_kind,stream,payer_type,payer_id,recipient_type,recipient_id,amount_pesewas,payer_percentage,entry_type,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)',booking.id,row.organization_id,row.origin_tenant_id,row.fee_kind,row.stream,row.payer_type,row.payer_id,row.recipient_type,row.recipient_id,-row.amount,row.payer_percentage,'reversal',now()))}
const ledgerAccountCodes={platform:'4000',tenant:'4100',organization:'4200'},ledgerAccountId=code=>{const account=one('select id from ledger_accounts where code=? and active=1',code);if(!account)throw new Error(`Accounting account ${code} is unavailable`);return account.id};
function postLedgerTransaction({sourceType,sourceId,tenantId=null,organizationId=null,stationId=null,effectiveAt=now(),memo,reference=null,createdBy=null,lines}){
 const entries=lines.filter(line=>line.debit||line.credit);
 if(!entries.length)return null;
 if(entries.some(line=>!Number.isSafeInteger(line.debit||0)||!Number.isSafeInteger(line.credit||0)||(line.debit||0)<0||(line.credit||0)<0||!!line.debit==!!line.credit))throw new Error('Invalid accounting journal line');
 const debits=entries.reduce((sum,line)=>sum+line.debit,0),credits=entries.reduce((sum,line)=>sum+line.credit,0);
 if(debits<=0||debits!=credits)throw new Error(`Unbalanced accounting transaction ${sourceType}:${sourceId} (${debits} debit, ${credits} credit)`);
 return db.transaction(()=>{
  const existing=one('select id from ledger_transactions where source_type=? and source_id=?',sourceType,String(sourceId));if(existing)return existing.id;
  const id=run('insert into ledger_transactions(source_type,source_id,tenant_id,organization_id,station_id,effective_at,memo,reference,created_by,created_at) values(?,?,?,?,?,?,?,?,?,?)',sourceType,String(sourceId),tenantId,organizationId,stationId,effectiveAt,String(memo).slice(0,240),reference,createdBy,now()).lastInsertRowid;
  entries.forEach((line,index)=>run('insert into ledger_entries(transaction_id,line_number,account_id,debit_pesewas,credit_pesewas) values(?,?,?,?,?)',id,index+1,ledgerAccountId(line.account),line.debit||0,line.credit||0));
  return id
 })()
}
const ledgerRevenueLines=(bookingId,stream,payerType=null)=>q(`select recipient_type,sum(amount_pesewas) amount from booking_fee_allocations where booking_id=? and stream=? ${payerType?"and payer_type=?":""} group by recipient_type order by recipient_type`,...(payerType?[bookingId,stream,payerType]:[bookingId,stream])).filter(row=>row.amount>0);
function postBookingCollection(paymentId){
 const payment=one("select * from booking_payments where id=? and status='Succeeded'",paymentId);if(!payment)return null;
 const booking=one('select b.*,r.tenant_id,r.organization_id,r.origin_id station_id from bookings b join routes r on r.id=b.route_id where b.id=?',payment.booking_id);if(!booking)throw new Error(`Booking ${payment.booking_id} for payment ${payment.id} is missing`);
 const paidBefore=one("select coalesce(sum(amount_pesewas),0) amount from booking_payments where booking_id=? and status='Succeeded' and id<?",booking.id,payment.id).amount,total=bookingTotal(booking),before=Math.min(total,paidBefore),after=Math.min(total,paidBefore+payment.amount_pesewas),fareCredit=Math.max(0,Math.min(after,booking.fare_pesewas)-Math.min(before,booking.fare_pesewas)),feeStart=Math.max(0,before-booking.fare_pesewas),feeEnd=Math.max(0,after-booking.fare_pesewas),feeRows=ledgerRevenueLines(booking.id,'rider'),lines=[{account:'1000',debit:payment.amount_pesewas,credit:0}];
 if(fareCredit)lines.push({account:'2000',debit:0,credit:fareCredit});
 let cursor=0,feeCredit=0;
 for(const row of feeRows){const end=cursor+row.amount,amount=Math.max(0,Math.min(feeEnd,end)-Math.max(feeStart,cursor));cursor=end;if(amount){lines.push({account:ledgerAccountCodes[row.recipient_type],debit:0,credit:amount});feeCredit+=amount}}
 const suspense=payment.amount_pesewas-fareCredit-feeCredit;if(suspense>0)lines.push({account:'2990',debit:0,credit:suspense});
 return postLedgerTransaction({sourceType:'booking_payment',sourceId:payment.id,tenantId:booking.tenant_id,organizationId:booking.organization_id,stationId:booking.station_id,effectiveAt:payment.updated_at,memo:`Passenger collection for ${booking.ref}`,reference:payment.transaction_id,lines})
}
function postDriverPayout(payoutId){
 const payout=one("select p.*,b.fare_pesewas,b.ref,r.tenant_id,r.organization_id,r.origin_id station_id from driver_payouts p join bookings b on b.id=p.booking_id join routes r on r.id=b.route_id where p.id=? and p.status='Succeeded'",payoutId);if(!payout)return null;
 if(payout.amount_pesewas>payout.fare_pesewas)throw new Error(`Driver payout ${payout.id} exceeds booking fare`);
 const deduction=payout.fare_pesewas-payout.amount_pesewas,feeRows=ledgerRevenueLines(payout.booking_id,'driver','driver'),lines=[{account:'2000',debit:payout.fare_pesewas,credit:0},{account:'1000',debit:0,credit:payout.amount_pesewas}];
 let cursor=0,revenueCredit=0;
 for(const row of feeRows){const amount=Math.max(0,Math.min(deduction,cursor+row.amount)-cursor);cursor+=row.amount;if(amount){lines.push({account:ledgerAccountCodes[row.recipient_type],debit:0,credit:amount});revenueCredit+=amount}}
 const suspense=deduction-revenueCredit;if(suspense>0)lines.push({account:'2990',debit:0,credit:suspense});
 return postLedgerTransaction({sourceType:'driver_payout',sourceId:payout.id,tenantId:payout.tenant_id,organizationId:payout.organization_id,stationId:payout.station_id,effectiveAt:payout.updated_at,memo:`Driver payout for ${payout.ref}`,reference:payout.transaction_id,lines})
}
function postCashFeeReceivable(receivableId){
 const row=one('select r.*,b.ref,b.route_id,b.organization_id,s.tenant_id booking_tenant from fee_receivables r join bookings b on b.id=r.booking_id join stations s on s.id=r.station_id where r.id=?',receivableId);if(!row)return null;
 const amount=row.station_pesewas+row.platform_pesewas+row.loading_pesewas;if(!amount)return null;
 const feeRows=q(`select recipient_type,sum(amount_pesewas) amount from booking_fee_allocations where booking_id=? and payer_type in('rider','driver') group by recipient_type order by recipient_type`,row.booking_id).filter(item=>item.amount>0),lines=[{account:'1100',debit:amount,credit:0}];let credited=0;
 for(const fee of feeRows){const part=Math.min(fee.amount,amount-credited);if(part>0){lines.push({account:ledgerAccountCodes[fee.recipient_type],debit:0,credit:part});credited+=part}}
 if(credited<amount)lines.push({account:'2990',debit:0,credit:amount-credited});
 return postLedgerTransaction({sourceType:'cash_fee_receivable',sourceId:row.id,tenantId:row.booking_tenant,organizationId:row.organization_id,stationId:row.station_id,effectiveAt:row.created_at,memo:`Cash-trip fee receivable for ${row.ref}`,lines})
}
function postFeeCollection(collectionId){
 const row=one("select c.*,d.station_id,d.tenant_id,d.organization_id from fee_collections c join drivers d on d.user_id=c.driver_id where c.id=? and c.status='Succeeded'",collectionId);if(!row)return null;
 return postLedgerTransaction({sourceType:'fee_collection',sourceId:row.id,tenantId:row.tenant_id||tenantForStation(row.station_id),organizationId:row.organization_id,stationId:row.station_id,effectiveAt:row.updated_at,memo:'Driver fee collection',reference:row.transaction_id,lines:[{account:'1000',debit:row.amount_pesewas,credit:0},{account:'1100',debit:0,credit:row.amount_pesewas}]})
}
function postFeeAdjustment(allocationId){
 const row=one(`select a.*,r.booking_id,r.station_id,b.ref,b.organization_id,s.tenant_id from fee_allocations a join fee_receivables r on r.id=a.receivable_id join bookings b on b.id=r.booking_id join stations s on s.id=r.station_id where a.id=? and a.kind in('waiver','manual_settlement')`,allocationId);if(!row)return null;
 const waiver=row.kind=='waiver';
 return postLedgerTransaction({sourceType:'fee_adjustment',sourceId:row.id,tenantId:row.tenant_id,organizationId:row.organization_id,stationId:row.station_id,effectiveAt:row.created_at,memo:`${waiver?'Fee waiver':'Manual fee settlement'} for ${row.ref}`,createdBy:row.approved_by||row.recorded_by,lines:[{account:waiver?'6100':'1010',debit:row.amount_pesewas,credit:0},{account:'1100',debit:0,credit:row.amount_pesewas}]})
}
const hashPin=p=>{const s=cr.randomBytes(8).toString('hex');return s+':'+cr.scryptSync(String(p),s,32).toString('hex')};
const okPin=(p,h)=>{if(!h||!p)return false;const[s,x]=h.split(':');return cr.timingSafeEqual(Buffer.from(x,'hex'),cr.scryptSync(String(p),s,32))};
if(!one("select 1 x from users where role='admin'")){
 const ph=process.env.SEED_ADMIN_PHONE,pin=process.env.SEED_ADMIN_PIN;
 if(!ph||!pin||String(pin).length<6)throw new Error('Set SEED_ADMIN_PHONE and a SEED_ADMIN_PIN of at least 6 characters for first start');
 run('insert into users(phone,name,role,verified,pin_hash) values(?,?,?,?,?)',ph,'Admin','admin',1,hashPin(pin))
}
// ---- dispatch core ----
const ACTIVE="('Reserved','Confirmed','Boarded')";
const freeSeats=id=>one('select v.capacity-(select coalesce(sum(seats),0) from assignments a where a.trip_id=t.id and a.status in'+ACTIVE+') f from trips t join vehicles v on v.id=t.vehicle_id where t.id=?',id).f;
function driverBelongsToRoute(did,routeId){const d=one('select station_id,tenant_id,organization_id from drivers where user_id=?',did),r=one('select origin_id,tenant_id,organization_id from routes where id=?',routeId);return!!d&&!!r&&d.station_id==r.origin_id&&d.tenant_id==r.tenant_id&&d.organization_id==r.organization_id}
function eligible(did,v,date,dep,routeId){const d=one('select * from drivers where user_id=?',did);
 if(!driverBelongsToRoute(did,routeId))return false;
 if(!d||!one('select 1 x from users where id=? and deleted_at is null',did)||v.deleted_at||!d.verified||['Suspended','TemporarilyUnavailable'].includes(d.op_status)||v.status=='Maintenance'||!v.docs_ok)return false;
 if(date==new Date().toISOString().slice(0,10)&&(v.status!='Available'||d.op_status!='Available'))return false; // declared availability != actual status
 const end=dep+DUR,dow=new Date(date+'T00:00:00').getDay();
 if(!q('select * from availability where driver_id=? and dow=?',did,dow).some(w=>mins(w.st)<=dep&&end<=mins(w.en)))return false;
 if(one("select 1 x from avail_ex where driver_id=? and status='Approved' and start_at<? and end_at>?",did,date+'T'+hhmm(end),date+'T'+hhmm(dep)))return false;
 return !q("select dep_at from trips where (driver_id=? or vehicle_id=?) and status not in('Cancelled','Completed','Breakdown') and substr(dep_at,1,10)=?",did,v.id,date).some(t=>Math.abs(mins(t.dep_at.slice(11))-dep)<DUR)}
function feeOutstanding(driverId){return one("select coalesce(sum(r.station_pesewas+r.platform_pesewas+r.loading_pesewas-(select coalesce(sum(a.amount_pesewas),0) from fee_allocations a where a.receivable_id=r.id)),0) amount from fee_receivables r where r.driver_id=? and r.status!='Settled'",driverId)?.amount||0}
const payoutDeduction=bookingId=>one("select coalesce(sum(amount_pesewas),0) amount from booking_fee_allocations where booking_id=? and stream='driver' and payer_type='driver'",bookingId)?.amount||0;
function cashDriverEligible(driverId,b){if(b.payment_status!='Cash'||cfg('fee_block_cash',b.route_id,0)!=1)return true;return feeOutstanding(driverId)<=toPesewas(cfg('fee_max_outstanding_ghs',b.route_id,0))}
function autoTrip(b){const today=new Date().toISOString().slice(0,10);if(b.date<today)return;const minDep=b.date==today?mins(now().slice(11))+15:0,dep=Math.min(Math.max(mins(b.arrival)+15,minDep),1439);if(b.date==today&&dep<=mins(now().slice(11)))return;
 const c=q('select * from vehicles where deleted_at is null and capacity>=?',b.seats).filter(v=>eligible(v.driver_id,v,b.date,dep,b.route_id)&&cashDriverEligible(v.driver_id,b));if(!c.length)return;
 const since=new Date(Date.now()-7*864e5).toISOString().slice(0,16);
 c.forEach(v=>v.n=one("select count(*) n from trips where driver_id=? and status!='Cancelled' and dep_at>?",v.driver_id,since).n);
 const m=Math.min(...c.map(v=>v.n)),p=c.filter(v=>v.n==m),v=p[Math.random()*p.length|0]; // fairness first, random among equals
 const t=one('select * from trips where id=?',run('insert into trips(route_id,driver_id,vehicle_id,dep_at) values(?,?,?,?)',b.route_id,v.driver_id,v.id,b.date+'T'+hhmm(dep)).lastInsertRowid);t.score=m;return t}
function assign(t,b,method,by,reason,score){
 if(!DISPATCHABLE.includes(b.payment_status))E(409,'Payment must be confirmed before dispatch assignment');if(!driverBelongsToRoute(t.driver_id,b.route_id))E(409,'Driver is not assigned to this terminal');if(!cashDriverEligible(t.driver_id,b))E(409,'Driver has outstanding cash-trip charges');
 if(freeSeats(t.id)<b.seats)E(409,'Not enough free seats');
 if(one('select 1 x from assignments where booking_id=? and status in'+ACTIVE,b.id))E(409,'Booking already assigned');
 run('insert into assignments(trip_id,booking_id,seats,method,score,by,reason,at) values(?,?,?,?,?,?,?,?)',t.id,b.id,b.seats,method,score??null,String(by),reason??null,now());
 setB(b.id,'Assigned',by,reason||'allocation');
 notify(b.passenger_id,'Booking assigned',`Booking ${b.ref}: trip #${t.id}, estimated departure ${t.dep_at.replace('T',' ')} (estimate, not a guarantee).`,tenantForRoute(b.route_id));
 notify(t.driver_id,'Trip assignment',`Trip #${t.id} departs ~${t.dep_at.replace('T',' ')}: +${b.seats} seat(s).`)}
function writeFeeLedger(booking,source,kind,amount){if(amount>0){const stationId=one('select origin_id from routes where id=?',booking.route_id)?.origin_id;if(stationId)run('insert or ignore into fee_ledger(booking_id,station_id,source,kind,amount_pesewas,created_at) values(?,?,?,?,?,?)',booking.id,stationId,source,kind,amount,now())}}
const ledgerRiderCharges=b=>{writeFeeLedger(b,'rider_charge','station',b.station_fee_pesewas||0);writeFeeLedger(b,'rider_charge','platform',b.platform_fee_pesewas||0)};
const ledgerDriverDeductions=b=>{writeFeeLedger(b,'driver_deduction','station',b.driver_station_deduction_pesewas||0);writeFeeLedger(b,'driver_deduction','platform',b.driver_platform_deduction_pesewas||0)};
const applyBookingCredit=b=>{if(b.payment_status!='Credit')return false;
 const credit=one("select amount_pesewas amount from booking_credits where booking_id=? and entry_type='NoShow'",b.id);
 if(!credit||credit.amount<bookingTotal(b))return false;
 run("insert or ignore into booking_credits(booking_id,passenger_id,amount_pesewas,entry_type,created_at) values(?,?,?,?,?)",b.id,b.passenger_id,-credit.amount,'Applied',now());
 run("update bookings set paid_pesewas=?,payment_status='Paid' where id=?",credit.amount,b.id);ledgerRiderCharges(b);b.payment_status='Paid';return true};
const allocate=db.transaction(()=>{let n=0;
 for(const row of q(`select * from bookings where status='Queued' and payment_status in${DISPATCHABLE_SQL} order by id`)){
  let b=row;if(b.payment_status=='Credit'){const credit=one("select amount_pesewas amount from booking_credits where booking_id=? and entry_type='NoShow'",b.id);if(!credit||credit.amount<bookingTotal(b))continue}
  try{  let t=q("select * from trips where route_id=? and status in('Planned','Loading') and substr(dep_at,1,10)=? and exclusive_for is null",b.route_id,b.date)
   .find(t=>{const d=mins(t.dep_at.slice(11))-mins(b.arrival);return t.dep_at>now()&&d>=0&&d<=45&&freeSeats(t.id)>=b.seats&&cashDriverEligible(t.driver_id,b)});
   if(!t)t=autoTrip(b);if(!t)continue;if(b.payment_status=='Credit'&&!applyBookingCredit(b))continue;assign(t,b,'Automatic','System',null,t.score);n++}catch(e){}}return n});
function requeue(tripId,st,why,unb){for(const a of q('select * from assignments where trip_id=? and status in'+(unb?"('Reserved','Confirmed')":ACTIVE),tripId)){
 run('update assignments set status=? where id=?',st,a.id);const b=one('select * from bookings where id=?',a.booking_id);
 if(b.status!='Cancelled'){setB(b.id,'Queued','System',why);notify(b.passenger_id,'Assignment changed',`Booking ${b.ref} is back in the queue (${why}). We will reassign you.`,tenantForRoute(b.route_id))}}}
function tripStatus(id,st,u){const t=one('select * from trips where id=?',id);if(!t)E(404,'No such trip');
 if(u.role=='driver'&&t.driver_id!=u.id)E(403,'Not your trip');
 const ok={Loading:['Planned','Delayed'],Departed:['Planned','Loading','Delayed'],Completed:['Departed'],Cancelled:['Planned','Loading','Delayed']}[st];
 if(!ok||!ok.includes(t.status))E(409,`Cannot change ${t.status} -> ${st}`);
 if(st=='Completed')missedBoarding(id,true);
 run('update trips set status=? where id=?',st,id);
 if(st=='Loading'){run("update vehicles set status='Loading' where id=?",t.vehicle_id);q('select user_id u from drivers where user_id=?',t.driver_id).forEach(d=>notify(d.u,'Loading',`Trip #${id}: start loading.`))}
 if(st=='Departed'){run('update trips set departed_at=? where id=?',now(),id);run("update vehicles set status='OnRound' where id=?",t.vehicle_id);run("update drivers set op_status='OnTrip' where user_id=?",t.driver_id);
  q("select a.booking_id,b.ref,b.passenger_id,b.route_id from assignments a join bookings b on b.id=a.booking_id where a.trip_id=? and a.status in('Reserved','Confirmed')",id).forEach(a=>notify(a.passenger_id,'Onboard confirmation requested',`Trip #${id} is moving. Confirm that you are on board in your dashboard within 15 minutes.`,tenantForRoute(a.route_id)))}
 if(st=='Completed'){run("update vehicles set status='Returning' where id=?",t.vehicle_id);run("update drivers set op_status='Returning' where user_id=?",t.driver_id);
  q("select booking_id from assignments where trip_id=? and status='Boarded'",id).forEach(a=>setB(a.booking_id,'Completed',u.id,'trip completed'))}
 if(st=='Cancelled'){run("update vehicles set status='Available' where id=? and status in('Loading','Reserved')",t.vehicle_id);requeue(id,'Cancelled','trip cancelled')}
 audit(u.id,'trip.'+st,'trip',id,{});if(st=='Cancelled')allocate()}
// ---- recurring ----
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
const nextMonday=()=>{const t=new Date().toISOString().slice(0,10),dow=new Date(t+'T00:00:00Z').getUTCDay();return addDays(t,(8-dow)%7||7)};
function review(r,week){const dl=new Date(Date.parse(week+'T00:00:00Z')-cfg('confirm_hours_before',r.route_id,78)*36e5).toISOString().slice(0,16);let c=one('select * from confirmations where rec_id=? and week_start=?',r.id,week);
 if(!c){run('insert into confirmations(rec_id,week_start,deadline) values(?,?,?)',r.id,week,dl);c=one('select * from confirmations where rec_id=? and week_start=?',r.id,week);
  notify(r.passenger_id,'Weekly review due',`Please confirm your rides for the week of ${week} before ${dl.replace('T',' ')}.`,tenantForRoute(r.route_id))}
 const days=r.days.split(',').map(Number),occ=[];for(let i=0;i<7;i++){const d=addDays(week,i);
  if(days.includes(new Date(d+'T00:00:00Z').getUTCDay())&&d>=r.start_date&&d<=r.end_date)occ.push({travelDate:d,expectedArrivalAt:r.arrival,seats:r.seats,confirmed:!!one('select 1 x from bookings where rec_id=? and date=? and status!=\'Cancelled\'',r.id,d)})}
 return{confirmation:c,route_id:r.route_id,occurrences:occ}}
function jobs(){const w=nextMonday();q("select * from recurring where status='Active'").forEach(r=>{if(r.end_date>=w&&r.start_date<=addDays(w,6))review(r,w)});
 q("select * from confirmations where status='Pending' and deadline<?",now()).forEach(c=>run("update confirmations set status='Expired' where id=?",c.id));
 missedBoarding();allocate();
 const dueDrivers=q("select r.driver_id,max(r.due_at) due_at from fee_receivables r where r.status!='Settled' and r.due_at<=? group by r.driver_id",now());
 for(const d of dueDrivers){const sent=one("select 1 x from notifications where user_id=? and event='Fee due' and at>?",d.driver_id,new Date(Date.now()-864e5).toISOString().slice(0,16));if(!sent)notify(d.driver_id,'Fee due',`Your cash-trip charges are overdue. Outstanding balance: GHS ${ghs(feeOutstanding(d.driver_id))}. Pay with MoMo from your driver dashboard.`)}
 const s=surge();s.filter(x=>x.alert).forEach(x=>{const m=`Surge on ${x.route}, ${x.date}: ${x.queuedSeats} seats waiting, oldest ${x.oldestWaitMin} min.`;
  if(!one('select 1 x from notifications where msg=? and at>?',m,new Date(Date.now()-36e5).toISOString().slice(0,16)))notifyMgrs('Surge',m,x.route_id)});
 reminders();outbox().catch(console.error)}
function surge(){const today=new Date().toISOString().slice(0,10);return q(`select b.route_id,b.date,sum(b.seats) seats,min(b.created) oldest,min(b.arrival) first,r.name from bookings b join routes r on r.id=b.route_id where b.status='Queued' and b.payment_status in${DISPATCHABLE_SQL} group by b.route_id,b.date,r.name`).map(g=>{
 const wait=Math.round((Date.now()-new Date(g.oldest+'Z'))/6e4),dow=new Date(g.date+'T00:00:00').getDay(),dep=Math.min(mins(g.first)+15,1439);
 const free=q("select id from trips where route_id=? and substr(dep_at,1,10)=? and status in('Planned','Loading') and exclusive_for is null",g.route_id,g.date).reduce((s,t)=>s+freeSeats(t.id),0);
 const ret=g.date!=today?[]:q("select v.* from vehicles v join drivers d on d.user_id=v.driver_id where v.status in('Returning','OnRound') and v.docs_ok=1 and d.verified=1 and d.op_status in('Returning','OnTrip') and d.station_id=(select origin_id from routes where id=?) and d.tenant_id=(select tenant_id from routes where id=?)",g.route_id,g.route_id).filter(v=>q('select 1 x from availability where driver_id=? and dow=? and st<=? and en>=?',v.driver_id,dow,hhmm(dep),hhmm(dep+DUR)).length);
 const exp=ret.reduce((s,v)=>s+v.capacity,0),short=Math.max(0,g.seats-free-exp);
 return{route:g.name,routeId:g.route_id,date:g.date,queuedSeats:g.seats,eligibleFreeSeats:free,returningVehicles:ret.length,expectedSeats:exp,shortfall:short,oldestWaitMin:wait,alert:short>=cfg('surge_seats',g.route_id,SURGE_SEATS)||wait>=cfg('surge_wait',g.route_id,SURGE_WAIT)}})}
// ---- http ----
const app=express(),compression=require('compression');app.set('trust proxy',+process.env.TRUST_PROXY||0);app.disable('x-powered-by');
app.use(compression({filter:(rq,rs)=>!rq.path.endsWith('/events')&&compression.filter(rq,rs)}));
app.use((rq,res,n)=>{res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"});if(PROD)res.set('Strict-Transport-Security','max-age=31536000');n()});
function sanitizeRequestInput(value,key='input'){
 if(typeof value=='string'){
  const field=key.toLowerCase();
  if(field=='contentbase64')return value;
  if(field.includes('pin')){if(value.length>64)throw new Error('PIN must be 64 characters or fewer');return value}
  if(field.includes('otp')||field=='code'){if(value.length>8)throw new Error('Verification code is invalid');return value}
  const cleaned=value.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g,'').replace(/\s+/g,' ').trim();
  if(cleaned.length>200)throw new Error('Text fields must be 200 characters or fewer');
  return cleaned
 }
 if(Array.isArray(value))return value.map(item=>sanitizeRequestInput(item,key));
 if(value&&typeof value=='object'){
  const cleaned=Object.create(null);
  for(const[name,item]of Object.entries(value)){
   if(['__proto__','prototype','constructor'].includes(name))continue;
   cleaned[name]=sanitizeRequestInput(item,name)
  }
  return cleaned
 }
 return value
}
app.get('/healthz',(rq,res)=>{try{one('select 1 x');res.json({ok:1})}catch{res.sendStatus(500)}});app.use(express.json({limit:'12mb'}));app.use((rq,res,next)=>{try{rq.body=sanitizeRequestInput(rq.body)}catch(e){return res.status(400).json({error:e.message})}next()});app.use('/vendor',express.static(__dirname+'/public/vendor',{maxAge:'30d',immutable:true}));app.use(express.static(__dirname+'/public'));
const api=express.Router(),H=f=>(req,res)=>{bad=e=>res.status(e.s||(/UNIQUE|CHECK|constraint/.test(e.message)?409:500)).json({error:e.s||/UNIQUE|CHECK|constraint/.test(e.message)||!PROD?e.message:'Server error'}),ok=r=>{if(typeof r=='string')res.type('text/csv').send(r);else if(r!==undefined)res.json(r)};try{const r=f(req,res);r&&r.then?r.then(ok,e=>{if(!e.s)console.error(e);bad(e)}):ok(r)}catch(e){if(!e.s)console.error(e);bad(e)}};
const sessionCookieOptions={httpOnly:true,secure:PROD,sameSite:'strict',path:'/api/v1'};
const SH=f=>H((req,res)=>{const issue=result=>{if(!result?.token)return result;res.cookie('session',result.token,{...sessionCookieOptions,expires:new Date(result.expiresAt)});return result};const result=f(req,res);return result&&typeof result.then==='function'?result.then(issue):issue(result)});
const ROLE=(...r)=>(req,res,n)=>r.includes(req.u.role)||(req.u.role=='admin'&&r.includes('manager'))?n():res.status(403).json({error:'Forbidden'});
const ACCESS_PERMISSIONS=['users.read','users.update','users.deactivate','vehicles.read','vehicles.create','vehicles.update','vehicles.deactivate','onboarding.invite','onboarding.read','onboarding.review','routes.publish','accounting.read','accounting.expense'],ACCESS_ROLES=['manager','accountant','driver','passenger','porter'];
const hasPermission=(u,permission)=>u.role=='admin'||!!one('select 1 x from role_permissions where role=? and permission=?',u.role,permission);
const PERM=(permission,...roles)=>(req,res,n)=>req.u.role=='admin'||roles.includes(req.u.role)&&hasPermission(req.u,permission)?n():res.status(403).json({error:'Forbidden'});
const STATION_STAFF=['manager','accountant'],mgr=ROLE('manager','accountant'),tenantForStation=id=>one('select tenant_id from stations where id=?',id)?.tenant_id||null,tenantForUser=u=>u.tenant_id||tenantForStation(u.station_id),scope=u=>u.role=='admin'?q('select id from routes').map(r=>r.id):u.organization_id?q('select id from routes where organization_id=?',u.organization_id).map(r=>r.id):u.tenant_id?q('select id from routes where tenant_id=?',u.tenant_id).map(r=>r.id):u.station_id?q('select id from routes where origin_id=?',u.station_id).map(r=>r.id):[];
const stationInScope=(u,id)=>u.role=='admin'||(u.organization_id?!!one('select 1 x from org_tenants ot join stations s on s.tenant_id=ot.tenant_id where ot.organization_id=? and s.id=?',u.organization_id,id):u.tenant_id?tenantForStation(id)==u.tenant_id:u.station_id==id);
const payoutGateFor=(driverId,routeId)=>{const d=one('select payout_gate,payout_gate_override from drivers where user_id=?',driverId)||{};return d.payout_gate_override||d.payout_gate||cfg('payout_gate',routeId,'manager_completion')};
const inScope=(u,rid)=>scope(u).includes(+rid)||E(403,'Outside your station scope');
const chkDrv=(u,did)=>{if(STATION_STAFF.includes(u.role)){const d=one('select station_id,tenant_id,organization_id from drivers where user_id=?',did);if(!d||(u.organization_id?d.organization_id!=u.organization_id:u.tenant_id?d.tenant_id!=u.tenant_id:!u.station_id||d.station_id!=u.station_id))E(403,'Driver belongs to another organization, station or tenant')}};
const chkPassenger=(u,pid)=>{if(STATION_STAFF.includes(u.role)){const ids=scope(u);if(!ids.length||!one(`select 1 x from bookings where passenger_id=? and route_id in(${ids.join(',')})`,pid))E(403,'Passenger has no booking in your station scope')}};
const managerUser=(manager,userId,includeDeleted=false)=>{const user=one('select u.id,u.role,u.tenant_id,u.station_id,u.organization_id,u.deleted_at,d.tenant_id driver_tenant_id,d.station_id driver_station_id,d.organization_id driver_organization_id from users u left join drivers d on d.user_id=u.id where u.id=?',userId);if(!user||!includeDeleted&&user.deleted_at)E(404,'User not found');if(!['driver','passenger','porter'].includes(user.role))E(403,'This role is outside your user-management scope');if(user.role=='driver'){if(user.driver_tenant_id||user.driver_station_id)chkDrv(manager,user.id);else if(manager.organization_id?!one('select 1 x from org_tenants where organization_id=? and tenant_id=?',manager.organization_id,user.tenant_id):user.tenant_id!=tenantForUser(manager))E(403,'Driver is outside your tenant scope');return user}if(user.role=='porter'){if(!user.station_id||!stationInScope(manager,user.station_id))E(403,'User is outside your tenant scope');return user}const ids=scope(manager),managerTenant=tenantForUser(manager),tenantAllowed=manager.organization_id&&one('select 1 x from org_tenants where organization_id=? and tenant_id=?',manager.organization_id,user.tenant_id)||managerTenant&&user.tenant_id==managerTenant,bookingAllowed=ids.length&&one(`select 1 x from bookings b where b.passenger_id=? and b.route_id in(${ids.join(',')})`,user.id);if(!tenantAllowed&&!bookingAllowed)E(403,'Passenger is outside your tenant scope');return user};
const userTenantAccess=(manager,user)=>{if(user.role=='driver'){if(user.driver_tenant_id||user.driver_station_id)return manager.organization_id?user.driver_organization_id==manager.organization_id:manager.tenant_id?user.driver_tenant_id==manager.tenant_id:!!manager.station_id&&user.driver_station_id==manager.station_id;return manager.organization_id?!!one('select 1 x from org_tenants where organization_id=? and tenant_id=?',manager.organization_id,user.tenant_id):user.tenant_id==tenantForUser(manager)}if(user.role=='porter')return!!user.station_id&&stationInScope(manager,user.station_id);const ids=scope(manager),managerTenant=tenantForUser(manager),tenantAllowed=manager.organization_id&&one('select 1 x from org_tenants where organization_id=? and tenant_id=?',manager.organization_id,user.tenant_id)||managerTenant&&user.tenant_id==managerTenant;return!!tenantAllowed||!!(ids.length&&one(`select 1 x from bookings b where b.passenger_id=? and b.route_id in(${ids.join(',')})`,user.id))};
const managerUsers=manager=>q("select u.id,u.name,u.phone,u.role,u.station_id,u.tenant_id,u.organization_id,u.deleted_at,d.station_id driver_station_id,d.tenant_id driver_tenant_id,d.organization_id driver_organization_id from users u left join drivers d on d.user_id=u.id where u.role in('driver','passenger','porter')").filter(user=>userTenantAccess(manager,user));
const lim=new Map(),limit=(k,max,ms)=>{const n=Date.now(),a=(lim.get(k)||[]).filter(t=>n-t<ms);if(a.length>=max)E(429,'Too many attempts, please try later');a.push(n);lim.set(k,a)};
setInterval(()=>{const n=Date.now();for(const[k,a]of lim)if(!a.some(t=>n-t<36e5))lim.delete(k)},6e5).unref();
const sha=x=>cr.createHash('sha256').update(SECRET+x).digest('hex'),STAFF=['manager','accountant','porter','admin'];
let invitationOtpRateCleanupAt=0;
const limitInvitationOtp=(ip,phone,invitationKey,tenantId)=>{
 const timestamp=Date.now();
 if(timestamp-invitationOtpRateCleanupAt>=6e4){run('delete from invitation_otp_rate_limits where expires_at<=?',timestamp);invitationOtpRateCleanupAt=timestamp}
 db.transaction(()=>{
  const checks=[['ip',ip,10,6e5],['phone',phone,3,6e5],['invitation',invitationKey,20,6e5],['tenant-hourly',tenantId,100,36e5],['tenant-daily',tenantId,500,864e5]];
  for(const[bucket,key,maximum,windowMs]of checks){
   const windowStart=Math.floor(timestamp/windowMs)*windowMs;
   const row=one(`insert into invitation_otp_rate_limits(bucket,subject_hash,window_start,hit_count,expires_at) values(?,?,?,?,?) on conflict(bucket,subject_hash,window_start) do update set hit_count=invitation_otp_rate_limits.hit_count+1 where invitation_otp_rate_limits.hit_count<? returning hit_count`,bucket,sha(`invite-otp:${bucket}:${key}`),windowStart,1,windowStart+windowMs,maximum);
   if(!row)E(429,'Too many verification code requests. Try again later.')
  }
 })()
};
const normalizePhone=(value)=>{const raw=String(value==null?'':value).trim();if(!raw||/[A-Za-z@]/.test(raw))return'';const cleaned=raw.replace(/[^\d+]/g,'').replace(/^\+{2,}/,'+');if(!/^\+?\d+$/.test(cleaned))return'';const digits=cleaned.replace(/\+/g,'');if(digits.length<9||digits.length>15)return'';return cleaned.startsWith('+')?`+${digits}`:digits;};
const normalizeGhanaCard=value=>{const compact=String(value||'').toUpperCase().replace(/[\s-]/g,'');if(!/^GHA\d{10}$/.test(compact))E(400,'Enter a valid Ghana Card number');return`GHA-${compact.slice(3,12)}-${compact.slice(12)}`};
let identityVerifierOverride=null;
async function verifyGhanaCard(number,name,phone){
 if(process.env.NODE_ENV=='test'&&identityVerifierOverride){if(!await identityVerifierOverride({number,name,phone}))E(422,'Ghana Card verification failed. Check the details and try again.');return true}
 const settings=systemProviderSettings(),url=settings.IDENTITY_VERIFY_URL,token=settings.IDENTITY_API_TOKEN;
 if(!url||!token)E(503,'Ghana Card verification is not configured. Contact the platform administrator.');
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
 let response;
 try{response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({idType:'GHANA_CARD',idNumber:number,fullName:name,phone}),signal:controller.signal})}
 catch{E(502,'Ghana Card verification service is unavailable. Try again later.')}
 finally{clearTimeout(timeout)}
 if(!response.ok)E(502,'Ghana Card verification service returned an error. Try again later.');
 let result;
 try{result=await response.json()}catch{E(502,'Ghana Card verification service returned an invalid response.')}
 if(!result||typeof result.verified!='boolean')E(502,'Ghana Card verification service returned an invalid response.');
 if(!result.verified)E(422,'Ghana Card verification failed. Check the details and try again.');
 return true
}
const conns=new Map(),tix=new Map();
function push(uid,ev){for(const c of conns.get(uid)||[])c.res.write(`event: ${ev}\ndata: 1\n\n`)}
function pushStaff(){for(const s of conns.values())for(const c of s)if(STAFF.includes(c.role))c.res.write('event: refresh\ndata: 1\n\n')}
const issueSession=(req,u,action='auth.login')=>{const token=cr.randomBytes(32).toString('hex'),ttl=(STAFF.includes(u.role)?+process.env.STAFF_TTL_H||12:+process.env.TOKEN_TTL_H||168)*36e5,created=Date.now();run('insert into sessions(hash,user_id,expires,created,ua,last_activity) values(?,?,?,?,?,?)',sha(token),u.id,created+ttl,created,(req.get('user-agent')||'').slice(0,100),created);audit(u.id,action,'user',u.id);return{token,expiresAt:created+ttl,lastActivityAt:created,user:{id:u.id,phone:u.phone,name:u.name,role:u.role,station_id:u.station_id,tenant_id:u.tenant_id}}};
const STAFF_REFRESH_EXCLUDED_PATHS=new Set(['/auth/activity','/auth/login','/auth/logout','/auth/logout-all','/auth/request-otp','/auth/register','/events/ticket']);
const shouldPushStaffRefresh=req=>req.method!=='GET'&&!STAFF_REFRESH_EXCLUDED_PATHS.has(req.path);
api.use((req,res,n)=>{try{limit('api:'+req.ip,+process.env.API_PER_MIN||600,6e4)}catch(e){return res.status(429).json({error:e.message})}if(shouldPushStaffRefresh(req))res.on('finish',()=>{if(res.statusCode<300)pushStaff()});n()});
api.post('/auth/request-otp',H(async req=>{const phone=normalizePhone(req.body.phone),name=String(req.body.name||'').trim(),role=req.body.role;if(!phone)E(400,'Invalid phone number');limit('ip:'+req.ip,20,36e5);limit('ph:'+phone,3,6e5);
 let user=one('select id,tenant_id,station_id,role,verified,pin_hash,deleted_at from users where phone=?',phone),purpose=req.body.purpose|| (user?'verify':'register');if(user?.deleted_at)E(403,'This account has been deactivated');
 if(!['register','verify','reset-pin'].includes(purpose))E(400,'Invalid OTP purpose');
 if(purpose=='register'&&!passengerSignupVerificationRequired())E(409,'Passenger signup verification is temporarily disabled; use the current registration form.');
 if(purpose=='reset-pin'&&!user)return{ok:1};
 if(purpose=='register'&&user&&(user.verified||user.pin_hash))E(409,'Account already exists. Sign in or use PIN recovery.');
 if(purpose=='register'&&role!='passenger')E(403,'Staff accounts require a tenant-issued invitation.');
 if(purpose=='register'&&user&&user.role!='passenger')E(409,'This phone number is already assigned to a staff account.');
 let tenantId=user?.tenant_id||tenantForStation(user?.station_id)||null,messaging;
 if(purpose=='register'&&role=='passenger'||user?.role=='passenger'&&!tenantId)messaging=authSmsSettings();
 else{
  tenantId=Number(req.body.tenantId)||tenantId;
  if(!tenantId||!one('select 1 x from tenants where id=?',tenantId))E(400,'Tenant messaging is not configured for this account');
  if(user?.tenant_id&&user.tenant_id!=tenantId)E(403,'This account belongs to another tenant');
  messaging=tenantProviderSettings(tenantId)
 }
 if(!messaging.SMS_PROVIDER)E(503,purpose=='register'&&role=='passenger'||user?.role=='passenger'&&!tenantId?'Platform OTP SMS is not configured. Contact the platform administrator.':'SMS is not configured for this tenant.');
 if(!user){if(purpose!='register'||!name||role!='passenger')E(400,'name and role (passenger) are required');if(!req.body.consent)E(400,'You must accept the Terms and Privacy Notice');run('insert into users(phone,name,role,consent_at,consent_ver,tenant_id) values(?,?,?,?,?,null)',phone,name,'passenger',new Date().toISOString(),TV)}
 else if(purpose=='register')run('update users set name=?,consent_at=?,consent_ver=? where id=?',name,new Date().toISOString(),TV,user.id);
 const code=String(100000+cr.randomInt(900000));run('delete from otps where phone=?',phone);run('insert into otps(phone,code,exp,purpose) values(?,?,?,?)',phone,sha(phone+code),Date.now()+3e5,purpose);
 const msg=`Your transport code is ${code}. Valid 5 minutes. Do not share it.`;try{await gw.sms(phone,msg,{config:messaging,tenantId})}catch(e){try{await gw.sms(phone,msg,{config:messaging,tenantId})}catch(e2){console.error('OTP send failed',e2.message);alertOps('otp','OTP SMS failing: '+e2.message);E(502,'Could not send SMS, try again')}}
 return{ok:1}}));
api.post('/auth/register',SH(req=>{if(passengerSignupVerificationRequired())E(403,'Passenger signup without phone and identity verification is disabled.');const phone=normalizePhone(req.body.phone),name=String(req.body.name||'').trim(),pin=String(req.body.pin||'').trim();if(!phone)E(400,'Enter a valid phone number');if(!name||name.length>100)E(400,'Enter a name up to 100 characters');if(pin.length<6||pin.length>64)E(400,'PIN must be between 6 and 64 characters');if(!req.body.consent)E(400,'You must accept the Terms and Privacy Notice');limit('ip:'+req.ip,20,36e5);limit('ph:'+phone,3,6e5);return db.transaction(()=>{let user=one('select * from users where phone=?',phone);if(user?.deleted_at)E(403,'This account has been deactivated');if(user&&(user.role!='passenger'||user.verified||user.pin_hash))E(409,'Account already exists. Sign in or use PIN recovery.');const consentAt=new Date().toISOString();if(user)run('update users set name=?,pin_hash=?,pin_fails=0,locked_until=0,consent_at=?,consent_ver=?,ghana_card_verified=0 where id=?',name,hashPin(pin),consentAt,TV,user.id);else run('insert into users(phone,name,role,verified,pin_hash,consent_at,consent_ver,ghana_card_verified) values(?,?,?,?,?,?,?,0)',phone,name,'passenger',0,hashPin(pin),consentAt,TV);user=one('select * from users where phone=?',phone);return issueSession(req,user,'auth.register.unverified')})()}));
api.post('/auth/login',SH(req=>{const phone=normalizePhone(req.body.phone),pin=String(req.body.pin||''),portal=String(req.body.portal||'');limit('login:'+req.ip,30,36e5);if(!phone||!pin)E(401,'Invalid phone or PIN');const u=one('select * from users where phone=?',phone);if(!u||u.deleted_at||!u.pin_hash)E(401,'Invalid phone or PIN');if(u.locked_until>Date.now())E(423,'Account locked, try again later');if(!okPin(pin,u.pin_hash)){run('update users set pin_fails=pin_fails+1,locked_until=case when pin_fails+1>=5 then cast(? as bigint) else 0 end where id=?',Date.now()+9e5,u.id);audit(u.id,'auth.fail','user',u.id);E(401,'Invalid phone or PIN')}
 if(portal&&!(portal=='manager'?['manager','accountant'].includes(u.role):u.role==portal))E(403,'This account belongs to a different portal');
 run('update users set pin_fails=0,locked_until=0 where id=?',u.id);return issueSession(req,u)}));
api.post('/auth/verify-otp',SH(async req=>{const phone=normalizePhone(req.body.phone),code=req.body.code,pin=req.body.pin;limit('v:'+req.ip,30,36e5);if(!phone)E(400,'Invalid phone number');const u=one('select * from users where phone=?',phone),o=one('select * from otps where phone=?',phone);
 if(o?.purpose=='register'&&!passengerSignupVerificationRequired())E(409,'Passenger signup verification is temporarily disabled; use the current registration form.');
 if(!u||u.deleted_at||!o||o.exp<Date.now())E(401,'Invalid or expired code');if(u.locked_until>Date.now()&&o.purpose!='reset-pin')E(423,'Account locked, try again later');
 if(o.attempts>=5){run('delete from otps where phone=?',phone);E(401,'Too many wrong codes; request a new one')}
 if(o.code!=sha(phone+String(code))){run('update otps set attempts=attempts+1 where phone=?',phone);E(401,'Invalid or expired code')}
 const p=(pin===undefined||pin===null)?'':String(pin).trim();
 if(o.purpose=='register'||o.purpose=='reset-pin'){
  if(p.length<6)E(400,'A PIN of at least 6 characters is required');
  if(o.purpose=='register'){if(u.role!='passenger')E(403,'Staff accounts require a tenant-issued invitation.');const idNumber=normalizeGhanaCard(req.body.ghanaCardNumber);await verifyGhanaCard(idNumber,u.name,u.phone)}
  run('update users set pin_hash=?,pin_fails=0,locked_until=0 where id=?',hashPin(p),u.id);
  if(o.purpose=='register')run('update users set ghana_card_verified=1,ghana_card_verified_at=? where id=?',new Date().toISOString(),u.id);
  if(o.purpose=='reset-pin')run('update sessions set revoked=1 where user_id=?',u.id);
 }else if(STAFF.includes(u.role)){
  if(!p)E(401,'Staff PIN required');if(!okPin(p,u.pin_hash)){run('update users set pin_fails=pin_fails+1,locked_until=case when pin_fails+1>=5 then cast(? as bigint) else 0 end where id=?',Date.now()+9e5,u.id);audit(u.id,'auth.fail','user',u.id);E(401,'Staff PIN incorrect')}
  run('update users set pin_hash=?,pin_fails=0,locked_until=0 where id=?',hashPin(p),u.id);
 }else if(p){run('update users set pin_hash=?,pin_fails=0,locked_until=0 where id=?',hashPin(p),u.id);}
 run('delete from otps where phone=?',phone);run('update users set pin_fails=0,locked_until=0,verified=1 where id=?',u.id);return issueSession(req,u)}));
api.get('/registration-options',H(()=>({stations:q('select s.id,s.name,s.code,s.tenant_id from stations s order by s.name'),tenants:q('select id,name from tenants order by name'),organizations:q('select o.id,o.name,ot.tenant_id from organizations o join org_tenants ot on ot.organization_id=o.id order by o.name'),payPartners:(process.env.EGANOW_MOMO_PARTNERS||'MTNGH,ATGH,TCELGH').split(',').map(x=>x.trim()).filter(Boolean),passengerSignupVerificationRequired:passengerSignupVerificationRequired()})));
const invitationByToken=token=>{if(!/^[a-f0-9]{64}$/.test(String(token||'')))return null;return one(`select i.*,s.name station_name,t.name tenant_name,o.name organization_name from onboarding_invitations i join stations s on s.id=i.station_id join tenants t on t.id=i.tenant_id left join organizations o on o.id=i.organization_id where i.token_hash=?`,sha('invite:'+token))};
const invitationLinkByToken=token=>{if(!/^[a-f0-9]{64}$/.test(String(token||'')))return null;return one(`select i.*,s.name station_name,t.name tenant_name,o.name organization_name from onboarding_invitation_links i join stations s on s.id=i.station_id join tenants t on t.id=i.tenant_id left join organizations o on o.id=i.organization_id where i.token_hash=?`,sha('invite:'+token))};
const invitationForLinkApplicant=(link,phone,create=false)=>{
 let invitation=one(`select i.*,s.name station_name,t.name tenant_name,o.name organization_name from onboarding_invitations i join stations s on s.id=i.station_id join tenants t on t.id=i.tenant_id left join organizations o on o.id=i.organization_id where i.link_id=? and i.applicant_phone=?`,link.id,phone);
 if(!invitation&&create){
  if(link.use_mode=='single'&&link.use_count>0)E(410,'This invitation has already been used');
  if(one('select 1 x from users where phone=?',phone))E(409,'This phone number already belongs to an account');
  const token=cr.randomBytes(32).toString('hex'),id=run('insert into onboarding_invitations(token_hash,role,tenant_id,station_id,organization_id,created_by,created_at,expires_at,applicant_phone,link_id) values(?,?,?,?,?,?,?,?,?,?)',sha('invite:'+token),link.role,link.tenant_id,link.station_id,link.organization_id,link.created_by,link.created_at,link.expires_at,phone,link.id).lastInsertRowid;
  invitation=one(`select i.*,s.name station_name,t.name tenant_name,o.name organization_name from onboarding_invitations i join stations s on s.id=i.station_id join tenants t on t.id=i.tenant_id left join organizations o on o.id=i.organization_id where i.id=?`,id)
 }
 return invitation
};
const invitationApplication=invitationId=>one('select * from onboarding_applications where invitation_id=?',invitationId);
const inviteTokenUsable=(inv,app)=>{if(!inv)E(404,'Invitation not found');if(inv.revoked_at&&!app)E(410,'This invitation has been revoked');if(Date.parse(inv.expires_at)<=Date.now()&&!app)E(410,'This invitation has expired')};
const validateApplication=(inv,body)=>{
 const name=String(body.name||'').trim();if(!name||name.length>100)E(400,'A valid full name is required');
 if(!body.consent)E(400,'You must accept the Terms and Privacy Notice');
 if(inv.role!='driver')return{name,form:{},documents:[]};
 const form={licence:String(body.licence||'').trim(),reg:String(body.reg||'').toUpperCase().replace(/\s/g,''),type:String(body.type||'').trim(),capacity:Number(body.capacity),payoutPartner:String(body.payoutPartner||'').trim().toUpperCase(),payoutPhone:normalizePhone(body.payoutPhone),payoutGate:String(body.payoutGate||'manager_completion'),days:Array.isArray(body.days)?[...new Set(body.days.map(Number))]:[],startTime:String(body.startTime||''),endTime:String(body.endTime||'')};
 if(!form.licence||!form.reg||form.reg.length>20||!/^[A-Z0-9-]+$/.test(form.reg)||!form.type||form.type.length>60||!Number.isSafeInteger(form.capacity)||form.capacity<1||form.capacity>60)E(400,'Enter a valid licence, vehicle registration, type, and capacity (1-60 seats)');
 if(!['onboard','manager_completion'].includes(form.payoutGate))E(400,'Choose a valid payout timing');
 if(!form.days.length||form.days.some(day=>!Number.isInteger(day)||day<0||day>6)||!validTime(form.startTime)||!validTime(form.endTime)||form.startTime>=form.endTime)E(400,'Select weekly availability days and a valid time range');
 if(!isSupportedPayPartner(paymentProvider,form.payoutPartner)||!form.payoutPhone)E(400,'Choose a supported mobile-money network and valid payout number');
 const docs=['licence','vehicle_registration','insurance'].map(kind=>({kind,...(body.documents||{})[kind]})),files=[];
 for(const doc of docs){const ext=path.extname(doc.filename||'').toLowerCase(),content=String(doc.contentBase64||''),buffer=Buffer.from(content,'base64');if(!['.pdf','.jpg','.jpeg','.png'].includes(ext)||!buffer.length||buffer.length>3e6||!/^[A-Za-z0-9+/]+={0,2}$/.test(content))E(400,`Upload a PDF, JPG, or PNG ${doc.kind} document under 3MB`);if(doc.kind!='vehicle_registration'&&(!validDate(doc.expiresOn)||doc.expiresOn<=new Date().toISOString().slice(0,10)))E(400,`A future expiry date is required for ${doc.kind}`);doc.buffer=buffer;files.push(doc)}
 if(files.reduce((sum,doc)=>sum+doc.buffer.length,0)>8e6)E(400,'Combined document uploads must be under 8MB');
 return{name,form,documents:files}
};
const verifyInvitationOtp=(inv,phone,code)=>{const otp=one('select * from otps where phone=?',phone);if(!otp||otp.purpose!='invite:'+inv.id||otp.exp<Date.now())E(401,'Invalid or expired code');if(otp.attempts>=5){run('delete from otps where phone=?',phone);E(401,'Too many wrong codes; request a new one')}if(otp.code!=sha(phone+String(code))){run('update otps set attempts=attempts+1 where phone=?',phone);E(401,'Invalid or expired code')}run('delete from otps where phone=?',phone)};
api.get('/onboarding/invitations/:token',H(req=>{const link=invitationLinkByToken(req.params.token);if(link){inviteTokenUsable(link,link.use_count>0);return{role:link.role,station:link.station_name,tenant:link.tenant_name,organization:link.organization_name,applicationExists:false}}const inv=invitationByToken(req.params.token),app=inv&&invitationApplication(inv.id);inviteTokenUsable(inv,app);return{role:inv.role,station:inv.station_name,tenant:inv.tenant_name,organization:inv.organization_name,applicationExists:!!app}}));
api.post('/onboarding/invitations/:token/request-otp',H(async req=>{
 const phone=normalizePhone(req.body.phone);if(!phone)E(400,'Enter a valid phone number');
 const link=invitationLinkByToken(req.params.token),existing=link&&invitationForLinkApplicant(link,phone),inv=link?existing:invitationByToken(req.params.token),app=inv&&invitationApplication(inv.id),target=link||inv;
 inviteTokenUsable(target,app);
 if(inv?.applicant_phone&&inv.applicant_phone!=phone)E(403,'This invitation is already bound to another phone number');
 if(app&&app.phone!=phone)E(403,'This application is bound to another phone number');
 if(!app&&one('select 1 x from users where phone=?',phone))E(409,'This phone number already belongs to an account');
 const tenantId=target.tenant_id,messaging=tenantProviderSettings(tenantId);
 if(!messaging.SMS_PROVIDER)E(503,'SMS is not configured for this tenant. Contact the tenant administrator.');
 const invitationKey=link?`link:${link.id}`:`legacy:${inv.id}`;
 limitInvitationOtp(req.ip,phone,invitationKey,tenantId);
 const applicantInvitation=inv||invitationForLinkApplicant(link,phone,true);
 inviteTokenUsable(target,app);
 const code=String(100000+cr.randomInt(900000));run('delete from otps where phone=?',phone);run('insert into otps(phone,code,exp,purpose) values(?,?,?,?)',phone,sha(phone+code),Date.now()+3e5,'invite:'+applicantInvitation.id);
 const message=`Your transport application code is ${code}. Valid 5 minutes. Do not share it.`;
 try{await gw.sms(phone,message,{config:messaging,tenantId})}catch(e){try{await gw.sms(phone,message,{config:messaging,tenantId})}catch(e2){console.error('Invitation OTP send failed',e2.message);E(502,'Could not send SMS, try again')}}
 return{ok:1,applicationExists:!!app}
}));
api.post('/onboarding/invitations/:token/submit',H(req=>{const phone=normalizePhone(req.body.phone);if(!phone)E(400,'Enter a valid phone number');const link=invitationLinkByToken(req.params.token),inv=link?invitationForLinkApplicant(link,phone):invitationByToken(req.params.token),app=inv&&invitationApplication(inv.id);inviteTokenUsable(link||inv,app);if(!inv)E(404,'Invitation not found');if(inv.applicant_phone&&inv.applicant_phone!=phone||app&&app.phone!=phone)E(403,'This invitation is already bound to another phone number');if(app&&app.status!='needs_changes')E(409,app.status=='pending_review'?'Your application is awaiting review.':'This application cannot be resubmitted.');verifyInvitationOtp(inv,phone,req.body.code);const submitted=validateApplication(inv,req.body),oldPaths=[],newPaths=[];let applicationId;
 try{db.transaction(()=>{
  const updatedAt=new Date().toISOString();
  if(app){applicationId=app.id;oldPaths.push(...q('select path from onboarding_application_documents where application_id=?',app.id).map(doc=>doc.path));run("update onboarding_applications set name=?,form_json=?,status='pending_review',review_comment=null,reviewed_by=null,updated_at=? where id=?",submitted.name,JSON.stringify(submitted.form),updatedAt,app.id);run('delete from onboarding_application_documents where application_id=?',app.id)}
  else{if(link&&link.use_mode=='single'&&link.use_count>0)E(410,'This invitation has already been used');applicationId=run("insert into onboarding_applications(invitation_id,name,phone,form_json,status,submitted_at,updated_at) values(?,?,?,?,'pending_review',?,?)",inv.id,submitted.name,phone,JSON.stringify(submitted.form),updatedAt,updatedAt).lastInsertRowid;run('update onboarding_invitations set applicant_phone=?,submitted_at=? where id=?',phone,updatedAt,inv.id);if(link)run('update onboarding_invitation_links set use_count=use_count+1 where id=?',link.id)}
  for(const doc of submitted.documents){const filename=cr.randomBytes(16).toString('hex')+path.extname(doc.filename).toLowerCase();fs.writeFileSync(path.join(UP,filename),doc.buffer,{flag:'wx',mode:0o600});newPaths.push(filename);run('insert into onboarding_application_documents(application_id,kind,filename,path,expires_on,uploaded_at) values(?,?,?,?,?,?)',applicationId,doc.kind,String(doc.filename).slice(0,200),filename,doc.expiresOn||null,updatedAt)}
  run("insert into onboarding_review_history(application_id,status,comment,reviewer_id,created_at) values(?,'pending_review','',null,?)",applicationId,updatedAt)
 })()}catch(error){for(const filename of newPaths)fs.rmSync(path.join(UP,filename),{force:true});throw error}
 for(const filename of oldPaths)fs.rmSync(path.join(UP,filename),{force:true});
 return{ok:1,status:'pending_review',applicationId}
}));
api.post('/onboarding/invitations/:token/status',H(req=>{const phone=normalizePhone(req.body.phone);if(!phone)E(400,'Enter a valid phone number');const link=invitationLinkByToken(req.params.token),inv=link?invitationForLinkApplicant(link,phone):invitationByToken(req.params.token),app=inv&&invitationApplication(inv.id);inviteTokenUsable(link||inv,app);if(!app)E(404,'No application has been submitted for this invitation');if(phone!=app.phone)E(403,'This application is bound to another phone number');verifyInvitationOtp(inv,phone,req.body.code);return{status:app.status,comment:app.review_comment||'',updatedAt:app.updated_at,history:q('select status,comment,created_at from onboarding_review_history where application_id=? order by id',app.id)}}));
api.use((req,res,n)=>{const bearerToken=/^Bearer\s+(.+)$/i.exec(req.headers.authorization||'')?.[1],cookieToken=(req.headers.cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith('session='))?.slice(8),token=bearerToken||cookieToken,hash=token&&sha(token),s=hash&&one('select * from sessions where hash=? and revoked=0',hash),now=Date.now(),lastActivity=s&&(s.last_activity||s.created),idleExpired=s&&now-lastActivity>=SESSION_IDLE_TIMEOUT_MS,u=s&&!idleExpired&&s.expires>now&&one('select * from users where id=? and deleted_at is null',s.user_id);if(!u){if(s&&(idleExpired||s.expires<=now))run('update sessions set revoked=1 where hash=?',hash);if(cookieToken)res.clearCookie('session',sessionCookieOptions);return res.status(401).json({error:idleExpired?'Session expired due to inactivity.':'Unauthorised'})}req.u=u;req.sh=hash;req.sessionExpiresAt=s.expires;req.sessionLastActivityAt=lastActivity;n()});
api.post('/auth/activity',H(req=>{const at=Date.now();run('update sessions set last_activity=? where hash=? and revoked=0 and expires>?',at,req.sh,at);req.sessionLastActivityAt=at;return{ok:1,lastActivityAt:at}}));
api.post('/auth/logout',H((req,res)=>{run('update sessions set revoked=1 where hash=?',req.sh);res.clearCookie('session',sessionCookieOptions);return{ok:1}}));
api.post('/auth/logout-all',H((req,res)=>{run('update sessions set revoked=1 where user_id=?',req.u.id);res.clearCookie('session',sessionCookieOptions);return{ok:1}}));
api.post('/events/ticket',H(req=>{const t=cr.randomBytes(16).toString('hex');tix.set(t,{id:req.u.id,role:req.u.role,exp:Date.now()+3e4});return{ticket:t}}));
api.post('/admin/users/:id/pin',ROLE('admin'),H(req=>{if(String(req.body.pin||'').length<6)E(400,'PIN must be 6+ characters');run('update users set pin_hash=?,pin_fails=0,locked_until=0 where id=?',hashPin(req.body.pin),req.params.id);run('update sessions set revoked=1 where user_id=?',req.params.id);audit(req.u.id,'pin.set','user',+req.params.id);return{ok:1}}));
const OUTBOX_EVENTS=(process.env.SMS_EVENTS||'Booking assigned,Assignment changed,Trip assignment,Loading,Breakdown,Surge,Weekly review due,Booking cancelled,No-show,Full-vehicle request,Verified,Document,Schedule changed,Weekly review reminder,Ride reminder,Trip reminder,Trip delayed,Booking suspended,No-show warning,Onboard confirmation requested,Boarding credit,Payment received,Payout attention,Fee due,Onboarding approved').split(',');
let sending=false;
async function outbox(){if(sending)return;sending=true;try{
 for(const n of q("select n.*,u.phone,u.whatsapp_optin from notifications n join users u on u.id=n.user_id where n.status in('Pending','Retrying') and n.next_try<=? order by n.id limit 20",Date.now())){
  if(!OUTBOX_EVENTS.includes(n.event)){run("update notifications set status='InApp' where id=?",n.id);continue}
  if(!n.tenant_id){run("update notifications set status='InApp',error='tenant scope unavailable' where id=?",n.id);continue}
  const messaging=tenantProviderSettings(n.tenant_id);if(!messaging.SMS_PROVIDER){run("update notifications set status='InApp',error='tenant SMS provider not configured' where id=?",n.id);continue}
  try{limit('sms:'+n.user_id,+process.env.SMS_PER_HOUR||10,36e5)}catch(e){run("update notifications set status='Throttled',error='rate limit' where id=?",n.id);continue}
  try{const ch=messaging.TWILIO_FROM_WA&&n.whatsapp_optin?'whatsapp':'sms',r=await gw.sms(n.phone,`${n.event}: ${n.msg}`.slice(0,300),{channel:ch,event:n.event,text:n.msg.slice(0,250),config:messaging,tenantId:n.tenant_id});smsFails=0;run("update notifications set status='Sent',channel=?,provider_id=?,attempts=attempts+1 where id=?",r&&r.channel||ch,r&&r.id||null,n.id)}
  catch(e){if(++smsFails>=5)alertOps('sms','Messaging provider failing: '+String(e.message).slice(0,120));const a=n.attempts+1;run('update notifications set status=?,attempts=?,next_try=?,error=? where id=?',a>=5?'Failed':'Retrying',a,Date.now()+Math.min(36e5,3e4*2**a),String(e.message).slice(0,200),n.id)}}}finally{sending=false}}
api.get('/me',H(r=>({...r.u,token:undefined,pin_hash:undefined,pin_fails:undefined,locked_until:undefined,termsVersion:TV,expiresAt:r.sessionExpiresAt,lastActivityAt:r.sessionLastActivityAt,waEnabled:!!tenantProviderSettings(r.u.tenant_id||tenantForStation(r.u.station_id)||0).TWILIO_FROM_WA,driver:one('select * from drivers where user_id=?',r.u.id)})));
api.get('/me/permissions',H(req=>Object.fromEntries(ACCESS_PERMISSIONS.map(permission=>[permission,hasPermission(req.u,permission)]))));
api.get('/routes',H(req=>{const routes=STATION_STAFF.includes(req.u.role)?scope(req.u):req.u.role=='driver'&&req.u.organization_id?q('select id from routes where organization_id=?',req.u.organization_id).map(r=>r.id):req.u.role=='driver'&&req.u.tenant_id?q('select id from routes where tenant_id=?',req.u.tenant_id).map(r=>r.id):q('select id from routes').map(r=>r.id);return q('select r.id,r.origin_id,r.dest_id,r.organization_id,r.published,r.name,o.name organization,origin.name origin_station,dest.name destination_station,origin.latitude origin_latitude,origin.longitude origin_longitude,dest.latitude dest_latitude,dest.longitude dest_longitude from routes r left join organizations o on o.id=r.organization_id join stations origin on origin.id=r.origin_id join stations dest on dest.id=r.dest_id').filter(r=>routes.includes(r.id)&&(req.u.role!='passenger'||r.published==1)).map(r=>({...r,cutoff_min:cfg('cutoff_min',r.id,CUTOFF),cash_enabled:cfg('cash_enabled',r.id,0)==1}))}));
api.get('/rides/availability',ROLE('passenger'),H(req=>{
 const routeId=+req.query.routeId,date=String(req.query.date||''),arrival=String(req.query.arrival||''),seats=Number(req.query.seats||1);
 if(!one('select 1 x from routes where id=?',routeId))E(400,'Unknown route');
 requirePassengerTenant(req.u,routeId);
 if(!validDate(date)||!Number.isSafeInteger(seats)||seats<1||seats>60)E(400,'A valid travel date and passenger count (1-60) are required');
 if(arrival&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(arrival))E(400,'Arrival time must use HH:MM');
 return q("select t.id,t.dep_at,t.status,v.capacity from trips t join vehicles v on v.id=t.vehicle_id where t.route_id=? and substr(t.dep_at,1,10)=? and t.status in('Planned','Loading','Delayed') and t.exclusive_for is null order by t.dep_at,t.id",routeId,date)
  .map(t=>({...t,seatsAvailable:freeSeats(t.id)}))
  .filter(t=>t.seatsAvailable>=seats&&(!arrival||(mins(t.dep_at.slice(11))>=mins(arrival)&&mins(t.dep_at.slice(11))-mins(arrival)<=45)))
  .map(t=>({departure:t.dep_at.slice(11),status:t.status,capacity:t.capacity,seatsAvailable:t.seatsAvailable}));
}));
api.get('/notifications',H(r=>q('select * from notifications where user_id=? order by id desc limit 30',r.u.id)));
const P=ROLE('passenger');
const requirePassengerTenant=(user,routeId)=>{const route=one('select published from routes where id=?',routeId);if(!route)E(400,'Unknown route');if(user.role=='passenger'&&route.published!=1)E(409,'This route is not currently published')};
function bookingPublic(id){const b=one(`select b.id,b.ref,b.date,b.arrival,b.seats,b.status,b.payment_status,b.payment_method,
 r.name route,a.seat_label,a.trip_id,t.dep_at,t.status trip_status,v.reg,a.onboard_confirmed,b.fare_pesewas,b.station_fee_pesewas,b.platform_fee_pesewas,b.loading_fee_pesewas,b.paid_pesewas,
 (select count(*) from bookings x where x.status='Queued' and x.payment_status in${DISPATCHABLE_SQL} and x.route_id=b.route_id and x.date=b.date and x.id<b.id)+1 queue_pos
 from bookings b join routes r on r.id=b.route_id left join assignments a on a.booking_id=b.id and a.status in${ACTIVE}
 left join trips t on t.id=a.trip_id left join vehicles v on v.id=t.vehicle_id where b.id=?`,id);
 if(!b)return b;const total=bookingTotal(b);return{id:b.id,ref:b.ref,date:b.date,arrival:b.arrival,seats:b.seats,status:b.status,payment_status:b.payment_status,payment_method:b.payment_method,route:b.route,seat_label:b.seat_label,trip_id:b.trip_id,dep_at:b.dep_at,trip_status:b.trip_status,reg:b.reg,onboard_confirmed:b.onboard_confirmed,queue_pos:b.queue_pos,total_due:'GHS '+ghs(total),amount_due:'GHS '+ghs(Math.max(0,total-b.paid_pesewas)),info:stText(b),payment_attempt_status:(one('select status from booking_payments where booking_id=? order by id desc limit 1',b.id)||{}).status||null}}
api.get('/quote',P,H(req=>{const routeId=+req.query.routeId,seats=Number(req.query.seats||1);if(!Number.isInteger(routeId)||!one('select 1 x from routes where id=?',routeId))E(400,'Unknown route');requirePassengerTenant(req.u,routeId);if(!Number.isSafeInteger(seats)||seats<1||seats>3)E(400,'Seats must be between 1 and 3');
 const fare=routeFare(routeId).farePesewas*seats,charges=riderCharges(fare,cfg('station_fee_pct',routeId,0),cfg('platform_fee_pct',routeId,0)),loading=percentageCharge(fare,cfg('loading_fee_pct',routeId,0));return{total_due:'GHS '+ghs(fare+charges.stationFeePesewas+charges.platformFeePesewas+loading)}}));
api.get('/me/activity-summary',P,H(req=>{
 const now=new Date(),weekStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-(now.getUTCDay()+6)%7)),nextWeek=new Date(weekStart.getTime()+7*864e5),
  monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)),nextMonth=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)),
  day=d=>d.toISOString().slice(0,10),uid=req.u.id;
 const rides=one(`select count(*) as "totalRides",coalesce(sum(seats),0) as "totalSeats",
  coalesce(sum(case when date>=? and date<? then 1 else 0 end),0) as "weekRides",
  coalesce(sum(case when date>=? and date<? then seats else 0 end),0) as "weekSeats",
  coalesce(sum(case when date>=? and date<? then 1 else 0 end),0) as "monthRides",
  coalesce(sum(case when date>=? and date<? then seats else 0 end),0) as "monthSeats",
  coalesce(sum(case when status in('Queued','Assigned','Confirmed') then 1 else 0 end),0) as "activeRides"
  from bookings where passenger_id=?`,day(weekStart),day(nextWeek),day(weekStart),day(nextWeek),day(monthStart),day(nextMonth),day(monthStart),day(nextMonth),uid);
 const groups=one(`select count(*) total,coalesce(sum(case when status='Pending' then 1 else 0 end),0) pending,
  coalesce(sum(case when date>=? and date<? then 1 else 0 end),0) as "weekRequests",
  coalesce(sum(case when date>=? and date<? then 1 else 0 end),0) as "monthRequests"
  from excl where passenger_id=?`,day(weekStart),day(nextWeek),day(monthStart),day(nextMonth),uid),
  weeklyPlans=one("select count(*) n from recurring where passenger_id=? and status='Active'",uid).n;
 return{...rides,totalGroupRequests:groups.total,weekRequests:groups.weekRequests,monthRequests:groups.monthRequests,pendingGroupRequests:groups.pending,activeWeeklyPlans:weeklyPlans,inProgress:rides.activeRides+groups.pending};
}));
function newBooking(u,b,src,rec){const{routeId,date,arrival,seats}=b,paymentMethod=src=='OneTime'?(b.paymentMethod||'digital'):'digital';if(u.noshow_blocked_until>Date.now())E(403,'Bookings suspended until '+new Date(u.noshow_blocked_until).toISOString().slice(0,10)+' because of repeated no-shows');if(!one('select 1 x from routes where id=?',routeId))E(400,'Unknown route');requirePassengerTenant(u,routeId);
 if(!(seats>=1&&seats<=3))E(400,'Ordinary bookings allow 1-3 seats; use a full-vehicle request for more');
 if(!validDateTime(date,arrival))E(400,'Bad date/time');
 if(Date.parse(date+'T'+arrival+':00Z')-Date.now()<cfg('cutoff_min',routeId,CUTOFF)*6e4)E(400,'Booking cut-off has passed for this route');
 if(!['digital','cash'].includes(paymentMethod))E(400,'paymentMethod must be digital or cash');if(paymentMethod=='cash'&&cfg('cash_enabled',routeId,0)!=1)E(400,'Cash payment is not enabled for this route');
 const pricing=routeFare(routeId),farePesewas=pricing.farePesewas*seats,riderPctStation=cfg('station_fee_pct',routeId,0),riderPctPlatform=cfg('platform_fee_pct',routeId,0),driverPctStation=cfg('driver_station_fee_pct',routeId,riderPctStation),driverPctPlatform=cfg('driver_platform_fee_pct',routeId,riderPctPlatform),riderLoadingPct=cfg('loading_fee_pct',routeId,0),driverLoadingPct=cfg('driver_loading_fee_pct',routeId,riderLoadingPct),
 rider=riderCharges(farePesewas,riderPctStation,riderPctPlatform),driver=driverDeductions(farePesewas,driverPctStation,driverPctPlatform),riderLoading=percentageCharge(farePesewas,riderLoadingPct),driverLoading=percentageCharge(farePesewas,driverLoadingPct),paymentStatus=paymentMethod=='cash'?'Cash':'Due';
 const ref='BK'+cr.randomBytes(3).toString('hex').toUpperCase(),created=new Date().toISOString().slice(0,19),id=run("insert into bookings(ref,passenger_id,route_id,organization_id,date,arrival,seats,status,rec_id,source,created,fare_pesewas,platform_fee_pesewas,station_fee_pesewas,loading_fee_pesewas,payment_status,payment_method,rider_station_pct,rider_platform_pct,driver_station_pct,driver_platform_pct,driver_loading_pct,rider_loading_pct,driver_station_deduction_pesewas,driver_platform_deduction_pesewas,driver_loading_deduction_pesewas) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",ref,u.id,routeId,pricing.organizationId,date,arrival,seats,'Queued',rec||null,src,created,farePesewas,rider.platformFeePesewas,rider.stationFeePesewas,riderLoading,paymentStatus,paymentMethod,riderPctStation,riderPctPlatform,driverPctStation,driverPctPlatform,driverLoadingPct,riderLoadingPct,driver.stationDeductionPesewas,driver.platformDeductionPesewas,driverLoading).lastInsertRowid;
 const saved=one('select * from bookings where id=?',id);snapshotBookingFees(saved,pricing);setB(id,'Queued',u.id,'created');return id}
api.post('/bookings',P,H((req,res)=>{const k=req.get('Idempotency-Key')||req.body.idempotencyKey;if(k){const p=one('select booking_id i from idem where user_id=? and key=?',req.u.id,k);if(p){res.set('Idempotent-Replay','true');return bookingPublic(p.i)}}const id=newBooking(req.u,req.body,'OneTime');if(k)run('insert into idem values(?,?,?)',req.u.id,k,id);audit(req.u.id,'booking.create','booking',id);notify(req.u.id,'Booking created',req.body.paymentMethod=='cash'?'Pay the driver in cash when boarding.':'Review the total and complete payment to enter the dispatch queue.',tenantForRoute(req.body.routeId));return bookingPublic(id)}));
api.get('/bookings',P,H((req,res)=>{res.set('X-Total-Count',one('select count(*) n from bookings where passenger_id=?',req.u.id).n);return q(`select b.id from bookings b where b.passenger_id=? order by b.date desc,b.id desc limit ? offset ?`,req.u.id,...pg(req)).map(b=>bookingPublic(b.id))}));
api.post('/bookings/:id/cancel',P,H(req=>{const b=one('select * from bookings where id=? and passenger_id=?',req.params.id,req.u.id);if(!b)E(404,'Not found');
 if(req.u.role=='passenger'&&b.paid_pesewas>0)E(409,'This booking has been paid. Contact the station manager to request a credit before cancelling.');
 if(req.u.role=='passenger'&&b.payment_status=='Credit')E(409,'This booking carries prepaid fare credit. Contact the station manager before cancelling.');
 if(['Boarded','Completed','Cancelled'].includes(b.status))E(409,'Cannot cancel at this stage');if(req.u.role=='passenger'&&new Date(b.date+'T'+b.arrival)-Date.now()<cfg('cancel_deadline_min',b.route_id,0)*6e4)E(409,'Cancellation deadline has passed');run("update assignments set status='Cancelled' where booking_id=? and status in"+ACTIVE,b.id);setB(b.id,'Cancelled',req.u.id,req.body.reason||'cancelled');
 audit(req.u.id,'booking.cancel','booking',b.id);notify(b.passenger_id,'Booking cancelled',`Booking ${b.ref} cancelled.`,tenantForRoute(b.route_id));return{ok:1}}));
api.post('/exclusive-requests',P,H(req=>{const routeId=+req.body.routeId,{date,time,vtype}=req.body,seats=Number(req.body.seats);if(!one('select 1 x from routes where id=?',routeId))E(400,'Unknown route');requirePassengerTenant(req.u,routeId);if(!validDateTime(date,time))E(400,'Bad date/time');if(!Number.isSafeInteger(seats)||seats<1)E(400,'Passenger count must be a positive whole number');return{id:run('insert into excl(passenger_id,route_id,date,time,vtype,seats) values(?,?,?,?,?,?)',req.u.id,routeId,date,time,vtype||'any',seats).lastInsertRowid,status:'Pending'}}));
api.get('/exclusive-requests',P,H(req=>q('select x.*,r.name route from excl x join routes r on r.id=x.route_id where x.passenger_id=? order by x.id desc',req.u.id)));
api.get('/manager/exclusive',mgr,H(req=>q('select * from excl order by id desc').filter(x=>scope(req.u).includes(x.route_id))));
['approve','reject'].forEach(a=>api.post('/manager/exclusive/:id/'+a,mgr,H(req=>{const x=one('select * from excl where id=?',req.params.id);if(!x||x.status!='Pending')E(409,'Not pending');inScope(req.u,x.route_id);
 const tid=a=='approve'?reserveExcl(x,req.body):null;run('update excl set status=?,manager_id=?,trip_id=? where id=?',a=='approve'?'Approved':'Rejected',req.u.id,tid,x.id);notify(x.passenger_id,'Full-vehicle request',`Your request #${x.id} was ${a}d.`,tenantForRoute(x.route_id));audit(req.u.id,'excl.'+a,'excl',x.id);return{ok:1}})));
// recurring
api.post('/recurring',P,H(req=>{const{routeId,days,arrival,seats,startDate,endDate}=req.body;if(!Array.isArray(days)||!days.length||days.some(d=>!Number.isInteger(d)||d<0||d>6)||!(seats>=1&&seats<=3)||!validTime(arrival)||!validDate(startDate)||!validDate(endDate)||endDate<startDate||!one('select 1 x from routes where id=?',routeId))E(400,'Valid route, days[], arrival, seats(1-3), startDate and endDate are required');requirePassengerTenant(req.u,routeId);
 return{id:run('insert into recurring(passenger_id,route_id,seats,arrival,days,start_date,end_date) values(?,?,?,?,?,?,?)',req.u.id,routeId,seats,arrival,days.join(','),startDate,endDate).lastInsertRowid}}));
api.get('/recurring',P,H(req=>q('select r.*,x.name route from recurring r join routes x on x.id=r.route_id where passenger_id=?',req.u.id)));
const rec=req=>one('select * from recurring where id=? and passenger_id=?',req.params.id,req.u.id)||E(404,'Not found');
const assertUpcomingWeek=w=>{if(!validDate(w)||new Date(w+'T00:00:00Z').getUTCDay()!=1)E(400,'Week must start on a Monday');if(w!=nextMonday())E(409,'Only the next upcoming week can be reviewed or confirmed')};
api.get('/recurring/:id/weekly-review',P,H(req=>{const r=rec(req),week=req.query.week||nextMonday();assertUpcomingWeek(week);return review(r,week)}));
api.post('/recurring/:id/confirm',P,H(req=>db.transaction(()=>{const r=rec(req),{weekStartDate:w,idempotencyKey:k,occurrences:oc}=req.body;assertUpcomingWeek(w);if(r.status!='Active')E(409,'Recurring arrangement is '+r.status);
 const v=review(r,w),c=v.confirmation;if(c.status=='Confirmed'&&c.idem==k)return{ok:1,replayed:true};if(c.status=='Confirmed')E(409,'Week already confirmed');
 if(c.status=='Expired'||(!process.env.NO_DEADLINE&&c.deadline<now()))E(409,'Confirmation deadline passed');
 const ids=[];for(const o of oc||[]){const ok=v.occurrences.find(x=>x.travelDate==o.travelDate);if(!ok)E(400,`${o.travelDate} is not part of this template/week`);if(!(o.seats>=1&&o.seats<=3))E(400,'Seats 1-3');
  if(o.confirmed){const ex=one("select id from bookings where rec_id=? and date=?",r.id,o.travelDate);if(!ex)ids.push(newBooking(req.u,{routeId:r.route_id,date:o.travelDate,arrival:o.expectedArrivalAt||r.arrival,seats:o.seats},'Recurring',r.id))}}
 run("update confirmations set status='Confirmed',confirmed_at=?,idem=? where id=?",now(),k||null,c.id);audit(req.u.id,'recurring.confirm','recurring',r.id,{w,ids});return{ok:1,created:ids.length}})()));
['pause:Paused','resume:Active','cancel:Cancelled'].forEach(s=>{const[a,st]=s.split(':');api.post('/recurring/:id/'+a,P,H(req=>{run('update recurring set status=? where id=?',st,rec(req).id);return{ok:1}}))});
// driver
const DR=ROLE('driver');
api.post('/drivers/profile',DR,H(req=>{const stationId=Number(req.body.stationId),tenantId=tenantForStation(stationId),organizationId=Number(req.body.organizationId)||null,payoutGate=String(req.body.payoutGate||'manager_completion'),existing=one('select station_id,tenant_id,organization_id from drivers where user_id=?',req.u.id);if(!existing)E(403,'Driver profiles are created after an approved invitation');if(!tenantId||!organizationId||!one('select 1 x from org_tenants where organization_id=? and tenant_id=?',organizationId,tenantId))E(400,'Choose an organization connected to the selected terminal');if(req.u.station_id&&req.u.station_id!=stationId||req.u.tenant_id&&req.u.tenant_id!=tenantId||existing.station_id!=stationId||existing.tenant_id!=tenantId||existing.organization_id!=organizationId)E(403,'Driver is already assigned to another terminal, tenant or organization');if(!['onboard','manager_completion'].includes(payoutGate))E(400,'Choose a valid payout timing');run('insert into drivers(user_id,licence,station_id,tenant_id,organization_id,payout_gate) values(?,?,?,?,?,?) on conflict(user_id) do update set licence=excluded.licence,station_id=excluded.station_id,tenant_id=excluded.tenant_id,organization_id=excluded.organization_id,payout_gate=excluded.payout_gate,verified=0',req.u.id,req.body.licence,stationId,tenantId,organizationId,payoutGate);run('update users set station_id=?,tenant_id=?,organization_id=? where id=?',stationId,tenantId,organizationId,req.u.id);notifyMgrs('Document verification',`Driver ${req.u.name} submitted profile details; review the licence and vehicle documents.`,null,stationId);return{ok:1}}));
const vehicleAccess=(user,id,includeDeleted=false)=>{const vehicle=one('select v.*,d.tenant_id driver_tenant_id,d.station_id driver_station_id,d.organization_id driver_organization_id from vehicles v join drivers d on d.user_id=v.driver_id where v.id=?',id);if(!vehicle||!includeDeleted&&vehicle.deleted_at)E(404,'Vehicle not found');if(user.role=='driver'&&vehicle.driver_id!=user.id)E(404,'Vehicle not found');if(STATION_STAFF.includes(user.role))chkDrv(user,vehicle.driver_id);return vehicle};
const vehicleInput=body=>{const reg=String(body.reg||'').toUpperCase().replace(/\s/g,''),type=String(body.type||'').trim(),capacity=Number(body.capacity);if(reg.length<2||reg.length>20||!/^[A-Z0-9-]+$/.test(reg)||!type||type.length>60||!Number.isSafeInteger(capacity)||capacity<1||capacity>100)E(400,'Valid registration, vehicle type, and capacity (1-100) are required');return{reg,type,capacity}};
api.post('/vehicles',DR,PERM('vehicles.create','driver'),H(req=>{const vehicle=vehicleInput(req.body);if(!one('select 1 x from drivers where user_id=?',req.u.id))E(409,'Submit driver profile first');if(one('select count(*) n from vehicles where driver_id=? and deleted_at is null',req.u.id).n>=cfg('max_vehicles',null,2))E(409,'Vehicle limit reached');return{id:run('insert into vehicles(driver_id,reg,type,capacity) values(?,?,?,?)',req.u.id,vehicle.reg,vehicle.type,vehicle.capacity).lastInsertRowid}}));
api.get('/vehicles/me',DR,PERM('vehicles.read','driver'),H(r=>q(`select v.*,d.licence from vehicles v join drivers d on d.user_id=v.driver_id where v.driver_id=?${r.query.includeArchived=='1'?'':' and v.deleted_at is null'} order by v.id`,r.u.id)));
api.patch('/vehicles/:id',PERM('vehicles.update','driver','manager','accountant'),H(req=>{const vehicle=vehicleAccess(req.u,req.params.id),input=vehicleInput(req.body),activeSeats=one("select coalesce(max((select coalesce(sum(a.seats),0) from assignments a where a.trip_id=t.id and a.status in"+ACTIVE+")),0) seats from trips t where t.vehicle_id=? and t.status in('Planned','Loading','Departed','Delayed')",vehicle.id).seats;if(input.capacity<activeSeats)E(409,'Capacity cannot be below seats committed to active trips');run('update vehicles set reg=?,type=?,capacity=? where id=?',input.reg,input.type,input.capacity,vehicle.id);audit(req.u.id,'vehicle.update','vehicle',vehicle.id,input);return{ok:1}}));
api.delete('/vehicles/:id',PERM('vehicles.deactivate','driver','manager','accountant'),H(req=>{const vehicle=vehicleAccess(req.u,req.params.id);if(one("select 1 x from trips where vehicle_id=? and status in('Planned','Loading','Departed','Delayed')",vehicle.id))E(409,'Vehicle has an active trip and cannot be archived');run("update vehicles set deleted_at=?,status='Maintenance',docs_ok=0 where id=?",now(),vehicle.id);syncDriverVerification(vehicle.driver_id,req.u.id);audit(req.u.id,'vehicle.deactivate','vehicle',vehicle.id);return{ok:1,message:'Vehicle archived.'}}));
api.post('/vehicles/:id/restore',PERM('vehicles.update','driver','manager','accountant'),H(req=>{const vehicle=vehicleAccess(req.u,req.params.id,true);if(!vehicle.deleted_at)E(409,'Vehicle is already active');if(one('select count(*) n from vehicles where driver_id=? and deleted_at is null',vehicle.driver_id).n>=cfg('max_vehicles',null,2))E(409,'Driver is at the active vehicle limit');if(one('select deleted_at from users where id=?',vehicle.driver_id).deleted_at)E(409,'Vehicle owner is deactivated');run("update vehicles set deleted_at=null,status='Maintenance',docs_ok=0 where id=?",vehicle.id);syncDriverVerification(vehicle.driver_id,req.u.id);audit(req.u.id,'vehicle.restore','vehicle',vehicle.id);return{ok:1,message:'Vehicle restored. Re-verify its documents before dispatch.'}}));
api.post('/vehicles/:id/status',PERM('vehicles.update','driver','manager','accountant'),H(req=>{const v=vehicleAccess(req.u,req.params.id),{status:s}=req.body;
 if(!['Available','Maintenance'].includes(s))E(400,'Use Available or Maintenance');if(s=='Available'&&one("select 1 x from trips where vehicle_id=? and status in('Departed','Loading')",v.id))E(409,'Vehicle on active trip');
 run('update vehicles set status=? where id=?',s,v.id);if(s=='Available')run("update drivers set op_status='Available' where user_id=? and op_status in('Returning','OnTrip')",v.driver_id);audit(req.u.id,'vehicle.'+s,'vehicle',v.id);if(s=='Available')allocate();return{ok:1}}));
api.put('/drivers/me/payout',DR,H(req=>{const partner=String(req.body.partner||'').trim().toUpperCase(),phone=normalizePhone(req.body.phone||req.u.phone);
 if(!isSupportedPayPartner(paymentProvider,partner)||!phone)E(400,'Choose a supported mobile-money network and valid payout number');
 run('update drivers set payout_partner=?,payout_msisdn=? where user_id=?',partner,normalizeMsisdn(phone),req.u.id);return{ok:1}}));
api.post('/drivers/me/availability',DR,H(req=>{const{dow,st,en}=req.body;if(!Number.isInteger(dow)||dow<0||dow>6||!validTime(st)||!validTime(en)||st>=en)E(400,'Invalid window (start<end, dow 0-6)');return{id:run('insert into availability(driver_id,dow,st,en) values(?,?,?,?)',req.u.id,dow,st,en).lastInsertRowid}}));
api.delete('/drivers/me/availability/:id',DR,H(req=>{run('delete from availability where id=? and driver_id=?',req.params.id,req.u.id);return{ok:1}}));
api.get('/drivers/me/availability',DR,H(r=>({weekly:q('select * from availability where driver_id=? order by dow,st',r.u.id),exceptions:q('select * from avail_ex where driver_id=? order by id desc',r.u.id)})));
api.get('/drivers/me/dispatch-overview',DR,H(req=>{
 const driver=one('select station_id from drivers where user_id=?',req.u.id),today=new Date().toISOString().slice(0,10);
 if(!driver?.station_id)return{queue:[],waitingPassengers:0};
 const queue=q(`select r.name route,b.date,count(*) requests,sum(b.seats) passengers from bookings b join routes r on r.id=b.route_id where b.status='Queued' and b.payment_status in${DISPATCHABLE_SQL} and r.origin_id=? and b.date>=? group by b.route_id,b.date,r.name order by b.date,r.name`,driver.station_id,today);
 return{queue,waitingPassengers:queue.reduce((sum,row)=>sum+row.passengers,0)};
}));
api.post('/drivers/me/availability-exceptions',DR,H(req=>{const{startAt,endAt,reason}=req.body;if(!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(startAt||'')||!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(endAt||'')||!validDateTime(startAt.slice(0,10),startAt.slice(11))||!validDateTime(endAt.slice(0,10),endAt.slice(11))||startAt>=endAt||!String(reason||'').trim())E(400,'Valid startAt<endAt and reason required');
 const id=run('insert into avail_ex(driver_id,start_at,end_at,reason) values(?,?,?,?)',req.u.id,startAt,endAt,reason).lastInsertRowid;notifyMgrs('Availability request',`${req.u.name} requests unavailability ${startAt} to ${endAt}: ${reason}`,null,one('select station_id from drivers where user_id=?',req.u.id)?.station_id);return{id,status:'Pending'}})); // Pending never changes approved availability
api.get('/drivers/me/assignments',DR,H(r=>q("select t.*,ro.name route,v.capacity,v.capacity-(select coalesce(sum(seats),0) from assignments a where a.trip_id=t.id and a.status in"+ACTIVE+") free,(select group_concat(b.ref||' x'||a.seats) from assignments a join bookings b on b.id=a.booking_id where a.trip_id=t.id and a.status in"+ACTIVE+") passengers,(select coalesce(sum(seats),0) from assignments a where a.trip_id=t.id and a.status in"+ACTIVE+") seats from trips t join routes ro on ro.id=t.route_id join vehicles v on v.id=t.vehicle_id where t.driver_id=? order by dep_at desc",r.u.id)));
api.post('/drivers/me/trips/:id/status',DR,H(req=>{tripStatus(+req.params.id,req.body.status,req.u);return{ok:1}}));
api.post('/drivers/me/trips/:id/acknowledge',DR,H(req=>{run("update assignments set status='Confirmed' where trip_id=? and status='Reserved' and trip_id in(select id from trips where driver_id=?)",req.params.id,req.u.id);
 q('select booking_id from assignments where trip_id=? and status=\'Confirmed\'',req.params.id).forEach(a=>setB(a.booking_id,'Confirmed',req.u.id,'driver acknowledged'));return{ok:1}}));
// manager
api.get('/manager/dashboard',mgr,H(req=>{const rs=scope(req.u),routeIds=rs.join(',')||0,inr=x=>rs.includes(x.route_id||x.routeId),sf=x=>!STATION_STAFF.includes(req.u.role)||(req.u.organization_id?x.organization_id==req.u.organization_id:req.u.tenant_id?x.tenant_id==req.u.tenant_id:!!req.u.station_id&&x.station_id==req.u.station_id);
 const trips=q("select t.*,ro.name route,u.name driver,v.reg,v.capacity from trips t join routes ro on ro.id=t.route_id join users u on u.id=t.driver_id join vehicles v on v.id=t.vehicle_id where t.status in('Planned','Loading','Delayed','Departed') order by dep_at").filter(inr);
 trips.forEach(t=>{t.free=freeSeats(t.id);t.assignments=q("select a.id,a.booking_id,a.seats,a.status,a.method,a.onboard_confirmed,b.ref,b.payment_status,u.name passenger from assignments a join bookings b on b.id=a.booking_id join users u on u.id=b.passenger_id where a.trip_id=? and a.status in"+ACTIVE,t.id)});
 const queue=q(`select b.*,r.name route from bookings b join routes r on r.id=b.route_id where b.status='Queued' and b.payment_status in${DISPATCHABLE_SQL} order by id`).filter(inr);
 const vehicles=hasPermission(req.u,'vehicles.read')?q('select v.*,u.name driver,d.licence,d.op_status,d.verified,d.station_id,d.tenant_id,d.organization_id,d.payout_gate,d.payout_gate_override from vehicles v join users u on u.id=v.driver_id join drivers d on d.user_id=v.driver_id where u.deleted_at is null').filter(sf):[];
 const users=hasPermission(req.u,'users.read')?managerUsers(req.u):[],vehicleDrivers=hasPermission(req.u,'vehicles.create')?q('select d.user_id id,u.name,d.station_id,d.tenant_id,d.organization_id from drivers d join users u on u.id=d.user_id where u.deleted_at is null').filter(sf):[],userPermissions=Object.fromEntries(ACCESS_PERMISSIONS.map(p=>[p,hasPermission(req.u,p)]));
 const settlements=q("select t.id,t.route_id,t.dep_at,t.status,r.name route,u.name driver from trips t join routes r on r.id=t.route_id join users u on u.id=t.driver_id where t.status='Completed' and t.settlement_confirmed_at is null").filter(inr);
 settlements.forEach(t=>{t.assignments=q("select a.booking_id,a.seats,a.onboard_confirmed,b.ref,b.payment_status,u.name passenger from assignments a join bookings b on b.id=a.booking_id join users u on u.id=b.passenger_id where a.trip_id=? and a.status in('Boarded','Completed')",t.id)});
 return{queue,queueSeats:queue.reduce((sum,b)=>sum+b.seats,0),queueBookings:queue.length,
 demand:q(`select r.name route,b.date,b.arrival,sum(b.seats) seats from bookings b join routes r on r.id=b.route_id where b.route_id in(${routeIds}) and b.status in('Queued','Assigned','Confirmed') group by b.route_id,r.name,b.date,b.arrival`),
 tripCounts:{standby:trips.filter(t=>t.status=='Planned').length,loading:trips.filter(t=>t.status=='Loading').length,away:trips.filter(t=>['Departed','Delayed'].includes(t.status)).length},
 vehicleCounts:{available:vehicles.filter(v=>!v.deleted_at&&v.status=='Available'&&v.docs_ok&&v.verified).length,loading:vehicles.filter(v=>!v.deleted_at&&v.status=='Loading').length,away:vehicles.filter(v=>!v.deleted_at&&['OnRound','Returning'].includes(v.status)).length},
 requests:q(`select b.ref,b.date,b.arrival,b.seats,b.status,b.payment_status,r.name route,u.name passenger from bookings b join routes r on r.id=b.route_id join users u on u.id=b.passenger_id where b.route_id in(${routeIds}) and b.status not in('Completed','Cancelled','NoShow') order by b.id desc limit 100`),
 history:q(`select b.ref,b.date,b.arrival,b.seats,b.status,b.payment_status,r.name route,u.name passenger,b.created from bookings b join routes r on r.id=b.route_id join users u on u.id=b.passenger_id where b.route_id in(${routeIds}) order by b.id desc limit 100`),
 trips,settlements,surge:surge().filter(inr),vehicles,users,vehicleDrivers,userPermissions,
 schedules:q('select u.name driver,v.reg,a.dow,a.st,a.en,d.station_id,d.tenant_id,d.organization_id from availability a join drivers d on d.user_id=a.driver_id join users u on u.id=d.user_id left join vehicles v on v.driver_id=d.user_id').filter(sf),
 exceptions:q("select e.*,u.name,(select station_id from drivers where user_id=e.driver_id) station_id,(select tenant_id from drivers where user_id=e.driver_id) tenant_id,(select organization_id from drivers where user_id=e.driver_id) organization_id from avail_ex e join users u on u.id=e.driver_id").filter(sf),docs:q("select d.*,u.name owner,(select station_id from drivers where user_id=d.owner_id) station_id,(select tenant_id from drivers where user_id=d.owner_id) tenant_id,(select organization_id from drivers where user_id=d.owner_id) organization_id from docs d join users u on u.id=d.owner_id where d.status='Pending'").filter(sf),exclusive:q("select * from excl").filter(inr),blocked:q(`select id,name,phone,noshow_blocked_until from users where noshow_blocked_until>? and id in(select passenger_id from bookings where route_id in(${routeIds}))`,Date.now()).map(u=>({...u,until:new Date(u.noshow_blocked_until).toISOString().slice(0,10)}))}}));
api.post('/manager/drivers/:id/status',mgr,H(req=>{const id=+req.params.id;chkDrv(req.u,id);if(!one('select 1 x from drivers where user_id=?',id))E(404,'Driver not found');if(!['Available','Suspended','TemporarilyUnavailable'].includes(req.body.status))E(400,'Invalid driver status');run('update drivers set op_status=? where user_id=?',req.body.status,id);audit(req.u.id,'driver.status','driver',id,req.body);return{ok:1}}));
api.put('/manager/drivers/:id/payout-timing',mgr,H(req=>{const id=+req.params.id,override=req.body.override;chkDrv(req.u,id);if(!one('select 1 x from drivers where user_id=?',id))E(404,'Driver not found');if(override!==null&&!['onboard','manager_completion'].includes(override))E(400,'Choose a valid payout timing override or clear it');run('update drivers set payout_gate_override=? where user_id=?',override,id);notify(id,'Payout timing',override?`Your station manager set payout timing to ${override=='onboard'?'onboard confirmation':'manager completion'}.`:'Your driver-selected payout timing is now active.');audit(req.u.id,'driver.payout_timing.override','driver',id,{override});return{ok:1,payout_gate_override:override}}));
api.post('/manager/drivers/:id/availability',mgr,H(req=>{const id=+req.params.id,{dow,st,en}=req.body;chkDrv(req.u,id);if(!Number.isInteger(dow)||dow<0||dow>6||!validTime(st)||!validTime(en)||st>=en)E(400,'Invalid availability window');run('insert into availability(driver_id,dow,st,en) values(?,?,?,?)',id,dow,st,en);notify(id,'Schedule changed','Your weekly availability was updated by a manager.');audit(req.u.id,'availability.set','driver',id,req.body);return{ok:1}}));
['approve','reject'].forEach(a=>api.post('/manager/availability-exceptions/:id/'+a,mgr,H(req=>{const e=one('select * from avail_ex where id=?',req.params.id);if(!e||e.status!='Pending')E(409,'Not pending');chkDrv(req.u,e.driver_id);
 if(a=='approve'){const c=q("select * from trips where driver_id=? and status in('Planned','Loading') and dep_at<? and dep_at>=?",e.driver_id,e.end_at,e.start_at);if(c.length)E(409,'Conflicts with trips '+c.map(t=>'#'+t.id)+'; resolve (cancel/reassign) first')}
 run('update avail_ex set status=?,reviewed_by=?,comment=? where id=?',a=='approve'?'Approved':'Rejected',req.u.id,req.body.comment||'',e.id);notify(e.driver_id,'Availability request',`Your request was ${a}d.`);audit(req.u.id,'exception.'+a,'avail_ex',e.id);return{ok:1}})));
api.post('/manager/trips',mgr,H(req=>{const{routeId,driverId,vehicleId,date,time}=req.body;inScope(req.u,routeId);chkDrv(req.u,+driverId);if(!validDateTime(date,time))E(400,'Bad date/time');const v=one('select * from vehicles where id=? and driver_id=? and deleted_at is null',vehicleId,driverId);if(!v)E(400,'Vehicle does not belong to driver');
 if(!eligible(driverId,v,date,mins(time),+routeId))E(409,'Driver/vehicle not eligible for this terminal (verification, availability, status or overlap)');
 const id=run('insert into trips(route_id,driver_id,vehicle_id,dep_at) values(?,?,?,?)',routeId,driverId,vehicleId,date+'T'+time).lastInsertRowid;notify(driverId,'Trip assignment',`Trip #${id} at ${date} ${time}`);audit(req.u.id,'trip.create','trip',id);allocate();return{id}}));
api.post('/manager/trips/:id/status',mgr,H(req=>{const t=one('select route_id from trips where id=?',req.params.id);if(!t)E(404,'No such trip');inScope(req.u,t.route_id);tripStatus(+req.params.id,req.body.status,req.u);return{ok:1}}));
api.post('/manager/allocate',mgr,H(()=>({allocated:allocate()})));
api.post('/manager/assignments/:id/override',mgr,H(req=>db.transaction(()=>{const{tripId,reason}=req.body;if(!reason)E(400,'Reason required');const a=one('select * from assignments where id=?',req.params.id),t=one('select * from trips where id=?',tripId);
 if(!a||!t)E(404,'Not found');const b=one('select * from bookings where id=?',a.booking_id);inScope(req.u,b.route_id);if(a.status=='Boarded')E(409,'Boarded passengers cannot be reassigned');if(!['Planned','Loading'].includes(t.status))E(409,'Target trip not open');
 if(t.route_id!=b.route_id)E(409,'Route mismatch');run("update assignments set status='Reassigned' where id=?",a.id);assign(t,b,'Manual',req.u.id,reason);audit(req.u.id,'assignment.override','assignment',a.id,{tripId,reason});return{ok:1}})()));
api.get('/manager/audit',mgr,H(req=>{const staff=STATION_STAFF.includes(req.u.role),f=req.query,[l0,o0]=pg(req),cv=f.format=='csv',l=cv?5000:l0,o=cv?0:o0,w=[],a=[];
 if(staff&&req.u.organization_id){w.push('organization_id=?');a.push(req.u.organization_id)}else if(staff&&req.u.tenant_id){w.push('tenant_id=?');a.push(req.u.tenant_id)}else if(staff&&req.u.station_id){w.push('station_id=?');a.push(req.u.station_id)}else if(staff)return[];if(f.action){w.push('action like ?');a.push(f.action+'%')}if(f.entity){w.push('entity=?');a.push(f.entity)}if(f.actor){w.push('actor=?');a.push(+f.actor)}if(f.from){w.push('at>=?');a.push(f.from)}if(f.to){w.push('at<=?');a.push(f.to+'T99')}
 const W=w.length?' where '+w.join(' and '):'';req.res.set('X-Total-Count',one('select count(*) n from audit'+W,...a).n);return rep(req,q('select id,at,actor,(select name from users where id=actor) actor_name,action,entity,eid,meta from audit'+W+' order by id desc limit ? offset ?',...a,l,o))}));
// admin
const AD=ROLE('admin');
const userTenantScope=(role,b)=>{let stationId=null,tenantId=null,organizationId=null;if(role=='passenger')return{stationId:null,tenantId:null,organizationId:null};else if(['manager','accountant'].includes(role)){stationId=Number(b.stationId)||null;tenantId=Number(b.tenantId)||null;organizationId=Number(b.organizationId)||null;if(organizationId&&!one('select 1 x from organizations where id=?',organizationId))E(400,'Choose a valid organization');if(tenantId&&!one('select 1 x from tenants where id=?',tenantId))E(400,'Choose a valid tenant');if(stationId&&!tenantForStation(stationId))E(400,'Choose a valid terminal');if(stationId&&tenantId&&tenantForStation(stationId)!=tenantId)E(400,'Terminal must belong to the selected tenant');if([tenantId,organizationId].filter(Boolean).length>1||organizationId&&stationId||tenantId&&stationId)E(400,'Choose one manager scope: organization or tenant');if(!tenantId&&!organizationId&&!stationId)E(400,'Choose an organization or tenant scope for this role')}else if(['porter','driver'].includes(role)&&b.stationId){stationId=Number(b.stationId);tenantId=tenantForStation(stationId);organizationId=role=='driver'?Number(b.organizationId)||null:null;if(!tenantId)E(400,'Choose a valid terminal');if(organizationId&&!one('select 1 x from org_tenants where organization_id=? and tenant_id=?',organizationId,tenantId))E(400,'Choose an organization connected to this terminal')}else if(role=='porter')E(400,'A valid terminal is required for this role');return{stationId,tenantId,organizationId}};
const createStation=(name,tenantId)=>{for(let attempt=0;attempt<5;attempt++){try{return run('insert into stations(name,tenant_id,code) values(?,?,?)',name,tenantId,stationCode(name)).lastInsertRowid}catch(e){if(!String(e.message).includes('stations.code'))throw e}}E(409,'Could not generate a unique station code; try again')};
const createOrganizationRoute=(organizationId,originId,destId,fareGhs)=>{const org=one('select id from organizations where id=?',organizationId),origin=one('select id,name,tenant_id from stations where id=?',originId),dest=one('select id,name from stations where id=?',destId),fare=Number(fareGhs);if(!org||!origin||!dest||originId===destId)E(400,'Choose an organization and two different stations');if(!one('select 1 x from org_tenants where organization_id=? and tenant_id=?',organizationId,origin.tenant_id))E(403,'The organization is not connected to the selected origin tenant');if(!Number.isFinite(fare)||toPesewas(fare)<=0||fare>100000)E(400,'Fare must be positive');if(one('select 1 x from routes where organization_id=? and origin_id=? and dest_id=?',organizationId,originId,destId))E(409,'This organization already has this route');
 const name=`${origin.name} -> ${dest.name}`,id=run('insert into routes(tenant_id,organization_id,origin_id,dest_id,name) values(?,?,?,?,?)',origin.tenant_id,organizationId,originId,destId,name).lastInsertRowid;run('insert into config(scope,key,value) values(?,?,?)','route:'+id,'fare_ghs',fare.toFixed(2));return{id,originId,destId,name,fareGhs:fare}};
const terminalName=value=>{const name=String(value||'').trim();if(!name||name.length>100)E(400,'Terminal name is required (100 characters maximum)');if(one('select 1 x from stations where name=? collate nocase',name))E(409,'A terminal with this name already exists');return name};
api.get('/admin/tenants',AD,H(()=>q('select t.id,t.name,t.hub_station_id,s.code station_code,t.created_at,(select count(*) from stations x where x.tenant_id=t.id) terminals,(select count(*) from routes r where r.tenant_id=t.id) routes from tenants t left join stations s on s.id=t.hub_station_id order by t.name')));
api.post('/admin/tenants',AD,H(req=>{const name=terminalName(req.body.name);if(one('select 1 x from tenants where name=? collate nocase',name))E(409,'A tenant with this name already exists');return db.transaction(()=>{const tenantId=run('insert into tenants(name) values(?)',name).lastInsertRowid,stationId=createStation(name,tenantId);run('update tenants set hub_station_id=? where id=?',stationId,tenantId);audit(req.u.id,'tenant.create','tenant',tenantId,{name,stationId,code:one('select code from stations where id=?',stationId).code});return{tenantId,stationId}})()}));
api.get('/admin/organizations',AD,H(()=>q('select o.id,o.name,o.created_at,(select group_concat(t.name, \', \') from org_tenants ot join tenants t on t.id=ot.tenant_id where ot.organization_id=o.id) tenants,(select count(*) from routes r where r.organization_id=o.id) routes from organizations o order by o.name')));
api.get('/manager/organizations',mgr,H(req=>{if(req.u.organization_id)return q('select id,name from organizations where id=? order by name',req.u.organization_id);const tenantId=req.u.tenant_id||tenantForStation(req.u.station_id);return tenantId?q('select o.id,o.name from organizations o join org_tenants ot on ot.organization_id=o.id where ot.tenant_id=? order by o.name',tenantId):[]}));
api.post('/admin/organizations',AD,H(req=>{const name=String(req.body.name||'').trim(),tenantIds=Array.isArray(req.body.tenantIds)?[...new Set(req.body.tenantIds.map(Number))]:[];if(!name||name.length>100||one('select 1 x from organizations where name=? collate nocase',name))E(400,'Organization name is required and must be unique');if(!tenantIds.length||tenantIds.some(id=>!Number.isSafeInteger(id)||!one('select 1 x from tenants where id=?',id)))E(400,'Select at least one valid tenant');return db.transaction(()=>{const id=run('insert into organizations(name) values(?)',name).lastInsertRowid;for(const tenantId of tenantIds)run('insert into org_tenants(organization_id,tenant_id) values(?,?)',id,tenantId);audit(req.u.id,'organization.create','organization',id,{name,tenantIds});return{id,name,tenantIds}})()}));
api.patch('/admin/organizations/:id',AD,H(req=>{const id=+req.params.id,name=String(req.body.name||'').trim();if(!one('select 1 x from organizations where id=?',id))E(404,'Organization not found');if(!name||name.length>100||one('select 1 x from organizations where name=? collate nocase and id!=?',name,id))E(400,'Organization name must be unique');run('update organizations set name=? where id=?',name,id);audit(req.u.id,'organization.rename','organization',id,{name});return{ok:1}}));
api.post('/admin/organizations/:id/tenants',AD,H(req=>{const organizationId=+req.params.id,tenantId=Number(req.body.tenantId);if(!one('select 1 x from organizations where id=?',organizationId)||!one('select 1 x from tenants where id=?',tenantId))E(404,'Organization or tenant not found');run('insert or ignore into org_tenants(organization_id,tenant_id) values(?,?)',organizationId,tenantId);audit(req.u.id,'organization.tenant.add','organization',organizationId,{tenantId});return{ok:1}}));
api.post('/admin/tenants/:id/terminals',AD,H(req=>{const tenantId=+req.params.id,name=terminalName(req.body.name);if(!one('select 1 x from tenants where id=?',tenantId))E(404,'Tenant not found');return db.transaction(()=>{const id=createStation(name,tenantId);audit(req.u.id,'terminal.create','station',id,{tenantId,name,code:one('select code from stations where id=?',id).code});return{id}})()}));
api.post('/admin/stations',AD,H(req=>{const name=terminalName(req.body.name),tenantId=+req.body.tenantId;if(!one('select 1 x from tenants where id=?',tenantId))E(400,'A valid tenant is required');const id=createStation(name,tenantId);audit(req.u.id,'terminal.create','station',id,{tenantId,name});return{id}}));
const stationCoordinates=body=>{const latitude=body.latitude===''||body.latitude==null?null:Number(body.latitude),longitude=body.longitude===''||body.longitude==null?null:Number(body.longitude);if(latitude===null&&longitude===null)return{latitude,longitude};if(latitude===null||longitude===null||!Number.isFinite(latitude)||latitude< -90||latitude>90||!Number.isFinite(longitude)||longitude< -180||longitude>180)E(400,'Enter both valid station coordinates (latitude -90 to 90, longitude -180 to 180)');return{latitude,longitude}};
api.put('/admin/stations/:id/location',AD,H(req=>{const station=one('select id from stations where id=?',req.params.id);if(!station)E(404,'Station not found');const{latitude,longitude}=stationCoordinates(req.body);run('update stations set latitude=?,longitude=? where id=?',latitude,longitude,station.id);audit(req.u.id,'station.location.configure','station',station.id,{latitude,longitude});return{ok:1}}));
api.put('/manager/stations/:id/location',mgr,H(req=>{const id=+req.params.id;if(!req.u.tenant_id||req.u.organization_id||!stationInScope(req.u,id))E(403,'Only a tenant administrator can update coordinates for a station in their tenant');const{latitude,longitude}=stationCoordinates(req.body);run('update stations set latitude=?,longitude=? where id=?',latitude,longitude,id);audit(req.u.id,'station.location.configure','station',id,{latitude,longitude});return{ok:1}}));
const applicationForManager=(user,id)=>{const app=one(`select a.*,i.role,i.tenant_id,i.station_id,i.organization_id,i.expires_at,i.created_by,s.name station_name,t.name tenant_name,o.name organization_name from onboarding_applications a join onboarding_invitations i on i.id=a.invitation_id join stations s on s.id=i.station_id join tenants t on t.id=i.tenant_id left join organizations o on o.id=i.organization_id where a.id=?`,id);if(!app)E(404,'Application not found');if(!stationInScope(user,app.station_id)||user.organization_id&&app.organization_id!=user.organization_id)E(403,'Application is outside your tenant or organization scope');return app};
api.post('/manager/onboarding/invitations',ROLE('manager'),PERM('onboarding.invite','manager'),H(async req=>{const role=String(req.body.role||''),tenantId=req.u.role=='admin'?Number(req.body.tenantId):tenantForUser(req.u),stationId=Number(req.body.stationId)||(req.u.station_id||one('select hub_station_id from tenants where id=?',tenantId)?.hub_station_id),organizationId=Number(req.body.organizationId)||null,durationDays=req.body.durationDays===undefined?7:Number(req.body.durationDays),useMode=String(req.body.useMode||'single');if(!['driver','porter'].includes(role))E(400,'Choose driver or porter');if(!Number.isSafeInteger(durationDays)||durationDays<1||durationDays>365)E(400,'Invitation duration must be from 1 to 365 days');if(!['single','multiple'].includes(useMode))E(400,'Choose single-use or multiple-use');if(!tenantId||!one('select 1 x from tenants where id=?',tenantId))E(400,'Choose a valid tenant');if(req.u.role!='admin'&&(!req.u.tenant_id||req.u.organization_id||tenantId!=req.u.tenant_id))E(403,'Only a tenant administrator can issue staff invitations');if(!stationId||tenantForStation(stationId)!=tenantId||req.u.role!='admin'&&!stationInScope(req.u,stationId))E(403,'Station is outside the tenant scope');if(role=='driver'&&(!organizationId||!one('select 1 x from org_tenants where organization_id=? and tenant_id=?',organizationId,tenantId)))E(400,'Choose an organization connected to the selected station');if(role=='porter'&&organizationId)E(400,'Porter invitations are station-scoped, not organization-scoped');const baseUrl=invitationBaseUrl(req);if(!baseUrl)E(503,'Set APP_BASE_URL to the public HTTPS address before issuing invitations');const token=cr.randomBytes(32).toString('hex'),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+durationDays*864e5).toISOString(),id=run('insert into onboarding_invitation_links(token_hash,token_encrypted,role,tenant_id,station_id,organization_id,created_by,created_at,expires_at,use_mode) values(?,?,?,?,?,?,?,?,?,?)',sha('invite:'+token),encryptSetting(token),role,tenantId,stationId,organizationId,req.u.id,createdAt,expiresAt,useMode).lastInsertRowid;const url=new URL(`/?invite=${token}`,baseUrl).toString(),qrDataUrl=await QRCode.toDataURL(url,{errorCorrectionLevel:'M',margin:1,width:280});audit(req.u.id,'onboarding.invitation.create','onboarding_invitation_link',id,{role,tenantId,stationId,organizationId,expiresAt,durationDays,useMode});return{id,role,stationId,tenantId,organizationId,durationDays,useMode,useCount:0,expiresAt,url,qrDataUrl}}));
api.get('/manager/onboarding/invitations',ROLE('manager'),PERM('onboarding.read','manager'),H(async req=>{const inScope=inv=>stationInScope(req.u,inv.station_id)&&(!req.u.organization_id||inv.organization_id==req.u.organization_id),legacy=q(`select i.id,i.role,i.tenant_id,i.station_id,i.organization_id,i.created_at,i.expires_at,i.revoked_at,i.submitted_at,s.name station,o.name organization,a.status application_status from onboarding_invitations i join stations s on s.id=i.station_id left join organizations o on o.id=i.organization_id left join onboarding_applications a on a.invitation_id=i.id where i.link_id is null`).filter(inScope).map(inv=>({...inv,recordType:'legacy',use_mode:'single',use_count:inv.submitted_at?1:0})),links=q(`select i.id,i.token_encrypted,i.role,i.tenant_id,i.station_id,i.organization_id,i.created_at,i.expires_at,i.revoked_at,i.use_mode,i.use_count,s.name station,o.name organization,(select count(*) from onboarding_invitations x join onboarding_applications a on a.invitation_id=x.id where x.link_id=i.id) applications_count from onboarding_invitation_links i join stations s on s.id=i.station_id left join organizations o on o.id=i.organization_id`).filter(inScope),baseUrl=invitationBaseUrl(req);if(links.length&&!baseUrl)E(503,'Set APP_BASE_URL to restore invitation links and QR codes');const previews=await Promise.all(links.map(async link=>{const token=decryptSetting(link.token_encrypted),url=new URL(`/?invite=${token}`,baseUrl).toString();return{...link,recordType:'link',url,qrDataUrl:await QRCode.toDataURL(url,{errorCorrectionLevel:'M',margin:1,width:280})}}));return[...legacy,...previews]}));
api.post('/manager/onboarding/invitations/:id/revoke',ROLE('manager'),PERM('onboarding.invite','manager'),H(req=>{const inv=one('select * from onboarding_invitations where id=?',req.params.id);if(!inv)E(404,'Invitation not found');if(!stationInScope(req.u,inv.station_id)||req.u.organization_id&&inv.organization_id!=req.u.organization_id)E(403,'Invitation is outside your tenant or organization scope');if(inv.revoked_at)E(409,'Invitation is already revoked');if(inv.submitted_at||invitationApplication(inv.id))E(409,'An application has already been submitted for this invitation');run('update onboarding_invitations set revoked_at=? where id=?',new Date().toISOString(),inv.id);audit(req.u.id,'onboarding.invitation.revoke','onboarding_invitation',inv.id);return{ok:1}}));
api.post('/manager/onboarding/invitation-links/:id/revoke',ROLE('manager'),PERM('onboarding.invite','manager'),H(req=>{const link=one('select * from onboarding_invitation_links where id=?',req.params.id);if(!link)E(404,'Invitation not found');if(!stationInScope(req.u,link.station_id)||req.u.organization_id&&link.organization_id!=req.u.organization_id)E(403,'Invitation is outside your tenant or organization scope');if(link.revoked_at)E(409,'Invitation is already revoked');run('update onboarding_invitation_links set revoked_at=? where id=?',new Date().toISOString(),link.id);audit(req.u.id,'onboarding.invitation.revoke','onboarding_invitation_link',link.id);return{ok:1}}));
api.get('/manager/onboarding/applications',ROLE('manager'),PERM('onboarding.read','manager'),H(req=>q(`select a.id,a.name,a.phone,a.status,a.review_comment,a.submitted_at,a.updated_at,a.form_json,i.role,i.tenant_id,i.station_id,i.organization_id,s.name station,o.name organization from onboarding_applications a join onboarding_invitations i on i.id=a.invitation_id join stations s on s.id=i.station_id left join organizations o on o.id=i.organization_id order by a.submitted_at desc`).filter(app=>stationInScope(req.u,app.station_id)&&(!req.u.organization_id||app.organization_id==req.u.organization_id)).map(app=>({...app,form:JSON.parse(app.form_json),documents:q('select id,kind,filename,expires_on,uploaded_at from onboarding_application_documents where application_id=? order by kind',app.id),history:q('select h.status,h.comment,h.created_at,u.name reviewer from onboarding_review_history h left join users u on u.id=h.reviewer_id where h.application_id=? order by h.id',app.id)}))));
api.get('/manager/onboarding/applications/:id/history',ROLE('manager'),PERM('onboarding.read','manager'),H(req=>{const app=applicationForManager(req.u,+req.params.id);return q('select h.status,h.comment,h.created_at,u.name reviewer from onboarding_review_history h left join users u on u.id=h.reviewer_id where h.application_id=? order by h.id',app.id)}));
api.get('/manager/onboarding/applications/:id/documents/:documentId',ROLE('manager'),PERM('onboarding.read','manager'),H((req,res)=>{const app=applicationForManager(req.u,+req.params.id),doc=one('select * from onboarding_application_documents where id=? and application_id=?',req.params.documentId,app.id);if(!doc)E(404,'Application document not found');const filename=path.resolve(UP,doc.path);if(!filename.startsWith(UP+path.sep))E(404,'Application document not found');res.sendFile(filename,{dotfiles:'deny'},error=>{if(error&&!res.headersSent)res.status(error.statusCode||500).json({error:'Could not open application document'})})}));
api.post('/manager/onboarding/applications/:id/review',ROLE('manager'),PERM('onboarding.review','manager'),H(req=>{const app=applicationForManager(req.u,+req.params.id),decision=String(req.body.decision||''),comment=String(req.body.comment||'').trim();if(!['approved','needs_changes','rejected'].includes(decision))E(400,'Choose Approved, Needs changes, or Rejected');if(comment.length>1000)E(400,'Review comments must be 1000 characters or fewer');if(['needs_changes','rejected'].includes(decision)&&!comment)E(400,'A comment is required for Needs changes or Rejected');if(['approved','rejected'].includes(app.status))E(409,'This application has already reached a final decision');const reviewedAt=new Date().toISOString();
 if(decision=='approved')db.transaction(()=>{
  if(one('select 1 x from users where phone=?',app.phone))E(409,'An account already exists for this phone number');
  const userId=run('insert into users(phone,name,role,station_id,tenant_id,organization_id,verified,consent_at,consent_ver) values(?,?,?,?,?,?,1,?,?)',app.phone,app.name,app.role,app.station_id,app.tenant_id,app.organization_id,app.submitted_at,TV).lastInsertRowid;
  if(app.role=='driver'){
   const form=JSON.parse(app.form_json),documents=q('select * from onboarding_application_documents where application_id=?',app.id);if(documents.length!=3)E(409,'Driver application is missing required documents');
   run('insert into drivers(user_id,licence,station_id,tenant_id,organization_id,payout_partner,payout_msisdn,payout_gate) values(?,?,?,?,?,?,?,?)',userId,form.licence,app.station_id,app.tenant_id,app.organization_id,form.payoutPartner,normalizeMsisdn(form.payoutPhone),form.payoutGate);
   const vehicleId=run('insert into vehicles(driver_id,reg,type,capacity) values(?,?,?,?)',userId,form.reg,form.type,form.capacity).lastInsertRowid;
   for(const dow of form.days)run('insert into availability(driver_id,dow,st,en) values(?,?,?,?)',userId,dow,form.startTime,form.endTime);
   for(const doc of documents)run('insert into docs(owner_id,vehicle_id,kind,filename,path,at,expires_on) values(?,?,?,?,?,?,?)',userId,doc.kind=='licence'?null:vehicleId,doc.kind,doc.filename,doc.path,doc.uploaded_at,doc.expires_on)
  }
  run('update onboarding_applications set status=?,review_comment=?,reviewed_by=?,user_id=?,updated_at=? where id=?',decision,comment,req.u.id,userId,reviewedAt,app.id);
  run('insert into onboarding_review_history(application_id,status,comment,reviewer_id,created_at) values(?,?,?,?,?)',app.id,decision,comment,req.u.id,reviewedAt);
  audit(req.u.id,'onboarding.application.approve','onboarding_application',app.id,{role:app.role,tenantId:app.tenant_id,stationId:app.station_id});
  notify(userId,'Onboarding approved','Your application was approved. Use Forgot PIN to create your sign-in PIN.',app.tenant_id)
 })();
 else db.transaction(()=>{run('update onboarding_applications set status=?,review_comment=?,reviewed_by=?,updated_at=? where id=?',decision,comment,req.u.id,reviewedAt,app.id);run('insert into onboarding_review_history(application_id,status,comment,reviewer_id,created_at) values(?,?,?,?,?)',app.id,decision,comment,req.u.id,reviewedAt);audit(req.u.id,'onboarding.application.'+decision,'onboarding_application',app.id,{tenantId:app.tenant_id,stationId:app.station_id})})();
 return{ok:1,status:decision}
}));
api.post('/admin/routes',AD,H(req=>db.transaction(()=>{const organizationId=Number(req.body.organizationId),route=createOrganizationRoute(organizationId,Number(req.body.originId),Number(req.body.destId),req.body.fareGhs);audit(req.u.id,'route.create','route',route.id,{organizationId,fareGhs:route.fareGhs});return{id:route.id}})()));
api.put('/admin/routes/:id/published',AD,H(req=>{const routeId=+req.params.id,published=req.body.published;if(![true,false,0,1].includes(published))E(400,'published must be a boolean');if(!one('select 1 x from routes where id=?',routeId))E(404,'Route not found');run('update routes set published=? where id=?',Number(published),routeId);audit(req.u.id,'route.publication.set','route',routeId,{published:!!published});return{ok:1,published:!!published}}));
api.post('/manager/stations',mgr,H(req=>{if(!req.u.tenant_id||req.u.organization_id)E(403,'Only a tenant-scoped manager can add terminal stations');const name=terminalName(req.body.name);return db.transaction(()=>{const id=createStation(name,req.u.tenant_id);audit(req.u.id,'terminal.create','station',id,{tenantId:req.u.tenant_id,name});return{id}})()}));
api.post('/manager/routes',mgr,H(req=>{if(!req.u.organization_id)E(403,'Routes and fares are managed at organization level');const organizationId=req.u.organization_id,originId=Number(req.body.originId),destId=Number(req.body.destId);if(!one('select 1 x from org_tenants ot join stations s on s.tenant_id=ot.tenant_id where ot.organization_id=? and s.id=?',organizationId,originId))E(403,'Route origin is outside your organization');const route=db.transaction(()=>createOrganizationRoute(organizationId,originId,destId,req.body.fareGhs))();audit(req.u.id,'route.create','route',route.id,{organizationId,fareGhs:route.fareGhs});return route}));
api.put('/manager/routes/:id/published',mgr,PERM('routes.publish','manager'),H(req=>{const routeId=+req.params.id,published=req.body.published;if(!req.u.organization_id)E(403,'Route publication is managed at organization level');if(![true,false,0,1].includes(published))E(400,'published must be a boolean');const route=one('select organization_id from routes where id=?',routeId);if(!route)E(404,'Route not found');if(route.organization_id!=req.u.organization_id)E(403,'Route belongs to another organization');run('update routes set published=? where id=?',Number(published),routeId);audit(req.u.id,'route.publication.set','route',routeId,{published:!!published});return{ok:1,published:!!published}}));
api.post('/admin/users/:id/role',AD,H(req=>{const role=req.body.role;if(!['admin','manager','accountant','driver','passenger','porter'].includes(role))E(400,'Invalid role');const user=one('select id,role,ghana_card_verified from users where id=?',req.params.id);if(!user)E(404,'User not found');if(['driver','porter'].includes(role)&&role!=user.role)E(403,'Drivers and porters must be activated through approved invitations');if(role=='passenger'&&!user.ghana_card_verified)E(409,'Passengers must complete Ghana Card verification before receiving the passenger role');const{stationId,tenantId,organizationId}=userTenantScope(role,req.body);run('update sessions set revoked=1 where user_id=?',req.params.id);run('update users set role=?,station_id=?,tenant_id=?,organization_id=? where id=?',role,stationId,tenantId,organizationId,req.params.id);run('update drivers set organization_id=?,station_id=coalesce(?,station_id),tenant_id=coalesce(?,tenant_id) where user_id=?',organizationId,stationId,tenantId,req.params.id);audit(req.u.id,'role.set','user',+req.params.id,{...req.body,stationId,tenantId,organizationId});return{ok:1}}));
api.get('/admin/role-permissions',AD,H(()=>({roles:ACCESS_ROLES,permissions:ACCESS_PERMISSIONS,grants:q('select role,permission from role_permissions order by role,permission')})));
api.put('/admin/role-permissions',AD,H(req=>{const role=String(req.body.role||''),raw=req.body.permissions;if(!ACCESS_ROLES.includes(role)||!Array.isArray(raw))E(400,'Choose a valid role and permission list');const permissions=[...new Set(raw)];if(permissions.some(p=>!ACCESS_PERMISSIONS.includes(p)))E(400,'Choose a valid role and permission list');db.transaction(()=>{run('delete from role_permissions where role=?',role);for(const permission of permissions)run('insert into role_permissions(role,permission) values(?,?)',role,permission)})();audit(req.u.id,'role.permissions.set','role',role,{permissions});return{ok:1}}));
api.get('/admin/users',AD,H(req=>{const role=String(req.query.role||''),tenantId=Number(req.query.tenantId)||0,includeDeactivated=req.query.includeDeactivated=='1';if(role&&!['admin','manager','accountant','driver','passenger','porter'].includes(role))E(400,'Invalid user role filter');if(tenantId&&!one('select 1 x from tenants where id=?',tenantId))E(400,'Unknown tenant filter');const where=[],args=[];if(role){where.push('u.role=?');args.push(role)}if(tenantId){where.push('(u.tenant_id=? or d.tenant_id=? or s.tenant_id=?)');args.push(tenantId,tenantId,tenantId)}if(!includeDeactivated)where.push('u.deleted_at is null');return q(`select u.id,u.phone,u.name,u.role,u.station_id,u.tenant_id,u.organization_id,u.deleted_at,o.name organization from users u left join organizations o on o.id=u.organization_id left join drivers d on d.user_id=u.id left join stations s on s.id=u.station_id ${where.length?'where '+where.join(' and '):''} order by u.role,u.name`,...args)}));
api.get('/manager/users',mgr,PERM('users.read','manager','accountant'),H(req=>{const users=managerUsers(req.u),includeDeactivated=req.query.includeDeactivated=='1';return users.filter(user=>includeDeactivated||!user.deleted_at).map(({driver_station_id,driver_tenant_id,driver_organization_id,...user})=>user)}));
api.post('/manager/users',mgr,H(()=>E(403,'Tenant staff accounts must use a scoped invitation and pass tenant review.')));
api.patch('/admin/users/:id',AD,H(req=>{const id=+req.params.id,user=one('select id from users where id=? and deleted_at is null',id),name=String(req.body.name||'').trim(),phone=normalizePhone(req.body.phone);if(!user)E(404,'User not found');if(!name||name.length>100||!phone)E(400,'Valid name and phone are required');run('update users set name=?,phone=? where id=?',name,phone,id);audit(req.u.id,'user.update','user',id,{name,phone});return{ok:1}}));
api.patch('/manager/users/:id',mgr,PERM('users.update','manager','accountant'),H(req=>{const id=+req.params.id,user=managerUser(req.u,id),name=String(req.body.name||'').trim(),phone=normalizePhone(req.body.phone);if(!name||name.length>100||!phone)E(400,'Valid name and phone are required');run('update users set name=?,phone=? where id=?',name,phone,user.id);audit(req.u.id,'user.update','user',user.id,{name,phone});return{ok:1}}));
const deactivateUser=(actor,id,checkScope)=>{const user=one('select id,role,deleted_at from users where id=?',id);if(!user)E(404,'User not found');if(user.id==actor.id||user.role=='admin')E(403,'You cannot deactivate this account');if(checkScope)checkScope();if(user.deleted_at)E(409,'User is already deactivated');if(one("select 1 x from trips where driver_id=? and status in('Planned','Loading','Departed','Delayed')",id)||user.role=='passenger'&&one("select 1 x from bookings where passenger_id=? and status in('Queued','Assigned','Confirmed') and date>=?",id,now().slice(0,10)))E(409,'User has an active trip or booking and cannot be deactivated');run('update users set deleted_at=? where id=?',now(),id);run('update sessions set revoked=1 where user_id=?',id);audit(actor.id,'user.deactivate','user',id);return{ok:1,message:'User deactivated.'}};
api.delete('/admin/users/:id',AD,H(req=>deactivateUser(req.u,+req.params.id)));
api.delete('/manager/users/:id',mgr,PERM('users.deactivate','manager','accountant'),H(req=>deactivateUser(req.u,+req.params.id,()=>managerUser(req.u,+req.params.id))));
api.post('/admin/users/:id/restore',AD,H(req=>{const id=+req.params.id;if(!one('select 1 x from users where id=? and deleted_at is not null',id))E(404,'Deactivated user not found');run('update users set deleted_at=null where id=?',id);audit(req.u.id,'user.restore','user',id);return{ok:1}}));
api.post('/manager/users/:id/restore',mgr,PERM('users.update','manager','accountant'),H(req=>{const user=managerUser(req.u,+req.params.id,true);if(!user.deleted_at)E(409,'User is already active');run('update users set deleted_at=null where id=?',user.id);audit(req.u.id,'user.restore','user',user.id);return{ok:1}}));
api.get('/admin/fees',AD,H(()=>{
 const global=Object.fromEntries(FEE_CONFIG_KEYS.map(k=>[k,Number(one('select value from config where scope=? and key=?','global',k)?.value||0)]));
 const getScope=(type,id,keys)=>{const overrides=Object.fromEntries(keys.map(k=>{const x=one('select value from config where scope=? and key=?',type+':'+id,k);return[k,x?Number(x.value):null]})),values=Object.fromEntries(keys.map(k=>[k,overrides[k]??global[k]]));return{values,overrides}};
 const tenants=q('select id,name,hub_station_id from tenants order by name').map(t=>({...t,...getScope('tenant',t.id,['station_fee_pct','platform_fee_pct','driver_station_fee_pct','driver_platform_fee_pct'])}));
 const organizations=q('select id,name from organizations order by name').map(o=>({...o,...getScope('organization',o.id,['loading_fee_pct','driver_loading_fee_pct'])}));
 const fare=Number(cfg('fare_ghs',null,100)),charges=riderCharges(toPesewas(fare),global.station_fee_pct,global.platform_fee_pct),loading=percentageCharge(toPesewas(fare),global.loading_fee_pct);
 return{global,globalSampleFareGhs:fare,globalSampleTotalGhs:ghs(toPesewas(fare)+charges.stationFeePesewas+charges.platformFeePesewas+loading),tenants,stations:tenants,organizations,history:q("select id,at,actor,(select name from users where id=actor) actor_name,meta from audit where action='fees.configure' order by id desc limit 100")}
}));
api.put('/admin/fees',AD,H(req=>{
 let scopeValue=String(req.body.scope||'global');const stationScope=scopeValue.match(/^station:([1-9]\d*)$/);if(stationScope){const tenantId=tenantForStation(+stationScope[1]);if(!tenantId)E(400,'Unknown station scope');scopeValue='tenant:'+tenantId}
 const match=scopeValue.match(/^(tenant|organization):([1-9]\d*)$/),validScope=scopeValue=='global'||!!match&&(match[1]=='tenant'?!!one('select 1 x from tenants where id=?',+match[2]):!!one('select 1 x from organizations where id=?',+match[2]));
 if(!validScope)E(400,'Scope must be global, tenant:ID, or organization:ID');const values=req.body.values;if(!values||typeof values!='object'||Array.isArray(values)||!Object.keys(values).length||Object.keys(values).some(key=>!FEE_CONFIG_KEYS.includes(key)))E(400,'Valid fee percentage values are required');const tenantKeys=['station_fee_pct','platform_fee_pct','driver_station_fee_pct','driver_platform_fee_pct'],organizationKeys=['loading_fee_pct','driver_loading_fee_pct'],allowedKeys=scopeValue=='global'?FEE_CONFIG_KEYS:scopeValue.startsWith('tenant:')?tenantKeys:organizationKeys;if(Object.keys(values).some(key=>!allowedKeys.includes(key)))E(400,'Fee percentage is not configurable at this scope');
 const oldValues={},oldOverrides={},newValues={};for(const[key,raw]of Object.entries(values)){const value=Number(raw);if(!Number.isFinite(value)||value<0||value>100)E(400,`${key} must be between 0 and 100`);const old=one('select value from config where scope=? and key=?',scopeValue,key)?.value??null;oldOverrides[key]=old;oldValues[key]=Number(old??(scopeValue=='global'?0:cfg(key,null,0)));newValues[key]=String(value)}
 db.transaction(()=>{for(const[key,value]of Object.entries(newValues))run('insert into config(scope,key,value) values(?,?,?) on conflict(scope,key) do update set value=excluded.value',scopeValue,key,value);
  audit(req.u.id,'fees.configure','config',0,{scope:scopeValue,oldValues,oldOverrides,newValues})})();
 return{ok:1}
}));
function saveFeeShares(req,scopeType,scopeId,kind,stream,shares){
 const payers=['rider','driver','organization','tenant'],values=shares&&typeof shares=='object'&&!Array.isArray(shares)?shares:{};
 if(!['station','platform','loading'].includes(kind)||!['rider','driver'].includes(stream)||Object.keys(values).some(p=>!payers.includes(p)))E(400,'Invalid fee kind, payment stream or payer');
 const entries=payers.map(payer=>[payer,Number(values[payer]||0)]);if(entries.some(([,pct])=>!Number.isInteger(pct)||pct<0||pct>100)||entries.reduce((sum,[,pct])=>sum+pct,0)!=100)E(400,'Payer percentages must be whole numbers from 0 to 100 and sum to 100');
 const old=q('select payer_type,percentage from fee_share_config where scope_type=? and scope_id=? and fee_kind=? and stream=? order by payer_type',scopeType,scopeId,kind,stream);
 db.transaction(()=>{run('delete from fee_share_config where scope_type=? and scope_id=? and fee_kind=? and stream=?',scopeType,scopeId,kind,stream);for(const[payer,percentage]of entries)if(percentage)run('insert into fee_share_config(scope_type,scope_id,fee_kind,stream,payer_type,percentage,updated_at) values(?,?,?,?,?,?,?)',scopeType,scopeId,kind,stream,payer,percentage,now());audit(req.u.id,'fees.configure','fee_share',0,{scope:scopeType+':'+scopeId,kind,stream,oldValues:old,newValues:entries})})();
 return{ok:1}
}
api.get('/admin/fee-shares',AD,H(()=>q('select scope_type,scope_id,fee_kind,stream,payer_type,percentage from fee_share_config order by scope_type,scope_id,fee_kind,stream,payer_type')));
api.put('/admin/fee-shares',AD,H(req=>{const scope=String(req.body.scope||''),m=scope.match(/^(global|tenant|organization)(?::([1-9]\d*))?$/);if(!m||m[1]=='global'&&m[2]||m[1]!='global'&&!m[2])E(400,'Invalid fee-share scope');const type=m[1],id=Number(m[2]||0),kind=String(req.body.feeKind||'');if(type=='tenant'&&!one('select 1 x from tenants where id=?',id)||type=='organization'&&!one('select 1 x from organizations where id=?',id))E(400,'Unknown fee-share scope');if(kind=='platform'&&type!='global'||kind=='station'&&!['global','tenant'].includes(type)||kind=='loading'&&!['global','organization'].includes(type))E(400,'Fee-share scope does not match the fee type');return saveFeeShares(req,type,id,kind,req.body.stream,req.body.shares)}));
api.get('/manager/fee-shares',mgr,H(req=>{const type=req.u.organization_id?'organization':req.u.tenant_id||req.u.station_id?'tenant':null,id=req.u.organization_id||req.u.tenant_id||tenantForStation(req.u.station_id);if(!type||!id)return[];return q("select scope_type,scope_id,fee_kind,stream,payer_type,percentage from fee_share_config where (scope_type=? and scope_id=?) or (scope_type='global' and scope_id=0) order by scope_type,scope_id,fee_kind,stream,payer_type",type,id)}));
api.put('/manager/fee-shares',mgr,H(req=>{const kind=String(req.body.feeKind||''),stream=String(req.body.stream||''),expected=req.u.organization_id?['organization',req.u.organization_id]:req.u.tenant_id||req.u.station_id?['tenant',req.u.tenant_id||tenantForStation(req.u.station_id)]:null;if(!expected)E(403,'Manager account has no organization or tenant scope');if(kind!='station'&&kind!='loading'||kind=='station'&&expected[0]!='tenant'||kind=='loading'&&expected[0]!='organization')E(403,'This fee type is outside your configuration scope');return saveFeeShares(req,expected[0],expected[1],kind,stream,req.body.shares)}));
api.get('/admin/platform-settings',AD,H(req=>{
 const tenantId=Number(req.query.tenantId)||null,tenants=q('select id,name from tenants order by name');
 if(tenantId&&!one('select 1 x from tenants where id=?',tenantId))E(404,'Tenant not found');
 const stored=tenantId?tenantProviderSettings(tenantId):{},settings=Object.fromEntries(TENANT_SETTING_KEYS.filter(k=>!TENANT_SECRET_KEYS.has(k)).map(k=>[k,stored[k]||'']));
 return{tenants,tenantId,settings,secrets:Object.fromEntries([...TENANT_SECRET_KEYS].map(k=>[k,!!stored[k]])),
  payloadDefaults:{countryCode:process.env.EGANOW_DEFAULT_COUNTRY_CODE||'GH0233',language:process.env.EGANOW_DEFAULT_LANGUAGE||'en',mobileMoneyPartners:(process.env.EGANOW_MOMO_PARTNERS||'MTNGH,ATGH,TCELGH').split(',').map(x=>x.trim()).filter(Boolean)}}
}));
api.get('/admin/system-providers',AD,H(()=>{
 const stored=systemProviderSettings();
 return{settings:Object.fromEntries(SYSTEM_PROVIDER_KEYS.filter(k=>!SYSTEM_SECRET_KEYS.has(k)).map(k=>[k,stored[k]||''])),secrets:Object.fromEntries([...SYSTEM_SECRET_KEYS].map(k=>[k,!!stored[k]]))}
}));
api.put('/admin/system-providers',AD,H(req=>{
 const settings=req.body.settings||{},clearSecrets=req.body.clearSecrets||[];
 if(!settings||typeof settings!='object'||Array.isArray(settings)||!Array.isArray(clearSecrets))E(400,'Invalid platform provider settings');
 const next={},changed=[];
 for(const[key,raw]of Object.entries(settings)){
  if(!SYSTEM_PROVIDER_KEYS.includes(key))E(400,'Unknown platform provider setting');
  if(typeof raw!='string'||raw.length>2048)E(400,`${key} must be a text value up to 2048 characters`);
  if(SYSTEM_SECRET_KEYS.has(key)&&!raw)continue;
  next[key]=raw.trim();changed.push(key)
 }
 if(clearSecrets.some(key=>!SYSTEM_SECRET_KEYS.has(key)))E(400,'Invalid secret field to clear');
 const existing=systemProviderSettings(),value=key=>next[key]??existing[key]??'';
 if(value('SMS_PROVIDER')&&!['twilio','http'].includes(value('SMS_PROVIDER')))E(400,'Unsupported platform OTP SMS provider');
 if(value('SMS_PROVIDER')=='twilio'&&(!value('TWILIO_SID')||!value('TWILIO_TOKEN')||!value('TWILIO_FROM')))E(400,'Configure the Twilio account SID, token, and sender before enabling OTP SMS');
 if(value('SMS_PROVIDER')=='http'&&!value('SMS_URL'))E(400,'Configure the OTP SMS URL before enabling the HTTP provider');
 for(const key of['SMS_URL','TWILIO_API_BASE_URL','IDENTITY_VERIFY_URL']){
  const raw=value(key);if(!raw)continue;
  let url;try{url=new URL(raw)}catch{E(400,`${key} must be a valid URL`)}
  if(url.username||url.password)E(400,`${key} must not contain URL credentials`);
  if(PROD&&url.protocol!='https:')E(400,`${key} must use HTTPS in production`)
 }
 if(value('IDENTITY_VERIFY_URL')&&!value('IDENTITY_API_TOKEN'))E(400,'Configure the identity API token before enabling Ghana Card verification');
 db.transaction(()=>{
  for(const[key,setting]of Object.entries(next))run('insert into system_provider_settings(key,value,encrypted) values(?,?,?) on conflict(key) do update set value=excluded.value,encrypted=excluded.encrypted',key,SYSTEM_SECRET_KEYS.has(key)?encryptSetting(setting):setting,SYSTEM_SECRET_KEYS.has(key)?1:0);
  for(const key of clearSecrets)run('delete from system_provider_settings where key=?',key);
  audit(req.u.id,'system.providers.configure','platform',0,{settings:changed,clearedSecrets:clearSecrets})
 })();
 return{ok:1}
}));
api.put('/admin/platform-settings',AD,H(req=>{
 const tenantId=Number(req.body.tenantId),settings=req.body.settings||{},clearSecrets=req.body.clearSecrets||[];
 if(!Number.isSafeInteger(tenantId)||tenantId<1||!one('select 1 x from tenants where id=?',tenantId))E(400,'Choose a valid tenant');
 if(!settings||typeof settings!='object'||Array.isArray(settings)||!Array.isArray(clearSecrets))E(400,'Invalid tenant provider settings');
 const next={},changed=[];
 for(const[k,raw]of Object.entries(settings)){
  if(!TENANT_SETTING_KEYS.includes(k))E(400,'Unknown tenant provider setting');
  if(typeof raw!='string'||raw.length>2048)E(400,`${k} must be a text value up to 2048 characters`);
  if(TENANT_SECRET_KEYS.has(k)&&!raw)continue;
  next[k]=raw.trim();changed.push(k)
 }
 if(clearSecrets.some(k=>!TENANT_SECRET_KEYS.has(k)))E(400,'Invalid secret field to clear');
 const existing=tenantProviderSettings(tenantId),value=(key)=>next[key]??existing[key]??'';
 if(value('PAYMENT_PROVIDER')&&!['eganow'].includes(value('PAYMENT_PROVIDER')))E(400,'Unsupported payment provider');
 if(value('SMS_PROVIDER')&&!['twilio','http'].includes(value('SMS_PROVIDER')))E(400,'Unsupported SMS provider');
 if(value('EMAIL_PROVIDER')&&!['disabled','smtp'].includes(value('EMAIL_PROVIDER')))E(400,'Unsupported email provider');
 const port=Number(value('SMTP_PORT')||'587');if(value('SMTP_PORT')&&(!Number.isInteger(port)||port<1||port>65535))E(400,'SMTP_PORT must be between 1 and 65535');
 for(const key of['EGANOW_BASE_URL','EGANOW_CALLBACK_URL','TWILIO_API_BASE_URL','SMS_URL']){
  const raw=value(key);if(!raw)continue;
  let url;try{url=new URL(raw)}catch{E(400,`${key} must be a valid URL`)}
  if(PROD&&url.protocol!='https:')E(400,`${key} must use HTTPS in production`)
 }
 if(value('NOTIFY_CHANNEL')&&!['sms','whatsapp'].includes(value('NOTIFY_CHANNEL')))E(400,'NOTIFY_CHANNEL must be sms or whatsapp');
 if(value('EMAIL_PROVIDER')=='smtp'&&!value('SMTP_HOST'))E(400,'Configure SMTP_HOST before selecting SMTP');
 db.transaction(()=>{
  for(const[k,setting]of Object.entries(next))run('insert into tenant_provider_settings(tenant_id,key,value,encrypted) values(?,?,?,?) on conflict(tenant_id,key) do update set value=excluded.value,encrypted=excluded.encrypted',tenantId,k,TENANT_SECRET_KEYS.has(k)?encryptSetting(setting):setting,TENANT_SECRET_KEYS.has(k)?1:0);
  for(const k of clearSecrets)run('delete from tenant_provider_settings where tenant_id=? and key=?',tenantId,k);
  audit(req.u.id,'tenant.providers.configure','tenant',tenantId,{settings:changed,clearedSecrets:clearSecrets})
 })();
 return{ok:1}
}));
api.get('/reports/daily-operations',mgr,H(req=>{const ids=scope(req.u).join(',')||0;return rep(req,q(`select substr(t.dep_at,1,10) as "day",t.status,count(*) trips from trips t join routes r on r.id=t.route_id where r.id in(${ids}) group by 1,2`))}));
// ---- v1.2 additions ----
const fs=require('fs'),path=require('path'),UP=path.resolve(__dirname,process.env.UPLOAD_DIR||'uploads');fs.mkdirSync(UP,{recursive:true});
const pg=req=>{const l=Math.min(+req.query.limit||20,100);return[l,((+req.query.page||1)-1)*l]};
const csv=rows=>{if(!rows.length)return'';const k=Object.keys(rows[0]);return[k.join(','),...rows.map(r=>k.map(c=>JSON.stringify(r[c]??'')).join(','))].join('\n')};
const rep=(req,rows)=>req.query.format=='csv'?csv(rows):rows;
api.post('/drivers/onboard',DR,H(()=>E(403,'Driver onboarding must be completed through a tenant-issued invitation and review.')));
api.post('/manager/drivers/onboard',mgr,H(()=>E(403,'Drivers must apply through a scoped invitation and receive tenant approval.')));
function reserveExcl(x,b){const dep=mins(x.time);let v;
 if(b.vehicleId){v=one('select * from vehicles where id=? and deleted_at is null',b.vehicleId);if(!v||v.capacity<x.seats)E(409,'Vehicle capacity is below the requested passenger count');if(!eligible(v.driver_id,v,x.date,dep,x.route_id))E(409,'Vehicle not eligible')}
 else{const c=q('select * from vehicles where deleted_at is null and capacity>=?',x.seats).filter(v=>eligible(v.driver_id,v,x.date,dep,x.route_id));if(!c.length)E(409,`No eligible vehicle with at least ${x.seats} seats`);v=c[Math.random()*c.length|0]}
 const id=run('insert into trips(route_id,driver_id,vehicle_id,dep_at,exclusive_for) values(?,?,?,?,?)',x.route_id,v.driver_id,v.id,x.date+'T'+x.time,x.id).lastInsertRowid;
 notify(v.driver_id,'Trip assignment',`Exclusive trip #${id} at ${x.date} ${x.time}`);notify(x.passenger_id,'Full-vehicle request',`Approved: vehicle reserved on trip #${id}.`,tenantForRoute(x.route_id));return id}
api.get('/stations',H(req=>{const cols='select s.id,s.name,s.code,s.tenant_id,s.latitude,s.longitude from stations s';if(req.u.organization_id)return q(cols+' join org_tenants ot on ot.tenant_id=s.tenant_id where ot.organization_id=? order by s.name',req.u.organization_id);if(STATION_STAFF.includes(req.u.role))return req.u.tenant_id?q(cols+' where s.tenant_id=? order by s.name',req.u.tenant_id):req.u.station_id?q(cols+' where s.id=? order by s.name',req.u.station_id):[];if(req.u.role=='driver'&&req.u.tenant_id)return q(cols+' where s.tenant_id=? order by s.name',req.u.tenant_id);return q(cols+' order by s.name')}));
api.get('/config',H(req=>{const rows=q('select * from config');if(req.u.role=='admin')return rows;if(!STATION_STAFF.includes(req.u.role))return[];const routes=scope(req.u),stationIds=req.u.tenant_id?q('select id from stations where tenant_id=?',req.u.tenant_id).map(s=>s.id):req.u.station_id?[req.u.station_id]:[];return rows.filter(c=>c.scope.startsWith('station:')&&stationIds.includes(+c.scope.slice(8))||c.scope.startsWith('tenant:')&&+c.scope.slice(7)==req.u.tenant_id||c.scope.startsWith('organization:')&&+c.scope.slice(13)==req.u.organization_id||c.scope.startsWith('route:')&&routes.includes(+c.scope.slice(6)))}));
api.get('/manager/fares',mgr,H(req=>q('select * from routes').filter(r=>scope(req.u).includes(r.id)).map(r=>({...r,fare_ghs:cfg('fare_ghs',r.id,null),station_fee_pct:cfg('station_fee_pct',r.id,0),loading_fee_pct:cfg('loading_fee_pct',r.id,0)}))));
api.put('/manager/routes/:id/fare',mgr,H(req=>{const routeId=+req.params.id,fare=Number(req.body.fareGhs);if(Object.hasOwn(req.body,'platformFeePct')||Object.hasOwn(req.body,'payoutGate'))E(400,'Set fare when creating a route; payout timing is selected by drivers and overridden per driver');inScope(req.u,routeId);if(req.u.role!='admin'&&!req.u.organization_id)E(403,'Route fares are managed at organization level');
 if(!Number.isFinite(fare)||toPesewas(fare)<=0||fare>100000)E(400,'Fare must be positive');
 run('insert into config(scope,key,value) values(?,?,?) on conflict(scope,key) do update set value=excluded.value','route:'+routeId,'fare_ghs',fare.toFixed(2));audit(req.u.id,'fare.configure','route',routeId,{fareGhs:fare});return{ok:1}}));
api.put('/config',mgr,H(req=>{const{scope:s,key,value}=req.body,u=req.u;
 const allowed=['cutoff_min','cancel_deadline_min','confirm_hours_before','surge_seats','surge_wait','max_vehicles','remind_hours','final_remind_hours','ride_remind_min','noshow_limit','noshow_days','noshow_block_days','cash_enabled','fee_due_hours','fee_max_outstanding_ghs','fee_manual_needs_approval','fee_block_cash',...FEE_CONFIG_KEYS];
 if(!allowed.includes(key)||value===''||!Number.isFinite(Number(value)))E(400,'Unknown key or non-numeric value');
 if(['cash_enabled','fee_manual_needs_approval','fee_block_cash'].includes(key)&&![0,1].includes(Number(value)))E(400,`${key} must be 0 or 1`);
 const[k,id]=String(s).split(':'),numericId=/^[1-9]\d*$/.test(id||''),feeKey=FEE_CONFIG_KEYS.includes(key),tenantFee=['station_fee_pct','platform_fee_pct','driver_station_fee_pct','driver_platform_fee_pct'],organizationFee=['loading_fee_pct','driver_loading_fee_pct'];
 if(feeKey&&Number(value)>100||feeKey&&Number(value)<0)E(400,'Fee percentages must be between 0 and 100');
 const ok=s=='global'?u.role=='admin':k=='station'?numericId&&!!one('select 1 x from stations where id=?',+id)&&(u.role=='admin'||STATION_STAFF.includes(u.role)&&!u.organization_id&&stationInScope(u,+id)):k=='tenant'?numericId&&!!one('select 1 x from tenants where id=?',+id)&&(u.role=='admin'||STATION_STAFF.includes(u.role)&&!u.organization_id&&u.tenant_id==+id):k=='organization'?numericId&&!!one('select 1 x from organizations where id=?',+id)&&(u.role=='admin'||STATION_STAFF.includes(u.role)&&u.organization_id==+id):k=='route'?numericId&&scope(u).includes(+id):false;if(!ok)E(403,'Scope not allowed');
 if(feeKey&&u.role!='admin'&&(tenantFee.includes(key)?(k!='tenant'||u.organization_id):(organizationFee.includes(key)?(k!='organization'||!u.organization_id):true)))E(403,'Fee rate cannot be changed in this scope');
 if(['fee_due_hours','fee_max_outstanding_ghs','fee_manual_needs_approval'].includes(key)&&u.role!='admin')E(403,'This fee policy is admin-only');
 run('insert into config values(?,?,?) on conflict(scope,key) do update set value=excluded.value',s,key,String(value));audit(u.id,'config.set','config',0,req.body);return{ok:1}}));
api.patch('/bookings/:id',P,H(req=>db.transaction(()=>{const b=one('select * from bookings where id=? and passenger_id=?',req.params.id,req.u.id);if(!b)E(404,'Not found');if(!['Queued','Assigned','Confirmed'].includes(b.status))E(409,'Cannot edit at this stage');
 if(b.paid_pesewas>0||b.payment_status=='Credit')E(409,'Paid bookings cannot be edited; contact the station manager to request a fare adjustment.');
 const n={date:req.body.date||b.date,arrival:req.body.arrival||b.arrival,seats:req.body.seats||b.seats};if(!(n.seats>=1&&n.seats<=3))E(400,'Seats 1-3');if(!validDateTime(n.date,n.arrival))E(400,'Bad date/time');
 if(Date.parse(n.date+'T'+n.arrival+':00Z')-Date.now()<cfg('cutoff_min',b.route_id,CUTOFF)*6e4)E(400,'Past booking cut-off');
 const farePesewas=Math.round(b.fare_pesewas/b.seats)*n.seats,rider=riderCharges(farePesewas,b.rider_station_pct,b.rider_platform_pct),driver=driverDeductions(farePesewas,b.driver_station_pct,b.driver_platform_pct),riderLoading=percentageCharge(farePesewas,b.rider_loading_pct),driverLoading=percentageCharge(farePesewas,b.driver_loading_pct),route=routeFare(b.route_id);
 run("update assignments set status='Reassigned' where booking_id=? and status in"+ACTIVE,b.id);reverseBookingFees(b);run('update bookings set date=?,arrival=?,seats=?,fare_pesewas=?,station_fee_pesewas=?,platform_fee_pesewas=?,loading_fee_pesewas=?,driver_station_deduction_pesewas=?,driver_platform_deduction_pesewas=?,driver_loading_deduction_pesewas=? where id=?',n.date,n.arrival,n.seats,farePesewas,rider.stationFeePesewas,rider.platformFeePesewas,riderLoading,driver.stationDeductionPesewas,driver.platformDeductionPesewas,driverLoading,b.id);snapshotBookingFees(one('select * from bookings where id=?',b.id),route);
 setB(b.id,'Queued',req.u.id,'edited');audit(req.u.id,'booking.edit','booking',b.id,n);allocate();return bookingPublic(b.id)})()));
api.patch('/recurring/:id',P,H(req=>{const r=rec(req),b=req.body,seats=b.seats||r.seats;if(!(seats>=1&&seats<=3))E(400,'Seats 1-3');
 const days=b.days||r.days.split(',').map(Number),arrival=b.arrival||r.arrival,startDate=b.startDate||r.start_date,endDate=b.endDate||r.end_date;
 if(!validTime(arrival)||!validDate(startDate)||!validDate(endDate)||endDate<startDate||!Array.isArray(days)||!days.length||days.some(d=>!Number.isInteger(d)||d<0||d>6))E(400,'Invalid recurring schedule');
 run('update recurring set days=?,seats=?,arrival=?,start_date=?,end_date=? where id=?',days.join(','),seats,arrival,startDate,endDate,r.id);audit(req.u.id,'recurring.edit','recurring',r.id,b);
 return{ok:1,note:'Applies to weeks not yet confirmed; existing assigned/confirmed bookings are not rewritten'}}));
api.post('/manager/bookings/:id/no-show',mgr,H(req=>{const b=one('select * from bookings where id=?',req.params.id);if(!b)E(404,'Not found');inScope(req.u,b.route_id);if(!['Assigned','Confirmed'].includes(b.status))E(409,'Only assigned/confirmed bookings can be no-shows (before departure)');
 run("update assignments set status='Cancelled' where booking_id=? and status in"+ACTIVE,b.id);setB(b.id,'NoShow',req.u.id,req.body.reason||'no-show');noshowRule(b);notify(b.passenger_id,'No-show',`Booking ${b.ref} marked as no-show.`,tenantForRoute(b.route_id));audit(req.u.id,'booking.noshow','booking',b.id);allocate();return{ok:1}}));
api.post('/exclusive-requests/:id/cancel',P,H(req=>{const x=one('select * from excl where id=? and passenger_id=?',req.params.id,req.u.id);if(!x||['Cancelled','Rejected'].includes(x.status))E(404,'Not found');
 if(x.trip_id){const t=one('select status from trips where id=?',x.trip_id);if(t.status!='Planned')E(409,'Trip already underway');tripStatus(x.trip_id,'Cancelled',{id:0,role:'admin'})}run("update excl set status='Cancelled' where id=?",x.id);return{ok:1}}));
// documents & vehicle ownership
function syncDriverVerification(driverId,actorId=0){
 const today=now().slice(0,10),driver=one('select verified from drivers where user_id=?',driverId);
 if(!driver)return false;
 const hasLicence=!!one("select 1 x from docs where owner_id=? and kind='licence' and status='Verified' and (expires_on is null or expires_on>?)",driverId,today);
 const hasApprovedVehicle=!!one(`select 1 x from vehicles v where v.driver_id=? and v.deleted_at is null and v.docs_ok=1
  and exists(select 1 from docs d where d.vehicle_id=v.id and d.kind='vehicle_registration' and d.status='Verified' and (d.expires_on is null or d.expires_on>?))
  and exists(select 1 from docs d where d.vehicle_id=v.id and d.kind='insurance' and d.status='Verified' and (d.expires_on is null or d.expires_on>?))`,driverId,today,today);
 const approved=hasLicence&&hasApprovedVehicle;
 if(!!driver.verified===approved)return approved;
 run('update drivers set verified=? where user_id=?',approved?1:0,driverId);
 audit(actorId,approved?'driver.auto_approve':'driver.auto_unapprove','driver',driverId,{automatic:true});
 if(approved)notify(driverId,'Driver approved','Your licence and vehicle documents are verified. Your driver account is now approved.');
 else notify(driverId,'Driver verification required','Your driver account is unavailable until a valid licence and an approved vehicle are on file.');
 return approved
}
api.post('/documents',DR,H(req=>{const{vehicleId,kind,filename,contentBase64,expiresOn}=req.body,ext=path.extname(filename||'').toLowerCase();
 if(!['.pdf','.jpg','.jpeg','.png'].includes(ext))E(400,'pdf/jpg/png only');if(!['licence','vehicle_registration','insurance','roadworthy'].includes(kind))E(400,'Unknown document kind');if(kind!='vehicle_registration'&&!(/^\d{4}-\d\d-\d\d$/.test(expiresOn||'')&&expiresOn>new Date().toISOString().slice(0,10)))E(400,'A future expiry date (YYYY-MM-DD) is required for this document');
 if(vehicleId&&!one('select 1 x from vehicles where id=? and driver_id=?',vehicleId,req.u.id))E(403,'Not your vehicle');
 const buf=Buffer.from(contentBase64||'','base64');if(!buf.length||buf.length>4e6)E(400,'File empty or over 4MB');const f=cr.randomBytes(12).toString('hex')+ext;fs.writeFileSync(path.join(UP,f),buf);
 return{id:run('insert into docs(owner_id,vehicle_id,kind,filename,path,at,expires_on) values(?,?,?,?,?,?,?)',req.u.id,vehicleId||null,kind,filename,f,now(),expiresOn||null).lastInsertRowid,status:'Pending'}}));
api.get('/documents',DR,H(r=>q('select id,kind,vehicle_id,filename,status,note from docs where owner_id=?',r.u.id)));
api.get('/documents/:id/file',H((req,res)=>{const d=one('select * from docs where id=?',req.params.id);if(!d||(d.owner_id!=req.u.id&&!['manager','accountant','admin'].includes(req.u.role)))E(404,'Not found');if(STATION_STAFF.includes(req.u.role))chkDrv(req.u,d.owner_id);res.sendFile(path.join(UP,d.path))}));
['verify','reject'].forEach(a=>api.post('/manager/documents/:id/'+a,mgr,H(req=>{const d=one('select * from docs where id=?',req.params.id);if(!d)E(404,'Not found');chkDrv(req.u,d.owner_id);if(a=='verify'&&d.expires_on&&d.expires_on<=now().slice(0,10))E(409,'Document already expired');
 run('update docs set status=?,reviewed_by=?,note=? where id=?',a=='verify'?'Verified':'Rejected',req.u.id,req.body.note||'',d.id);if(d.vehicle_id&&['vehicle_registration','insurance'].includes(d.kind))run('update vehicles set docs_ok=0 where id=?',d.vehicle_id);notify(d.owner_id,'Document',`Your ${d.kind} document was ${a=='verify'?'verified':'rejected'}.`);audit(req.u.id,'doc.'+a,'doc',d.id);syncDriverVerification(d.owner_id,req.u.id);return{ok:1}})));
api.post('/manager/vehicles',mgr,PERM('vehicles.create','manager','accountant'),H(req=>{const driverId=Number(req.body.driverId),vehicle=vehicleInput(req.body),driver=one('select d.user_id from drivers d join users u on u.id=d.user_id where d.user_id=? and u.deleted_at is null',driverId);if(!driver)E(404,'Driver profile not found');chkDrv(req.u,driverId);if(one('select count(*) n from vehicles where driver_id=? and deleted_at is null',driverId).n>=cfg('max_vehicles',null,2))E(409,'Vehicle limit reached');const id=run('insert into vehicles(driver_id,reg,type,capacity) values(?,?,?,?)',driverId,vehicle.reg,vehicle.type,vehicle.capacity).lastInsertRowid;audit(req.u.id,'vehicle.create','vehicle',id,{driverId,...vehicle});return{id}}));
api.post('/manager/vehicles/:id/verify',mgr,PERM('vehicles.update','manager'),H(req=>{const v=vehicleAccess(req.u,req.params.id);
 for(const k of['vehicle_registration','insurance'])if(!one("select 1 x from docs where vehicle_id=? and kind=? and status='Verified' and (expires_on is null or expires_on>?)",v.id,k,now().slice(0,10)))E(409,`Verified ${k} document required`);
 run('update vehicles set docs_ok=1 where id=?',v.id);syncDriverVerification(v.driver_id,req.u.id);audit(req.u.id,'vehicle.verify','vehicle',v.id);allocate();return{ok:1}}));
api.post('/manager/vehicles/:id/transfer',mgr,PERM('vehicles.update','manager'),H(req=>{const v=vehicleAccess(req.u,req.params.id),to=+req.body.driverId;chkDrv(req.u,to);
 if(!one("select 1 x from drivers d join users u on u.id=d.user_id where d.user_id=? and d.verified=1 and u.deleted_at is null",to))E(409,'Target must be a verified driver');if(one('select count(*) n from vehicles where driver_id=? and deleted_at is null',to).n>=cfg('max_vehicles',null,2))E(409,'Target at vehicle limit');
 if(one("select 1 x from trips where vehicle_id=? and status in('Planned','Loading','Departed')",v.id))E(409,'Vehicle has open trips');run('update vehicles set driver_id=?,docs_ok=0 where id=?',to,v.id);syncDriverVerification(v.driver_id,req.u.id);syncDriverVerification(to,req.u.id);audit(req.u.id,'vehicle.transfer','vehicle',v.id,{to});return{ok:1}}));
api.post('/admin/drivers/onboard',AD,H(req=>{
 const name=String(req.body.name||'').trim(),phone=normalizePhone(req.body.phone),stationId=Number(req.body.stationId),tenantId=tenantForStation(stationId),organizationId=Number(req.body.organizationId)||null;
 if(!phone||!name||name.length>100)E(400,'Valid phone and name (100 characters maximum) are required');
 if(one('select 1 x from users where phone=?',phone))E(409,'This phone number already belongs to an account');
 if(!tenantId||!organizationId||!one('select 1 x from org_tenants where organization_id=? and tenant_id=?',organizationId,tenantId))E(400,'Choose an organization connected to the selected terminal');
 if(!req.body.consent)E(400,'Confirm the driver has consented to onboarding');
 const submitted=validateApplication({role:'driver'},req.body),storedFiles=[];
 let id,vehicleId;
 try{db.transaction(()=>{
  const consentAt=new Date().toISOString();
  id=run('insert into users(phone,name,role,station_id,tenant_id,organization_id,verified,consent_at,consent_ver) values(?,?,?,?,?,?,1,?,?)',phone,name,'driver',stationId,tenantId,organizationId,consentAt,TV).lastInsertRowid;
  const form=submitted.form;
  run('insert into drivers(user_id,licence,station_id,tenant_id,organization_id,payout_partner,payout_msisdn,payout_gate) values(?,?,?,?,?,?,?,?)',id,form.licence,stationId,tenantId,organizationId,form.payoutPartner,normalizeMsisdn(form.payoutPhone),form.payoutGate);
  vehicleId=run('insert into vehicles(driver_id,reg,type,capacity) values(?,?,?,?)',id,form.reg,form.type,form.capacity).lastInsertRowid;
  for(const dow of form.days)run('insert into availability(driver_id,dow,st,en) values(?,?,?,?)',id,dow,form.startTime,form.endTime);
  const uploadedAt=new Date().toISOString();
  for(const doc of submitted.documents){const filename=cr.randomBytes(16).toString('hex')+path.extname(doc.filename).toLowerCase();fs.writeFileSync(path.join(UP,filename),doc.buffer,{flag:'wx',mode:0o600});storedFiles.push(filename);run('insert into docs(owner_id,vehicle_id,kind,filename,path,at,expires_on) values(?,?,?,?,?,?,?)',id,doc.kind=='licence'?null:vehicleId,doc.kind,String(doc.filename).slice(0,200),filename,uploadedAt,doc.expiresOn||null)}
  audit(req.u.id,'driver.manual_create','driver',id,{tenantId,stationId,organizationId,vehicleId});
 })()}catch(error){for(const filename of storedFiles)fs.rmSync(path.join(UP,filename),{force:true});throw error}
 notifyMgrs('Document verification',`Driver ${name} submitted licence and vehicle documents for review.`,null,stationId);
 return{id,vehicleId,message:'Driver profile created. The driver must set a PIN by phone verification; documents remain pending station verification.'}
}));
api.post('/admin/users',AD,H(req=>{const role=req.body.role,phone=normalizePhone(req.body.phone),name=String(req.body.name||'').trim(),pin=String(req.body.pin||'');if(!['manager','accountant'].includes(role))E(400,['driver','porter'].includes(role)?'Use the admin manual driver form or scoped invitations.':role=='passenger'?'Passengers must complete phone and Ghana Card verification through registration.':'Only managers and accountants can be created directly.');if(!phone||!name||name.length>100||pin.length<6)E(400,'Valid phone, name (100 characters maximum), and PIN (6+ characters) required');const{stationId,tenantId,organizationId}=userTenantScope(role,req.body),id=run('insert into users(phone,name,role,station_id,tenant_id,organization_id,verified,pin_hash) values(?,?,?,?,?,?,?,?)',phone,name,role,stationId,tenantId,organizationId,1,hashPin(pin)).lastInsertRowid;audit(req.u.id,'user.create','user',id,{phone,name,role,stationId,tenantId,organizationId});return{id}}));
api.post('/admin/managers',AD,H(req=>{const phone=normalizePhone(req.body.phone),name=String(req.body.name||'').trim(),stationId=Number(req.body.stationId),pin=req.body.pin;if(!phone||!name||!Number.isInteger(stationId)||!tenantForStation(stationId)||String(pin||'').length<6)E(400,'phone, name, valid stationId, pin (6+ chars) required');return db.transaction(()=>{const id=run('insert into users(phone,name,role,station_id,verified,pin_hash) values(?,?,?,?,?,?)',phone,name,'manager',stationId,1,hashPin(pin)).lastInsertRowid;audit(req.u.id,'user.create','user',id,{phone,name,role:'manager',stationId});return{id}})()}));
// reports (CSV via ?format=csv, date range via ?from=&to=)
const rng=req=>[req.query.from||'0000-01-01',req.query.to||'9999-12-31'];
api.get('/reports/route-demand',mgr,H(req=>{const[f,t]=rng(req),rs=scope(req.u).join(',')||0;return rep(req,q(`select r.name route,b.date,substr(b.arrival,1,2)||':00' as "hour",count(*) bookings,sum(b.seats) seats,sum(case when b.status='Completed' then 1 else 0 end) completed,sum(case when b.status='Cancelled' then 1 else 0 end) cancelled,sum(case when b.status='NoShow' then 1 else 0 end) no_shows,sum(case when b.status='Queued' then 1 else 0 end) waiting from bookings b join routes r on r.id=b.route_id where b.route_id in(${rs}) and b.date between ? and ? group by b.route_id,r.name,b.date,substr(b.arrival,1,2) order by b.date`,f,t))}));
api.get('/reports/driver-utilisation',mgr,H(req=>{const[f,t]=rng(req),rs=scope(req.u).join(',')||0;return rep(req,q(`select u.name driver,v.reg,count(*) trips,sum(case when t.status='Completed' then 1 else 0 end) completed,sum(case when t.status='Breakdown' then 1 else 0 end) breakdowns,coalesce(sum((select sum(a.seats) from assignments a where a.trip_id=t.id and a.status='Boarded')),0) seats_carried,round(count(*)*${DUR}/60.0,1) scheduled_hours from trips t join users u on u.id=t.driver_id join vehicles v on v.id=t.vehicle_id where t.route_id in(${rs}) and substr(t.dep_at,1,10) between ? and ? group by t.driver_id,t.vehicle_id,u.name,v.reg`,f,t))}));
// ---- v1.4 additions ----
function moveTrip(id,time,date,reason,u,delayed){const t=one('select * from trips where id=?',id);if(!t||!['Planned','Loading','Delayed'].includes(t.status))E(409,'Trip cannot be rescheduled now');inScope(u,t.route_id);
 const as=q('select a.id,b.passenger_id,b.ref,b.arrival,b.route_id from assignments a join bookings b on b.id=a.booking_id where a.trip_id=? and a.status in'+ACTIVE,id),od=t.dep_at.slice(0,10),d=date||od;if(!validDateTime(d,time))E(400,'Bad date/time');
 if(as.length&&d!=od)E(409,'Cannot change the date while passengers are assigned');if(as.some(a=>mins(a.arrival)>mins(time)))E(409,"New time is earlier than a passenger's arrival time");
 if(q("select dep_at from trips where id!=? and (driver_id=? or vehicle_id=?) and status not in('Cancelled','Completed','Breakdown') and substr(dep_at,1,10)=?",id,t.driver_id,t.vehicle_id,d).some(x=>Math.abs(mins(x.dep_at.slice(11))-mins(time))<DUR))E(409,'Overlaps another trip of this driver/vehicle');
 run('update trips set dep_at=?,status=?,reminded=0 where id=?',d+'T'+time,delayed?'Delayed':t.status=='Delayed'?'Planned':t.status,id);run('update bookings set reminded=0 where id in(select booking_id from assignments where trip_id=?)',id);
 const ev=delayed?'Trip delayed':'Schedule changed';as.forEach(a=>notify(a.passenger_id,ev,`Booking ${a.ref}: new estimated departure ${d} ${time}. ${reason}`,tenantForRoute(a.route_id)));notify(t.driver_id,'Schedule changed',`Trip #${id} now ${d} ${time}. ${reason}`);
 audit(u.id,delayed?'trip.delay':'trip.reschedule','trip',id,{time,date:d,reason});return{ok:1,departure:d+'T'+time}}
const breakdown=db.transaction((id,u,reason)=>{const t=one('select * from trips where id=?',id);if(!t||['Completed','Cancelled','Breakdown'].includes(t.status))E(409,'Not applicable');
 run("update trips set status='Breakdown' where id=?",id);run("update vehicles set status='Maintenance' where id=?",t.vehicle_id);run("update drivers set op_status='TemporarilyUnavailable' where user_id=?",t.driver_id);
 q("select b.passenger_id,b.ref,b.route_id from assignments a join bookings b on b.id=a.booking_id where a.trip_id=? and a.status='Boarded'",id).forEach(p=>notify(p.passenger_id,'Breakdown',`Booking ${p.ref}: your vehicle broke down; the station manager is arranging help.`,tenantForRoute(p.route_id)));
 requeue(id,'Reassigned','vehicle breakdown',true);notifyMgrs('Breakdown',`Trip #${id} breakdown${reason?': '+reason:''}.`,t.route_id);audit(u.id,'trip.breakdown','trip',id,{reason});allocate()}); // boarded passengers are never silently reassigned
api.post('/manager/trips/:id/breakdown',mgr,H(req=>{const t=one('select route_id from trips where id=?',req.params.id);if(!t)E(404,'No such trip');inScope(req.u,t.route_id);breakdown(+req.params.id,req.u,req.body.reason);return{ok:1}}));
api.post('/drivers/me/trips/:id/breakdown',DR,H(req=>{if(!one('select 1 x from trips where id=? and driver_id=?',req.params.id,req.u.id))E(403,'Not your trip');breakdown(+req.params.id,req.u,req.body.reason);return{ok:1}}));
api.post('/manager/trips/:id/reschedule',mgr,H(req=>db.transaction(()=>{const{time,date,reason}=req.body;if(!validTime(time)||date!==undefined&&!validDate(date)||!String(reason||'').trim())E(400,'Valid time, optional date, and reason required');return moveTrip(+req.params.id,time,date,reason,req.u,false)})()));
api.post('/manager/trips/:id/delay',mgr,H(req=>db.transaction(()=>{const m=+req.body.minutes,t=one('select dep_at from trips where id=?',req.params.id);if(!t)E(404,'No such trip');if(!(m>0&&m<=480)||!req.body.reason)E(400,'minutes (1-480) and reason required');return moveTrip(+req.params.id,hhmm(mins(t.dep_at.slice(11))+m),null,req.body.reason,req.u,true)})()));
api.post('/manager/bookings/:id/assign',mgr,H(req=>db.transaction(()=>{const{tripId,reason,seatLabel}=req.body,b=one('select * from bookings where id=?',req.params.id),t=one('select * from trips where id=?',tripId);if(!reason)E(400,'Reason required');if(!b||!t)E(404,'Not found');inScope(req.u,b.route_id);
 if(b.route_id!=t.route_id)E(409,'Route mismatch');if(t.exclusive_for)E(409,'Trip is reserved for a full-vehicle request');if(!['Planned','Loading'].includes(t.status))E(409,'Trip not open');if(!['Queued','Assigned','Confirmed'].includes(b.status))E(409,'Booking cannot be moved');
 run("update assignments set status='Reassigned' where booking_id=? and status in"+ACTIVE,b.id);assign(t,b,'Manual',req.u.id,reason);if(seatLabel)run('update assignments set seat_label=? where booking_id=? and status in'+ACTIVE,String(seatLabel).slice(0,10),b.id);
 audit(req.u.id,'booking.manual-assign','booking',b.id,{tripId,reason});return{ok:1}})()));
const bookingStatusText=b=>b.status=='Queued'&&b.payment_status=='Due'?'Payment required before dispatch allocation.':b.status=='Queued'?`Waiting for a vehicle. Queue position ${b.queue_pos} for this route and day. We will message you when one is assigned.`:['Assigned','Confirmed'].includes(b.status)&&b.dep_at?`${b.trip_status=='Delayed'?'DELAYED. ':''}Estimated departure ${b.dep_at.slice(11)} (${b.reg||'vehicle'}${b.seat_label?', seat '+b.seat_label:''}). Estimate only, not a guarantee. Be at the station by ${b.arrival}.`:b.status=='Boarded'?'On board.':b.status=='NoShow'?'Marked as no-show.':'';
const stText=b=>{const info=bookingStatusText(b);return b.payment_method=='cash'&&!['Cancelled','NoShow'].includes(b.status)?`Pay the driver in cash when boarding.${info?' '+info:''}`:info};
function reminders(){const t0=Date.now();
 const utcMs=(value)=>new Date((value&&value.includes('Z'))?value:value+':00Z').getTime();
 for(const c of q("select c.*,r.passenger_id from confirmations c join recurring r on r.id=c.rec_id where c.status='Pending' and r.status='Active'")){const left=(utcMs(c.deadline)-t0)/36e5;if(left<=0)continue;
  const fin=left<=cfg('final_remind_hours',null,3);if(fin&&c.reminded<2||!fin&&left<=cfg('remind_hours',null,24)&&c.reminded<1){notify(c.passenger_id,'Weekly review reminder',`${fin?'Final reminder: ':''}confirm your rides for the week of ${c.week_start} before ${c.deadline.replace('T',' ')}.`,tenantForRoute(one('select route_id from recurring where id=?',c.rec_id)?.route_id));run('update confirmations set reminded=? where id=?',fin?2:1,c.id)}}
 for(const b of q("select b.id,b.ref,b.passenger_id,b.arrival,b.route_id,t.dep_at from bookings b join assignments a on a.booking_id=b.id and a.status in('Reserved','Confirmed') join trips t on t.id=a.trip_id where t.status in('Planned','Loading','Delayed')")){
  const m=utcMs(b.dep_at)-t0,flags=one('select reminded from bookings where id=?',b.id).reminded||0;
  if(m>0&&m<=15*6e4&&!(flags&2)){notify(b.passenger_id,'Ride reminder',`Booking ${b.ref}: estimated departure in 15 minutes. Be at the station by ${b.arrival}.`,tenantForRoute(b.route_id));run('update bookings set reminded=reminded|2 where id=?',b.id)}
  else if(m>15*6e4&&m<=30*6e4&&!(flags&1)){notify(b.passenger_id,'Ride reminder',`Booking ${b.ref}: estimated departure in 30 minutes. Be at the station by ${b.arrival}.`,tenantForRoute(b.route_id));run('update bookings set reminded=reminded|1 where id=?',b.id)}}
 for(const t of q("select t.*,(select count(*) from assignments a where a.trip_id=t.id and a.status in('Reserved','Confirmed')) n from trips t where status in('Planned','Loading','Delayed') and exclusive_for is null")){const m=utcMs(t.dep_at)-t0,flags=t.reminded||0;
  if(t.n&&m>0&&m<=35*6e4&&!(flags&1)){notify(t.driver_id,'Trip reminder',`Trip #${t.id}: ${t.n} booking(s); start loading, estimated departure in 35 minutes.`);run('update trips set reminded=reminded|1 where id=?',t.id)}}}
function missedBoarding(tripId,force=false){const deadline=new Date(Date.now()-15*6e4).toISOString().slice(0,16),where=force?'t.id=?':'t.departed_at<=?',args=force?[tripId]:[deadline];
 for(const a of q(`select a.id assignment_id,b.*,t.id trip_id from assignments a join bookings b on b.id=a.booking_id join trips t on t.id=a.trip_id where t.status='Departed' and ${where} and a.status in('Reserved','Confirmed') and a.onboard_confirmed=0`,...args)){
  db.transaction(()=>{const active=one("select 1 x from assignments where id=? and status in('Reserved','Confirmed') and onboard_confirmed=0",a.assignment_id);if(!active)return;
   run("update assignments set status='NoShow' where id=?",a.assignment_id);
   if(a.payment_status=='Paid'&&a.paid_pesewas>=bookingTotal(a)){
    run("insert or ignore into booking_credits(booking_id,passenger_id,amount_pesewas,entry_type,created_at) values(?,?,?,?,?)",a.id,a.passenger_id,a.paid_pesewas,'NoShow',now());
    run("update bookings set paid_pesewas=0,payment_status='Credit' where id=?",a.id)}
   setB(a.id,'Queued','System','boarding not confirmed; prepaid fare carried as credit');
   notify(a.passenger_id,'Boarding credit',`Booking ${a.ref}: this car has left without your confirmation. Your prepaid fare is kept as credit and you are back in the queue for the next available car.`,tenantForRoute(a.route_id))
  })()}
 allocate()}
function noshowRule(b){const lim=cfg('noshow_limit',b.route_id,3),days=cfg('noshow_days',b.route_id,30),bd=cfg('noshow_block_days',b.route_id,14),since=addDays(new Date().toISOString().slice(0,10),-days);
 const n=one("select count(*) n from bookings where passenger_id=? and status='NoShow' and date>=?",b.passenger_id,since).n;
 if(n>=lim){run('update users set noshow_blocked_until=? where id=?',Date.now()+bd*864e5,b.passenger_id);notify(b.passenger_id,'Booking suspended',`Bookings are suspended for ${bd} days after ${n} no-shows in ${days} days.`,tenantForRoute(b.route_id))}
 else notify(b.passenger_id,'No-show warning',`No-show recorded (${n} of ${lim} allowed in ${days} days).`,tenantForRoute(b.route_id))}
api.post('/manager/users/:id/lift-block',mgr,H(req=>{const id=+req.params.id;if(!one('select 1 x from users where id=?',id))E(404,'User not found');chkPassenger(req.u,id);run('update users set noshow_blocked_until=0 where id=?',id);audit(req.u.id,'noshow.lift','user',id);return{ok:1}}));
function retention(){const cut=d=>new Date(Date.now()-d*864e5).toISOString(),nd=+process.env.NOTIF_DAYS||90,ad=+process.env.AUDIT_DAYS||730;
 run('delete from notifications where at<?',cut(nd).slice(0,16));run('delete from audit where at<?',cut(ad));run('delete from history where at<?',cut(ad).slice(0,16));run('delete from sessions where expires<?',Date.now()-30*864e5)}
api.get('/me/export',H(req=>{const u=req.u,id=u.id,bookings=q('select id,ref,route_id,date,arrival,seats,status,payment_status,payment_method,fare_pesewas,station_fee_pesewas,platform_fee_pesewas,paid_pesewas from bookings where passenger_id=?',id).map(b=>({id:b.id,ref:b.ref,route_id:b.route_id,date:b.date,arrival:b.arrival,seats:b.seats,status:b.status,payment_status:b.payment_status,payment_method:b.payment_method,total_due:'GHS '+ghs(bookingTotal(b)),amount_due:'GHS '+ghs(Math.max(0,bookingTotal(b)-b.paid_pesewas))}));return{exportedAt:new Date().toISOString(),profile:{id,phone:u.phone,name:u.name,role:u.role,consent_at:u.consent_at},bookings,bookingHistory:q('select h.* from history h join bookings b on b.id=h.booking_id where b.passenger_id=?',id),
 recurring:q('select * from recurring where passenger_id=?',id),exclusiveRequests:q('select * from excl where passenger_id=?',id),notifications:q('select event,msg,status,at from notifications where user_id=?',id),driver:u.role=='passenger'?null:one('select * from drivers where user_id=?',id)||null,vehicles:q('select * from vehicles where driver_id=?',id),documents:q('select id,kind,filename,status,at from docs where owner_id=?',id),availability:q('select * from availability where driver_id=?',id)}}));
api.post('/me/delete',H(req=>db.transaction(()=>{const u=req.u,id=u.id;if(req.body.confirm!='DELETE')E(400,'Send {"confirm":"DELETE"}');if(STAFF.includes(u.role))E(403,'Staff accounts are removed by an administrator');
 if(one("select 1 x from bookings where passenger_id=? and status='Boarded'",id)||one("select 1 x from trips where driver_id=? and status in('Planned','Loading','Departed','Delayed')",id))E(409,'You have an active trip; try again after it completes');
 run("update assignments set status='Cancelled' where status in"+ACTIVE+" and booking_id in(select id from bookings where passenger_id=? and status in('Queued','Assigned','Confirmed'))",id);run("update bookings set status='Cancelled' where passenger_id=? and status in('Queued','Assigned','Confirmed')",id);
 run("update recurring set status='Cancelled' where passenger_id=?",id);run("update excl set status='Cancelled' where passenger_id=? and status='Pending'",id);
 for(const d of q('select path from docs where owner_id=?',id))fs.rmSync(path.join(UP,d.path),{force:true});for(const t of['docs where owner_id','availability where driver_id','notifications where user_id'])run('delete from '+t+'=?',id);
 run('delete from otps where phone=?',u.phone);run("update vehicles set status='Maintenance',docs_ok=0 where driver_id=?",id);run("update drivers set licence=null,verified=0,op_status='Suspended' where user_id=?",id);
 run('update sessions set revoked=1 where user_id=?',id);run("update users set name='Deleted user',phone=?,pin_hash=null,token=null,deleted_at=? where id=?",'deleted-'+id,now(),id);audit(id,'account.delete','user',id);return{ok:1}})()));
api.post('/me/pin',H(req=>{const{oldPin,newPin}=req.body;if(!STAFF.includes(req.u.role))E(403,'Staff only');limit('pin:'+req.u.id,5,9e5);if(!okPin(oldPin,req.u.pin_hash))E(401,'Current PIN incorrect');if(String(newPin||'').length<6)E(400,'PIN must be 6+ characters');
 run('update users set pin_hash=? where id=?',hashPin(newPin),req.u.id);run('update sessions set revoked=1 where user_id=? and hash!=?',req.u.id,req.sh);audit(req.u.id,'pin.change','user',req.u.id);return{ok:1}}));

// ---- v1.5 additions: ops, expiry, consent versions, WhatsApp opt-in ----
const TV=process.env.TERMS_VERSION||'1';let lastJob=Date.now(),smsFails=0;const alertLast=new Map();
async function alertOps(key,msg){if(Date.now()-(alertLast.get(key)||0)<(+process.env.ALERT_COOLDOWN_MIN||60)*6e4)return;alertLast.set(key,Date.now());console.error('[ALERT]',msg);
 if(process.env.ALERT_WEBHOOK)await fetch(process.env.ALERT_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'Transport: '+msg,content:'Transport: '+msg}),signal:AbortSignal.timeout(8000)}).catch(e=>console.error('alert webhook failed',e.message))}
function health(){const c={};try{one('select 1 x');c.db=`ok (${DB_BACKEND})`}catch(e){c.db='FAIL: '+e.message}
 const backupExt=DB_BACKEND==='postgres'?'.dump':'.db',bf=fs.existsSync(BK)?fs.readdirSync(BK).filter(x=>x.endsWith(backupExt)).sort().pop():null,age=bf?(Date.now()-fs.statSync(path.join(BK,bf)).mtimeMs)/36e5:null;
 c.backup=age==null?'FAIL: no backup yet':age>(+process.env.BACKUP_EVERY_H||6)*2+1?`FAIL: last backup ${age.toFixed(1)}h ago`:`ok (${age.toFixed(1)}h ago)`;
 const old=one("select min(at) a from notifications where status in('Pending','Retrying')").a,failed=one("select count(*) n from notifications where status='Failed' and at>?",new Date(Date.now()-36e5).toISOString().slice(0,16)).n;
 c.messaging=failed>=(+process.env.ALERT_FAILED||5)?`FAIL: ${failed} messages failed in the last hour`:old&&Date.now()-new Date(old+'Z')>9e5?'FAIL: messages stuck for over 15 minutes':'ok';
 c.scheduler=Date.now()-lastJob>6e4?`FAIL: silent for ${Math.round((Date.now()-lastJob)/1000)}s`:'ok';return{ok:Object.values(c).every(v=>String(v).startsWith('ok')),checks:c}}
function watchdog(){const h=health();if(!h.ok){const bad=Object.entries(h.checks).filter(([,v])=>!String(v).startsWith('ok'));alertOps('health:'+bad.map(x=>x[0]),bad.map(([k,v])=>k+': '+v).join('; '))}}
app.get('/healthz/deep',(rq,res)=>{if(!process.env.HEALTH_KEY||rq.query.key!==process.env.HEALTH_KEY)return res.sendStatus(403);const h=health();res.status(h.ok?200:503).json(h)});
api.get('/admin/health',ROLE('admin'),H(()=>health()));
function expiryCheck(){const today=now().slice(0,10),in30=addDays(today,30),in7=addDays(today,7);
 for(const d of q("select * from docs where status='Verified' and expires_on is not null and expires_on<=?",in30)){
  if(d.expires_on<=today){run("update docs set status='Expired' where id=?",d.id);if(d.vehicle_id)run('update vehicles set docs_ok=0 where id=?',d.vehicle_id);
   syncDriverVerification(d.owner_id);notify(d.owner_id,'Document expired',`Your ${d.kind} has expired. You cannot be dispatched until a new one is uploaded and verified.`);notifyMgrs('Document expired',`Driver #${d.owner_id}: ${d.kind} expired.`,null,one('select station_id from drivers where user_id=?',d.owner_id)?.station_id);audit(0,'doc.expired','doc',d.id)}
  else{const lvl=d.expires_on<=in7?2:1;if(d.expiry_level<lvl){run('update docs set expiry_level=? where id=?',lvl,d.id);notify(d.owner_id,'Document expiring',`Your ${d.kind} expires on ${d.expires_on}. Please upload the renewal.`);if(lvl==2)notifyMgrs('Document expiring',`Driver #${d.owner_id}: ${d.kind} expires ${d.expires_on}.`,null,one('select station_id from drivers where user_id=?',d.owner_id)?.station_id)}}}}
const cfgOk=(u,s)=>{const[k,id]=String(s).split(':'),numericId=/^[1-9]\d*$/.test(id||'');return s=='global'?u.role=='admin':k=='station'?numericId&&!!one('select 1 x from stations where id=?',+id)&&(u.role=='admin'||STATION_STAFF.includes(u.role)&&stationInScope(u,+id)):k=='route'?numericId&&scope(u).includes(+id):false};
api.delete('/config',mgr,H(req=>{if(FEE_CONFIG_KEYS.includes(req.body.key)&&req.u.role!='admin')E(403,'Fee percentages can only be changed through the admin fees panel');if(!cfgOk(req.u,req.body.scope))E(403,'Scope not allowed');run('delete from config where scope=? and key=?',req.body.scope,req.body.key);audit(req.u.id,'config.remove','config',0,req.body);return{ok:1}}));
api.post('/me/whatsapp',H(req=>{run('update users set whatsapp_optin=? where id=?',req.body.optin?1:0,req.u.id);audit(req.u.id,'whatsapp.optin','user',req.u.id,req.body);const tenantId=req.u.tenant_id||tenantForStation(req.u.station_id);return{ok:1,enabled:!!tenantProviderSettings(tenantId||0).TWILIO_FROM_WA}}));
api.post('/me/consent',H(req=>{run('update users set consent_at=?,consent_ver=? where id=?',new Date().toISOString(),TV,req.u.id);return{ok:1}}));
app.get('/api/v1/events',(req,res)=>{const t=tix.get(req.query.ticket);tix.delete(req.query.ticket);if(!t||t.exp<Date.now())return res.sendStatus(401);
 res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','X-Accel-Buffering':'no'});res.flushHeaders();res.write('retry: 5000\n\n');
 const c={res,role:t.role};if(!conns.has(t.id))conns.set(t.id,new Set());conns.get(t.id).add(c);req.on('close',()=>conns.get(t.id)?.delete(c))});
app.post('/webhooks/sms-status',express.urlencoded({extended:false}),(req,res)=>{const tenantId=Number(req.query.tenantId),key=tenantId&&tenantProviderSettings(tenantId).WEBHOOK_KEY;if(!key||req.query.key!==key)return res.sendStatus(403);
 const st={delivered:'Delivered',failed:'Failed',undelivered:'Failed',sent:'Sent'}[req.body.MessageStatus];if(st)run('update notifications set status=? where provider_id=?',st,req.body.MessageSid);res.sendStatus(204)});
let paymentProvider = createPaymentProvider('eganow');
const providerOutcome=result=>{const s=String(result?.transactionstatus||result?.transactionStatus||result?.status||result?.data?.status||'').trim().toUpperCase();
 if(result?.isSuccess===true||['SUCCESS','SUCCESSFUL','COMPLETED'].includes(s))return'Succeeded';
 if(result?.isSuccess===false||['FAILED','FAILURE','CANCELLED','REJECTED'].includes(s))return'Failed';return'Pending'};
function applyPaymentResult(paymentId,result){
 const p=one('select * from booking_payments where id=?',paymentId);if(!p||!['Pending','NeedsReview'].includes(p.status))return p;
 const outcome=providerOutcome(result),statusText=String(result?.transactionstatus||result?.transactionStatus||result?.status||result?.data?.status||'').slice(0,40)||null;
 db.transaction(()=>{run('update booking_payments set status=?,response_status=?,updated_at=? where id=?',outcome,statusText,now(),p.id);
  if(outcome=='Succeeded'){const b=one('select * from bookings where id=?',p.booking_id),total=bookingTotal(b),paid=Math.min(total,b.paid_pesewas+p.amount_pesewas),st=paid>=total?'Paid':'Partial';
   run('update bookings set paid_pesewas=?,payment_status=? where id=?',paid,st,b.id);postBookingCollection(p.id);if(st=='Paid')ledgerRiderCharges(b);notify(b.passenger_id,'Payment received',`Payment received for booking ${b.ref}. ${st=='Paid'?'Your booking is in the dispatch queue.':'Remaining balance: GHS '+ghs(total-paid)+'.'}`,tenantForRoute(b.route_id))}})();
 if(outcome=='Succeeded')allocate();return one('select * from booking_payments where id=?',paymentId)}
api.post('/bookings/:id/pay',P,H(async req=>{
 const b=one('select * from bookings where id=? and passenger_id=?',req.params.id,req.u.id);if(!b)E(404,'Booking not found');
 if(!['Queued','Assigned'].includes(b.status))E(409,'This booking cannot be paid at this stage');
 if(b.payment_method=='cash')E(409,'This booking is paid to the driver in cash');
 if(b.payment_status=='Paid')E(409,'Booking is already paid');
 const pending=one("select 1 x from booking_payments where booking_id=? and status in('Pending','NeedsReview')",b.id);if(pending)E(409,'A payment is already pending; check its status before retrying');
 const amount=bookingTotal(b)-b.paid_pesewas;if(amount<=0)E(409,'No balance is due');
 const tenantId=one('select tenant_id from routes where id=?',b.route_id)?.tenant_id,provider=tenantPaymentProvider(tenantId);
 const partner=String(req.body.paypartnerCode||'').trim().toUpperCase();if(!isSupportedPayPartner(provider,partner))E(400,'Choose a supported mobile-money network');
 const transactionId='TP'+cr.randomBytes(12).toString('hex').toUpperCase(),created=now();
 const paymentId=run("insert into booking_payments(booking_id,transaction_id,amount_pesewas,status,created_at,updated_at) values(?,?,?,'Pending',?,?)",b.id,transactionId,amount,created,created).lastInsertRowid;
 try{const result=await provider.initiateCollection({amount:ghs(amount),transCurrencyIso:'GHS',transactionId,reference:b.ref,paypartnerCode:partner,accountNoOrCardNoOrMSISDN:normalizeMsisdn(req.u.phone),countryCode:provider.getDefaultCountryCode?.()||'GH0233',languageId:provider.getDefaultLanguage?.()||'en',callback:provider.getCallbackUrl?.()||''});
  const updated=applyPaymentResult(paymentId,result);return{paymentId,transactionId,status:updated.status,amountGhs:ghs(amount),message:updated.status=='Succeeded'?'Payment confirmed':'Approve the payment request, then check status.'}
 }catch(e){run("update booking_payments set status='NeedsReview',response_status='provider error',updated_at=? where id=?",now(),paymentId);notifyMgrs('Payment attention',`Payment for booking ${b.ref} needs provider status review.`,b.route_id);throw e}
}));
api.post('/bookings/:id/payment/status',P,H(async req=>{
 const b=one('select id,route_id from bookings where id=? and passenger_id=?',req.params.id,req.u.id);if(!b)E(404,'Booking not found');
 const p=one('select * from booking_payments where booking_id=? order by id desc limit 1',b.id);if(!p)E(404,'No payment attempt found');
 if(['Pending','NeedsReview'].includes(p.status)){const tenantId=one('select tenant_id from routes where id=?',b.route_id)?.tenant_id,result=await tenantPaymentProvider(tenantId).getTransactionStatus({transactionId:p.transaction_id});return applyPaymentResult(p.id,result)}
 return p
}));
function confirmBoarding(a,uid,reason){if(a.onboard_confirmed)return;db.transaction(()=>{run("update assignments set onboard_confirmed=1,onboard_confirmed_at=?,status='Boarded' where id=?",now(),a.id);setB(a.booking_id,'Boarded',uid,reason);
 if(a.payment_method=='cash'){const owed=q("select fee_kind,sum(amount_pesewas) amount from booking_fee_allocations where booking_id=? and payer_type in('rider','driver') group by fee_kind",a.booking_id),amounts=Object.fromEntries(owed.map(x=>[x.fee_kind,x.amount]));if((amounts.station||0)+(amounts.platform||0)+(amounts.loading||0)>0){run("insert or ignore into fee_receivables(booking_id,driver_id,station_id,station_pesewas,platform_pesewas,loading_pesewas,status,created_at,due_at) values(?,?,?,?,?,?, 'Open',?,?)",a.booking_id,a.driver_id,a.station_id||one('select origin_id from routes where id=?',a.route_id).origin_id,amounts.station||0,amounts.platform||0,amounts.loading||0,now(),new Date(Date.now()+cfg('fee_due_hours',a.route_id,24)*36e5).toISOString().slice(0,16));const receivable=one('select id from fee_receivables where booking_id=?',a.booking_id);postCashFeeReceivable(receivable.id)}}
 notifyMgrs('Rider onboard',`Booking ${a.ref} confirmed onboard trip #${a.trip_id}.`,a.route_id)})()}
api.post('/bookings/:id/board-confirm',P,H(async req=>{
 const a=one("select a.*,b.passenger_id,b.ref,b.route_id,b.payment_method,b.station_fee_pesewas,b.platform_fee_pesewas,b.driver_station_deduction_pesewas,b.driver_platform_deduction_pesewas,t.id trip_id,t.driver_id,t.status trip_status,t.departed_at from assignments a join bookings b on b.id=a.booking_id join trips t on t.id=a.trip_id where b.id=? and b.passenger_id=? and a.status in('Reserved','Confirmed','Boarded')",req.params.id,req.u.id);
 if(!a)E(404,'No active assignment');if(a.trip_status!='Departed')E(409,'Boarding confirmation opens when the driver starts the trip');
 if(a.departed_at&&Date.now()>new Date(a.departed_at+'Z').getTime()+15*6e4)E(409,'The 15-minute boarding confirmation window has closed');
 confirmBoarding(a,req.u.id,'passenger confirmed onboard');
 if(payoutGateFor(a.driver_id,a.route_id)=='onboard')await releaseDriverPayout(a.booking_id,'onboard');
 return{ok:1,confirmed:true}
}));
api.get('/porter/dashboard',ROLE('porter'),H(req=>{if(!req.u.station_id)E(403,'Porter account has no station scope');return{station_id:req.u.station_id,assignments:q(`select a.id assignment_id,a.onboard_confirmed,b.ref,u.name passenger,r.name route,b.seats,t.dep_at,t.departed_at
 from assignments a join bookings b on b.id=a.booking_id join users u on u.id=b.passenger_id join trips t on t.id=a.trip_id join routes r on r.id=b.route_id
 where r.origin_id=? and t.status='Departed' and julianday(t.departed_at)>=julianday('now','-15 minutes') and a.status in('Reserved','Confirmed','Boarded') and b.payment_status in${DISPATCHABLE_SQL}
 order by t.departed_at,a.id limit 100`,req.u.station_id)} }));
api.post('/porter/assignments/:id/board-confirm',ROLE('porter'),H(async req=>{if(!req.u.station_id)E(403,'Porter account has no station scope');const a=one(`select a.*,b.ref,b.route_id,b.payment_method,b.station_fee_pesewas,b.platform_fee_pesewas,b.driver_station_deduction_pesewas,b.driver_platform_deduction_pesewas,t.id trip_id,t.driver_id,t.status trip_status,t.departed_at,r.origin_id station_id
 from assignments a join bookings b on b.id=a.booking_id join trips t on t.id=a.trip_id join routes r on r.id=b.route_id
 where a.id=? and r.origin_id=? and a.status in('Reserved','Confirmed','Boarded') and b.payment_status in${DISPATCHABLE_SQL}`,req.params.id,req.u.station_id);
 if(!a)E(404,'No active assignment at your station');if(a.trip_status!='Departed')E(409,'Boarding check-in opens when the trip departs');
 if(a.departed_at&&Date.now()>new Date(a.departed_at+'Z').getTime()+15*6e4)E(409,'The 15-minute boarding check-in window has closed');
 confirmBoarding(a,req.u.id,'porter check-in');if(payoutGateFor(a.driver_id,a.route_id)=='onboard')await releaseDriverPayout(a.booking_id,'onboard');return{ok:1,confirmed:true}
}));
api.get('/manager/payments',mgr,H(req=>{
 const routes=scope(req.u);if(!routes.length)return{payments:[],payouts:[]};const ids=routes.join(',');
 return{payments:q(`select p.id,p.transaction_id,p.amount_pesewas,p.status,p.response_status,p.updated_at,b.ref,b.payment_status,b.date,r.name route,u.name passenger from booking_payments p join bookings b on b.id=p.booking_id join routes r on r.id=b.route_id join users u on u.id=b.passenger_id where b.route_id in(${ids}) order by p.id desc limit 100`),
  payouts:q(`select p.*,b.ref,u.name driver,r.name route from driver_payouts p join bookings b on b.id=p.booking_id join trips t on t.id=p.trip_id join routes r on r.id=t.route_id join users u on u.id=t.driver_id where t.route_id in(${ids}) order by p.id desc limit 100`)}
}));
async function releaseDriverPayout(bookingId,gate,retryFailed=false){
 const row=one("select a.onboard_confirmed,b.*,t.id trip_id,t.route_id,t.driver_id,t.status trip_status,t.settlement_confirmed_by,d.payout_partner,d.payout_msisdn from assignments a join bookings b on b.id=a.booking_id join trips t on t.id=a.trip_id join drivers d on d.user_id=t.driver_id where b.id=? and a.status in('Boarded','Completed') order by a.id desc limit 1",bookingId);
 if(!row||!row.onboard_confirmed||row.payment_status!='Paid'||row.paid_pesewas<bookingTotal(row))return null;
 const configured=payoutGateFor(row.driver_id,row.route_id);
 if(gate=='onboard'&&(configured!='onboard'||row.trip_status!='Departed'))return null;
 if(gate=='manager_completion'&&(configured!='manager_completion'||row.trip_status!='Completed'||!row.settlement_confirmed_by))return null;
 const amount=row.fare_pesewas-payoutDeduction(bookingId);if(amount<=0)return null;
 if(!row.payout_partner||!row.payout_msisdn){notifyMgrs('Payout attention',`Driver for booking ${row.ref} has no verified payout details.`,row.route_id);return null}
 const provider=tenantPaymentProvider(one('select tenant_id from routes where id=?',row.route_id)?.tenant_id);
 const existing=one('select * from driver_payouts where booking_id=?',bookingId),created=now();
 if(existing){
  if(existing.status!='Failed'||!retryFailed)return existing;
  run('insert into driver_payout_attempts(payout_id,transaction_id,amount_pesewas,status,response_status,created_at,updated_at) values(?,?,?,?,?,?,?)',existing.id,existing.transaction_id,existing.amount_pesewas,existing.status,existing.response_status,existing.created_at,existing.updated_at);
  run("update driver_payouts set transaction_id=?,status='Pending',response_status=null,updated_at=? where id=?",`TPPO${cr.randomBytes(10).toString('hex').toUpperCase()}`,created,existing.id);
 }else{
  const transactionId='TPPO'+cr.randomBytes(10).toString('hex').toUpperCase();
  run("insert into driver_payouts(booking_id,trip_id,transaction_id,amount_pesewas,gate,status,created_at,updated_at) values(?,?,?,?,?,'Pending',?,?)",bookingId,row.trip_id,transactionId,amount,gate,created,created);
 }
 const payout=one('select * from driver_payouts where booking_id=?',bookingId);
 try{const result=await provider.initiatePayout({amount:ghs(amount),transCurrencyIso:'GHS',transactionId:payout.transaction_id,reference:row.ref,paypartnerCode:row.payout_partner,accountNoOrCardNoOrMSISDN:row.payout_msisdn,countryCode:provider.getDefaultCountryCode?.()||'GH0233',languageId:provider.getDefaultLanguage?.()||'en',callback:provider.getCallbackUrl?.()||''}),status=providerOutcome(result),responseStatus=String(result?.transactionstatus||result?.transactionStatus||result?.status||result?.data?.status||'').slice(0,40)||null;
  db.transaction(()=>{run('update driver_payouts set status=?,response_status=?,updated_at=? where id=?',status,responseStatus,now(),payout.id);if(status=='Succeeded'){ledgerDriverDeductions(row);postDriverPayout(payout.id)}})();
  if(status=='Failed')notifyMgrs('Payout attention',`Payout for booking ${row.ref} failed; review provider status.`,row.route_id);
  else notify(one('select driver_id from trips where id=?',row.trip_id).driver_id,'Payout update',`Payout for booking ${row.ref}: ${status}.`);
 }catch(e){run("update driver_payouts set status='NeedsReview',response_status='provider error',updated_at=? where id=?",now(),payout.id);
  notifyMgrs('Payout attention',`Payout for booking ${row.ref} needs provider status review.`,row.route_id);console.error('Payout request needs reconciliation',e.message)}
 return one('select * from driver_payouts where id=?',payout.id)
}
api.post('/manager/trips/:id/settle',mgr,H(async req=>{
 const t=one('select * from trips where id=?',req.params.id);if(!t)E(404,'No such trip');inScope(req.u,t.route_id);if(t.status!='Completed')E(409,'Complete the trip before settlement review');
 if(payoutGateFor(t.driver_id,t.route_id)!='manager_completion')E(409,'This driver uses the onboard-confirmation payout timing');
 run('update trips set settlement_confirmed_by=?,settlement_confirmed_at=? where id=?',req.u.id,now(),t.id);
 const bookings=q("select booking_id from assignments where trip_id=? and status in('Boarded','Completed') and onboard_confirmed=1",t.id),payouts=[];
 for(const b of bookings){const p=await releaseDriverPayout(b.booking_id,'manager_completion');if(p)payouts.push(p.status)}
 audit(req.u.id,'trip.settle','trip',t.id,{confirmedRiders:bookings.length,payouts:payouts.length});return{ok:1,confirmedRiders:bookings.length,payouts:payouts.length}
}));
api.post('/manager/payouts/:id/status',mgr,H(async req=>{
 const p=one('select p.*,t.route_id from driver_payouts p join trips t on t.id=p.trip_id where p.id=?',req.params.id);if(!p)E(404,'Payout not found');inScope(req.u,p.route_id);
 if(!['Pending','NeedsReview'].includes(p.status))return p;const tenantId=one('select tenant_id from routes where id=?',p.route_id)?.tenant_id,result=await tenantPaymentProvider(tenantId).getTransactionStatus({transactionId:p.transaction_id}),status=providerOutcome(result),responseStatus=String(result?.transactionstatus||result?.transactionStatus||result?.status||result?.data?.status||'').slice(0,40)||null;
 const booking=one('select b.* from bookings b where b.id=?',p.booking_id);
 db.transaction(()=>{run('update driver_payouts set status=?,response_status=?,updated_at=? where id=?',status,responseStatus,now(),p.id);if(status=='Succeeded'){ledgerDriverDeductions(booking);postDriverPayout(p.id)}})();
 return one('select * from driver_payouts where id=?',p.id)
}));
api.post('/manager/payouts/:id/retry',mgr,H(async req=>{
 const p=one('select p.*,t.route_id from driver_payouts p join trips t on t.id=p.trip_id where p.id=?',req.params.id);
 if(!p)E(404,'Payout not found');inScope(req.u,p.route_id);if(p.status!='Failed')E(409,'Only failed payouts can be retried');
 const retried=await releaseDriverPayout(p.booking_id,p.gate,true);if(!retried)E(409,'Payout is no longer eligible for retry');
 audit(req.u.id,'payout.retry','payout',p.id,{transactionId:retried.transaction_id});return{ id:retried.id,transactionId:retried.transaction_id,status:retried.status }
}));
function settlementBalanceRows(day){
 const allocations=q(`with normalized as(
  select b.date,a.fee_kind,a.stream,
   case when b.payment_method='cash' and a.stream='rider' and a.payer_type='rider' then 'driver' else a.payer_type end payer_type,
   case when b.payment_method='cash' and a.stream='rider' and a.payer_type='rider' then
    (select t.driver_id from assignments a2 join trips t on t.id=a2.trip_id where a2.booking_id=b.id and a2.onboard_confirmed=1 order by a2.id desc limit 1)
    when a.payer_type='driver' and a.payer_id is null then
    (select t.driver_id from assignments a2 join trips t on t.id=a2.trip_id where a2.booking_id=b.id and a2.onboard_confirmed=1 order by a2.id desc limit 1)
    else a.payer_id end payer_id,
   a.recipient_type,a.recipient_id,a.organization_id,a.origin_tenant_id,r.origin_id origin_station_id,a.amount_pesewas
  from booking_fee_allocations a join bookings b on b.id=a.booking_id join routes r on r.id=b.route_id
  where b.date=? and b.status not in('Cancelled','NoShow') and (
   a.stream='rider' and ((b.payment_method='cash' and exists(select 1 from assignments x where x.booking_id=b.id and x.onboard_confirmed=1)) or (b.payment_method!='cash' and b.payment_status='Paid'))
   or a.stream='driver' and ((b.payment_method='cash' and exists(select 1 from assignments x where x.booking_id=b.id and x.onboard_confirmed=1)) or exists(select 1 from driver_payouts p where p.booking_id=b.id and p.status='Succeeded'))
  )
 )
 select date,fee_kind,stream,payer_type,payer_id,recipient_type,recipient_id,organization_id,origin_tenant_id,origin_station_id,sum(amount_pesewas) due_pesewas
 from normalized group by date,fee_kind,stream,payer_type,payer_id,recipient_type,recipient_id,organization_id,origin_tenant_id,origin_station_id`,day);
 const events=q('select payer_type,payer_id,recipient_type,recipient_id,fee_kind,stream,sum(amount_pesewas) settled_pesewas from fee_settlement_entries where settlement_date=? group by payer_type,payer_id,recipient_type,recipient_id,fee_kind,stream',day),settled=new Map(events.map(x=>[JSON.stringify([x.payer_type,x.payer_id,x.recipient_type,x.recipient_id,x.fee_kind,x.stream]),x.settled_pesewas]));
 const partyName=(type,id)=>type=='platform'?'Platform':type=='tenant'?one('select name from tenants where id=?',id)?.name||'Tenant':type=='organization'?one('select name from organizations where id=?',id)?.name||'Organization':one('select name from users where id=?',id)?.name||type;
 return allocations.map(x=>{const key=JSON.stringify([x.payer_type,x.payer_id,x.recipient_type,x.recipient_id,x.fee_kind,x.stream]),settledPesewas=settled.get(key)||0;return{...x,payer_name:partyName(x.payer_type,x.payer_id),recipient_name:partyName(x.recipient_type,x.recipient_id),settled_pesewas:settledPesewas,balance_pesewas:x.due_pesewas-settledPesewas}}).filter(x=>x.balance_pesewas>0)
}
function settlementInScope(u,row){if(u.role=='admin')return true;if(u.organization_id)return row.organization_id==u.organization_id||row.payer_type=='organization'&&row.payer_id==u.organization_id||row.recipient_type=='organization'&&row.recipient_id==u.organization_id;if(u.tenant_id)return row.origin_tenant_id==u.tenant_id||row.payer_type=='tenant'&&row.payer_id==u.tenant_id||row.recipient_type=='tenant'&&row.recipient_id==u.tenant_id;return row.origin_station_id==u.station_id}
api.get('/manager/settlements',mgr,H(req=>{const day=String(req.query.date||new Date().toISOString().slice(0,10));if(!validDate(day))E(400,'date must be YYYY-MM-DD');return rep(req,settlementBalanceRows(day).filter(row=>settlementInScope(req.u,row)))}));
api.post('/manager/settlements',mgr,H(req=>{const day=String(req.body.date||''),payerType=String(req.body.payerType||''),payerId=Number(req.body.payerId)||null,recipientType=String(req.body.recipientType||''),recipientId=Number(req.body.recipientId)||null,feeKind=String(req.body.feeKind||''),stream=String(req.body.stream||''),raw=String(req.body.amountGhs??''),reference=String(req.body.reference||'').trim();if(!validDate(day)||!['rider','driver','organization','tenant'].includes(payerType)||!['platform','tenant','organization'].includes(recipientType)||!['station','platform','loading'].includes(feeKind)||!['rider','driver'].includes(stream)||!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw))E(400,'Valid date, parties, fee, stream and amount are required');const amount=toPesewas(raw),row=settlementBalanceRows(day).find(x=>x.payer_type==payerType&&x.payer_id==payerId&&x.recipient_type==recipientType&&x.recipient_id==recipientId&&x.fee_kind==feeKind&&x.stream==stream);if(!row)E(404,'No outstanding settlement balance for this selection');if(!settlementInScope(req.u,row))E(403,'Settlement is outside your organization or tenant scope');if(amount<=0||amount>row.balance_pesewas)E(400,'Settlement amount must be positive and no greater than the outstanding balance');if(reference.length>100)E(400,'Reference must be 100 characters or fewer');const id=run('insert into fee_settlement_entries(settlement_date,payer_type,payer_id,recipient_type,recipient_id,fee_kind,stream,amount_pesewas,reference,recorded_by,created_at) values(?,?,?,?,?,?,?,?,?,?,?)',day,payerType,payerId,recipientType,recipientId,feeKind,stream,amount,reference||null,req.u.id,now()).lastInsertRowid;audit(req.u.id,'fees.settlement','fee_settlement',id,{date:day,payerType,payerId,recipientType,recipientId,feeKind,stream,amountPesewas:amount,reference});return{id,balance_pesewas:row.balance_pesewas-amount}}));
function feeReceivableBalances(id){const r=one('select * from fee_receivables where id=?',id);if(!r)return null;
 const paid=Object.fromEntries(q('select fee_kind,sum(amount_pesewas) n from fee_allocations where receivable_id=? group by fee_kind',id).map(x=>[x.fee_kind,x.n])),stationOutstanding=Math.max(0,r.station_pesewas-(paid.station||0)),platformOutstanding=Math.max(0,r.platform_pesewas-(paid.platform||0)),loadingOutstanding=Math.max(0,r.loading_pesewas-(paid.loading||0));
 return{...r,station_outstanding_pesewas:stationOutstanding,platform_outstanding_pesewas:platformOutstanding,loading_outstanding_pesewas:loadingOutstanding,outstanding_pesewas:stationOutstanding+platformOutstanding+loadingOutstanding}}
function refreshFeeReceivable(id){const b=feeReceivableBalances(id);if(!b)return;
 const allocated=b.station_pesewas+b.platform_pesewas+b.loading_pesewas-b.outstanding_pesewas,status=b.outstanding_pesewas==0?'Settled':allocated?'PartiallyPaid':'Open';
 run('update fee_receivables set status=? where id=?',status,id);
 if(status=='Settled')for(const kind of['station','platform']){
  const amount=one("select coalesce(sum(case when kind='waiver' then -amount_pesewas else amount_pesewas end),0) n from fee_allocations where receivable_id=? and fee_kind=?",id,kind).n,rec=one('select booking_id,station_id from fee_receivables where id=?',id);
  if(amount)run("insert or ignore into fee_ledger(booking_id,station_id,source,kind,amount_pesewas,created_at) values(?,?,'cash_settlement',?,?,?)",rec.booking_id,rec.station_id,kind,amount,now())
 }}
function applyFeeAllocation({collectionId=null,receivableId,feeKind,amount,kind,reason=null,recordedBy=null,approvedBy=null}){const id=run('insert into fee_allocations(collection_id,receivable_id,fee_kind,amount_pesewas,kind,reason,recorded_by,approved_by,created_at) values(?,?,?,?,?,?,?,?,?)',collectionId,receivableId,feeKind,amount,kind,reason,recordedBy,approvedBy,now()).lastInsertRowid;refreshFeeReceivable(receivableId);if(kind!='collection')postFeeAdjustment(id)}
function applyFeeCollectionResult(id,result){const c=one('select * from fee_collections where id=?',id);if(!c||!['Pending','NeedsReview'].includes(c.status))return c;
 const outcome=providerOutcome(result),statusText=String(result?.transactionstatus||result?.transactionStatus||result?.status||result?.data?.status||'').slice(0,40)||null;
 db.transaction(()=>{if(outcome=='Succeeded'){
  const outstanding=feeOutstanding(c.driver_id);if(c.amount_pesewas>outstanding){run("update fee_collections set status='NeedsReview',response_status='collected amount exceeds outstanding balance',updated_at=? where id=?",now(),c.id);return}
  run("update fee_collections set status='Succeeded',response_status=?,updated_at=? where id=?",statusText,now(),c.id);
  let left=c.amount_pesewas;
  for(const r of q("select * from fee_receivables where driver_id=? and status!='Settled' order by created_at,id",c.driver_id)){
   for(const kind of['station','platform','loading']){if(!left)break;const b=feeReceivableBalances(r.id),due=kind=='station'?b.station_outstanding_pesewas:kind=='platform'?b.platform_outstanding_pesewas:b.loading_outstanding_pesewas,amount=Math.min(left,due);
    if(amount){applyFeeAllocation({collectionId:c.id,receivableId:r.id,feeKind:kind,amount,kind:'collection'});left-=amount}}
   if(!left)break
  }
  postFeeCollection(c.id)
 }else run('update fee_collections set status=?,response_status=?,updated_at=? where id=?',outcome,statusText,now(),c.id)})();
 const updated=one('select * from fee_collections where id=?',id);if(updated.status=='NeedsReview')notifyMgrs('Fee due',`Fee collection ${updated.transaction_id} needs review.`,null,one('select station_id from drivers where user_id=?',updated.driver_id)?.station_id);return updated}
api.get('/drivers/me/fees',DR,H(req=>{
 const receivables=q("select r.*,b.ref,b.date from fee_receivables r join bookings b on b.id=r.booking_id where r.driver_id=? order by r.created_at desc,r.id desc",req.u.id).map(r=>feeReceivableBalances(r.id)).map(r=>({...r,ref:one('select ref from bookings where id=?',r.booking_id).ref,date:one('select date from bookings where id=?',r.booking_id).date}));
 return{receivables,outstanding_pesewas:feeOutstanding(req.u.id),collections:q('select id,transaction_id,amount_pesewas,status,response_status,created_at,updated_at from fee_collections where driver_id=? order by id desc limit 50',req.u.id)}
}));
api.post('/drivers/me/fees/pay',DR,H(async req=>{
 const raw=String(req.body.amountGhs??'');if(!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw))E(400,'amountGhs must be a positive amount with at most two decimals');
 const amount=toPesewas(raw),outstanding=feeOutstanding(req.u.id);if(amount<=0||amount>outstanding)E(400,'Amount must be positive and no greater than the outstanding balance');
 if(one("select 1 x from fee_collections where driver_id=? and status in('Pending','NeedsReview')",req.u.id))E(409,'A fee collection is already pending; check its status first');
 const d=one('select payout_partner,payout_msisdn,station_id from drivers where user_id=?',req.u.id);if(!d?.payout_partner||!d.payout_msisdn)E(409,'Set verified MoMo payout details before paying fees');
 const provider=tenantPaymentProvider(tenantForStation(d.station_id));if(!isSupportedPayPartner(provider,d.payout_partner))E(400,'Saved payout network is not supported by the tenant payment provider');
 const transactionId='TF'+cr.randomBytes(12).toString('hex').toUpperCase(),created=now(),id=run("insert into fee_collections(driver_id,transaction_id,amount_pesewas,status,created_at,updated_at) values(?,?,?,'Pending',?,?)",req.u.id,transactionId,amount,created,created).lastInsertRowid;
 try{const result=await provider.initiateCollection({amount:ghs(amount),transCurrencyIso:'GHS',transactionId,reference:transactionId,paypartnerCode:d.payout_partner,accountNoOrCardNoOrMSISDN:d.payout_msisdn,countryCode:provider.getDefaultCountryCode?.()||'GH0233',languageId:provider.getDefaultLanguage?.()||'en',callback:provider.getCallbackUrl?.()||''});
  const updated=applyFeeCollectionResult(id,result);return{transactionId,status:updated.status,amountGhs:ghs(amount),message:updated.status=='Succeeded'?'Fee payment confirmed':'Approve the MoMo request, then check status.'}
 }catch(e){run("update fee_collections set status='NeedsReview',response_status='provider error',updated_at=? where id=?",now(),id);notifyMgrs('Fee due',`Fee collection ${transactionId} needs provider review.`,null,d.station_id);throw e}
}));
api.post('/drivers/me/fees/status',DR,H(async req=>{
 const c=req.body.transactionId?one('select * from fee_collections where driver_id=? and transaction_id=?',req.u.id,String(req.body.transactionId)):one("select * from fee_collections where driver_id=? and status in('Pending','NeedsReview') order by id desc limit 1",req.u.id);
 if(!c)E(404,'No pending fee collection found');if(!['Pending','NeedsReview'].includes(c.status))return c;
 const stationId=one('select station_id from drivers where user_id=?',req.u.id)?.station_id,provider=tenantPaymentProvider(tenantForStation(stationId)),result=await provider.getTransactionStatus({transactionId:c.transaction_id});return applyFeeCollectionResult(c.id,result)
}));
function inFeeScope(u,stationId){if(u.role=='admin')return;if(!STATION_STAFF.includes(u.role)||!stationInScope(u,stationId))E(403,'Outside your tenant scope')}
api.get('/manager/fees',mgr,H(req=>{
 const where=STATION_STAFF.includes(req.u.role)?req.u.organization_id?'where r.station_id in(select s.id from stations s join org_tenants ot on ot.tenant_id=s.tenant_id where ot.organization_id=?)':req.u.tenant_id?'where r.station_id in(select id from stations where tenant_id=?)':'where r.station_id=?':'',args=STATION_STAFF.includes(req.u.role)?[req.u.organization_id||req.u.tenant_id||req.u.station_id]:[];
 const receivables=q(`select r.id,r.booking_id,r.driver_id,r.station_id,r.station_pesewas,r.platform_pesewas,r.loading_pesewas,r.status,r.created_at,r.due_at,b.ref,b.date,u.name driver from fee_receivables r join bookings b on b.id=r.booking_id join users u on u.id=r.driver_id ${where} order by r.created_at desc,r.id desc`,...args).map(r=>({...r,...feeReceivableBalances(r.id)}));
 const adjustments=q(`select x.*,r.station_id,r.booking_id,b.ref,u.name recorder from fee_adjustments x join fee_receivables r on r.id=x.receivable_id join bookings b on b.id=r.booking_id join users u on u.id=x.recorded_by ${where} order by x.id desc limit 100`,...args);
 return{receivables,adjustments}
}));
api.post('/manager/fees/receivables/:id/adjust',mgr,H(req=>{
 const r=one('select * from fee_receivables where id=?',req.params.id);if(!r)E(404,'Receivable not found');inFeeScope(req.u,r.station_id);
 const kind=String(req.body.kind||''),reason=String(req.body.reason||'').trim(),raw=String(req.body.amountGhs??'');if(!['waiver','manual_settlement'].includes(kind)||!reason||!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw))E(400,'A valid action, amount and reason are required');
 const amount=toPesewas(raw),balance=feeReceivableBalances(r.id);if(amount<=0||amount>balance.outstanding_pesewas)E(400,'Amount must be positive and no greater than the receivable balance');
 const pending=cfg('fee_manual_needs_approval',null,0)==1,created=now(),id=db.transaction(()=>{
  const adjustmentId=run('insert into fee_adjustments(receivable_id,kind,amount_pesewas,reason,recorded_by,status,created_at,updated_at) values(?,?,?,?,?,?,?,?)',r.id,kind,amount,reason,req.u.id,pending?'Pending':'Applied',created,created).lastInsertRowid;
  if(!pending){let left=amount;for(const feeKind of['station','platform','loading']){const b=feeReceivableBalances(r.id),due=feeKind=='station'?b.station_outstanding_pesewas:feeKind=='platform'?b.platform_outstanding_pesewas:b.loading_outstanding_pesewas,take=Math.min(left,due);if(take){applyFeeAllocation({receivableId:r.id,feeKind,amount:take,kind,reason,recordedBy:req.u.id,approvedBy:req.u.id});left-=take}}}
  audit(req.u.id,pending?'fees.adjustment.request':'fees.adjustment.apply','fee_receivable',r.id,{adjustmentId,kind,amountPesewas:amount,reason});return adjustmentId
 })();
 return{id,status:pending?'Pending':'Applied'}
}));
api.post('/manager/fees/adjustments/:id/approve',mgr,H(req=>{
 const a=one('select x.*,r.station_id from fee_adjustments x join fee_receivables r on r.id=x.receivable_id where x.id=?',req.params.id);if(!a||a.status!='Pending')E(409,'Adjustment is not pending');inFeeScope(req.u,a.station_id);if(a.recorded_by==req.u.id)E(403,'A different staff member must approve this adjustment');
 db.transaction(()=>{const balance=feeReceivableBalances(a.receivable_id);if(a.amount_pesewas>balance.outstanding_pesewas)E(409,'Receivable balance changed; record a new adjustment');
  run("update fee_adjustments set status='Applied',approved_by=?,updated_at=? where id=?",req.u.id,now(),a.id);
  let left=a.amount_pesewas;for(const feeKind of['station','platform','loading']){const b=feeReceivableBalances(a.receivable_id),due=feeKind=='station'?b.station_outstanding_pesewas:feeKind=='platform'?b.platform_outstanding_pesewas:b.loading_outstanding_pesewas,take=Math.min(left,due);if(take){applyFeeAllocation({receivableId:a.receivable_id,feeKind,amount:take,kind:a.kind,reason:a.reason,recordedBy:a.recorded_by,approvedBy:req.u.id});left-=take}}
  audit(req.u.id,'fees.adjustment.approve','fee_receivable',a.receivable_id,{adjustmentId:a.id,recordedBy:a.recorded_by,kind:a.kind,amountPesewas:a.amount_pesewas,reason:a.reason})
 })();return{ok:1}
}));
api.get('/reports/fees',mgr,H(req=>{
 const[f,t]=rng(req),where=['l.created_at>=?','l.created_at<=?'],args=[f+'T00:00',t+'T99'];if(STATION_STAFF.includes(req.u.role)){if(req.u.organization_id){where.push('l.station_id in(select s.id from stations s join org_tenants ot on ot.tenant_id=s.tenant_id where ot.organization_id=?)');args.push(req.u.organization_id)}else if(req.u.tenant_id){where.push('l.station_id in(select id from stations where tenant_id=?)');args.push(req.u.tenant_id)}else{where.push('l.station_id=?');args.push(req.u.station_id||0)}}
 return rep(req,q(`select l.created_at,l.station_id,s.name station,b.ref,b.payment_method,l.source,l.kind,l.amount_pesewas from fee_ledger l join stations s on s.id=l.station_id join bookings b on b.id=l.booking_id where ${where.join(' and ')} order by l.created_at,l.id`,...args))
}));
function accountingRange(req){const to=String(req.query.to||new Date().toISOString().slice(0,10)),from=String(req.query.from||new Date(Date.now()-29*864e5).toISOString().slice(0,10));if(!validDate(from)||!validDate(to)||from>to)E(400,'Enter a valid accounting date range');return{from,to}}
function accountingScope(req,fields){
 if(req.u.role=='admin'){
  const raw=String(req.query.tenantId||'');if(!raw||raw=='all')return{sql:'1=1',args:[]};if(raw=='platform')return{sql:`${fields.tenant} is null`,args:[]};
  const tenantId=Number(raw);if(!Number.isSafeInteger(tenantId)||tenantId<1||!one('select 1 x from tenants where id=?',tenantId))E(400,'Choose a valid tenant scope');return{sql:`${fields.tenant}=?`,args:[tenantId]}
 }
 if(req.u.organization_id)return{sql:`${fields.organization}=?`,args:[req.u.organization_id]};
 if(req.u.tenant_id)return{sql:`${fields.tenant}=?`,args:[req.u.tenant_id]};
 if(req.u.station_id)return{sql:`${fields.station}=?`,args:[req.u.station_id]};
 E(403,'Accounting access requires an assigned organization, tenant, or station')
}
const accountingRows=(req,format)=>{const{from,to}=accountingRange(req),scope=accountingScope(req,{tenant:'t.tenant_id',organization:'t.organization_id',station:'t.station_id'}),args=[from,to,...scope.args],where=`substr(t.effective_at,1,10) between ? and ? and ${scope.sql}`;
 const journalLimit=req.query.format=='csv'?'':'limit 500',journal=q(`select t.id,t.effective_at,t.source_type,t.memo,t.reference,t.tenant_id,tn.name tenant,t.organization_id,o.name organization,t.station_id,s.name station,a.code account_code,a.name account,a.account_type,e.debit_pesewas,e.credit_pesewas
  from ledger_transactions t join ledger_entries e on e.transaction_id=t.id join ledger_accounts a on a.id=e.account_id left join tenants tn on tn.id=t.tenant_id left join organizations o on o.id=t.organization_id left join stations s on s.id=t.station_id where ${where} order by t.effective_at desc,t.id desc,e.line_number ${journalLimit}`,...args);
 const periodAccounts=q(`select a.code,a.name,a.account_type,sum(e.debit_pesewas) debits_pesewas,sum(e.credit_pesewas) credits_pesewas
  from ledger_transactions t join ledger_entries e on e.transaction_id=t.id join ledger_accounts a on a.id=e.account_id where ${where} group by a.id order by a.code`,...args).map(row=>({...row,amount_pesewas:row.account_type=='revenue'?row.credits_pesewas-row.debits_pesewas:row.account_type=='expense'?row.debits_pesewas-row.credits_pesewas:0}));
 const balanceScope=accountingScope(req,{tenant:'t.tenant_id',organization:'t.organization_id',station:'t.station_id'}),balances=q(`select a.code,a.name,a.account_type,coalesce(sum(e.debit_pesewas),0) debits_pesewas,coalesce(sum(e.credit_pesewas),0) credits_pesewas
  from ledger_accounts a left join ledger_entries e on e.account_id=a.id and e.transaction_id in(select t.id from ledger_transactions t where substr(t.effective_at,1,10)<=? and ${balanceScope.sql}) where a.active=1 group by a.id order by a.code`,to,...balanceScope.args).map(row=>({...row,balance_pesewas:['asset','expense'].includes(row.account_type)?row.debits_pesewas-row.credits_pesewas:row.credits_pesewas-row.debits_pesewas}));
 const sourceChecks=[
  ['booking_payment',`select 'booking_payment' source_type,p.id source_id,p.transaction_id reference,p.amount_pesewas amount_pesewas,p.updated_at effective_at from booking_payments p join bookings b on b.id=p.booking_id join routes r on r.id=b.route_id`,'r'],
  ['driver_payout',`select 'driver_payout' source_type,p.id source_id,p.transaction_id reference,p.amount_pesewas amount_pesewas,p.updated_at effective_at from driver_payouts p join bookings b on b.id=p.booking_id join routes r on r.id=b.route_id`,'r'],
  ['fee_collection',`select 'fee_collection' source_type,c.id source_id,c.transaction_id reference,c.amount_pesewas amount_pesewas,c.updated_at effective_at from fee_collections c join drivers d on d.user_id=c.driver_id`,'d']
 ];
 const unposted=[];
 for(const[type,sql,alias]of sourceChecks){const scoped=accountingScope(req,{tenant:`${alias}.tenant_id`,organization:`${alias}.organization_id`,station:alias=='r'?`${alias}.origin_id`:`${alias}.station_id`});const sourceTable=type=='booking_payment'?'booking_payments':type=='driver_payout'?'driver_payouts':'fee_collections',sourceAlias=type=='booking_payment'?'p':type=='driver_payout'?'p':'c';unposted.push(...q(`${sql} where ${sourceAlias}.status='Succeeded' and substr(${sourceAlias}.updated_at,1,10) between ? and ? and ${scoped.sql} and not exists(select 1 from ledger_transactions lt where lt.source_type=? and lt.source_id=cast(${sourceAlias}.id as text)) order by ${sourceAlias}.id limit 100`,from,to,...scoped.args,type).map(row=>({...row,amount_pesewas:row.amount_pesewas,source_table:sourceTable})))}
 const cashScope=accountingScope(req,{tenant:'station.tenant_id',organization:'b.organization_id',station:'fr.station_id'}),cashUnposted=q(`select 'cash_fee_receivable' source_type,fr.id source_id,b.ref reference,fr.station_pesewas+fr.platform_pesewas+fr.loading_pesewas amount_pesewas,fr.created_at effective_at from fee_receivables fr join bookings b on b.id=fr.booking_id join stations station on station.id=fr.station_id where fr.station_pesewas+fr.platform_pesewas+fr.loading_pesewas>0 and substr(fr.created_at,1,10) between ? and ? and ${cashScope.sql} and not exists(select 1 from ledger_transactions lt where lt.source_type='cash_fee_receivable' and lt.source_id=cast(fr.id as text)) order by fr.id limit 100`,from,to,...cashScope.args);unposted.push(...cashUnposted.map(row=>({...row,source_table:'fee_receivables'})));
 const adjustmentScope=accountingScope(req,{tenant:'station.tenant_id',organization:'b.organization_id',station:'fr.station_id'}),adjustmentUnposted=q(`select 'fee_adjustment' source_type,a.id source_id,b.ref reference,a.amount_pesewas,a.created_at effective_at from fee_allocations a join fee_receivables fr on fr.id=a.receivable_id join bookings b on b.id=fr.booking_id join stations station on station.id=fr.station_id where a.kind in('waiver','manual_settlement') and substr(a.created_at,1,10) between ? and ? and ${adjustmentScope.sql} and not exists(select 1 from ledger_transactions lt where lt.source_type='fee_adjustment' and lt.source_id=cast(a.id as text)) order by a.id limit 100`,from,to,...adjustmentScope.args);unposted.push(...adjustmentUnposted.map(row=>({...row,source_table:'fee_allocations'})));
 const broken=q(`select t.id,t.source_type,t.source_id,sum(e.debit_pesewas) debits_pesewas,sum(e.credit_pesewas) credits_pesewas from ledger_transactions t join ledger_entries e on e.transaction_id=t.id where ${where} group by t.id having sum(e.debit_pesewas)!=sum(e.credit_pesewas)`,...args);
 const income=periodAccounts.filter(row=>row.account_type=='revenue').reduce((sum,row)=>sum+row.amount_pesewas,0),expenses=periodAccounts.filter(row=>row.account_type=='expense').reduce((sum,row)=>sum+row.amount_pesewas,0);
 return{from,to,journal,accounts:balances,periodAccounts,income_pesewas:income,expenses_pesewas:expenses,net_pesewas:income-expenses,reconciliation:{unposted,unposted_count:unposted.length,unbalanced_transactions:broken.length,unallocated_receipts_pesewas:balances.find(row=>row.code=='2990')?.balance_pesewas||0}}
};
api.get('/accounting/report',mgr,PERM('accounting.read','accountant'),H(req=>accountingRows(req)));
api.get('/accounting/journal',mgr,PERM('accounting.read','accountant'),H(req=>rep(req,accountingRows(req).journal)));
api.get('/accounting/income-expenses',mgr,PERM('accounting.read','accountant'),H(req=>rep(req,accountingRows(req).periodAccounts.filter(row=>['revenue','expense'].includes(row.account_type)))));
api.get('/accounting/reconciliation',mgr,PERM('accounting.read','accountant'),H(req=>accountingRows(req).reconciliation));
api.post('/accounting/expenses',mgr,PERM('accounting.expense','accountant'),H(req=>{
 const date=String(req.body.date||''),category=String(req.body.category||'').trim(),description=String(req.body.description||'').trim(),reference=String(req.body.reference||'').trim(),raw=String(req.body.amountGhs??'');
 if(!validDate(date)||!category||category.length>80||!description||description.length>240||reference.length>100||!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw))E(400,'Enter a valid date, category, description, amount and optional reference');
 const amount=toPesewas(raw);if(amount<=0||!Number.isSafeInteger(amount))E(400,'Expense amount must be positive and within the supported range');
 let tenantId=null,organizationId=null,stationId=null;
 if(req.u.role=='admin'){
  tenantId=Number(req.body.tenantId)||null;if(tenantId&&!one('select 1 x from tenants where id=?',tenantId))E(400,'Choose a valid tenant');
  organizationId=Number(req.body.organizationId)||null;if(organizationId&&(!tenantId||!one('select 1 x from org_tenants where organization_id=? and tenant_id=?',organizationId,tenantId)))E(400,'Choose an organization connected to the selected tenant');
  stationId=Number(req.body.stationId)||null;if(stationId&&tenantForStation(stationId)!=tenantId)E(400,'Choose a station in the selected tenant')
 }else{
  tenantId=req.u.tenant_id||tenantForStation(req.u.station_id);organizationId=req.u.organization_id||null;stationId=req.u.station_id||null;
  if(organizationId&&tenantId&&!one('select 1 x from org_tenants where organization_id=? and tenant_id=?',organizationId,tenantId))E(403,'Expense scope is outside your organization')
 }
 const id=cr.randomBytes(16).toString('hex'),transactionId=postLedgerTransaction({sourceType:'manual_expense',sourceId:id,tenantId,organizationId,stationId,effectiveAt:`${date}T12:00:00.000Z`,memo:`${category}: ${description}`,reference:reference||null,createdBy:req.u.id,lines:[{account:'6200',debit:amount,credit:0},{account:'1010',debit:0,credit:amount}]});
 audit(req.u.id,'accounting.expense.record','ledger_transaction',transactionId,{category,amountPesewas:amount,tenantId,organizationId,stationId,reference});return{id:transactionId}
}));
api.post('/accounting/expenses/:id/reverse',mgr,PERM('accounting.expense','accountant'),H(req=>{
 const id=Number(req.params.id),reason=String(req.body.reason||'').trim(),date=String(req.body.date||new Date().toISOString().slice(0,10));if(!Number.isSafeInteger(id)||id<1||!reason||reason.length>240||!validDate(date))E(400,'Enter a valid reversal date and reason');
 const scope=accountingScope(req,{tenant:'t.tenant_id',organization:'t.organization_id',station:'t.station_id'}),original=one(`select t.* from ledger_transactions t where t.id=? and t.source_type='manual_expense' and ${scope.sql}`,id,...scope.args);if(!original)E(404,'Manual expense not found in your accounting scope');
 if(one("select 1 x from ledger_transactions where source_type='manual_expense_reversal' and source_id=?",String(id)))E(409,'This expense has already been reversed');
 const lines=q('select a.code,e.debit_pesewas,e.credit_pesewas from ledger_entries e join ledger_accounts a on a.id=e.account_id where e.transaction_id=? order by e.line_number',id).map(line=>({account:line.code,debit:line.credit_pesewas,credit:line.debit_pesewas}));
 const reversalId=postLedgerTransaction({sourceType:'manual_expense_reversal',sourceId:id,tenantId:original.tenant_id,organizationId:original.organization_id,stationId:original.station_id,effectiveAt:`${date}T12:00:00.000Z`,memo:`Expense reversal: ${reason}`,reference:original.reference,createdBy:req.u.id,lines});audit(req.u.id,'accounting.expense.reverse','ledger_transaction',reversalId,{originalId:id,reason});return{id:reversalId}
}));
api.get('/reports/accounting-journal',mgr,PERM('accounting.read','accountant'),H(req=>rep(req,accountingRows(req).journal)));
api.get('/reports/accounting-income-expenses',mgr,PERM('accounting.read','accountant'),H(req=>rep(req,accountingRows(req).periodAccounts.filter(row=>['revenue','expense'].includes(row.account_type)))));
api.get('/reports/accounting-reconciliation',mgr,PERM('accounting.read','accountant'),H(req=>rep(req,accountingRows(req).reconciliation.unposted)));
function backfillAccountingLedger(){
 q("select id from booking_payments where status='Succeeded' order by id").forEach(row=>postBookingCollection(row.id));
 q("select id from driver_payouts where status='Succeeded' order by id").forEach(row=>postDriverPayout(row.id));
 q("select id from fee_collections where status='Succeeded' order by id").forEach(row=>postFeeCollection(row.id));
 q('select id from fee_receivables where station_pesewas+platform_pesewas+loading_pesewas>0 order by id').forEach(row=>postCashFeeReceivable(row.id));
 q("select id from fee_allocations where kind in('waiver','manual_settlement') order by id").forEach(row=>postFeeAdjustment(row.id))
}
backfillAccountingLedger();
app.use('/api/v1',api);
const bk=require('./backup'),BK=path.resolve(process.env.BACKUP_DIR||'backups'),backup=()=>DB_BACKEND==='postgres'?bk.backupPostgres(BK,+process.env.BACKUP_KEEP||28):bk.backup(db,BK,+process.env.BACKUP_KEEP||28);
if(require.main===module){setInterval(()=>{try{jobs();lastJob=Date.now()}catch(e){console.error(e)}},+process.env.JOB_MS||10000);
 setInterval(()=>conns.forEach(s=>s.forEach(c=>c.res.write(': ping\n\n'))),25000).unref();
 const doBackup=()=>backup().then(f=>{console.log('backup',f);if(process.env.BACKUP_PING_URL)fetch(process.env.BACKUP_PING_URL).catch(()=>{})},e=>{console.error('BACKUP FAILED',e);alertOps('backup','BACKUP FAILED: '+e.message)});setInterval(doBackup,(+process.env.BACKUP_EVERY_H||6)*36e5).unref();setTimeout(doBackup,5000).unref();setInterval(retention,864e5).unref();setTimeout(retention,9000).unref();setInterval(expiryCheck,36e5).unref();setTimeout(expiryCheck,12000).unref();setInterval(watchdog,3e5).unref();
 const srv=app.listen(process.env.PORT||3000,()=>console.log('Transport system on :'+(process.env.PORT||3000)));
 for(const s of['SIGTERM','SIGINT'])process.on(s,()=>{srv.close(()=>{db.close();process.exit(0)});setTimeout(()=>process.exit(1),8000).unref()})}
const paymentTesting=process.env.NODE_ENV=='test'?{setProviderForTests(provider){const previous=paymentProviderOverride;paymentProviderOverride=provider;return()=>{paymentProviderOverride=previous}},setIdentityVerifierForTests(verifier){const previous=identityVerifierOverride;identityVerifierOverride=verifier;return()=>{identityVerifierOverride=previous}}}:{};
module.exports={app,jobs,db,backup,outbox,reminders,retention,noshowRule,expiryCheck,alertOps,health,shouldPushStaffRefresh,...paymentTesting};
