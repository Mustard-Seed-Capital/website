/* Bags & Books table server: the game rules, run on the server.
   Uses the exact same rules code as the app (logic.js is copied out of the game file),
   so the server and every phone always agree. Pure functions, no database here. */
const vm=require('vm'), fs=require('fs'), path=require('path');
const LOGIC=fs.readFileSync(path.join(__dirname,'logic.js'),'utf8');

/* a fresh copy of the rules for one table (mode + house rules) */
function rules(mode,r){
  const ctx={crypto:globalThis.crypto,Math,Uint32Array,Set,Array,Object,JSON,String,Number,console};
  vm.createContext(ctx);
  vm.runInContext(LOGIC+`
;this.__api={setOpts(o){opts=Object.assign({},opts,o);},getG(){return G;},setG(v){G=v;},
  makeDeck,shuffle,sortHand,legal,curWin,suggestBid,botChoose,power,dealCode,partnersOn,scoreTeam,gameOverCheck,teamCount};`,ctx);
  const api=ctx.__api;
  api.setOpts(Object.assign({},r||{},{mode}));
  return api;
}

/* the server's private copy of a table: every hand, the trick, the bids */
function fresh(g){return {g,H:0,dealer:3,hands:{},bids:{},trick:[],played:0,leader:0,tricks:[0,0,0,0],broken:false,miss:{},lastAt:0,blind:{},sc:null,bags:null,tb:{},over:false};}

function deal(st,R){
  const H=st.H+1, dealer=(H+2)%4; /* hand 1 is dealt by seat 3, then it moves left */
  const deck=R.makeDeck(), d=R.shuffle(deck.slice()), hands={0:[],1:[],2:[],3:[]};
  d.forEach((c,i)=>hands[(dealer+1+i)%4].push(c.id));
  Object.assign(st,{H,dealer,hands,bids:{},trick:[],played:0,leader:(dealer+1)%4,tricks:[0,0,0,0],broken:false,blind:{},playedIds:[],dealNo:R.dealCode(d.map(c=>c.id)),
    out:{},ren:[],rcN:0,calls:{},cf:false,renH:{ok:[],bad:[]},scored:false});
  return st;
}
const turnOf=st=>(st.leader+st.trick.length)%4;

/* rebuild the in-memory game the rules code expects */
function toG(st,R){
  const deck=R.makeDeck(), byId=Object.fromEntries(deck.map(c=>[c.id,c]));
  const G={deck,hands:[0,1,2,3].map(a=>R.sortHand((st.hands[a]||[]).map(id=>byId[id]).filter(Boolean))),
    bids:[0,1,2,3].map(a=>st.bids[a]===undefined?null:st.bids[a]),tricks:st.tricks.slice(),trick:st.trick.map(t=>({p:t.p,c:byId[t.c]})),
    leader:st.leader,turn:turnOf(st),broken:st.broken,played:new Set(st.playedIds||[]),phase:'play',blind:[0,1,2,3].map(a=>!!st.blind[a])};
  R.setG(G); return {G,byId};
}

/* apply a card someone played; returns an error string if it isn't allowed */
function applyPlay(st,R,a,cid,strict){
  if(st.played>=52) return 'hand is over';
  if(turnOf(st)!==a) return 'not your turn';
  const h=st.hands[a]||[]; if(!h.includes(cid)) return 'not in hand';
  if(strict){ const {G}=toG(st,R); if(!R.legal(a).some(c=>c.id===cid)) return 'must follow suit'; }
  st.hands[a]=h.filter(x=>x!==cid); st.trick.push({p:a,c:cid}); st.played++;
  st.playedIds=(st.playedIds||[]).concat(cid);
  { const {byId}=toG(st,R); if(byId[cid]&&byId[cid].s==='S') st.broken=true; }
  if(st.trick.length===4){ const {G}=toG(st,R); const w=R.curWin().p; st.tricks[w]++; st.leader=w; st.trick=[]; }
  return '';
}
/* Real Spades: before a card is applied, note a renege (didn't follow suit while holding it)
   and whether this play proves an earlier one (they showed out of a suit, then played it) */
function renTrack(st,R,a,cid){
  if(!st.trick.length) return null;
  const {byId}=toG(st,R), lead=byId[st.trick[0].c], c=byId[cid]; if(!lead||!c) return null;
  const led=lead.s, book=Math.floor(st.played/4)+1;
  st.out=st.out||{}; const so=st.out[a]=st.out[a]||{}; st.ren=st.ren||[];
  let evident=null;
  if(c.s!==led&&so[c.s]!==undefined) evident={a,b:so[c.s],u:c.s};
  else if(c.s===led&&so[led]!==undefined) evident={a,b:so[led],u:led};
  if(c.s!==led){ if(so[led]===undefined) so[led]=book;
    if((st.hands[a]||[]).some(id=>id!==cid&&byId[id]&&byId[id].s===led)) st.ren.push({a,b:book,u:led,called:false}); }
  return evident;
}
/* score a finished hand with the app's own scoring code; returns the game-over check too */
function scoreHand(st,R,T){
  const G=toG(st,R).G, n=R.teamCount();
  if(!st.sc){ st.sc=Array(n).fill(0); st.bags=Array(n).fill(0); }
  Object.assign(G,{scores:st.sc.slice(),bags:st.bags.slice(),tricks:st.tricks.slice(),bids:[0,1,2,3].map(a=>st.bids[a]===undefined?null:st.bids[a]),
    blind:[0,1,2,3].map(a=>!!st.blind[a]),teamBid:null,handNo:st.H,renH:{[st.H]:st.renH||{ok:[],bad:[]}}});
  const res=[]; for(let t=0;t<n;t++){ const x=R.scoreTeam(t); res.push(x); st.sc[t]+=x.pts; st.bags[t]=x.bags; }
  R.setG(Object.assign(G,{scores:st.sc.slice()}));
  const go=R.gameOverCheck(T.target||300,(T.target||300)===100?-100:-200);
  go.res=res; return go;
}
function applyBid(st,a,v,blind){ if(st.bids[a]!==undefined) return 'already bid'; st.bids[a]=v; if(blind) st.blind[a]=true; return ''; }

/* what a bot (or the autopilot for someone who timed out) does */
function botBid(st,R,a,human){ toG(st,R); const v=R.suggestBid(a); return human?Math.max(1,v):v; }
function botPlay(st,R,a){ toG(st,R); return R.botChoose(a).id; }

module.exports={rules,fresh,deal,turnOf,applyPlay,applyBid,botBid,botPlay,toG,renTrack,scoreHand};
