/* Browser regressions using Chromium's debugging protocol; no npm dependencies. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Expected counts come from the dataset the page was built from, so the checks survive data updates.
function datasetCounts() {
  const csvPath = path.resolve(__dirname, '../output/oneida_911_records.csv');
  const lines = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const split = line => {
    const out = []; let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch; }
      else if (ch === '"') quoted = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]), town = header.indexOf('town'), village = header.indexOf('village');
  const county = header.indexOf('county'), kind = header.indexOf('agency_type'), agency = header.indexOf('agency');
  const reportDate = header.indexOf('report_date');
  const categoryColumn=header.indexOf('category'),priorityColumn=header.indexOf('mpds_level'),datetimeColumn=header.indexOf('call_datetime');
  const comparison={towns:{},dates:{}};
  const surgeEvents=['2024-02-28','2024-02-29','2024-07-16','2025-06-22'];
  const surgeStats={all:{},utica:{},fire:{}};
  const surgeDateMs=iso=>Date.parse(iso+'T00:00:00Z');
  const nearSurge=iso=>surgeEvents.some(e=>iso.slice(0,4)===e.slice(0,4) && new Date(surgeDateMs(iso)).getUTCDay()===new Date(surgeDateMs(e)).getUTCDay() && Math.abs(surgeDateMs(iso)-surgeDateMs(e))<=42*86400000);
  const addComparison=(a,f)=>{a.n++;if(f[categoryColumn]==='MEDICAL'){a.medical++;if(f[priorityColumn])a.priority++;if(['D','E'].includes(f[priorityColumn]))a.de++;}a.hours[+f[hourColumn]]++;};
  const comparisonSide=()=>({n:0,medical:0,priority:0,de:0,hours:Array(24).fill(0)});
  const seasonal = {}, seasonalMonday = {};
  const discoveries = {}, localProfiles = {};
  const response = header.indexOf('response_type');
  const officerTypes = new Set(['TRAFFIC STOP','PREMISE CK','AREA CK','CITIZEN STOP','TRAFFIC DETAIL','DETAIL','WATER DETAIL',
    'TOBACCO DETAIL','PARKING SUMMONS','WARRANT','SUMMONS','VEHICLE TRAFFIC LAW']);
  const policeMonths={}, policeDates={}, policeCounts=[0,0,0];
  const medical={hours:Array.from({length:24},()=>Array(7).fill(0)),mondayHours:Array.from({length:24},()=>Array(7).fill(0)),county:[0,0]};
  const adminTypes=/^(DATA|RECORDS CHECK|BACKGROUND INV|PISTOL PERMIT|SORA\b.*|TEST|TRAINING|INTERNAL|DO NOT TAG|POLYGRAPH|PERSONNEL COMP|SUBPOENA SERVED)$/;
  const hourColumn=header.indexOf('hour');
  let total = 0, whitestown = 0, whitesboro = 0;
  const fireUnknownBy = new Map(), hasHome = new Set();
  const outsideBy = new Map();
  const population = { all: { known: 0, unknown: 0, utica: 0 }, years: {} };
  for (const line of lines.slice(1)) {
    const f = split(line); total++;
    if(['LOCAL_POLICE','SHERIFF','STATE_POLICE','CAMPUS_POLICE'].includes(f[kind]))
      policeCounts[officerTypes.has(f[response]) ? 0 : adminTypes.test(f[response]) ? 1 : 2]++;
    const callDate=f[datetimeColumn].slice(0,10);
    if(nearSurge(callDate)) {
      const q=Math.floor((+f[datetimeColumn].slice(11,13)*60 + +f[datetimeColumn].slice(14,16))/15);
      const service=['LOCAL_POLICE','SHERIFF','STATE_POLICE','CAMPUS_POLICE'].includes(f[kind]) ? 0 : f[kind]==='FIRE' ? 1 : f[kind]==='EMS' ? 2 : 3;
      for(const scope of ['all',...(f[town]==='UTICA' && f[county]==='ONEIDA'?['utica']:[]),...(f[kind]==='FIRE'?['fire']:[])]) {
        const a=surgeStats[scope][callDate] ||= {n:0,bins:Array.from({length:96},()=>Array(4).fill(0)),types:{},agencies:{},destinations:{}};
        a.n++;a.bins[q][service]++;
        (a.types[f[response]] ||= Array(96).fill(0))[q]++;
        (a.agencies[f[agency]] ||= Array(96).fill(0))[q]++;
        const dest=f[town] ? f[town]+(f[county] && f[county]!=='ONEIDA'?' ('+f[county]+' COUNTY)':'') : f[county] && f[county]!=='ONEIDA'? f[county]+' COUNTY (TOWN NOT ASSIGNED)' : 'TOWN/CITY NOT ASSIGNED';
        (a.destinations[dest] ||= Array(96).fill(0))[q]++;
      }
    }
    const discoveryYear=callDate.slice(0,4),discoveryMonth=+callDate.slice(5,7),discoveryDow=(new Date(callDate+'T00:00:00Z').getUTCDay()+6)%7;
    for(const scope of ['all',...(f[town]==='UTICA'?['utica']:[]),...(discoveryDow===0?['monday']:[])]) {
      const byType=(discoveries[scope] ||= {})[discoveryYear] ||= {};
      const c=byType[f[response]] ||= {months:Array(13).fill(0),weekdays:Array(7).fill(0),hours:Array(24).fill(0)};
      c.months[discoveryMonth]++;c.weekdays[discoveryDow]++;c.hours[+f[hourColumn]]++;
    }
    if(f[county]==='ONEIDA' && f[town]) for(const scope of ['all',...(discoveryDow===0?['monday']:[])]) {
      const y=(localProfiles[scope] ||= {})[discoveryYear] ||= {total:0,types:{},places:{}};
      y.total++;y.types[f[response]]=(y.types[f[response]]||0)+1;
      for(const place of ['T:'+f[town],...(f[village]?['V:'+f[town]+'|'+f[village]]:[])]) {
        const a=y.places[place] ||= {total:0,types:{}};a.total++;a.types[f[response]]=(a.types[f[response]]||0)+1;
      }
    }
    addComparison(comparison.dates[callDate] ||= comparisonSide(),f);
    if(['UTICA','ROME'].includes(f[town]))addComparison(comparison.towns[f[town]] ||= comparisonSide(),f);
    if (['FIRE', 'EMS'].includes(f[kind]) && !/nurse navigation/i.test(f[agency])) {
      let a = outsideBy.get(f[agency]);
      if (!a) outsideBy.set(f[agency], a = { known: 0, unknown: 0, towns: new Map(), dests: new Map() });
      const dest = f[county] && f[county] !== 'ONEIDA' ? 'C:' + f[county] : f[town] ? 'T:' + f[town] : '';
      if (!dest) a.unknown++;
      else { a.known++; a.dests.set(dest, (a.dests.get(dest) || 0) + 1);
        if (dest.startsWith('T:')) a.towns.set(dest, (a.towns.get(dest) || 0) + 1); }
    }
    const iso = f[reportDate], y = iso.slice(0, 4), m = +iso.slice(5, 7);
    if(f[categoryColumn]==='MEDICAL') {
      const level=['','O','A','B','C','D','E'].indexOf(f[priorityColumn]),h=+f[hourColumn];
      assert(level>=0,'Unexpected medical priority code');medical.hours[h][level]++;
      if(new Date(iso+'T00:00:00Z').getUTCDay()===1)medical.mondayHours[h][level]++;
      if(level && f[county]==='ONEIDA' && f[town]) {medical.county[0]++;if(level>=5)medical.county[1]++;}
    }
    for (const stats of [population.all, population.years[y] ||= { known: 0, unknown: 0, utica: 0 }]) {
      if (f[county] === 'ONEIDA' && f[town]) stats.known++;
      else if (!f[county] || f[county] === 'ONEIDA') stats.unknown++;
      if (f[town] === 'UTICA') stats.utica++;
    }
    if(y==='2026' && f[agency]==='Utica Police Department') {
      const hour=+f[hourColumn], hours=policeMonths[m] ||= Array.from({length:24},()=>({n:0,initiated:0})); hours[hour].n++;
      if(officerTypes.has(f[response])) hours[hour].initiated++;
      const day=policeDates[iso] ||= new Array(24).fill(0); day[hour]++;
    }
    for (const stats of [seasonal, ...(new Date(iso + 'T00:00:00Z').getUTCDay() === 1 ? [seasonalMonday] : [])]) {
      const row = stats[y] ||= Array.from({length:13}, () => ({n:0, dates:new Set()}));
      row[m].n++; row[m].dates.add(iso);
    }
    if (f[town] === 'WHITESTOWN') { whitestown++; if (f[village] === 'WHITESBORO') whitesboro++; }
    // "Unknown destination" = no town and not a neighboring county (matches the flows panel).
    const unknown = f[town] === '' && (f[county] === '' || f[county] === 'ONEIDA');
    if (unknown && f[kind] === 'FIRE') fireUnknownBy.set(f[agency], (fireUnknownBy.get(f[agency]) || 0) + 1);
    if (f[town] !== '' && f[county] === 'ONEIDA') hasHome.add(f[agency]);
  }
  // The panel only considers agencies with a home town (at least one dispatch in an Oneida County town).
  let fireUnknown = 0;
  fireUnknownBy.forEach((n, a) => { if (hasHome.has(a)) fireUnknown += n; });
  const plain = stats => Object.fromEntries(Object.entries(stats).map(([y, months]) => [y, months.map(v => ({n:v.n, days:v.dates.size}))]));
  const outside = Object.fromEntries([...outsideBy].filter(([, a]) => a.towns.size).map(([name, a]) => {
    const home = [...a.towns].sort((a, b) => b[1] - a[1])[0][0];
    return [name, { known: a.known, unknown: a.unknown, out: a.known - a.dests.get(home) }];
  }));
  return { total, surgeStats, whitestown, whitesboro, fireUnknown, outside, population, comparison, seasonal:plain(seasonal), seasonalMonday:plain(seasonalMonday), policeMonths, policeDates, policeCounts, medical, discoveries, localProfiles };
}

async function main() {
  const expected = datasetCounts();
  const fmt = n => n.toLocaleString('en-US');
  const browserPath = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oneida-ui-'));
  const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--remote-debugging-port=19229', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let spawnError;
  browser.on('error', error => { spawnError = error; });
  let ws, send;
  const watchdog = setTimeout(() => { console.error('Browser regression check timed out'); browser.kill(); process.exitCode = 1; ws?.close(); }, 300000);
  try {
    let target;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (spawnError) throw spawnError;
      try {
        const tabs = await (await fetch('http://127.0.0.1:19229/json/list')).json();
        target = tabs.find(t => t.url === 'about:blank');
        if (target) break;
      } catch (_) {}
      await delay(200);
    }
    assert(target, 'Headless browser did not start; set BROWSER_PATH or allow browser execution');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let sequence = 0;
    const pending = new Map(), errors = [];
    ws.onclose = () => { for (const job of pending.values()) job.reject(new Error('Browser connection closed')); pending.clear(); };
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const job = pending.get(message.id);
        if (job) { pending.delete(message.id); message.error ? job.reject(new Error(JSON.stringify(message.error))) : job.resolve(message.result); }
      } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    };
    send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const pageUrl = pathToFileURL(path.resolve(__dirname, '../docs/index.html')).href;
    async function navigate(url = pageUrl) {
      await send('Page.navigate', { url });
      for (let i = 0; i < 80; i++) {
        if (await evaluate(`document.readyState === 'complete' && !!document.querySelector('#q') && !!document.querySelector('#theme [aria-pressed]')`)) return;
        await delay(100);
      }
      throw new Error('Page did not initialize: ' + errors.join('\n'));
    }
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*', '*cdnjs.cloudflare.com*'] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await navigate();
    assert.equal(await evaluate(`document.querySelector('#total').textContent`), fmt(expected.total));
    const initialGeometry = await evaluate(`({bottom:document.querySelector('#map').getBoundingClientRect().bottom, height:innerHeight})`);
    assert(initialGeometry.bottom <= initialGeometry.height + 1, 'Desktop map must fit the first screen: ' + JSON.stringify(initialGeometry));
    async function screenshot(name) {
      const result = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(profile, name + '.png'), Buffer.from(result.data, 'base64'));
    }
    await screenshot('desktop');
    console.log('PASS: initial page works with external fonts and CDN blocked');

    const documentedSurges=['2024-02-28','2024-02-29','2024-07-16','2025-06-22'];
    const referenceDates=iso=>Object.keys(expected.comparison.dates).filter(d=>d!==iso && !documentedSurges.includes(d) && d.slice(0,4)===iso.slice(0,4) && new Date(d+'T00:00:00Z').getUTCDay()===new Date(iso+'T00:00:00Z').getUTCDay() && Math.abs(Date.parse(d)-Date.parse(iso))<=42*86400000).sort();
    async function checkSurge(date,scope='all') {
      const refs=referenceDates(date),stats=expected.surgeStats[scope],a=stats[date],bins=a?.bins||Array.from({length:96},()=>Array(4).fill(0));
      assert.deepEqual(await evaluate(`document.querySelector('#surge-reference-dates').dataset.dates.split(',').filter(Boolean).sort()`),refs);
      assert.equal(await evaluate(`+document.querySelector('#surge-kpis').dataset.total`),a?.n||0);
      assert.equal(await evaluate(`+document.querySelector('#surge-kpis').dataset.referenceMean`),refs.reduce((n,d)=>n+(stats[d]?.n||0),0)/refs.length);
      const timeline=await evaluate(`[...document.querySelectorAll('[data-surge-table-bin]')].map(tr=>[...tr.querySelectorAll('td')].map(td=>td.textContent.replaceAll(',','')))`);
      assert.equal(timeline.length,96);
      timeline.forEach((row,q)=>{
        assert.deepEqual(row.slice(0,4).map(Number),bins[q],date+' quarter '+q);
        assert.equal(+row[4],bins[q].reduce((s,n)=>s+n,0));
        const mean=refs.reduce((s,d)=>s+(stats[d]?.bins[q].reduce((n,v)=>n+v,0)||0),0)/refs.length;
        assert(Math.abs(+row[5]-mean)<=.051,date+' reference quarter '+q);
      });
      return {a,refs,stats,bins};
    }
    for(const date of documentedSurges) {
      await navigate(pageUrl+'?surge='+date+'&surgeAt=64');await checkSurge(date);
    }
    for(const [scope,query] of [['utica','&place=T:UTICA'],['fire','&responder=FIRE']]) {
      await navigate(pageUrl+'?surge=2024-07-16&surgeAt=64'+query);await checkSurge('2024-07-16',scope);
    }
    await navigate(pageUrl+'?surge=2024-07-16&surgeAt=64&year=2026&month=3&day=mon&hour=7');
    const surgeExpected=await checkSurge('2024-07-16');
    assert((await evaluate(`document.querySelector('#surge-section').textContent`)).includes("replaces the page's time filters"));
    for(const mode of ['interval','cumulative','day']) {
      await evaluate(`(()=>{const s=document.querySelector('#surge-scope');s.value='${mode}';s.dispatchEvent(new Event('change'))})()`);
      const start=mode==='interval'?64:0,end=mode==='day'?95:64;
      const n=surgeExpected.bins.slice(start,end+1).flat().reduce((a,b)=>a+b,0);
      assert.equal(await evaluate(`+document.querySelector('#surge-window-summary').dataset.total`),n);
      const mean=surgeExpected.refs.reduce((s,d)=>s+(surgeExpected.stats[d]?.bins.slice(start,end+1).flat().reduce((a,b)=>a+b,0)||0),0)/surgeExpected.refs.length;
      assert.equal(await evaluate(`+document.querySelector('#surge-window-summary').dataset.referenceMean`),mean);
      const types=await evaluate(`[...document.querySelectorAll('[data-surge-type]')].map(tr=>({type:tr.dataset.surgeType,n:+tr.dataset.count,mean:+tr.dataset.reference}))`);
      for(const t of types) {
        assert.equal(t.n,surgeExpected.a.types[t.type].slice(start,end+1).reduce((a,b)=>a+b,0));
        assert.equal(t.mean,surgeExpected.refs.reduce((s,d)=>s+(surgeExpected.stats[d]?.types[t.type]?.slice(start,end+1).reduce((a,b)=>a+b,0)||0),0)/surgeExpected.refs.length);
      }
      for(const panel of ['agencies','towns']) {
        const button='#surge-all-'+panel;
        await evaluate(`if(!document.querySelector('${button}').hidden && document.querySelector('${button}').getAttribute('aria-expanded')==='false')document.querySelector('${button}').click()`);
        const actual=await evaluate(`[...document.querySelectorAll('#surge-${panel} tbody tr')].map(tr=>[tr.cells[0].textContent.toUpperCase(),+tr.cells[1].textContent.replaceAll(',','')])`);
        const source=panel==='agencies'?surgeExpected.a.agencies:surgeExpected.a.destinations;
        const target=Object.fromEntries(Object.entries(source).map(([name,values])=>[name.toUpperCase(),values.slice(start,end+1).reduce((a,b)=>a+b,0)]).filter(([,n])=>n));
        assert.deepEqual(Object.fromEntries(actual),target,panel+' '+mode);
      }
    }
    const surgeCsv=await evaluate(`(async()=>{let blob;const create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;try{URL.createObjectURL=b=>{blob=b;return 'blob:review'};HTMLAnchorElement.prototype.click=function(){};document.querySelector('#surge-download').click();return await blob.text()}finally{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click}})()`);
    assert.equal(surgeCsv.trim().split(/\r?\n/).length,97);
    assert.equal(surgeCsv.trim().split(/\r?\n/).slice(1).reduce((sum,line)=>sum+Number(line.split(',')[7]),0),surgeExpected.a.n);
    assert(surgeCsv.includes('reference_dates,place_filter,category_filter') && surgeCsv.includes(surgeExpected.refs.join(';')));
    const review2026=Object.keys(expected.comparison.dates).find(d=>d.startsWith('2026'));
    await navigate(pageUrl+'?surge='+review2026+'&year=2024');
    assert.equal(await evaluate(`+document.querySelector('#surge-kpis').dataset.total`),expected.comparison.dates[review2026].n);
    assert(await evaluate(`!document.querySelector('#surge-report-warning').hidden && document.querySelector('#surge-report-warning').getBoundingClientRect().height>0`));
    await navigate(pageUrl+'?surge=2025-06-22&year=2026&month=3&day=mon&hour=7&place=T:ROME');
    await evaluate(`document.querySelector('#surge-explore').click()`);
    assert.equal(await evaluate(`new URL(location.href).searchParams.get('date')`),'2025-06-22');
    assert.equal(await evaluate(`new URL(location.href).searchParams.get('place')`),'T:ROME');
    assert(!await evaluate(`['hour','month','day'].some(k=>new URL(location.href).searchParams.has(k))`));
    // All current dates have enough references: simulate extra annotated exclusions to test 2 and 0 eligible dates.
    const excludedReferences=[...referenceDates('2024-07-16').slice(2),...referenceDates('2024-02-28')];
    const sparseInjection=await send('Page.addScriptToEvaluateOnNewDocument',{source:`const parse=JSON.parse;JSON.parse=function(...args){const d=parse.apply(this,args);if(d&&d.records&&d.weatherEvents)d.weatherEvents.push({id:'test-exclusions',label:'Test reference exclusions',dates:${JSON.stringify(excludedReferences)}});return d}`});
    for(const [date,count] of [['2024-07-16',2],['2024-02-28',0]]) {
      await navigate(pageUrl+'?surge='+date);
      assert.equal(await evaluate(`document.querySelector('#surge-reference-dates').dataset.dates.split(',').filter(Boolean).length`),count);
      assert.equal(await evaluate(`document.querySelector('#surge-kpis').dataset.referenceMean`),'');
      assert((await evaluate(`document.querySelector('#surge-reference').textContent`)).includes('unavailable'));
      assert((await evaluate(`document.querySelector('[data-surge-table-bin] td:last-child').textContent`)).includes('Unavailable'));
    }
    await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:sparseInjection.identifier});
    const absentSurgeType=await evaluate(`JSON.parse(document.querySelector('#data').textContent).types.map(t=>t[0]).find(t=>!${JSON.stringify(Object.keys(surgeExpected.a.types))}.includes(t))`);
    await navigate(pageUrl+'?surge=2024-07-16&type='+encodeURIComponent(absentSurgeType));
    assert.equal(await evaluate(`+document.querySelector('#surge-kpis').dataset.total`),0);
    assert(await evaluate(`document.querySelector('#surge-replay').disabled`));
    assert.equal(await evaluate(`+document.querySelector('#surge-window-summary').dataset.total`),0);
    await navigate(pageUrl+'?surge=2024-07-16&surgeAt=64&surgeScope=cumulative');
    await evaluate(`document.querySelector('#surge-seek').focus()`);
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    assert.equal(await evaluate(`new URL(location.href).searchParams.get('surgeAt')`),'65');
    const surgeLink=await evaluate('location.href');await navigate(surgeLink);
    assert.equal(await evaluate(`document.querySelector('#surge-seek').value`),'65');
    assert.equal(await evaluate(`document.querySelector('#surge-scope').value`),'cumulative');
    await evaluate(`document.querySelector('#surge-replay').click()`);
    assert.equal(await evaluate(`+document.querySelector('#replay-seek').value`),65*900);
    assert.equal(await evaluate(`document.querySelector('#replay-play').getAttribute('aria-pressed')`),'false');
    assert.equal(await evaluate(`new URL(location.href).searchParams.get('date')`),'2024-07-16');
    assert(!await evaluate(`['hour','month','day'].some(k=>new URL(location.href).searchParams.has(k))`));
    for(const [width,height,mobile] of [[1440,900,false],[390,844,true],[320,844,true]]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
      for(const theme of ['light','dark']) {
        await evaluate(`document.querySelector('#theme [data-theme="${theme}"]').click();document.querySelector('#surge-section').scrollIntoView({behavior:'instant',block:'start'})`);
        assert(await evaluate(`(()=>{const e=document.querySelector('#surge-section'),r=e.getBoundingClientRect(),c=document.querySelector('#surge-chart');return document.documentElement.scrollWidth<=innerWidth && e.scrollWidth<=e.clientWidth && c.scrollWidth<=c.clientWidth && r.left>=0 && r.right<=innerWidth && document.querySelector('#surge-seek').getBoundingClientRect().height>=44})()`),'Surge review and full-day timeline fit '+width+' '+theme);
        await screenshot('surge-'+width+'-'+theme);
        await evaluate(`document.querySelector('#surge-chart').scrollIntoView({behavior:'instant',block:'center'})`);
        await screenshot('surge-chart-'+width+'-'+theme);
        await evaluate(`document.querySelector('.surge-columns').scrollIntoView({behavior:'instant',block:'start'})`);
        await screenshot('surge-details-'+width+'-'+theme);
      }
    }
    await evaluate(`document.querySelector('#reset').click()`);
    assert(!await evaluate(`new URL(location.href).searchParams.has('surge')`));
    assert.deepEqual(errors,[]);
    console.log('PASS: surge review quarter-hour counts, reference dates/means, filters, detail windows, types, agencies, towns, CSV, sparse coverage, keyboard sharing and paused replay match independent CSV evidence');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await navigate(pageUrl);

    if (await evaluate(`!!document.querySelector('#stories-section')`)) {
    async function checkDiscoveries(scope='all',requireSome=true) {
      const ids=await evaluate(`[...document.querySelectorAll('#story-list [data-story]')].map(b=>b.dataset.story)`);
      if(requireSome)assert(ids.length>0,'Broad selections should produce supported local discoveries');
      for(const id of ids) {
        await evaluate(`document.querySelector('#story-list [data-story='+CSS.escape(${JSON.stringify(id)})+']').click()`);
        const [kind,y,type,...placeParts]=id.split('|'),place=placeParts.join('|');
        assert.equal(kind,'place','Discoveries should focus on local differences');
        const c=expected.localProfiles[scope][y],here=c.places[place];
        assert(here,'Discovery place must exist in the CSV');
        const wanted=[{n:here.types[type]||0,d:here.total},{n:(c.types[type]||0)-(here.types[type]||0),d:c.total-here.total}];
        const actual=await evaluate(`({bars:[...document.querySelectorAll('#story-bars [data-count]')].map(b=>({n:+b.dataset.count,d:+b.dataset.denominator})),mappedTotal:+document.querySelector('#story-map-note').dataset.total})`);
        assert.deepEqual(actual.bars,wanted,'Local shares must match independent CSV counts: '+id);
        assert.equal(actual.mappedTotal,wanted[0].n,'Map evidence must retain every local dispatch');
        assert(wanted.every(v=>v.n>=50));assert(wanted[0].d>=500&&wanted[1].d>=1000);
        assert((wanted[0].n/wanted[0].d)/(wanted[1].n/wanted[1].d)>=1.5);
        assert(100*(wanted[0].n/wanted[0].d-wanted[1].n/wanted[1].d)>=1);
      }
      return {ids};
    }
    await checkDiscoveries();
    assert((await evaluate(`[...document.querySelectorAll('#story-list [data-story]')].map(b=>b.dataset.story.split('|')[2])`)).every(t=>!['ASSIST','EMS CALL','FIREWORKS','BUILDING INSPECTION','PARKING SUMMONS','SUMMONS','TRAFFIC STOP'].includes(t)&&!t.includes('TRANSFER')),'Routine discoveries are hidden by default');
    const savedStory=await evaluate(`document.querySelector('#story-detail').dataset.story`);
    const discoveryUrl=await evaluate(`location.href`);
    assert.equal(new URL(discoveryUrl).searchParams.get('story'),savedStory,'Selecting a discovery must create a shared view');
    await navigate(discoveryUrl);
    assert.equal(await evaluate(`document.querySelector('#story-detail').dataset.story`),savedStory,'Shared discovery restores evidence');
    const typeFiltered=new URL(discoveryUrl);typeFiltered.searchParams.set('type',savedStory.split('|')[2]);
    await navigate(typeFiltered.href);
    await checkDiscoveries();
    assert.equal(await evaluate(`document.querySelector('#story-detail').dataset.story`),savedStory,'Type filters preserve all-dispatch denominators');
    const peakCount=await evaluate(`+document.querySelector('#story-bars [data-count]').dataset.count`);
    await evaluate(`document.querySelector('#story-explore').click()`);
    assert.equal(await evaluate(`document.querySelector('#total').textContent`),fmt(peakCount),'Explore applies exactly the peak selection');
    await navigate(pageUrl+'?place=T:UTICA');
    await checkDiscoveries();
    await navigate(pageUrl+'?place='+encodeURIComponent('V:WHITESTOWN|WHITESBORO'));
    await checkDiscoveries('all',false);
    await navigate(pageUrl+'?year=2024&day=mon');
    await checkDiscoveries('monday',false);

    await navigate(pageUrl+'?year=2025');
    assert.equal(await evaluate(`document.querySelectorAll('#story-list [data-story]').length`),0,'Sparse year coverage must suppress local discoveries');
    await navigate(pageUrl+'?storyRoutine=1');
    assert(await evaluate(`document.querySelector('#story-routine').checked`));
    await checkDiscoveries();
    assert.equal(new URL(await evaluate(`location.href`)).searchParams.get('storyRoutine'),'1','Routine preference survives sharing');
    await evaluate(`document.querySelector('#reset').click()`);
    assert(!await evaluate(`document.querySelector('#story-routine').checked`),'Reset restores routine suppression');
    await navigate(pageUrl+'?date='+Object.keys(expected.comparison.dates)[0]);
    assert.equal(await evaluate(`document.querySelectorAll('#story-list [data-story]').length`),0,'Single-day filters must not invent discoveries');
    assert(await evaluate(`document.querySelector('#story-detail').getBoundingClientRect().height===0`),'Empty evidence is hidden');
    await navigate();
    for(const width of [1440,320]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===320});
      for(const theme of ['light','dark']) {
        await evaluate(`document.querySelector('#theme [data-theme="${theme}"]').click();document.querySelector('#stories-section').scrollIntoView({block:'start',behavior:'instant'})`);
        await delay(150);
        assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),'Discovery panel must fit mobile');
        await screenshot('discoveries-'+width+'-'+theme);
        await evaluate(`document.querySelector('#story-detail').scrollIntoView({block:'start',behavior:'instant'})`);
        await screenshot('discovery-evidence-'+width+'-'+theme);
      }
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: local discovery shares match CSV with disjoint county baselines; routine preference, coverage, exploration, sharing, filters and mobile themes work');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await navigate();

    } else {
      assert.equal(await evaluate(`document.querySelectorAll('#stories-section,.section-nav a[href="#stories-section"],button[data-chart-help="stories-section"]').length`),0);
      await navigate(pageUrl+'?year=2024&story=legacy&storyRoutine=1');
      assert.equal(await evaluate(`document.querySelector('#total').textContent`),fmt(Object.entries(expected.comparison.dates).filter(([d])=>d.startsWith('2024-')).reduce((n,[,v])=>n+v.n,0)));
      assert(!new URL(await evaluate(`location.href`)).searchParams.has('story'));
      assert(!new URL(await evaluate(`location.href`)).searchParams.has('storyRoutine'));
      assert.deepEqual(errors,[]);
      console.log('PASS: Find the story is disabled; legacy discovery links do not activate hidden controls');
      await navigate();
    }

    const replayDay = await evaluate(`(()=>{const s=document.querySelector('#replay-date'),d=JSON.parse(document.querySelector('#data').textContent);return d.dates[+s.value]})()`);
    const replayExpected = expected.comparison.dates[replayDay];
    assert(replayExpected, 'Replay date must exist in the independent CSV');
    assert.equal(await evaluate(`+document.querySelector('#replay-status').dataset.total`), replayExpected.n);
    const hourCounts = await evaluate(`[...document.querySelectorAll('#replay-hours button')].map(b=>Number(b.title.split(': ').at(-1).replaceAll(',','').split(' ')[0]))`);
    assert.deepEqual(hourCounts, replayExpected.hours, 'Replay hourly counts must match CSV');
    await evaluate(`document.querySelector('#replay-section').scrollIntoView({block:'start'});document.querySelector('#replay-seek').value=86400;document.querySelector('#replay-seek').dispatchEvent(new Event('input'))`);
    assert.equal(await evaluate(`+document.querySelector('#replay-status').dataset.elapsed`), replayExpected.n, 'End of day includes all dispatches');
    assert.equal(await evaluate(`document.querySelector('#replay-clock').textContent`), '24:00');
    const feed = await evaluate(`(()=>{const d=JSON.parse(document.querySelector('#data').textContent),read=(key,Type)=>new Type(Uint8Array.from(atob(d.records[key]),c=>c.charCodeAt(0)).buffer),z=read('z',Uint32Array),p=read('p',Uint8Array);return [...document.querySelectorAll('#replay-feed li[data-record]')].map(e=>({seconds:z[+e.dataset.record],precise:p[+e.dataset.record],text:e.querySelector('time').textContent}))})()`);
    assert(feed.length > 0 && feed.length <= 12);
    assert(feed.every((f,i)=>i===0 || f.seconds<=feed[i-1].seconds),'Feed must show newest first');
    assert(feed.every(f=>f.precise ? /:\d\d:\d\d/.test(f.text) : f.text.includes('minute precision')),'Replay must preserve timestamp precision');
    await evaluate(`document.querySelector('#replay-restart').click();document.querySelector('#replay-hours [data-replay-hour="12"]').click()`);
    assert.equal(await evaluate(`document.querySelector('#replay-clock').textContent`), '12:00');
    assert.equal(await evaluate(`document.querySelector('#replay-play').getAttribute('aria-pressed')`), 'false');
    await delay(150);
    await evaluate(`document.querySelector('#replay-play').click()`);
    await delay(650);
    assert.equal(await evaluate(`document.querySelector('#replay-play').textContent`), 'Pause');
    assert.notEqual(await evaluate(`document.querySelector('#replay-clock').textContent`), '12:00','Playback advances simulated time');
    await evaluate(`document.querySelector('#replay-play').click()`);
    const pausedClock = await evaluate(`document.querySelector('#replay-clock').textContent`);
    await delay(350);
    assert.equal(await evaluate(`document.querySelector('#replay-clock').textContent`),pausedClock,'Pause stops playback');
    await evaluate(`document.querySelector('#replay-play').click();document.querySelector('#flows-section').scrollIntoView({block:'start'})`);
    await delay(250);
    assert.equal(await evaluate(`document.querySelector('#replay-play').getAttribute('aria-pressed')`),'false','Playback pauses offscreen');
    await evaluate(`document.querySelector('#replay-section').scrollIntoView({block:'start'})`);
    await delay(150);
    await evaluate(`document.querySelector('#replay-seek').value=86400;document.querySelector('#replay-seek').dispatchEvent(new Event('input'));document.querySelector('#replay-feed [data-replay-record]')?.click()`);
    assert((await evaluate(`document.querySelector('#replay-map').innerText`)).includes('not a verified incident site') || (await evaluate(`document.querySelector('#replay-map').innerText`)).includes('estimated') || (await evaluate(`document.querySelector('#replay-map .leaflet-popup')?.textContent || ''`)).length>0,'Feed opens location details');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    for (const width of [1440,320]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===320});
      for (const theme of ['light','dark']) {
        await evaluate(`document.querySelector('#theme [data-theme="${theme}"]').click();document.querySelector('#replay-section').scrollIntoView({block:'start'})`);
        await delay(120);
        const layout = await evaluate(`(()=>{const c=document.querySelector('#replay-section').getBoundingClientRect(),m=document.querySelector('#replay-map').getBoundingClientRect(),s=document.querySelector('#replay-date').getBoundingClientRect();return {scroll:document.documentElement.scrollWidth,width:innerWidth,card:c.width,map:m.width,selectRight:s.right,cardRight:c.right}})()`);
        assert(layout.scroll<=layout.width+1,'Replay must fit mobile viewport: '+JSON.stringify(layout));
        assert(layout.selectRight<layout.cardRight,'Replay date selector must stay inside its card');
        assert(layout.map>200 && layout.map<=layout.card,'Replay map remains usable');
        await evaluate(`document.querySelector('#replay-feed [data-replay-record]')?.click()`);
        await delay(300);
        const popupFit=await evaluate(`(()=>{const m=document.querySelector('#replay-map').getBoundingClientRect(),p=document.querySelector('#replay-map .leaflet-popup')?.getBoundingClientRect();return p && p.left>=m.left && p.right<=m.right})()`);
        assert(popupFit,'Replay location popup must fit its map at '+width+'px');
        await evaluate(`document.querySelector('#replay-section').scrollIntoView({block:'start'})`);
        await screenshot('replay-'+width+'-'+theme);
      }
    }
    await send('Emulation.setEmulatedMedia',{features:[]});
    await navigate(pageUrl+'?date='+replayDay+'&hour=7');
    assert.equal(await evaluate(`+document.querySelector('#replay-status').dataset.total`),replayExpected.hours[7], 'Date/hour filters apply to replay');
    assert.equal(await evaluate(`document.querySelector('#replay-date').options.length`),replayExpected.hours[7] ? 1 : 0);
    await evaluate(`document.querySelector('#replay-section').scrollIntoView({block:'start'})`);
    await delay(150);
    await evaluate(`document.querySelector('#replay-play').click();const s=document.querySelector('[data-hour-picker]');s.value='8';s.dispatchEvent(new Event('change'))`);
    assert.equal(await evaluate(`document.querySelector('#replay-play').getAttribute('aria-pressed')`),'false','Filter changes pause playback');
    assert.equal(await evaluate(`+document.querySelector('#replay-status').dataset.total`),replayExpected.hours[8]);
    const emptyReplay = Object.entries(expected.comparison.dates).find(([,v])=>v.hours.includes(0));
    assert(emptyReplay,'Need a covered day with an empty hour to verify the empty replay');
    await navigate(pageUrl+'?date='+emptyReplay[0]+'&hour='+emptyReplay[1].hours.indexOf(0));
    assert.equal(await evaluate(`document.querySelector('#replay-play').disabled`),true,'Empty filters disable playback');
    assert.equal(await evaluate(`+document.querySelector('#replay-status').dataset.total`),0);
    assert.deepEqual(errors,[]);
    console.log('PASS: replay dates and hourly counts match CSV; seeking, precision, playback, pause, filters, empty state, location details and mobile themes work');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await navigate();

    assert.equal(await evaluate(`document.querySelectorAll('#coverage-weather button[data-weather-date]').length`),4);
    assert.equal(await evaluate(`document.querySelectorAll('#trend .weather-dot').length`),4);
    for(const date of ['2024-02-28','2024-02-29','2024-07-16','2025-06-22']) {
      for(const origin of ['#coverage-weather','#trend']) {
        await evaluate(`document.querySelector('${origin} [data-weather-date="${date}"]').click()`);
        const info=await evaluate(`(()=>{const d=document.querySelector('#chart-help-dialog');return {open:d.open,body:document.querySelector('#chart-help-body').textContent,source:document.querySelector('#chart-help-body a').href}})()`);
        assert(info.open && info.body.includes(expected.comparison.dates[date].n.toLocaleString('en-US')+' matching dispatches'));
        assert(info.source.startsWith('https://www.weather.gov/bgm/'));
        assert(info.body.includes('do not establish that every dispatch was caused by the weather'));
        await evaluate(`document.querySelector('#chart-help-close').click()`);
        await delay(50);
        assert(await evaluate(`document.activeElement.matches('${origin} [data-weather-date="${date}"]')`),'Weather details restore focus to '+origin);
      }
    }
    await evaluate(`document.querySelector('#coverage-weather [data-weather-date="2024-07-16"]').click();document.querySelector('[data-weather-filter="2024-07-16"]').click()`);
    assert.equal(await evaluate(`new URL(location.href).searchParams.get('date')`),'2024-07-16');
    assert.equal(await evaluate(`+document.querySelector('#replay-status').dataset.total`),expected.comparison.dates['2024-07-16'].n);
    await navigate(pageUrl+'?hour=4');
    await evaluate(`document.querySelector('#coverage-weather [data-weather-date="2025-06-22"]').click()`);
    assert((await evaluate(`document.querySelector('#chart-help-body').textContent`)).includes(expected.comparison.dates['2025-06-22'].hours[4].toLocaleString('en-US')+' matching dispatches'));
    await evaluate(`document.querySelector('[data-weather-replay="2025-06-22"]').click()`);
    assert.equal(await evaluate(`+document.querySelector('#replay-seek').value`),12600);
    assert.equal(await evaluate(`document.querySelector('#replay-play').getAttribute('aria-pressed')`),'false');
    assert.equal(await evaluate(`new URL(location.href).searchParams.get('hour')`),'4');
    await navigate(pageUrl+'?year=2026');
    assert.equal(await evaluate(`document.querySelectorAll('[data-weather-date],#trend .weather-dot').length`),0);
    await navigate(pageUrl);
    for(const width of [390,320]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
      for(const theme of ['light','dark']) {
        await evaluate(`document.querySelector('#theme [data-theme="${theme}"]').click();document.querySelector('#coverage-weather [data-weather-date="2025-06-22"]').click()`);
        assert(await evaluate(`(()=>{const d=document.querySelector('#chart-help-dialog'),r=d.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && d.scrollWidth<=d.clientWidth && document.documentElement.scrollWidth<=innerWidth})()`),'Weather annotations fit mobile '+width+' '+theme);
        await screenshot('weather-'+width+'-'+theme);
        await evaluate(`document.querySelector('#chart-help-close').click()`);
      }
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: sourced weather annotations match CSV counts, respect filters, restore focus, start replay paused and fit mobile themes');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await navigate(pageUrl);

    const helperSections=await evaluate(`[...document.querySelectorAll('button[data-chart-help]')].map(b=>b.dataset.chartHelp)`);
    assert(helperSections.includes('population-section') && helperSections.includes('compare-section') && helperSections.includes('flows-section') && helperSections.includes('about'));
    for(const id of helperSections) {
      const help=await evaluate(`(()=>{const b=document.querySelector('button[data-chart-help="${id}"]');b.click();const d=document.querySelector('#chart-help-dialog');return {open:d.open,title:document.querySelector('#chart-help-title').textContent,body:document.querySelector('#chart-help-body').textContent,focused:d.contains(document.activeElement),expanded:b.getAttribute('aria-expanded'),duplicateIds:[...document.querySelectorAll('[id]')].map(e=>e.id).filter((v,i,a)=>a.indexOf(v)!==i)}})()`);
      assert(help.open && help.focused && help.expanded==='true',id);
      assert(help.title && help.body.length>40,id);
      assert.deepEqual(help.duplicateIds,[],id);
      await evaluate(`document.querySelector('#chart-help-close').click()`);
      assert.equal(await evaluate(`document.activeElement.dataset.chartHelp`),id);
    }
    await evaluate(`document.querySelector('button[data-chart-help="population-section"]').click()`);
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert(!await evaluate(`document.querySelector('#chart-help-dialog').open`));
    assert.equal(await evaluate(`document.activeElement.dataset.chartHelp`),'population-section');
    await navigate(pageUrl+'?year=2024&rate=annual');
    await evaluate(`document.querySelector('button[data-chart-help="population-section"]').click()`);
    const filteredHelp=await evaluate(`document.querySelector('#chart-help-body').textContent`);
    assert(filteredHelp.includes('364 covered days') && filteredHelp.includes('Annual equivalent'));
    await evaluate(`document.querySelector('#chart-help-close').click()`);
    assert(await evaluate(`document.querySelector('#pc-coverage').getBoundingClientRect().height>0 && document.querySelector('#pc-excluded-note').getBoundingClientRect().height>0 && document.querySelector('#pc-location-note').getBoundingClientRect().height===0`));
    await navigate(pageUrl);
    for(const [width,height,mobile] of [[1440,900,false],[390,844,true],[320,844,true]]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
      for(const theme of ['light','dark']) {
        await evaluate(`document.querySelector('#theme [data-theme="${theme}"]').click();document.querySelector('button[data-chart-help="population-section"]').click()`);
        const geometry=await evaluate(`(()=>{const d=document.querySelector('#chart-help-dialog'),r=d.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,scroll:d.scrollWidth,client:d.clientWidth}})()`);
        assert(geometry.left>=0 && geometry.right<=geometry.width && geometry.top>=0 && geometry.bottom<=geometry.height && geometry.scroll<=geometry.client,JSON.stringify(geometry));
        assert(await evaluate(`(()=>{const body=document.querySelector('#chart-help-body'),close=document.querySelector('#chart-help-close');body.scrollTop=body.scrollHeight;const r=close.getBoundingClientRect();body.scrollTop=0;return r.top>=0 && r.bottom<=innerHeight})()`),'Close stays visible while scrolling long notes');
        await screenshot('chart-help-'+width+'-'+theme);
        // A native dialog traps keyboard focus even when its content contains links.
        await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        assert(await evaluate(`document.querySelector('#chart-help-dialog').contains(document.activeElement)`));
        await evaluate(`document.querySelector('#chart-help-close').click()`);
      }
    }
    await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    const helpTap=await evaluate(`(()=>{const b=document.querySelector('button[data-chart-help="flows-section"]');b.scrollIntoView({behavior:'instant',block:'center'});const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[helpTap]});
    await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert(await evaluate(`document.querySelector('#chart-help-dialog').open`));
    assert(await evaluate(`!!document.querySelector('#chart-help-body a[href*="new-york-mills-fire-department"]')`));
    await evaluate(`document.querySelector('#chart-help-close').click()`);
    await send('Emulation.setTouchEmulationEnabled',{enabled:false});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await navigate(pageUrl);
    console.log('PASS: chart explanations use compact accessible dialogs with current data, focus return, Escape, mobile taps and both themes');

    const bubbleTarget=await evaluate(`(()=>{const d=JSON.parse(document.querySelector('#data').textContent),l=d.locations.find(l=>l[2]==='HOSPITAL DR'&&l[3]==='UTICA');return {street:l[2]+'|'+l[3],point:l[0]+','+l[1]}})()`);
    for(const width of [1440,390,320]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width!==1440});
      await send('Emulation.setTouchEmulationEnabled',{enabled:width!==1440,maxTouchPoints:1});
      for(const theme of ['light','dark']) {
        await navigate(pageUrl+'?street='+encodeURIComponent(bubbleTarget.street)+'&point='+encodeURIComponent(bubbleTarget.point));
        await evaluate(`document.querySelector('#theme [data-theme="${theme}"]').click();document.querySelector('#map').scrollIntoView({block:'center',behavior:'instant'})`);
        await delay(350);
        const bubble=await evaluate(`(()=>{const r=document.querySelector('#map').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
        if(width===1440) {
          await send('Input.dispatchMouseEvent',{type:'mouseMoved',...bubble});
          assert(await evaluate(`!!document.querySelector('#map .leaflet-tooltip')`),'Desktop hover preview remains available');
          await send('Input.dispatchMouseEvent',{type:'mousePressed',...bubble,button:'left',buttons:1,clickCount:1});
          await send('Input.dispatchMouseEvent',{type:'mouseReleased',...bubble,button:'left',clickCount:1});
        } else {
          await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[bubble]});
          await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        }
        assert.equal(await evaluate(`[...document.querySelectorAll('#map .leaflet-tooltip')].filter(e=>e.getBoundingClientRect().width>0&&getComputedStyle(e).opacity!=='0').length`),0,'Opening details immediately hides hover previews');
        await delay(250); // Leaflet removes closed tooltip nodes after its fade timer.
        const detail=await evaluate(`(()=>{const d=document.querySelector('#chart-help-dialog'),r=d.getBoundingClientRect(),p=d.querySelector('.point-details');return {open:d.open,types:p?.querySelectorAll('.point-calltypes li').length,locations:p?.querySelectorAll('ol li').length,total:p?Number(p.querySelector('p').textContent.split(' dispatches')[0].replaceAll(',','')):0,typeSum:[...d.querySelectorAll('.point-calltypes [data-count]')].reduce((n,e)=>n+Number(e.dataset.count),0),tooltips:document.querySelectorAll('#map .leaflet-tooltip').length,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})()`);
        assert(detail.open&&detail.types>0&&detail.locations>0,'A bubble opens one dialog with dispatch types and locations: '+JSON.stringify(detail));
        assert.equal(detail.typeSum,detail.total,'Dispatch-type summary accounts for every dispatch at the point');
        assert.equal(detail.tooltips,0,'The hover tooltip must close when details open');
        assert(detail.left>=0&&detail.right<=detail.width&&detail.top>=0&&detail.bottom<=detail.height,'Bubble details fit the viewport');
        await screenshot('bubble-details-'+width+'-'+theme);
        await evaluate(`document.querySelector('#chart-help-close').click()`);
        assert.equal(await evaluate(`document.querySelectorAll('#map .leaflet-tooltip').length`),0,'Closing details must not leave a stale tooltip');
      }
    }
    await send('Emulation.setTouchEmulationEnabled',{enabled:false});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await navigate();
    await navigate(pageUrl+'?street='+encodeURIComponent(bubbleTarget.street)+'&point='+encodeURIComponent(bubbleTarget.point));
    await evaluate(`document.querySelector('#list .row').click()`);
    await delay(650);
    assert(await evaluate(`document.querySelector('#chart-help-dialog').open`));
    assert.equal(await evaluate(`document.querySelectorAll('#map .leaflet-tooltip').length`),0,'A delayed shared-link preview cannot reopen behind a dialog');
    assert.deepEqual(errors,[]);
    await navigate();
    console.log('PASS: real bubble taps/clicks show dispatch types and location details in one dialog without lingering tooltips on mobile or desktop');

    const pointAuditExpression = `(()=>{
      const d=JSON.parse(document.querySelector('#data').textContent),decode=(s,T)=>new T(Uint8Array.from(atob(s),c=>c.charCodeAt(0)).buffer);
      const locations=decode(d.records.l,Uint16Array),cities=decode(d.records.c,Uint8Array),dates=decode(d.records.d,Uint16Array),groups=new Map(),q=new URLSearchParams(location.search);
      for(let i=0;i<locations.length;i++){
        if(!locations[i])continue;const info=d.cityInfo[d.cities[cities[i]]],county=info[2];if(county && county!=='ONEIDA')continue;
        if(q.has('year')&&!d.dates[dates[i]].startsWith(q.get('year')+'-'))continue;
        if(q.get('place')?.startsWith('T:')&&info[0]!==q.get('place').slice(2))continue;
        const li=locations[i]-1,l=d.locations[li],key=l[0]+','+l[1];
        if(!groups.has(key))groups.set(key,{n:0,members:new Set()});const g=groups.get(key);g.n++;g.members.add(li);
      }
      const rows=[...document.querySelectorAll('#list .row')].map(row=>{const l=d.locations[+row.dataset.li],g=groups.get(l[0]+','+l[1]);return {actual:+row.querySelector('.ct').textContent.replaceAll(',',''),expected:g.n,members:+row.dataset.members,expectedMembers:g.members.size}});
      const coordinate=d.locations.filter(l=>l[2]===''&&l[3]===''&&l[4]==='coordinates')[1];
      return {rows,points:groups.size,total:[...groups.values()].reduce((n,g)=>n+g.n,0),mapped:document.querySelector('#s-mapped').textContent,coordinate:coordinate.slice(0,2),members:d.locations.filter(l=>l[0]===coordinate[0]&&l[1]===coordinate[1]).length};
    })()`;
    const pointAudit = await evaluate(pointAuditExpression);
    pointAudit.rows.forEach(r=>{assert.equal(r.actual,r.expected);assert.equal(r.members,r.expectedMembers);});
    assert(pointAudit.mapped.includes(fmt(pointAudit.points)) && pointAudit.mapped.includes(fmt(pointAudit.total)));
    await navigate(pageUrl+'?year=2024&place=T%3AUTICA');
    const filteredPoints=await evaluate(pointAuditExpression);
    filteredPoints.rows.forEach(r=>{assert.equal(r.actual,r.expected);assert.equal(r.members,r.expectedMembers);});
    assert(filteredPoints.mapped.includes(fmt(filteredPoints.total)) && filteredPoints.mapped.includes(fmt(filteredPoints.points)));
    await navigate(pageUrl);
    await evaluate(`document.querySelector('#list .row[data-members]:not([data-members="1"])').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await delay(1100);
    assert(await evaluate(`document.querySelector('#chart-help-dialog').open && !!document.querySelector('#chart-help-body .point-details ol li')`));
    const breakdown=await evaluate(`(()=>{const d=document.querySelector('.point-details');return {total:+d.querySelector('p').textContent.split(' dispatches')[0].replaceAll(',',''),sum:[...d.querySelectorAll('li b')].reduce((n,b)=>n+Number(b.textContent.slice(b.textContent.lastIndexOf(':')+1).replaceAll(',','')),0)}})()`);
    assert.equal(breakdown.sum,breakdown.total);
    await screenshot('point-breakdown-desktop');
    await navigate(pageUrl+'?street='+encodeURIComponent('|')+'&point='+encodeURIComponent(pointAudit.coordinate.join(',')));
    assert.equal(await evaluate(`new URLSearchParams(location.search).get('point')`),pointAudit.coordinate.join(','));
    await navigate(pageUrl+'?street='+encodeURIComponent('|'));
    assert.equal(await evaluate(`new URLSearchParams(location.search).get('street')`),null,'Ambiguous legacy coordinate links must not pick the first point');
    await navigate(pageUrl);
    for(const theme of ['light','dark']){
      await send('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true});
      await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
      await evaluate(`document.querySelector('#theme [data-theme="${theme}"]').click()`);
      const tap=await evaluate(`(()=>{const row=document.querySelector('#list .row:not([data-members="1"])');row.scrollIntoView({block:'center',behavior:'instant'});const r=row.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
      await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[tap]});await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(1100);
      await evaluate(`document.querySelector('#map').scrollIntoView({block:'center',behavior:'instant'})`);
      const popup=await evaluate(`(()=>{const p=document.querySelector('#chart-help-dialog'),r=p.getBoundingClientRect();return {open:p.open,left:r.left,right:r.right,width:innerWidth,items:p.querySelectorAll('.point-details ol li').length,close:p.querySelector('#chart-help-close').getBoundingClientRect().height}})()`);
      assert(popup.open && popup.items>1 && popup.left>=0 && popup.right<=popup.width && popup.close>=44,JSON.stringify(popup));
      await screenshot('point-breakdown-mobile-'+theme);
      await evaluate(`document.querySelector('#chart-help-close').click()`);
    }
    await send('Emulation.setTouchEmulationEnabled',{enabled:false});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await navigate(pageUrl);
    console.log('PASS: co-located dispatches share point totals and accessible source breakdowns; coordinate links restore unambiguously on desktop/mobile');

    for (const street of ['HOSPITAL DR','KENNEDY PLAZA APTS HI RISE']) {
      await navigate(pageUrl+'?place=T%3AUTICA&street='+encodeURIComponent(street+'|UTICA'));
      await evaluate(`(()=>{const q=document.querySelector('#q');q.value=${JSON.stringify(street)};q.dispatchEvent(new Event('input'));q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`);
      await delay(1100);
      const note=await evaluate(`document.querySelector('#chart-help-body').textContent`);
      assert(note.includes('Oneida County CAD'),note);
      assert(!note.includes('Unmatched street'),note);
      if(street.includes('APTS')) assert(note.includes('not independently verified'),note);
      await screenshot(street.includes('APTS') ? 'county-complex-details' : 'county-hospital-details');
    }
    await navigate(pageUrl);
    console.log('PASS: recovered county road and complex points disclose their source and uncertainty');

    await send('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true});
    for(const street of ['WHITESBORO MIDDLE SCHOOL','MAIN ST, WHITESBORO']) {
      await navigate(pageUrl+'?place='+encodeURIComponent('V:WHITESTOWN|WHITESBORO'));
      await evaluate(`(()=>{const q=document.querySelector('#q');q.value=${JSON.stringify(street)};q.dispatchEvent(new Event('input'));q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`);
      await delay(1100);
      const detail=await evaluate(`(()=>{const p=document.querySelector('#chart-help-dialog'),r=p.getBoundingClientRect();return {open:p.open,left:r.left,right:r.right,body:document.querySelector('#chart-help-body').textContent}})()`);
      assert(detail.open && detail.left>=0 && detail.right<=320,JSON.stringify(detail));
      assert(detail.body.includes(street),detail.body);
      assert(!detail.body.includes('Unmatched street'),detail.body);
      if(street.includes('SCHOOL')) assert(detail.body.includes('Oneida County CAD') && detail.body.includes('not independently verified'),detail.body);
      else assert(detail.body.includes('matched to MAIN ST'),detail.body);
      await screenshot(street.includes('SCHOOL') ? 'whitesboro-school-mobile' : 'whitesboro-main-alias-mobile');
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await navigate(pageUrl);
    console.log('PASS: Whitesboro school and reviewed Main Street alias retain original labels and usable mobile details');

    for(const street of ['OLD RIVER RD','U TURN']) {
      await navigate(pageUrl+'?place=T%3AMARCY');
      await evaluate(`(()=>{const q=document.querySelector('#q');q.value=${JSON.stringify(street)};q.dispatchEvent(new Event('input'));const d=JSON.parse(document.querySelector('#data').textContent),option=[...document.querySelectorAll('#sugg [data-i]')].find(e=>d.locations[+e.dataset.i][3]==='MARCY');option.click()})()`);
      await delay(1100);
      const detail=await evaluate(`document.querySelector('#chart-help-body').textContent`);
      assert(detail.includes(street),detail);
      if(street==='U TURN') assert(detail.includes('Ambiguous U TURN label') && detail.includes('not an incident site'),detail);
      else assert(detail.includes('Oneida County CAD') && !detail.includes('Unmatched street'),detail);
      await screenshot(street==='U TURN' ? 'marcy-ambiguous-turnaround' : 'marcy-old-river');
    }
    await navigate(pageUrl);
    console.log('PASS: Marcy streets disclose county references and ambiguous turnarounds remain approximate');

    for(const [street,city] of [['PARK DRIVE MNR 2','ROME INSIDE'],['ERIE BLVD BLVD W','ROME INSIDE'],
                                ['ROUTE 26 ROUTE 365 RAMP','ROME OUTSIDE'],['ERIE BLVD','ROME INSIDE']]) {
      await navigate(pageUrl+'?place=T%3AROME');
      await evaluate(`(()=>{const q=document.querySelector('#q');q.value=${JSON.stringify(street)};q.dispatchEvent(new Event('input'));const d=JSON.parse(document.querySelector('#data').textContent),option=[...document.querySelectorAll('#sugg [data-i]')].find(e=>{const l=d.locations[+e.dataset.i];return l[2]===${JSON.stringify(street)}&&l[3]===${JSON.stringify(city)}});option.click()})()`);
      await delay(1100);
      const detail=await evaluate(`document.querySelector('#chart-help-body').textContent`);
      assert(detail.includes(street),detail);
      if(street==='ERIE BLVD') assert(detail.includes('direction not specified') && detail.includes('not an incident site'),detail);
      else {
        assert(detail.includes('Oneida County CAD'),detail);
        assert(!detail.includes('Unmatched street'),detail);
        if(street.includes('MNR')) assert(detail.includes('not independently verified'),detail);
        if(street.includes('BLVD BLVD')) assert(detail.includes('reviewed name correction') && detail.includes('ERIE BLVD WEST'),detail);
      }
      await screenshot('rome-'+street.toLowerCase().replaceAll(' ','-'));
    }
    await navigate(pageUrl);
    console.log('PASS: Rome facilities, corrections and connector ramps disclose estimates; unspecified Erie direction stays approximate');

    await send('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true});
    for(const street of ['NY STATE THRUWAY WB','MARION MANOR','NY STATE THRUWAY RAMP']) {
      await navigate(pageUrl+'?place=T%3AVERONA');
      await evaluate(`(()=>{const q=document.querySelector('#q');q.value=${JSON.stringify(street)};q.dispatchEvent(new Event('input'));const d=JSON.parse(document.querySelector('#data').textContent),option=[...document.querySelectorAll('#sugg [data-i]')].find(e=>{const l=d.locations[+e.dataset.i];return l[2]===${JSON.stringify(street)}&&l[3]==='VERONA'});option.click()})()`);
      await delay(1100);
      const detail=await evaluate(`(()=>{const p=document.querySelector('#chart-help-dialog'),r=p.getBoundingClientRect();return {open:p.open,left:r.left,right:r.right,body:document.querySelector('#chart-help-body').textContent}})()`);
      assert(detail.open && detail.left>=0 && detail.right<=320,JSON.stringify(detail));
      assert(detail.body.includes(street),detail.body);
      if(street.endsWith('RAMP')) assert(detail.body.includes('no exit number or direction') && detail.body.includes('Ambiguous U TURN label'),detail.body);
      else {
        assert(detail.body.includes('Oneida County CAD') && !detail.body.includes('Unmatched street'),detail.body);
        if(street==='MARION MANOR') assert(detail.body.includes('not independently verified'),detail.body);
        else assert(detail.body.includes('INTERSTATE 90 WB') && detail.body.includes('not a verified incident site'),detail.body);
      }
      await screenshot('verona-'+street.toLowerCase().replaceAll(' ','-'));
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await navigate(pageUrl);
    console.log('PASS: Verona highway aliases and facilities disclose estimates on mobile; generic ramps and turnarounds remain approximate');

    await send('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true});
    for(const street of ['ONEIDA SERVICE CENTER','NY STATE THRUWAY RAMP']) {
      await navigate(pageUrl+'?place=T%3AWESTMORELAND');
      await evaluate(`(()=>{const q=document.querySelector('#q');q.value=${JSON.stringify(street)};q.dispatchEvent(new Event('input'));const d=JSON.parse(document.querySelector('#data').textContent),option=[...document.querySelectorAll('#sugg [data-i]')].find(e=>{const l=d.locations[+e.dataset.i];return l[2]===${JSON.stringify(street)}&&l[3]==='WESTMORELAND'});option.click()})()`);
      await delay(1100);
      const detail=await evaluate(`(()=>{const p=document.querySelector('#chart-help-dialog'),r=p.getBoundingClientRect();return {open:p.open,left:r.left,right:r.right,body:document.querySelector('#chart-help-body').textContent}})()`);
      assert(detail.open && detail.left>=0 && detail.right<=320,JSON.stringify(detail));
      assert(detail.body.includes(street),detail.body);
      if(street.endsWith('RAMP')) assert(detail.body.includes('no exit number or direction') && detail.body.includes('not an incident site'),detail.body);
      else assert(detail.body.includes('Oneida County CAD') && detail.body.includes('not independently verified') && !detail.body.includes('Unmatched street'),detail.body);
      await screenshot('westmoreland-'+street.toLowerCase().replaceAll(' ','-'));
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await navigate(pageUrl);
    console.log('PASS: Westmoreland service areas disclose approximate placement on mobile; unspecified ramps remain approximate');

    await send('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true});
    for(const [street,city,place] of [['UTICA ST','CLINTON VILLAGE','V:KIRKLAND|CLINTON'],['NEW CARRIAGE HOUSE APTS','KIRKLAND','T:KIRKLAND']]) {
      await navigate(pageUrl+'?place='+encodeURIComponent(place));
      await evaluate(`(()=>{const q=document.querySelector('#q');q.value=${JSON.stringify(street)};q.dispatchEvent(new Event('input'));const d=JSON.parse(document.querySelector('#data').textContent),option=[...document.querySelectorAll('#sugg [data-i]')].find(e=>{const l=d.locations[+e.dataset.i];return l[2]===${JSON.stringify(street)}&&l[3]===${JSON.stringify(city)}});option.click()})()`);
      await delay(1100);
      const detail=await evaluate(`(()=>{const p=document.querySelector('#chart-help-dialog'),r=p.getBoundingClientRect();return {open:p.open,left:r.left,right:r.right,body:document.querySelector('#chart-help-body').textContent}})()`);
      assert(detail.open && detail.left>=0 && detail.right<=320,JSON.stringify(detail));
      assert(detail.body.includes(street) && detail.body.includes('Kirkland'),detail.body);
      assert(detail.body.includes('Oneida County CAD') && !detail.body.includes('Unmatched street'),detail.body);
      if(city==='CLINTON VILLAGE') assert(detail.body.includes('Clinton'),detail.body);
      else assert(detail.body.includes('not independently verified'),detail.body);
      await screenshot('kirkland-'+street.toLowerCase().replaceAll(' ','-'));
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await navigate(pageUrl);
    console.log('PASS: Clinton village street labels and Kirkland apartments retain reporting areas and source caveats on mobile');

    await send('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true});
    await navigate(pageUrl+'?place='+encodeURIComponent('V:CAMDEN|CAMDEN'));
    await evaluate(`(()=>{const q=document.querySelector('#q');q.value='RIPLEY DR';q.dispatchEvent(new Event('input'));const d=JSON.parse(document.querySelector('#data').textContent),option=[...document.querySelectorAll('#sugg [data-i]')].find(e=>{const l=d.locations[+e.dataset.i];return l[2]==='RIPLEY DR'&&l[3]==='CAMDEN VILLAGE'});option.click()})()`);
    await delay(1100);
    const camdenDetail=await evaluate(`(()=>{const p=document.querySelector('#chart-help-dialog'),r=p.getBoundingClientRect();return {open:p.open,left:r.left,right:r.right,body:document.querySelector('#chart-help-body').textContent}})()`);
    assert(camdenDetail.open && camdenDetail.left>=0 && camdenDetail.right<=320,JSON.stringify(camdenDetail));
    assert(camdenDetail.body.includes('RIPLEY DR') && camdenDetail.body.includes('Camden (village)'),camdenDetail.body);
    assert(camdenDetail.body.includes('Oneida County CAD') && camdenDetail.body.includes('not a verified incident site') && !camdenDetail.body.includes('Unmatched street'),camdenDetail.body);
    await screenshot('camden-ripley-mobile');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await navigate(pageUrl);
    console.log('PASS: Camden village street details retain village labels and road-estimate caveats on mobile');

    for (const width of [390, 1440]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      await navigate(pageUrl);
      for (const [street,city,ambiguity] of [['E MAIN ST','VERONA',false],['ROUTE 291 RAMP','MARCY',false],['ERIE BLVD W','ROME INSIDE',true]]) {
        await evaluate(`(()=>{const q=document.querySelector('#q');q.value=${JSON.stringify(street)};q.dispatchEvent(new Event('input'));
          const d=JSON.parse(document.querySelector('#data').textContent),option=[...document.querySelectorAll('#sugg [data-i]')].find(e=>{const l=d.locations[+e.dataset.i];return l[2]===${JSON.stringify(street)}&&l[3]===${JSON.stringify(city)}});option.click()})()`);
        const detail=await evaluate(`(()=>{const p=document.querySelector('#chart-help-dialog'),r=p.getBoundingClientRect();return {open:p.open,left:r.left,right:r.right,body:document.querySelector('#chart-help-body').textContent}})()`);
        assert(detail.open && detail.left>=0 && detail.right<=width,JSON.stringify(detail));
        assert(detail.body.includes(street),detail.body);
        assert(detail.body.includes(ambiguity?'Ambiguous match':'Oneida County CAD'),detail.body);
        await evaluate(`document.querySelector('#chart-help-dialog').close()`);
      }
    }
    console.log('PASS: directional roads, ramps and separate matching stretches disclose source and ambiguity on mobile and desktop');

    const overlap = await evaluate(`(()=>{const a=document.querySelector('#cmp-a'),b=document.querySelector('#cmp-b');
      a.value='T:WHITESTOWN';a.dispatchEvent(new Event('change'));b.value='V:WHITESTOWN|WHITESBORO';b.dispatchEvent(new Event('change'));
      const first=[...document.querySelectorAll('#cmp-out .cmp-summary tbody tr:first-child td')].slice(1).map(e=>e.textContent);
      a.value='V:WHITESTOWN|WHITESBORO';a.dispatchEvent(new Event('change'));b.value='T:WHITESTOWN';b.dispatchEvent(new Event('change'));
      const reverse=[...document.querySelectorAll('#cmp-out .cmp-summary tbody tr:first-child td')].slice(1).map(e=>e.textContent);return {first,reverse}})()`);
    assert.deepEqual(overlap.first, [fmt(expected.whitestown), fmt(expected.whitesboro)]);
    assert.deepEqual(overlap.reverse, [fmt(expected.whitesboro), fmt(expected.whitestown)]);
    console.log('PASS: overlapping comparison populations are independent');

    const readComparison=()=>evaluate(`Object.fromEntries([...document.querySelectorAll('#cmp-out .cmp-summary tbody tr')].map(r=>[r.children[0].textContent,[r.children[1].textContent,r.children[2].textContent]]))`);
    await navigate(pageUrl);
    const summary=await readComparison();
    for(const [k,name] of ['UTICA','ROME'].entries()) {
      const a=expected.comparison.towns[name];
      assert.equal(summary['Dispatches'][k],fmt(a.n));
      assert.equal(summary['Medical share'][k],(100*a.medical/a.n).toFixed(1)+'%');
      assert.equal(summary['Medical dispatches without a priority code'][k],fmt(a.medical-a.priority));
      assert.equal(summary['Delta/Echo among priority-coded medical dispatches'][k],(100*a.de/a.priority).toFixed(1)+'%');
    }
    const fullDay=await evaluate(`document.querySelector('#cmp-out .la').getAttribute('d')`);
    await navigate(pageUrl+'?hour=3');
    assert.equal(await evaluate(`document.querySelector('#cmp-out .la').getAttribute('d')`),fullDay);
    const keyboardHour=await evaluate(`(()=>{const r=document.querySelector('#cmp-out [data-compare-hour="0"]');r.focus();r.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return {hour:document.activeElement.dataset.compareHour,detail:document.querySelector('#cmp-hour-detail').textContent}})()`);
    assert.equal(keyboardHour.hour,'1');assert(keyboardHour.detail.startsWith('01:00:'));
    const openHours=await evaluate(`(()=>{const d=document.querySelector('#cmp-out details');d.open=true;return d.querySelectorAll('tbody tr').length})()`);
    assert.equal(openHours,24);await delay(100);
    assert(await evaluate(`document.querySelector('#cmp-out details').open`));
    for(const query of ['cat=MEDICAL','type=EMS%20CALL']) {
      await navigate(pageUrl+'?'+query);
      assert.deepEqual((await readComparison())['Medical share'],['100.0%','100.0%']);
    }
    console.log('PASS: comparison medical counts match CSV classifications; full-day hourly values support keyboard inspection and stay expanded');

    const yearQuery='?compare=year&compareA=2024&compareB=2026';
    const dateEntries=Object.entries(expected.comparison.dates);
    await navigate(pageUrl+yearQuery);const yearSummary=await readComparison();
    await navigate(pageUrl+yearQuery+'&date=2024-01-01');
    assert.deepEqual(await readComparison(),yearSummary);
    assert((await evaluate(`document.querySelector('#cmp-scope').textContent`)).includes('2024-01-01 remains selected elsewhere'));
    const missingMonth=Array.from({length:12},(_,m)=>m+1).find(m=>dateEntries.some(([iso])=>iso.startsWith('2024')&&+iso.slice(5,7)===m)&&!dateEntries.some(([iso])=>iso.startsWith('2026')&&+iso.slice(5,7)===m));
    if(missingMonth) {
      await navigate(pageUrl+yearQuery+'&month='+missingMonth);
      const missing=await readComparison();
      assert.equal(missing['Dispatches'][1],'No reports available');
      assert.equal(missing['Report days'][1],'0');
      assert(!await evaluate(`!!document.querySelector('#cmp-out .cmp-chart path.lb')`));
      assert((await evaluate(`document.querySelector('#cmp-out').innerText`)).includes('2026 reports omit'));
    }
    await navigate(pageUrl+yearQuery);
    const commonLink=await evaluate(`(()=>{const c=document.querySelector('#cmp-common');c.click();return location.href})()`);
    assert(new URL(commonLink).searchParams.get('comparePeriod')==='common');
    const commonSummary=await readComparison();
    const mdSets=[2024,2026].map(y=>new Set(dateEntries.filter(([iso])=>iso.startsWith(String(y))).map(([iso])=>iso.slice(5))));
    const sharedDates=new Set([...mdSets[0]].filter(md=>mdSets[1].has(md)));
    for(const [k,y] of [2024,2026].entries()) {
      const dates=dateEntries.filter(([iso])=>iso.startsWith(String(y))&&sharedDates.has(iso.slice(5)));
      assert.equal(commonSummary['Report days'][k],fmt(dates.length));
      assert.equal(commonSummary['Dispatches'][k],fmt(dates.reduce((s,[,a])=>s+a.n,0)));
    }
    await navigate(commonLink);
    assert(await evaluate(`document.querySelector('#cmp-common').checked`));
    assert.deepEqual(await readComparison(),commonSummary);
    await evaluate(`document.querySelector('#reset').click()`);
    assert(!await evaluate(`document.querySelector('#cmp-common').checked`));
    assert(!new URL(await evaluate('location.href')).searchParams.has('comparePeriod'));
    console.log('PASS: year comparisons disclose ignored dates, suppress missing-report lines and share/reset matched calendar periods');

    const agency = await evaluate(`(()=>{document.querySelector('#reset').click();
      const d=JSON.parse(document.querySelector('#data').textContent),u=d.agencies.indexOf('AmCare Ambulance');
      const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));const units=bytes(d.records.u),ids=new Uint32Array(bytes(d.records.i).buffer);
      const expected=new Set();let n=0;for(let i=0;i<units.length;i++)if(units[i]===u){expected.add(ids[i]);n++}
      document.querySelector('#resp-list [data-u="'+u+'"]').click();
      return {n,incidents:expected.size,total:document.querySelector('#total').textContent,kpis:[...document.querySelectorAll('#resp-kpis b')].map(e=>e.textContent)}})()`);
    assert.equal(agency.total, agency.n.toLocaleString('en-US'));
    assert.equal(agency.kpis[0], agency.total);
    assert.equal(agency.kpis[1], '≈ ' + agency.incidents.toLocaleString('en-US'));
    console.log('PASS: individual agency summaries count matching dispatches and distinct incidents');

    const rates = await evaluate(`(()=>{document.querySelector('#reset').click();document.querySelector('#heat [data-k="dow:0"]').click();
      const ranking=document.querySelector('#pc-list [data-place="T:UTICA"] .v').textContent;
      const row=[...document.querySelectorAll('#cmp-out tbody tr')].find(e=>e.firstChild.textContent.startsWith('Per 1,000'));
      return {ranking,comparison:row.children[1].textContent}})()`);
    assert.equal(rates.ranking, rates.comparison);
    console.log('PASS: population ranking and comparison use the same observed weekday counts');

    await navigate(pageUrl);
    const pcObserved=await evaluate(`(()=>{
      const d=JSON.parse(document.querySelector('#data').textContent);
      return {pop:d.population,county:document.querySelector('#pc-list .v').childNodes[0].textContent,
        utica:document.querySelector('#pc-list [data-place="T:UTICA"] .v').textContent,
        note:document.querySelector('#pc-location-note').textContent,coverage:document.querySelector('#pc-coverage').textContent};
    })()`);
    const fmt1=n=>n>=100 ? fmt(Math.round(n)) : n>=10 ? n.toFixed(1) : n.toFixed(2);
    assert.equal(pcObserved.county,fmt1(expected.population.all.known/pcObserved.pop.ALL*1000));
    assert.equal(pcObserved.utica,fmt1(expected.population.all.utica/pcObserved.pop['T:UTICA']*1000));
    assert(pcObserved.note.includes(fmt(expected.population.all.unknown)+' dispatches without an assigned town'));
    assert(pcObserved.coverage.includes('not annual rates'));
    const afterPlace=await evaluate(`(()=>{const c=document.querySelector('#city');c.value='T:UTICA';c.dispatchEvent(new Event('change'));return document.querySelector('#pc-list .v').childNodes[0].textContent})()`);
    assert.equal(afterPlace,pcObserved.county);
    await navigate(pageUrl+'?year=2024&rate=annual');
    const pcAnnual=await evaluate(`({value:document.querySelector('#pc-list [data-place="T:UTICA"] .v').textContent,coverage:document.querySelector('#pc-coverage').textContent,mode:document.querySelector('#pc-scale [aria-pressed="true"]').dataset.scale})`);
    const yearDays=expected.seasonal['2024'].reduce((s,a)=>s+a.days,0);
    assert.equal(pcAnnual.value,fmt1(expected.population.years['2024'].utica/pcObserved.pop['T:UTICA']*1000*366/yearDays));
    assert.equal(pcAnnual.mode,'annual');
    assert(pcAnnual.coverage.includes('not a measured full-year total'));
    const incompleteYear=Object.keys(expected.seasonal).find(y=>{
      const months=expected.seasonal[y];
      const totalDays=(Date.UTC(+y+1,0,1)-Date.UTC(+y,0,1))/864e5;
      return months.reduce((s,a)=>s+a.days,0)/totalDays<.9 || months.slice(1).some((a,m)=>a.days/new Date(Date.UTC(+y,m+1,0)).getUTCDate()<.8);
    });
    for (const query of ['rate=annual',...(incompleteYear ? ['year='+incompleteYear+'&rate=annual'] : []),'year=2024&month=1&rate=annual','year=2024&day=mon&rate=annual','year=2024&hour=0&rate=annual','date=2024-01-01&rate=annual']) {
      await navigate(pageUrl+'?'+query);
      const withheld=await evaluate(`({value:document.querySelector('#pc-list [data-place="T:UTICA"] .v').textContent,coverage:document.querySelector('#pc-coverage').textContent,bars:[...document.querySelectorAll('#pc-list .bar')].every(b=>b.hidden)})`);
      assert.equal(withheld.value,'\u2014',query);
      assert(withheld.coverage.includes('Rates withheld') && withheld.bars,query);
    }
    await evaluate(`document.querySelector('#reset').click()`);
    assert.equal(await evaluate(`document.querySelector('#pc-scale [aria-pressed="true"]').dataset.scale`),'observed');
    assert(!await evaluate(`location.search.includes('rate=annual')`));
    console.log('PASS: population rates match independent CSV totals, use assigned-location benchmarks and guard annual scaling including leap years');

    const group = await evaluate(`(()=>{document.querySelector('#reset').click();const c=document.querySelector('#cat');c.value='MEDICAL';c.dispatchEvent(new Event('change'));
      const before=document.querySelector('#total').textContent;document.querySelector('#mix button[data-mix^="g:"]').click();
      return {before,after:document.querySelector('#total').textContent,url:location.href,type:document.querySelector('#type').value}})()`);
    assert.notEqual(group.after, group.before);
    assert(group.type.startsWith('group:'));
    await navigate(group.url);
    assert.equal(await evaluate(`document.querySelector('#total').textContent`), group.after);
    console.log('PASS: grouped medical complaint filters and share links');

    const downloads = await evaluate(`(async()=>{document.querySelector('#reset').click();let blob;
      const create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;
      try {URL.createObjectURL=b=>{blob=b;return 'blob:review'};HTMLAnchorElement.prototype.click=function(){};
      document.querySelector('#dl-dispatches').click();const csv=await blob.text(),lines=csv.split('\\r\\n');
      document.querySelector('#dl-places').click();const places=await blob.text();
      return {rows:lines.length-1,header:lines[0],placesRows:places.split('\\r\\n').length-1}} finally {URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click}})()`);
    assert.equal(downloads.rows, expected.total);
    for (const name of ['call_datetime', 'agency', 'reported_latitude', 'source_file', 'incident_cluster_id', 'reported_city_raw', 'matched_reference_name', 'matched_stretches']) assert(downloads.header.includes(name));
    assert(downloads.placesRows > 0);
    console.log('PASS: downloads retain all matching dispatches and source metadata');

    const keyboard = await evaluate(`(()=>{const cell=document.querySelector('#heat .cell[tabindex="0"]');cell.focus();
      cell.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));const next=document.activeElement.dataset.k;
      const date=document.querySelector('#cal .day.has[tabindex="0"]');date.focus();date.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      const dated=location.search.includes('date=');document.querySelector('#reset').click();
      const urgency=document.querySelector('#urg-stack .col');urgency.focus();urgency.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      const hourly=location.search.includes('hour=0');document.querySelector('#reset').click();
      const q=document.querySelector('#q');q.value='GENESEE';q.dispatchEvent(new Event('input'));
      const active=q.getAttribute('aria-activedescendant');
      const unnamed=[...document.querySelectorAll('[role="button"]')].filter(e=>!(e.innerText||e.textContent||'').trim()&&!e.getAttribute('aria-label')&&!e.title).length;
      return {next,dated,hourly,active,validActive:!!document.getElementById(active),unnamed}})()`);
    assert.equal(keyboard.next, 'cell:0:1');
    assert(keyboard.dated && keyboard.hourly && keyboard.validActive);
    assert.equal(keyboard.unnamed, 0);
    console.log('PASS: chart keyboard navigation, names and search active descendant');

    const shared = await evaluate(`(()=>{document.querySelector('#cmp-mode [data-m="year"]').click();document.querySelector('#pc-mode [data-m="V"]').click();return location.href})()`);
    await navigate(shared);
    assert.equal(await evaluate(`document.querySelector('#cmp-mode [aria-pressed="true"]').textContent`), 'Years');
    assert.equal(await evaluate(`document.querySelector('#pc-mode [aria-pressed="true"]').textContent`), 'Villages');
    // An explicit camera position must survive a link even when a town is selected.
    const cameraLink = new URL(shared);
    cameraLink.searchParams.set('view', '43.11,-75.25,15');
    cameraLink.searchParams.set('place', 'T:UTICA');
    await navigate(cameraLink.href);
    const camera = await evaluate(`(()=>{const url=new URL(location.href);return url.searchParams.get('view')})()`);
    const [latitude, longitude, zoom] = camera.split(',').map(Number);
    // Leaflet rounds projected centers to pixels; allow one pixel at this zoom.
    assert(Math.abs(latitude - 43.11) < 0.00004 && Math.abs(longitude + 75.25) < 0.00004);
    assert.equal(zoom, 15);
    console.log('PASS: comparison and population display modes survive shared links');

    for (const [width, height, mobile] of [[800, 600, false], [390, 844, true]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await evaluate(`scrollTo(0,0)`);
      await delay(200);
      const geometry = await evaluate(`({mapBottom:document.querySelector('#map').getBoundingClientRect().bottom,patternsTop:document.querySelector('#patterns').getBoundingClientRect().top,
        width:innerWidth,scrollWidth:document.body.scrollWidth,filterWidths:[...document.querySelectorAll('.filters select')].map(e=>e.getBoundingClientRect().width)})`);
      assert(geometry.mapBottom <= geometry.patternsTop + 1, JSON.stringify(geometry));
      assert(geometry.scrollWidth <= geometry.width);
      if (mobile) assert(Math.max(...geometry.filterWidths) - Math.min(...geometry.filterWidths) < 1);
    }
    await evaluate(`document.querySelector('#reset').click();document.documentElement.style.scrollBehavior='auto';document.activeElement.blur();scrollTo(0,0)`);
    await screenshot('mobile');
    const themes = await evaluate(`(()=>{document.querySelector('#theme [data-theme="light"]').click();const light=getComputedStyle(document.body).backgroundColor;
      document.querySelector('#theme [data-theme="dark"]').click();return [light,getComputedStyle(document.body).backgroundColor]})()`);
    assert.notEqual(themes[0], themes[1]);
    assert.deepEqual(errors, []);
    console.log('PASS: desktop/mobile layouts, themes and no JavaScript exceptions');

    await navigate(pageUrl);
    const medicalRead=()=>evaluate(`({summary:document.querySelector('#urg-insight').innerText,rows:[...document.querySelectorAll('#urg-table tr')].map(r=>[...r.children].slice(1).map(c=>c.textContent)),benchmark:document.querySelector('#urg-towns .avgmark')?.title})`);
    const medical=await medicalRead(), codedMedical=c=>c.slice(1).reduce((a,b)=>a+b,0);
    assert(await evaluate(`document.querySelector('#urg-hour-detail').getBoundingClientRect().height>0`),'Hourly medical details must remain visible outside the help popup');
    assert((await evaluate(`document.querySelector('#urg-table tr th').textContent`)).includes('00:00\u201301:00'));
    assert.equal(medical.rows.length,24);
    expected.medical.hours.forEach((c,h)=>{
      assert.equal(medical.rows[h][0],fmt(codedMedical(c)));
      assert.equal(medical.rows[h][1],fmt(c[0]));
      c.slice(1).forEach((n,k)=>assert(medical.rows[h][k+2].startsWith(fmt(n)+' (')));
    });
    const coded=expected.medical.hours.reduce((n,c)=>n+codedMedical(c),0),missing=expected.medical.hours.reduce((n,c)=>n+c[0],0);
    assert(medical.summary.includes(fmt(coded)+' with a priority code and '+fmt(missing)+' without one'));
    const [countyCoded,countyDE]=expected.medical.county;
    assert(medical.benchmark.includes((100*countyDE/countyCoded).toFixed(1)+'%') && medical.benchmark.includes(fmt(countyDE)+' of '+fmt(countyCoded)));
    await evaluate(`document.querySelector('#urg-table').closest('details').open=true;document.querySelector('#urg-stack [data-k="hour:7"]').click()`);
    const selectedMedical=await medicalRead(),h7=expected.medical.hours[7];
    assert(selectedMedical.summary.includes(fmt(codedMedical(h7))+' with a priority code and '+fmt(h7[0])+' without one'));
    assert.deepEqual(selectedMedical.rows,medical.rows,'Full-day table must remain visible under the hour filter');
    assert(await evaluate(`document.querySelector('#urg-table').closest('details').open`));
    await navigate(pageUrl+'?day=mon');
    const medKeyboard=await evaluate(`(()=>{const el=document.querySelector('#urg-stack [data-k="hour:6"]');el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));const moved=document.activeElement.dataset.k,detail=document.querySelector('#urg-hour-detail').innerText;document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return {moved,detail,url:location.href}})()`);
    assert.equal(medKeyboard.moved,'hour:7');assert(medKeyboard.detail.includes('Delta:')&&medKeyboard.detail.includes('without a priority code'));
    assert.equal(new URL(medKeyboard.url).searchParams.get('day'),'mon');
    assert.equal(new URL(medKeyboard.url).searchParams.get('hour'),'7');
    const monday=expected.medical.mondayHours[7];
    assert((await medicalRead()).summary.includes(fmt(codedMedical(monday))+' with a priority code and '+fmt(monday[0])+' without one'));
    await evaluate(`(()=>{const e=document.querySelector('#medical-section [data-hour-picker]');e.value='8';e.dispatchEvent(new Event('change'))})()`);
    assert.equal(new URL(await evaluate('location.href')).searchParams.get('day'),'mon');
    await navigate(pageUrl+'?type=EMS%20CALL');
    const uncodedMedical=await medicalRead();
    assert(uncodedMedical.summary.includes('0 with a priority code')&&uncodedMedical.summary.includes('Priority shares unavailable.'));
    assert(!uncodedMedical.summary.includes('No medical dispatches'));
    assert(uncodedMedical.rows[0][2].includes('\u2014'),'Unavailable shares must use a dash');
    for(const [width,mobile] of [[1440,false],[320,true]]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile});
      await navigate(pageUrl);
      await evaluate(`document.querySelector('#medical-section').scrollIntoView({behavior:'instant',block:'start'})`);
      const bounds=await evaluate(`({width:innerWidth,scroll:document.body.scrollWidth,detail:document.querySelector('#urg-hour-detail').getBoundingClientRect().right})`);
      assert(bounds.scroll<=bounds.width&&bounds.detail<=bounds.width,JSON.stringify(bounds));
      await screenshot('medical-'+width);
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await navigate(pageUrl);
    console.log('PASS: medical priority counts, missing codes and county benchmark match CSV; hour/weekday filters, keyboard details, table and mobile layout work');
    const policeSummary=await evaluate(`document.querySelector('#pol-insight').innerText`);
    const policeTotal=expected.policeCounts.reduce((a,b)=>a+b,0);
    assert(policeSummary.includes('Of '+fmt(policeTotal)+' police dispatches,'));
    for(const count of expected.policeCounts) {
      const pct=100*count/policeTotal;
      const formatted=count===0?'0%':count===policeTotal?'100%':pct<0.1?'<0.1%':pct>99.9?'>99.9%':pct.toFixed(1)+'%';
      assert(policeSummary.includes(formatted+' ('+fmt(count)+')'));
    }
    assert(policeSummary.includes('This compares proportions, not dispatch volume.'));
    console.log('PASS: police summary percentages and counts match the CSV without rounding small shares to zero');
    const policeHour = await evaluate(`(()=>{
      const d=JSON.parse(document.querySelector('#data').textContent),bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
      const units=bytes(d.records.u),hours=bytes(d.records.h),police=new Set(['LOCAL_POLICE','SHERIFF','STATE_POLICE','CAMPUS_POLICE']);
      let expected=0;for(let i=0;i<units.length;i++)if(hours[i]===7&&police.has(d.agencyKind[units[i]]))expected++;
      document.querySelector('#pol-hour [data-k="hour:7"]').click();
      return {expected,text:document.querySelector('#pol-insight').innerText,legend:document.querySelector('#pol-list').parentElement.innerText};
    })()`);
    assert(policeHour.text.includes('Of ' + policeHour.expected.toLocaleString('en-US') + ' police dispatches,'));
    assert(policeHour.legend.includes('Other dispatch types'));
    assert(!policeHour.legend.includes('calls from the public'));
    console.log('PASS: police summary uses the selected hour and describes estimated dispatch types');

    const zeroMonth=Object.keys(expected.policeMonths).find(m=>expected.policeMonths[m].some(v=>v.n>=20&&v.initiated===0));
    await navigate(pageUrl + '?agency=Utica%20Police%20Department&year=2026&month='+zeroMonth);
    const zeroHour=expected.policeMonths[zeroMonth].findIndex(v=>v.n>=20 && v.initiated===0);
    assert(zeroHour>=0,'Expected an eligible hour with a genuine zero officer-initiated share');
    const policeMinimum = await evaluate(`({text:document.querySelector('#pol-insight').innerText,
      zero:document.querySelector('#pol-hour [data-k="hour:${zeroHour}"]').getAttribute('aria-label')})`);
    const range=String(zeroHour).padStart(2,'0')+':00\u2013'+String((zeroHour+1)%24).padStart(2,'0')+':00';
    assert(policeMinimum.text.includes('lowest during '+range+' (0%)') || policeMinimum.text.includes('0% at every hour with at least 20 dispatches.'));
    assert(policeMinimum.zero.includes('0% likely officer-initiated'));
    const sparseDate=Object.keys(expected.policeDates).sort().find(d=>expected.policeDates[d].some(n=>n>0&&n<20));
    const sparseHour=expected.policeDates[sparseDate].findIndex(n=>n>0&&n<20);
    await navigate(pageUrl+'?agency=Utica%20Police%20Department&date='+sparseDate);
    assert((await evaluate(`document.querySelector('#pol-hour [data-k="hour:${sparseHour}"]').getAttribute('aria-label')`)).includes('insufficient data'));
    console.log('PASS: genuine zero shares remain eligible and sparse hours are marked insufficient');

    await navigate(pageUrl + '?cat=MEDICAL&responder=EMS');
    const policeClick = await evaluate(`(()=>{
      // EMS hides police rows; restore responder while retaining the ignored medical filter.
      const a=document.querySelector('#agency');a.value='-1';a.dispatchEvent(new Event('change'));
      document.querySelector('#pol-list [data-u]').click();return {category:document.querySelector('#cat').value,total:document.querySelector('#total').innerText}})()`);
    assert.equal(policeClick.category, 'ALL');
    assert.notEqual(policeClick.total, '0');
    await navigate(pageUrl + '?cat=MEDICAL&responder=FIRE');
    const incompatibleClick = await evaluate(`(()=>{document.querySelector('#flow-kind [data-k="EMS"]').click();
      document.querySelector('#flow-list [data-dest]').click();return {responder:document.querySelector('#agency').value,total:document.querySelector('#total').innerText}})()`);
    assert.equal(incompatibleClick.responder, '-1');
    assert.notEqual(incompatibleClick.total, '0');
    console.log('PASS: analysis selections clear incompatible category and responder filters');

    await navigate(pageUrl);
    const outside = await evaluate(`(()=>{const before=document.querySelector('#out-list').innerText;
      const unknown=document.querySelector('#flow-insight').innerText;
      const c=document.querySelector('#city');c.value='T:UTICA';c.dispatchEvent(new Event('change'));
      const changed=document.querySelector('#out-list').innerText!==before;
      document.querySelector('#reset').click();const a=document.querySelector('#agency');
      const d=JSON.parse(document.querySelector('#data').textContent);a.value=d.agencyTypes.indexOf('FIRE');a.dispatchEvent(new Event('change'));
      return {changed,unknown,out:document.querySelector('#out-list').innerText,
        kinds:[...document.querySelectorAll('#out-list [data-u]')].map(e=>d.agencyKind[+e.dataset.u])}})()`);
    assert(outside.changed);
    assert(outside.kinds.length > 0 && outside.kinds.every(k => k === 'FIRE'));
    assert(outside.unknown.includes('with known destinations'));
    assert(outside.unknown.includes(fmt(expected.fireUnknown) + ' dispatches with unknown destinations excluded'), outside.unknown + ' / expected ' + expected.fireUnknown);
    assert(outside.out.includes(fmt(expected.fireUnknown) + ' dispatches with unknown destinations excluded'), outside.out.slice(-120) + ' / expected ' + expected.fireUnknown);
    console.log('PASS: outside-town ranking applies place/responders and discloses unknown destinations');

    await navigate(pageUrl);
    const outsideAll = await evaluate(`(()=>{
      document.querySelector('#out-expand').click();
      const d=JSON.parse(document.querySelector('#data').textContent);
      return [...document.querySelectorAll('#out-list [data-u]')].map(r=>({name:d.agencies[+r.dataset.u],text:r.innerText,value:r.querySelector('.v').innerText}));
    })()`);
    assert.equal(outsideAll.length, Object.values(expected.outside).filter(a => a.known >= 40).length);
    for (const row of outsideAll) {
      const a=expected.outside[row.name];
      assert(row.value.startsWith((100*a.out/a.known).toFixed(0)+'%'), row.name);
      assert(row.value.includes(`${fmt(a.out)} of ${fmt(a.known)} known`), row.name);
      assert(row.text.includes(`${fmt(a.unknown)} of ${fmt(a.known+a.unknown)} destinations unknown`), row.name);
      assert.equal(row.text.includes('Limited location coverage.'), a.unknown/(a.known+a.unknown)>=.2, row.name);
    }
    const townOutside = await evaluate(`(()=>{
      const c=document.querySelector('#city');c.value='T:WHITESTOWN';c.dispatchEvent(new Event('change'));
      const d=JSON.parse(document.querySelector('#data').textContent);
      return [...document.querySelectorAll('#out-list [data-u]')].map(r=>({name:d.agencies[+r.dataset.u],value:r.querySelector('.v').innerText}));
    })()`);
    for (const name of ['COCVAC Ambulance','New York Mills Fire Department']) {
      const row=townOutside.find(r=>r.name===name), a=expected.outside[name];
      assert(row, name);
      assert(row.value.startsWith((100*a.out/a.known).toFixed(0)+'%'), name+' must retain its all-destination percentage');
    }
    await navigate(pageUrl);
    const retained = await evaluate(`(()=>{
      const button=document.querySelector('#out-expand');button.click();
      const rows=[...document.querySelectorAll('#out-list [data-u]')],last=rows.at(-1),u=last.dataset.u;
      last.click();button.click();
      const selected=document.querySelector('#out-list [data-u="'+u+'"]');
      return {name:JSON.parse(document.querySelector('#data').textContent).agencies[+u],selected:!!selected?.classList.contains('on'),expanded:button.getAttribute('aria-expanded'),count:document.querySelectorAll('#out-list [data-u]').length,text:document.querySelector('#out-list').innerText};
    })()`);
    assert(retained.selected);
    assert.equal(retained.expanded,'false');
    assert.equal(retained.count,13);
    assert(retained.text.includes('Selected agency also shown.'));
    await navigate(pageUrl+'?date=2024-01-01&agency='+encodeURIComponent(retained.name));
    const sparseOutside=await evaluate(`(()=>{const r=document.querySelector('#out-list .on');return {text:r?.innerText,value:r?.querySelector('.v').innerText}})()`);
    assert(sparseOutside.text.includes('Fewer than 40 known destinations; percentage withheld.'));
    assert(!sparseOutside.value.includes('%'));
    await navigate(pageUrl);
    for (const width of [1440,320]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===320});
      for (const theme of ['light','dark']) {
        const layout=await evaluate(`(()=>{
          document.documentElement.dataset.theme='${theme}';
          const panel=document.querySelector('#outside-section');panel.scrollIntoView({behavior:'instant',block:'start'});
          const box=panel.getBoundingClientRect();
          return {fits:panel.scrollWidth<=panel.clientWidth,rows:[...panel.querySelectorAll('.rank-row')].every(r=>r.scrollWidth<=r.clientWidth),left:box.left,right:box.right,width:innerWidth};
        })()`);
        assert(layout.fits && layout.rows && layout.left>=0 && layout.right<=layout.width, JSON.stringify(layout));
        await screenshot('agency-coverage-'+width+'-'+theme);
      }
    }
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    console.log('PASS: agency coverage percentages retain all destinations, disclose missing locations, expand fully and retain sparse selections');

    await navigate(pageUrl + '?place=C%3AHERKIMER');
    const countyRoute = await evaluate(`(()=>{const row=document.querySelector('#flow-list [data-dest="C:HERKIMER"]');
      if(!row)return null;row.click();return {place:document.querySelector('#city').value,url:location.href}})()`);
    assert(countyRoute);
    assert.equal(countyRoute.place, 'C:HERKIMER');
    assert(new URL(countyRoute.url).searchParams.get('place') === 'C:HERKIMER');
    // A county route must also work when selected from a different place filter.
    await navigate(pageUrl);
    const countyClick = await evaluate(`(()=>{const list=document.querySelector('#flow-list');
      const row=document.createElement('div');row.dataset.dest='C:HERKIMER';list.append(row);row.click();return document.querySelector('#city').value})()`);
    assert.equal(countyClick, 'C:HERKIMER');
    console.log('PASS: county destinations can be selected through route controls');

    const smallSample = await evaluate(`(()=>{const d=JSON.parse(document.querySelector('#data').textContent),bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
      const units=bytes(d.records.u),dates=new Uint16Array(bytes(d.records.d).buffer),counts=new Map();
      for(let i=0;i<units.length;i++)if(d.agencyKind[units[i]]==='CAMPUS_POLICE'){
        const key=dates[i]+':'+units[i];counts.set(key,(counts.get(key)||0)+1)}
      const days=[...new Set([...counts.keys()].map(k=>+k.split(':')[0]))];
      return d.dates[days.find(day=>[...counts].filter(([k])=>+k.split(':')[0]===day).every(([,n])=>n<20))];})()`);
    assert(smallSample);
    await navigate(pageUrl + '?responder=CAMPUS_POLICE&date=' + smallSample);
    const sampleText = await evaluate(`document.querySelector('#pol-list').innerText`);
    assert(sampleText.includes('fewer than 20'));
    assert(!sampleText.includes('No police dispatches'));
    assert.deepEqual(errors, []);
    console.log('PASS: department ranking distinguishes a small sample from no matching dispatches');

    await navigate(pageUrl);
    await evaluate(`document.documentElement.style.scrollBehavior='auto';document.querySelector('#pol-hour').scrollIntoView({behavior:'instant',block:'center'})`);
    await screenshot('policing-mobile');
    await evaluate(`document.querySelector('#flowmap').scrollIntoView({behavior:'instant',block:'center'})`);
    await screenshot('flows-mobile');

    await navigate(pageUrl);
    await evaluate(`(()=>{const q=document.querySelector('#q');q.value='GENESEE';q.dispatchEvent(new Event('input'));
      q.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
    assert.equal(await evaluate(`document.querySelector('#q').getAttribute('aria-expanded')`), 'false');
    assert.deepEqual(errors, []);
    console.log('PASS: Escape then Enter safely closes street suggestions');

    await navigate(pageUrl + '?year=2026');
    const yearTrend = await evaluate(`({years:[...document.querySelectorAll('#trend svg')].map(e=>e.dataset.year),text:document.querySelector('#trend-insight').innerText})`);
    assert.deepEqual(yearTrend.years, ['2026']);
    assert(!yearTrend.text.includes('2024'));
    const trendKeys = await evaluate(`(()=>{const chart=document.querySelector('#trend svg');chart.focus();
      chart.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));
      chart.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
      const detail=document.querySelector('#trend-detail-2026').innerText;
      chart.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      const d=JSON.parse(document.querySelector('#data').textContent);
      return {date:new URL(location.href).searchParams.get('date'),expected:d.dates.filter(s=>s.startsWith('2026'))[1],detail,focused:document.activeElement.dataset.year}})()`);
    assert.equal(trendKeys.date, trendKeys.expected);
    assert.equal(trendKeys.focused, '2026');
    assert(trendKeys.detail.includes('dispatches'));
    console.log('PASS: trend honors year filters and supports keyboard exploration and selection');

    await navigate(pageUrl);
    const rankFocus = await evaluate(`(()=>{const row=document.querySelector('#resp-list [data-u]');const unit=row.dataset.u;row.focus();
      row.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      return {unit,focused:document.activeElement.dataset.u}})()`);
    assert.equal(rankFocus.focused, rankFocus.unit);
    await send('Input.dispatchKeyEvent', { type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9 });
    await send('Input.dispatchKeyEvent', { type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9 });
    const focusStyle = await evaluate(`({style:getComputedStyle(document.activeElement).outlineStyle,width:getComputedStyle(document.activeElement).outlineWidth})`);
    assert.equal(focusStyle.style, 'solid');
    assert.equal(focusStyle.width, '2px');
    console.log('PASS: agency filtering preserves keyboard focus and visible focus styling');

    await navigate(pageUrl + '?place=T%3AROME');
    const resetSearch = await evaluate(`(()=>{const q=document.querySelector('#q');q.value='GENESEE';q.dispatchEvent(new Event('input'));document.querySelector('#sugg li').click();
      const before=document.querySelector('#qnote').innerText;document.querySelector('#reset').click();
      return {before,query:q.value,note:document.querySelector('#qnote').innerText,suggestions:document.querySelector('#sugg').childElementCount}})()`);
    assert(resetSearch.before.includes('No dispatches'));
    assert.equal(resetSearch.query, '');assert.equal(resetSearch.note, '');assert.equal(resetSearch.suggestions, 0);
    console.log('PASS: reset clears search text, suggestions and stale messages');

    const flowLink = await evaluate(`(()=>{document.querySelector('#flow-kind [data-k="EMS"]').click();return {url:location.href,reset:document.querySelector('#reset').hidden}})()`);
    assert.equal(flowLink.reset, false);
    await navigate(flowLink.url);
    assert.equal(await evaluate(`document.querySelector('#flow-kind [aria-pressed="true"]').dataset.k`), 'EMS');
    await evaluate(`document.querySelector('#reset').click()`);
    assert.equal(await evaluate(`document.querySelector('#flow-kind [aria-pressed="true"]').dataset.k`), 'FIRE');
    assert.equal(new URL(await evaluate(`location.href`)).searchParams.get('flow'), null);
    console.log('PASS: response-flow mode survives sharing and returns to fire on reset');

    await navigate(pageUrl + '?cat=PROPERTY_CRIME&responder=EMS');
    assert.equal(await evaluate(`document.querySelector('#total').innerText`), '0');
    const emptyHeat = await evaluate(`document.querySelector('#heat-insight').innerText`);
    assert(emptyHeat.includes('No dispatches'));
    assert(!emptyHeat.includes('Busiest') && !emptyHeat.includes('peak'));
    console.log('PASS: empty heatmap suppresses busiest/quietest claims');

    await navigate(pageUrl);
    for (const theme of ['light','dark']) {
      await evaluate(`document.querySelector('#theme [data-theme="${theme}"]').click()`);await delay(100);
      const ratios = await evaluate(`(()=>{const rgb=s=>s.match(/[\\d.]+/g).slice(0,3).map(Number);
        const lum=s=>rgb(s).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
        const contrast=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
        const labels=[...document.querySelectorAll('#resp-size span')].filter(e=>e.innerText.trim()).map(e=>{const s=getComputedStyle(e);return contrast(s.color,s.backgroundColor)});
        const avg=getComputedStyle(document.querySelector('#trend .avg')).stroke,bg=getComputedStyle(document.querySelector('#trend').closest('.card')).backgroundColor;
        return {labels,average:contrast(avg,bg)}})()`);
      assert(ratios.labels.every(r=>r>=4.5), JSON.stringify(ratios));
      assert(ratios.average>=3, JSON.stringify(ratios));
    }
    console.log('PASS: incident percentages and trend averages have readable contrast in both themes');

    for (const width of [320,390]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});await delay(150);
      const narrow = await evaluate(`({inner:innerWidth,scroll:document.documentElement.scrollWidth,
        cards:[...document.querySelectorAll('.card')].filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>e.querySelector('h2')?.innerText),
        pickerHeights:[...document.querySelectorAll('[data-hour-picker],#report-date')].map(e=>e.getBoundingClientRect().height),
        years:[...document.querySelectorAll('#trend svg')].map(e=>e.dataset.year),
        mobileSpikeLabels:document.querySelectorAll('#trend .spike text').length})`);
      assert(narrow.inner<=width && narrow.scroll<=width, JSON.stringify(narrow));
      assert.deepEqual(narrow.cards, []);
      assert(narrow.pickerHeights.every(h=>h>=44));
      assert.deepEqual(narrow.years, ['2024','2025','2026']);
    }
    await screenshot('narrow-mobile');
    await evaluate(`document.documentElement.style.scrollBehavior='auto';document.querySelector('#trend').scrollIntoView({behavior:'instant',block:'start'})`);
    await screenshot('yearly-trends-mobile');
    await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    const tapPoint = await evaluate(`(()=>{const svg=document.querySelector('#trend svg');svg.scrollIntoView({behavior:'instant',block:'center'});const r=svg.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[tapPoint]});await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert(new URL(await evaluate(`location.href`)).searchParams.has('date'));
    await send('Emulation.setTouchEmulationEnabled',{enabled:false});
    const pickers = await evaluate(`(()=>{document.querySelector('#reset').click();const hour=document.querySelector('[data-hour-picker]');hour.value='7';hour.dispatchEvent(new Event('change'));
      const day=document.querySelector('#report-date');day.value=day.options[1].value;day.dispatchEvent(new Event('change'));
      return {url:location.href,hours:[...document.querySelectorAll('[data-hour-picker]')].map(e=>e.value)}})()`);
    assert(new URL(pickers.url).searchParams.has('date'));
    assert.deepEqual(pickers.hours, ['7','7','7']);
    assert.deepEqual(errors, []);
    console.log('PASS: narrow layouts, separate yearly trends, mobile taps and large date/hour pickers');

    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await navigate(pageUrl + '?cat=MEDICAL');
    await evaluate(`document.querySelector('#reset-map').click()`);
    const countyCamera = await evaluate(`new URL(location.href).searchParams.get('view').split(',').map(Number)`);
    await navigate(pageUrl + '?cat=MEDICAL&view=0,0,15');
    const limitedCamera = await evaluate(`(()=>{const view=new URL(location.href).searchParams.get('view').split(',').map(Number),d=JSON.parse(document.querySelector('#data').textContent),points=[];
      function collect(a){if(typeof a[0]==='number'){points.push(a);return}a.forEach(collect)}d.basemap.towns.forEach(t=>collect(t.rings));
      return {view,south:Math.min(...points.map(p=>p[0])),north:Math.max(...points.map(p=>p[0])),west:Math.min(...points.map(p=>p[1])),east:Math.max(...points.map(p=>p[1]))}})()`);
    const nearCounty = view => view[0] >= limitedCamera.south - (limitedCamera.north-limitedCamera.south)*.15 - .001 &&
      view[0] <= limitedCamera.north + (limitedCamera.north-limitedCamera.south)*.15 + .001 &&
      view[1] >= limitedCamera.west - (limitedCamera.east-limitedCamera.west)*.15 - .001 &&
      view[1] <= limitedCamera.east + (limitedCamera.east-limitedCamera.west)*.15 + .001;
    assert(nearCounty(limitedCamera.view), JSON.stringify(limitedCamera));
    const mapPoint=await evaluate(`(()=>{const r=document.querySelector('#map').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:mapPoint.x,y:mapPoint.y});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:mapPoint.x,y:mapPoint.y,button:'left',buttons:1,clickCount:1});
    for(let step=1;step<=6;step++)await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:mapPoint.x+step*500,y:mapPoint.y+step*300,button:'left',buttons:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:mapPoint.x+3000,y:mapPoint.y+1800,button:'left',clickCount:1});await delay(250);
    const dragged=await evaluate(`new URL(location.href).searchParams.get('view').split(',').map(Number)`);
    assert(nearCounty(dragged), JSON.stringify(dragged));
    const resetCounty = await evaluate(`(()=>{document.querySelector('#reset-map').click();return {view:new URL(location.href).searchParams.get('view').split(',').map(Number),category:document.querySelector('#cat').value}})()`);
    // Leaflet rounds projected centers to pixels when fitting after a drag.
    const countyPixel = 360 / (256 * 2 ** countyCamera[2]);
    assert(Math.abs(resetCounty.view[0]-countyCamera[0])<=countyPixel && Math.abs(resetCounty.view[1]-countyCamera[1])<=countyPixel,JSON.stringify(resetCounty));
    assert.equal(resetCounty.view[2],countyCamera[2]);
    assert.equal(resetCounty.category,'MEDICAL');
    console.log('PASS: county bounds constrain shared cameras and large drags; Show county preserves filters');

    for(const [width,height,mobile] of [[390,844,true],[1440,900,false]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});await delay(200);
      const resized=await evaluate(`new URL(location.href).searchParams.get('view').split(',').map(Number)`);
      assert(Math.abs(resized[0]-countyCamera[0])<.02 && Math.abs(resized[1]-countyCamera[1])<.02,JSON.stringify(resized));
      await evaluate(`document.querySelector('#reset-flow-map').click()`);
      assert.equal(await evaluate(`document.querySelector('#reset-flow-map').getAttribute('aria-label')`),'Reset map to show all of Oneida County');
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: county overview remains centered across mobile/desktop resizing and both maps expose reset controls');

    // Preserve the Seasons checks for when the panel is restored.
    if (await evaluate(`!!document.querySelector('#seasons-section')`)) {
    async function checkSeasons(stats, years) {
      const actual = await evaluate(`({years:[...document.querySelectorAll('#season-coverage tbody tr')].map(e=>e.dataset.year),
        bars:[...document.querySelectorAll('#season-top button')].map(e=>({rate:e.dataset.rate,days:+e.dataset.days,disabled:e.disabled})),
        cells:[...document.querySelectorAll('#season-coverage tbody tr')].map(e=>[...e.querySelectorAll('td')].map(c=>c.innerText))})`);
      assert.deepEqual(actual.years, years);
      for (let m=1;m<=12;m++) {
        const n=years.reduce((s,y)=>s+(stats[y]?.[m].n||0),0), days=years.reduce((s,y)=>s+(stats[y]?.[m].days||0),0);
        assert.equal(actual.bars[m-1].days,days);
        assert.equal(actual.bars[m-1].disabled,days===0);
        if(days) assert(Math.abs(+actual.bars[m-1].rate-n/days)<1e-9);
        else assert.equal(actual.bars[m-1].rate,'');
        years.forEach((y,i)=>{
          const v=stats[y]?.[m];
          assert(actual.cells[i][m-1].startsWith(v?.days ? (v.n/v.days).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1}) : 'No reports'),actual.cells[i][m-1]);
        });
      }
    }
    const seasonYears=Object.keys(expected.seasonal).sort();
    await navigate(pageUrl);
    await checkSeasons(expected.seasonal,seasonYears);
    assert(await evaluate(`!!document.querySelector('.section-nav a[href="#seasons-section"]')`));
    await evaluate(`document.querySelector('#seasons-section').scrollIntoView({behavior:'instant',block:'start'})`);
    await screenshot('seasons-desktop');
    console.log('PASS: pooled monthly rates and per-year coverage match independent CSV counts');

    await navigate(pageUrl+'?year=2025');
    await checkSeasons(expected.seasonal,['2025']);
    const months2025=expected.seasonal['2025'].slice(1).filter((v,k)=>v.days/new Date(Date.UTC(2025,k+1,0)).getUTCDate()>=.8).length;
    if(months2025<6) assert.equal(await evaluate(`document.querySelectorAll('#season-grid .season-card').length`),0);
    await navigate(pageUrl+'?day=mon');
    await checkSeasons(expected.seasonalMonday,seasonYears);
    console.log('PASS: selected years, missing months and weekday denominators are handled correctly');

    await navigate(pageUrl+'?month=11&compare=year&compareA=2024&compareB=2025');
    assert.equal(await evaluate(`document.querySelector('#total').textContent`),fmt(seasonYears.reduce((s,y)=>s+expected.seasonal[y][11].n,0)));
    const november=await evaluate(`({counts:[...document.querySelectorAll('#cmp-out .cmp-summary tbody tr:first-child td')].slice(1).map(e=>e.textContent),
      trendDates:[...document.querySelectorAll('#trend svg')].map(e=>e.dataset.year),chip:document.querySelector('[data-clear="month"]').innerText})`);
    assert.deepEqual(november.counts,['2024','2025'].map(y=>expected.seasonal[y][11].days ? fmt(expected.seasonal[y][11].n) : 'No reports available'));
    assert(november.chip.includes('November'));
    await checkSeasons(expected.seasonal,seasonYears); // The month axis retains context.
    await evaluate(`document.querySelector('#season-top [data-month="6"]').focus();document.activeElement.click()`);
    assert.equal(new URL(await evaluate('location.href')).searchParams.get('month'),'6');
    assert.equal(await evaluate(`document.activeElement.dataset.month`),'6');
    await evaluate(`document.querySelector('[data-clear="month"]').click()`);
    assert(!new URL(await evaluate('location.href')).searchParams.has('month'));
    console.log('PASS: month filtering, year comparisons, shared links and keyboard focus stay consistent');

    const oneDate=[...fs.readFileSync(path.resolve(__dirname,'../output/oneida_911_records.csv'),'utf8').matchAll(/2024-11-\d\d/g)][0][0];
    await navigate(pageUrl+'?date='+oneDate+'&month=11');
    await evaluate(`document.querySelector('#season-top [data-month="11"]').click()`);
    assert.equal(new URL(await evaluate('location.href')).searchParams.get('date'),oneDate);
    assert(!new URL(await evaluate('location.href')).searchParams.has('month'));
    assert.equal(await evaluate(`document.querySelectorAll('#season-grid .season-card').length`),0);
    console.log('PASS: single-date selections do not fabricate seasonal patterns or disappear when clearing the month');

    await navigate(pageUrl);
    const groupName=await evaluate(`(()=>{const b=document.querySelector('#season-grid [data-g]');const t=b.textContent;b.click();return t})()`);
    const seasonalFilter=new URL(await evaluate('location.href')).searchParams;
    assert(seasonalFilter.has('group') || seasonalFilter.has('type'));
    assert.equal(await evaluate(`document.querySelector('#season-grid [data-g]').textContent`),groupName);
    await evaluate(`document.querySelector('#reset').click()`);
    for(const theme of ['light','dark']) {
      await send('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true});
      await evaluate(`document.querySelector('#theme [data-theme="${theme}"]').click();document.querySelector('#seasons-section').scrollIntoView({behavior:'instant',block:'start'})`);
      const overflow=await evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth,card:document.querySelector('#seasons-section').clientWidth,content:document.querySelector('#seasons-section').scrollWidth})`);
      assert(overflow.scroll<=overflow.width && overflow.content<=overflow.card+2,JSON.stringify(overflow));
      await screenshot('seasons-mobile-'+theme);
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: seasonal call filters and 320px layouts work in both themes without JavaScript errors');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});

    } else {
      await navigate(pageUrl);
      assert.equal(await evaluate(`document.querySelectorAll('#seasons-section,.section-nav a[href="#seasons-section"]').length`),0);
      await navigate(pageUrl+'?month=11&compare=year&compareA=2024&compareB=2025');
      const years=Object.keys(expected.seasonal);
      assert.equal(await evaluate(`document.querySelector('#total').textContent`),fmt(years.reduce((n,y)=>n+expected.seasonal[y][11].n,0)));
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#cmp-out .cmp-summary tbody tr:first-child td')].slice(1).map(e=>e.textContent)`),
        ['2024','2025'].map(y=>expected.seasonal[y][11].days ? fmt(expected.seasonal[y][11].n) : 'No reports available'));
      await evaluate(`document.querySelector('[data-clear="month"]').click()`);
      assert(!new URL(await evaluate('location.href')).searchParams.has('month'));
      assert.deepEqual(errors,[]);
      console.log('PASS: Seasons panel and navigation are disabled; saved month filters still work');
    }

    await navigate(pageUrl);
    for (const [width,height,mobile] of [[1440,900,false],[800,600,false],[390,844,true],[320,844,true]]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
      for(const theme of ['light','dark']) {
        await evaluate(`document.querySelector('#theme [data-theme="${theme}"]').click();document.querySelector('#coverage-section').scrollIntoView({behavior:'instant',block:'start'})`);
        const layout=await evaluate(`(()=>{const card=document.querySelector('#coverage-section'),c=card.getBoundingClientRect(),p=document.querySelector('#patterns').getBoundingClientRect(),
          t=document.querySelector('#time-patterns-section').getBoundingClientRect(),f=document.querySelector('#flows-section').getBoundingClientRect(),
          year=document.querySelector('#cal .cal'),labels=year.querySelectorAll('.mlab');
          return {width:innerWidth,scroll:document.documentElement.scrollWidth,cardWidth:c.width,available:p.width,height:c.height,
            ordered:t.bottom<=c.top+1&&c.bottom<=f.top+1,grids:[...document.querySelectorAll('#cal .cal')].map(g=>({width:g.clientWidth,scroll:g.scrollWidth})),
            months:[...labels].map(e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,top:e.getBoundingClientRect().top})),
            left:c.left,right:c.right,days:document.querySelectorAll('#cal .day').length,picker:document.querySelector('#report-date').getBoundingClientRect().height}})()`);
        assert(layout.ordered,JSON.stringify(layout));
        assert(Math.abs(layout.cardWidth-layout.available)<2,JSON.stringify(layout));
        assert(layout.scroll<=width && layout.height<=height-24,JSON.stringify(layout));
        assert(layout.grids.every(g=>g.scroll<=g.width+1),JSON.stringify(layout));
        assert(layout.months.every(m=>m.left>=layout.left && m.right<=layout.right),JSON.stringify(layout));
        assert.equal(layout.days,Object.keys(expected.seasonal).reduce((n,y)=>n+(Date.UTC(+y+1,0,1)-Date.UTC(+y,0,1))/864e5,0));
        assert(layout.picker>=44);
        assert.equal(layout.months[6].top>layout.months[0].top,width<=600);
        await screenshot('coverage-'+width+'-'+theme);
        await evaluate(`document.querySelector('#population-section').scrollIntoView({behavior:'instant',block:'start'})`);
        const pcLayout=await evaluate(`(()=>{const p=document.querySelector('#population-section'),r=p.getBoundingClientRect();return {fits:p.scrollWidth<=p.clientWidth,left:r.left,right:r.right,width:innerWidth,rows:[...p.querySelectorAll('.rank-row')].every(e=>e.scrollWidth<=e.clientWidth),buttons:[...p.querySelectorAll('#pc-scale button')].every(e=>e.scrollHeight<=e.clientHeight && e.getBoundingClientRect().height>=42)}})()`);
        assert(pcLayout.fits && pcLayout.rows && pcLayout.buttons && pcLayout.left>=0 && pcLayout.right<=pcLayout.width,JSON.stringify(pcLayout));
        await screenshot('population-'+width+'-'+theme);
        await evaluate(`document.querySelector('#compare-section').scrollIntoView({behavior:'instant',block:'start'})`);
        const compareLayout=await evaluate(`(()=>{const p=document.querySelector('#compare-section'),r=p.getBoundingClientRect();return {fits:p.scrollWidth<=p.clientWidth,left:r.left,right:r.right,width:innerWidth,summary:p.querySelector('.cmp-summary').getBoundingClientRect().width,available:p.clientWidth}})()`);
        assert(compareLayout.fits && compareLayout.left>=0 && compareLayout.right<=compareLayout.width && compareLayout.summary<=compareLayout.available,JSON.stringify(compareLayout));
        await screenshot('compare-'+width+'-'+theme);
        if(width===1440 || width===390) {
          await evaluate(`document.querySelector('#flows-section').scrollIntoView({behavior:'instant',block:'start'})`);
          await screenshot('connections-'+width+'-'+theme);
        }
      }
    }
    await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    const coverageTap=await evaluate(`(()=>{const e=document.querySelector('#cal .day.has[aria-label*="Jul 1, 2024"]');e.scrollIntoView({behavior:'instant',block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[coverageTap]});
    await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.equal(new URL(await evaluate('location.href')).searchParams.get('date'),'2024-07-01');
    await send('Emulation.setTouchEmulationEnabled',{enabled:false});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    assert.deepEqual(errors,[]);
    console.log('PASS: coverage fills the screen without horizontal scrolling in both themes; connections follow both time panels and calendar taps work');

    const injected = await send('Page.addScriptToEvaluateOnNewDocument', { source: `const originalParse=JSON.parse;JSON.parse=function(...args){const d=originalParse.apply(this,args);if(d&&d.records&&d.population)d.population={};return d}` });
    await navigate(pageUrl + '?test=missing-population');
    assert((await evaluate(`document.querySelector('#pc-list').innerText`)).includes('unavailable'));
    assert.equal(await evaluate(`document.querySelector('#total').textContent`), fmt(expected.total));
    assert.deepEqual(errors, []);
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier });
    console.log('PASS: missing optional population data does not interrupt initialization');
    console.log('Review screenshots: ' + profile);
  } finally {
    if (ws?.readyState === WebSocket.OPEN) { try { await send('Browser.close'); } catch (_) {} ws.close(); }
    else browser.kill();
    clearTimeout(watchdog);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
