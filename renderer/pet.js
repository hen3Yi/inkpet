// 桌宠 · 渲染进程：Live2D 模型（官方 Cubism Web Framework，见 live2d-adapter.js）+ 自己的动画层
//   这里做：喂全屏鼠标视线、播动作、拖拽摆动（弹簧）、眨眼、口型、窗口适配、命中轮廓、气泡、说话播放
import { findAction, pickPoolAction, sampleAction } from './actions.js';
import { HeartFx } from './heartfx.js';

const stage = document.getElementById('stage');
let rt = null;
// ★ 多角色：现在显示的角色（主进程 pet:character-state / pet:character 给）
//   rig 不给 = 驱动里的默认 rig；lines 不给 = 不显示台词行；tail 不给 = 没有尾巴
let CH = { id: '', name: '', modelUrl: null, rig: null, lines: null, tail: null };
const S = {
  t0: performance.now(),
  win: { wx: 0, wy: 0, ww: 1, wh: 1 }, cursor: { x: -9999, y: -9999 },
  action: null, actionT0: 0,
  dragging: false, dragVX: 0, dragLastX: 0,
  dragVY: 0, swingAngle: 0, swingVel: 0, _dragVAt: 0, _swingPeak: 0, squint: 0,
  clickPulse: 0, scalePulse: 0, blinkT: -1, nextBlink: 0,
  limbs: {},   // 每个摇曳部件一条独立弹簧 { a: 角度, v: 角速度 }
  _last: 0,
};
// 拖动速度满幅参考（px/s）：主进程差分窗口位移得来，超过它倾角就吃满
// ★ 「照 Petra 的口径，别自己调」——以下三个常量对齐 Petra Rigged2DView：
//   SWING_VREF：把主进程给的 px/s 速度归一化成 Petra 用的 -1..1（Petra 的 dragVelX 本就是 -1..1）
//   SWING_MAX ：Petra 原式 `bodySwing: clamp(this.swing, -1.5, 1.5)` ⇒ 上限 ±1.5（内核再乘 0.35 ≈ ±30°）
//   DRAG_SQUINT：Petra「按住眯眼」——pressed 时把眼开合压到 5%（「拖拽时眼睛是闭上的」说的就是它）。
//               不想要眯眼就把它设成 0。
const SWING_VREF = 1200;
const SWING_MAX = 1.5;
const DRAG_SQUINT = 0.95;

// ★ 外观调节（2026-09-20 要搬进设置面板自己调）：值由主进程 config.json 经 IPC 下发，
//   面板拖动即时生效。默认＝Petra 口径（sway 动作关键帧：body ±1.0／angleZ ±0.5／周期 2.0s）。
//   headDy：head 组整体下移（画布 px）；bodySx/bodySy：body 组绕胯部比例缩放
//   —— head 组**只平移**到缩放后的颈根位置、自身不变形 ⇒ “身体比例不影响头部”。
const TUNE = {
  swayPeriod: 2.0,
  swayBody: 1.0,
  swayZ: 0.5,
  breathPeriod: 3.4,  // 呼吸周期（秒）——live2d 写 ParamBreath；psd 内核也吃这个周期
  breathAmp: 1.0,     // 呼吸幅度（live2d 专属：1.0 = 走满 ParamBreath 范围）
  headFollow: 1.0,    // 头部追随灵敏度（live2d 专属，0~2）
  eyeFollow: 1.0,     // 眼球追随灵敏度（live2d 专属，0~2）
  dragTilt: 0.5,      // 拖拽时头跟随倾斜比例（live2d 专属，0~1）
  dragBody: 1.0,      // 拖拽时身体摆幅倍数（live2d 专属，0~2）
  headDy: 24,
  bodySx: 1.0,
  bodySy: 1.0,
  blinkMin: 1.6,      // 眨眼最短间隔（秒）
  blinkMax: 5.4,      // 眨眼最长间隔（秒）
  blinkDouble: 0.18,  // 连眨概率
  clickVol: 0.25,     // 点击音效音量（0＝静音）
};
function applyTune(t) {
  if (!t) return;
  for (const k in TUNE) {
    const v = Number(t[k]);
    if (isFinite(v)) TUNE[k] = v;
  }
  // ★ 下发到渲染后端：live2d 侧接呼吸周期/幅度；psd 侧让内核也吃面板的呼吸周期
  if (rt) {
    if (rt.setTune) rt.setTune(TUNE);
    if (rt.tune !== undefined) rt.tune = TUNE;
  }
  console.log('TUNE ' + JSON.stringify(TUNE));
}

// 脖子跟随躯干摆动的比例（内核 bodySwing 排除了 neck ⇒ 大幅摆动会把颈躯扯开）
const NECK_FOLLOW = 0.55;

// 绕任意枢轴整体旋转一层顶点（与内核 deform 同一手法）
function rotateAround(o, px, py, th) {
  const co = Math.cos(th), si = Math.sin(th);
  for (let i = 0; i < o.length; i += 2) {
    const rx = o[i] - px, ry = o[i + 1] - py;
    o[i] = px + rx * co - ry * si;
    o[i + 1] = py + rx * si + ry * co;
  }
}

// ---- ★ 点击气泡：**数据与台词分开**（数据的文字要大）
//   上行 #bubbleData＝大字数据（陪伴天数/被摸次数/语音/自定义，15px 粗体 + tabular-nums）
//   下行 #bubbleText＝小字台词（10.5px，只吐槽、不重复数字）
const bubbleEl = document.getElementById('bubble');
const bubbleDataEl = document.getElementById('bubbleData');
const bubbleTextEl = document.getElementById('bubbleText');
let bubbleTimer = 0;
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  // 大字行要短：够分就不显示秒（"20 分"而不是"20 分 0 秒"）
  if (d > 0) return d + ' 天 ' + h + ' 小时';
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  if (m > 0) return m + ' 分';
  return s + ' 秒';
}
function pickOne(arr) { return arr && arr.length ? String(arr[Math.floor(Math.random() * arr.length)]) : ''; }
// ★ 大字数据格 [标签, 数值]：主进程没给编排好的数据行时用这两项（台词由角色档案的 lines 给）
function dataCells(st) {
  const t = (typeof st.ms === 'number' && isFinite(st.ms)) ? fmtDuration(st.ms) : '—';
  const n = (typeof st.clicks === 'number') ? String(st.clicks) : '0';
  return [['陪伴', t], ['摸', n + ' 次']];
}
// ★ 气泡总开关：关掉＝点一下不弹气泡；被摸次数仍由主进程照旧累计
let bubbleOn = true;
// ★「台词」开关：关掉＝气泡只留大字数据，台词那行整行收起
let bubbleSay = true;
// ★ 气泡长宽控制：main.js 的 bubble.wPct（60–100＝窗宽百分比）与 bubble.hPx（40–200px）
//   经 pet:bubble-cfg-state 拉一次、pet:bubble-cfg 推送更新；窗口高度也按 hPx 走（气泡带＝hPx）。
function applyBubbleCfg(cfg) {
  if (!cfg) return;
  const de = document.documentElement.style;
  if (typeof cfg.wPct === 'number' && isFinite(cfg.wPct)) {
    de.setProperty('--bubble-w-pct', String(Math.max(60, Math.min(100, Math.round(cfg.wPct)))));
  }
  if (typeof cfg.hPx === 'number' && isFinite(cfg.hPx)) {
    de.setProperty('--bubble-h', Math.max(40, Math.min(200, Math.round(cfg.hPx))) + 'px');
  }
}
if (window.petAPI && window.petAPI.bubbleCfgState) {
  window.petAPI.bubbleCfgState().then(applyBubbleCfg).catch(() => {});
}
if (window.petAPI && window.petAPI.onBubbleCfg) window.petAPI.onBubbleCfg(applyBubbleCfg);

// ★ 气泡高度自适应 + 测高上报
//   气泡不再单行硬截：内容换行撑高 ⇒ 这里把「实际内容高（含 padding/border）」报给主进程，
//   由它把窗口一起撑高（否则气泡会被窗口裁掉）。差值 ≤4px 不发（防抖）；上报值夹在 [40, 340]。
//   角色区布局直接用本模块请求的高度（innerHeight − 该高度），不等主进程回传，避免错一帧。
let lastBubbleH = 0;        // 本模块请求（并已上报）的气泡高度，供 bandH 布局用
let lastReportedH = 0;      // 上次真正发出去的值（防抖比较）
let bubblePayload = null;   // 最近一次渲染用的 payload（resize 时按新窗宽重算标签）

