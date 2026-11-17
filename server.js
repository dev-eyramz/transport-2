// Community Transport Reservation & Dispatch - Node + Express + SQLite (modular single file)
const express=require('express'),D=require('better-sqlite3'),cr=require('crypto');
const { createPaymentProvider, normalizeMsisdn, isSupportedPayPartner } = require('./payment');
const { riderCharges, driverDeductions, totalDue } = require('./fees');
const PROD=process.env.NODE_ENV=='production',gw=require('./gateway'),SECRET=process.env.APP_SECRET;
if(!SECRET||SECRET.length<32)throw new Error('APP_SECRET must be set to a random value of at least 32 characters');
const db=new D(process.env.DB||'transport.db');db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.pragma('busy_timeout=5000');db.pragma('foreign_keys=ON');
const DUR=+process.env.TRIP_MIN||60,CUTOFF=+process.env.CUTOFF_MIN||30,SURGE_SEATS=+process.env.SURGE_SEATS||4,SURGE_WAIT=+process.env.SURGE_WAIT||30;
require('./migrate')(db);
const q=(s,...a)=>db.prepare(s).all(...a),one=(s,...a)=>db.prepare(s).get(...a),run=(s,...a)=>db.prepare(s).run(...a);
const PLATFORM_SETTING_KEYS=[
 'PAYMENT_PROVIDER','EGANOW_BASE_URL','EGANOW_API_USERNAME','EGANOW_API_PASSWORD','EGANOW_X_AUTH','EGANOW_CALLBACK_URL',
 'EGANOW_DEFAULT_COUNTRY_CODE','EGANOW_DEFAULT_LANGUAGE','EGANOW_MOMO_PARTNERS','SMS_PROVIDER','TWILIO_SID','TWILIO_TOKEN',
 'TWILIO_FROM','TWILIO_API_BASE_URL','NOTIFY_CHANNEL','WEBHOOK_KEY','TWILIO_FROM_WA','TWILIO_WA_TEMPLATE_SID',
 'SMS_URL','SMS_AUTH','SMS_FROM','EMAIL_PROVIDER','SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','SMTP_FROM'
],PLATFORM_SECRET_KEYS=new Set(['EGANOW_API_PASSWORD','EGANOW_X_AUTH','TWILIO_TOKEN','WEBHOOK_KEY','SMS_AUTH','SMTP_PASSWORD']);
const settingsKey=cr.hkdfSync('sha256',Buffer.from(SECRET),'platform-settings','v1',32);
const encryptSetting=value=>{const iv=cr.randomBytes(12),cipher=cr.createCipheriv('aes-256-gcm',settingsKey,iv),data=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);return['v1',iv.toString('hex'),cipher.getAuthTag().toString('hex'),data.toString('hex')].join(':')};
const decryptSetting=value=>{const[version,iv,tag,data]=String(value).split(':');if(version!='v1'||!iv||!tag||!data)throw new Error('Invalid encrypted platform setting');const decipher=cr.createDecipheriv('aes-256-gcm',settingsKey,Buffer.from(iv,'hex'));decipher.setAuthTag(Buffer.from(tag,'hex'));return Buffer.concat([decipher.update(Buffer.from(data,'hex')),decipher.final()]).toString('utf8')};
const savedPlatformSettings=()=>q('select key,value,encrypted from platform_settings').map(x=>[x.key,x.encrypted?decryptSetting(x.value):x.value]);
for(const[k,value]of savedPlatformSettings())if(PLATFORM_SETTING_KEYS.includes(k))process.env[k]=value;
if(PROD&&gw.provider=='console')throw new Error('Set SMS_PROVIDER (twilio|http) in production');
if(PROD&&process.env.PAYMENT_PROVIDER=='mock')throw new Error('PAYMENT_PROVIDER=mock is not allowed in production');
const E=(s,m)=>{throw Object.assign(new Error(m),{s})},now=()=>new Date().toISOString().slice(0,16),mins=t=>{const[a,b]=t.split(':');return+a*60+ +b};
const validDate=d=>typeof d=='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)==d;
const validTime=t=>typeof t=='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const validDateTime=(d,t)=>validDate(d)&&validTime(t);
const hhmm=m=>{m=Math.min(m,1439);return String(m/60|0).padStart(2,'0')+':'+String(m%60).padStart(2,'0')};
const audit=(u,a,e,id,m)=>run('insert into audit(actor,action,entity,eid,meta,at,station_id) values(?,?,?,?,?,?,?)',u,a,e,id,JSON.stringify(m||{}),new Date().toISOString(),(one('select station_id s from users where id=?',u)||{}).s||(one('select station_id s from drivers where user_id=?',u)||{}).s||null);
const notify=(u,ev,msg)=>{run('insert into notifications(user_id,event,msg,at) values(?,?,?,?)',u,ev,msg,now());push(u,'notify')};
const notifyMgrs=(ev,msg)=>q("select id from users where role in('manager','accountant','admin')").forEach(m=>notify(m.id,ev,msg));
const setB=(id,st,by,why)=>{const b=one('select status from bookings where id=?',id);run('update bookings set status=? where id=?',st,id);run('insert into history(booking_id,old,new,by,reason,at) values(?,?,?,?,?,?)',id,b.status,st,String(by),why||'',now())};
const cfg=(k,rid,def)=>{const r=one('select origin_id o from routes where id=?',rid)||{};for(const s of['route:'+rid,'station:'+r.o,'global']){const c=one('select value from config where scope=? and key=?',s,k);if(c){const n=Number(c.value);return c.value.trim()!==''&&Number.isFinite(n)?n:c.value}}return def};
const toPesewas=value=>Math.round(Number(value)*100),ghs=value=>(Number(value||0)/100).toFixed(2),bookingTotal=totalDue;
const DISPATCHABLE=['Paid','Credit','Cash'],DISPATCHABLE_SQL="('"+DISPATCHABLE.join("','")+"')",FEE_CONFIG_KEYS=['station_fee_pct','platform_fee_pct','driver_station_fee_pct','driver_platform_fee_pct'];
const routeFare=routeId=>{const route=one('select origin_id from routes where id=?',routeId),fare=cfg('fare_ghs',routeId,null),gate=cfg('payout_gate',routeId,'manager_completion');
 if(!(fare>0))E(409,'This route has no fare configured yet');return{farePesewas:toPesewas(fare),fareGhs:Number(fare),stationId:route?.origin_id,payoutGate:gate}};
// seed
if(!one('select 1 x from stations')){['East Legon','Oyarifa','Oyibi','Dodowa'].forEach(n=>run('insert into stations(name) values(?)',n));
 for(let a=1;a<=4;a++)for(let b=1;b<=4;b++)if(a!=b)run('insert into routes(origin_id,dest_id,name) values(?,?,?)',a,b,q('select name from stations where id in(?,?)',a,b).map(x=>x.name).join(' -> '));
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
function eligible(did,v,date,dep){const d=one('select * from drivers where user_id=?',did);
 if(!d||!d.verified||['Suspended','TemporarilyUnavailable'].includes(d.op_status)||v.status=='Maintenance'||!v.docs_ok)return false;
 if(date==new Date().toISOString().slice(0,10)&&(v.status!='Available'||d.op_status!='Available'))return false; // declared availability != actual status
 const end=dep+DUR,dow=new Date(date+'T00:00:00').getDay();
 if(!q('select * from availability where driver_id=? and dow=?',did,dow).some(w=>mins(w.st)<=dep&&end<=mins(w.en)))return false;
 if(one("select 1 x from avail_ex where driver_id=? and status='Approved' and start_at<? and end_at>?",did,date+'T'+hhmm(end),date+'T'+hhmm(dep)))return false;
 return !q("select dep_at from trips where (driver_id=? or vehicle_id=?) and status not in('Cancelled','Completed','Breakdown') and substr(dep_at,1,10)=?",did,v.id,date).some(t=>Math.abs(mins(t.dep_at.slice(11))-dep)<DUR)}
function feeOutstanding(driverId){return one("select coalesce(sum(r.station_pesewas+r.platform_pesewas-(select coalesce(sum(a.amount_pesewas),0) from fee_allocations a where a.receivable_id=r.id)),0) amount from fee_receivables r where r.driver_id=? and r.status!='Settled'",driverId)?.amount||0}
function cashDriverEligible(driverId,b){if(b.payment_status!='Cash'||cfg('fee_block_cash',b.route_id,0)!=1)return true;return feeOutstanding(driverId)<=toPesewas(cfg('fee_max_outstanding_ghs',b.route_id,0))}
function autoTrip(b){const today=new Date().toISOString().slice(0,10);if(b.date<today)return;const minDep=b.date==today?mins(now().slice(11))+15:0,dep=Math.min(Math.max(mins(b.arrival)+15,minDep),1439);if(b.date==today&&dep<=mins(now().slice(11)))return;
 const c=q('select * from vehicles where capacity>=?',b.seats).filter(v=>eligible(v.driver_id,v,b.date,dep)&&cashDriverEligible(v.driver_id,b));if(!c.length)return;
 const since=new Date(Date.now()-7*864e5).toISOString().slice(0,16);
 c.forEach(v=>v.n=one("select count(*) n from trips where driver_id=? and status!='Cancelled' and dep_at>?",v.driver_id,since).n);
 const m=Math.min(...c.map(v=>v.n)),p=c.filter(v=>v.n==m),v=p[Math.random()*p.length|0]; // fairness first, random among equals
 const t=one('select * from trips where id=?',run('insert into trips(route_id,driver_id,vehicle_id,dep_at) values(?,?,?,?)',b.route_id,v.driver_id,v.id,b.date+'T'+hhmm(dep)).lastInsertRowid);t.score=m;return t}
function assign(t,b,method,by,reason,score){
 if(!DISPATCHABLE.includes(b.payment_status))E(409,'Payment must be confirmed before dispatch assignment');if(!cashDriverEligible(t.driver_id,b))E(409,'Driver has outstanding cash-trip charges');
 if(freeSeats(t.id)<b.seats)E(409,'Not enough free seats');
 if(one('select 1 x from assignments where booking_id=? and status in'+ACTIVE,b.id))E(409,'Booking already assigned');
 run('insert into assignments(trip_id,booking_id,seats,method,score,by,reason,at) values(?,?,?,?,?,?,?,?)',t.id,b.id,b.seats,method,score??null,String(by),reason??null,now());
 setB(b.id,'Assigned',by,reason||'allocation');
 notify(b.passenger_id,'Booking assigned',`Booking ${b.ref}: trip #${t.id}, estimated departure ${t.dep_at.replace('T',' ')} (estimate, not a guarantee).`);
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
 if(b.status!='Cancelled'){setB(b.id,'Queued','System',why);notify(b.passenger_id,'Assignment changed',`Booking ${b.ref} is back in the queue (${why}). We will reassign you.`)}}}
function tripStatus(id,st,u){const t=one('select * from trips where id=?',id);if(!t)E(404,'No such trip');
 if(u.role=='driver'&&t.driver_id!=u.id)E(403,'Not your trip');
 const ok={Loading:['Planned','Delayed'],Departed:['Planned','Loading','Delayed'],Completed:['Departed'],Cancelled:['Planned','Loading','Delayed']}[st];
 if(!ok||!ok.includes(t.status))E(409,`Cannot change ${t.status} -> ${st}`);
 if(st=='Completed')missedBoarding(id,true);
 run('update trips set status=? where id=?',st,id);
 if(st=='Loading'){run("update vehicles set status='Loading' where id=?",t.vehicle_id);q('select user_id u from drivers where user_id=?',t.driver_id).forEach(d=>notify(d.u,'Loading',`Trip #${id}: start loading.`))}
 if(st=='Departed'){run('update trips set departed_at=? where id=?',now(),id);run("update vehicles set status='OnRound' where id=?",t.vehicle_id);run("update drivers set op_status='OnTrip' where user_id=?",t.driver_id);
  q("select a.booking_id,b.ref,b.passenger_id from assignments a join bookings b on b.id=a.booking_id where a.trip_id=? and a.status in('Reserved','Confirmed')",id).forEach(a=>notify(a.passenger_id,'Onboard confirmation requested',`Trip #${id} is moving. Confirm that you are on board in your dashboard within 15 minutes.`))}
 if(st=='Completed'){run("update vehicles set status='Returning' where id=?",t.vehicle_id);run("update drivers set op_status='Returning' where user_id=?",t.driver_id);
  q("select booking_id from assignments where trip_id=? and status='Boarded'",id).forEach(a=>setB(a.booking_id,'Completed',u.id,'trip completed'))}
 if(st=='Cancelled'){run("update vehicles set status='Available' where id=? and status in('Loading','Reserved')",t.vehicle_id);requeue(id,'Cancelled','trip cancelled')}
 audit(u.id,'trip.'+st,'trip',id,{});if(st=='Cancelled')allocate()}
// ---- recurring ----
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
const nextMonday=()=>{const t=new Date().toISOString().slice(0,10),dow=new Date(t+'T00:00:00Z').getUTCDay();return addDays(t,(8-dow)%7||7)};
function review(r,week){const dl=new Date(Date.parse(week+'T00:00:00Z')-cfg('confirm_hours_before',r.route_id,78)*36e5).toISOString().slice(0,16);let c=one('select * from confirmations where rec_id=? and week_start=?',r.id,week);
 if(!c){run('insert into confirmations(rec_id,week_start,deadline) values(?,?,?)',r.id,week,dl);c=one('select * from confirmations where rec_id=? and week_start=?',r.id,week);
  notify(r.passenger_id,'Weekly review due',`Please confirm your rides for the week of ${week} before ${dl.replace('T',' ')}.`)}
 const days=r.days.split(',').map(Number),occ=[];for(let i=0;i<7;i++){const d=addDays(week,i);
  if(days.includes(new Date(d+'T00:00:00Z').getUTCDay())&&d>=r.start_date&&d<=r.end_date)occ.push({travelDate:d,expectedArrivalAt:r.arrival,seats:r.seats,confirmed:!!one('select 1 x from bookings where rec_id=? and date=? and status!=\'Cancelled\'',r.id,d)})}
 return{confirmation:c,route_id:r.route_id,occurrences:occ}}
function jobs(){const w=nextMonday();q("select * from recurring where status='Active'").forEach(r=>{if(r.end_date>=w&&r.start_date<=addDays(w,6))review(r,w)});
 q("select * from confirmations where status='Pending' and deadline<?",now()).forEach(c=>run("update confirmations set status='Expired' where id=?",c.id));
 missedBoarding();allocate();
 const dueDrivers=q("select r.driver_id,max(r.due_at) due_at from fee_receivables r where r.status!='Settled' and r.due_at<=? group by r.driver_id",now());
 for(const d of dueDrivers){const sent=one("select 1 x from notifications where user_id=? and event='Fee due' and at>?",d.driver_id,new Date(Date.now()-864e5).toISOString().slice(0,16));if(!sent)notify(d.driver_id,'Fee due',`Your cash-trip charges are overdue. Outstanding balance: GHS ${ghs(feeOutstanding(d.driver_id))}. Pay with MoMo from your driver dashboard.`)}
 const s=surge();s.filter(x=>x.alert).forEach(x=>{const m=`Surge on ${x.route}, ${x.date}: ${x.queuedSeats} seats waiting, oldest ${x.oldestWaitMin} min.`;
  if(!one('select 1 x from notifications where msg=? and at>?',m,new Date(Date.now()-36e5).toISOString().slice(0,16)))notifyMgrs('Surge',m)});
 reminders();outbox().catch(console.error)}
