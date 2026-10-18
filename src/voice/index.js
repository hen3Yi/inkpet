// 语音合成：把一句话变成 16 位单声道 PCM 片段，交给调用方（桌宠主进程推给渲染端边收边播、按音量对口型）。
//
// 合成服务（engines，按顺序试，第一个出声的算数；已经出过声的不再换下一个，免得念两遍）：
//   system  Windows 自带语音（System.Speech）：不用装东西，要系统里有对应语言的语音（中文版 Windows 一般带 Huihui）
//   qwen    阿里云百炼 · 千问实时语音合成（qwen3-tts-flash-realtime，WebSocket）：要自己的 API Key，按字数计费
//   http    自定义接口：接你自己的语音服务（本机的 IndexTTS、GPT-SoVITS 等，自己包一层），协议见 docs/voice.md
//
// 这个模块不依赖 Electron；密钥的加解密由调用方传进来的 secret.seal / secret.open 负责。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { speechText } = require('./text');

const ENGINES = [
  { id: 'system', name: 'Windows 自带语音', note: '不用装东西，音质一般；要系统里装了对应语言的语音' },
  { id: 'qwen', name: '阿里云百炼 · 千问语音合成', note: '音质好、开口快（约 0.3～1 秒），按字数计费，要自己的 API Key' },
  { id: 'http', name: '自定义接口', note: '接你自己的语音服务（IndexTTS、GPT-SoVITS 等），协议见 docs/voice.md' },
];
const ENGINE_IDS = ENGINES.map((e) => e.id);
// 千问实时合成自带的几个音色（完整列表以阿里云文档为准；也可以直接填别的音色名）
const QWEN_VOICES = [
  { id: 'Cherry', name: '芊悦（女声）' },
  { id: 'Serena', name: '苏瑶（女声）' },
  { id: 'Chelsie', name: '千雪（女声，二次元）' },
  { id: 'Ethan', name: '晨煦（男声）' },
];
const QWEN_URL = {
  cn: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',        // 北京地域
  intl: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime', // 新加坡地域（国际站的 Key）
};
const QWEN_SAMPLE_RATE = 24000;

function defaultConfig() {
  return {
    enabled: true,
    engines: ['system'],
    clickTalk: false,      // 点角色时念台词
    idleMinutes: 0,        // 多少分钟没人碰它就念一句台词（0 = 不说）
    qwen: { key: '', voice: 'Cherry', model: 'qwen3-tts-flash-realtime', region: 'cn' },   // key 是 secret.seal 封好的
    http: { url: 'http://127.0.0.1:9882/tts/stream', lang: 'ZH' },
    system: { voice: '', rate: 0 },
  };
}

const str = (v, max, dflt) => (typeof v === 'string' ? v.trim().slice(0, max) : dflt);
function cleanEngines(list) {
  const out = [];
  if (Array.isArray(list)) for (const id of list) if (ENGINE_IDS.includes(id) && !out.includes(id)) out.push(id);
  return out;
}
// 设置文件里读出来的：缺的补默认，不认识的丢掉
function cleanConfig(j) {
  const d = defaultConfig();
  if (!j || typeof j !== 'object') return d;
  if (typeof j.enabled === 'boolean') d.enabled = j.enabled;
  if (Array.isArray(j.engines)) d.engines = cleanEngines(j.engines);
  if (typeof j.clickTalk === 'boolean') d.clickTalk = j.clickTalk;
  const m = Number(j.idleMinutes);
  if (isFinite(m)) d.idleMinutes = Math.max(0, Math.min(240, Math.round(m)));
  if (j.qwen && typeof j.qwen === 'object') {
    d.qwen.key = str(j.qwen.key, 4096, '');
    d.qwen.voice = str(j.qwen.voice, 120, d.qwen.voice) || d.qwen.voice;
    d.qwen.model = str(j.qwen.model, 120, d.qwen.model) || d.qwen.model;
    if (QWEN_URL[j.qwen.region]) d.qwen.region = j.qwen.region;
  }
  if (j.http && typeof j.http === 'object') {
    d.http.url = str(j.http.url, 500, d.http.url);
    d.http.lang = str(j.http.lang, 16, d.http.lang) || d.http.lang;
  }
  if (j.system && typeof j.system === 'object') {
    d.system.voice = str(j.system.voice, 200, '');
    const r = Number(j.system.rate);
    if (isFinite(r)) d.system.rate = Math.max(-10, Math.min(10, Math.round(r)));
  }
  return d;
}
// 界面上看的：不带密钥，只说填没填
function publicConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  c.qwen.hasKey = !!cfg.qwen.key;
  delete c.qwen.key;
  return c;
}
// 界面改的：qwen.key 给明文（空串 = 清掉），这里封好再存
function applyPatch(cfg, patch, secret) {
  const next = cleanConfig(cfg);
  next.qwen.key = cfg.qwen.key;
  if (!patch || typeof patch !== 'object') return next;
  const merged = cleanConfig(Object.assign({}, next, patch, {
    qwen: Object.assign({}, next.qwen, patch.qwen || {}, { key: next.qwen.key }),
    http: Object.assign({}, next.http, patch.http || {}),
    system: Object.assign({}, next.system, patch.system || {}),
  }));
  if (patch.qwen && typeof patch.qwen.key === 'string') {
    const k = patch.qwen.key.trim();
    merged.qwen.key = k ? secret.seal(k) : '';
  }
  return merged;
}
function engineName(id) { const e = ENGINES.find((x) => x.id === id); return e ? e.name : id; }
function describe(cfg) {
  if (!cfg.enabled) return 'off';
  return (cfg.engines.join('>') || 'none') + (cfg.qwen.key ? ' (qwen key set)' : '');
}

