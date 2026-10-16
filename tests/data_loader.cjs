/* Exercise compressed transport, HTTP-decoded transport and corrupt downloads. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { gzipSync } = require('node:zlib');

const source = fs.readFileSync(path.resolve(__dirname, '../geo/data_loader.js'), 'utf8');
const widths = {t:2,a:1,c:1,d:2,h:1,l:2,u:1,m:1,i:4,k:2,s:2,z:4,q:1,p:1,f:2,v:2,r:2};
const binary = Buffer.alloc(256), layout = {}, embedded = {};
let offset = 0;
for (const [key, width] of Object.entries(widths)) {
  offset = Math.ceil(offset / 4) * 4;
  const values = width === 1 ? [7, 9] : width === 2 ? [300, 500] : [70000, 90000];
  values.forEach((value, i) => binary.writeUIntLE(value, offset + i * width, width));
  layout[key] = {offset, width, count:2};
  embedded[key] = binary.subarray(offset, offset + width * 2).toString('base64');
  offset += width * 2;
}
const records = binary.subarray(0, offset);
const metadata = {formatVersion:1,total:2,recordBytes:offset,records:layout};
const config = {formatVersion:1,metadataUrl:'metadata',recordsUrl:'records'};

async function load({plain=false, broken=false, status=200, schema=metadata, offline=false, native=true}={}) {
  const context = {window:{},document:{getElementById:()=>({textContent:JSON.stringify(offline ? {total:2,records:embedded} : config)})},
    Uint8Array,Uint16Array,Uint32Array,Response,Blob,AbortController,TextDecoder,
    DecompressionStream:native ? DecompressionStream : undefined,setTimeout,clearTimeout,atob,
    fetch:async url=>{
      assert(!offline,'Offline copy must not fetch data');
      let body = url==='metadata' ? Buffer.from(JSON.stringify(schema)) : broken ? records.subarray(1) : records;
      return new Response(plain ? body : gzipSync(body),{status});
    }};
  vm.runInNewContext(source, context);
  return context.window.loadOneidaData();
}

(async()=>{
  for (const options of [{},{plain:true},{offline:true,native:false}]) {
    const data = await load(options);
    for (const [key,width] of Object.entries(widths)) {
      assert.deepEqual([...data.records[key]],width===1 ? [7,9] : width===2 ? [300,500] : [70000,90000]);
    }
  }
  await assert.rejects(load({broken:true}),/Incomplete/);
  await assert.rejects(load({status:503}),/503/);
  await assert.rejects(load({schema:{...metadata,records:{...layout,t:{...layout.t,offset:1}}}}),/Invalid/);
  await assert.rejects(load({native:false}),/updated browser/);
  console.log('PASS: binary columns survive gzip, HTTP-decoded and offline transports; corrupt data and HTTP errors fail safely');
})().catch(error=>{console.error(error);process.exitCode=1;});