function surge(){const today=new Date().toISOString().slice(0,10);return q(`select b.route_id,b.date,sum(b.seats) seats,min(b.created) oldest,min(b.arrival) first,r.name from bookings b join routes r on r.id=b.route_id where b.status='Queued' and b.payment_status in${DISPATCHABLE_SQL} group by b.route_id,b.date`).map(g=>{
 const wait=Math.round((Date.now()-new Date(g.oldest+'Z'))/6e4),dow=new Date(g.date+'T00:00:00').getDay(),dep=Math.min(mins(g.first)+15,1439);
 const free=q("select id from trips where route_id=? and substr(dep_at,1,10)=? and status in('Planned','Loading') and exclusive_for is null",g.route_id,g.date).reduce((s,t)=>s+freeSeats(t.id),0);
 const ret=g.date!=today?[]:q("select v.* from vehicles v join drivers d on d.user_id=v.driver_id where v.status in('Returning','OnRound') and v.docs_ok=1 and d.verified=1 and d.op_status in('Returning','OnTrip')").filter(v=>q('select 1 x from availability where driver_id=? and dow=? and st<=? and en>=?',v.driver_id,dow,hhmm(dep),hhmm(dep+DUR)).length);
 const exp=ret.reduce((s,v)=>s+v.capacity,0),short=Math.max(0,g.seats-free-exp);
 return{route:g.name,routeId:g.route_id,date:g.date,queuedSeats:g.seats,eligibleFreeSeats:free,returningVehicles:ret.length,expectedSeats:exp,shortfall:short,oldestWaitMin:wait,alert:short>=cfg('surge_seats',g.route_id,SURGE_SEATS)||wait>=cfg('surge_wait',g.route_id,SURGE_WAIT)}})}
// ---- http ----
const app=express(),compression=require('compression');app.set('trust proxy',+process.env.TRUST_PROXY||0);app.disable('x-powered-by');
app.use(compression({filter:(rq,rs)=>!rq.path.endsWith('/events')&&compression.filter(rq,rs)}));
app.use((rq,res,n)=>{res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'"});if(PROD)res.set('Strict-Transport-Security','max-age=31536000');n()});
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
const ROLE=(...r)=>(req,res,n)=>r.includes(req.u.role)||(req.u.role=='admin'&&r.includes('manager'))?n():res.status(403).json({error:'Forbidden'});
const STATION_STAFF=['manager','accountant'],mgr=ROLE('manager','accountant'),scope=u=>STATION_STAFF.includes(u.role)&&!u.station_id?[]:q('select id from routes'+(STATION_STAFF.includes(u.role)?' where origin_id='+(+u.station_id):'')).map(r=>r.id);
const inScope=(u,rid)=>scope(u).includes(+rid)||E(403,'Outside your station scope');
const chkDrv=(u,did)=>{if(STATION_STAFF.includes(u.role)){if(!u.station_id)E(403,'Staff account has no station scope');const d=one('select station_id s from drivers where user_id=?',did);if(!d||d.s!=u.station_id)E(403,'Driver belongs to another station')}};
const chkPassenger=(u,pid)=>{if(STATION_STAFF.includes(u.role)){const ids=scope(u);if(!ids.length||!one(`select 1 x from bookings where passenger_id=? and route_id in(${ids.join(',')})`,pid))E(403,'Passenger has no booking in your station scope')}};
const lim=new Map(),limit=(k,max,ms)=>{const n=Date.now(),a=(lim.get(k)||[]).filter(t=>n-t<ms);if(a.length>=max)E(429,'Too many attempts, please try later');a.push(n);lim.set(k,a)};
setInterval(()=>{const n=Date.now();for(const[k,a]of lim)if(!a.some(t=>n-t<36e5))lim.delete(k)},6e5).unref();
const sha=x=>cr.createHash('sha256').update(SECRET+x).digest('hex'),STAFF=['manager','accountant','admin'],DEV=!PROD&&gw.provider=='console';
const normalizePhone=(value)=>{const raw=String(value==null?'':value).trim();if(!raw||/[A-Za-z@]/.test(raw))return'';const cleaned=raw.replace(/[^\d+]/g,'').replace(/^\+{2,}/,'+');if(!/^\+?\d+$/.test(cleaned))return'';const digits=cleaned.replace(/\+/g,'');if(digits.length<9||digits.length>15)return'';return cleaned.startsWith('+')?`+${digits}`:digits;};
const conns=new Map(),tix=new Map();
function push(uid,ev){for(const c of conns.get(uid)||[])c.res.write(`event: ${ev}\ndata: 1\n\n`)}
function pushStaff(){for(const s of conns.values())for(const c of s)if(STAFF.includes(c.role))c.res.write('event: refresh\ndata: 1\n\n')}
api.use((req,res,n)=>{try{limit('api:'+req.ip,+process.env.API_PER_MIN||600,6e4)}catch(e){return res.status(429).json({error:e.message})}if(req.method!='GET')res.on('finish',()=>{if(res.statusCode<300)pushStaff()});n()});
api.post('/auth/request-otp',H(async req=>{const phone=normalizePhone(req.body.phone),name=String(req.body.name||'').trim(),role=req.body.role; if(!phone)E(400,'Invalid phone number');limit('ip:'+req.ip,20,36e5);limit('ph:'+phone,3,6e5);
 let user=one('select id from users where phone=?',phone),purpose=req.body.purpose|| (user?'verify':'register');
 if(!['register','verify','reset-pin'].includes(purpose))E(400,'Invalid OTP purpose');
 if(purpose=='reset-pin'&&!user)return{ok:1};
 if(purpose=='register'&&user)E(409,'Account already exists. Sign in or use PIN recovery.');
 if(!user){if(purpose!='register'||!name||!['passenger','driver'].includes(role))E(400,'name and role (passenger|driver) required');if(!req.body.consent)E(400,'You must accept the Terms and Privacy Notice');run('insert into users(phone,name,role,consent_at,consent_ver) values(?,?,?,?,?)',phone,name,role,new Date().toISOString(),TV)}
 const code=String(100000+cr.randomInt(900000));run('delete from otps where phone=?',phone);run('insert into otps(phone,code,exp,purpose) values(?,?,?,?)',phone,sha(phone+code),Date.now()+3e5,purpose);
 const msg=`Your transport code is ${code}. Valid 5 minutes. Do not share it.`;try{await gw.sms(phone,msg)}catch(e){try{await gw.sms(phone,msg)}catch(e2){console.error('OTP send failed',e2.message);alertOps('otp','OTP SMS failing: '+e2.message);E(502,'Could not send SMS, try again')}}
 return DEV?{ok:1,devOtp:code}:{ok:1}}));
api.post('/auth/login',H(req=>{const phone=normalizePhone(req.body.phone),pin=String(req.body.pin||'');limit('login:'+req.ip,30,36e5);if(!phone||!pin)E(401,'Invalid phone or PIN');const u=one('select * from users where phone=?',phone);if(!u||!u.pin_hash)E(401,'Invalid phone or PIN');if(u.locked_until>Date.now())E(423,'Account locked, try again later');if(!okPin(pin,u.pin_hash)){run('update users set pin_fails=pin_fails+1,locked_until=case when pin_fails+1>=5 then ? else 0 end where id=?',Date.now()+9e5,u.id);audit(u.id,'auth.fail','user',u.id);E(401,'Invalid phone or PIN')}
 run('update users set pin_fails=0,locked_until=0,verified=1 where id=?',u.id);const t=cr.randomBytes(32).toString('hex'),ttl=(STAFF.includes(u.role)?+process.env.STAFF_TTL_H||12:+process.env.TOKEN_TTL_H||168)*36e5;run('insert into sessions(hash,user_id,expires,created,ua) values(?,?,?,?,?)',sha(t),u.id,Date.now()+ttl,Date.now(),(req.get('user-agent')||'').slice(0,100));audit(u.id,'auth.login','user',u.id);return{token:t,expiresAt:Date.now()+ttl,user:{id:u.id,phone:u.phone,name:u.name,role:u.role,station_id:u.station_id}}}));
api.post('/auth/verify-otp',H(req=>{const phone=normalizePhone(req.body.phone),code=req.body.code,pin=req.body.pin;limit('v:'+req.ip,30,36e5);if(!phone)E(400,'Invalid phone number');const u=one('select * from users where phone=?',phone),o=one('select * from otps where phone=?',phone);
 if(!u||!o||o.exp<Date.now())E(401,'Invalid or expired code');if(u.locked_until>Date.now()&&o.purpose!='reset-pin')E(423,'Account locked, try again later');
 if(o.attempts>=5){run('delete from otps where phone=?',phone);E(401,'Too many wrong codes; request a new one')}
 if(o.code!=sha(phone+String(code))){run('update otps set attempts=attempts+1 where phone=?',phone);E(401,'Invalid or expired code')}
 const p=(pin===undefined||pin===null)?'':String(pin).trim();
 if(o.purpose=='register'||o.purpose=='reset-pin'){
  if(p.length<6)E(400,'A PIN of at least 6 characters is required');
  run('update users set pin_hash=?,pin_fails=0,locked_until=0 where id=?',hashPin(p),u.id);
  if(o.purpose=='reset-pin')run('update sessions set revoked=1 where user_id=?',u.id);
 }else if(STAFF.includes(u.role)){
  if(!p)E(401,'Staff PIN required');if(!okPin(p,u.pin_hash)){run('update users set pin_fails=pin_fails+1,locked_until=case when pin_fails+1>=5 then ? else 0 end where id=?',Date.now()+9e5,u.id);audit(u.id,'auth.fail','user',u.id);E(401,'Staff PIN incorrect')}
  run('update users set pin_hash=?,pin_fails=0,locked_until=0 where id=?',hashPin(p),u.id);
 }else if(p){run('update users set pin_hash=?,pin_fails=0,locked_until=0 where id=?',hashPin(p),u.id);}
 run('delete from otps where phone=?',phone);run('update users set pin_fails=0,locked_until=0,verified=1 where id=?',u.id);
 const t=cr.randomBytes(32).toString('hex'),ttl=(STAFF.includes(u.role)?+process.env.STAFF_TTL_H||12:+process.env.TOKEN_TTL_H||168)*36e5;
 run('insert into sessions(hash,user_id,expires,created,ua) values(?,?,?,?,?)',sha(t),u.id,Date.now()+ttl,Date.now(),(req.get('user-agent')||'').slice(0,100));audit(u.id,'auth.login','user',u.id);
 return{token:t,expiresAt:Date.now()+ttl,user:{id:u.id,phone:u.phone,name:u.name,role:u.role,station_id:u.station_id}}}));
api.get('/registration-options',H(()=>({stations:q('select id,name from stations order by name'),payPartners:(process.env.EGANOW_MOMO_PARTNERS||'MTNGH,ATGH,TCELGH').split(',').map(x=>x.trim()).filter(Boolean)})));
api.use((req,res,n)=>{const t=(req.headers.authorization||'').slice(7),s=t&&one('select * from sessions where hash=? and revoked=0 and expires>?',sha(t),Date.now()),u=s&&one('select * from users where id=?',s.user_id);if(!u)return res.status(401).json({error:'Unauthorised'});req.u=u;req.sh=sha(t);n()});
api.post('/auth/logout',H(req=>{run('update sessions set revoked=1 where hash=?',req.sh);return{ok:1}}));
api.post('/auth/logout-all',H(req=>{run('update sessions set revoked=1 where user_id=?',req.u.id);return{ok:1}}));
api.post('/events/ticket',H(req=>{const t=cr.randomBytes(16).toString('hex');tix.set(t,{id:req.u.id,role:req.u.role,exp:Date.now()+3e4});return{ticket:t}}));
api.post('/admin/users/:id/pin',ROLE('admin'),H(req=>{if(String(req.body.pin||'').length<6)E(400,'PIN must be 6+ characters');run('update users set pin_hash=?,pin_fails=0,locked_until=0 where id=?',hashPin(req.body.pin),req.params.id);run('update sessions set revoked=1 where user_id=?',req.params.id);audit(req.u.id,'pin.set','user',+req.params.id);return{ok:1}}));
const OUTBOX_EVENTS=(process.env.SMS_EVENTS||'Booking assigned,Assignment changed,Trip assignment,Loading,Breakdown,Surge,Weekly review due,Booking cancelled,No-show,Full-vehicle request,Verified,Document,Schedule changed,Weekly review reminder,Ride reminder,Trip reminder,Trip delayed,Booking suspended,No-show warning,Onboard confirmation requested,Boarding credit,Payment received,Payout attention,Fee due').split(',');
let sending=false;
async function outbox(){if(sending)return;sending=true;try{
 for(const n of q("select n.*,u.phone,u.whatsapp_optin from notifications n join users u on u.id=n.user_id where n.status in('Pending','Retrying') and n.next_try<=? order by n.id limit 20",Date.now())){
  if(!OUTBOX_EVENTS.includes(n.event)){run("update notifications set status='InApp' where id=?",n.id);continue}
  try{limit('sms:'+n.user_id,+process.env.SMS_PER_HOUR||10,36e5)}catch(e){run("update notifications set status='Throttled',error='rate limit' where id=?",n.id);continue}
  try{const ch=gw.waEnabled&&n.whatsapp_optin?'whatsapp':'sms',r=await gw.sms(n.phone,`${n.event}: ${n.msg}`.slice(0,300),{channel:ch,event:n.event,text:n.msg.slice(0,250)});smsFails=0;run("update notifications set status='Sent',channel=?,provider_id=?,attempts=attempts+1 where id=?",r&&r.channel||ch,r&&r.id||null,n.id)}
  catch(e){if(++smsFails>=5)alertOps('sms','Messaging provider failing: '+String(e.message).slice(0,120));const a=n.attempts+1;run('update notifications set status=?,attempts=?,next_try=?,error=? where id=?',a>=5?'Failed':'Retrying',a,Date.now()+Math.min(36e5,3e4*2**a),String(e.message).slice(0,200),n.id)}}}finally{sending=false}}
api.get('/me',H(r=>({...r.u,token:undefined,pin_hash:undefined,pin_fails:undefined,locked_until:undefined,termsVersion:TV,waEnabled:gw.waEnabled,driver:one('select * from drivers where user_id=?',r.u.id)})));
api.get('/routes',H(()=>q('select id,origin_id,dest_id,name from routes').map(r=>({...r,cutoff_min:cfg('cutoff_min',r.id,CUTOFF),cash_enabled:cfg('cash_enabled',r.id,0)==1}))));
api.get('/rides/availability',ROLE('passenger'),H(req=>{
 const routeId=+req.query.routeId,date=String(req.query.date||''),arrival=String(req.query.arrival||''),seats=Number(req.query.seats||1);
 if(!one('select 1 x from routes where id=?',routeId))E(400,'Unknown route');
 if(!validDate(date)||!Number.isSafeInteger(seats)||seats<1||seats>60)E(400,'A valid travel date and passenger count (1-60) are required');
 if(arrival&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(arrival))E(400,'Arrival time must use HH:MM');
 return q("select t.id,t.dep_at,t.status,v.capacity from trips t join vehicles v on v.id=t.vehicle_id where t.route_id=? and substr(t.dep_at,1,10)=? and t.status in('Planned','Loading','Delayed') and t.exclusive_for is null order by t.dep_at,t.id",routeId,date)
  .map(t=>({...t,seatsAvailable:freeSeats(t.id)}))
  .filter(t=>t.seatsAvailable>=seats&&(!arrival||(mins(t.dep_at.slice(11))>=mins(arrival)&&mins(t.dep_at.slice(11))-mins(arrival)<=45)))
  .map(t=>({departure:t.dep_at.slice(11),status:t.status,capacity:t.capacity,seatsAvailable:t.seatsAvailable}));
}));
api.get('/notifications',H(r=>q('select * from notifications where user_id=? order by id desc limit 30',r.u.id)));
const P=ROLE('passenger');
function bookingPublic(id){const b=one(`select b.id,b.ref,b.date,b.arrival,b.seats,b.status,b.payment_status,b.payment_method,
 r.name route,a.seat_label,a.trip_id,t.dep_at,t.status trip_status,v.reg,a.onboard_confirmed,b.fare_pesewas,b.station_fee_pesewas,b.platform_fee_pesewas,b.paid_pesewas,
 (select count(*) from bookings x where x.status='Queued' and x.payment_status in${DISPATCHABLE_SQL} and x.route_id=b.route_id and x.date=b.date and x.id<b.id)+1 queue_pos
 from bookings b join routes r on r.id=b.route_id left join assignments a on a.booking_id=b.id and a.status in${ACTIVE}
 left join trips t on t.id=a.trip_id left join vehicles v on v.id=t.vehicle_id where b.id=?`,id);
 if(!b)return b;const total=bookingTotal(b);return{id:b.id,ref:b.ref,date:b.date,arrival:b.arrival,seats:b.seats,status:b.status,payment_status:b.payment_status,payment_method:b.payment_method,route:b.route,seat_label:b.seat_label,trip_id:b.trip_id,dep_at:b.dep_at,trip_status:b.trip_status,reg:b.reg,onboard_confirmed:b.onboard_confirmed,queue_pos:b.queue_pos,total_due:'GHS '+ghs(total),amount_due:'GHS '+ghs(Math.max(0,total-b.paid_pesewas)),info:stText(b),payment_attempt_status:(one('select status from booking_payments where booking_id=? order by id desc limit 1',b.id)||{}).status||null}}
api.get('/quote',P,H(req=>{const routeId=+req.query.routeId,seats=Number(req.query.seats||1);if(!Number.isInteger(routeId)||!one('select 1 x from routes where id=?',routeId))E(400,'Unknown route');if(!Number.isSafeInteger(seats)||seats<1||seats>3)E(400,'Seats must be between 1 and 3');
 const fare=routeFare(routeId).farePesewas*seats,charges=riderCharges(fare,cfg('station_fee_pct',routeId,0),cfg('platform_fee_pct',routeId,0));return{total_due:'GHS '+ghs(fare+charges.stationFeePesewas+charges.platformFeePesewas)}}));
api.get('/me/activity-summary',P,H(req=>{
 const now=new Date(),weekStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-(now.getUTCDay()+6)%7)),nextWeek=new Date(weekStart.getTime()+7*864e5),
  monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)),nextMonth=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)),
  day=d=>d.toISOString().slice(0,10),uid=req.u.id;
 const rides=one(`select count(*) totalRides,coalesce(sum(seats),0) totalSeats,
  coalesce(sum(case when date>=? and date<? then 1 else 0 end),0) weekRides,
  coalesce(sum(case when date>=? and date<? then seats else 0 end),0) weekSeats,
  coalesce(sum(case when date>=? and date<? then 1 else 0 end),0) monthRides,
  coalesce(sum(case when date>=? and date<? then seats else 0 end),0) monthSeats,
  coalesce(sum(case when status in('Queued','Assigned','Confirmed') then 1 else 0 end),0) activeRides
  from bookings where passenger_id=?`,day(weekStart),day(nextWeek),day(weekStart),day(nextWeek),day(monthStart),day(nextMonth),day(monthStart),day(nextMonth),uid);
 const groups=one(`select count(*) total,coalesce(sum(status='Pending'),0) pending,
  coalesce(sum(case when date>=? and date<? then 1 else 0 end),0) weekRequests,
  coalesce(sum(case when date>=? and date<? then 1 else 0 end),0) monthRequests
  from excl where passenger_id=?`,day(weekStart),day(nextWeek),day(monthStart),day(nextMonth),uid),
  weeklyPlans=one("select count(*) n from recurring where passenger_id=? and status='Active'",uid).n;
 return{...rides,totalGroupRequests:groups.total,weekRequests:groups.weekRequests,monthRequests:groups.monthRequests,pendingGroupRequests:groups.pending,activeWeeklyPlans:weeklyPlans,inProgress:rides.activeRides+groups.pending};
}));
function newBooking(u,b,src,rec){const{routeId,date,arrival,seats}=b,paymentMethod=src=='OneTime'?(b.paymentMethod||'digital'):'digital';if(u.noshow_blocked_until>Date.now())E(403,'Bookings suspended until '+new Date(u.noshow_blocked_until).toISOString().slice(0,10)+' because of repeated no-shows');if(!one('select 1 x from routes where id=?',routeId))E(400,'Unknown route');
 if(!(seats>=1&&seats<=3))E(400,'Ordinary bookings allow 1-3 seats; use a full-vehicle request for more');
 if(!validDateTime(date,arrival))E(400,'Bad date/time');
 if(Date.parse(date+'T'+arrival+':00Z')-Date.now()<cfg('cutoff_min',routeId,CUTOFF)*6e4)E(400,'Booking cut-off has passed for this route');
 if(!['digital','cash'].includes(paymentMethod))E(400,'paymentMethod must be digital or cash');if(paymentMethod=='cash'&&cfg('cash_enabled',routeId,0)!=1)E(400,'Cash payment is not enabled for this route');
 const pricing=routeFare(routeId),farePesewas=pricing.farePesewas*seats,riderPctStation=cfg('station_fee_pct',routeId,0),riderPctPlatform=cfg('platform_fee_pct',routeId,0),driverPctStation=cfg('driver_station_fee_pct',routeId,riderPctStation),driverPctPlatform=cfg('driver_platform_fee_pct',routeId,riderPctPlatform),
 rider=riderCharges(farePesewas,riderPctStation,riderPctPlatform),driver=driverDeductions(farePesewas,driverPctStation,driverPctPlatform),paymentStatus=paymentMethod=='cash'?'Cash':'Due';
 const ref='BK'+cr.randomBytes(3).toString('hex').toUpperCase(),id=run("insert into bookings(ref,passenger_id,route_id,date,arrival,seats,status,rec_id,source,created,fare_pesewas,platform_fee_pesewas,station_fee_pesewas,payment_status,payment_method,rider_station_pct,rider_platform_pct,driver_station_pct,driver_platform_pct,driver_station_deduction_pesewas,driver_platform_deduction_pesewas) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",ref,u.id,routeId,date,arrival,seats,'Queued',rec||null,src,new Date().toISOString().slice(0,19),farePesewas,rider.platformFeePesewas,rider.stationFeePesewas,paymentStatus,paymentMethod,riderPctStation,riderPctPlatform,driverPctStation,driverPctPlatform,driver.stationDeductionPesewas,driver.platformDeductionPesewas).lastInsertRowid;
 setB(id,'Queued',u.id,'created');return id}
