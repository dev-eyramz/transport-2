const S='shell-v9',A='api-v2',C='cdn';
addEventListener('install',e=>e.waitUntil(caches.open(S).then(c=>c.addAll(['/','/manifest.json','/icon.svg','/vendor/bootstrap.min.css','/app-base.css','/app.css','/app.js','/terms.css'])).then(()=>skipWaiting())));
addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>![S,A,C].includes(x)).map(x=>caches.delete(x)))).then(()=>clients.claim())));
addEventListener('message',e=>{if(e.data=='clear')caches.delete(A)});
const nf=(r,name,fb)=>fetch(r).then(x=>{if(x.ok){const c=x.clone();caches.open(name).then(k=>k.put(r,c)).catch(err=>console.warn('Cache write failed',err))}return x}).catch(()=>caches.match(r).then(m=>m||fb));
addEventListener('fetch',e=>{const r=e.request,u=new URL(r.url);if(!['http:','https:'].includes(u.protocol)||r.method!='GET'||u.pathname.endsWith('/events')||u.pathname.includes('/auth/')||/^\/api\/v1\/(?:admin\/fees|manager\/fees|drivers\/me\/fees|reports\/fees|quote)(?:\/|$)/.test(u.pathname))return;
 if(u.origin!=location.origin){e.respondWith(caches.match(r).then(m=>m||nf(r,C)));return} // CDN CSS: cache-first
 if(u.pathname.startsWith('/api/'))e.respondWith(nf(r,A,new Response('{"error":"offline"}',{status:503,headers:{'Content-Type':'application/json'}})));
 else e.respondWith(nf(r,S))});
