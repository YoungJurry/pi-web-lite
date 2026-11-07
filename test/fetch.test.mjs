import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchOne } from '../src/fetch.ts';

const options = { timeoutMs: 5000, maxChars: 10000, extractMainContent: false };

test('concurrent HTML fetches keep separate documents and resolve links after redirects', async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/docs/first' });
      response.end();
      return;
    }
    if (request.url === '/plain') {
      response.setHeader('Content-Type', 'text/plain');
      response.end('<document>Keep this markup</document>');
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/docs/first') {
      response.end('<html><head><title>First page</title></head><body><h1>First article</h1><p><a href="next">Continue</a></p><script>REMOVE_SCRIPT</script></body></html>');
    } else {
      response.end('<html><head><title>Second page</title></head><body><h1>Second article</h1><p><strong>Independent content</strong></p></body></html>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const plain = await fetchOne(`${base}/plain`, options);
  assert.equal(plain.content, '<document>Keep this markup</document>');
  const [first, second] = await Promise.all([
    fetchOne(`${base}/redirect`, options),
    fetchOne(`${base}/second`, options)
  ]);
  assert.equal(first.title, 'First page');
  assert.match(first.content, /First article/);
  assert.ok(first.content.includes(`[Continue](${base}/docs/next)`));
  assert.doesNotMatch(first.content, /REMOVE_SCRIPT|Second article/);
  assert.equal(second.title, 'Second page');
  assert.ok(second.content.includes('**Independent content**'));
  assert.doesNotMatch(second.content, /First article|Continue/);
  assert.equal(first.extractedMainContent, false);
  assert.equal(second.extractedMainContent, false);
});
