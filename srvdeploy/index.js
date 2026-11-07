/* Bags & Books table server (Cloud Function "table").
   Phones post their own bids and plays straight to the database (fast).
   When a table needs a move that isn't any phone's own (a bot, a player who timed out,
   a new deal), a phone asks this function. The function keeps every hand private,
   deals, plays the bots, and covers players who run out of time. No phone ever holds
   another player's cards, and the game keeps going if anyone's phone dies. */
const {onRequest}=require('firebase-functions/v2/https');
const admin=require('firebase-admin');
admin.initializeApp();
const db=admin.firestore();
const FV=admin.firestore.FieldValue, FP=admin.firestore.FieldPath;
const E=require('./engine');

const TURN_MS=15000, GRACE=2500, BOT_GAP=650, DEAL_MS=2600, VOTE_MS=23000;
const sleep=t=>new Promise(r=>setTimeout(r,t));
const ms=t=>t&&t.toMillis?t.toMillis():(typeof t==='number'?t:0);

exports.table=onRequest({region:'us-central1',cors:true,maxInstances:20,concurrency:80,memory:'256MiB',timeoutSeconds:20},async(req,res)=>{
  if(req.method==='GET'){res.json({ok:true,v:1});return;}
  let uid;
  try{ const tok=(req.get('Authorization')||'').replace(/^Bearer\s+/i,''); uid=(await admin.auth().verifyIdToken(tok)).uid; }
  catch(e){ res.status(401).json({err:'sign in'}); return; }
  const {code,id}=req.body||{};
  if(typeof code!=='string'||!/^[A-Z0-9]{5}$/.test(code)||typeof id!=='string'||id.length>40){res.status(400).json({err:'bad request'});return;}
  try{
    const r=id==='next'?{ok:true}:await handle(uid,code,id,{});
    /* after any move, keep playing the bots that come next, right here, until it's a real player's turn */
    if(r.ok){ for(let i=0;i<16;i++){ const n=await handle(uid,code,'next',{botOnly:true});
      if(n.wait>0&&n.bot&&n.wait<4500){ await sleep(n.wait+15); continue; }
      if(!n.ok) break; } }
    res.json(r);
  }
  catch(e){ console.error(code,id,e); res.status(500).json({err:'server'}); }
});