// ---- 念一句：按 engines 的顺序试 ----
//   o.onChunk(sampleRate, pcmBuffer, seq)、o.signal（AbortSignal，停下用）、o.log、o.secret
async function speak(cfg, text, o) {
  const t0 = Date.now();
  const errors = [];
  const say = String(text || '').trim();
  if (!say) return { ok: false, engine: '', chunks: 0, ms: 0, error: '没有要念的字' };
  for (const id of cfg.engines) {
    if (o.signal && o.signal.aborted) break;
    let chunks = 0;
    const onChunk = (sampleRate, pcm) => {
      if (!pcm || !pcm.length || (o.signal && o.signal.aborted)) return;
      chunks += 1;
      o.onChunk(sampleRate, pcm, chunks);
    };
    try {
      if (id === 'qwen') await qwenSpeak(cfg.qwen, say, onChunk, o);
      else if (id === 'http') await httpSpeak(cfg.http, say, onChunk, o);
      else if (id === 'system') await systemSpeak(cfg.system, say, onChunk, o);
      if (chunks > 0) return { ok: true, engine: id, chunks, ms: Date.now() - t0, error: '' };
      if (o.signal && o.signal.aborted) break;
      errors.push(engineName(id) + '：没有出声');
    } catch (e) {
      // 念到一半断了：不再换下一个服务（免得前半句念两遍）
      if (chunks > 0) return { ok: true, engine: id, chunks, ms: Date.now() - t0, error: e.message };
      if (o.signal && o.signal.aborted) break;
      errors.push(engineName(id) + '：' + e.message);
      if (o.log) o.log('voice ' + id + ' failed: ' + e.message);
    }
  }
  if (o.signal && o.signal.aborted) return { ok: false, engine: '', chunks: 0, ms: Date.now() - t0, error: '停下了' };
  return { ok: false, engine: '', chunks: 0, ms: Date.now() - t0, error: errors.join('；') || '没有选合成服务' };
}

