/* generated from bags-and-books.html <script id="logic"> by build_server.py; do not edit */

/* ===== Pure game logic (no DOM) ===== */
const SUITS=['S','H','C','D'];
const SYM={S:'♠',H:'♥',C:'♣',D:'♦'};
const RL={11:'J',12:'Q',13:'K',14:'A'};
const NAMES=['You','Dre','Nae','Big Ray'];
let opts={target:500,jokers:false,deuce:false,bags:true,nil:true,timer:true,mode:'classic',blind:true,teamBid:true};
let G=null;

/* modes: classic & jjdd are partnerships; ffa is every player for themself */
const partnersOn=()=>opts.mode!=='ffa';
const jjdd=()=>opts.mode==='jjdd';
const teamCount=()=>partnersOn()?2:4;
const teamOf=p=>partnersOn()?p%2:p;
const members=t=>partnersOn()?[t,t+2]:[t];
const partnerOf=p=>partnersOn()?(p+2)%4:-1;
const jokersOn=()=>jjdd()||opts.jokers;

const dsuit=c=>c.ds||c.s;               // the suit printed on the card
function isRed(c){return c.joker? c.joker==='big' : (dsuit(c)==='H'||dsuit(c)==='D');}
function rankLabel(c){return c.joker? '★' : (RL[c.r]||String(c.r));}
function power(c){
  if(c.s!=='S') return c.r;
  if(c.joker) return c.joker==='big'?116:115;
  if(c.ds==='D') return 114.7;          // JJDD: 2♦ plays as a spade, under the jokers
  if((jjdd()||opts.deuce) && c.r===2) return 114.5;
  return 100+c.r;
}
function makeDeck(){
  const d=[];
  for(const s of SUITS) for(let r=2;r<=14;r++){
    if(jjdd()){
      if(r===2&&(s==='H'||s==='C')) continue;
      if(r===2&&s==='D'){d.push({s:'S',ds:'D',r:2,id:'D2'});continue;}
    } else if(opts.jokers && r===2 && (s==='H'||s==='D')) continue;
    d.push({s,r,id:s+r});
  }
  if(jokersOn()){d.push({s:'S',r:16,id:'BJ',joker:'big'});d.push({s:'S',r:15,id:'LJ',joker:'little'});}
  return d;
}
function hierarchy(){
  const top=[];
  if(jokersOn()) top.push('Big Joker','Little Joker');
  if(jjdd()) top.push('2♦','2♠');
  else if(opts.deuce) top.push('2♠');
  top.push('A♠','K♠','Q♠');
  return top.join(' › ')+' …';
}
/* fair shuffle: the phone's secure random generator (the kind used for encryption), no bias, no "house" logic */
function rndInt(n){try{const u=new Uint32Array(1), lim=Math.floor(4294967296/n)*n; let x; do{crypto.getRandomValues(u); x=u[0];}while(x>=lim); return x%n;}catch(e){return Math.floor(Math.random()*n);}}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=rndInt(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
function dealCode(order){let h=2166136261; for(const ch of order.join(',')){h^=ch.charCodeAt(0); h=Math.imul(h,16777619)>>>0;} const x=h.toString(16).toUpperCase().padStart(8,'0'); return x.slice(0,4)+'-'+x.slice(4);}
const SORT_ORDER={D:0,C:1,H:2,S:3};
function sortHand(h){return h.sort((a,b)=>SORT_ORDER[a.s]-SORT_ORDER[b.s]||power(a)-power(b));}

function newGameState(){
  const n=teamCount();
  return {scores:Array(n).fill(0),bags:Array(n).fill(0),dealer:3,handNo:0,deck:[],hands:[[],[],[],[]],bids:[null,null,null,null],
    tricks:[0,0,0,0],trick:[],leader:0,turn:0,phase:'idle',broken:false,played:new Set(),lastTrick:null,over:false};
}
function dealHand(){
  G.deck=makeDeck(); const d=shuffle(G.deck.slice());
  G.hands=[[],[],[],[]];
  d.forEach((c,i)=>G.hands[(G.dealer+1+i)%4].push(c));
  G.hands.forEach(sortHand);
  G.dealNo=dealCode(d.map(c=>c.id)); G.start=G.hands.map(h=>h.slice());
  G.bids=[null,null,null,null]; G.tricks=[0,0,0,0]; G.trick=[]; G.broken=false; G.played=new Set(); G.lastTrick=null;
  G.blind=[false,false,false,false]; G.hideHand=false; G.teamBid=null;
  G.handNo++; renReset(); realButtons();
}
/* ===== Real Spades: no coach, no tracker, any card can be played. Reneges are allowed;
   get caught and your team loses 100 and its books for the hand. A wrong call costs the caller's team 50. ===== */
const realOn=()=>!!opts.real;
function realButtons(){ const r=realOn(); $('#bRen').hidden=!r; $('#bHint').hidden=r; $('#bTrack').hidden=r; document.body.classList.toggle('realsp',r); }
const SUIT_N={S:'spades',H:'hearts',C:'clubs',D:'diamonds'}, SUIT_I={S:'♠',H:'♥',C:'♣',D:'♦'};
/* penalties per hand, kept by hand number so a replay can't mix hands up; team indexes are this phone's view */
function renOf(H){ G.renH=G.renH||{}; return G.renH[H]||(G.renH[H]={ok:[],bad:[]}); }
function renReset(){ G.ren=[]; G.showOut=[{},{},{},{}]; G.renCalls=0; G.renCalled=new Set(); }
/* note who didn't follow suit, and whether it was a renege (they still had that suit) */
function renTrack(p,c){
  if(!realOn()||!G.trick.length) return null;
  if(!G.ren) renReset();
  const led=G.trick[0].c.s, book=G.tricks.reduce((a,b)=>a+b,0)+1, so=G.showOut[p];
  let evident=null;
  if(so[c.s]!==undefined&&c.s!==led) evident={p,b:so[c.s],u:c.s};      /* played a suit they showed out of before */
  else if(c.s===led&&so[led]!==undefined) evident={p,b:so[led],u:led};
  if(c.s!==led){ if(so[led]===undefined) so[led]=book;
    const had=G.hands[p].some(x=>x.id!==c.id&&x.s===led&&x.s!=='?');
    if(had) G.ren.push({p,b:book,u:led,called:false}); }
  return evident;
}
function legal(p){
  const h=G.hands[p];
  if(!G.trick.length){
    if(!G.broken && h.some(c=>c.s!=='S')) return h.filter(c=>c.s!=='S');
    return h.slice();
  }
  const led=G.trick[0].c.s, f=h.filter(c=>c.s===led);
  return f.length? f : h.slice();
}
function eff(c,led){return c.s==='S'? power(c) : (c.s===led? c.r : 0);}
function curWin(){
  const led=G.trick[0].c.s; let bi=0,be=-1;
  G.trick.forEach((t,i)=>{const e=eff(t.c,led); if(e>be){be=e;bi=i;}});
  return {i:bi,p:G.trick[bi].p,e:be,led};
}
function unseen(p){const mine=new Set(G.hands[p].map(c=>c.id));return G.deck.filter(c=>!G.played.has(c.id)&&!mine.has(c.id));}
function isBoss(c,p){const u=unseen(p);return !u.some(x=>x.s===c.s&&power(x)>power(c));}
function teamNeed(t){
  let contract=0,books=0;
  members(t).forEach(p=>{books+=G.tricks[p]; if(G.bids[p]) contract+=G.bids[p];});
  return contract-books;
}
function evalHand(h){
  const sp=h.filter(c=>c.s==='S'), n=sp.length; let t=0;
  const allSp=makeDeck().filter(c=>c.s==='S');
  sp.forEach(c=>{
    const above=allSp.filter(x=>power(x)>power(c)&&!sp.some(y=>y.id===x.id)).length; // higher spades held by others
    if(above===0) t+=1;
    else if(above===1) t+= n>=2?0.8:0.25;
    else if(above===2) t+= n>=3?0.5:0.1;
    else if(above===3) t+= n>=4?0.25:0;
  });
  if(n>4) t+=(n-4)*0.75;
  for(const s of ['H','C','D']){
    const cs=h.filter(c=>c.s===s), L=cs.length, has=r=>cs.some(c=>c.r===r);
    if(has(14)) t+= L<=5?0.95:0.6;
    if(has(13)) t+= (L>=2&&L<=5)?(has(14)?0.8:0.55):(L===1?0.15:0.3);
    if(has(12)&&L>=3&&L<=4&&(has(14)||has(13))) t+=0.25;
    if(L===0&&n>=2) t+=Math.min(n-1,2)*0.6;
    else if(L===1&&n>=3) t+=0.45;
    else if(L===2&&n>=4) t+=0.2;
  }
  return t;
}
function suggestBid(p){
  const h=G.hands[p], t=evalHand(h);
  const hiSp=h.some(c=>c.s==='S'&&power(c)>=112), nSp=h.filter(c=>c.s==='S').length;
  const aces=h.filter(c=>c.r===14).length;
  const partner=partnerOf(p), pNil=partner>=0&&G.bids[partner]===0;
  if(opts.nil && !pNil && t<1.3 && !hiSp && nSp<=3 && aces===0) return 0;
  let b=Math.max(1,Math.round(t*1.1));
  if(pNil) b=Math.min(13,b+1);
  return Math.min(13,b);
}
function botChoose(p){
  const L=legal(p), partner=partnerOf(p), t=teamOf(p);
  const nilMe=G.bids[p]===0&&G.tricks[p]===0;
  const pNil=partner>=0&&G.bids[partner]===0&&G.tricks[partner]===0;
  const opps=[0,1,2,3].filter(o=>o!==p&&o!==partner);
  const oNil=opps.filter(o=>G.bids[o]===0&&G.tricks[o]===0);
  let need=teamNeed(t);
  const oppNeed=partnersOn()?teamNeed(1-t):Math.max(...opps.map(o=>teamNeed(o))), left=G.hands[p].length;
  if(need<=0 && oppNeed>0 && left<=oppNeed+1) need=1; // go for the set
  const byPow=(a,b)=>power(a)-power(b);
  const low=arr=>arr.slice().sort(byPow)[0];
  const high=arr=>arr.slice().sort(byPow).pop();
  const nonSp=arr=>arr.filter(c=>c.s!=='S');
  if(!G.trick.length){
    if(nilMe) return low(L);
    const bosses=L.filter(c=>isBoss(c,p));
    if(pNil) return bosses.length? high(bosses) : high(nonSp(L).length?nonSp(L):L);
    if(oNil.length) return low(L);
    if(need>0){
      const nb=nonSp(bosses); if(nb.length) return high(nb);
      const sb=bosses.filter(c=>c.s==='S'), mySp=G.hands[p].filter(c=>c.s==='S').length;
      if(sb.length&&mySp>=3) return high(sb);
      const side=nonSp(L);
      if(side.length){const cnt=s=>G.hands[p].filter(c=>c.s===s).length; side.sort((a,b)=>cnt(a.s)-cnt(b.s)||a.r-b.r); return side[0];}
      return low(L);
    }
    return low(L);
  }
  const cw=curWin(), led=cw.led;
  const winners=L.filter(c=>eff(c,led)>cw.e), losers=L.filter(c=>eff(c,led)<=cw.e);
  const byEff=(a,b)=>eff(a,led)-eff(b,led);
  const lowW=()=>winners.slice().sort(byEff)[0];
  const highL=()=>losers.slice().sort(byPow).pop();
  const last=G.trick.length===3;
  const partnerPlayed=partner>=0&&G.trick.some(x=>x.p===partner), partnerWinning=partner>=0&&cw.p===partner;
  if(nilMe) return losers.length? highL() : high(winners);
  if(pNil){
    if(partnerPlayed){ if(partnerWinning) return winners.length? lowW() : low(L); return losers.length? low(losers) : lowW(); }
    return winners.length? winners.slice().sort(byEff).pop() : low(L);
  }
  if(oNil.includes(cw.p)) return losers.length? highL() : lowW();
  if(partnerWinning){
    const safe=last||isBoss(G.trick[cw.i].c,p);
    if(safe||need<=0) return losers.length? low(losers) : lowW();
    const bw=winners.filter(c=>isBoss(c,p)); if(bw.length) return bw.sort(byEff)[0];
    return losers.length? low(losers) : lowW();
  }
  if(need<=0) return losers.length? highL() : lowW();
  if(winners.length){
    if(last) return lowW();
    const bw=winners.filter(c=>isBoss(c,p)); if(bw.length) return bw.sort(byEff)[0];
    if(winners.some(c=>c.s==='S'&&led!=='S')) return lowW();
    if(G.trick.length===1&&losers.length) return low(losers);
    return lowW();
  }
  return low(losers.length?losers:L);
}
function scoreTeam(t){
  const ps=members(t); let pts=0,contract=0,books=0; const notes=[];
  const rp=renOf(G.handNo), caught=rp.ok.filter(x=>x===t).length, wrong=rp.bad.filter(x=>x===t).length;
  const tb=G.teamBid&&G.teamBid[t]!=null?G.teamBid[t]:null;
  ps.forEach(p=>{books+=G.tricks[p];
    if(G.bids[p]===0){ const bl=G.blind&&G.blind[p], v=bl?200:100, kind=bl?'blind nil':'nil';
      if(G.tricks[p]===0){pts+=v;notes.push(`${NAMES[p]} made ${kind}  +${v}`);} else {pts-=v;notes.push(`${NAMES[p]}'s ${kind} got busted  −${v}`);} }
    else contract+=G.bids[p];
  });
  if(tb!=null) contract=tb;
  if(caught){ books=0; pts-=100*caught; notes.push(`Renege caught  −${100*caught} and the books`); }
  if(wrong){ pts-=50*wrong; notes.push(`Wrong renege call  −${50*wrong}`); }
  let bagsAdd=0, set=false;
  if(contract>0){
    if(books>=contract){pts+=contract*10; bagsAdd=books-contract; pts+=bagsAdd;}
    else {pts-=contract*10; set=true;}
  } else {bagsAdd=books; pts+=books;}
  let bags=G.bags[t]+bagsAdd, penalty=false;
  if(opts.bags&&bags>=10){pts-=100;bags-=10;penalty=true;}
  if(books===13) notes.push('Boston — all 13 books');
  return {contract,books,pts,bagsAdd,bags,set,penalty,notes};
}
/* blind nil: allowed when your side trails the leader by 100+ */
function blindEligible(p){
  return !!(opts.blind&&opts.nil&&G.blindOK);
}
function behindBy(p){const t=teamOf(p);return Math.max(...G.scores.filter((_,i)=>i!==t))-G.scores[t];}
/* game over: someone hits the target or falls to the floor, with a clear leader */
function gameOverCheck(target,floor){
  const s=G.scores, mx=Math.max(...s), lead=s.filter(x=>x===mx).length===1;
  if((s.some(x=>x>=target)||s.some(x=>x<=floor))&&lead) return {over:true,winner:s.indexOf(mx)};
  return {over:false,winner:-1};
}
