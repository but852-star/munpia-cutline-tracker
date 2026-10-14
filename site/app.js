/* Independently implemented UI and chart; no external libraries. */
(() => {
  'use strict';
  const pad = n => String(n).padStart(2, '0');
  const kstParts = timestamp => {
    const date = new Date(new Date(timestamp).getTime() + 9 * 3600000);
    return {day: `${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())}`,
      hour: date.getUTCHours(), minute: date.getUTCMinutes(), weekday: date.getUTCDay()};
  };
  const hourSeries = records => {
    const hours = Array(24).fill(null);
    [...records].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)).forEach(record => {
      const entry = record.cutlines['200'];
      if (entry && Number.isFinite(entry.views)) hours[kstParts(record.timestamp).hour] = record;
    });
    return hours;
  };
  const weekdayStats = (records, end) => {
    const start = new Date(end).getTime() - 7*86400000;
    const buckets = Array.from({length:7},()=>Array.from({length:24},()=>[]));
    records.forEach(record => {
      const instant = new Date(record.timestamp).getTime(), entry = record.cutlines['200'];
      if (instant < start || instant > new Date(end).getTime() || !entry || !Number.isFinite(entry.views)) return;
      const p = kstParts(record.timestamp); buckets[p.weekday][p.hour].push(entry.views);
    });
    return buckets.map(hours => {
      const observed = hours.map((values,hour)=>values.length?{hour,average:values.reduce((a,b)=>a+b,0)/values.length,count:values.length}:null).filter(Boolean);
      observed.sort((a,b)=>a.average-b.average||a.hour-b.hour);
      return {low:observed[0]||null, high:observed.length?[...observed].sort((a,b)=>b.average-a.average||a.hour-b.hour)[0]:null};
    });
  };
  globalThis.CutlineStats = {kstParts,hourSeries,weekdayStats};
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const number = n => Math.round(n).toLocaleString('ko-KR');
  const format = t => new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false});
  const state = {kind:'today',index:null,day:null,month:null,records:[],token:0,kindVersion:0,cache:new Map()};
  const node = (tag, text, className) => {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
  const message = (text, severity='') => {$('notice').textContent=text;$('notice').className='notice '+severity;};
  const empty = (target, text) => target.replaceChildren(node('div',text,'empty'));
  const link = entry => {
    if (!entry || !/^\d+$/.test(String(entry.novel_id))) return node('span',entry?.title||'작품명 없음');
    const a=node('a',entry.title);a.href='https://www.munpia.com/novel/detail/'+entry.novel_id;a.target='_blank';a.rel='noopener noreferrer';return a;
  };

  async function file(key) {
    if (state.cache.has(key)) return state.cache.get(key);
    const promise = (async()=>{
      if (location.protocol==='file:') {
        if (!globalThis.MUNPIA_FILES?.[key]) await new Promise((resolve,reject)=>{
          const script=document.createElement('script');script.src='data/'+key.replace(/\.json$/,'.js');script.onload=resolve;script.onerror=()=>reject(Error('오프라인 파일을 찾지 못했습니다. build.py로 만든 dist/index.html을 열어 주세요.'));document.head.append(script);
        });
        const result=globalThis.MUNPIA_FILES?.[key];if (!result) throw Error('기록 파일을 읽지 못했습니다.');return result;
      }
      const base=state.dataBase||'data/';
      const response=await fetch(base+key,{cache:'no-store'});
      if (!response.ok) throw Error('기록을 불러오지 못했습니다 ('+response.status+').');
      return response.json();
    })();
    state.cache.set(key,promise);
    try{return await promise;}catch(error){state.cache.delete(key);throw error;}
  }

  function renderCurrent(series) {
    const latest=series.latest, entry=latest?.cutlines['200'];
    $('current-count').textContent=series.count?number(series.count)+'개 시각 기록':'—';
    $('current-views').textContent=entry?number(entry.views)+'회':'—';
    $('current-title').replaceChildren();
    $('current-time').textContent=latest?format(latest.timestamp):'아직 수집된 기록이 없습니다.';
    if(entry){$('current-title').append(link(entry));if(entry.actual_rank!==200)$('current-title').append(node('span',entry.actual_rank+'위로 대체된 기록','substitute'));}
    if(state.remoteFailed)message('자동 수집 기록에 연결하지 못했습니다. 사이트에 보관된 마지막 기록을 표시합니다.','warning');
    else if(series.attempt && !series.attempt.ok)message('최근 수집 실패 · 기존 기록을 표시합니다. '+(series.attempt.message||''),'warning');
    else if(!latest)message('아직 기록이 없습니다. 수집을 시작하면 달력과 그래프가 채워집니다.','');
    else if(Date.now()-new Date(latest.timestamp).getTime()>3*3600000)message('마지막 수집 이후 3시간 이상 지났습니다. 자동 수집 상태를 확인해 주세요.','warning');
    else if(globalThis.CUTLINE_CONFIG?.automaticCollection)message('약 1시간 간격으로 수집한 기록입니다. 마지막 성공 시각을 확인하세요.');
    else message('첫 수집을 완료했습니다. GitHub 자동 수집 연결은 아직 대기 중입니다.');
  }

  function renderCalendar(series) {
    const [year,month]=state.month.split('-').map(Number);
    $('calendar-heading').textContent=year+'년 '+month+'월';
    const calendar=$('calendar');calendar.replaceChildren();
    ['일','월','화','수','목','금','토'].forEach(name=>calendar.append(node('div',name,'weekday-label')));
    const first=new Date(Date.UTC(year,month-1,1)).getUTCDay(),length=new Date(Date.UTC(year,month,0)).getUTCDate();
    const available=new Set(series.months[state.month]?.dates||[]);
    for(let i=0;i<first;i++)calendar.append(node('div','','blank'));
    for(let d=1;d<=length;d++){
      const key=state.month+'-'+pad(d),b=node('button',d,'date'+(available.has(key)?' has-record':''));
      b.disabled=!available.has(key);b.setAttribute('aria-label',key+(available.has(key)?' 기록 보기':' 기록 없음'));b.setAttribute('aria-pressed',String(state.day===key));
      b.addEventListener('click',()=>chooseDay(key));calendar.append(b);
    }
  }

  function svgNode(tag,attrs={},text) {const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value]of Object.entries(attrs))n.setAttribute(key,String(value));if(text!==undefined)n.textContent=text;return n;}
  function renderChart() {
    const hours=hourSeries(state.records),values=hours.filter(Boolean).map(r=>r.cutlines['200'].views);
    $('chart-heading').textContent=(state.day||'날짜 미선택')+' · 시간별 200위';
    $('day-summary').textContent=values.length?'관측 '+values.length+'/24시간 · 평균 '+number(values.reduce((a,b)=>a+b,0)/values.length)+'회 · 최저 '+number(Math.min(...values))+'회 · 최고 '+number(Math.max(...values))+'회':'';
    if(!values.length){empty($('chart'),'이 날짜에는 수집된 기록이 없습니다.');return;}
    const width=760,height=280,left=64,right=22,top=25,bottom=42;
    const min=Math.min(...values),max=Math.max(...values),margin=Math.max(5,(max-min)*.15),lower=Math.max(0,min-margin),upper=max+margin;
    const x=h=>left+h*(width-left-right)/23,y=v=>top+(upper-v)*(height-top-bottom)/(upper-lower);
    const svg=svgNode('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':state.day+' 200위 조회수 그래프'});
    svg.append(svgNode('title',{},'기록이 없는 시간은 선이 끊어집니다. 각 점에 마우스를 올리거나 키보드로 이동하면 값을 확인할 수 있습니다.'));
    for(let i=0;i<=4;i++){const value=lower+(upper-lower)*i/4;svg.append(svgNode('line',{x1:left,y1:y(value),x2:width-right,y2:y(value),class:'grid'}));svg.append(svgNode('text',{x:left-9,y:y(value)+4,'text-anchor':'end'},number(value)));}
    for(const h of [0,3,6,9,12,15,18,21,23])svg.append(svgNode('text',{x:x(h),y:height-14,'text-anchor':'middle'},h+'시'));
    let path='',connected=false;
    hours.forEach((record,h)=>{if(!record){connected=false;return;}path+=(connected?' L':' M')+x(h)+' '+y(record.cutlines['200'].views);connected=true;});
    svg.append(svgNode('path',{d:path,class:'trace'}));
    hours.forEach((record,h)=>{if(!record)return;const e=record.cutlines['200'],label=`${h}시 ${number(e.views)}회 · ${e.title}`+(e.actual_rank===200?'':` (${e.actual_rank}위 대체)`);const point=svgNode('circle',{cx:x(h),cy:y(e.views),r:5,class:'point',tabindex:0,'aria-label':label});point.append(svgNode('title',{},label));svg.append(point);});
    $('chart').replaceChildren(svg);
  }

  function renderCutlines(record) {
    $('cutlines').replaceChildren();$('cutline-time').textContent=record?format(record.timestamp)+' 기준':'';
    if(!record){const tr=node('tr'),td=node('td','이 날짜에는 기록이 없습니다.');td.colSpan=3;tr.append(td);$('cutlines').append(tr);return;}
    for(let rank=20;rank<=200;rank+=20){const e=record.cutlines[String(rank)],tr=node('tr'),title=node('td');title.append(link(e));if(e&&e.actual_rank!==rank)title.append(node('span',e.actual_rank+'위로 대체','substitute'));tr.append(node('td',rank/20+'페이지 · '+rank+'위'),title,node('td',e?number(e.views):'—','numeric'));$('cutlines').append(tr);}
  }
  async function chooseDay(day) {
    const token=++state.token,kind=state.kind,series=state.index.series[kind];state.day=day;state.month=day.slice(0,7);renderCalendar(series);
    $('time').disabled=true;$('export').disabled=true;empty($('chart'),'기록을 불러오는 중입니다.');
    try{
      const meta=series.months[state.month],records=meta?await file(meta.file):[];
      if(token!==state.token)return;
      state.records=records.filter(r=>kstParts(r.timestamp).day===day).sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
      const select=$('time');select.replaceChildren();
      state.records.forEach((record,i)=>{const p=kstParts(record.timestamp),option=node('option',pad(p.hour)+':'+pad(p.minute)+' · '+number(record.cutlines['200'].views)+'회');option.value=i;select.append(option);});
      if(!state.records.length)select.append(node('option','기록 없음'));
      select.disabled=!state.records.length;select.selectedIndex=Math.max(0,state.records.length-1);$('export').disabled=!state.records.length;
      renderChart();renderCutlines(state.records.at(-1));
    }catch(error){if(token===state.token){state.records=[];renderChart();renderCutlines(null);message(error.message,'error');}}
  }

  async function renderWeekdays(series,token) {
    $('weekdays').replaceChildren();$('weekday-range').textContent='통계를 계산하는 중입니다.';
    const end=series.latest?.timestamp;
    if(!end){$('weekdays').replaceChildren();$('weekday-range').textContent='수집된 기록이 없습니다.';return;}
    const start=new Date(new Date(end).getTime()-7*86400000),startKey=kstParts(start.toISOString()).day;
    const endKey=kstParts(end).day;
    const needed=Object.values(series.months).filter(m=>m.dates.some(d=>d>=startKey&&d<=endKey));
    try{
      const records=(await Promise.all(needed.map(m=>file(m.file)))).flat();
      if(token!==state.kindVersion)return;
      $('weekday-range').textContent='마지막 기록까지 7일 · '+format(end)+' 기준';$('weekdays').replaceChildren();
      weekdayStats(records,end).forEach((stats,day)=>{const tr=node('tr');tr.append(node('td',['일','월','화','수','목','금','토'][day]+'요일'));for(const value of [stats.low,stats.high])tr.append(node('td',value?value.hour+'시 · 평균 '+number(value.average)+'회':'기록 없음'));$('weekdays').append(tr);});
    }catch(error){if(token===state.kindVersion){$('weekdays').replaceChildren();$('weekday-range').textContent='통계를 읽지 못했습니다. 새로고침해 주세요.';}}
  }

  async function switchKind(kind) {
    state.kind=kind;++state.token;const version=++state.kindVersion;
    document.querySelectorAll('[data-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.kind===kind)));
    const series=state.index.series[kind];renderCurrent(series);
    const day=series.latest?kstParts(series.latest.timestamp).day:kstParts(new Date().toISOString()).day;
    await Promise.all([chooseDay(day),renderWeekdays(series,version)]);
  }
  async function initialize() {
    message('기록을 확인하는 중입니다.');
    try{state.dataBase='data/';state.remoteFailed=false;
      const remote=globalThis.CUTLINE_CONFIG?.remoteDataBase;
      if(remote && location.protocol!=='file:'){
        const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
        try{const response=await fetch(remote+'index.json',{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('remote unavailable');const index=await response.json();if(index.schema!==1||!index.series?.today||!index.series?.new)throw Error('invalid remote schema');state.dataBase=remote;state.cache.set('index.json',Promise.resolve(index));}
        catch(error){state.dataBase='data/';state.remoteFailed=true;}finally{clearTimeout(timeout);}
      }
      state.index=await file('index.json');if(state.index.schema!==1||!state.index.series?.today||!state.index.series?.new)throw Error('지원하지 않는 기록 형식입니다.');await switchKind(state.kind);}
    catch(error){message(error.message,'error');empty($('chart'),'기록을 불러오지 못했습니다.');}
  }
  document.querySelectorAll('[data-kind]').forEach(b=>b.addEventListener('click',()=>{if(state.index)switchKind(b.dataset.kind);}));
  for(const [id,offset]of [['prev-month',-1],['next-month',1]])$(id).addEventListener('click',()=>{if(!state.index||!state.month)return;const[y,m]=state.month.split('-').map(Number),date=new Date(Date.UTC(y,m-1+offset,1));state.month=date.getUTCFullYear()+'-'+pad(date.getUTCMonth()+1);renderCalendar(state.index.series[state.kind]);});
  $('time').addEventListener('change',()=>renderCutlines(state.records[Number($('time').value)]));
  $('refresh').addEventListener('click',()=>{++state.token;state.cache.clear();if(location.protocol==='file:')globalThis.MUNPIA_FILES={};initialize();});
  $('export').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(state.records,null,2)],{type:'application/json'})),a=node('a');a.href=url;a.download=state.kind+'-'+state.day+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  initialize();
})();
