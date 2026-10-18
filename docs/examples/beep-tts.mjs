// 「自定义接口」的最小例子：不真的合成语音，只按字数回一串「嘀」声，用来试通协议。
//   node docs/examples/beep-tts.mjs [端口=9882]
//   然后在控制中心「语音」页把自定义接口的地址填成 http://127.0.0.1:9882/tts/stream，排到第一个，点「试听一句」。
// 接你自己的语音服务时，把下面 beep() 换成真正的合成：拿到 PCM 就一段一段写回去，越早写第一段，桌宠开口越快。
import http from 'node:http';

const PORT = Number(process.argv[2] || 9882);
const RATE = 24000;

// 0.25 秒的一声「嘀」：16 位有符号、小端、单声道 PCM
function beep(freq) {
  const n = RATE / 4;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.sin(Math.PI * i / n);   // 渐强渐弱，免得爆音
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / RATE) * env * 9000), i * 2);
  }
  return pcm;
}

http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/tts/stream') { res.writeHead(404); res.end(); return; }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let text = '';
    try { text = String(JSON.parse(body).text || ''); } catch (e) { /* 不是 JSON */ }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    if (!text.trim()) { res.end(JSON.stringify({ type: 'error', error: '没有要念的字' }) + '\n'); return; }
    // 大约 4 个字一声，最多 12 声
    const count = Math.min(12, Math.max(1, Math.ceil(text.length / 4)));
    for (let i = 0; i < count; i++) {
      const pcm = beep(i % 2 ? 660 : 520);
      res.write(JSON.stringify({ type: 'chunk', seq: i + 1, sampleRate: RATE, pcm: pcm.toString('base64') }) + '\n');
    }
    res.end(JSON.stringify({ type: 'done' }) + '\n');
  });
}).listen(PORT, '127.0.0.1', () => console.log('beep-tts: http://127.0.0.1:' + PORT + '/tts/stream'));