api.post('/bookings',P,H((req,res)=>{const k=req.get('Idempotency-Key')||req.body.idempotencyKey;if(k){const p=one('select booking_id i from idem where user_id=? and key=?',req.u.id,k);if(p){res.set('Idempotent-Replay','true');return bookingPublic(p.i)}}const id=newBooking(req.u,req.body,'OneTime');if(k)run('insert into idem values(?,?,?)',req.u.id,k,id);audit(req.u.id,'booking.create','booking',id);notify(req.u.id,'Booking created',req.body.paymentMethod=='cash'?'Pay the driver in cash when boarding.':'Review the total and complete payment to enter the dispatch queue.');return bookingPublic(id)}));
api.get('/bookings',P,H((req,res)=>{res.set('X-Total-Count',one('select count(*) n from bookings where passenger_id=?',req.u.id).n);return q(`select b.id from bookings b where b.passenger_id=? order by b.date desc,b.id desc limit ? offset ?`,req.u.id,...pg(req)).map(b=>bookingPublic(b.id))}));
api.post('/bookings/:id/cancel',P,H(req=>{const b=one('select * from bookings where id=? and passenger_id=?',req.params.id,req.u.id);if(!b)E(404,'Not found');
 if(req.u.role=='passenger'&&b.paid_pesewas>0)E(409,'This booking has been paid. Contact the station manager to request a credit before cancelling.');
 if(req.u.role=='passenger'&&b.payment_status=='Credit')E(409,'This booking carries prepaid fare credit. Contact the station manager before cancelling.');
 if(['Boarded','Completed','Cancelled'].includes(b.status))E(409,'Cannot cancel at this stage');if(req.u.role=='passenger'&&new Date(b.date+'T'+b.arrival)-Date.now()<cfg('cancel_deadline_min',b.route_id,0)*6e4)E(409,'Cancellation deadline has passed');run("update assignments set status='Cancelled' where booking_id=? and status in"+ACTIVE,b.id);setB(b.id,'Cancelled',req.u.id,req.body.reason||'cancelled');
 audit(req.u.id,'booking.cancel','booking',b.id);notify(b.passenger_id,'Booking cancelled',`Booking ${b.ref} cancelled.`);return{ok:1}}));
api.post('/exclusive-requests',P,H(req=>{const routeId=+req.body.routeId,{date,time,vtype}=req.body,seats=Number(req.body.seats);if(!one('select 1 x from routes where id=?',routeId))E(400,'Unknown route');if(!validDateTime(date,time))E(400,'Bad date/time');if(!Number.isSafeInteger(seats)||seats<1)E(400,'Passenger count must be a positive whole number');return{id:run('insert into excl(passenger_id,route_id,date,time,vtype,seats) values(?,?,?,?,?,?)',req.u.id,routeId,date,time,vtype||'any',seats).lastInsertRowid,status:'Pending'}}));
api.get('/exclusive-requests',P,H(req=>q('select x.*,r.name route from excl x join routes r on r.id=x.route_id where x.passenger_id=? order by x.id desc',req.u.id)));
api.get('/manager/exclusive',mgr,H(req=>q('select * from excl order by id desc').filter(x=>scope(req.u).includes(x.route_id))));
['approve','reject'].forEach(a=>api.post('/manager/exclusive/:id/'+a,mgr,H(req=>{const x=one('select * from excl where id=?',req.params.id);if(!x||x.status!='Pending')E(409,'Not pending');inScope(req.u,x.route_id);
 const tid=a=='approve'?reserveExcl(x,req.body):null;run('update excl set status=?,manager_id=?,trip_id=? where id=?',a=='approve'?'Approved':'Rejected',req.u.id,tid,x.id);notify(x.passenger_id,'Full-vehicle request',`Your request #${x.id} was ${a}d.`);audit(req.u.id,'excl.'+a,'excl',x.id);return{ok:1}})));