function measureBubbleH() {
  if (!bubbleEl) return 0;
  // ★ 用 offsetHeight（布局高度，含 padding/border）而不是 getBoundingClientRect：
  //   后者会被 #bubble.show 那 0.18s 过渡里的 scale(.94) 缩小 ⇒ 刚 add('show') 就测会少 3~4px（真机踩过）。
  let h = bubbleEl.offsetHeight || 0;
  if (!h && typeof bubbleEl.getBoundingClientRect === 'function') {
    const r = bubbleEl.getBoundingClientRect();
    h = r && r.height ? r.height : 0;
  }
  if (!(h > 0)) return 0;
  return Math.max(40, Math.min(340, Math.round(h)));
}
function reportBubbleHeight() {
  const h = measureBubbleH();
  if (!h) return 0;
  lastBubbleH = h;
  if (Math.abs(h - lastReportedH) > 4) {          // ★ 防抖：变化 >4px 才发
    lastReportedH = h;
    if (window.petAPI && window.petAPI.reportBubbleHeight) window.petAPI.reportBubbleHeight(h);
  }
  return h;
}

// ★ 数据行渲染：窗宽 <300 用 short 短标签、≥300 用完整 label；
//   项数截断保留（窄窗 2 项 + 「+n」）；**项内文字不再省略**，由 CSS flex-wrap 折行 + 自适应高度承载。
function renderBubbleData(st) {
  if (!bubbleDataEl) return;
  const narrow = window.innerWidth < 300;                     // 短标签开关
  const labelOf = (o) => (narrow && o && o.short) ? String(o.short) : String((o && o.label) == null ? '' : o.label);
  const maxItems = narrow ? 2 : (window.innerWidth < 500 ? 4 : Infinity);
  const withMore = (list) => {
    const shown = list.slice(0, maxItems);
    const hidden = list.length - shown.length;
    return shown.join('') + (hidden > 0 ? '<i class="more">+' + hidden + '</i>' : '');
  };
  bubbleDataEl.style.display = '';
  if (st && Array.isArray(st.data) && st.data.length) {
    bubbleDataEl.innerHTML = withMore(st.data.map((d) => {
      const lb = labelOf(d);
      const val = String(d.value == null ? '' : d.value);
      // ★ 每项＝纵向两行小格子：上行标签（小字/次要色）、下行数值（大字/粗体/主色深），
      //   格子之间并排，宽度不够由 flex-wrap 自然折行；永远两行结构，不按窗宽切换。
      return '<span class="cell' + (d.level === 'small' ? ' sm' : '') + '">' +
        '<i class="lbl">' + lb + '</i>' +
        '<b class="val">' + val + '</b></span>';
    }));
  } else {
    // 没有编排好的数据行：只显示陪伴时长和被摸次数
    bubbleDataEl.innerHTML = withMore(dataCells(st || {})
      .map((c) => '<span><i class="lbl">' + c[0] + '</i>' + c[1] + '</span>'));
  }
}

function showBubble(st) {
  if (!bubbleOn) return;
  if (!bubbleEl || !bubbleDataEl || !bubbleTextEl || !st) return;
  applyBubbleCfg(st);                // ★ payload 里带的 wPct/hPx 优先（主进程直接下发时以它为准）
  bubblePayload = st;
  renderBubbleData(st);
  // ★「台词」开关：关掉＝只留大字数据（台词行 display:none，不占高）
  bubbleTextEl.style.display = bubbleSay ? 'block' : 'none';
  // 台词：点角色时主进程要念的那句（st.say）优先，否则从档案的 lines.stats 里挑一句
  const line = st.say || pickOne(CH.lines && CH.lines.stats);
  bubbleTextEl.textContent = bubbleSay ? line : '';
  if (!line) bubbleTextEl.style.display = 'none';
  bubbleEl.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl.classList.remove('show'), 4200);
  reportBubbleHeight();              // ★ 渲染完测高上报 → 主进程撑高窗口
}

// 窗宽变化：短/全标签与项数截断都要按新宽度重算，并重测高
window.addEventListener('resize', () => {
  if (bubblePayload && bubbleEl && bubbleEl.classList.contains('show')) renderBubbleData(bubblePayload);
  reportBubbleHeight();
});

// ★ 文本气泡：显示正在说的那句话（主进程 pet:say-text 推来；插件经本机接口让它说的也走这里）。
//   与数据气泡共用 #bubble，但只占小字行，大字数据行临时收起（showBubble 会复位）。
function showTextBubble(text, sticky) {
  if (!bubbleOn || !text) return;
  if (!bubbleEl || !bubbleDataEl || !bubbleTextEl) return;
  bubbleDataEl.innerHTML = '';
  bubbleDataEl.style.display = 'none';
  bubbleTextEl.style.display = 'block';
  bubbleTextEl.textContent = String(text);
  bubbleEl.classList.add('show');
  clearTimeout(bubbleTimer);
  if (!sticky) bubbleTimer = setTimeout(() => { bubbleEl.classList.remove('show'); bubbleDataEl.style.display = ''; }, 6500);
}
// 画不出角色（没装运行库 / 没有模型 / 载入失败）：气泡一直挂着说清楚缺什么（原因由主进程的 characterInfo().problem 给）
function showProblem(text) {
  bubbleOn = true;
  showTextBubble(text || '还没有角色模型（见 README）', true);
}
// 正在说的话 → 气泡显示原文（声音由主进程合成、分块推来，见 sayPlayChunk）
if (window.petAPI && window.petAPI.onSayText) window.petAPI.onSayText((d) => showTextBubble(d && d.text));

// ---- 点击音效（WebAudio 合成，不依赖任何素材文件）----
// ⚠️ 变量名勿用 actx：文件里已有 `actx` 是手臂 canvas 的 2D 上下文，重名会 SyntaxError 整层崩
let audioCtx = null;
function playClickSound() {
  const vol = TUNE.clickVol;
  if (!(vol > 0)) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(760, t0);
    o.frequency.exponentialRampToValueAtTime(1380, t0 + 0.05);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.02, vol * 0.5), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t0); o.stop(t0 + 0.18);
  } catch (e) { /* 音频不可用时静默 */ }
}

// ---- 说话播放（2026-09-22 · 流式排程连播）----
//   主进程从 /tts/stream 边收边推 NDJSON 分块 ⇒ 这里解成 AudioBuffer 按时序排程连播：
//   第一段算好就能开口，后面的段接在后面（AudioContext 时间轴），口型由总输出的 AnalyserNode 驱动。
let sayAnalyser = null, sayBuf = null;
let sayNextAt = 0;     // 时间轴上的下一段起点
let sayLive = 0;       // 还在排程/未播完的段数
let saySegs = 0;
// 排上的音频源都记着，「停下」时一个个 stop（只清计数的话，已排上的照样念完）
let saySources = [];

function sayStop(why, hard) {
  // 记下是谁停的（排查用）
  if (S.speaking || sayLive > 0 || saySegs > 0) {
    console.log('SAY stop why=' + (why || 'unknown') + ' segs=' + saySegs + ' live=' + sayLive + (hard ? ' (hard)' : ''));
  }
  // hard = 真的掐掉已经排上的音频（被停下）；平时（一段念完）只是收尾
  if (hard) {
    const list = saySources;
    saySources = [];
    for (const src of list) { try { src.onended = null; src.stop(); } catch (e) { /* 已经停了 */ } }
  }
  S.speaking = false;
  sayNextAt = 0; sayLive = 0; saySegs = 0;
}

function sayCtxEnsure() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (!sayAnalyser) {
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.6;
    an.connect(audioCtx.destination);
    sayAnalyser = an; sayBuf = new Uint8Array(an.fftSize);
  }
  return audioCtx;
}

// 收一段 int16 PCM（base64）→ 排到时间轴
function sayPlayChunk(b64, sampleRate) {
  try {
    const ctx = sayCtxEnsure();
    const bin = atob(b64 || '');
    const n = bin.length >> 1;
    if (!n) return;
    const buf = ctx.createBuffer(1, n, sampleRate || 22050);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const lo = bin.charCodeAt(i * 2), hi = bin.charCodeAt(i * 2 + 1);
      let v = (lo | (hi << 8)) & 0xffff;
      if (v >= 0x8000) v -= 0x10000;
      ch[i] = v / 32768;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(sayAnalyser);
    const at = Math.max(ctx.currentTime + 0.05, sayNextAt);
    src.start(at);
    sayNextAt = at + buf.duration;
    sayLive += 1;
    saySegs += 1;
    saySources.push(src);
    if (saySegs === 1) { S.sayLevel = 0; console.log('SAY first chunk @' + at.toFixed(2)); }
    S.speaking = true;
    src.onended = () => {
      saySources = saySources.filter((x) => x !== src);
      sayLive -= 1;
      if (sayLive <= 0) { sayStop('ended-chunk'); console.log('SAY end'); }
    };
    console.log('SAY chunk #' + saySegs + ' ' + n + ' samples @' + (sampleRate || 22050) + 'Hz');
  } catch (e) { console.log('SAY chunk err ' + e.message); }
}