/* the next move this table is waiting on */
function nextOf(st){
  if(!st.H) return null;
  for(let k=1;k<=4;k++){ const a=(st.dealer+k)%4; if(st.bids[a]===undefined) return `${st.g}.${st.H}.b${a}`; }
  return st.played<52?`${st.g}.${st.H}.p${st.played}`:null;
}
async function handle(uid,code,id,opt){
  opt=opt||{};
  const tRef=db.doc(`tables/${code}`), sRef=db.doc(`srv/${code}`), ev=x=>tRef.collection('ev').doc(x);
  return db.runTransaction(async tx=>{
    /* ---- reads ---- */
    const [tS,seatsS,sS]=await Promise.all([tx.get(tRef),tx.get(tRef.collection('seats')),tx.get(sRef)]);
    if(!tS.exists) return {err:'no table'};
    const T=tS.data(); if(!T.srv||T.status!=='playing') return {err:'not live'};
    const seats=[null,null,null,null]; seatsS.forEach(d=>{const i=+d.id; if(i>=0&&i<4) seats[i]=d.data();});
    if(!seats.some(s=>s&&s.uid===uid)) return {err:'not seated'};
    const g=T.g||0, R=E.rules(T.mode,T.rules||{}), now=Date.now();
    let st=sS.exists?sS.data():null; if(!st||st.g!==g) st=E.fresh(g);

    /* catch up on bids and plays the phones posted since we last looked */
    const human=a=>!!seats[a]&&!(T.bots||[]).includes(a);
    const seen=d=>{ const x=d.data(); st.lastAt=Math.max(st.lastAt||0,ms(x.at)); if(x.by!=='srv'&&typeof x.s==='number') st.miss[x.s]=0; return x; };
    if(st.H>0){
      const need=[0,1,2,3].filter(a=>st.bids[a]===undefined);
      if(need.length){ const bs=await Promise.all(need.map(a=>tx.get(ev(`${g}.${st.H}.b${a}`))));
        bs.forEach((d,i)=>{ if(d.exists){const x=seen(d); E.applyBid(st,need[i],x.v,x.blind);} }); }
      for(let guard=0;guard<13&&st.played<52;guard++){
        const ids=[0,1,2,3].map(k=>`${g}.${st.H}.p${st.played+k}`).filter((_,k)=>st.played+k<52);
        const ps=await Promise.all(ids.map(x=>tx.get(ev(x)))); let n=0;
        for(const d of ps){ if(!d.exists) break; const x=seen(d); const err=E.applyPlay(st,R,x.s,x.c,false); if(err) console.warn(code,d.id,err); n++; }
        if(n<ids.length) break;
      }
    }
    if(id==='next'){ id=nextOf(st); if(!id) return {err:'none'}; }
    if((await tx.get(ev(id))).exists) return {done:true};
    let left=null;
    const gone=async a=>{ /* has this player left (and not come back) this game? */
      if(!left){ left={};
        const q=p=>tx.get(tRef.collection('ev').where(FP.documentId(),'>=',`${p}.${g}.`).where(FP.documentId(),'<',`${p}.${g}.\uf8ff`));
        const [L,B]=await Promise.all([q('left'),q('back')]);
        L.forEach(d=>{const x=d.data(), s=x.s; left[s]=left[s]||{l:0,b:0,bye:false,q:false}; left[s].l++; left[s].bye=!!x.bye; left[s].q=!!x.q;});
        B.forEach(d=>{const s=d.data().s; left[s]=left[s]||{l:0,b:0}; left[s].b++;}); }
      const r=left[a]; return r&&r.l>r.b?r:null; };

    /* ---- what was asked for ---- */
    let m, out={ok:true};
    const writes=[];
    const evw=(x,data)=>writes.push(()=>tx.create(ev(x),Object.assign({by:'srv',at:FV.serverTimestamp()},data)));
    const autopilot=async a=>{ /* bots go right away; a real player only after their clock ran out */
      if(!human(a)||await gone(a)) return {ok:true,bot:true,wait:Math.max(0,(st.lastAt||0)+BOT_GAP-now)};
      return {ok:true,bot:false,wait:Math.max(0,(st.lastAt||0)+TURN_MS+GRACE-now)};
    };
    const missed=a=>{ if(!human(a)) return; st.miss[a]=(st.miss[a]||0)+1;
      if(st.miss[a]>=3){ st.miss[a]=0; evw(`left.${g}.${a}.s${st.H}x${st.played}`,{s:a,q:0}); } };

    if((m=id.match(/^(\d+)\.(\d+)\.deal$/))){
      const H=+m[2]; if(+m[1]!==g||H!==st.H+1||(st.H>0&&st.played<52)) return {err:'not time to deal'};
      E.deal(st,R);
      /* players who sat down in a bot's seat during the last hand take it over now */
      const joins=(T.bots||[]).filter(a=>seats[a]&&seats[a].join&&seats[a].uid);
      if(joins.length) T.bots=T.bots.filter(a=>!joins.includes(a));
      writes.push(()=>tx.update(tRef,Object.assign({act:FV.serverTimestamp()},joins.length?{bots:T.bots}:{})));
      for(let a=0;a<4;a++){ const cards=st.hands[a].slice();
        writes.push(()=>tx.set(tRef.collection('hands').doc(`${g}-${H}-${a}`),{uid:seats[a]&&human(a)?seats[a].uid:'srv',cards})); }
      evw(id,Object.assign({s:0,d:st.dealer,dealNo:st.dealNo},joins.length?{join:joins}:{})); st.lastAt=now+DEAL_MS; /* bots wait for the deal to land on every phone */
    }
    else if((m=id.match(/^(\d+)\.(\d+)\.b(\d)$/))){
      const H=+m[2], a=+m[3]; if(+m[1]!==g||H!==st.H||st.bids[a]!==undefined) return {err:'not now'};
      const p=await autopilot(a); if(opt.botOnly&&!p.bot) return {err:'human'}; if(p.wait>0) return {wait:p.wait,bot:p.bot};
      const v=E.botBid(st,R,a,!p.bot); E.applyBid(st,a,v); if(!p.bot) missed(a);
      evw(id,{s:a,v}); st.lastAt=now;
    }
    else if((m=id.match(/^(\d+)\.(\d+)\.p(\d+)$/))){
      const H=+m[2], n=+m[3]; if(+m[1]!==g||H!==st.H||n!==st.played||st.played>=52) return {err:'not now'};
      if([0,1,2,3].some(a=>st.bids[a]===undefined)) return {err:'still bidding'};
      const a=E.turnOf(st), p=await autopilot(a); if(opt.botOnly&&!p.bot) return {err:'human'}; if(p.wait>0) return {wait:p.wait,bot:p.bot};
      const c=E.botPlay(st,R,a), err=E.applyPlay(st,R,a,c,true); if(err) return {err};
      if(!p.bot) missed(a);
      evw(id,{s:a,c}); st.lastAt=now;
    }
    else if((m=id.match(/^(\d+)\.v(\d)$/))){
      const a=+m[2]; if(+m[1]!==g) return {err:'not now'};
      st.voteAt=st.voteAt||now; const bot=!human(a)||await gone(a);
      if(!bot&&now-st.voteAt<VOTE_MS) return {wait:st.voteAt+VOTE_MS-now};
      evw(id,{s:a,v:bot?Math.random()<0.6:false});
    }
    else if((m=id.match(/^(\d+)\.q(\d)$/))){ /* dropped and never came back: mark it so the table can file the 1-star */
      const a=+m[2], r=await gone(a); if(+m[1]!==g||!human(a)||!r||r.bye) return {err:'no'};
      evw(id,{s:a,drop:1});
    }
    else return {err:'unknown'};

    /* ---- writes ---- */
    writes.forEach(w=>w());
    tx.set(sRef,st);
    return out;
  });
}
