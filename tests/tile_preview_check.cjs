const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert');
const calls = [];
const path = '/samplesift/collections/fish/tiles/{z}/{x}/{y}';
const schema = {openapi:'3.2.1',paths:{[path]:{query:{tags:['fish']}}}};
const responseInner = {prepend(element) { this.element = element; element.isConnected = true; }};
const label = {textContent:'POST'};
const curl = {textContent:"curl -X 'POST' \\\n  'http://localhost/example'"};
const block = {querySelector(sel) { return sel === '.opblock-summary-path' ? {textContent:path} : sel === '.opblock-summary-method' ? label : sel === '.responses-inner' ? responseInner : sel === '.curl-command pre, .curl-command code' ? curl : null; }};
let observer, script, renderedMap, click, copied;
class MockMap {
  constructor(options) { renderedMap = this; this.options = options; }
  addControl() {}
  fitBounds(bounds) { this.bounds = bounds; }
  getZoom() { return 4; }
  jumpTo(options) { this.zoom = options.zoom; }
  on() {}
}
const context = {URL, Response, Headers, ArrayBuffer, location:{href:'http://localhost/samplesift/docs',origin:'http://localhost'},
  MutationObserver: class { constructor(fn) {observer=fn} observe(){} },
  navigator:{clipboard:{writeText: text => {copied = text;}}},
  document:{currentScript:{dataset:{schemaUrl:'/samplesift/openapi.json'}},documentElement:{},querySelectorAll:()=>[block], addEventListener: (_name, fn) => {click = fn;},
    createElement:()=>({style:{},setAttribute(){}}),head:{appendChild(element){ if (element.src) script = element; }}},
  window:{maplibregl:{Map: MockMap,NavigationControl:class {}},fetch:async (url, init)=>{
    calls.push({url,init});
    return String(url).endsWith('openapi.json') ? new Response(JSON.stringify(schema)) : new Response(new Uint8Array(calls.length === 2 ? [1,2,3] : []));
  }}};
vm.runInNewContext(fs.readFileSync('src/samplesift/django/static/samplesift/tile-preview.js','utf8'), context);
(async()=>{
  const schemaResponse = await context.window.fetch('http://localhost/samplesift/openapi.json');
  const s = await schemaResponse.json();
  assert(s.paths[path].post); assert(!s.paths[path].query);
  const result = await context.window.fetch('http://localhost/samplesift/collections/fish/tiles/1/0/0',{method:'POST',body:'{}'});
  assert.equal(calls[1].init.method,'QUERY');
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())],[1,2,3]);
  observer(); assert.equal(label.textContent,'QUERY'); assert(responseInner.element);
  assert(curl.textContent.includes("-X 'QUERY'"));
  const button = {closest: () => block};
  let stopped = false;
  click({target:{closest: () => button}, preventDefault(){}, stopImmediatePropagation(){stopped = true;}});
  assert(stopped); assert.equal(copied, curl.textContent);
  await context.window.fetch('http://localhost/samplesift/collections/fish/tiles/1/0/0',{method:'POST',body:'{}'});
  script.onload();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renderedMap.zoom, 0);
  const outline = renderedMap.options.style.layers.find(layer => layer.id === 'tile-boundary');
  assert.equal(outline.paint['line-color'], '#f28c28');
  const ring = renderedMap.options.style.sources['tile-boundary'].data.geometry.coordinates[0];
  assert.equal(ring.length, 5);
  assert.equal(ring[0][0], -180);
  assert.equal(ring[1][0], 0);
  console.log('schema, QUERY response, map placement, zoom and tile outline passed');
})().catch(error=>{console.error(error); process.exit(1)});