// ---- 拖拽摇曳：四肢 / 脖子 / 衣摆各自绕「根部枢轴」甩动----
//   手法与隐藏图层同一套路：**hook 内核的逐层变形函数**，在它算完之后叠加一次绕枢旋转，
//   内核 psd-runtime.js 一行不改、PSD 一个字节不动、描边效果不受影响。
//   枢轴 px/py 是画布(1280)坐标，由各层实心区实测得来：
//     左肩(675,725) 右肩(606,725) 胯(639,928) 颈底(639,711) 腰(639,910)
//   ★ 骨骼化 · 分关节：每层一条骨轴 root→tip，
//     joints 列出关节在骨轴上的归一化位置（如 [0.48] = 肘/膝在 48% 处），
//     **每段一条独立弹簧**，顶点绕「各自段的关节」旋转「累积角度」= 正向运动学 ⇒ 肘/膝能折。
//     joints 留空 = 单段（等同单链渐进，脖子/裙摆先用这个）。
//   ★ 手感旋钮：gain[]=各段角度系数(按段顺序) / K=刚度 / C=阻尼(越小回弹越多) / dir=方向翻转
const LIMB_CFG = {
  //          骨轴：根部 → 梢部（画布 1280 坐标，实测自各层实心区）
  //  ★ 2026-09-19 调硬：两段 gain 是**相加**的（总角度 = gain[0]+gain[1]），首版 0.30+0.46=0.76 太软像面条；
  //    现在收到 0.46 上下，同时把 K 拉高（跟手）、C 拉高（回弹收敛快），ζ≈0.4 仍有回弹但不飘。
  arm_l:      { key: 'armL', root: [675, 725], tip: [866, 987], joints: [], gain: [0.46], K: 300, C: 14.0, dir: 1 },
  arm_r:      { key: 'armR', root: [606, 725], tip: [413, 987], joints: [], gain: [0.46], K: 300, C: 14.0, dir: 1 },
  sleeve_l:   { key: 'slvL', root: [675, 725], tip: [866, 987], joints: [], gain: [0.40], K: 300, C: 14.0, dir: 1 },
  sleeve_r:   { key: 'slvR', root: [606, 725], tip: [413, 987], joints: [], gain: [0.40], K: 300, C: 14.0, dir: 1 },
  legs:       { key: 'legs', root: [639, 928], tip: [639, 1239], joints: [], gain: [0.41], K: 250, C: 15.0, dir: 1 },
  //  ★ 「鞋子没跟随脚部、跟随衣服」：socks/footwear 以前不在表里 ⇒ 没进腿部骨骼，
  //    只受内核 body/bodySwing（跟躯干/衣服一起转）。修法＝**借用 legs 的弹簧**（key 相同 ⇒ 同相位：
  //    腿动了鞋袜才动、绝不错开），`borrow: true` 表示不单独积分（否则同一弹簧会被积分三次）。
  socks:      { key: 'legs', borrow: true, root: [639, 928], tip: [639, 1239], joints: [], gain: [0.41], dir: 1 },
  footwear:   { key: 'legs', borrow: true, root: [639, 928], tip: [639, 1239], joints: [], gain: [0.41], dir: 1 },
  neck:       { key: 'neck', root: [639, 711], tip: [639, 643], joints: [], gain: [0.14], K: 340, C: 19.0, dir: 1 },
  bottomwear: { key: 'skirt', root: [639, 910], tip: [639, 1043], joints: [], gain: [0.26], K: 210, C: 12.0, dir: 1 },
};
function limbSegs(c) { return (c.joints || []).length + 1; }
const LIMB_VREF = 1400;   // 摇曳满幅参考速度(px/s)
const LIMB_MAX = 1.05;    // 弹簧值上限（角度 = 值 × gain）

// 画布按窗口「宽度」等比缩放、**底部对齐**：窗口比宽多出来的那一条（h-w）就是顶部气泡带 ⇒ 气泡不挡角色
// ★ 2026-09-26 气泡高度自适应后：优先用**本模块请求并上报的高度**（lastBubbleH）来布局角色区，
//   因为主进程撑高窗口有一帧延迟，等它回传会让角色错位一帧；没测过之前才退回「窗高 − 窗宽」的旧推断。
function bandH(w, h) {
  if (lastBubbleH > 0) return Math.max(0, Math.min(h, lastBubbleH));
  const b = h - w;
  return b > 0 && b < h ? b : 0;
}
// 角色区尺寸 = 整个窗口
const areaW = () => Math.max(120, window.innerWidth);
const areaH = () => window.innerHeight;

function fit() {
  const w = areaW(), h = areaH();
  HM.at = 0;   // 窗口 / 画布位置变了：命中轮廓下一帧就重算
  if (!rt) {
    stage.style.width = w + 'px';
    stage.style.height = h + 'px';
    return;
  }
  const band = bandH(w, h);
  const sc = Math.min(w / rt.canvasWidth, Math.max(1, h - band) / rt.canvasHeight);
  S.view = { sc, tx: (w - rt.canvasWidth * sc) / 2, ty: (h - rt.canvasHeight * sc) };
  // ★ 点击缩放脉冲以**底部中心**为原点（脚不动）——见 loop 里的 scale 应用
  stage.style.transformOrigin = '50% 100%';
  stage.style.position = 'absolute';
  stage.style.transform = 'none';
  stage.style.width = (rt.canvasWidth * sc) + 'px';
  stage.style.height = (rt.canvasHeight * sc) + 'px';
  stage.style.left = S.view.tx + 'px';
  stage.style.top = S.view.ty + 'px';
}

function modelScale() {
  if (S.view) return S.view;
  const w = areaW(), h = areaH();
  const band = bandH(w, h);
  const sc = Math.min(w / rt.canvasWidth, Math.max(1, h - band) / rt.canvasHeight);
  return { sc, tx: (w - rt.canvasWidth * sc) / 2, ty: (h - rt.canvasHeight * sc) };
}

// ---- ★ 命中轮廓（点击范围贴合角色、屏幕边按角色算）----
//   以前命中框 = 整块画布（差不多整个窗口）：透明的地方也挡鼠标，拖到屏幕边还隔着一截透明边距。
//   现在按角色画出来的像素算：把画布缩小画到一张小图上读透明度（HM_SUB 像素一个采样点），
//   ① 有像素的地方按 HM_CELL 见方记成格子、外扩一格（边缘好点中）→ 位图报给主进程判命中、切穿透；
//   ② 有像素的范围 = 贴身包围盒 → reportHitbox 报上去，拖动时按它夹屏幕边。
//   鼠标在窗口附近时 0.1 秒算一次，离得远 1 秒一次。
const HM_CELL = 8;      // 轮廓格边长（CSS px）
const HM_SUB = 2;       // 采样间距（CSS px）：包围盒的精度
const HM_ALPHA = 20;    // 透明度门槛（0~255）：发梢、尾尖这种细边也算
const HM = { canvas: null, ctx: null, colCell: null, at: 0, key: '', cols: 0, rows: 0, bits: null, box: null, logged: false, n: 0, sum: 0, max: 0 };
// 自检用（CDP 读）：现在的轮廓、包围盒、算一次花多少毫秒
window.__petHitMask = () => ({ cell: HM_CELL, cols: HM.cols, rows: HM.rows, box: HM.box, bits: HM.bits ? Array.from(HM.bits) : null,
  cost: { n: HM.n, avg: HM.n ? Math.round(HM.sum / HM.n * 10) / 10 : 0, max: HM.max } });
