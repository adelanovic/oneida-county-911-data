/* Browser regressions using Chromium's debugging protocol; no npm dependencies. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
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
    assert.equal(await evaluate(`document.querySelector('#total').textContent`), '181,601');
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
    assert.deepEqual(overlap.first, ['15,426', '4,370']);
    assert.deepEqual(overlap.reverse, ['4,370', '15,426']);
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
    assert.equal(downloads.rows, 181601);
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

    const injected = await send('Page.addScriptToEvaluateOnNewDocument', { source: `const originalParse=JSON.parse;JSON.parse=function(...args){const d=originalParse.apply(this,args);if(d&&d.records&&d.population)d.population={};return d}` });
    await navigate(pageUrl + '?test=missing-population');
    assert((await evaluate(`document.querySelector('#pc-list').innerText`)).includes('unavailable'));
    assert.equal(await evaluate(`document.querySelector('#total').textContent`), '181,601');
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