// recurring
api.post('/recurring',P,H(req=>{const{routeId,days,arrival,seats,startDate,endDate}=req.body;if(!Array.isArray(days)||!days.length||days.some(d=>!Number.isInteger(d)||d<0||d>6)||!(seats>=1&&seats<=3)||!validTime(arrival)||!validDate(startDate)||!validDate(endDate)||endDate<startDate||!one('select 1 x from routes where id=?',routeId))E(400,'Valid route, days[], arrival, seats(1-3), startDate and endDate are required');
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
api.post('/drivers/profile',DR,H(req=>{run('insert into drivers(user_id,licence,station_id) values(?,?,?) on conflict(user_id) do update set licence=excluded.licence,station_id=excluded.station_id,verified=0',req.u.id,req.body.licence,req.body.stationId||null);notifyMgrs('Driver verification',`Driver ${req.u.name} awaits licence verification.`);return{ok:1}}));
api.post('/vehicles',DR,H(req=>{const{reg,type,capacity}=req.body;if(!one('select 1 x from drivers where user_id=?',req.u.id))E(409,'Submit driver profile first');if(one('select count(*) n from vehicles where driver_id=?',req.u.id).n>=cfg('max_vehicles',null,2))E(409,'Vehicle limit reached');return{id:run('insert into vehicles(driver_id,reg,type,capacity) values(?,?,?,?)',req.u.id,String(reg).toUpperCase().replace(/\s/g,''),type,capacity).lastInsertRowid}}));
api.get('/vehicles/me',DR,H(r=>q('select * from vehicles where driver_id=?',r.u.id)));
api.post('/vehicles/:id/status',H(req=>{const v=one('select * from vehicles where id=?',req.params.id),{status:s}=req.body;if(!['driver','manager','accountant','admin'].includes(req.u.role))E(403,'Forbidden');if(!v||(req.u.role=='driver'&&v.driver_id!=req.u.id))E(404,'Not found');if(v&&STATION_STAFF.includes(req.u.role))chkDrv(req.u,v.driver_id);
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
 const queue=q(`select r.name route,b.date,count(*) requests,sum(b.seats) passengers from bookings b join routes r on r.id=b.route_id where b.status='Queued' and b.payment_status in${DISPATCHABLE_SQL} and r.origin_id=? and b.date>=? group by b.route_id,b.date order by b.date,r.name`,driver.station_id,today);
 return{queue,waitingPassengers:queue.reduce((sum,row)=>sum+row.passengers,0)};
}));
api.post('/drivers/me/availability-exceptions',DR,H(req=>{const{startAt,endAt,reason}=req.body;if(!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(startAt||'')||!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(endAt||'')||!validDateTime(startAt.slice(0,10),startAt.slice(11))||!validDateTime(endAt.slice(0,10),endAt.slice(11))||startAt>=endAt||!String(reason||'').trim())E(400,'Valid startAt<endAt and reason required');
 const id=run('insert into avail_ex(driver_id,start_at,end_at,reason) values(?,?,?,?)',req.u.id,startAt,endAt,reason).lastInsertRowid;notifyMgrs('Availability request',`${req.u.name} requests unavailability ${startAt} to ${endAt}: ${reason}`);return{id,status:'Pending'}})); // Pending never changes approved availability
api.get('/drivers/me/assignments',DR,H(r=>q("select t.*,ro.name route,v.capacity,v.capacity-(select coalesce(sum(seats),0) from assignments a where a.trip_id=t.id and a.status in"+ACTIVE+") free,(select group_concat(b.ref||' x'||a.seats) from assignments a join bookings b on b.id=a.booking_id where a.trip_id=t.id and a.status in"+ACTIVE+") passengers,(select coalesce(sum(seats),0) from assignments a where a.trip_id=t.id and a.status in"+ACTIVE+") seats from trips t join routes ro on ro.id=t.route_id join vehicles v on v.id=t.vehicle_id where t.driver_id=? order by dep_at desc",r.u.id)));
api.post('/drivers/me/trips/:id/status',DR,H(req=>{tripStatus(+req.params.id,req.body.status,req.u);return{ok:1}}));
api.post('/drivers/me/trips/:id/acknowledge',DR,H(req=>{run("update assignments set status='Confirmed' where trip_id=? and status='Reserved' and trip_id in(select id from trips where driver_id=?)",req.params.id,req.u.id);
 q('select booking_id from assignments where trip_id=? and status=\'Confirmed\'',req.params.id).forEach(a=>setB(a.booking_id,'Confirmed',req.u.id,'driver acknowledged'));return{ok:1}}));
// manager
api.get('/manager/dashboard',mgr,H(req=>{const rs=scope(req.u),routeIds=rs.join(',')||0,inr=x=>rs.includes(x.route_id||x.routeId),sf=x=>!STATION_STAFF.includes(req.u.role)||!!req.u.station_id&&x.station_id==req.u.station_id;
 const trips=q("select t.*,ro.name route,u.name driver,v.reg,v.capacity from trips t join routes ro on ro.id=t.route_id join users u on u.id=t.driver_id join vehicles v on v.id=t.vehicle_id where t.status in('Planned','Loading','Delayed','Departed') order by dep_at").filter(inr);
 trips.forEach(t=>{t.free=freeSeats(t.id);t.assignments=q("select a.id,a.booking_id,a.seats,a.status,a.method,a.onboard_confirmed,b.ref,b.payment_status,u.name passenger from assignments a join bookings b on b.id=a.booking_id join users u on u.id=b.passenger_id where a.trip_id=? and a.status in"+ACTIVE,t.id)});
 const queue=q(`select b.*,r.name route from bookings b join routes r on r.id=b.route_id where b.status='Queued' and b.payment_status in${DISPATCHABLE_SQL} order by id`).filter(inr);
 const vehicles=q('select v.*,u.name driver,d.op_status,d.verified,d.station_id from vehicles v join users u on u.id=v.driver_id join drivers d on d.user_id=v.driver_id').filter(sf);
 const settlements=q("select t.id,t.route_id,t.dep_at,t.status,r.name route,u.name driver from trips t join routes r on r.id=t.route_id join users u on u.id=t.driver_id where t.status='Completed' and t.settlement_confirmed_at is null").filter(inr);
 settlements.forEach(t=>{t.assignments=q("select a.booking_id,a.seats,a.onboard_confirmed,b.ref,b.payment_status,u.name passenger from assignments a join bookings b on b.id=a.booking_id join users u on u.id=b.passenger_id where a.trip_id=? and a.status in('Boarded','Completed')",t.id)});
 return{queue,queueSeats:queue.reduce((sum,b)=>sum+b.seats,0),queueBookings:queue.length,
 demand:q(`select r.name route,b.date,b.arrival,sum(b.seats) seats from bookings b join routes r on r.id=b.route_id where r.origin_id in(${routeIds}) and b.status in('Queued','Assigned','Confirmed') group by b.route_id,b.date,b.arrival`),
 tripCounts:{standby:trips.filter(t=>t.status=='Planned').length,loading:trips.filter(t=>t.status=='Loading').length,away:trips.filter(t=>['Departed','Delayed'].includes(t.status)).length},
 vehicleCounts:{available:vehicles.filter(v=>v.status=='Available'&&v.docs_ok&&v.verified).length,loading:vehicles.filter(v=>v.status=='Loading').length,away:vehicles.filter(v=>['OnRound','Returning'].includes(v.status)).length},
 requests:q(`select b.ref,b.date,b.arrival,b.seats,b.status,b.payment_status,r.name route,u.name passenger from bookings b join routes r on r.id=b.route_id join users u on u.id=b.passenger_id where b.route_id in(${routeIds}) and b.status not in('Completed','Cancelled','NoShow') order by b.id desc limit 100`),
 history:q(`select b.ref,b.date,b.arrival,b.seats,b.status,b.payment_status,r.name route,u.name passenger,b.created from bookings b join routes r on r.id=b.route_id join users u on u.id=b.passenger_id where b.route_id in(${routeIds}) order by b.id desc limit 100`),
 trips,settlements,surge:surge().filter(inr),vehicles,
 schedules:q('select u.name driver,v.reg,a.dow,a.st,a.en,d.station_id from availability a join drivers d on d.user_id=a.driver_id join users u on u.id=d.user_id left join vehicles v on v.driver_id=d.user_id').filter(sf),
 pendingDrivers:q("select d.*,u.name from drivers d join users u on u.id=d.user_id where d.verified=0").filter(sf),
 exceptions:q("select e.*,u.name,(select station_id from drivers where user_id=e.driver_id) station_id from avail_ex e join users u on u.id=e.driver_id").filter(sf),docs:q("select d.*,u.name owner,(select station_id from drivers where user_id=d.owner_id) station_id from docs d join users u on u.id=d.owner_id where d.status='Pending'").filter(sf),exclusive:q("select * from excl").filter(inr),blocked:q(`select id,name,phone,noshow_blocked_until from users where noshow_blocked_until>? and id in(select passenger_id from bookings where route_id in(${routeIds}))`,Date.now()).map(u=>({...u,until:new Date(u.noshow_blocked_until).toISOString().slice(0,10)}))}}));
api.post('/manager/drivers/:id/verify',mgr,H(req=>{if(+req.params.id==req.u.id)E(403,'Cannot self-verify');chkDrv(req.u,+req.params.id);if(!one("select 1 x from docs where owner_id=? and kind='licence' and status='Verified'",req.params.id))E(409,'Verify the licence document first');run('update drivers set verified=1 where user_id=?',req.params.id);notify(+req.params.id,'Verified','Your licence was verified.');audit(req.u.id,'driver.verify','driver',+req.params.id);return{ok:1}}));
api.post('/manager/drivers/:id/status',mgr,H(req=>{const id=+req.params.id;chkDrv(req.u,id);if(!one('select 1 x from drivers where user_id=?',id))E(404,'Driver not found');if(!['Available','Suspended','TemporarilyUnavailable'].includes(req.body.status))E(400,'Invalid driver status');run('update drivers set op_status=? where user_id=?',req.body.status,id);audit(req.u.id,'driver.status','driver',id,req.body);return{ok:1}}));
api.post('/manager/drivers/:id/availability',mgr,H(req=>{const id=+req.params.id,{dow,st,en}=req.body;chkDrv(req.u,id);if(!Number.isInteger(dow)||dow<0||dow>6||!validTime(st)||!validTime(en)||st>=en)E(400,'Invalid availability window');run('insert into availability(driver_id,dow,st,en) values(?,?,?,?)',id,dow,st,en);notify(id,'Schedule changed','Your weekly availability was updated by a manager.');audit(req.u.id,'availability.set','driver',id,req.body);return{ok:1}}));
['approve','reject'].forEach(a=>api.post('/manager/availability-exceptions/:id/'+a,mgr,H(req=>{const e=one('select * from avail_ex where id=?',req.params.id);if(!e||e.status!='Pending')E(409,'Not pending');chkDrv(req.u,e.driver_id);
 if(a=='approve'){const c=q("select * from trips where driver_id=? and status in('Planned','Loading') and dep_at<? and dep_at>=?",e.driver_id,e.end_at,e.start_at);if(c.length)E(409,'Conflicts with trips '+c.map(t=>'#'+t.id)+'; resolve (cancel/reassign) first')}
 run('update avail_ex set status=?,reviewed_by=?,comment=? where id=?',a=='approve'?'Approved':'Rejected',req.u.id,req.body.comment||'',e.id);notify(e.driver_id,'Availability request',`Your request was ${a}d.`);audit(req.u.id,'exception.'+a,'avail_ex',e.id);return{ok:1}})));
api.post('/manager/trips',mgr,H(req=>{const{routeId,driverId,vehicleId,date,time}=req.body;inScope(req.u,routeId);chkDrv(req.u,+driverId);if(!validDateTime(date,time))E(400,'Bad date/time');const v=one('select * from vehicles where id=? and driver_id=?',vehicleId,driverId);if(!v)E(400,'Vehicle does not belong to driver');
 if(!eligible(driverId,v,date,mins(time)))E(409,'Driver/vehicle not eligible (verification, availability, status or overlap)');
 const id=run('insert into trips(route_id,driver_id,vehicle_id,dep_at) values(?,?,?,?)',routeId,driverId,vehicleId,date+'T'+time).lastInsertRowid;notify(driverId,'Trip assignment',`Trip #${id} at ${date} ${time}`);audit(req.u.id,'trip.create','trip',id);allocate();return{id}}));
api.post('/manager/trips/:id/status',mgr,H(req=>{const t=one('select route_id from trips where id=?',req.params.id);if(!t)E(404,'No such trip');inScope(req.u,t.route_id);tripStatus(+req.params.id,req.body.status,req.u);return{ok:1}}));
api.post('/manager/allocate',mgr,H(()=>({allocated:allocate()})));
api.post('/manager/assignments/:id/override',mgr,H(req=>db.transaction(()=>{const{tripId,reason}=req.body;if(!reason)E(400,'Reason required');const a=one('select * from assignments where id=?',req.params.id),t=one('select * from trips where id=?',tripId);
 if(!a||!t)E(404,'Not found');const b=one('select * from bookings where id=?',a.booking_id);inScope(req.u,b.route_id);if(a.status=='Boarded')E(409,'Boarded passengers cannot be reassigned');if(!['Planned','Loading'].includes(t.status))E(409,'Target trip not open');
 if(t.route_id!=b.route_id)E(409,'Route mismatch');run("update assignments set status='Reassigned' where id=?",a.id);assign(t,b,'Manual',req.u.id,reason);audit(req.u.id,'assignment.override','assignment',a.id,{tripId,reason});return{ok:1}})()));
api.get('/manager/audit',mgr,H(req=>{if(STATION_STAFF.includes(req.u.role)&&!req.u.station_id)return[];const st=STATION_STAFF.includes(req.u.role)&&req.u.station_id,f=req.query,[l0,o0]=pg(req),cv=f.format=='csv',l=cv?5000:l0,o=cv?0:o0,w=[],a=[];
 if(st)w.push('station_id='+(+st));if(f.action){w.push('action like ?');a.push(f.action+'%')}if(f.entity){w.push('entity=?');a.push(f.entity)}if(f.actor){w.push('actor=?');a.push(+f.actor)}if(f.from){w.push('at>=?');a.push(f.from)}if(f.to){w.push('at<=?');a.push(f.to+'T99')}
 const W=w.length?' where '+w.join(' and '):'';req.res.set('X-Total-Count',one('select count(*) n from audit'+W,...a).n);return rep(req,q('select id,at,actor,(select name from users where id=actor) actor_name,action,entity,eid,meta from audit'+W+' order by id desc limit ? offset ?',...a,l,o))}));
// admin
const AD=ROLE('admin');
api.post('/admin/stations',AD,H(r=>({id:run('insert into stations(name) values(?)',r.body.name).lastInsertRowid})));
api.post('/admin/routes',AD,H(r=>({id:run('insert into routes(origin_id,dest_id,name) values(?,?,?)',r.body.originId,r.body.destId,r.body.name).lastInsertRowid})));
api.post('/manager/stations',mgr,H(req=>{
 const name=String(req.body.name||'').trim();if(!name||name.length>100)E(400,'Station name is required (100 characters maximum)');
 return{id:run('insert into stations(name) values(?)',name).lastInsertRowid};
}));
api.post('/manager/routes',mgr,H(req=>{
 const originId=Number(req.body.originId),destId=Number(req.body.destId),origin=one('select id from stations where id=?',originId),dest=one('select id,name from stations where id=?',destId);
 if(!origin||!dest||originId===destId)E(400,'Choose two different existing stations');
 if(STATION_STAFF.includes(req.u.role)&&req.u.station_id&&originId!==req.u.station_id)E(403,'Routes must start at your assigned station');
 const name=String(req.body.name||'').trim()||q('select name from stations where id=? union all select name from stations where id=?',originId,destId).map(s=>s.name).join(' -> ');
 return{id:run('insert into routes(origin_id,dest_id,name) values(?,?,?)',originId,destId,name).lastInsertRowid};
}));
api.post('/admin/users/:id/role',AD,H(r=>{const role=r.body.role,stationId=['manager','accountant'].includes(role)?Number(r.body.stationId):null;if(!['admin','manager','accountant','driver','passenger'].includes(role))E(400,'Invalid role');if(['manager','accountant'].includes(role)&&(!Number.isInteger(stationId)||!one('select 1 x from stations where id=?',stationId)))E(400,'A valid station is required for station staff accounts');if(!one('select 1 x from users where id=?',r.params.id))E(404,'User not found');run('update sessions set revoked=1 where user_id=?',r.params.id);run('update users set role=?,station_id=? where id=?',role,stationId,r.params.id);audit(r.u.id,'role.set','user',+r.params.id,r.body);return{ok:1}}));
api.get('/admin/users',AD,H(()=>q('select id,phone,name,role,station_id from users')));
api.get('/admin/fees',AD,H(()=>{
 const keys=FEE_CONFIG_KEYS,global=Object.fromEntries(keys.map(k=>[k,Number(cfg(k,null,0))]));
 const stations=q('select id,name from stations order by name').map(s=>{
  const overrides=Object.fromEntries(keys.map(k=>{const x=one('select value from config where scope=? and key=?','station:'+s.id,k);return[k,x?Number(x.value):null]})),values=Object.fromEntries(keys.map(k=>[k,overrides[k]??global[k]]));
  const route=one('select id from routes where origin_id=? order by id limit 1',s.id),fare=route?Number(cfg('fare_ghs',route.id,0)):0,pcts=route?keys.map(k=>Number(cfg(k,route.id,0))):keys.map(k=>Number(cfg(k,null,0))),charges=riderCharges(toPesewas(fare),pcts[0],pcts[1]);
  return{...s,values,overrides,sampleFareGhs:fare,sampleTotalGhs:ghs(toPesewas(fare)+charges.stationFeePesewas+charges.platformFeePesewas)}
 });
 const fare=Number(cfg('fare_ghs',null,100)),charges=riderCharges(toPesewas(fare),global.station_fee_pct,global.platform_fee_pct);
 return{global,globalSampleFareGhs:fare,globalSampleTotalGhs:ghs(toPesewas(fare)+charges.stationFeePesewas+charges.platformFeePesewas),stations,history:q("select id,at,actor,(select name from users where id=actor) actor_name,meta from audit where action='fees.configure' order by id desc limit 100")}
}));
api.put('/admin/fees',AD,H(req=>{
 const scopeValue=String(req.body.scope||'global'),match=scopeValue.match(/^station:([1-9]\d*)$/),validScope=scopeValue=='global'||!!match&&!!one('select 1 x from stations where id=?',+match[1]);
 if(!validScope)E(400,'Scope must be global or station:ID');const values=req.body.values;if(!values||typeof values!='object'||Array.isArray(values))E(400,'Fee percentage values are required');
 const oldValues={},newValues={};for(const key of FEE_CONFIG_KEYS){const value=Number(values[key]);if(!Number.isFinite(value)||value<0||value>100)E(400,`${key} must be between 0 and 100`);oldValues[key]=one('select value from config where scope=? and key=?',scopeValue,key)?.value??null;newValues[key]=String(value)}
 db.transaction(()=>{for(const key of FEE_CONFIG_KEYS)run('insert into config(scope,key,value) values(?,?,?) on conflict(scope,key) do update set value=excluded.value',scopeValue,key,newValues[key]);
  audit(req.u.id,'fees.configure','config',0,{scope:scopeValue,oldValues,newValues})})();
 return{ok:1}
}));
api.get('/admin/platform-settings',AD,H(()=>({
 settings:Object.fromEntries(PLATFORM_SETTING_KEYS.filter(k=>!PLATFORM_SECRET_KEYS.has(k)).map(k=>[k,process.env[k]||''])),
 secrets:Object.fromEntries([...PLATFORM_SECRET_KEYS].map(k=>[k,!!(process.env[k]||'')]))
})));
api.put('/admin/platform-settings',AD,H(req=>{
 const settings=req.body.settings||{},clearSecrets=req.body.clearSecrets||[];
 if(!settings||typeof settings!='object'||Array.isArray(settings)||!Array.isArray(clearSecrets))E(400,'Invalid platform settings');
 const next={},changed=[];
 for(const[k,raw]of Object.entries(settings)){
  if(!PLATFORM_SETTING_KEYS.includes(k))E(400,'Unknown platform setting');
  if(typeof raw!='string'||raw.length>2048)E(400,`${k} must be a text value up to 2048 characters`);
  if(PLATFORM_SECRET_KEYS.has(k)&&!raw)continue;
  next[k]=raw.trim();changed.push(k)
 }
 if(clearSecrets.some(k=>!PLATFORM_SECRET_KEYS.has(k)))E(400,'Invalid secret field to clear');
 const payment=next.PAYMENT_PROVIDER??process.env.PAYMENT_PROVIDER??'eganow',sms=next.SMS_PROVIDER??process.env.SMS_PROVIDER??'console',email=next.EMAIL_PROVIDER??process.env.EMAIL_PROVIDER??'disabled';
 if(!['eganow','mock'].includes(payment)||!['twilio','http','console'].includes(sms)||!['disabled','smtp'].includes(email))E(400,'Unsupported payment, SMS, or email provider');
 if(PROD&&(payment=='mock'||sms=='console'))E(400,'Mock payments and console messaging are not allowed in production');
 const port=Number(next.SMTP_PORT??process.env.SMTP_PORT??'587');if((next.SMTP_PORT??process.env.SMTP_PORT)&&(!Number.isInteger(port)||port<1||port>65535))E(400,'SMTP_PORT must be between 1 and 65535');
 for(const key of['EGANOW_BASE_URL','EGANOW_CALLBACK_URL','TWILIO_API_BASE_URL','SMS_URL']){
  const value=next[key]??process.env[key];if(!value)continue;
  let url;try{url=new URL(value)}catch{E(400,`${key} must be a valid URL`)}
  if(PROD&&url.protocol!='https:')E(400,`${key} must use HTTPS in production`)
 }
 if(settings.NOTIFY_CHANNEL&&!['sms','whatsapp'].includes(settings.NOTIFY_CHANNEL))E(400,'NOTIFY_CHANNEL must be sms or whatsapp');
 if(settings.EMAIL_PROVIDER=='smtp'&&(!settings.SMTP_HOST&&!process.env.SMTP_HOST))E(400,'Configure SMTP_HOST before selecting SMTP');
 const prior={};for(const k of [...changed,...clearSecrets])prior[k]=process.env[k];const priorPaymentProvider=paymentProvider;
 try{
  for(const[k,value]of Object.entries(next))process.env[k]=value;
  for(const k of clearSecrets)delete process.env[k];
  if((next.PAYMENT_PROVIDER||clearSecrets.includes('PAYMENT_PROVIDER'))&&typeof paymentProvider!='undefined'){
   paymentProvider=createPaymentProvider();if(paymentProvider.name=='eganow')paymentProvider.getBaseUrl()
  }
  db.transaction(()=>{
   for(const[k,value]of Object.entries(next))run('insert into platform_settings(key,value,encrypted) values(?,?,?) on conflict(key) do update set value=excluded.value,encrypted=excluded.encrypted',k,PLATFORM_SECRET_KEYS.has(k)?encryptSetting(value):value,PLATFORM_SECRET_KEYS.has(k)?1:0);
   for(const k of clearSecrets)run('delete from platform_settings where key=?',k);
   audit(req.u.id,'platform.settings','platform',0,{settings:changed,clearedSecrets:clearSecrets})
  })()
 }catch(e){for(const k of [...changed,...clearSecrets]){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k]}paymentProvider=priorPaymentProvider;throw e}
 return{ok:1}
}));
api.get('/reports/daily-operations',mgr,H(req=>{const ids=scope(req.u).join(',')||0;return rep(req,q(`select substr(t.dep_at,1,10) day,t.status,count(*) trips from trips t join routes r on r.id=t.route_id where r.id in(${ids}) group by 1,2`))}));
// ---- v1.2 additions ----
const fs=require('fs'),path=require('path'),UP=path.resolve(__dirname,process.env.UPLOAD_DIR||'uploads');fs.mkdirSync(UP,{recursive:true});
function onboardDriver(driverId,b,actorId){
 const stationId=+b.stationId,capacity=Number(b.capacity),partner=String(b.payoutPartner||'').trim().toUpperCase(),payoutPhone=normalizePhone(b.payoutPhone),days=Array.isArray(b.days)?[...new Set(b.days.map(Number))]:[];
 if(!String(b.licence||'').trim()||!one('select 1 x from stations where id=?',stationId))E(400,'Licence number and station are required');
 if(!String(b.reg||'').trim()||!String(b.type||'').trim()||!Number.isSafeInteger(capacity)||capacity<1||capacity>60)E(400,'Vehicle registration, type, and capacity (1-60 seats) are required');
 if(!days.length||days.some(d=>!Number.isInteger(d)||d<0||d>6)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.startTime||'')||!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.endTime||'')||b.startTime>=b.endTime)E(400,'Select weekly availability days and a valid time range');
 if(!isSupportedPayPartner(paymentProvider,partner)||!payoutPhone)E(400,'Choose a supported mobile-money network and valid payout number');
 const docs=['licence','vehicle_registration','insurance'].map(kind=>({kind,...(b.documents||{})[kind]})),files=[];
 for(const d of docs){const ext=path.extname(d.filename||'').toLowerCase(),buf=Buffer.from(d.contentBase64||'','base64');
  if(!['.pdf','.jpg','.jpeg','.png'].includes(ext)||!buf.length||buf.length>3e6)E(400,`Upload a PDF, JPG, or PNG ${d.kind} document under 3MB`);
  if(d.kind!='vehicle_registration'&&(!/^\d{4}-\d\d-\d\d$/.test(d.expiresOn||'')||d.expiresOn<=new Date().toISOString().slice(0,10)))E(400,`A future expiry date is required for ${d.kind}`);
  d.buffer=buf}
 if(docs.reduce((sum,d)=>sum+d.buffer.length,0)>8e6)E(400,'Combined document uploads must be under 8MB');
 try{db.transaction(()=>{
  if(one('select 1 x from drivers where user_id=?',driverId))E(409,'Driver profile already exists');
  run('insert into drivers(user_id,licence,station_id,payout_partner,payout_msisdn) values(?,?,?,?,?)',driverId,String(b.licence).trim(),stationId,partner,normalizeMsisdn(payoutPhone));
  const vehicleId=run('insert into vehicles(driver_id,reg,type,capacity) values(?,?,?,?)',driverId,String(b.reg).toUpperCase().replace(/\s/g,''),String(b.type).trim(),capacity).lastInsertRowid;
  for(const dow of days)run('insert into availability(driver_id,dow,st,en) values(?,?,?,?)',driverId,dow,b.startTime,b.endTime);
  for(const d of docs){const filename=cr.randomBytes(12).toString('hex')+path.extname(d.filename).toLowerCase();
   fs.writeFileSync(path.join(UP,filename),d.buffer);files.push(filename);
   run('insert into docs(owner_id,vehicle_id,kind,filename,path,at,expires_on) values(?,?,?,?,?,?,?)',driverId,d.kind=='licence'?null:vehicleId,d.kind,d.filename,filename,now(),d.expiresOn||null)}
  notifyMgrs('Driver verification',`Driver ${one('select name from users where id=?',driverId).name} submitted onboarding details for station ${stationId}.`);
  audit(actorId,'driver.onboard','driver',driverId,{stationId,vehicleId,capacity,days});
 })()}catch(e){for(const f of files)fs.rmSync(path.join(UP,f),{force:true});throw e}
}
const pg=req=>{const l=Math.min(+req.query.limit||20,100);return[l,((+req.query.page||1)-1)*l]};
const csv=rows=>{if(!rows.length)return'';const k=Object.keys(rows[0]);return[k.join(','),...rows.map(r=>k.map(c=>JSON.stringify(r[c]??'')).join(','))].join('\n')};
const rep=(req,rows)=>req.query.format=='csv'?csv(rows):rows;
api.post('/drivers/onboard',DR,H(req=>{onboardDriver(req.u.id,req.body,req.u.id);return{ok:1,status:'Pending verification'}}));
api.post('/manager/drivers/onboard',mgr,H(req=>{const phone=normalizePhone(req.body.phone),name=String(req.body.name||'').trim(),stationId=+(req.body.stationId||req.u.station_id);
 if(!phone||!name||!stationId||!req.body.consent)E(400,'Phone, name, station, and driver consent are required');
 if(STATION_STAFF.includes(req.u.role)&&req.u.station_id&&stationId!=req.u.station_id)E(403,'Cannot onboard drivers for another station');
 if(one('select 1 x from users where phone=?',phone))E(409,'A user already has this phone number');
 const driverId=db.transaction(()=>{const id=run('insert into users(phone,name,role,station_id,verified,consent_at,consent_ver) values(?,?,?,?,?,?,?)',phone,name,'driver',stationId,0,new Date().toISOString(),TV).lastInsertRowid;
  onboardDriver(id,{...req.body,stationId},req.u.id);return id})();return{ok:1,driverId,status:'Pending verification'}}));
