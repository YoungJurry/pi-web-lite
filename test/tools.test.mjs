import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { Value } from 'typebox/value';
import { CONFIG_PATH } from '../src/config.ts';
import register from '../src/index.ts';

const tools = new Map();
register({ registerTool: (tool) => tools.set(tool.name, tool) });
const search = tools.get('web_search');
const fetchTool = tools.get('fetch');

test('web tools require one scalar input and reject legacy batch arguments', async () => {
  assert.equal(Value.Check(search.parameters, { query: 'Pi' }), true);
  assert.equal(Value.Check(fetchTool.parameters, { url: 'https://example.com', extractMainContent: false }), true);
  for (const args of [{}, { query: ['Pi'] }, { queries: ['Pi'] }, { query: 'Pi', queries: ['other'] }]) {
    assert.equal(Value.Check(search.parameters, args), false);
  }
  for (const args of [{}, { url: ['https://example.com'] }, { urls: ['https://example.com'] }, { url: 'https://example.com', urls: [] }]) {
    assert.equal(Value.Check(fetchTool.parameters, args), false);
  }
  await assert.rejects(search.execute('search', { query: ' ' }), /No query provided/);
  await assert.rejects(fetchTool.execute('fetch', { url: ' ' }), /No URL provided/);
});

test('independent calls return a single result and surface failures', async (t) => {
  const { existsSync, readFileSync } = fs;
  t.mock.method(fs, 'existsSync', (path) => path === CONFIG_PATH || existsSync(path));
  t.mock.method(fs, 'readFileSync', (path, ...args) => path === CONFIG_PATH
    ? JSON.stringify({ provider: 'brave', apiKeys: { brave: ['test-key'] } })
    : readFileSync(path, ...args));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (url.hostname === 'api.search.brave.com') {
      return Response.json({ grounding: { generic: [{ title: 'Test source', url: 'https://example.com/source', snippets: ['snippet'] }] } });
    }
    if (url.pathname === '/fail') return new Response('unavailable', { status: 503 });
    return new Response('page content', { headers: { 'Content-Type': 'text/plain' } });
  });

  const [first, second, page, failure] = await Promise.allSettled([
    search.execute('first', { query: ' first ' }),
    search.execute('second', { query: 'second' }),
    fetchTool.execute('page', { url: ' https://example.com/page ' }),
    fetchTool.execute('failure', { url: 'https://example.com/fail' }),
  ]);
  assert.deepEqual(requests.map((url) => url.searchParams.get('q') ?? url.pathname), ['first', 'second', '/page', '/fail']);
  for (const [result, query] of [[first, 'first'], [second, 'second']]) {
    assert.equal(result.status, 'fulfilled');
    assert.equal(result.value.details.query, query);
    assert.equal(result.value.details.sources.length, 1);
    assert.match(result.value.content[0].text, /https:\/\/example\.com\/source/);
  }
  assert.equal(page.status, 'fulfilled');
  assert.equal(page.value.details.url, 'https://example.com/page');
  assert.match(page.value.content[0].text, /page content/);
  assert.equal(failure.status, 'rejected');
  assert.match(failure.reason.message, /Fetch error 503/);
});