// ---- 阿里云百炼 · 千问实时语音合成 ----
// 协议（阿里云文档「Qwen-TTS 实时语音合成」）：连 wss://…/api-ws/v1/realtime?model=…，握手带 Authorization: Bearer <key>；
// 发 session.update {mode: commit, voice, response_format: pcm, sample_rate} → input_text_buffer.append {text} →
// input_text_buffer.commit → session.finish；收 response.audio.delta {delta: base64 PCM}，到 response.done / session.finished 结束。
// 实测：一个账号同时最多 3 条会话（多了被 1007 断开）；偶尔回了 committed 就没下文 → 1.5 秒没出声就换一条连接重发，最多 3 次。
const QWEN_CONNECT_MS = 8000;
const QWEN_FIRST_AUDIO_MS = 1500;
const QWEN_LAST_FIRST_AUDIO_MS = 8000;
async function qwenSpeak(q, text, onChunk, o) {
  const key = q.key ? o.secret.open(q.key) : '';
  if (!key) throw new Error('还没填 API Key');
  if (typeof WebSocket !== 'function') throw new Error('这个 Electron 版本没有 WebSocket');
  const url = (QWEN_URL[q.region] || QWEN_URL.cn) + '?model=' + encodeURIComponent(q.model);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const last = attempt === 3;
    let got = false;
    try {
      await qwenOnce(url, key, q, text, (sr, pcm) => { got = true; onChunk(sr, pcm); }, o.signal, last ? QWEN_LAST_FIRST_AUDIO_MS : QWEN_FIRST_AUDIO_MS);
      return;
    } catch (e) {
      if (got || last || (o.signal && o.signal.aborted)) throw e;
      if (o.log) o.log('voice qwen attempt ' + attempt + ' no audio (' + e.message + '), retry');
      if (/rate limit/i.test(e.message)) await new Promise((r) => setTimeout(r, 400));
    }
  }
}
function qwenOnce(url, key, q, text, onChunk, signal, firstAudioMs) {
  return new Promise((resolve, reject) => {
    // Node 自带的 WebSocket（undici）第二个参数可以带请求头
    const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + key } });
    let done = false, opened = false, gotAudio = false, closeNote = '';
    let timer = setTimeout(() => finish(new Error(opened ? '百炼没回 session.updated' : '连百炼超时')), QWEN_CONNECT_MS);
    const send = (obj) => ws.send(JSON.stringify(Object.assign({ event_id: 'ev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) }, obj)));
    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { ws.close(); } catch (e) { /* 已经关了 */ }
      if (err) reject(err); else resolve();
    }
    function onAbort() { finish(null); }
    if (signal) { if (signal.aborted) { finish(null); return; } signal.addEventListener('abort', onAbort, { once: true }); }
    ws.onopen = () => {
      opened = true;
      send({ type: 'session.update', session: { mode: 'commit', voice: q.voice, language_type: 'Chinese', response_format: 'pcm', sample_rate: QWEN_SAMPLE_RATE } });
    };
    ws.onerror = () => finish(new Error('连不上百炼的语音合成'));
    ws.onclose = (e) => {
      closeNote = (e && e.code ? e.code : '') + (e && e.reason ? ' ' + String(e.reason).slice(0, 120) : '');
      finish(gotAudio ? null : new Error('百炼断开了（' + (closeNote || '没给原因') + '）'));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let j;
      try { j = JSON.parse(ev.data); } catch (e) { return; }
      if (j.type === 'error') { finish(new Error('百炼：' + ((j.error && j.error.message) || JSON.stringify(j.error || j).slice(0, 160)))); return; }
      if (j.type === 'session.updated') {
        send({ type: 'input_text_buffer.append', text });
        send({ type: 'input_text_buffer.commit' });
        send({ type: 'session.finish' });
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error('百炼 ' + firstAudioMs + ' 毫秒没出声')), firstAudioMs);
        return;
      }
      if (j.type === 'response.audio.delta' && typeof j.delta === 'string' && j.delta) {
        if (!gotAudio) { gotAudio = true; clearTimeout(timer); timer = setTimeout(() => finish(new Error('百炼合成到一半断了')), 20000); }
        onChunk(QWEN_SAMPLE_RATE, Buffer.from(j.delta, 'base64'));
        return;
      }
      if (j.type === 'response.done' || j.type === 'session.finished') finish(gotAudio ? null : new Error('百炼没给声音'));
    };
  });
}

// ---- 自定义接口：POST {text, lang} → 一行一个 JSON：{type:'chunk', seq, sampleRate, pcm} / {type:'done'} / {type:'error', error} ----
function httpSpeak(h, text, onChunk, o) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(h.url); } catch (e) { reject(new Error('地址不对：' + h.url)); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify({ text, lang: h.lang || 'ZH' }), 'utf8');
    let tail = '', err = '', done = false;
    const finish = (e) => { if (done) return; done = true; if (o.signal) o.signal.removeEventListener('abort', onAbort); if (e) reject(e); else resolve(); };
    const req = mod.request(u, {
      method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.setEncoding('utf8');
        res.on('data', (d) => { if (err.length < 300) err += d; });
        res.on('end', () => finish(new Error('HTTP ' + res.statusCode + (err ? ' ' + err.slice(0, 160) : ''))));
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (d) => {
        tail += d;
        let i;
        while ((i = tail.indexOf('\n')) >= 0) {
          const line = tail.slice(0, i).trim();
          tail = tail.slice(i + 1);
          if (!line) continue;
          let j;
          try { j = JSON.parse(line); } catch (e) { continue; }
          if (j.type === 'chunk' && typeof j.pcm === 'string') onChunk(Number(j.sampleRate) || 24000, Buffer.from(j.pcm, 'base64'));
          else if (j.type === 'error') err = String(j.error || 'error');
        }
      });
      res.on('end', () => finish(err ? new Error(err) : null));
      res.on('error', (e) => finish(e));
    });
    function onAbort() { try { req.destroy(); } catch (e) { /* ignore */ } finish(null); }
    if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } finish(new Error('超时')); });
    req.on('error', (e) => finish(new Error(e.code === 'ECONNREFUSED' ? '连不上 ' + u.host + '（服务没开？）' : e.message)));
    req.write(body);
    req.end();
  });
}