function reserveExcl(x,b){const dep=mins(x.time);let v;
 if(b.vehicleId){v=one('select * from vehicles where id=?',b.vehicleId);if(!v||v.capacity<x.seats)E(409,'Vehicle capacity is below the requested passenger count');if(!eligible(v.driver_id,v,x.date,dep))E(409,'Vehicle not eligible')}
 else{const c=q('select * from vehicles where capacity>=?',x.seats).filter(v=>eligible(v.driver_id,v,x.date,dep));if(!c.length)E(409,`No eligible vehicle with at least ${x.seats} seats`);v=c[Math.random()*c.length|0]}
 const id=run('insert into trips(route_id,driver_id,vehicle_id,dep_at,exclusive_for) values(?,?,?,?,?)',x.route_id,v.driver_id,v.id,x.date+'T'+x.time,x.id).lastInsertRowid;
 notify(v.driver_id,'Trip assignment',`Exclusive trip #${id} at ${x.date} ${x.time}`);notify(x.passenger_id,'Full-vehicle request',`Approved: vehicle reserved on trip #${id}.`);return id}
api.get('/stations',H(()=>q('select * from stations')));
api.get('/config',H(req=>{const rows=q('select * from config');if(req.u.role=='admin')return rows;if(!STATION_STAFF.includes(req.u.role)||!req.u.station_id)return[];const routes=scope(req.u);return rows.filter(c=>c.scope=='station:'+req.u.station_id||c.scope.startsWith('route:')&&routes.includes(+c.scope.slice(6)))}));
api.get('/manager/fares',mgr,H(req=>q('select * from routes').filter(r=>scope(req.u).includes(r.id)).map(r=>({...r,fare_ghs:cfg('fare_ghs',r.id,null),payout_gate:cfg('payout_gate',r.id,'manager_completion'),station_fee_pct:cfg('station_fee_pct',r.id,0)}))));
api.put('/manager/routes/:id/fare',mgr,H(req=>{const routeId=+req.params.id,{fareGhs,payoutGate}=req.body;inScope(req.u,routeId);
 const fare=Number(fareGhs);if(!Number.isFinite(fare)||toPesewas(fare)<=0||fare>100000||!['onboard','manager_completion'].includes(payoutGate))E(400,'Fare must be positive and payout gate must be selected');
 db.transaction(()=>{for(const[k,value]of[['fare_ghs',fare.toFixed(2)],['payout_gate',payoutGate]])run('insert into config(scope,key,value) values(?,?,?) on conflict(scope,key) do update set value=excluded.value','route:'+routeId,k,value);
  audit(req.u.id,'fare.configure','route',routeId,{fareGhs:fare,payoutGate})})();return{ok:1}}));
api.put('/config',mgr,H(req=>{const{scope:s,key,value}=req.body,u=req.u;if(FEE_CONFIG_KEYS.includes(key)&&u.role!='admin')E(403,'Fee percentages can only be configured through the admin fees panel');
 const allowed=['cutoff_min','cancel_deadline_min','confirm_hours_before','surge_seats','surge_wait','max_vehicles','remind_hours','final_remind_hours','ride_remind_min','noshow_limit','noshow_days','noshow_block_days','cash_enabled','fee_due_hours','fee_max_outstanding_ghs','fee_manual_needs_approval','fee_block_cash'];
 if(!allowed.includes(key)||value===''||!Number.isFinite(Number(value)))E(400,'Unknown key or non-numeric value');
 if(['cash_enabled','fee_manual_needs_approval','fee_block_cash'].includes(key)&&![0,1].includes(Number(value)))E(400,`${key} must be 0 or 1`);
 const[k,id]=String(s).split(':'),numericId=/^[1-9]\d*$/.test(id||''),ok=s=='global'?u.role=='admin':k=='station'?numericId&&!!one('select 1 x from stations where id=?',+id)&&(u.role=='admin'||STATION_STAFF.includes(u.role)&&!!u.station_id&&u.station_id==id):k=='route'?numericId&&scope(u).includes(+id):false;if(!ok)E(403,'Scope not allowed');
 if(['fee_due_hours','fee_max_outstanding_ghs','fee_manual_needs_approval'].includes(key)&&u.role!='admin')E(403,'This fee policy is admin-only');
 run('insert into config values(?,?,?) on conflict(scope,key) do update set value=excluded.value',s,key,String(value));audit(u.id,'config.set','config',0,req.body);return{ok:1}}));
api.patch('/bookings/:id',P,H(req=>db.transaction(()=>{const b=one('select * from bookings where id=? and passenger_id=?',req.params.id,req.u.id);if(!b)E(404,'Not found');if(!['Queued','Assigned','Confirmed'].includes(b.status))E(409,'Cannot edit at this stage');
 if(b.paid_pesewas>0||b.payment_status=='Credit')E(409,'Paid bookings cannot be edited; contact the station manager to request a fare adjustment.');
 const n={date:req.body.date||b.date,arrival:req.body.arrival||b.arrival,seats:req.body.seats||b.seats};if(!(n.seats>=1&&n.seats<=3))E(400,'Seats 1-3');if(!validDateTime(n.date,n.arrival))E(400,'Bad date/time');
 if(Date.parse(n.date+'T'+n.arrival+':00Z')-Date.now()<cfg('cutoff_min',b.route_id,CUTOFF)*6e4)E(400,'Past booking cut-off');
 const farePesewas=Math.round(b.fare_pesewas/b.seats)*n.seats,rider=riderCharges(farePesewas,b.rider_station_pct,b.rider_platform_pct),driver=driverDeductions(farePesewas,b.driver_station_pct,b.driver_platform_pct);
 run("update assignments set status='Reassigned' where booking_id=? and status in"+ACTIVE,b.id);run('update bookings set date=?,arrival=?,seats=?,fare_pesewas=?,station_fee_pesewas=?,platform_fee_pesewas=?,driver_station_deduction_pesewas=?,driver_platform_deduction_pesewas=? where id=?',n.date,n.arrival,n.seats,farePesewas,rider.stationFeePesewas,rider.platformFeePesewas,driver.stationDeductionPesewas,driver.platformDeductionPesewas,b.id);
 setB(b.id,'Queued',req.u.id,'edited');audit(req.u.id,'booking.edit','booking',b.id,n);allocate();return bookingPublic(b.id)})()));
api.patch('/recurring/:id',P,H(req=>{const r=rec(req),b=req.body,seats=b.seats||r.seats;if(!(seats>=1&&seats<=3))E(400,'Seats 1-3');
 const days=b.days||r.days.split(',').map(Number),arrival=b.arrival||r.arrival,startDate=b.startDate||r.start_date,endDate=b.endDate||r.end_date;
 if(!validTime(arrival)||!validDate(startDate)||!validDate(endDate)||endDate<startDate||!Array.isArray(days)||!days.length||days.some(d=>!Number.isInteger(d)||d<0||d>6))E(400,'Invalid recurring schedule');
 run('update recurring set days=?,seats=?,arrival=?,start_date=?,end_date=? where id=?',days.join(','),seats,arrival,startDate,endDate,r.id);audit(req.u.id,'recurring.edit','recurring',r.id,b);
 return{ok:1,note:'Applies to weeks not yet confirmed; existing assigned/confirmed bookings are not rewritten'}}));
api.post('/manager/bookings/:id/no-show',mgr,H(req=>{const b=one('select * from bookings where id=?',req.params.id);if(!b)E(404,'Not found');inScope(req.u,b.route_id);if(!['Assigned','Confirmed'].includes(b.status))E(409,'Only assigned/confirmed bookings can be no-shows (before departure)');
 run("update assignments set status='Cancelled' where booking_id=? and status in"+ACTIVE,b.id);setB(b.id,'NoShow',req.u.id,req.body.reason||'no-show');noshowRule(b);notify(b.passenger_id,'No-show',`Booking ${b.ref} marked as no-show.`);audit(req.u.id,'booking.noshow','booking',b.id);allocate();return{ok:1}}));
api.post('/exclusive-requests/:id/cancel',P,H(req=>{const x=one('select * from excl where id=? and passenger_id=?',req.params.id,req.u.id);if(!x||['Cancelled','Rejected'].includes(x.status))E(404,'Not found');
 if(x.trip_id){const t=one('select status from trips where id=?',x.trip_id);if(t.status!='Planned')E(409,'Trip already underway');tripStatus(x.trip_id,'Cancelled',{id:0,role:'admin'})}run("update excl set status='Cancelled' where id=?",x.id);return{ok:1}}));