window.__petClickPart = (x, y) => clickPart(x, y);
function cursorNear(margin) {
  const w = S.win;
  if (!w || !(w.ww > 1)) return true;
  const dpr = window.devicePixelRatio || 1;
  const near = (x, y) => x > -margin && y > -margin && x < w.ww + margin && y < w.wh + margin;
  // 光标坐标有的机器给 DIP、有的给物理像素（同主进程 cursorRel）：两种都算
  return near(S.cursor.x - w.wx, S.cursor.y - w.wy) || near(S.cursor.x / dpr - w.wx, S.cursor.y / dpr - w.wy);
}
function hitMaskUpdate(now) {
  if (!rt || !S.view || !window.petAPI || !window.petAPI.reportHitmask) return;
  if (now - HM.at < (cursorNear(60) ? 100 : 1000)) return;
  HM.at = now;
  const t0 = performance.now();
  const W = window.innerWidth, H = window.innerHeight;
  const sw = Math.ceil(W / HM_SUB), sh = Math.ceil(H / HM_SUB);
  if (!HM.canvas) { HM.canvas = document.createElement('canvas'); HM.ctx = HM.canvas.getContext('2d', { willReadFrequently: true }); }
  if (HM.canvas.width !== sw || HM.canvas.height !== sh) { HM.canvas.width = sw; HM.canvas.height = sh; }
  const c = HM.ctx, v = S.view;
  c.clearRect(0, 0, sw, sh);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  // 画布在窗口里的位置 = fit() 定的 S.view（点击缩放脉冲那一下不算）；画布缓冲区是模型原始尺寸
  c.drawImage(stage, 0, 0, stage.width, stage.height,
    v.tx / HM_SUB, v.ty / HM_SUB, rt.canvasWidth * v.sc / HM_SUB, rt.canvasHeight * v.sc / HM_SUB);
  const a = c.getImageData(0, 0, sw, sh).data;
  const cols = Math.ceil(W / HM_CELL), rows = Math.ceil(H / HM_CELL), k = HM_CELL / HM_SUB;
  if (!HM.colCell || HM.colCell.length !== sw) HM.colCell = Int32Array.from({ length: sw }, (_, x) => (x / k) | 0);
  const colCell = HM.colCell;
  const on = new Uint8Array(cols * rows);
  let x0 = sw, y0 = sh, x1 = -1, y1 = -1;
  for (let y = 0; y < sh; y++) {
    const rowOff = ((y / k) | 0) * cols;
    let any = false;
    for (let x = 0, p = y * sw * 4 + 3; x < sw; x++, p += 4) {
      if (a[p] < HM_ALPHA) continue;
      on[rowOff + colCell[x]] = 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      any = true;
    }
    if (any) { if (y < y0) y0 = y; y1 = y; }
  }
  // 外扩一格：先横向、再纵向
  const wide = new Uint8Array(cols * rows);
  for (let r = 0; r < cols * rows; r += cols) {
    for (let cx = 0; cx < cols; cx++) {
      wide[r + cx] = on[r + cx] | (cx > 0 ? on[r + cx - 1] : 0) | (cx + 1 < cols ? on[r + cx + 1] : 0);
    }
  }
  const bits = new Uint8Array(Math.ceil(cols * rows / 8));
  let n = 0;
  for (let cy = 0, r = 0; cy < rows; cy++, r += cols) {
    for (let cx = 0; cx < cols; cx++) {
      if (wide[r + cx] | (cy > 0 ? wide[r - cols + cx] : 0) | (cy + 1 < rows ? wide[r + cols + cx] : 0)) {
        const i = r + cx;
        bits[i >> 3] |= 1 << (i & 7);
        n++;
      }
    }
  }
  HM.cols = cols; HM.rows = rows; HM.bits = bits;
  HM.box = x1 >= 0 ? { left: x0 * HM_SUB, top: y0 * HM_SUB, right: (x1 + 1) * HM_SUB, bottom: (y1 + 1) * HM_SUB } : null;
  let s = '';
  for (let i = 0; i < bits.length; i++) s += String.fromCharCode(bits[i]);
  const b64 = btoa(s);
  const key = cols + 'x' + rows + ':' + b64;
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  HM.n++; HM.sum += ms; if (ms > HM.max) HM.max = ms;
  if (key === HM.key) return;
  HM.key = key;
  window.petAPI.reportHitmask({ cell: HM_CELL, cols, rows, bits: b64, ms, id: CH.id });
  if (!HM.logged) {
    HM.logged = true;
    console.log('HITMASK ' + CH.id + ' ' + cols + 'x' + rows + ' on=' + n + ' box=' + JSON.stringify(HM.box) + ' ms=' + ms);
  }
}

function hitTest(cssX, cssY) {
  if (!rt || !rt.characterBounds) return false;
  // ★ 有命中轮廓就按轮廓判（和主进程同一张位图，见 hitMaskUpdate）：点在透明的地方不算点到角色
  if (HM.bits) {
    const cx = Math.floor(cssX / HM_CELL), cy = Math.floor(cssY / HM_CELL);
    if (cx < 0 || cy < 0 || cx >= HM.cols || cy >= HM.rows) return false;
    const i = cy * HM.cols + cx;
    return !!(HM.bits[i >> 3] & (1 << (i & 7)));
  }
  const b = rt.characterBounds;
  const { sc, tx, ty } = modelScale();
  const x = (cssX - tx) / sc, y = (cssY - ty) / sc;
  return x >= b.left - 4 && x <= b.right + 4 && y >= b.top - 4 && y <= b.bottom + 4;
}

// ---- 角色命中框上报（CSS 像素 / 相对窗口客户区）----
// 穿透开关改由主进程独占：Windows 上只要鼠标下面有别的可命中窗口（如别的程序的全屏透明宿主窗口），
// 桌宠就一次 mousemove 都收不到 —— 靠渲染端 mousemove 切穿透会永久卡住。这里只提供几何。
let _lastBox = null, _lastBoxAt = 0, _boxLogged = false;
function reportHitbox() {
  if (!rt || !rt.characterBounds || !window.petAPI || !window.petAPI.reportHitbox) return;
  const b = rt.characterBounds;
  const { sc, tx, ty } = modelScale();
  const q = (v) => Math.round(v / 4) * 4;      // 量化 4px：滤掉待机呼吸/摆动的亚像素微动
  // ★ 2026-10-17：报贴身包围盒（按画出来的像素算，见 hitMaskUpdate）⇒ 主进程拖动时按它夹屏幕边，角色能贴到边上；
  //   还没算出来才退回整块画布
  const box = HM.box ? Object.assign({}, HM.box) : {
    left: q(tx + b.left * sc), top: q(ty + b.top * sc),
    right: q(tx + b.right * sc), bottom: q(ty + b.bottom * sc),
  };
  const now = performance.now();
  if (_lastBox) {
    const d = Math.max(
      Math.abs(box.left - _lastBox.left), Math.abs(box.right - _lastBox.right),
      Math.abs(box.top - _lastBox.top), Math.abs(box.bottom - _lastBox.bottom));
    if (d === 0) return;
    if (d < 16 && now - _lastBoxAt < 100) return;   // 小变化最多 10 次/秒，防刷爆 IPC 与日志
  }
  _lastBox = box; _lastBoxAt = now;
  window.petAPI.reportHitbox(box);
  if (!_boxLogged) {
    _boxLogged = true;
    console.log('HITBOX_REPORT ' + [box.left, box.top, box.right, box.bottom].join(','));
  }
}

function tsec(now) { return ((now || performance.now()) - (S.t0 || 0)) / 1000; }

function startAction(def) {
  if (!def) return;
  S.action = def;
  S.actionT0 = performance.now();
}

