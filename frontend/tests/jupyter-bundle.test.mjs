import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from '@playwright/test';

test('bundled widget renders from a blob with no frontend server', async () => {
  const source = await readFile(new URL('../../src/samplesift/jupyter/static/dist/widget.js', import.meta.url), 'utf8');
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL, args: ['--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage();
    const errors = [], scripts = [], workers = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('worker', worker => workers.push(worker.url()));
    await page.route('**/*', route => {
      const request = route.request();
      if (request.resourceType() === 'script') scripts.push(request.url());
      if (request.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: '<div id="widget"></div>' });
      return route.abort();
    });
    await page.goto('http://localhost:8888/');
    await page.evaluate(async source => {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const { default: widget } = await import(url);
      window.widget = widget;
      const values = { component_url: '', demo: true, api_url: '', collection: '', tile_layer: '',
        query_state: { predicates: [], sort: [], selection: null } };
      const listeners = new Map();
      const model = { get: key => values[key], set: update => Object.assign(values, update),
        save_changes() {}, on: (key, fn) => listeners.set(key, fn), off: key => listeners.delete(key) };
      window.values = values;
      window.model = model;
      window.cleanup = await widget.render({ model, el: document.querySelector('#widget') });
      URL.revokeObjectURL(url);
    }, source);
    await page.locator('sample-sift canvas.maplibregl-canvas').waitFor();
    await page.waitForFunction(() => {
      const map = document.querySelector('sample-sift').shadowRoot.querySelector('sample-sift-map');
      return map?._ready;
    });
    assert.ok(workers.length, 'MapLibre starts its embedded worker');
    assert.ok(workers.every(url => url.startsWith('data:') || url.startsWith('blob:')));
    assert.deepEqual(scripts, [], 'No scripts are fetched from a frontend server');
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.cleanup());
    assert.equal(await page.locator('sample-sift').count(), 0);

    // Collection filters exercise Golem's bundled lazy loaders.
    await page.route('http://api.test/samplesift/**', route => {
      const path = new URL(route.request().url()).pathname;
      const headers = { 'Access-Control-Allow-Origin': '*' };
      if (path.endsWith('/queryables')) return route.fulfill({ headers, json: {
        type: 'object', properties: { depth: { type: 'number', 'x-samplesift': { operators: ['>='] } } },
      } });
      if (path.endsWith('/openapi.json')) return route.fulfill({ headers, json: {
        openapi: '3.2.1', paths: { '/samplesift/collections/occurrences/results': { query: {
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {
            filter: { type: 'object' }, sort: { type: 'array', items: { type: 'string', enum: ['depth', '-depth'] } },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }, offset: { type: 'integer', minimum: 0 },
          } } } } },
          responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: {
            items: { type: 'array', items: { type: 'object', properties: { source_pk: { type: 'string' }, depth: { type: 'number' } } } },
          } } } } } },
        } } },
      } });
      return route.fulfill({ headers, json: { items: [{ source_pk: 'a', depth: 60, geometry: null }], total: 1, limit: 100, offset: 0 } });
    });
    await page.evaluate(async () => {
      Object.assign(window.values, { demo: false, api_url: 'http://api.test/samplesift', collection: 'occurrences',
        query_state: { predicates: [{ field: 'depth', operator: '>=', value: 50 }], sort: [], selection: null } });
      window.cleanup = await window.widget.render({ model: window.model, el: document.querySelector('#widget') });
    });
    await page.waitForFunction(() => window.values.page?.result?.total === 1 || window.values.query_error);
    assert.equal(await page.evaluate(() => window.values.query_error), '', await page.locator('body').innerText());
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.locator('gui-form input').first().waitFor();
    await page.waitForFunction(() => window.values.page?.result?.total === 1);
    assert.equal(await page.evaluate(() => window.values.query_error), '');
    assert.deepEqual(scripts, []);
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.cleanup());
  } finally {
    await browser.close();
  }
});