// documents & vehicle ownership
api.post('/documents',DR,H(req=>{const{vehicleId,kind,filename,contentBase64,expiresOn}=req.body,ext=path.extname(filename||'').toLowerCase();
 if(!['.pdf','.jpg','.jpeg','.png'].includes(ext))E(400,'pdf/jpg/png only');if(!['licence','vehicle_registration','insurance','roadworthy'].includes(kind))E(400,'Unknown document kind');if(kind!='vehicle_registration'&&!(/^\d{4}-\d\d-\d\d$/.test(expiresOn||'')&&expiresOn>new Date().toISOString().slice(0,10)))E(400,'A future expiry date (YYYY-MM-DD) is required for this document');
 if(vehicleId&&!one('select 1 x from vehicles where id=? and driver_id=?',vehicleId,req.u.id))E(403,'Not your vehicle');
 const buf=Buffer.from(contentBase64||'','base64');if(!buf.length||buf.length>4e6)E(400,'File empty or over 4MB');const f=cr.randomBytes(12).toString('hex')+ext;fs.writeFileSync(path.join(UP,f),buf);
 return{id:run('insert into docs(owner_id,vehicle_id,kind,filename,path,at,expires_on) values(?,?,?,?,?,?,?)',req.u.id,vehicleId||null,kind,filename,f,now(),expiresOn||null).lastInsertRowid,status:'Pending'}}));
api.get('/documents',DR,H(r=>q('select id,kind,vehicle_id,filename,status,note from docs where owner_id=?',r.u.id)));
api.get('/documents/:id/file',H((req,res)=>{const d=one('select * from docs where id=?',req.params.id);if(!d||(d.owner_id!=req.u.id&&!['manager','admin'].includes(req.u.role)))E(404,'Not found');if(req.u.role=='manager')chkDrv(req.u,d.owner_id);res.sendFile(path.join(UP,d.path))}));
['verify','reject'].forEach(a=>api.post('/manager/documents/:id/'+a,mgr,H(req=>{const d=one('select * from docs where id=?',req.params.id);if(!d)E(404,'Not found');chkDrv(req.u,d.owner_id);if(a=='verify'&&d.expires_on&&d.expires_on<=now().slice(0,10))E(409,'Document already expired');
 run('update docs set status=?,reviewed_by=?,note=? where id=?',a=='verify'?'Verified':'Rejected',req.u.id,req.body.note||'',d.id);notify(d.owner_id,'Document',`Your ${d.kind} document was ${a=='verify'?'verified':'rejected'}.`);audit(req.u.id,'doc.'+a,'doc',d.id);return{ok:1}})));
api.post('/manager/vehicles/:id/verify',mgr,H(req=>{const v=one('select * from vehicles where id=?',req.params.id);if(!v)E(404,'Not found');chkDrv(req.u,v.driver_id);
 for(const k of['vehicle_registration','insurance'])if(!one("select 1 x from docs where vehicle_id=? and kind=? and status='Verified'",v.id,k))E(409,`Verified ${k} document required`);
 run('update vehicles set docs_ok=1 where id=?',v.id);audit(req.u.id,'vehicle.verify','vehicle',v.id);allocate();return{ok:1}}));
api.post('/manager/vehicles/:id/transfer',mgr,H(req=>{const v=one('select * from vehicles where id=?',req.params.id),to=+req.body.driverId;if(!v)E(404,'Not found');chkDrv(req.u,v.driver_id);chkDrv(req.u,to);
 if(!one('select 1 x from drivers where user_id=? and verified=1',to))E(409,'Target must be a verified driver');if(one('select count(*) n from vehicles where driver_id=?',to).n>=cfg('max_vehicles',null,2))E(409,'Target at vehicle limit');
 if(one("select 1 x from trips where vehicle_id=? and status in('Planned','Loading','Departed')",v.id))E(409,'Vehicle has open trips');run('update vehicles set driver_id=?,docs_ok=0 where id=?',to,v.id);audit(req.u.id,'vehicle.transfer','vehicle',v.id,{to});return{ok:1}}));
api.post('/admin/managers',AD,H(req=>{const phone=normalizePhone(req.body.phone),name=String(req.body.name||'').trim(),stationId=Number(req.body.stationId),pin=req.body.pin;if(!phone||!name||!Number.isInteger(stationId)||!one('select 1 x from stations where id=?',stationId)||String(pin||'').length<6)E(400,'phone, name, valid stationId, pin (6+ chars) required');return{id:run('insert into users(phone,name,role,station_id,verified,pin_hash) values(?,?,?,?,?,?)',phone,name,'manager',stationId,1,hashPin(pin)).lastInsertRowid}}));
// reports (CSV via ?format=csv, date range via ?from=&to=)
const rng=req=>[req.query.from||'0000-01-01',req.query.to||'9999-12-31'];
api.get('/reports/route-demand',mgr,H(req=>{const[f,t]=rng(req),rs=scope(req.u).join(',')||0;return rep(req,q(`select r.name route,b.date,substr(b.arrival,1,2)||':00' hour,count(*) bookings,sum(b.seats) seats,sum(b.status='Completed') completed,sum(b.status='Cancelled') cancelled,sum(b.status='NoShow') no_shows,sum(b.status='Queued') waiting from bookings b join routes r on r.id=b.route_id where b.route_id in(${rs}) and b.date between ? and ? group by b.route_id,b.date,substr(b.arrival,1,2) order by b.date`,f,t))}));
api.get('/reports/driver-utilisation',mgr,H(req=>{const[f,t]=rng(req),rs=scope(req.u).join(',')||0;return rep(req,q(`select u.name driver,v.reg,count(*) trips,sum(t.status='Completed') completed,sum(t.status='Breakdown') breakdowns,coalesce(sum((select sum(a.seats) from assignments a where a.trip_id=t.id and a.status='Boarded')),0) seats_carried,round(count(*)*${DUR}/60.0,1) scheduled_hours from trips t join users u on u.id=t.driver_id join vehicles v on v.id=t.vehicle_id where t.route_id in(${rs}) and substr(t.dep_at,1,10) between ? and ? group by t.driver_id,t.vehicle_id`,f,t))}));
// ---- v1.4 additions ----
function moveTrip(id,time,date,reason,u,delayed){const t=one('select * from trips where id=?',id);if(!t||!['Planned','Loading','Delayed'].includes(t.status))E(409,'Trip cannot be rescheduled now');inScope(u,t.route_id);
 const as=q('select a.id,b.passenger_id,b.ref,b.arrival from assignments a join bookings b on b.id=a.booking_id where a.trip_id=? and a.status in'+ACTIVE,id),od=t.dep_at.slice(0,10),d=date||od;if(!validDateTime(d,time))E(400,'Bad date/time');
 if(as.length&&d!=od)E(409,'Cannot change the date while passengers are assigned');if(as.some(a=>mins(a.arrival)>mins(time)))E(409,"New time is earlier than a passenger's arrival time");
 if(q("select dep_at from trips where id!=? and (driver_id=? or vehicle_id=?) and status not in('Cancelled','Completed','Breakdown') and substr(dep_at,1,10)=?",id,t.driver_id,t.vehicle_id,d).some(x=>Math.abs(mins(x.dep_at.slice(11))-mins(time))<DUR))E(409,'Overlaps another trip of this driver/vehicle');
 run('update trips set dep_at=?,status=?,reminded=0 where id=?',d+'T'+time,delayed?'Delayed':t.status=='Delayed'?'Planned':t.status,id);run('update bookings set reminded=0 where id in(select booking_id from assignments where trip_id=?)',id);
 const ev=delayed?'Trip delayed':'Schedule changed';as.forEach(a=>notify(a.passenger_id,ev,`Booking ${a.ref}: new estimated departure ${d} ${time}. ${reason}`));notify(t.driver_id,'Schedule changed',`Trip #${id} now ${d} ${time}. ${reason}`);
 audit(u.id,delayed?'trip.delay':'trip.reschedule','trip',id,{time,date:d,reason});return{ok:1,departure:d+'T'+time}}
const breakdown=db.transaction((id,u,reason)=>{const t=one('select * from trips where id=?',id);if(!t||['Completed','Cancelled','Breakdown'].includes(t.status))E(409,'Not applicable');
 run("update trips set status='Breakdown' where id=?",id);run("update vehicles set status='Maintenance' where id=?",t.vehicle_id);run("update drivers set op_status='TemporarilyUnavailable' where user_id=?",t.driver_id);
 q("select b.passenger_id,b.ref from assignments a join bookings b on b.id=a.booking_id where a.trip_id=? and a.status='Boarded'",id).forEach(p=>notify(p.passenger_id,'Breakdown',`Booking ${p.ref}: your vehicle broke down; the station manager is arranging help.`));
 requeue(id,'Reassigned','vehicle breakdown',true);notifyMgrs('Breakdown',`Trip #${id} breakdown${reason?': '+reason:''}.`);audit(u.id,'trip.breakdown','trip',id,{reason});allocate()}); // boarded passengers are never silently reassigned
api.post('/manager/trips/:id/breakdown',mgr,H(req=>{const t=one('select route_id from trips where id=?',req.params.id);if(!t)E(404,'No such trip');inScope(req.u,t.route_id);breakdown(+req.params.id,req.u,req.body.reason);return{ok:1}}));
api.post('/drivers/me/trips/:id/breakdown',DR,H(req=>{if(!one('select 1 x from trips where id=? and driver_id=?',req.params.id,req.u.id))E(403,'Not your trip');breakdown(+req.params.id,req.u,req.body.reason);return{ok:1}}));
api.post('/manager/trips/:id/reschedule',mgr,H(req=>db.transaction(()=>{const{time,date,reason}=req.body;if(!validTime(time)||date!==undefined&&!validDate(date)||!String(reason||'').trim())E(400,'Valid time, optional date, and reason required');return moveTrip(+req.params.id,time,date,reason,req.u,false)})()));
api.post('/manager/trips/:id/delay',mgr,H(req=>db.transaction(()=>{const m=+req.body.minutes,t=one('select dep_at from trips where id=?',req.params.id);if(!t)E(404,'No such trip');if(!(m>0&&m<=480)||!req.body.reason)E(400,'minutes (1-480) and reason required');return moveTrip(+req.params.id,hhmm(mins(t.dep_at.slice(11))+m),null,req.body.reason,req.u,true)})()));
api.post('/manager/bookings/:id/assign',mgr,H(req=>db.transaction(()=>{const{tripId,reason,seatLabel}=req.body,b=one('select * from bookings where id=?',req.params.id),t=one('select * from trips where id=?',tripId);if(!reason)E(400,'Reason required');if(!b||!t)E(404,'Not found');inScope(req.u,b.route_id);
 if(b.route_id!=t.route_id)E(409,'Route mismatch');if(t.exclusive_for)E(409,'Trip is reserved for a full-vehicle request');if(!['Planned','Loading'].includes(t.status))E(409,'Trip not open');if(!['Queued','Assigned','Confirmed'].includes(b.status))E(409,'Booking cannot be moved');
 run("update assignments set status='Reassigned' where booking_id=? and status in"+ACTIVE,b.id);assign(t,b,'Manual',req.u.id,reason);if(seatLabel)run('update assignments set seat_label=? where booking_id=? and status in'+ACTIVE,String(seatLabel).slice(0,10),b.id);
 audit(req.u.id,'booking.manual-assign','booking',b.id,{tripId,reason});return{ok:1}})()));
const stText=b=>b.status=='Queued'&&b.payment_status=='Due'?'Payment required before dispatch allocation.':b.status=='Queued'?`Waiting for a vehicle. Queue position ${b.queue_pos} for this route and day. We will message you when one is assigned.`:['Assigned','Confirmed'].includes(b.status)&&b.dep_at?`${b.trip_status=='Delayed'?'DELAYED. ':''}Estimated departure ${b.dep_at.slice(11)} (${b.reg||'vehicle'}${b.seat_label?', seat '+b.seat_label:''}). Estimate only, not a guarantee. Be at the station by ${b.arrival}.`:b.status=='Boarded'?'On board.':b.status=='NoShow'?'Marked as no-show.':'';
function reminders(){const t0=Date.now();
 const utcMs=(value)=>new Date((value&&value.includes('Z'))?value:value+':00Z').getTime();
 for(const c of q("select c.*,r.passenger_id from confirmations c join recurring r on r.id=c.rec_id where c.status='Pending' and r.status='Active'")){const left=(utcMs(c.deadline)-t0)/36e5;if(left<=0)continue;
  const fin=left<=cfg('final_remind_hours',null,3);if(fin&&c.reminded<2||!fin&&left<=cfg('remind_hours',null,24)&&c.reminded<1){notify(c.passenger_id,'Weekly review reminder',`${fin?'Final reminder: ':''}confirm your rides for the week of ${c.week_start} before ${c.deadline.replace('T',' ')}.`);run('update confirmations set reminded=? where id=?',fin?2:1,c.id)}}
 for(const b of q("select b.id,b.ref,b.passenger_id,b.arrival,t.dep_at from bookings b join assignments a on a.booking_id=b.id and a.status in('Reserved','Confirmed') join trips t on t.id=a.trip_id where t.status in('Planned','Loading','Delayed')")){
  const m=utcMs(b.dep_at)-t0,flags=one('select reminded from bookings where id=?',b.id).reminded||0;
  if(m>0&&m<=15*6e4&&!(flags&2)){notify(b.passenger_id,'Ride reminder',`Booking ${b.ref}: estimated departure in 15 minutes. Be at the station by ${b.arrival}.`);run('update bookings set reminded=reminded|2 where id=?',b.id)}
  else if(m>15*6e4&&m<=30*6e4&&!(flags&1)){notify(b.passenger_id,'Ride reminder',`Booking ${b.ref}: estimated departure in 30 minutes. Be at the station by ${b.arrival}.`);run('update bookings set reminded=reminded|1 where id=?',b.id)}}
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
   notify(a.passenger_id,'Boarding credit',`Booking ${a.ref}: this car has left without your confirmation. Your prepaid fare is kept as credit and you are back in the queue for the next available car.`)
  })()}
 allocate()}
function noshowRule(b){const lim=cfg('noshow_limit',b.route_id,3),days=cfg('noshow_days',b.route_id,30),bd=cfg('noshow_block_days',b.route_id,14),since=addDays(new Date().toISOString().slice(0,10),-days);
 const n=one("select count(*) n from bookings where passenger_id=? and status='NoShow' and date>=?",b.passenger_id,since).n;
 if(n>=lim){run('update users set noshow_blocked_until=? where id=?',Date.now()+bd*864e5,b.passenger_id);notify(b.passenger_id,'Booking suspended',`Bookings are suspended for ${bd} days after ${n} no-shows in ${days} days.`)}
 else notify(b.passenger_id,'No-show warning',`No-show recorded (${n} of ${lim} allowed in ${days} days).`)}
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
 if(process.env.ALERT_WEBHOOK)await fetch(process.env.ALERT_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'Transport: '+msg,content:'Transport: '+msg}),signal:AbortSignal.timeout(8000)}).catch(e=>console.error('alert webhook failed',e.message));
 for(const p of(process.env.ALERT_PHONES||'').split(',').filter(Boolean))await gw.sms(p,'ALERT: '+msg).catch(()=>{})}
function health(){const c={};try{one('select 1 x');c.db='ok'}catch(e){c.db='FAIL: '+e.message}
 const bf=fs.existsSync(BK)?fs.readdirSync(BK).filter(x=>x.endsWith('.db')).sort().pop():null,age=bf?(Date.now()-fs.statSync(path.join(BK,bf)).mtimeMs)/36e5:null;
 c.backup=age==null?'FAIL: no backup yet':age>(+process.env.BACKUP_EVERY_H||6)*2+1?`FAIL: last backup ${age.toFixed(1)}h ago`:`ok (${age.toFixed(1)}h ago)`;
 const old=one("select min(at) a from notifications where status in('Pending','Retrying')").a,failed=one("select count(*) n from notifications where status='Failed' and at>?",new Date(Date.now()-36e5).toISOString().slice(0,16)).n;
 c.messaging=failed>=(+process.env.ALERT_FAILED||5)?`FAIL: ${failed} messages failed in the last hour`:old&&Date.now()-new Date(old+'Z')>9e5?'FAIL: messages stuck for over 15 minutes':'ok';
 c.scheduler=Date.now()-lastJob>6e4?`FAIL: silent for ${Math.round((Date.now()-lastJob)/1000)}s`:'ok';return{ok:Object.values(c).every(v=>String(v).startsWith('ok')),checks:c}}
