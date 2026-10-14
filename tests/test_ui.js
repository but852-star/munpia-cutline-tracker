/* Lightweight DOM integration check; not a browser layout/screenshot test. */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.events={};this.dataset={};this.textContent='';this.disabled=false;this.selectedIndex=0;}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=[...items];}
  setAttribute(key,value){this.attrs[key]=value;}
  addEventListener(event,callback){this.events[event]=callback;}
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function scenario(populated){
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element('div'));return elements.get(id);};
  const tabs=['today','new'].map(kind=>{const b=new Element('button');b.dataset.kind=kind;return b;});
  const entries=Object.fromEntries(Array.from({length:10},(_,i)=>{const rank=(i+1)*20;return [rank,{rank,actual_rank:rank,novel_id:String(10000+rank),title:'가상 <작품> & '+rank,views:1000-rank}];}));
  const records=[{timestamp:'2026-10-12T02:17:00+09:00',cutlines:entries}];
  const series={months:populated?{'2026-10':{file:'today/2026-10.json',dates:['2026-10-12'],count:1}}:{},latest:populated?records[0]:null,count:populated?1:0,attempt:null};
  const index={schema:1,series:{today:series,new:{months:{},latest:null,count:0,attempt:null}}};
  const context={console,Date,Map,Set,Blob,setTimeout,URL,location:{protocol:'https:'},document:{getElementById:get,createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),querySelectorAll:()=>tabs},fetch:async url=>({ok:true,json:async()=>url.endsWith('index.json')?index:records})};
  vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../site/app.js'),'utf8'),context);
  await settle();await settle();
  if(populated){
    assert.equal(get('cutlines').children.length,10);
    assert.equal(get('chart').children[0].tagName,'svg');
    assert.equal(get('time').children.length,1);
    assert.equal(get('time').disabled,false);
    assert.equal(get('calendar-heading').textContent,'2026년 10월');
    assert.equal(get('weekdays').children.length,7);
    const title=get('current-title').children[0];assert.equal(title.textContent,'가상 <작품> & 200');
    assert.equal(title.href,'https://www.munpia.com/novel/detail/10200');
    tabs[1].events.click();await settle();await settle();
    assert.equal(get('current-views').textContent,'—');
    assert.equal(get('time').disabled,true);
    assert.equal(get('export').disabled,true);
    assert.equal(get('cutlines').children.length,1);
  }else{
    assert.equal(get('time').disabled,true);
    assert.equal(get('export').disabled,true);
    assert.match(get('notice').textContent,/아직 기록이 없습니다/);
  }
}
(async()=>{await scenario(false);await scenario(true);console.log('PASS: empty state, calendar, graph, cutlines, weekdays, safe titles, and tab switching');})().catch(error=>{console.error(error);process.exitCode=1;});
