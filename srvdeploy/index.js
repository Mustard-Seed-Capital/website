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
const crypto=require('crypto');

const TURN_MS=15000, GRACE=2500, BOT_GAP=650, DEAL_MS=2600, VOTE_MS=23000;
const sleep=t=>new Promise(r=>setTimeout(r,t));
const ms=t=>t&&t.toMillis?t.toMillis():(typeof t==='number'?t:0);

exports.table=onRequest({region:'us-central1',cors:true,maxInstances:20,concurrency:80,memory:'256MiB',timeoutSeconds:20},async(req,res)=>{
  if(req.method==='GET'){res.json({ok:true,v:1});return;}
  let uid;
  try{ const tok=(req.get('Authorization')||'').replace(/^Bearer\s+/i,''); uid=(await admin.auth().verifyIdToken(tok)).uid; }
  catch(e){ res.status(401).json({err:'sign in'}); return; }
  const b=req.body||{};
  if(b.act==='tour'){ try{ res.json(await tourAct(uid,b)); }catch(e){ console.error('tour',e); res.status(500).json({err:'server'}); } return; }
  if(b.act==='pin'){ try{ res.json(await pinAct(uid,b)); }catch(e){ console.error('pin',e); res.status(500).json({err:'server'}); } return; }
  const {code,id,mv,call}=b;
  if(typeof code!=='string'||!/^[A-Z0-9]{5}$/.test(code)||typeof id!=='string'||id.length>40){res.status(400).json({err:'bad request'});return;}
  try{
    const r=id==='next'?{ok:true}:await handle(uid,code,id,mv&&typeof mv==='object'?{mv}:call&&typeof call==='object'?{call}:{});
    /* after any move, keep playing the bots that come next, right here, until it's a real player's turn */
    if(r.ok){ for(let i=0;i<16;i++){ const n=await handle(uid,code,'next',{botOnly:true});
      if(n.wait>0&&n.bot&&n.wait<4500){ await sleep(n.wait+15); continue; }
      if(!n.ok) break; } }
    res.json(r);
  }
  catch(e){ console.error(code,id,e); res.status(500).json({err:'server'}); }
});

/* ---- weekend tournament: Friday 12:00 AM to Sunday 11:59 PM Eastern ----
   wk/{week}_{tier} holds the pot; wk/{week}_{tier}/e/{uid} each player's games. Only this server writes them.
   Your best 10 games count. Pot = every buy-in; the house keeps 10%; paid out after Sunday night. */