function watchdog(){const h=health();if(!h.ok){const bad=Object.entries(h.checks).filter(([,v])=>!String(v).startsWith('ok'));alertOps('health:'+bad.map(x=>x[0]),bad.map(([k,v])=>k+': '+v).join('; '))}}
app.get('/healthz/deep',(rq,res)=>{if(!process.env.HEALTH_KEY||rq.query.key!==process.env.HEALTH_KEY)return res.sendStatus(403);const h=health();res.status(h.ok?200:503).json(h)});
api.get('/admin/health',ROLE('admin'),H(()=>health()));
function expiryCheck(){const today=now().slice(0,10),in30=addDays(today,30),in7=addDays(today,7);
 for(const d of q("select * from docs where status='Verified' and expires_on is not null and expires_on<=?",in30)){
  if(d.expires_on<=today){run("update docs set status='Expired' where id=?",d.id);if(d.kind=='licence')run('update drivers set verified=0 where user_id=?',d.owner_id);else if(d.vehicle_id)run('update vehicles set docs_ok=0 where id=?',d.vehicle_id);
   notify(d.owner_id,'Document expired',`Your ${d.kind} has expired. You cannot be dispatched until a new one is uploaded and verified.`);notifyMgrs('Document expired',`Driver #${d.owner_id}: ${d.kind} expired.`);audit(0,'doc.expired','doc',d.id)}
  else{const lvl=d.expires_on<=in7?2:1;if(d.expiry_level<lvl){run('update docs set expiry_level=? where id=?',lvl,d.id);notify(d.owner_id,'Document expiring',`Your ${d.kind} expires on ${d.expires_on}. Please upload the renewal.`);if(lvl==2)notifyMgrs('Document expiring',`Driver #${d.owner_id}: ${d.kind} expires ${d.expires_on}.`)}}}}
const cfgOk=(u,s)=>{const[k,id]=String(s).split(':'),numericId=/^[1-9]\d*$/.test(id||'');return s=='global'?u.role=='admin':k=='station'?numericId&&!!one('select 1 x from stations where id=?',+id)&&(u.role=='admin'||STATION_STAFF.includes(u.role)&&!!u.station_id&&u.station_id==id):k=='route'?numericId&&scope(u).includes(+id):false};
api.delete('/config',mgr,H(req=>{if(FEE_CONFIG_KEYS.includes(req.body.key)&&req.u.role!='admin')E(403,'Fee percentages can only be changed through the admin fees panel');if(!cfgOk(req.u,req.body.scope))E(403,'Scope not allowed');run('delete from config where scope=? and key=?',req.body.scope,req.body.key);audit(req.u.id,'config.remove','config',0,req.body);return{ok:1}}));
api.post('/me/whatsapp',H(req=>{run('update users set whatsapp_optin=? where id=?',req.body.optin?1:0,req.u.id);audit(req.u.id,'whatsapp.optin','user',req.u.id,req.body);return{ok:1,enabled:gw.waEnabled}}));
api.post('/me/consent',H(req=>{run('update users set consent_at=?,consent_ver=? where id=?',new Date().toISOString(),TV,req.u.id);return{ok:1}}));
app.get('/api/v1/events',(req,res)=>{const t=tix.get(req.query.ticket);tix.delete(req.query.ticket);if(!t||t.exp<Date.now())return res.sendStatus(401);
 res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','X-Accel-Buffering':'no'});res.flushHeaders();res.write('retry: 5000\n\n');
 const c={res,role:t.role};if(!conns.has(t.id))conns.set(t.id,new Set());conns.get(t.id).add(c);req.on('close',()=>conns.get(t.id)?.delete(c))});
app.post('/webhooks/sms-status',express.urlencoded({extended:false}),(req,res)=>{if(!process.env.WEBHOOK_KEY||req.query.key!==process.env.WEBHOOK_KEY)return res.sendStatus(403);
 const st={delivered:'Delivered',failed:'Failed',undelivered:'Failed',sent:'Sent'}[req.body.MessageStatus];if(st)run('update notifications set status=? where provider_id=?',st,req.body.MessageSid);res.sendStatus(204)});
let paymentProvider = createPaymentProvider(),feeProvider=createPaymentProvider(paymentProvider.name,{envPrefix:'FEES_EGANOW'});
if(paymentProvider.name=='eganow')paymentProvider.getBaseUrl();
const cashEnabledSomewhere=()=>cfg('cash_enabled',null,0)==1||q('select id from routes').some(r=>cfg('cash_enabled',r.id,0)==1);
if(PROD&&cashEnabledSomewhere()){
 if(feeProvider.name!='eganow')throw new Error('Cash-enabled production requires the fee Eganow provider');
 for(const key of['BASE_URL','API_USERNAME','API_PASSWORD','X_AUTH'])if(!process.env['FEES_EGANOW_'+key])throw new Error(`FEES_EGANOW_${key} must be configured when cash is enabled`);
 feeProvider.getBaseUrl()
}
const providerOutcome=result=>{const s=String(result?.transactionstatus||result?.transactionStatus||result?.status||result?.data?.status||'').trim().toUpperCase();
 if(result?.isSuccess===true||['SUCCESS','SUCCESSFUL','COMPLETED'].includes(s))return'Succeeded';
 if(result?.isSuccess===false||['FAILED','FAILURE','CANCELLED','REJECTED'].includes(s))return'Failed';return'Pending'};
function applyPaymentResult(paymentId,result){
 const p=one('select * from booking_payments where id=?',paymentId);if(!p||p.status!='Pending')return p;
 const outcome=providerOutcome(result),statusText=String(result?.transactionstatus||result?.transactionStatus||result?.status||result?.data?.status||'').slice(0,40)||null;
 db.transaction(()=>{run('update booking_payments set status=?,response_status=?,updated_at=? where id=?',outcome,statusText,now(),p.id);
  if(outcome=='Succeeded'){const b=one('select * from bookings where id=?',p.booking_id),total=bookingTotal(b),paid=Math.min(total,b.paid_pesewas+p.amount_pesewas),st=paid>=total?'Paid':'Partial';
   run('update bookings set paid_pesewas=?,payment_status=? where id=?',paid,st,b.id);if(st=='Paid')ledgerRiderCharges(b);notify(b.passenger_id,'Payment received',`Payment received for booking ${b.ref}. ${st=='Paid'?'Your booking is in the dispatch queue.':'Remaining balance: GHS '+ghs(total-paid)+'.'}`)}})();
 if(outcome=='Succeeded')allocate();return one('select * from booking_payments where id=?',paymentId)}
api.post('/bookings/:id/pay',P,H(async req=>{
 const b=one('select * from bookings where id=? and passenger_id=?',req.params.id,req.u.id);if(!b)E(404,'Booking not found');
 if(!['Queued','Assigned'].includes(b.status))E(409,'This booking cannot be paid at this stage');
 if(b.payment_method=='cash')E(409,'This booking is paid to the driver in cash');
 if(b.payment_status=='Paid')E(409,'Booking is already paid');
 const pending=one("select 1 x from booking_payments where booking_id=? and status in('Pending','NeedsReview')",b.id);if(pending)E(409,'A payment is already pending; check its status before retrying');
 const amount=bookingTotal(b)-b.paid_pesewas;if(amount<=0)E(409,'No balance is due');
 const partner=String(req.body.paypartnerCode||'').trim().toUpperCase();if(!isSupportedPayPartner(paymentProvider,partner))E(400,'Choose a supported mobile-money network');
 const transactionId='TP'+cr.randomBytes(12).toString('hex').toUpperCase(),created=now();
 const paymentId=run("insert into booking_payments(booking_id,transaction_id,amount_pesewas,status,created_at,updated_at) values(?,?,?,'Pending',?,?)",b.id,transactionId,amount,created,created).lastInsertRowid;
 try{const result=await paymentProvider.initiateCollection({amount:ghs(amount),transCurrencyIso:'GHS',transactionId,reference:b.ref,paypartnerCode:partner,accountNoOrCardNoOrMSISDN:normalizeMsisdn(req.u.phone),countryCode:process.env.EGANOW_DEFAULT_COUNTRY_CODE||'GH0233',languageId:process.env.EGANOW_DEFAULT_LANGUAGE||'en',callback:process.env.EGANOW_CALLBACK_URL||''});
  const updated=applyPaymentResult(paymentId,result);return{paymentId,transactionId,status:updated.status,amountGhs:ghs(amount),message:updated.status=='Succeeded'?'Payment confirmed':'Approve the payment request, then check status.'}
 }catch(e){run("update booking_payments set status='NeedsReview',response_status='provider error',updated_at=? where id=?",now(),paymentId);notifyMgrs('Payment attention',`Payment for booking ${b.ref} needs provider status review.`);throw e}
}));
api.post('/bookings/:id/payment/status',P,H(async req=>{
 const b=one('select id from bookings where id=? and passenger_id=?',req.params.id,req.u.id);if(!b)E(404,'Booking not found');
 const p=one('select * from booking_payments where booking_id=? order by id desc limit 1',b.id);if(!p)E(404,'No payment attempt found');
 if(['Pending','NeedsReview'].includes(p.status)){const result=await paymentProvider.getTransactionStatus({transactionId:p.transaction_id});return applyPaymentResult(p.id,result)}
 return p
}));
api.post('/bookings/:id/board-confirm',P,H(async req=>{
 const a=one("select a.*,b.passenger_id,b.ref,b.route_id,b.payment_method,b.station_fee_pesewas,b.platform_fee_pesewas,b.driver_station_deduction_pesewas,b.driver_platform_deduction_pesewas,t.id trip_id,t.driver_id,t.status trip_status,t.departed_at from assignments a join bookings b on b.id=a.booking_id join trips t on t.id=a.trip_id where b.id=? and b.passenger_id=? and a.status in('Reserved','Confirmed','Boarded')",req.params.id,req.u.id);
 if(!a)E(404,'No active assignment');if(a.trip_status!='Departed')E(409,'Boarding confirmation opens when the driver starts the trip');
 if(a.departed_at&&Date.now()>new Date(a.departed_at+'Z').getTime()+15*6e4)E(409,'The 15-minute boarding confirmation window has closed');
 if(!a.onboard_confirmed){db.transaction(()=>{run("update assignments set onboard_confirmed=1,onboard_confirmed_at=?,status='Boarded' where id=?",now(),a.id);setB(a.booking_id,'Boarded',req.u.id,'passenger confirmed onboard');
  if(a.payment_method=='cash')run("insert or ignore into fee_receivables(booking_id,driver_id,station_id,station_pesewas,platform_pesewas,status,created_at,due_at) values(?,?,?,?,?,'Open',?,?)",a.booking_id,a.driver_id,one('select origin_id from routes where id=?',a.route_id).origin_id,(a.station_fee_pesewas||0)+(a.driver_station_deduction_pesewas||0),(a.platform_fee_pesewas||0)+(a.driver_platform_deduction_pesewas||0),now(),new Date(Date.now()+cfg('fee_due_hours',a.route_id,24)*36e5).toISOString().slice(0,16));
  notifyMgrs('Rider onboard',`Booking ${a.ref} confirmed onboard trip #${a.trip_id}.`)})()}
 if(cfg('payout_gate',a.route_id,'manager_completion')=='onboard')await releaseDriverPayout(a.booking_id,'onboard');
 return{ok:1,confirmed:true}
}));
api.get('/manager/payments',mgr,H(req=>{
 const routes=scope(req.u);if(!routes.length)return{payments:[],payouts:[]};const ids=routes.join(',');
 return{payments:q(`select p.id,p.transaction_id,p.amount_pesewas,p.status,p.response_status,p.updated_at,b.ref,b.payment_status,b.date,r.name route,u.name passenger from booking_payments p join bookings b on b.id=p.booking_id join routes r on r.id=b.route_id join users u on u.id=b.passenger_id where b.route_id in(${ids}) order by p.id desc limit 100`),
  payouts:q(`select p.*,b.ref,u.name driver,r.name route from driver_payouts p join bookings b on b.id=p.booking_id join trips t on t.id=p.trip_id join routes r on r.id=t.route_id join users u on u.id=t.driver_id where t.route_id in(${ids}) order by p.id desc limit 100`)}
}));
async function releaseDriverPayout(bookingId,gate,retryFailed=false){
 const row=one("select a.onboard_confirmed,b.*,t.id trip_id,t.route_id,t.status trip_status,t.settlement_confirmed_by,d.payout_partner,d.payout_msisdn from assignments a join bookings b on b.id=a.booking_id join trips t on t.id=a.trip_id join drivers d on d.user_id=t.driver_id where b.id=? and a.status in('Boarded','Completed') order by a.id desc limit 1",bookingId);
 if(!row||!row.onboard_confirmed||row.payment_status!='Paid'||row.paid_pesewas<bookingTotal(row))return null;
 const configured=cfg('payout_gate',row.route_id,'manager_completion');
 if(gate=='onboard'&&(configured!='onboard'||row.trip_status!='Departed'))return null;
 if(gate=='manager_completion'&&(configured!='manager_completion'||row.trip_status!='Completed'||!row.settlement_confirmed_by))return null;
 const amount=row.fare_pesewas-row.driver_station_deduction_pesewas-row.driver_platform_deduction_pesewas;if(amount<=0)return null;
 if(!row.payout_partner||!row.payout_msisdn){notifyMgrs('Payout attention',`Driver for booking ${row.ref} has no verified payout details.`);return null}
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
 try{const result=await paymentProvider.initiatePayout({amount:ghs(amount),transCurrencyIso:'GHS',transactionId:payout.transaction_id,reference:row.ref,paypartnerCode:row.payout_partner,accountNoOrCardNoOrMSISDN:row.payout_msisdn,countryCode:process.env.EGANOW_DEFAULT_COUNTRY_CODE||'GH0233',languageId:process.env.EGANOW_DEFAULT_LANGUAGE||'en',callback:process.env.EGANOW_CALLBACK_URL||''}),status=providerOutcome(result),responseStatus=String(result?.transactionstatus||result?.transactionStatus||result?.status||result?.data?.status||'').slice(0,40)||null;
  db.transaction(()=>{run('update driver_payouts set status=?,response_status=?,updated_at=? where id=?',status,responseStatus,now(),payout.id);if(status=='Succeeded')ledgerDriverDeductions(row)})();
  if(status=='Failed')notifyMgrs('Payout attention',`Payout for booking ${row.ref} failed; review provider status.`);
  else notify(one('select driver_id from trips where id=?',row.trip_id).driver_id,'Payout update',`Payout for booking ${row.ref}: ${status}.`);
 }catch(e){run("update driver_payouts set status='NeedsReview',response_status='provider error',updated_at=? where id=?",now(),payout.id);
  notifyMgrs('Payout attention',`Payout for booking ${row.ref} needs provider status review.`);console.error('Payout request needs reconciliation',e.message)}
 return one('select * from driver_payouts where id=?',payout.id)
}
api.post('/manager/trips/:id/settle',mgr,H(async req=>{
 const t=one('select * from trips where id=?',req.params.id);if(!t)E(404,'No such trip');inScope(req.u,t.route_id);if(t.status!='Completed')E(409,'Complete the trip before settlement review');
 if(cfg('payout_gate',t.route_id,'manager_completion')!='manager_completion')E(409,'This route uses the onboard-confirmation payout gate');
 run('update trips set settlement_confirmed_by=?,settlement_confirmed_at=? where id=?',req.u.id,now(),t.id);
 const bookings=q("select booking_id from assignments where trip_id=? and status in('Boarded','Completed') and onboard_confirmed=1",t.id),payouts=[];
 for(const b of bookings){const p=await releaseDriverPayout(b.booking_id,'manager_completion');if(p)payouts.push(p.status)}
 audit(req.u.id,'trip.settle','trip',t.id,{confirmedRiders:bookings.length,payouts:payouts.length});return{ok:1,confirmedRiders:bookings.length,payouts:payouts.length}
}));
api.post('/manager/payouts/:id/status',mgr,H(async req=>{
 const p=one('select p.*,t.route_id from driver_payouts p join trips t on t.id=p.trip_id where p.id=?',req.params.id);if(!p)E(404,'Payout not found');inScope(req.u,p.route_id);
 if(!['Pending','NeedsReview'].includes(p.status))return p;const result=await paymentProvider.getTransactionStatus({transactionId:p.transaction_id}),status=providerOutcome(result),responseStatus=String(result?.transactionstatus||result?.transactionStatus||result?.status||result?.data?.status||'').slice(0,40)||null;
 const booking=one('select b.* from bookings b where b.id=?',p.booking_id);
 db.transaction(()=>{run('update driver_payouts set status=?,response_status=?,updated_at=? where id=?',status,responseStatus,now(),p.id);if(status=='Succeeded')ledgerDriverDeductions(booking)})();
 return one('select * from driver_payouts where id=?',p.id)
}));
api.post('/manager/payouts/:id/retry',mgr,H(async req=>{
 const p=one('select p.*,t.route_id from driver_payouts p join trips t on t.id=p.trip_id where p.id=?',req.params.id);
 if(!p)E(404,'Payout not found');inScope(req.u,p.route_id);if(p.status!='Failed')E(409,'Only failed payouts can be retried');
 const retried=await releaseDriverPayout(p.booking_id,p.gate,true);if(!retried)E(409,'Payout is no longer eligible for retry');
 audit(req.u.id,'payout.retry','payout',p.id,{transactionId:retried.transaction_id});return{ id:retried.id,transactionId:retried.transaction_id,status:retried.status }
}));
function feeReceivableBalances(id){const r=one('select * from fee_receivables where id=?',id);if(!r)return null;
 const stationPaid=one("select coalesce(sum(amount_pesewas),0) n from fee_allocations where receivable_id=? and fee_kind='station'",id).n,platformPaid=one("select coalesce(sum(amount_pesewas),0) n from fee_allocations where receivable_id=? and fee_kind='platform'",id).n;
 return{...r,station_outstanding_pesewas:Math.max(0,r.station_pesewas-stationPaid),platform_outstanding_pesewas:Math.max(0,r.platform_pesewas-platformPaid),outstanding_pesewas:Math.max(0,r.station_pesewas+r.platform_pesewas-stationPaid-platformPaid)}}
