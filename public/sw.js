const CACHE='sana-ishraq-v7-netlify-impact';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon-180.png','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('sana-ishraq-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{const req=event.request;const reqUrl=new URL(req.url);if(req.method!=='GET'||reqUrl.origin!==self.location.origin||reqUrl.pathname.startsWith('/.netlify/functions/'))return;
if(req.mode==='navigate'){event.respondWith(fetch(req).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(c=>c.put('./index.html',copy));}return response;}).catch(()=>caches.match('./index.html')));return;}
event.respondWith(caches.match(req).then(cached=>cached||fetch(req).then(response=>{if(response.ok)caches.open(CACHE).then(c=>c.put(req,response.clone()));return response;})));});