function loop(now) {
  if (!rt) { requestAnimationFrame(loop); return; }
  if (!S._fit2) { S._fit2 = 1; fit(); }   // 首帧后按画布重算一次（此时 canvasWidth 已就绪）
  if (!S._logged && S.view) {
    S._logged = 1;
    const r = stage.getBoundingClientRect();
    console.log('FIT bounds=' + JSON.stringify(rt.characterBounds) + ' view=' + JSON.stringify(S.view) +
      ' win=' + window.innerWidth + 'x' + window.innerHeight +
      ' cw=' + rt.canvasWidth + 'x' + rt.canvasHeight +
      ' rect=' + [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',') +
      ' attr=' + stage.width + 'x' + stage.height +
      ' css=' + stage.style.width + '/' + stage.style.height + '/' + stage.style.left + '/' + stage.style.top);
  }
  const dt = Math.min(0.05, (now - S._last || 16) / 1000);
  S._last = now;

  // 基准值：PsdRuntime 内部对 eyeOpen 只取 min、从不恢复（Petra 靠外部驱动每帧重建 tgt）
  // physAmp/fhAmp/soft/fhSoft：发丝幅度与软度收敛（Petra 默认 2/2/2/0.4，实测「摇摆过猛」）
  // angleZ / body / bodySwing 一律归零：这三项都会让整只角色绕身体枢轴旋转，**脚会跟着倾斜**
  //（要「脚部是平的，不要倾斜」）；呼吸走的是纯垂直位移，不破坏脚的水平，保留
  const ov = {
    eyeOpenL: 1, eyeOpenR: 1, mouthOpen: 0, irisScale: 1, armY: 0,
  sayLevel: 0, sayLogAt: 0,   // ★ 说话音量（0~1，驱动连续口型）＋自证日志节流
    physAmp: 1.1, fhAmp: 1.1, soft: 1.2, fhSoft: 0.3,
    angleZ: 0, body: 0, bodySwing: 0,
    // ★ 拖拽速度（live2d 的四肢弹簧驱动用，口径＝PSD 的 limTgt：S.dragVX / LIMB_VREF，clamp ±1）
    dragVelX: S.dragging ? Math.max(-1, Math.min(1, S.dragVX / LIMB_VREF)) : 0,
  };
  // 长按/拖拽自检：看窗口与画布尺寸有没有被改（实测「长按会变大」）
  if (S.dragging && S._dragLog !== 1) {
    S._dragLog = 1;
    S._swingPeak = 0; S.swingAngle = 0; S.swingVel = 0; S.dragVX = 0;   // 每次拖拽从静止起步
    const r = stage.getBoundingClientRect();
    console.log('DRAG_START win=' + window.innerWidth + 'x' + window.innerHeight +
      ' css=' + stage.style.width + ' rect=' + [Math.round(r.width), Math.round(r.height)].join('x'));
  } else if (!S.dragging && S._dragLog === 1) {
    S._dragLog = 2;
    const r = stage.getBoundingClientRect();
    console.log('DRAG_END win=' + window.innerWidth + 'x' + window.innerHeight +
      ' css=' + stage.style.width + ' rect=' + [Math.round(r.width), Math.round(r.height)].join('x') +
      ' swingPeak=' + S._swingPeak.toFixed(3));
  }
  // 全屏鼠标 → 视线（Petra 用 cursorDx/Dy ∈ -1..1，这里换算成 eyeX/eyeY）
  const cxp = S.win.wx + S.win.ww / 2;
  const cyp = S.win.wy + S.win.wh * 0.36;
  const dx = S.cursor.x - cxp, dy = S.cursor.y - cyp;
  const dist = Math.hypot(dx, dy);
  const k = Math.min(1, dist / 700);
  if (dist > 1) { ov.eyeX = (dx / dist) * k; ov.eyeY = (dy / dist) * k; }

  // ★ 指针追随自检（2026-09-22）：视线大幅变化就把后端的读回打一行（阈值 0.3 + 节流 3s，
  //   正常使用不会刷屏）。live2d 才有 probe；psd 模式这段自动跳过。
  if (rt.probe &&
      (Math.abs((ov.eyeX || 0) - (S._pPtrX || 0)) > 0.3 || Math.abs((ov.eyeY || 0) - (S._pPtrY || 0)) > 0.3) &&
      now - (S._pPtrAt || 0) > 3000) {
    S._pPtrX = ov.eyeX || 0; S._pPtrY = ov.eyeY || 0; S._pPtrAt = now;
    try {
      const p = rt.probe();
      console.log('PTRPROBE ' + JSON.stringify({
        ptr: p.pointer, angle: p.angle, breath: p.breath, params: p.params, motion: p.motion,
        cloth: p.clothOpacity,
      }));
    } catch (e) { console.log('PTRPROBE err ' + (e && e.message)); }
  }

  // ★ 拖拽自检（2026-09-22）：拖拽中每 0.8s 打一行（抓帧后按时间戳对齐，确认哪几帧真在拖拽中）
  if (rt.probe && S.dragging && now - (S._pDragAt || 0) > 800) {
    S._pDragAt = now;
    try { const p = rt.probe(); console.log('DRAGPROBE ' + JSON.stringify({ motion: p.motion, swing: p.swing })); } catch (e) { }
  }

  // 手臂层旋转角（挥手已删除，保持归零；手臂层本身保留）
  S.armAngle = { l: 0, r: 0 };

  // ★ 持续左右摇晃（照 Petra 的 sway 动作：body ±1.0／angleZ ±0.5，同相半幅，周期 2s；面板可调）
  //   Petra 的 sway 属动作池（拖拽/播动作时不叠加）⇒ 这里同样在这两种状态下暂停。
  if (!S.dragging && !S.action && TUNE.swayPeriod > 0.05) {
    const sw = Math.sin((now / 1000) * (Math.PI * 2 / TUNE.swayPeriod));
    ov.body = TUNE.swayBody * sw;
    ov.angleZ = TUNE.swayZ * sw;
  }

  // ★ 眨眼（自管、频率面板可调）：照 Petra 的曲线 —— 闭 0.08s → 保持 0.34s → 睁 0.16s，
  //   间隔取 [blinkMin, blinkMax]，blinkDouble 概率追加一次「连眨」（+0.28s）。拖拽中不眨眼。
  if (!S.dragging) {
    const ms = now;   // performance.now()，毫秒
    if (S.blinkT < 0 && ms > S.nextBlink) {
      S.blinkT = 0;
      const mn = Math.min(TUNE.blinkMin, TUNE.blinkMax) * 1000;
      const mx = Math.max(TUNE.blinkMin, TUNE.blinkMax) * 1000;
      S.nextBlink = ms + mn + Math.random() * Math.max(1, mx - mn);
      if (Math.random() < TUNE.blinkDouble) S.nextBlink = ms + 280;
    }
    if (S.blinkT >= 0) {
      S.blinkT += dt;
      const d = S.blinkT;
      let v;
      if (d < 0.08) v = 1 - d / 0.08;
      else if (d < 0.42) v = 0;
      else if (d < 0.58) v = (d - 0.42) / 0.16;
      else { v = 1; S.blinkT = -1; }
      ov.eyeOpenL = Math.min(ov.eyeOpenL, v);
      ov.eyeOpenR = Math.min(ov.eyeOpenR, v);
    }
  }

  // ★ 点击反馈（照 Petra playClick/clickPulse）：嘴微张 + 整体缩放脉冲（缩放作用在 stage 上）
  //   嘴张原来衰减太快（dt*6≈0.17s）几乎看不见 ⇒ 放慢到 dt*3.5 且幅度抬到 0.85（模型确有 mouth_open 层）
  S.clickPulse = Math.max(0, S.clickPulse - dt * 3.5);
  S.scalePulse = Math.max(0, S.scalePulse - dt * 5);
  if (S.clickPulse > 0.01) ov.mouthOpen = Math.max(ov.mouthOpen, S.clickPulse * 0.85);

  // ★ 说话口型（2026-09-22）：播放音量 → 嘴的开合（S.speaking 由 sayPlay/sayStop 置位）
  if (S.speaking && sayAnalyser) {
    sayAnalyser.getByteTimeDomainData(sayBuf);
    let sum = 0;
    for (let i = 0; i < sayBuf.length; i++) { const v = (sayBuf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / sayBuf.length);
    const target = Math.min(1, rms * 4.5);
    S.sayLevel += (target - S.sayLevel) * Math.min(1, dt * 14);   // 平滑，别抖成开关
    ov.mouthOpen = Math.max(ov.mouthOpen, S.sayLevel);
    // 自证日志：说话期间每 0.7 秒记一次音量（可核对唇动驱动是否真的在动）
    if (!S.sayLogAt || (performance.now() - S.sayLogAt) > 700) {
      S.sayLogAt = performance.now();
      console.log('SAYLEVEL ' + S.sayLevel.toFixed(2) + ' rms=' + rms.toFixed(3));
    }
  } else if (S.sayLevel > 0.001) {
    S.sayLevel *= Math.max(0, 1 - dt * 8);
    ov.mouthOpen = Math.max(ov.mouthOpen, S.sayLevel);
  }

  // ---- 按住眯眼：★Petra 口径（pressed 时把眼开合压到 5%）----
  //   位置与 Petra 同序：在「动作层」之前（动作播放时可盖过它）。DRAG_SQUINT=0 可整体关掉。
  S.squint += ((S.dragging ? 1 : 0) - S.squint) * Math.min(1, dt * 6);
  if (S.squint > 0.01) {
    const sq = 1 - DRAG_SQUINT * S.squint;
    ov.eyeOpenL = Math.min(ov.eyeOpenL, sq);
    ov.eyeOpenR = Math.min(ov.eyeOpenR, sq);
  }

  // 动作库覆盖（关键帧 + smoothstep）
  if (S.action) {
    const p = (now - S.actionT0) / (S.action.duration * 1000);
    if (p >= 1) S.action = null;
    else {
      const ap = sampleAction(S.action, p);
      for (const key in ap) {
        if (key === 'eyeOpenL' || key === 'eyeOpenR') ov[key] = Math.min(ov[key], ap[key]);
        else ov[key] = ap[key];
      }
    }
  }
  // ---- 拖拽下半身摆动：★照抄 Petra Rigged2DView.update() 的原式----
  //   Petra：target = hold + clamp(dragVelX*2.0, -1.5, 1.5)
  //          swingV += (target - swing) * 45 * dt;  swingV *= exp(-dt*6.3);  swing += swingV * dt
  //          松手：swingV = 0;  swing += (0 - swing) * min(1, dt*12)   ← 平滑归零、不来回甩
  //          bodySwing = clamp(swing, -1.5, 1.5)
  //   hold＝按住时的双频轻微晃动（Petra 只要按住就在晃，不必真的拖动）。
  //   内核 bodySwing 只作用于 group==='body' 的层（face/前发/后发属 head 组）⇒ 头固定、身体倾，脚跟着倾（腾空）。
  if (S.dragging && now - (S._dragVAt || 0) > 150) S.dragVX *= 0.85;   // 速度断流时自然衰减
  const psec = now / 1000;
  const hold = Math.sin(psec * 0.6) * 0.4 + Math.sin(psec * 0.25 + 1.0) * 0.18;
  if (S.dragging) {
    const norm = Math.max(-1, Math.min(1, S.dragVX / SWING_VREF));      // px/s → -1..1
    const target = hold + Math.max(-1.5, Math.min(1.5, norm * 2.0));
    S.swingVel += (target - S.swingAngle) * 45 * dt;
    S.swingVel *= Math.exp(-dt * 6.3);
    S.swingAngle += S.swingVel * dt;
  } else {
    S.swingVel = 0;
    S.swingAngle += (0 - S.swingAngle) * Math.min(1, dt * 12);
    if (Math.abs(S.swingAngle) < 0.002) S.swingAngle = 0;
  }
  ov.bodySwing = Math.max(-SWING_MAX, Math.min(SWING_MAX, S.swingAngle));
  S._swingPeak = Math.max(S._swingPeak, Math.abs(S.swingAngle), Math.abs(S.dragVX));

  // ---- 四肢/脖子/衣摆的摇曳：各自一条二阶弹簧，目标取「拖拽反方向」（滞后才甩得起来）----
  //   目标值带负号 ⇒ 身体先走、四肢向后甩；松手后目标归零，弹簧自然回弹几下才停。
  //   每条弹簧的 K/C 不同 ⇒ 相位与回弹次数各异，看起来才像活的。
  const limTgt = (S.dragging ? Math.max(-1, Math.min(1, S.dragVX / LIMB_VREF)) : 0) * -1;
  for (const nm in LIMB_CFG) {
    const c = LIMB_CFG[nm];
    if (c.borrow || c.onlySeg !== undefined) continue;   // 借用别层弹簧（鞋/袜借 legs）：不单独积分，否则同一弹簧会被积分多次
    const nseg = limbSegs(c);
    let st = S.limbs[c.key];
    if (!st || st.segs.length !== nseg) {
      st = S.limbs[c.key] = { segs: Array.from({ length: nseg }, () => ({ a: 0, v: 0 })) };
    }
    for (let k = 0; k < nseg; k++) {
      const s = st.segs[k];
      // 后段只比前段软"一点点" ⇒ 保留一截递一截的递延感，又不至于软成面条
      //（首版 0.18/0.12 太软；想更硬就把这两个系数继续往 0 调）
      const K = c.K * (1 - 0.07 * k), C = c.C * (1 - 0.05 * k);
      s.v += (K * (limTgt - s.a) - C * s.v) * dt;
      s.a += s.v * dt;
      if (s.a > LIMB_MAX) { s.a = LIMB_MAX; s.v *= 0.5; }
      if (s.a < -LIMB_MAX) { s.a = -LIMB_MAX; s.v *= 0.5; }
      if (!S.dragging && Math.abs(s.a) < 0.002 && Math.abs(s.v) < 0.01) { s.a = 0; s.v = 0; }
    }
  }

  // 拖拽期间关掉内核自动眨眼（改由本层自管，频率面板可调）：
  // 窗口被常驻 helper 以 8ms 级推动时渲染端会掉帧/冻结，眨眼若卡在闭眼段就会一直闭着
  // （实测「拖拽时眼睛是闭上的」）⇒ 拖拽期间强制睁眼。内核 autoBlink 恒关、由下面自管。
  rt.autoBlink = false;
  if (S.dragging) {
    const t = performance.now();
    if (!S._ticks) S._ticks = { n: 0, t0: t };
    S._ticks.n++;
    if (t - S._ticks.t0 > 500) {
      console.log('DRAG_TICK fps=' + Math.round(S._ticks.n * 1000 / (t - S._ticks.t0)) +
        ' dt=' + dt.toFixed(3));
      S._ticks = { n: 0, t0: t };
    }
  } else if (S._ticks) { S._ticks = null; }

  // ★ 口型：平时微笑、点击/拖拽三角、语音接上后张嘴（S.speaking 接口先留着）
  if (rt.setMouth) {
    const mm = S.speaking ? 'open' : ((S.dragging || S.clickPulse > 0.05) ? 'triangle' : 'smile');
    if (S._mouth !== mm) { S._mouth = mm; rt.setMouth(mm); console.log('MOUTH ' + mm); }
  }
  // ★ 尾巴（多角色，有尾巴的角色才有）：平时慢慢摆、点尾巴 / 开口说话时甩几下、拖动时往反方向拖着（二阶弹簧）
  //   模型自己的尾巴物理（ParamTail）跟身体摆动走，这里只写另一层 ParamTailWag
  if (CH.tail && rt.setExtra) {
    const tw = CH.tail;
    let w = 0;
    if (!S.dragging && tw.idleAmp) w += tw.idleAmp * Math.sin((now / 1000) * Math.PI * 2 / (tw.idlePeriod || 4));
    if (S.wagT0) {
      const t = (now - S.wagT0) / 1000;
      if (t > 4) S.wagT0 = 0;
      else w += (S.wagAmp || 1) * Math.exp(-t * (tw.burstDecay || 1.5)) * Math.sin(2 * Math.PI * (tw.burstFreq || 2.2) * t);
    }
    const tgt = S.dragging ? Math.max(-1, Math.min(1, -(S.dragVX / LIMB_VREF) * (tw.dragGain || 1))) : 0;
    S.tailV = (S.tailV || 0) + (60 * (tgt - (S.tailA || 0)) - 7 * (S.tailV || 0)) * dt;
    S.tailA = (S.tailA || 0) + S.tailV * dt;
    w += S.tailA;
    rt.setExtra(tw.param || 'ParamTailWag', Math.max(-1, Math.min(1, w)));
  }
  rt.update(dt, ov);
  hitMaskUpdate(now);
  reportHitbox();
  // 爱心眼（瞳孔之上、前发之下的叠加层）：常驻开关由菜单控制
  heart.update(dt);
  // ★ 点击脉冲的缩放系数：stage 的 transform 与 heartfx（独立 #fx 层）**必须共用这同一个值**，
  //   否则点击那 0.2 秒里 stage 缩了、爱心没缩 ⇒ 爱心相对眼睛错位（实测「爱心点击时没有贴合眼睛」）。
  const pulseScale = S.scalePulse > 0.01 ? (1 - S.scalePulse * 0.08) : 1;
  heart.draw(S.view, pulseScale);
  // ★ 点击反馈缩放（实测「点击时超出框外、有被裁剪的效果」）：
  //   根因＝**几何上必然**：fit() 让 stage 尺寸＝窗口（角色铺满），以中心放大 12% ⇒ 四边各溢 6%，
  //   窗口边界一裁就露馅（PSD 模式同样如此，是老毛病）。
  //   修法＝改成**缩一下**（绝不溢出），并把 origin 钉在**底部中心** ⇒ 脚不动、像被手指按了一下。
  stage.style.transform = pulseScale !== 1 ? 'scale(' + pulseScale.toFixed(4) + ')' : 'none';
  requestAnimationFrame(loop);
}

// ---- 爱心眼：独立叠加层（heartfx.js），开关走主进程菜单 ----
const heart = new HeartFx(document.getElementById('fx'));

// ---- 服装 / 配件开关：勾选＝显示。键和对应的部件（drawable）写在角色档案的 cloth.keys / rig.cloth 里，
//      由适配层按 drawable 名把不透明度压 0（见 live2d-adapter.setCloth） ----
const CLOTH = { on: {} };
function applyCloth() {
  if (rt && rt.setCloth) rt.setCloth(CLOTH.on);
}

// ---- ★ 多角色：点到哪儿、甩尾、换角色 ----
// 点击落在模型的哪一组部件（档案 rig.hit：head / tail …）；只有 live2d 后端有 hitPart
function clickPart(cssX, cssY) {
  if (!rt || !rt.hitPart) return null;
  const { sc, tx, ty } = modelScale();
  try { return rt.hitPart((cssX - tx) / sc, (cssY - ty) / sc); } catch (e) { return null; }
}
// 甩尾：振幅 amp 的一阵衰减摆动（loop 里按 CH.tail 的频率 / 衰减算）
function wagBurst(amp) {
  if (!CH.tail) return;
  S.wagT0 = performance.now();
  S.wagAmp = amp;
}
// 换角色：淡出 → 放掉旧模型 → 同一块画布载新模型 → 按新角色的衣服 / 摆动重新套上 → 淡入。
//   reload = 同一个角色的模型重新生成过（PSD 保存了），也走这一套。
//   失败就整页重载（主进程那边已经是新角色 / 新模型了，重载后按它启动）
let swapping = null;
async function swapCharacter(info, reload) {
  if (!info || !info.id) return;
  if (swapping) { swapping.next = { info, reload: !!reload || !!(swapping.next && swapping.next.reload) }; return; }   // 正在换：换完再按最后一次的来
  if (info.id === CH.id && rt && !reload) { CH = Object.assign({}, CH, info); return; }
  swapping = { next: null };
  console.log((reload ? 'CHAR reload ' + info.id + ' ' + info.modelUrl : 'CHAR swap ' + CH.id + ' -> ' + info.id));
  stage.style.transition = 'opacity 0.18s';
  stage.style.opacity = '0';
  await new Promise((r) => setTimeout(r, 200));
  const old = rt;
  rt = null;   // loop 在 rt 为空时只空转
  try { if (old && old.release) old.release(); } catch (e) { console.log('CHAR release failed: ' + (e && e.message)); }
  CH = Object.assign({ id: '', name: '', modelUrl: null, rig: null, lines: null, tail: null }, info);
  if (!CH.modelUrl) {
    // 新角色画不出来（模型还没有 / 生成失败）：不载入，气泡说原因
    console.log('CHAR ' + CH.id + ' has no model: ' + CH.problem);
    showProblem(CH.problem);
  } else try {
    const { createLive2DRuntime } = await import('./live2d-adapter.js');
    const next = await createLive2DRuntime(stage, { log: console.log, modelUrl: CH.modelUrl || undefined, rig: CH.rig });
    S._fit2 = 0; S.view = null; S._mouth = null;
    S.wagT0 = 0; S.tailA = 0; S.tailV = 0;
    HM.at = 0; HM.logged = false;   // 命中轮廓下一帧按新模型重算
    rt = next;
    fit();
    heart.attach(rt);
    if (info.cloth) CLOTH.on = Object.assign({}, info.cloth);
    applyCloth();
    applyTune(TUNE);
    console.log('CHAR ready ' + CH.id + ' bounds=' + JSON.stringify(rt.characterBounds));
  } catch (e) {
    console.log('CHAR swap failed: ' + (e && e.message) + ' -> reload');
    location.reload();
    return;
  }
  stage.style.opacity = '1';
  const pending = swapping.next;
  swapping = null;
  if (pending) void swapCharacter(pending.info, pending.reload);
}

async function boot() {
  // ★ 多角色：先问主进程现在是谁（模型 / rig / 尾巴 / 台词），再载入
  try {
    if (window.petAPI.characterState) CH = Object.assign({}, CH, await window.petAPI.characterState());
  } catch (e) { console.log('CHAR state failed: ' + (e && e.message)); }
  console.log('CHAR ' + (CH.id || '(none)') + ' model=' + (CH.modelUrl || '(none)'));
  // 画不出角色（没装运行库 / 没有角色 / 模型还没有 / 载入失败）：气泡里挂着原因，窗口里什么都不画；
  //   主进程那边情况变了（模型生成好了 / 换了角色）就整页重来
  const stuck = (text) => {
    showProblem(text);
    if (window.petAPI.onModelReload) window.petAPI.onModelReload(() => location.reload());
    if (window.petAPI.onCharacter) window.petAPI.onCharacter(() => location.reload());
  };
  if (!CH.modelUrl) { stuck(CH.problem); return; }
  try {
    const { createLive2DRuntime } = await import('./live2d-adapter.js');
    rt = await createLive2DRuntime(stage, { log: console.log, modelUrl: CH.modelUrl, rig: CH.rig });
  } catch (e) {
    console.log('LIVE2D load failed: ' + (e && e.message));
    stuck('模型载入失败：' + ((e && e.message) || e));
    return;
  }
  console.log('LIVE2D backend ready  bounds=' + JSON.stringify(rt.characterBounds));

  fit();
  heart.attach(rt);
  if (window.petAPI.onHeart) window.petAPI.onHeart((v) => { heart.setOn(v); console.log('HEART on=' + v); });
  // 服装穿脱状态：订阅 + 启动时主动拉一次
  if (window.petAPI.onCloth) {
    window.petAPI.onCloth((v) => { CLOTH.on = Object.assign({}, v); applyCloth(); console.log('CLOTH ' + JSON.stringify(CLOTH.on)); });
  }
  if (window.petAPI.clothState) {
    const cv = await window.petAPI.clothState();
    CLOTH.on = Object.assign({}, cv);
    applyCloth();
    console.log('CLOTH state=' + JSON.stringify(CLOTH.on));
  }
  // ★ 多角色：主进程换了角色（菜单 / 控制中心 / 本机接口）⇒ 原地换模型
  if (window.petAPI.onCharacter) window.petAPI.onCharacter((info) => { void swapCharacter(info); });
  // ★ 模型实时生成：PSD 保存后主进程生成好新模型 ⇒ 同一个角色原地重载
  if (window.petAPI.onModelReload) window.petAPI.onModelReload((info) => { void swapCharacter(info, true); });
  // 外观调节（摇晃/头部/身体比例）：订阅面板改动 + 启动主动拉一次
  if (window.petAPI.onTune) window.petAPI.onTune((t) => applyTune(t));
  if (window.petAPI.tuneState) {
    try { applyTune(await window.petAPI.tuneState()); } catch (e) { /* ignore */ }
  }
  if (window.petAPI.heartState) {           // 启动时同步一次菜单开关状态（PET_HEART=1 会默认开着）
    const v = await window.petAPI.heartState();
    heart.setOn(v);
    console.log('HEART state=' + v);
  }
  // ★ 气泡总开关：订阅 + 启动时主动拉一次（面板/菜单改了即时生效，早发的会丢所以自己拉）
  if (window.petAPI.onBubble) {
    window.petAPI.onBubble((v) => {
      bubbleOn = !!v;
      if (!bubbleOn && bubbleEl) bubbleEl.classList.remove('show');
      console.log('BUBBLE on=' + bubbleOn);
    });
  }
  if (window.petAPI.bubbleState) {
    try { bubbleOn = !!(await window.petAPI.bubbleState()); } catch (e) { /* ignore */ }
    console.log('BUBBLE state=' + bubbleOn);
  }
  // ★ 台词行开关：同上一套（订阅 + 启动主动拉一次）
  if (window.petAPI.onBubbleSay) {
    window.petAPI.onBubbleSay((v) => { bubbleSay = !!v; console.log('BUBBLE say=' + bubbleSay); });
  }
  if (window.petAPI.bubbleSayState) {
    try { bubbleSay = !!(await window.petAPI.bubbleSayState()); } catch (e) { /* ignore */ }
    console.log('BUBBLE say state=' + bubbleSay);
  }
  if (window.petAPI.onCursor) {
    window.petAPI.onCursor((d) => { S.win = d; S.cursor = { x: d.sx, y: d.sy }; });
  }
  if (window.petAPI.onAction) {
    window.petAPI.onAction((id) => startAction(id ? findAction(id) : pickPoolAction('mid')));
  }
  // ★ 系统唤醒自愈：主进程发来 pet:wake ⇒ 清掉可能卡住的拖拽/物理状态（症状＝息屏后拖不动）
  if (window.petAPI.onWake) {
    window.petAPI.onWake(() => {
      S.dragging = false;
      S.dragVX = 0; S.dragVY = 0; S._dragVAt = 0;
      S.swingAngle = 0; S.swingVel = 0; S.squint = 0;
      S.clickPulse = 0; S.scalePulse = 0;
      S._dragLog = 0;                 // 让下次拖拽能重新打印 DRAG_START
      console.log('WAKE reset renderer drag state');
    });
  }
  // ★ 流式说话：主进程边合成边推分块 → 排程连播；失败则收声
  if (window.petAPI.onSayChunk) {
    window.petAPI.onSayChunk((d) => { if (d && d.b64) sayPlayChunk(d.b64, d.sampleRate); });
  }
  if (window.petAPI.onSayEnd) {
    window.petAPI.onSayEnd((d) => { console.log('SAY stream end segs=' + (d && d.segments)); });
  }
  if (window.petAPI.onSayFail) {
    window.petAPI.onSayFail(() => { sayStop('say-fail'); console.log('SAY fail'); });
  }
  // ★ 停下（快捷键 / 菜单 / 控制中心 / 本机接口）：已排上的音频也掐掉
  if (window.petAPI.onSayStop) {
    window.petAPI.onSayStop(() => { sayStop('stop', true); });
  }
  // ★ 即时反馈：合成中先动一下 —— 三角嘴脉冲 + 轻微弹跳，表示「听到了」
  if (window.petAPI.onSayPending) {
    window.petAPI.onSayPending(() => {
      S.clickPulse = 1.0; S.scalePulse = 0.5;
      if (CH.tail) wagBurst(CH.tail.sayAmp || 0.45);   // 有尾巴的角色开口前甩一下
      console.log('SAY think');
    });
  }
  if (window.petAPI.onDragVel) {
    // 拖拽速度流（主进程差分窗口位移得来）：喂物理弹簧，并代替 mousemove 给看门狗续期
    //（窗口跟手走 ⇒ 鼠标相对窗口几乎不动，mousemove 不一定派发；不续期会被 1.5s 看门狗误杀）
    window.petAPI.onDragVel((d) => {
      S.dragVX = d.vx || 0;
      S.dragVY = d.vy || 0;
      S._dragVAt = performance.now();
      if (S.dragging) S._dragAt = performance.now();
      if (!d.dragging && S.dragging) endNativeDrag();
    });
  }
  if (window.petAPI.onInside) {
    // 主进程的权威命中判定（穿透/接管由它切）——用它更新光标形状，不依赖本地 mousemove
    window.petAPI.onInside((v) => {
      document.body.style.cursor = v ? 'grab' : 'default';
      console.log('INSIDE ' + v);
    });
  }
  // ★ 输入兜底（2026-09-21）：拖动由 helper 自己发起 ⇒ 主进程推 dragauto，渲染端只管视觉态
  if (window.petAPI.onDragAuto) {
    window.petAPI.onDragAuto((on) => {
      if (on) {
        S.dragging = true;
        S._dragAt = performance.now();
        S.dragVX = 0; S.dragVY = 0; S._dragVAt = 0;
        document.body.classList.add('pet-drag');
      } else if (S.dragging) {
        S.dragging = false;   // 不调 nativeDragEnd：helper 已经自己停了
      }
      console.log('DRAGAUTO ' + on);
    });
  }
  // ★ 兜底单击：窗口收不到 mousedown 时，由主进程代播点击反馈
  if (window.petAPI.onClicked) {
    window.petAPI.onClicked((payload) => {
      S.clickPulse = 1;
      S.scalePulse = 1;
      playClickSound();
      // ★ 2026-10-17：兜底点击带着位置（窗口内 CSS 像素）⇒ 点头抖耳、点尾巴甩尾照常
      const at = payload && payload.at;
      const part = at ? clickPart(at.x, at.y) : null;
      if (part === 'head' && rt && rt.earTwitch) rt.earTwitch();
      else if (part === 'tail') wagBurst(CH.tail ? (CH.tail.burstAmp || 0.9) : 0);
      if (payload) showBubble(payload);
      console.log('CLICKED (auto)' + (part ? ' part=' + part : ''));
    });
  }
  if (window.petAPI.onDragIdle) {
    window.petAPI.onDragIdle(() => document.body.classList.remove('pet-drag'));
  }
  requestAnimationFrame(loop);
}

window.addEventListener('resize', fit);
window.addEventListener('mousemove', (e) => {
  // ★ 点/拖分离：待定期内移动超过阈值才真正起拖（纯单击不动窗口）
  if (pendingDrag && !S.dragging) {
    const dx = e.clientX - pendingDrag.x, dy = e.clientY - pendingDrag.y;
    if (dx * dx + dy * dy >= DRAG_SLOP * DRAG_SLOP) {
      pendingDrag = null;
      S.dragging = true;
      S._dragAt = performance.now();
      S.dragVX = 0; S.dragVY = 0; S._dragVAt = 0;   // 起手不留上一次的速度残值
      window.petAPI.nativeDragStart();
    }
  }
  const inside = hitTest(e.clientX, e.clientY);
  if (inside !== S._inside) {
    S._inside = inside;
    console.log('HIT ' + inside);
    // ⚠️ 这里**不再**切 setIgnoreMouseEvents：穿透开关已交主进程（它按光标轮询自己判命中）。
    //    两边都切会互相打架，而且上层窗口吃掉鼠标时这里根本收不到事件 ⇒ 会永久卡在穿透态。
    document.body.style.cursor = inside ? 'grab' : 'default';
  }
  if (S.dragging) S._dragAt = performance.now();   // 看门狗续期
});
// 右键菜单：mousedown(btn=2) 已直接弹菜单；这里保留 contextmenu 作双保险
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.petAPI.menu();
});
// 左键命中 → 交给「原生跟随器」（独立进程以 8ms 周期 SetWindowPos 移动窗口）
// 不走 app-region，所以右键/悬停照常；跟手靠的是进程外的短周期循环
// ★ 点/拖分离（实测「说话时点角色一下就退出说话状态」）：
//   按下**只记 pendingDrag**，移动超过 DRAG_SLOP 像素才真正起拖 ⇒ 纯单击不再触发 DRAG_START
//   （此前 mousedown 立刻 S.dragging=true，点一下窗口就被原生 helper 抖一次）。
const DRAG_SLOP = 4;
let pendingDrag = null;
// ★ 诊断（2026-10-17）：按下以什么形式到了页面（mouse / pen / touch），和下面的 MDOWN 对照着看
window.addEventListener('pointerdown', (e) => {
  console.log('PDOWN ' + e.pointerType + ' btn=' + e.button + ' at=' + Math.round(e.clientX) + ',' + Math.round(e.clientY));
}, true);
window.addEventListener('mousedown', (e) => {
  // ★ 拖不动排障（2026-09-21）：一行日志看穿「事件到没到渲染端」「有没有点中角色」
  try {
    console.log('MDOWN btn=' + e.button + ' at=' + Math.round(e.clientX) + ',' + Math.round(e.clientY) +
      ' hit=' + hitTest(e.clientX, e.clientY));
  } catch (err) { console.log('MDOWN log failed'); }
  // 右键：直接在这里弹菜单，不等 contextmenu
  // （无边框 + 不聚焦的窗口下，Chromium 不一定派发 contextmenu；而 mousedown 实测能到）
  if (e.button === 2) {
    e.preventDefault();
    window.petAPI.menu();
    return;
  }
  if (e.button === 0 && hitTest(e.clientX, e.clientY)) {
    // ★ 点击反馈（照 Petra playClick）：音效 + 动画脉冲（嘴张、整体缩放）
    S.clickPulse = 1;
    S.scalePulse = 1;
    playClickSound();
    // ★ 多角色：点头抖耳朵、点尾巴甩尾（档案里没有耳朵 / 尾巴的角色照旧）
    const part = clickPart(e.clientX, e.clientY);
    if (part === 'head' && rt && rt.earTwitch) rt.earTwitch();
    else if (part === 'tail') wagBurst(CH.tail ? (CH.tail.burstAmp || 0.9) : 0);
    if (part) console.log('CLICK part=' + part);
    // ★ 陪伴统计：被摸 +1（主进程累加并落盘）⇒ 回传累计值，头顶气泡显示
    if (window.petAPI.click) {
      window.petAPI.click().then((st) => showBubble(st)).catch(() => {});
    }
    // ★ 点/拖分离：按下先待定（见本段上方 DRAG_SLOP），移动够了才在 mousemove 里起拖
    pendingDrag = { x: e.clientX, y: e.clientY, t: performance.now() };
  }
});
window.addEventListener('mouseup', () => { pendingDrag = null; });
const endNativeDrag = () => {
  if (!S.dragging) return;
  S.dragging = false;
  window.petAPI.nativeDragEnd();
};
window.addEventListener('blur', endNativeDrag);
setInterval(() => {
  if (S.dragging && performance.now() - (S._dragAt || 0) > 1500) endNativeDrag();
}, 400);
// 尺寸守卫：窗口/画布尺寸一旦变化就记录（定位「长按变大」）
setInterval(() => {
  const w = areaW(), h = areaH();
  const cw = stage.style.width;
  if (S._lastW !== undefined && (S._lastW !== w || S._lastH !== h || S._lastCss !== cw)) {
    console.log('SIZE_CHANGE win=' + S._lastW + 'x' + S._lastH + ' -> ' + w + 'x' + h +
      ' css=' + S._lastCss + ' -> ' + cw);
  }
  S._lastW = w; S._lastH = h; S._lastCss = cw;
}, 500);
window.addEventListener('mouseup', endNativeDrag);
window.addEventListener('contextmenu', (e) => { e.preventDefault(); window.petAPI.menu(); });

boot();