function refreshFeeReceivable(id){const b=feeReceivableBalances(id);if(!b)return;
 const allocated=b.station_pesewas+b.platform_pesewas-b.outstanding_pesewas,status=b.outstanding_pesewas==0?'Settled':allocated?'PartiallyPaid':'Open';
 run('update fee_receivables set status=? where id=?',status,id);
 if(status=='Settled')for(const kind of['station','platform']){
  const amount=one("select coalesce(sum(case when kind='waiver' then -amount_pesewas else amount_pesewas end),0) n from fee_allocations where receivable_id=? and fee_kind=?",id,kind).n,rec=one('select booking_id,station_id from fee_receivables where id=?',id);
  if(amount)run("insert or ignore into fee_ledger(booking_id,station_id,source,kind,amount_pesewas,created_at) values(?,?,'cash_settlement',?,?,?)",rec.booking_id,rec.station_id,kind,amount,now())
 }}
function applyFeeAllocation({collectionId=null,receivableId,feeKind,amount,kind,reason=null,recordedBy=null,approvedBy=null}){run('insert into fee_allocations(collection_id,receivable_id,fee_kind,amount_pesewas,kind,reason,recorded_by,approved_by,created_at) values(?,?,?,?,?,?,?,?,?)',collectionId,receivableId,feeKind,amount,kind,reason,recordedBy,approvedBy,now());refreshFeeReceivable(receivableId)}
function applyFeeCollectionResult(id,result){const c=one('select * from fee_collections where id=?',id);if(!c||!['Pending','NeedsReview'].includes(c.status))return c;
 const outcome=providerOutcome(result),statusText=String(result?.transactionstatus||result?.transactionStatus||result?.status||result?.data?.status||'').slice(0,40)||null;
 db.transaction(()=>{if(outcome=='Succeeded'){
  const outstanding=feeOutstanding(c.driver_id);if(c.amount_pesewas>outstanding){run("update fee_collections set status='NeedsReview',response_status='collected amount exceeds outstanding balance',updated_at=? where id=?",now(),c.id);return}
  run("update fee_collections set status='Succeeded',response_status=?,updated_at=? where id=?",statusText,now(),c.id);
  let left=c.amount_pesewas;
  for(const r of q("select * from fee_receivables where driver_id=? and status!='Settled' order by created_at,id",c.driver_id)){
   for(const kind of['station','platform']){if(!left)break;const b=feeReceivableBalances(r.id),due=kind=='station'?b.station_outstanding_pesewas:b.platform_outstanding_pesewas,amount=Math.min(left,due);
    if(amount){applyFeeAllocation({collectionId:c.id,receivableId:r.id,feeKind:kind,amount,kind:'collection'});left-=amount}}
   if(!left)break
  }
 }else run('update fee_collections set status=?,response_status=?,updated_at=? where id=?',outcome,statusText,now(),c.id)})();
 const updated=one('select * from fee_collections where id=?',id);if(updated.status=='NeedsReview')notifyMgrs('Fee due',`Fee collection ${updated.transaction_id} needs review.`);return updated}
api.get('/drivers/me/fees',DR,H(req=>{
 const receivables=q("select r.*,b.ref,b.date from fee_receivables r join bookings b on b.id=r.booking_id where r.driver_id=? order by r.created_at desc,r.id desc",req.u.id).map(r=>feeReceivableBalances(r.id)).map(r=>({...r,ref:one('select ref from bookings where id=?',r.booking_id).ref,date:one('select date from bookings where id=?',r.booking_id).date}));
 return{receivables,outstanding_pesewas:feeOutstanding(req.u.id),collections:q('select id,transaction_id,amount_pesewas,status,response_status,created_at,updated_at from fee_collections where driver_id=? order by id desc limit 50',req.u.id)}
}));
api.post('/drivers/me/fees/pay',DR,H(async req=>{
 const raw=String(req.body.amountGhs??'');if(!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw))E(400,'amountGhs must be a positive amount with at most two decimals');
 const amount=toPesewas(raw),outstanding=feeOutstanding(req.u.id);if(amount<=0||amount>outstanding)E(400,'Amount must be positive and no greater than the outstanding balance');
 if(one("select 1 x from fee_collections where driver_id=? and status in('Pending','NeedsReview')",req.u.id))E(409,'A fee collection is already pending; check its status first');
 const d=one('select payout_partner,payout_msisdn from drivers where user_id=?',req.u.id);if(!d?.payout_partner||!d.payout_msisdn)E(409,'Set verified MoMo payout details before paying fees');
 if(!isSupportedPayPartner(feeProvider,d.payout_partner))E(400,'Saved payout network is not supported by the fee account');
 const transactionId='TF'+cr.randomBytes(12).toString('hex').toUpperCase(),created=now(),id=run("insert into fee_collections(driver_id,transaction_id,amount_pesewas,status,created_at,updated_at) values(?,?,?,'Pending',?,?)",req.u.id,transactionId,amount,created,created).lastInsertRowid;
 try{const result=await feeProvider.initiateCollection({amount:ghs(amount),transCurrencyIso:'GHS',transactionId,reference:transactionId,paypartnerCode:d.payout_partner,accountNoOrCardNoOrMSISDN:d.payout_msisdn,countryCode:feeProvider.getDefaultCountryCode?.()||'GH0233',languageId:feeProvider.getDefaultLanguage?.()||'en',callback:feeProvider.getCallbackUrl?.()||''});
  const updated=applyFeeCollectionResult(id,result);return{transactionId,status:updated.status,amountGhs:ghs(amount),message:updated.status=='Succeeded'?'Fee payment confirmed':'Approve the MoMo request, then check status.'}
 }catch(e){run("update fee_collections set status='NeedsReview',response_status='provider error',updated_at=? where id=?",now(),id);notifyMgrs('Fee due',`Fee collection ${transactionId} needs provider review.`);throw e}
}));
api.post('/drivers/me/fees/status',DR,H(async req=>{
 const c=req.body.transactionId?one('select * from fee_collections where driver_id=? and transaction_id=?',req.u.id,String(req.body.transactionId)):one("select * from fee_collections where driver_id=? and status in('Pending','NeedsReview') order by id desc limit 1",req.u.id);
 if(!c)E(404,'No pending fee collection found');if(!['Pending','NeedsReview'].includes(c.status))return c;
 const result=await feeProvider.getTransactionStatus({transactionId:c.transaction_id});return applyFeeCollectionResult(c.id,result)
}));
function inFeeScope(u,stationId){if(u.role=='admin')return;if(!STATION_STAFF.includes(u.role)||!u.station_id||u.station_id!=stationId)E(403,'Outside your station scope')}
api.get('/manager/fees',mgr,H(req=>{
 const where=STATION_STAFF.includes(req.u.role)?'where r.station_id=?':'',args=STATION_STAFF.includes(req.u.role)?[req.u.station_id]:[];
 const receivables=q(`select r.id,r.booking_id,r.driver_id,r.station_id,r.station_pesewas,r.platform_pesewas,r.status,r.created_at,r.due_at,b.ref,b.date,u.name driver from fee_receivables r join bookings b on b.id=r.booking_id join users u on u.id=r.driver_id ${where} order by r.created_at desc,r.id desc`,...args).map(r=>({...r,...feeReceivableBalances(r.id)}));
 const adjustments=q(`select x.*,r.station_id,r.booking_id,b.ref,u.name recorder from fee_adjustments x join fee_receivables r on r.id=x.receivable_id join bookings b on b.id=r.booking_id join users u on u.id=x.recorded_by ${where?'where r.station_id=?':''} order by x.id desc limit 100`,...args);
 return{receivables,adjustments}
}));
api.post('/manager/fees/receivables/:id/adjust',mgr,H(req=>{
 const r=one('select * from fee_receivables where id=?',req.params.id);if(!r)E(404,'Receivable not found');inFeeScope(req.u,r.station_id);
 const kind=String(req.body.kind||''),reason=String(req.body.reason||'').trim(),raw=String(req.body.amountGhs??'');if(!['waiver','manual_settlement'].includes(kind)||!reason||!/^(?:0|[1-9]\\d*)(?:\\.\\d{1,2})?$/.test(raw))E(400,'A valid action, amount and reason are required');
 const amount=toPesewas(raw),balance=feeReceivableBalances(r.id);if(amount<=0||amount>balance.outstanding_pesewas)E(400,'Amount must be positive and no greater than the receivable balance');
 const pending=cfg('fee_manual_needs_approval',null,0)==1,created=now(),id=db.transaction(()=>{
  const adjustmentId=run('insert into fee_adjustments(receivable_id,kind,amount_pesewas,reason,recorded_by,status,created_at,updated_at) values(?,?,?,?,?,?,?,?)',r.id,kind,amount,reason,req.u.id,pending?'Pending':'Applied',created,created).lastInsertRowid;
  if(!pending){let left=amount;for(const feeKind of['station','platform']){const b=feeReceivableBalances(r.id),due=feeKind=='station'?b.station_outstanding_pesewas:b.platform_outstanding_pesewas,take=Math.min(left,due);if(take){applyFeeAllocation({receivableId:r.id,feeKind,amount:take,kind,reason,recordedBy:req.u.id,approvedBy:req.u.id});left-=take}}}
  audit(req.u.id,pending?'fees.adjustment.request':'fees.adjustment.apply','fee_receivable',r.id,{adjustmentId,kind,amountPesewas:amount,reason});return adjustmentId
 })();
 return{id,status:pending?'Pending':'Applied'}
}));
api.post('/manager/fees/adjustments/:id/approve',mgr,H(req=>{
 const a=one('select x.*,r.station_id from fee_adjustments x join fee_receivables r on r.id=x.receivable_id where x.id=?',req.params.id);if(!a||a.status!='Pending')E(409,'Adjustment is not pending');inFeeScope(req.u,a.station_id);if(a.recorded_by==req.u.id)E(403,'A different staff member must approve this adjustment');
 db.transaction(()=>{const balance=feeReceivableBalances(a.receivable_id);if(a.amount_pesewas>balance.outstanding_pesewas)E(409,'Receivable balance changed; record a new adjustment');
  run("update fee_adjustments set status='Applied',approved_by=?,updated_at=? where id=?",req.u.id,now(),a.id);
  let left=a.amount_pesewas;for(const feeKind of['station','platform']){const b=feeReceivableBalances(a.receivable_id),due=feeKind=='station'?b.station_outstanding_pesewas:b.platform_outstanding_pesewas,take=Math.min(left,due);if(take){applyFeeAllocation({receivableId:a.receivable_id,feeKind,amount:take,kind:a.kind,reason:a.reason,recordedBy:a.recorded_by,approvedBy:req.u.id});left-=take}}
  audit(req.u.id,'fees.adjustment.approve','fee_receivable',a.receivable_id,{adjustmentId:a.id,recordedBy:a.recorded_by,kind:a.kind,amountPesewas:a.amount_pesewas,reason:a.reason})
 })();return{ok:1}
}));
api.get('/reports/fees',mgr,H(req=>{
 const[f,t]=rng(req),where=['l.created_at>=?','l.created_at<=?'],args=[f+'T00:00',t+'T99'];if(STATION_STAFF.includes(req.u.role)){where.push('l.station_id=?');args.push(req.u.station_id)}
 return rep(req,q(`select l.created_at,l.station_id,s.name station,b.ref,b.payment_method,l.source,l.kind,l.amount_pesewas from fee_ledger l join stations s on s.id=l.station_id join bookings b on b.id=l.booking_id where ${where.join(' and ')} order by l.created_at,l.id`,...args))
}));
app.use('/api/v1',api);
const bk=require('./backup'),BK=path.resolve(process.env.BACKUP_DIR||'backups'),backup=()=>bk.backup(db,BK,+process.env.BACKUP_KEEP||28);
if(require.main===module){setInterval(()=>{try{jobs();lastJob=Date.now()}catch(e){console.error(e)}},+process.env.JOB_MS||10000);
 setInterval(()=>conns.forEach(s=>s.forEach(c=>c.res.write(': ping\n\n'))),25000).unref();
 const doBackup=()=>backup().then(f=>{console.log('backup',f);if(process.env.BACKUP_PING_URL)fetch(process.env.BACKUP_PING_URL).catch(()=>{})},e=>{console.error('BACKUP FAILED',e);alertOps('backup','BACKUP FAILED: '+e.message)});setInterval(doBackup,(+process.env.BACKUP_EVERY_H||6)*36e5).unref();setTimeout(doBackup,5000).unref();setInterval(retention,864e5).unref();setTimeout(retention,9000).unref();setInterval(expiryCheck,36e5).unref();setTimeout(expiryCheck,12000).unref();setInterval(watchdog,3e5).unref();
 const srv=app.listen(process.env.PORT||3000,()=>console.log('Transport system on :'+(process.env.PORT||3000)+(PROD?'':' (DEV mode: OTP echoed, console SMS)')));
 for(const s of['SIGTERM','SIGINT'])process.on(s,()=>{srv.close(()=>{db.close();process.exit(0)});setTimeout(()=>process.exit(1),8000).unref()})}
module.exports={app,jobs,db,backup,outbox,reminders,retention,noshowRule,expiryCheck,alertOps,health};
