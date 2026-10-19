// 语音模块的测试：设置的清理 / 合并、密钥不外露、自定义接口的流式协议、Windows 自带语音（只合成不播放）。
//   npm test
//   Windows 自带语音测试仅手动启用：PET_TEST_SYSTEM_TTS=1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const voice = require('../src/voice');

// 测试用的「加密」：前缀一下就行（真程序里用 Electron 的 safeStorage）
const secret = {
  seal: (s) => 'test:' + Buffer.from(s).toString('base64'),
  open: (s) => (String(s).startsWith('test:') ? Buffer.from(String(s).slice(5), 'base64').toString() : ''),
};

test('首次启动关闭语音，缺省设置不会自动选择系统语音', async () => {
  const cfg = voice.defaultConfig();
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.engines, []);
  assert.deepEqual(voice.cleanConfig({}).engines, []);
  const r = await voice.speak(cfg, '测试', { onChunk() { assert.fail('未选择服务不应合成'); }, secret });
  assert.equal(r.ok, false);
  assert.equal(r.error, '没有选合成服务');
});

test('cleanConfig 补默认、丢掉不认识的', () => {
  const c = voice.cleanConfig({ enabled: false, engines: ['qwen', 'nope', 'qwen', 'system'], idleMinutes: 999, qwen: { region: 'mars' }, extra: 1 });
  assert.equal(c.enabled, false);
  assert.deepEqual(c.engines, ['qwen', 'system']);
  assert.equal(c.idleMinutes, 240);
  assert.equal(c.qwen.region, 'cn');
  assert.equal(c.extra, undefined);
  assert.deepEqual(voice.cleanConfig(null), voice.defaultConfig());
});

test('applyPatch 封好密钥再存，publicConfig 不带密钥', () => {
  let c = voice.defaultConfig();
  c = voice.applyPatch(c, { qwen: { key: '  sk-test-123  ', voice: 'Serena' }, engines: ['qwen', 'system'] }, secret);
  assert.equal(secret.open(c.qwen.key), 'sk-test-123');
  assert.equal(c.qwen.voice, 'Serena');
  assert.deepEqual(c.engines, ['qwen', 'system']);
  // 改别的不碰密钥
  c = voice.applyPatch(c, { clickTalk: true, http: { url: 'http://127.0.0.1:1/x' } }, secret);
  assert.equal(secret.open(c.qwen.key), 'sk-test-123');
  assert.equal(c.clickTalk, true);
  const pub = voice.publicConfig(c);
  assert.equal(pub.qwen.hasKey, true);
  assert.equal('key' in pub.qwen, false);
  assert.equal(JSON.stringify(pub).includes('sk-test'), false);
  // 空串 = 清掉
  c = voice.applyPatch(c, { qwen: { key: '' } }, secret);
  assert.equal(c.qwen.key, '');
});

test('speechText 去掉网址、代码、括号里的动作', () => {
  assert.equal(voice.speechText('（点点头）好的，看这里 https://example.com 就行'), '好的，看这里 就行');
  assert.equal(voice.speechText('跑一下 `npm start` 吧'), '跑一下 吧');
});

test('没选服务 / 没填 Key：不出声，说清原因', async () => {
  const none = await voice.speak(Object.assign(voice.defaultConfig(), { engines: [] }), '你好', { onChunk() {}, secret });
  assert.equal(none.ok, false);
  const noKey = await voice.speak(Object.assign(voice.defaultConfig(), { engines: ['qwen'] }), '你好', { onChunk() {}, secret });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /API Key/);
});

test('自定义接口：按行收 PCM 片段；第一个服务失败就换下一个', async () => {
  const pcm = Buffer.alloc(9600, 1);
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const j = JSON.parse(body);
      assert.equal(j.text, '测试一句');
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ type: 'chunk', seq: 1, sampleRate: 22050, pcm: pcm.toString('base64') }) + '\n');
      res.write(JSON.stringify({ type: 'chunk', seq: 2, sampleRate: 22050, pcm: pcm.toString('base64') }) + '\n');
      res.end(JSON.stringify({ type: 'done', segments: 2 }) + '\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/tts/stream';
  try {
    const cfg = Object.assign(voice.defaultConfig(), { engines: ['qwen', 'http'], http: { url, lang: 'ZH' } });
    const got = [];
    const r = await voice.speak(cfg, '测试一句', { onChunk: (sr, buf) => got.push([sr, buf.length]), secret });
    assert.equal(r.ok, true);
    assert.equal(r.engine, 'http');
    assert.deepEqual(got, [[22050, 9600], [22050, 9600]]);
  } finally {
    server.close();
  }
});

test('自定义接口连不上：报「服务没开」', async () => {
  const cfg = Object.assign(voice.defaultConfig(), { engines: ['http'], http: { url: 'http://127.0.0.1:9/x', lang: 'ZH' } });
  const r = await voice.speak(cfg, '你好', { onChunk() {}, secret });
  assert.equal(r.ok, false);
});

test('Windows 自带语音：合成出 24 kHz PCM（不播放）', { skip: process.platform !== 'win32' || process.env.PET_TEST_SYSTEM_TTS !== '1' }, async () => {
  const cfg = Object.assign(voice.defaultConfig(), { engines: ['system'] });
  let bytes = 0, rate = 0;
  const r = await voice.speak(cfg, '你好，我是桌宠。', { onChunk: (sr, buf) => { rate = sr; bytes += buf.length; }, secret });
  if (!r.ok && /没有中文语音|没合成出声音/.test(r.error)) return;   // 系统里没装中文语音：跳过
  assert.equal(r.ok, true, r.error);
  assert.equal(rate, 24000);
  assert.ok(bytes > 24000, 'too short: ' + bytes);
});

test('WAV 解析只认 data 段', () => {
  const { wavData } = voice._test;
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.write('WAVE', 8); head.write('fmt ', 12); head.writeUInt32LE(16, 16);
  head.write('data', 36); head.writeUInt32LE(9600, 40);
  const wav = Buffer.concat([head, Buffer.alloc(9600, 2)]);
  assert.equal(wavData(wav).length, 9600);
  assert.equal(wavData(Buffer.from('not a wav')), null);
});
