// Messaging gateway. Console delivery is reserved for tests.
const provider=()=>process.env.SMS_PROVIDER||'console';
const post=async(url,o)=>{const r=await fetch(url,{...o,signal:AbortSignal.timeout(10000)}),t=await r.text();if(!r.ok)throw new Error(`${provider()} ${r.status}: ${t.slice(0,150)}`);try{return JSON.parse(t)}catch{return{}}};
const norm=p=>{p=String(p).replace(/[\s-]/g,'');return p.startsWith('+')?p:p.startsWith('0')?(process.env.COUNTRY_CODE||'+233')+p.slice(1):'+'+p};
const twilioUrl=sid=>{
 const base=process.env.TWILIO_API_BASE_URL;
 if(!base)throw new Error('TWILIO_API_BASE_URL must be configured for SMS_PROVIDER=twilio');
 const url=new URL(base);
 if(url.protocol!=='https:')throw new Error('TWILIO_API_BASE_URL must use HTTPS');
 return new URL(`2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,`${url.toString().replace(/\/+$/,'')}/`).toString()
};
module.exports={get provider(){return provider()},channel:'sms',get waEnabled(){return !!process.env.TWILIO_FROM_WA},set waEnabled(value){if(value)process.env.TWILIO_FROM_WA=process.env.TWILIO_FROM_WA||'configured';else delete process.env.TWILIO_FROM_WA},
 // opts: {channel:'sms'|'whatsapp', event, text}. WhatsApp business-initiated messages need an approved template (TWILIO_WA_TEMPLATE_SID, 2 variables); falls back to SMS on failure.
 async sms(to,body,o={}){to=norm(to);const ch=o.channel||'sms';
  const P=provider();
  if(P=='console'){if(process.env.NODE_ENV!=='test')throw new Error('SMS_PROVIDER=console is only allowed in tests');console.log(`[${ch.toUpperCase()}->${to}] ${body}`);return{id:null,channel:ch}}
  if(P=='twilio'){const send=async wa=>{const w=wa?'whatsapp:':'',f=new URLSearchParams({To:w+to,From:w+(wa?process.env.TWILIO_FROM_WA:process.env.TWILIO_FROM)});
    if(wa&&process.env.TWILIO_WA_TEMPLATE_SID){f.set('ContentSid',process.env.TWILIO_WA_TEMPLATE_SID);f.set('ContentVariables',JSON.stringify({1:String(o.event||'Update').replace(/\s+/g,' '),2:String(o.text||body).replace(/\s+/g,' ')}))}else f.set('Body',body);
    if(process.env.PUBLIC_URL&&process.env.WEBHOOK_KEY)f.set('StatusCallback',`${process.env.PUBLIC_URL}/webhooks/sms-status?key=${process.env.WEBHOOK_KEY}`);
    const sid=process.env.TWILIO_SID,token=process.env.TWILIO_TOKEN,from=wa?process.env.TWILIO_FROM_WA:process.env.TWILIO_FROM;
    if(!sid||!token||!from)throw new Error('TWILIO_SID, TWILIO_TOKEN, and the matching TWILIO_FROM value must be configured');
    return(await post(twilioUrl(sid),{method:'POST',headers:{Authorization:'Basic '+Buffer.from(sid+':'+token).toString('base64')},body:f})).sid};
   try{return{id:await send(ch=='whatsapp'),channel:ch}}catch(e){if(ch=='whatsapp'&&process.env.TWILIO_FROM)return{id:await send(false),channel:'sms',fallback:true};throw e}}
  if(P=='http'){const j=await post(process.env.SMS_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:process.env.SMS_AUTH||''},body:JSON.stringify({to,from:process.env.SMS_FROM,message:body})});return{id:j.id||j.messageId||null,channel:'sms'}}
  throw new Error('Unknown SMS_PROVIDER')}};
