// Read-only look at the newest tables: who's seated, each phone's speed report, and move timings.
const P='https://firestore.googleapis.com/v1/projects/bags-and-books/databases/(default)/documents';
const H={Authorization:'Bearer '+process.env.TK,'Content-Type':'application/json'};
const val=v=>v==null?null:'stringValue' in v?v.stringValue:'integerValue' in v?+v.integerValue:'doubleValue' in v?v.doubleValue:'booleanValue' in v?v.booleanValue:'timestampValue' in v?Date.parse(v.timestampValue):'mapValue' in v?obj(v.mapValue.fields||{}):'arrayValue' in v?(v.arrayValue.values||[]).map(val):null;
const obj=f=>Object.fromEntries(Object.entries(f).map(([k,v])=>[k,val(v)]));
const q=async(parent,sq)=>(await (await fetch(`${P}${parent}:runQuery`,{method:'POST',headers:H,body:JSON.stringify({structuredQuery:sq})})).json()).filter(x=>x.document).map(x=>({id:x.document.name.split('/').pop(),...obj(x.document.fields||{})}));
(async()=>{
  const ts=await q('',{from:[{collectionId:'tables'}],orderBy:[{field:{fieldPath:'created'},direction:'DESCENDING'}],limit:6});
  ts.forEach(t=>console.log('TABLE',t.id,t.status,t.mode,'srv='+!!t.srv,'pub='+!!t.pub,'bots='+JSON.stringify(t.bots),new Date(t.created).toLocaleTimeString('en-US',{timeZone:'America/New_York'})));
  const code=process.argv[2]||(ts.find(t=>t.status==='playing'&&!t.pub)||{}).id; if(!code) return console.log('no live crew table');
  const seats=await q(`/tables/${code}`,{from:[{collectionId:'seats'}]});
  const name={}; seats.forEach(s=>{name[s.uid]=s.name+'@'+s.id; console.log('SEAT',s.id,s.name,s.uid.slice(0,6));});
  const ev=await q(`/tables/${code}`,{from:[{collectionId:'ev'}],limit:600});
  ev.filter(e=>e.id.startsWith('lag.')).forEach(e=>console.log('LAG',e.id,'app='+e.app,'net='+e.net,'up',JSON.stringify(e.up),'dn',JSON.stringify(e.dn)));
  const mv=ev.filter(e=>/\.(deal|b\d|p\d+)$/.test(e.id)).sort((a,b)=>a.at-b.at).slice(-40);
  let prev=0; mv.forEach(e=>{console.log('EV',e.id.padEnd(9),(e.by==='srv'?'server':name[e.by]||e.by.slice(0,6)).padEnd(12),'+'+(prev?e.at-prev:0)+'ms',e.ms!=null?'ping='+e.ms:''); prev=e.at;});
})();
