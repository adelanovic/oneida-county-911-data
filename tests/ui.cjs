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
  let total = 0, whitestown = 0, whitesboro = 0;
  const fireUnknownBy = new Map(), hasHome = new Set();
  for (const line of lines.slice(1)) {
    const f = split(line); total++;
    if (f[town] === 'WHITESTOWN') { whitestown++; if (f[village] === 'WHITESBORO') whitesboro++; }
    // "Unknown destination" = no town and not a neighboring county (matches the flows panel).
    const unknown = f[town] === '' && (f[county] === '' || f[county] === 'ONEIDA');
    if (unknown && f[kind] === 'FIRE') fireUnknownBy.set(f[agency], (fireUnknownBy.get(f[agency]) || 0) + 1);
    if (f[town] !== '' && f[county] === 'ONEIDA') hasHome.add(f[agency]);
  }
  // The panel only considers agencies with a home town (at least one dispatch in an Oneida County town).
  let fireUnknown = 0;
  fireUnknownBy.forEach((n, a) => { if (hasHome.has(a)) fireUnknown += n; });
  return { total, whitestown, whitesboro, fireUnknown };
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
  const watchdog = setTimeout(() => { console.error('Browser regression check timed out'); browser.kill(); process.exitCode = 1; ws?.close(); }, 120000);
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

    const overlap = await evaluate(`(()=>{const a=document.querySelector('#cmp-a'),b=document.querySelector('#cmp-b');
      a.value='T:WHITESTOWN';a.dispatchEvent(new Event('change'));b.value='V:WHITESTOWN|WHITESBORO';b.dispatchEvent(new Event('change'));
      const first=[...document.querySelectorAll('#cmp-out tbody tr:first-child td')].slice(1).map(e=>e.textContent);
      a.value='V:WHITESTOWN|WHITESBORO';a.dispatchEvent(new Event('change'));b.value='T:WHITESTOWN';b.dispatchEvent(new Event('change'));
      const reverse=[...document.querySelectorAll('#cmp-out tbody tr:first-child td')].slice(1).map(e=>e.textContent);return {first,reverse}})()`);
    assert.deepEqual(overlap.first, [fmt(expected.whitestown), fmt(expected.whitesboro)]);
    assert.deepEqual(overlap.reverse, [fmt(expected.whitesboro), fmt(expected.whitestown)]);
    console.log('PASS: overlapping comparison populations are independent');

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
    console.log('PASS: population ranking and comparison use the same weekday denominator');

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
    for (const name of ['call_datetime', 'agency', 'reported_latitude', 'source_file', 'incident_cluster_id']) assert(downloads.header.includes(name));
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
      const unnamed=[...document.querySelectorAll('[role="button"]')].filter(e=>!e.innerText.trim()&&!e.getAttribute('aria-label')&&!e.title).length;
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
    const policeHour = await evaluate(`(()=>{
      const d=JSON.parse(document.querySelector('#data').textContent),bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
      const units=bytes(d.records.u),hours=bytes(d.records.h),police=new Set(['LOCAL_POLICE','SHERIFF','STATE_POLICE','CAMPUS_POLICE']);
      let expected=0;for(let i=0;i<units.length;i++)if(hours[i]===7&&police.has(d.agencyKind[units[i]]))expected++;
      document.querySelector('#pol-hour [data-k="hour:7"]').click();
      return {expected,text:document.querySelector('#pol-insight').innerText,legend:document.querySelector('#pol-list').parentElement.innerText};
    })()`);
    assert(policeHour.text.includes('of ' + policeHour.expected.toLocaleString('en-US') + ' police dispatches'));
    assert(policeHour.legend.includes('Other dispatch types'));
    assert(!policeHour.legend.includes('calls from the public'));
    console.log('PASS: police summary uses the selected hour and describes estimated dispatch types');

    await navigate(pageUrl + '?agency=Utica%20Police%20Department&year=2026');
    const policeMinimum = await evaluate(`({text:document.querySelector('#pol-insight').innerText,
      zero:document.querySelector('#pol-hour [data-k="hour:1"]').getAttribute('aria-label'),
      sparse:document.querySelector('#pol-hour [data-k="hour:2"]').getAttribute('aria-label')})`);
    assert(policeMinimum.text.includes('lowest at 01:00 (0%)'));
    assert(policeMinimum.zero.includes('0% likely officer-initiated'));
    assert(policeMinimum.sparse.includes('insufficient data'));
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
