const post=async(url,o,provider)=>{const r=await fetch(url,{...o,signal:AbortSignal.timeout(10000)}),t=await r.text();if(!r.ok)throw new Error(`${provider} ${r.status}: ${t.slice(0,150)}`);try{return JSON.parse(t)}catch{return{}}};
const norm=p=>{p=String(p).replace(/[\s-]/g,'');return p.startsWith('+')?p:p.startsWith('0')?(process.env.COUNTRY_CODE||'+233')+p.slice(1):'+'+p};
const twilioUrl=(sid,config)=>{
 const base=config.TWILIO_API_BASE_URL;
 if(!base)throw new Error('TWILIO_API_BASE_URL must be configured for SMS_PROVIDER=twilio');
 const url=new URL(base);
 if(url.protocol!=='https:')throw new Error('TWILIO_API_BASE_URL must use HTTPS');
 return new URL(`2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,`${url.toString().replace(/\/+$/,'')}/`).toString()
};
module.exports={channel:'sms',
 async sms(to,body,o={}){to=norm(to);const ch=o.channel||'sms',config=o.config||{},P=config.SMS_PROVIDER;
  if(!P)throw new Error('Tenant SMS provider is not configured');
  if(P=='twilio'){const send=async wa=>{const w=wa?'whatsapp:':'',f=new URLSearchParams({To:w+to,From:w+(wa?config.TWILIO_FROM_WA:config.TWILIO_FROM)});
    if(wa&&config.TWILIO_WA_TEMPLATE_SID){f.set('ContentSid',config.TWILIO_WA_TEMPLATE_SID);f.set('ContentVariables',JSON.stringify({1:String(o.event||'Update').replace(/\s+/g,' '),2:String(o.text||body).replace(/\s+/g,' ')}))}else f.set('Body',body);
    if(process.env.PUBLIC_URL&&config.WEBHOOK_KEY&&o.tenantId)f.set('StatusCallback',`${process.env.PUBLIC_URL}/webhooks/sms-status?tenantId=${encodeURIComponent(o.tenantId)}&key=${encodeURIComponent(config.WEBHOOK_KEY)}`);
    const sid=config.TWILIO_SID,token=config.TWILIO_TOKEN,from=wa?config.TWILIO_FROM_WA:config.TWILIO_FROM;
    if(!sid||!token||!from)throw new Error('TWILIO_SID, TWILIO_TOKEN, and the matching TWILIO_FROM value must be configured');
    return(await post(twilioUrl(sid,config),{method:'POST',headers:{Authorization:'Basic '+Buffer.from(sid+':'+token).toString('base64')},body:f},P)).sid};
   try{return{id:await send(ch=='whatsapp'),channel:ch}}catch(e){if(ch=='whatsapp'&&config.TWILIO_FROM)return{id:await send(false),channel:'sms',fallback:true};throw e}}
  if(P=='http'){if(!config.SMS_URL)throw new Error('SMS_URL must be configured for SMS_PROVIDER=http');const j=await post(config.SMS_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:config.SMS_AUTH||''},body:JSON.stringify({to,from:config.SMS_FROM,message:body})},P);return{id:j.id||j.messageId||null,channel:'sms'}}
  throw new Error('Unknown SMS_PROVIDER')}};
