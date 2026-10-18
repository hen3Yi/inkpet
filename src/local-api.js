// 本机接口：只听 127.0.0.1，给插件（比如以后的 dsh 插件）用 —— 让桌宠说话、做动作、换角色、查状态。
//
// 每个请求都要带令牌：请求头 `Authorization: Bearer <令牌>` 或 `X-Pet-Token: <令牌>`。
// 令牌在用户数据目录的 api-token.txt（第一次启动时随机生成；控制中心「系统」页可以复制、换一个）。
// 带 Origin 头的请求（也就是浏览器里的网页发来的）一律拒绝，免得随便一个网页来指挥桌宠。
//
//   GET  /state                     → { character, characters, speaking, voice, visible, mouseThrough, actions }
//   POST /say        {text}         → 说一句（气泡里显示 + 念出来；语音关着就只显示）{ ok, spoken, error }
//   POST /stop                      → 停下正在念的、清空排队的
//   POST /action     {id}           → 做个动作（id 见 /state 的 actions；空串 = 随机）
//   POST /character  {id}           → 换角色（空串 = 排第一的那个）
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const S = { server: null, port: 0, token: '', tokenFile: '', listening: false, error: '' };

function loadToken(dataDir) {
  S.tokenFile = path.join(dataDir, 'api-token.txt');
  try {
    const t = fs.readFileSync(S.tokenFile, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{24,}$/.test(t)) { S.token = t; return; }
  } catch (e) { /* 还没有 */ }
  regenerateToken(dataDir);
}
function regenerateToken(dataDir) {
  S.tokenFile = path.join(dataDir, 'api-token.txt');
  S.token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(S.tokenFile, S.token + '\n');
  return S.token;
}
function tokenOk(req) {
  const h = String(req.headers.authorization || '');
  const t = h.startsWith('Bearer ') ? h.slice(7).trim() : String(req.headers['x-pet-token'] || '').trim();
  if (!t || t.length !== S.token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(S.token));
}
function reply(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > 16 * 1024) { reject(Object.assign(new Error('请求太大'), { code: 413 })); req.destroy(); return; }
      parts.push(d);
    });
    req.on('end', () => {
      const s = Buffer.concat(parts).toString('utf8').trim();
      if (!s) { resolve({}); return; }
      try { resolve(JSON.parse(s)); } catch (e) { reject(Object.assign(new Error('不是 JSON'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

function start(o) {
  stop();
  loadToken(o.dataDir);
  S.port = o.port;
  S.error = '';
  const routes = {
    'GET /state': (_b) => o.handlers.state(),
    'POST /say': (b) => o.handlers.say(b),
    'POST /stop': (b) => o.handlers.stop(b),
    'POST /action': (b) => o.handlers.action(b),
    'POST /character': (b) => o.handlers.character(b),
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.origin) { reply(res, 403, { ok: false, error: '不接受网页发来的请求' }); return; }
      if (!tokenOk(req)) { reply(res, 401, { ok: false, error: '令牌不对' }); return; }
      const route = routes[req.method + ' ' + String(req.url || '').split('?')[0]];
      if (!route) { reply(res, 404, { ok: false, error: '没有这个接口' }); return; }
      const body = req.method === 'POST' ? await readJson(req) : {};
      reply(res, 200, await route(body));
    } catch (e) {
      reply(res, e.code === 413 || e.code === 400 ? e.code : 500, { ok: false, error: e.message });
    }
  });
  server.on('error', (e) => {
    S.listening = false;
    S.error = e.code === 'EADDRINUSE' ? '端口 ' + S.port + ' 被占用了' : e.message;
    o.log('local api error: ' + S.error);
  });
  server.listen(S.port, '127.0.0.1', () => {
    S.listening = true;
    o.log('local api listening 127.0.0.1:' + S.port);
  });
  S.server = server;
}
function stop() {
  if (S.server) { try { S.server.close(); } catch (e) { /* ignore */ } }
  S.server = null;
  S.listening = false;
}
// 控制中心看的（含令牌：给你复制到插件里用）
function info() {
  return { listening: S.listening, port: S.port, url: 'http://127.0.0.1:' + S.port, token: S.token, tokenFile: S.tokenFile, error: S.error };
}

module.exports = { start, stop, info, regenerateToken };
