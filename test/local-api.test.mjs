// 本机接口的测试：令牌、拒绝网页来源、路由、请求体限制。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require('../src/local-api');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-api-test-'));
const port = 18000 + Math.floor(Math.random() * 900);
const calls = [];
let base, token;

before(async () => {
  api.start({
    port, dataDir: dir, log: () => {},
    handlers: {
      state: () => ({ ok: true, character: { id: 't' } }),
      say: (b) => { calls.push(['say', b.text]); return { ok: true, spoken: false }; },
      stop: () => ({ ok: true }),
      action: (b) => { calls.push(['action', b.id]); return { ok: true }; },
      character: (b) => ({ ok: true, active: b.id }),
    },
  });
  for (let i = 0; i < 50 && !api.info().listening; i++) await new Promise((r) => setTimeout(r, 20));
  base = 'http://127.0.0.1:' + port;
  token = fs.readFileSync(path.join(dir, 'api-token.txt'), 'utf8').trim();
});
after(() => { api.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

test('没带令牌 / 令牌不对：401', async () => {
  assert.equal((await fetch(base + '/state')).status, 401);
  assert.equal((await fetch(base + '/state', { headers: { Authorization: 'Bearer x' } })).status, 401);
});

test('网页来源（带 Origin）：403', async () => {
  const r = await fetch(base + '/state', { headers: { Authorization: 'Bearer ' + token, Origin: 'https://example.com' } });
  assert.equal(r.status, 403);
});

test('带令牌：查状态、说话、做动作', async () => {
  const h = { 'X-Pet-Token': token, 'Content-Type': 'application/json' };
  const st = await (await fetch(base + '/state', { headers: h })).json();
  assert.equal(st.character.id, 't');
  const say = await (await fetch(base + '/say', { method: 'POST', headers: h, body: JSON.stringify({ text: '你好' }) })).json();
  assert.equal(say.ok, true);
  await fetch(base + '/action', { method: 'POST', headers: h, body: JSON.stringify({ id: 'nod' }) });
  assert.deepEqual(calls, [['say', '你好'], ['action', 'nod']]);
});

test('没有的接口 404，坏 JSON 400，太大 413', async () => {
  const h = { 'X-Pet-Token': token };
  assert.equal((await fetch(base + '/nope', { headers: h })).status, 404);
  assert.equal((await fetch(base + '/say', { method: 'POST', headers: h, body: '{bad' })).status, 400);
  const big = await fetch(base + '/say', { method: 'POST', headers: h, body: JSON.stringify({ text: 'x'.repeat(20000) }) }).catch(() => null);
  assert.ok(!big || big.status === 413);
});

test('换令牌后旧令牌失效', async () => {
  const old = token;
  token = api.regenerateToken(dir);
  assert.notEqual(token, old);
  assert.equal((await fetch(base + '/state', { headers: { 'X-Pet-Token': old } })).status, 401);
  assert.equal((await fetch(base + '/state', { headers: { 'X-Pet-Token': token } })).status, 200);
});