// ---- Windows 自带语音：PowerShell + System.Speech 合成到临时 WAV，读出来切成 0.5 秒一段 ----
//   要念的字经环境变量（base64）传给脚本，不拼进命令行
const PS_SYNTH = [
  'Add-Type -AssemblyName System.Speech',
  '$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PET_TTS_TEXT))',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'if ($env:PET_TTS_VOICE) { $s.SelectVoice($env:PET_TTS_VOICE) }',
  'elseif ($env:PET_TTS_CULTURE) { $v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $env:PET_TTS_CULTURE } | Select-Object -First 1; if ($v) { $s.SelectVoice($v.VoiceInfo.Name) } }',
  '$s.Rate = [int]$env:PET_TTS_RATE',
  '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 24000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)',
  '$s.SetOutputToWaveFile($env:PET_TTS_OUT, $fmt)',
  '$s.Speak($t)',
  '$s.Dispose()',
].join('\r\n');
const PS_LIST = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture.Name + "|" + $_.VoiceInfo.Gender }',
  '$s.Dispose()',
].join('\r\n');
function psScript(name, body) {
  const p = path.join(os.tmpdir(), 'desktop-pet-' + name + '.ps1');
  try { if (fs.readFileSync(p, 'utf8') === body) return p; } catch (e) { /* 还没有 */ }
  fs.writeFileSync(p, body, 'ascii');
  return p;
}
function runPs(script, env, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, env: Object.assign({}, process.env, env) });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } }, timeoutMs);
    const onAbort = () => { try { child.kill(); } catch (e) { /* ignore */ } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (err.length < 2000) err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve(out);
      else reject(new Error(err.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 200) || '退出码 ' + code));
    });
  });
}
async function systemSpeak(sys, text, onChunk, o) {
  if (process.platform !== 'win32') throw new Error('只有 Windows 上能用');
  const out = path.join(os.tmpdir(), 'desktop-pet-tts-' + process.pid + '-' + Date.now() + '.wav');
  try {
    await runPs(psScript('synth', PS_SYNTH), {
      PET_TTS_TEXT: Buffer.from(text, 'utf8').toString('base64'),
      PET_TTS_VOICE: sys.voice || '',
      PET_TTS_CULTURE: sys.voice ? '' : (/[一-鿿]/.test(text) ? 'zh-CN' : ''),
      PET_TTS_RATE: String(sys.rate || 0),
      PET_TTS_OUT: out,
    }, o.signal, 60000);
    if (o.signal && o.signal.aborted) return;
    const wav = fs.readFileSync(out);
    const pcm = wavData(wav);
    if (!pcm) throw new Error('没合成出声音（系统里可能没有中文语音）');
    const step = 24000 * 2 / 2;   // 0.5 秒一段（24 kHz、16 位单声道）
    for (let i = 0; i < pcm.length; i += step) onChunk(24000, pcm.subarray(i, Math.min(pcm.length, i + step)));
  } finally {
    try { fs.unlinkSync(out); } catch (e) { /* ignore */ }
  }
}
// WAV 里的 data 段（只认 16 位 PCM）；太短（不到 0.1 秒）当没有
function wavData(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'data') {
      const d = buf.subarray(p + 8, Math.min(buf.length, p + 8 + size));
      return d.length >= 4800 ? d : null;
    }
    p += 8 + size + (size & 1);
  }
  return null;
}
async function listSystemVoices(o) {
  if (process.platform !== 'win32') return [];
  try {
    const out = await runPs(psScript('voices', PS_LIST), {}, null, 20000);
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, culture, gender] = l.split('|');
      return { name, culture: culture || '', gender: gender || '' };
    });
  } catch (e) {
    if (o && o.log) o.log('voice list failed: ' + e.message);
    return [];
  }
}

module.exports = {
  ENGINES, QWEN_VOICES, defaultConfig, cleanConfig, publicConfig, applyPatch, describe, speak, listSystemVoices, speechText,
  _test: { wavData, cleanEngines },
};