const TIERS={open:1000,t10:10000,t25:25000,t50:50000,t100:100000,t250:250000};
const WIN_PTS=200, LOSS_PTS=75, BONUS=25, BONUS_CAP=100, BEST=10;
function etDate(ms){
  const o={}; new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',hourCycle:'h23'})
    .formatToParts(new Date(ms)).forEach(x=>o[x.type]=x.value);
  return {date:`${o.year}-${o.month}-${o.day}`,dow:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(o.weekday),h:+o.hour};
}
const addDays=(d,n)=>{const t=new Date(d+'T12:00:00Z'); t.setUTCDate(t.getUTCDate()+n); return t.toISOString().slice(0,10);};
function weekNow(ms){ const e=etDate(ms); return e.dow===5?e.date:e.dow===6?addDays(e.date,-1):e.dow===0?addDays(e.date,-2):null; }
const payable=(week,ms)=>etDate(ms-2*3600e3).date>addDays(week,2);           /* Sunday is over, plus 2 hours for games still finishing */
const recordable=(week,ms)=>weekNow(ms)===week||!payable(week,ms)&&etDate(ms).date<=addDays(week,3);
const best=games=>games.map(x=>x.p).sort((a,b)=>b-a).slice(0,BEST).reduce((a,b)=>a+b,0);
function payPlan(n,pot){
  const prize=Math.floor(pot*0.9);
  if(n>=10) return [30,18,12,6,6,3.6,3.6,3.6,3.6,3.6].map(x=>Math.floor(prize*x/90));
  if(n===1) return [pot];                                                  /* nobody to play against: full refund */
  const pc=[50,30,20].slice(0,n), tot=pc.reduce((a,b)=>a+b,0); return pc.map(x=>Math.floor(prize*x/tot));
}
async function tourAct(uid,b){
  const now=Date.now();
  if(b.op==='join'){
    const tier=b.tier, buy=TIERS[tier], week=weekNow(now); if(!buy) return {err:'tier'}; if(!week) return {err:'closed'};
    const name=String(b.n||'Player').replace(/[^A-Za-z0-9_ ]/g,'').slice(0,14)||'Player';
    const wRef=db.doc(`wk/${week}_${tier}`), eRef=wRef.collection('e').doc(uid);
    return db.runTransaction(async tx=>{
      const [w,e]=await Promise.all([tx.get(wRef),tx.get(eRef)]);
      if(e.exists) return {err:'already',week};
      tx.set(wRef,{week,tier,buy,pot:(w.exists?w.data().pot:0)+buy,n:(w.exists?w.data().n:0)+1,status:'open'},{merge:true});
      tx.set(eRef,{uid,n:name,pts:0,games:[],at:FV.serverTimestamp()});
      return {ok:true,week};
    });
  }
  if(b.op==='pay'){
    const week=String(b.week||''), tier=b.tier; if(!/^\d{4}-\d{2}-\d{2}$/.test(week)||!TIERS[tier]) return {err:'bad'};
    if(!payable(week,now)) return {err:'not yet'};
    const wRef=db.doc(`wk/${week}_${tier}`);
    return db.runTransaction(async tx=>{
      const w=await tx.get(wRef); if(!w.exists) return {err:'none'}; const W=w.data(); if(W.status==='paid') return {ok:true,paid:true,results:W.results||[]};
      const es=await tx.get(wRef.collection('e')); const list=[]; es.forEach(d=>list.push(d.data()));
      list.sort((x,y)=>(y.pts||0)-(x.pts||0)||(x.games||[]).length-(y.games||[]).length);
      const plan=payPlan(list.length,W.pot||0), results=[];
      list.forEach((x,i)=>{ const c=plan[i]||0; results.push({uid:x.uid,n:x.n,pts:x.pts||0,place:i+1,coins:c});
        if(c>0) tx.set(db.doc(`users/${x.uid}/inbox/wk_${week}_${tier}`),{coins:c,place:i+1,tier,week,pts:x.pts||0,at:FV.serverTimestamp()}); });
      tx.update(wRef,{status:'paid',results:results.slice(0,25),paidAt:FV.serverTimestamp()});
      return {ok:true,paid:true,results:results.slice(0,25)};
    });
  }
  return {err:'unknown'};
}

/* ---- username PINs: get your player back on a new phone or browser ----
   pins/{uid} holds a salted hash, never the PIN. No phone can read that collection.
   5 wrong tries locks the name for 15 minutes; 10 locks it for a day. */
const pinHash=(pin,salt)=>crypto.scryptSync(String(pin),salt,32).toString('hex');
const PIN_RX=/^\d{4}$/, NAME_RX=/^[a-z0-9_]{3,14}$/;
async function pinAct(uid,b){
  if(b.op==='set'){
    if(!PIN_RX.test(b.pin||'')) return {err:'bad pin'};
    const salt=crypto.randomBytes(16).toString('hex');
    await db.doc(`pins/${uid}`).set({salt,h:pinHash(b.pin,salt),fails:0,lock:0,at:FV.serverTimestamp()});
    return {ok:true};
  }
  if(b.op==='has'){ /* does this player (or the owner of this name) have a PIN? */
    let owner=uid;
    if(b.n!==undefined){ const n=String(b.n).toLowerCase(); if(!NAME_RX.test(n)) return {has:false};
      const nm=await db.doc(`names/${n}`).get(); if(!nm.exists) return {has:false}; owner=nm.data().uid; }
    return {has:(await db.doc(`pins/${owner}`).get()).exists};
  }
  if(b.op==='claim'){
    const n=String(b.n||'').toLowerCase(); if(!NAME_RX.test(n)||!PIN_RX.test(b.pin||'')) return {err:'bad'};
    const r=await db.runTransaction(async tx=>{
      const nm=await tx.get(db.doc(`names/${n}`)); if(!nm.exists) return {err:'no name'};
      const owner=nm.data().uid; if(owner===uid) return {ok:true,same:true};
      const pr=db.doc(`pins/${owner}`), p=await tx.get(pr); if(!p.exists) return {err:'no pin'};
      const d=p.data(), now=Date.now();
      if((d.lock||0)>now) return {err:'locked',wait:d.lock-now};
      if(pinHash(b.pin,d.salt)!==d.h){ const f=(d.fails||0)+1, lock=f%5===0?now+(f>=10?864e5:15*60e3):0;
        tx.update(pr,{fails:f,lock}); return lock?{err:'locked',wait:lock-now}:{err:'wrong',left:5-f%5}; }
      tx.update(pr,{fails:0,lock:0}); return {ok:true,owner};
    });
    if(r.ok&&r.owner){ r.token=await admin.auth().createCustomToken(r.owner); delete r.owner; }
    return r;
  }
  return {err:'unknown'};
}

