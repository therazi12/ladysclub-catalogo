// Lady's Club · backend de pedidos (Cloudflare Worker + D1 + R2 opcional)
// Variables/secretos: ADMIN_PASSWORD (obligatoria), TG_TOKEN + TG_CHAT (Telegram),
// RESEND_KEY + NOTIFY_EMAILS ("a@x.com,b@y.com") + MAIL_FROM (correo).
const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const clean=(v,n)=>String(v??'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,n);
const num=v=>{v=Number(v);return Number.isFinite(v)?Math.round(v*100)/100:0};
const esc=t=>String(t).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

export default {
 async fetch(req,env,ctx){
  const u=new URL(req.url),p=u.pathname;
  try{
   if(p==='/api/order'&&req.method==='POST')return order(req,env,ctx);
   if(p.startsWith('/api/admin/'))return admin(req,env,u,p);
  }catch(e){return J({ok:false,error:'server'},500)}
  return env.ASSETS.fetch(req);
 }
};

async function order(req,env,ctx){
 if(+req.headers.get('content-length')>3e6)return J({ok:false,error:'too_big'},413);
 const o=await req.json();
 const name=clean(o.name,80),ci=clean(o.ci,10),tel=clean(o.tel,10),email=clean(o.email,120),
  prov=clean(o.prov,40),city=clean(o.city,60),addr=clean(o.addr,200);
 if(name.length<5||!/^\d{10}$/.test(ci)||!/^09\d{8}$/.test(tel)||!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)||!prov||city.length<3||addr.length<8)
  return J({ok:false,error:'invalid'},400);
 const items=(Array.isArray(o.items)?o.items:[]).slice(0,20).map(i=>({id:clean(i.id,40),name:clean(i.name,80),q:Math.min(5,Math.max(1,num(i.q))),price:num(i.price),state:i.state==='pre'?'pre':'in'}));
 if(!items.length)return J({ok:false,error:'empty'},400);
 const code='LC-'+String(crypto.getRandomValues(new Uint32Array(1))[0]%1e6).padStart(6,'0');
 let proofKey=null,proofB64=null;
 if(typeof o.proof==='string'&&o.proof.startsWith('data:image/')&&o.proof.length<2.5e6){
  const b64=o.proof.split(',')[1]||'';
  if(env.BUCKET){proofKey='proofs/'+code+'.jpg';const bin=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));await env.BUCKET.put(proofKey,bin,{httpMetadata:{contentType:'image/jpeg'}})}
  else proofB64=b64;
 }
 const row={code,at:new Date().toISOString(),name,ci,tel,email,prov,city,addr,items:JSON.stringify(items),sub:num(o.sub),ship:num(o.ship),now:num(o.now),later:num(o.later)};
 await env.DB.prepare(`INSERT INTO orders(code,created_at,name,ci,tel,email,prov,city,addr,items,sub,ship,pay_now,pay_later,method,proof_key,proof_b64) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .bind(row.code,row.at,name,ci,tel,email,prov,city,addr,row.items,row.sub,row.ship,row.now,row.later,'transferencia',proofKey,proofB64).run();
 ctx.waitUntil(notify(env,row,items,!!(proofKey||proofB64)));
 return J({ok:true,code});
}

async function notify(env,r,items,hasProof){
 const lines=items.map(i=>`• ${i.q} × ${i.name}${i.state==='pre'?' (reserva)':''}`).join('\n');
 const txt=`🛍 Pedido nuevo ${r.code}\n${lines}\n\n${r.name} · ${r.tel}\n${r.prov}, ${r.city}\nPaga ahora: $${r.now.toFixed(2)}${hasProof?'\n📎 Con comprobante':'\n(sin comprobante)'}`;
 const jobs=[];
 if(env.TG_TOKEN&&env.TG_CHAT)jobs.push(fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:env.TG_CHAT,text:txt})}));
 if(env.RESEND_KEY&&env.NOTIFY_EMAILS)jobs.push(fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_KEY,'Content-Type':'application/json'},
  body:JSON.stringify({from:env.MAIL_FROM||'Ladys Club <onboarding@resend.dev>',to:env.NOTIFY_EMAILS.split(',').map(s=>s.trim()).filter(Boolean),subject:'Pedido nuevo '+r.code,html:'<pre style="font:15px sans-serif">'+esc(txt)+'</pre>'})}));
 await Promise.allSettled(jobs);
}

function authed(req,env){
 const t=(req.headers.get('authorization')||'').replace(/^Bearer /,'');
 const w=env.ADMIN_PASSWORD||'';
 if(!w||t.length!==w.length)return false;
 let d=0;for(let i=0;i<w.length;i++)d|=t.charCodeAt(i)^w.charCodeAt(i);
 return d===0;
}

async function admin(req,env,u,p){
 if(!authed(req,env))return J({ok:false,error:'auth'},401);
 if(p==='/api/admin/orders'&&req.method==='GET'){
  const {results}=await env.DB.prepare(`SELECT code,created_at,status,name,ci,tel,email,prov,city,addr,items,sub,ship,pay_now,pay_later,tracking,note,(proof_key IS NOT NULL OR proof_b64 IS NOT NULL) AS has_proof FROM orders ORDER BY created_at DESC LIMIT 300`).all();
  return J({ok:true,orders:results});
 }
 if(p==='/api/admin/status'&&req.method==='POST'){
  const b=await req.json();
  if(!['nuevo','pagado','enviado','cancelado'].includes(b.status))return J({ok:false},400);
  await env.DB.prepare('UPDATE orders SET status=?,tracking=COALESCE(?,tracking),note=COALESCE(?,note) WHERE code=?')
   .bind(b.status,b.tracking?clean(b.tracking,60):null,b.note?clean(b.note,300):null,clean(b.code,12)).run();
  return J({ok:true});
 }
 if(p.startsWith('/api/admin/proof/')){
  const code=clean(p.split('/').pop(),12);
  const r=await env.DB.prepare('SELECT proof_key,proof_b64 FROM orders WHERE code=?').bind(code).first();
  if(!r)return J({ok:false},404);
  let body=null;
  if(r.proof_key&&env.BUCKET){const o=await env.BUCKET.get(r.proof_key);body=o&&o.body}
  else if(r.proof_b64)body=Uint8Array.from(atob(r.proof_b64),c=>c.charCodeAt(0));
  if(!body)return J({ok:false},404);
  return new Response(body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'no-store'}});
 }
 return J({ok:false},404);
}