/* the next move this table is waiting on */
/* bidding order: normally around the table from the dealer's left; with team bidding
   both players on the dealer's left team call first, then the dealer's team (same as the app) */
function nextOf(st,R,T){
  if(!st.H) return null;
  const team=!!(T&&T.rules&&T.rules.teamBid&&R&&R.partnersOn());
  for(const k of team?[1,3,2,0]:[1,2,3,0]){ const a=(st.dealer+k)%4; if(st.bids[a]===undefined) return `${st.g}.${st.H}.b${a}`; }
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

    const writes=[];
    const evw=(x,data)=>writes.push(()=>tx.create(ev(x),Object.assign({by:'srv',at:FV.serverTimestamp()},data)));
    const realT=!!(T.rules&&T.rules.real), evq=[];
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
        for(const d of ps){ if(!d.exists) break; const x=seen(d);
          if(realT){ const e=E.renTrack(st,R,x.s,x.c); if(e) evq.push(e); }
          const err=E.applyPlay(st,R,x.s,x.c,false); if(err) console.warn(code,d.id,err); n++; }
        if(n<ids.length) break;
      }
    }
    let left=null;
    const gone=async a=>{ /* has this player left (and not come back) this game? */
      if(!left){ left={};
        const q=p=>tx.get(tRef.collection('ev').where(FP.documentId(),'>=',`${p}.${g}.`).where(FP.documentId(),'<',`${p}.${g}.\uf8ff`));
        const [L,B]=await Promise.all([q('left'),q('back')]);
        L.forEach(d=>{const x=d.data(), s=x.s; left[s]=left[s]||{l:0,b:0,bye:false,q:false}; left[s].l++; left[s].bye=!!x.bye; left[s].q=!!x.q;});
        B.forEach(d=>{const s=d.data().s; left[s]=left[s]||{l:0,b:0}; left[s].b++;}); }
      const r=left[a]; return r&&r.l>r.b?r:null; };
    st.tb=st.tb||{};
    /* Real Spades: a bot calls a renege once the table can prove it; anyone who got away with one confesses at the end of the hand */
    const teamOf=a=>T.mode==='ffa'?a:a%2, isBot=a=>!seats[a]||(T.bots||[]).includes(a);
    let realDirty=false;
    if(realT&&st.H>0){
      evq.forEach(e=>{ const r=(st.ren||[]).find(x=>x.a===e.a&&x.b===e.b&&x.u===e.u&&!x.called); if(!r) return;
        const callers=[0,1,2,3].filter(q=>q!==e.a&&teamOf(q)!==teamOf(e.a)&&isBot(q)); if(!callers.length) return;
        const hsh=(st.H*131+e.b*17+e.a*7+e.u.charCodeAt(0))%100; if(hsh>=75) return;
        r.called=true; evw(`${g}.${st.H}.rc${st.rcN||0}`,{s:callers[hsh%callers.length],t:e.a,b:e.b,u:e.u,ok:true,bot:true}); st.rcN=(st.rcN||0)+1; realDirty=true;
        (st.renH=st.renH||{ok:[],bad:[]}).ok.push(teamOf(e.a)); const tt=st.tb[e.a]=st.tb[e.a]||{}; tt.caught=(tt.caught||0)+1; });
      if(st.played===52&&!st.cf){ st.cf=true; realDirty=true;
        const sneaks=(st.ren||[]).filter(x=>!x.called); sneaks.forEach(x=>{ const tb=st.tb[x.a]=st.tb[x.a]||{}; tb.sneak=(tb.sneak||0)+1; });
        evw(`${g}.${st.H}.cf`,{s:0,list:sneaks.map(x=>({a:x.a,b:x.b,u:x.u}))}); }
    }
    /* every online table: the server keeps the score itself, tracks each player's hand stats,
       and when the game ends writes the profile stats (and tournament points) nobody can fake */
    const tour=T.rules&&T.rules.tier&&TIERS[T.rules.tier]?T.rules:null;
    if(st.H>0&&st.played===52&&!st.scored){
      st.scored=true; realDirty=true;
      [0,1,2,3].forEach(a=>{ if(st.bids[a]===0&&st.tricks[a]===0){ const tb=st.tb[a]=st.tb[a]||{}; tb.nil=(tb.nil||0)+1; } });
      const go=E.scoreHand(st,R,T);
      st.ps=st.ps||{};
      [0,1,2,3].forEach(a=>{ const P=st.ps[a]=st.ps[a]||{h:0,nt:0,nm:0,bt:0,bm:0,ex:0,bd:0,bk:0,set:0,bg:0};
        const bid=st.bids[a], tr=st.tricks[a]||0, x=go.res[teamOf(a)]||{};
        P.h++; P.bk+=tr; P.set+=x.set?1:0; P.bg+=x.bagsAdd||0;
        if(bid===0){ if(st.blind[a]){P.bt++; if(!tr)P.bm++;} else {P.nt++; if(!tr)P.nm++;} }
        else if(typeof bid==='number'){ P.bd++; if(tr===bid) P.ex++; } });
      if(go.over&&!st.over){ st.over=true;
        const bucket=tour?'tour':realT?'real':T.mode==='ffa'?'solo':'partners';
        const hs=[0,1,2,3].filter(a=>human(a)), refs=hs.map(a=>db.doc(`stats/${seats[a].uid}`));
        const sd=await Promise.all(refs.map(r=>tx.get(r))), goneS={};
        for(const a of hs) goneS[a]=!!(await gone(a));
        hs.forEach((a,i)=>{ const S=sd[i].exists?sd[i].data():{}, B=Object.assign({g:0,w:0,q:0,h:0,nt:0,nm:0,bt:0,bm:0,ex:0,bd:0,bk:0,set:0,bg:0,cur:0,best:0,last:'',cr:0,wr:0,sn:0,ct:0,p:{},f:{}},S[bucket]||{});
          const won=teamOf(a)===go.winner, P=st.ps[a]||{}, tb=st.tb[a]||{};
          B.g++; if(won)B.w++; if(goneS[a])B.q++;
          ['h','nt','nm','bt','bm','ex','bd','bk','set','bg'].forEach(k=>B[k]+=P[k]||0);
          B.cr+=tb.call||0; B.wr+=tb.wrong||0; B.sn+=tb.sneak||0; B.ct+=tb.caught||0;
          B.cur=won?Math.max(1,B.cur+1):Math.min(-1,B.cur-1); B.best=Math.max(B.best,B.cur);
          B.last=((won?'W':'L')+(B.last||'')).slice(0,10);
          const mate=T.mode!=='ffa'?(a+2)%4:-1;
          if(mate>=0&&human(mate)){ const u=seats[mate].uid, o=B.p[u]||{n:'',g:0,w:0}; o.n=String(seats[mate].name||'').slice(0,14); o.g++; if(won)o.w++; B.p[u]=o; }
          [0,1,2,3].filter(q=>q!==a&&q!==mate&&human(q)).forEach(q=>{ const u=seats[q].uid, o=B.f[u]||{n:'',g:0,l:0}; o.n=String(seats[q].name||'').slice(0,14); o.g++; if(!won)o.l++; B.f[u]=o; });
          const trim=m=>Object.fromEntries(Object.entries(m).sort((x,y)=>y[1].g-x[1].g).slice(0,25)); B.p=trim(B.p); B.f=trim(B.f);
          writes.push(()=>tx.set(refs[i],{n:String(seats[a].name||'').slice(0,14),at:FV.serverTimestamp(),[bucket]:B},{merge:true})); });
      }
      if(tour&&go.over&&recordable(tour.wk,now)&&!st.tourDone){ st.tourDone=true;
        st.over=true;
        const players=[];
        for(const a of [0,1,2,3]) if(human(a)&&!(await gone(a))) players.push(a);
        const refs=players.map(a=>db.doc(`wk/${tour.wk}_${tour.tier}/e/${seats[a].uid}`));
        const docs=await Promise.all(refs.map(r=>tx.get(r))), list=[];
        players.forEach((a,i)=>{ if(!docs[i].exists) return; const E0=docs[i].data(), tb=st.tb[a]||{};
          const won=teamOf(a)===go.winner, bonus=Math.min(BONUS_CAP,BONUS*((tb.nil||0)+(tb.call||0)+(tb.sneak||0))), p=(won?WIN_PTS:LOSS_PTS)+bonus;
          const games=(E0.games||[]).concat({p,w:won?1:0,c:code}).slice(-40);
          writes.push(()=>tx.update(refs[i],{games,pts:best(games)})); list.push({a,p,won,bonus}); });
        if(list.length) evw(`${g}.tp`,{s:0,list});
      }
    }
    const fin=x=>{ if(realDirty){ writes.forEach(w=>w()); tx.set(sRef,st); } return x; };
    if(id==='next'){ id=nextOf(st,R,T); if(!id){ if(!realDirty) tx.set(sRef,st); return fin({err:'none'}); } }
    if((await tx.get(ev(id))).exists) return fin({done:true});

    /* ---- what was asked for ---- */
    let m, out={ok:true};
    const autopilot=async a=>{ /* bots go right away; a real player only after their clock ran out */
      if(!human(a)||await gone(a)) return {ok:true,bot:true,wait:Math.max(0,(st.lastAt||0)+BOT_GAP-now)};
      return {ok:true,bot:false,wait:Math.max(0,(st.lastAt||0)+TURN_MS+GRACE-now)};
    };
    const missed=a=>{ if(!human(a)) return; st.miss[a]=(st.miss[a]||0)+1;
      if(st.miss[a]>=3){ st.miss[a]=0; evw(`left.${g}.${a}.s${st.H}x${st.played}`,{s:a,q:0}); } };

    if((m=id.match(/^(\d+)\.(\d+)\.deal$/))){
      const H=+m[2]; if(+m[1]!==g||H!==st.H+1||(st.H>0&&st.played<52)) return fin({err:'not time to deal'});
      E.deal(st,R);
      /* players who sat down in a bot's seat during the last hand take it over now */
      const joins=(T.bots||[]).filter(a=>seats[a]&&seats[a].join&&seats[a].uid);
      if(joins.length) T.bots=T.bots.filter(a=>!joins.includes(a));
      writes.push(()=>tx.update(tRef,Object.assign({act:FV.serverTimestamp()},joins.length?{bots:T.bots}:{})));
      for(let a=0;a<4;a++){ const cards=st.hands[a].slice();
        writes.push(()=>tx.set(tRef.collection('hands').doc(`${g}-${H}-${a}`),{uid:seats[a]&&human(a)?seats[a].uid:'srv',cards})); }
      evw(id,Object.assign({s:0,d:st.dealer,dealNo:st.dealNo},joins.length?{join:joins}:{})); st.lastAt=now+DEAL_MS; /* bots wait for the deal to land on every phone */
    }
    else if(opt.call&&(m=id.match(/^(\d+)\.(\d+)\.rc$/))){
      const c=opt.call, a=[0,1,2,3].find(q=>seats[q]&&seats[q].uid===uid&&!(T.bots||[]).includes(q));
      if(!realT||a===undefined||+m[1]!==g||+m[2]!==st.H) return fin({err:'no'});
      if(st.played>=52) return fin({err:'late'});
      const t=c.t, bk=c.b, u=c.u;
      if(![0,1,2,3].includes(t)||t===a||teamOf(t)===teamOf(a)||!Number.isInteger(bk)||bk<1||bk>Math.floor(st.played/4)+1||!'SHCD'.includes(u)||u.length!==1) return fin({err:'bad call'});
      st.calls=st.calls||{}; if((st.calls[a]||0)>=2) return fin({err:'limit'}); st.calls[a]=(st.calls[a]||0)+1;
      const r=(st.ren||[]).find(x=>x.a===t&&x.b===bk&&x.u===u&&!x.called); if(r) r.called=true;
      evw(`${g}.${st.H}.rc${st.rcN||0}`,{s:a,t,b:bk,u,ok:!!r}); st.rcN=(st.rcN||0)+1;
      st.renH=st.renH||{ok:[],bad:[]};
      if(r){ st.renH.ok.push(teamOf(t)); const tb=st.tb[a]=st.tb[a]||{}; tb.call=(tb.call||0)+1; const tt=st.tb[t]=st.tb[t]||{}; tt.caught=(tt.caught||0)+1; }
      else { st.renH.bad.push(teamOf(a)); const tb=st.tb[a]=st.tb[a]||{}; tb.wrong=(tb.wrong||0)+1; }
      out.result=!!r;
    }
    else if(opt.mv&&(m=id.match(/^(\d+)\.(\d+)\.(b|p)(\d+)$/))){
      /* a phone whose database connection is stuck hands us its own move; check it like any other */
      const x=opt.mv, a=x.s, H=+m[2];
      if(+m[1]!==g||H!==st.H||![0,1,2,3].includes(a)||!seats[a]||seats[a].uid!==uid||!human(a)) return fin({err:'not yours'});
      if(m[3]==='b'){ const v=x.v; if(+m[4]!==a||st.bids[a]!==undefined||!Number.isInteger(v)||v<0||v>13) return fin({err:'not now'});
        E.applyBid(st,a,v,!!x.blind); evw(id,Object.assign({s:a,v,by:uid},x.blind?{blind:true}:{})); }
      else { if(+m[4]!==st.played||E.turnOf(st)!==a||typeof x.c!=='string') return fin({err:'not now'});
        if(realT){ const e=E.renTrack(st,R,a,x.c); if(e) evq.push(e); } const err=E.applyPlay(st,R,a,x.c,!realT); if(err) return fin({err}); evw(id,{s:a,c:x.c,by:uid}); }
      st.miss[a]=0; st.lastAt=now;
    }
    else if((m=id.match(/^(\d+)\.(\d+)\.b(\d)$/))){
      const H=+m[2], a=+m[3]; if(+m[1]!==g||H!==st.H||st.bids[a]!==undefined) return fin({err:'not now'});
      if(nextOf(st,R,T)!==id) return fin({err:'not now'}); /* bids go around the table in order */
      const p=await autopilot(a); if(opt.botOnly&&!p.bot) return fin({err:'human'}); if(p.wait>0) return fin({wait:p.wait,bot:p.bot});
      const v=E.botBid(st,R,a,!p.bot); E.applyBid(st,a,v); if(!p.bot) missed(a);
      evw(id,{s:a,v}); st.lastAt=now;
    }
    else if((m=id.match(/^(\d+)\.(\d+)\.p(\d+)$/))){
      const H=+m[2], n=+m[3]; if(+m[1]!==g||H!==st.H||n!==st.played||st.played>=52) return fin({err:'not now'});
      if([0,1,2,3].some(a=>st.bids[a]===undefined)) return fin({err:'still bidding'});
      const a=E.turnOf(st), p=await autopilot(a); if(opt.botOnly&&!p.bot) return fin({err:'human'}); if(p.wait>0) return fin({wait:p.wait,bot:p.bot});
      const c=E.botPlay(st,R,a), err=E.applyPlay(st,R,a,c,true); if(err) return fin({err});
      if(!p.bot) missed(a);
      evw(id,{s:a,c}); st.lastAt=now;
    }
    else if((m=id.match(/^(\d+)\.v(\d)$/))){
      const a=+m[2]; if(+m[1]!==g) return fin({err:'not now'});
      st.voteAt=st.voteAt||now; const bot=!human(a)||await gone(a);
      if(!bot&&now-st.voteAt<VOTE_MS) return fin({wait:st.voteAt+VOTE_MS-now});
      evw(id,{s:a,v:bot?Math.random()<0.6:false});
    }
    else if((m=id.match(/^(\d+)\.q(\d)$/))){ /* dropped and never came back: mark it so the table can file the 1-star */
      const a=+m[2], r=await gone(a); if(+m[1]!==g||!human(a)||!r||r.bye) return fin({err:'no'});
      evw(id,{s:a,drop:1});
    }
    else return fin({err:'unknown'});

    /* ---- writes ---- */
    writes.forEach(w=>w());
    tx.set(sRef,st);
    return out;
  });
}
