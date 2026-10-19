// Live2D 桌宠 · 主进程（透明置顶窗口 + 穿透命中测试 + 拖拽 + 托盘/右键菜单 + 语音 + 本机接口）
const { app, BrowserWindow, ipcMain, screen, Tray, nativeImage, powerMonitor, globalShortcut, shell, safeStorage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const voice = require('./src/voice');
const localApi = require('./src/local-api');
const { startPos, menuPos, besidePos } = require('./src/window-pos');
const { fileSha1, readStamp, sameOpts, stampCurrent } = require('./src/model-stamp');

// ---- 数据目录：设置、统计、日志都放在用户数据目录（不写进程序目录）；PET_DATA_DIR 可改（测试用）----
const DATA_DIR = process.env.PET_DATA_DIR ? path.resolve(process.env.PET_DATA_DIR) : app.getPath('userData');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }

// ---- 只开一只：已经开着时再启动，就把开着的那只亮出来、自己退出（锁跟着 Electron 的用户数据目录走，测试实例换 --user-data-dir）----
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => restoreFromTray());

// ---- 配置（尺寸 + 服装）：持久化到 config.json ----
const SIZES = { small: 300, normal: 430, large: 580 };   // 旧三档，作滑条刻度参考
const SIZE_MIN = 200, SIZE_MAX = 800;
// ★ 窗口顶部给「点击气泡」预留的高度（px）：窗口高 = 宽 + 这个值
//   渲染端按 h-w 自行推断带宽，无需两边同步常量。
//   数据大字、台词小字分开⇒ 上行 15px 数据（both 模式两行）＋ 下行 10.5px 台词，留 74 够用
const BUBBLE_BAND = 66;          // ★ 2026-09-26（方案 B）：气泡带固定 66px —— 点一下才弹、带宽常驻 ⇒ 点角色时窗口不跳
const BUBBLE_BAND_NO_SAY = 66;   // 旧常量名保留（外部若引用不破），值同 66
// ★ 气泡总开关：关掉气泡时窗口高度不再留这条带 ⇒ 窗口变回正方形、角色上移贴底
// ★ 渲染端实测的气泡高度（pet:bubble-height 上报；0 = 还没测过 ⇒ 用固定滑条值）
let bubbleBandOverride = 0;
function bandPx() {
  // ★ 「气泡高度自适应」：带宽优先用渲染端实测的气泡高度（bubbleBandOverride），
  //   没实测值才回退到控制中心滑条 hPx；关掉气泡则带宽 0。
  if (!cfg.bubble.on) return 0;
  const base = bubbleBandOverride > 0 ? bubbleBandOverride : (cfg.bubble.hPx || BUBBLE_BAND);
  return Math.max(40, Math.min(340, Math.round(base)));
}
const CFG_PATH = path.join(DATA_DIR, 'config.json');
// ★ 气泡内容编排：可编排项 id / 中文名
const BUBBLE_ITEM_KEYS = ['days', 'touches', 'voice', 'custom'];
const BUBBLE_ITEM_LABEL = {
  days: '陪伴天数', touches: '被摸次数', voice: '语音状态', custom: '自定义文本',
};
// ★ 短标签：窄窗用简称，宽够时用全称
const BUBBLE_ITEM_SHORT = {
  days: '天数', touches: '被摸', voice: '语音', custom: '自定义',
};
// ★ 主题白名单（与渲染端 class 一一对应，loadCfg 与 center:theme 共用同一份，禁止别处再写一遍）
const THEME_STYLES = ['glass', 'acrylic', 'flat'];
const THEME_COLORS = ['sakura', 'celadon', 'midnight', 'amber', 'ink'];   // ink = 墨朱（苏墨默认）
const cfg = {
  size: SIZES.normal,
  cloth: {},                     // 服装 / 配件开关：键来自当前角色档案的 cloth.keys（true = 显示）
  bubble: {
    on: true,                    // ★ 总开关：关掉＝点一下不冒气泡，顶部气泡带一并收掉；被摸次数照旧累计
    say: true,                   // ★ 台词行：关掉＝说话时也不显示台词
    // ★ 气泡内容编排（点击后有气泡，内容可自由编排）：
    items: ['days', 'touches'],  // 点角色后数据行显示哪些项（顺序见 order）
    order: ['days', 'touches', 'voice', 'custom'],  // 编排器里的排序
    levels: { days: 'big', touches: 'big' },   // 每项字级：big 大字行 / small 小字行
    custom: '',                  // 'custom' 项的自定义文本（跟角色走，默认取档案里的 custom）
    // ★ 气泡长宽（横着的气泡，长宽用设置里的滑条调）：
    wPct: 96,     // 宽度 = 窗宽 × wPct%（60–100）
    hPx: 78,      // 高度 px（40–200）—— 同时也是窗口顶部那条气泡带的高度
  },
  // ★ 主题：3 质感 × 5 颜色，只改渲染端 class + CSS 变量
  theme: { style: 'glass', color: 'sakura' },
  autostart: false,            // ★ 开机自启（Electron 登录项；真实调用 app.setLoginItemSettings）
  pos: null,                   // 窗口左上角 {x, y}（DIP），拖完自动记；不在任何屏幕上就放主屏右下角
  // ★ 不影响鼠标（点击穿透）：true ＝ 整窗永不接管鼠标，点哪都落到下面窗口。
  //   代价：角色也点不到、拖不动、不冒气泡、点击不计数；
  //   恢复入口＝托盘图标的菜单（托盘不在桌宠窗口里，穿透后照旧点得动）。
  mouseThrough: false,
  // ★ 语音：合成服务按 engines 的顺序试，谁先出声算谁的（见 src/voice）
  voice: voice.defaultConfig(),
  // ★ 本机接口（给插件用：让桌宠说话、做动作、查状态；只听 127.0.0.1）
  api: { enabled: true, port: 18932 },
  // 外观调节（设置面板里可视化）：摇晃 / 头部 / 身体比例
  tune: {
    swayPeriod: 2.0,   // 持续摇晃周期（秒，越大越慢）
    swayBody: 1.0,     // 前后摆幅（Petra sway 动作原值 1.0）
    swayZ: 0.5,        // 左右摆幅（Petra sway 原值 0.5＝body 的一半）
    // ★ 呼吸（「live2d 也有一个呼吸参数，都可以在设置里调」）
    //   live2d 侧写模型自带的 ParamBreath（周期与 PSD 内核同款默认 3.4s）；
    //   psd 侧内核只吃周期（幅度在 psd 内核里是写死的像素量）
    breathPeriod: 3.4, // 呼吸周期（秒）
    breathAmp: 1.0,    // 呼吸幅度（1.0 = ParamBreath 走满整个范围）
    // ★ 视线追随灵敏度（「眼睛和面部追随鼠标的灵敏度也可以分别调」）
    //   0 = 完全不追；1.0 = 最初口径；2.0 = 幅度翻倍
    headFollow: 1.0,
    eyeFollow: 1.0,
    dragTilt: 0.5,     // 拖拽时头跟着倾的比例（0＝头完全稳、1＝跟身体一起倒）
    dragBody: 1.0,     // 拖拽时身体摆幅倍数（0＝身体不动、1＝满幅）
    // ★ 手臂（含袖子）摆动幅度倍率（「拖拽时手臂摆动幅度太大」）
    //   照搬 PSD 的 LIMB_CFG gain(0.46) 在 live2d 上偏大 ⇒ 默认缩到 0.5
    limbArm: 1.0,
    headDy: 24,        // 头整体下移（画布 px，正数向下；脖子属 body 组不动 ⇒ 视觉上脖子变短）
    bodySx: 1.0,       // 身体横向比例（**不影响头部**：头只跟着颈根位置平移）
    bodySy: 1.0,       // 身体纵向比例（同上）
    blinkMin: 1.6,     // 眨眼最短间隔（秒）——渲染端自管眨眼（内核 autoBlink 关掉）
    blinkMax: 5.4,     // 眨眼最长间隔（秒）
    blinkDouble: 0.18, // 连眨概率（0–1）
    clickVol: 0.25,    // 点击反馈音效音量（0–1，0＝静音）
  },
};
// 每一项的 [min, max, step] —— 面板滑条与主进程 clamp 共用同一份，避免两边漂移
const TUNE_RANGE = {
  swayPeriod: [0.6, 6, 0.1],
  swayBody: [0, 2, 0.05],
  swayZ: [0, 1.5, 0.05],
  breathPeriod: [1.5, 8, 0.1],
  breathAmp: [0, 2, 0.05],
  headFollow: [0, 2, 0.05],
  eyeFollow: [0, 2, 0.05],
  dragTilt: [0, 1, 0.05],
  dragBody: [0, 2, 0.05],
  limbArm: [0, 1.5, 0.05],
  headDy: [-80, 80, 1],
  bodySx: [0.6, 1.6, 0.01],
  bodySy: [0.6, 1.6, 0.01],
  blinkMin: [0.4, 8, 0.1],
  blinkMax: [0.6, 12, 0.1],
  blinkDouble: [0, 1, 0.01],
  clickVol: [0, 1, 0.05],
};
function clampTune(k, v) {
  const r = TUNE_RANGE[k];
  if (!r || typeof v !== 'number' || !isFinite(v)) return undefined;
  return Math.round(Math.max(r[0], Math.min(r[1], v)) * 1000) / 1000;
}
// ★ 参数默认值快照（控制中心「复位 / 恢复默认」用）：必须在任何 loadCfg/面板改动之前取一次
const TUNE_DEFAULTS = JSON.parse(JSON.stringify(cfg.tune));

// ---- ★ 角色 ----
//   角色档案 <id>.json：名字、称呼、模型、主题、服装 / 配件开关、rig（部件 / 枢轴 / 口型 / 点击分区）、尾巴、台词。
//   从两处读：程序目录的 characters/（随程序发布的），用户数据目录的 characters/（自己加的，同 id 的盖过前者）。
//   档案里的相对路径（model / psd）按档案所在目录算。
//   cfg.character = '' ⇒ 显示排第一的角色（order 最小）；写了角色 id ⇒ 固定显示这一个。
//   cfg.chars[id] = { cloth, tune, theme, custom }：每个角色自己的一份；顶层的 cfg.cloth / tune / theme / bubble.custom
//   始终是「当前角色」的那份（saveCfg 时同步回 cfg.chars[当前角色]）。
const CHAR_DIRS = [path.join(__dirname, 'characters'), path.join(DATA_DIR, 'characters')];
const CHARS = {};
let DEFAULT_CHAR = '';
let activeChar = '';
cfg.character = '';
cfg.chars = {};
function loadProfiles() {
  for (const dir of CHAR_DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (p && typeof p.id === 'string' && /^[a-z0-9-]+$/.test(p.id) && typeof p.model === 'string') {
          // 程序目录里的档案：路径按程序目录算（characters/ 的上一级）；自己加的：按档案所在目录算
          p._base = dir === CHAR_DIRS[0] ? __dirname : dir;
          CHARS[p.id] = p;
        } else plog('character ' + f + ' skipped (no id / model)');
      } catch (e) { plog('character ' + f + ' bad json: ' + e.message); }
    }
  }
  const ids = Object.values(CHARS).sort((a, b) => (a.order || 99) - (b.order || 99)).map((p) => p.id);
  DEFAULT_CHAR = ids[0] || '';
  plog('characters: ' + (ids.join(',') || '(none)'));
}
function charPath(p, rel) { return path.isAbsolute(rel) ? rel : path.join(p._base || __dirname, rel); }
// 一个角色都没有时给个空档案，免得到处判空（窗口里什么都不画，控制中心会提示）
const NO_CHAR = { id: '', name: '桌宠', model: '' };
function prof(id) { return CHARS[id || activeChar] || CHARS[DEFAULT_CHAR] || NO_CHAR; }
function charList() {
  return Object.values(CHARS).sort((a, b) => (a.order || 99) - (b.order || 99)).map((p) => ({ id: p.id, name: p.name }));
}
function clothKeys(id) { const c = prof(id).cloth; return c && Array.isArray(c.keys) ? c.keys : []; }
function clothLabels(id) { const c = prof(id).cloth; return (c && c.labels) || {}; }
function tuneWithOverrides(base, id) {
  const t = Object.assign({}, TUNE_DEFAULTS, base || {});
  const o = prof(id).tune || {};
  for (const k in TUNE_RANGE) { const v = clampTune(k, Number(o[k])); if (v !== undefined) t[k] = v; }
  return t;
}
// 「恢复默认」用：代码默认值 + 档案里的覆盖
function defaultTune(id) { return tuneWithOverrides(null, id); }
function initialTune(id) { return defaultTune(id); }
function defaultTheme(id) {
  const t = prof(id).theme || {};
  return { style: THEME_STYLES.indexOf(t.style) >= 0 ? t.style : 'glass', color: THEME_COLORS.indexOf(t.color) >= 0 ? t.color : 'sakura' };
}
// 把存档里的一份角色设置理顺（缺的补默认，不认识的丢掉）
function cleanCharState(id, s) {
  s = s && typeof s === 'object' ? s : {};
  const cloth = {};
  for (const k of clothKeys(id)) cloth[k] = !(s.cloth && s.cloth[k] === false);
  const tune = s.tune && typeof s.tune === 'object' ? tuneWithOverrides(null, id) : initialTune(id);
  if (s.tune && typeof s.tune === 'object') for (const k in TUNE_RANGE) { const v = clampTune(k, Number(s.tune[k])); if (v !== undefined) tune[k] = v; }
  const theme = defaultTheme(id);
  if (s.theme && THEME_STYLES.indexOf(s.theme.style) >= 0) theme.style = s.theme.style;
  if (s.theme && THEME_COLORS.indexOf(s.theme.color) >= 0) theme.color = s.theme.color;
  const custom = typeof s.custom === 'string' ? s.custom.slice(0, 60) : String(prof(id).custom || '').slice(0, 60);
  return { cloth, tune, theme, custom };
}
function charState(id) {
  if (!cfg.chars[id]) cfg.chars[id] = cleanCharState(id, null);
  return cfg.chars[id];
}
// 当前角色的那份 → 顶层（老代码读写的地方）
function loadLive(id) {
  const st = charState(id);
  cfg.cloth = Object.assign({}, st.cloth);
  cfg.tune = Object.assign({}, st.tune);
  cfg.theme = Object.assign({}, st.theme);
  cfg.bubble.custom = st.custom;
}
// 顶层 → 当前角色的那份（saveCfg 前调）
function syncLive() {
  cfg.chars[activeChar] = { cloth: Object.assign({}, cfg.cloth), tune: Object.assign({}, cfg.tune), theme: Object.assign({}, cfg.theme), custom: cfg.bubble.custom };
}
function resolveChar() {
  let id = DEFAULT_CHAR;
  if (CHARS[cfg.character]) id = cfg.character;
  // 模型文件还没有（刚登记 PSD、还在生成）⇒ 先显示默认角色；生成好了 mbBuild 会再换过来
  if (id !== DEFAULT_CHAR && !fs.existsSync(modelFile(id))) return DEFAULT_CHAR;
  return id;
}
// 画不出角色的原因（没装 Live2D 运行库 / 没有角色 / 模型文件不在 / 正在生成）：渲染端在气泡里一直挂着这句
function vendorReady() {
  const v = path.join(__dirname, 'renderer', 'vendor', 'live2d');
  return fs.existsSync(path.join(v, 'live2dcubismcore.min.js')) && fs.existsSync(path.join(v, 'pet-live2d.js'));
}
function modelProblem(p) {
  if (!vendorReady()) return '还没装 Live2D 运行库：在项目目录运行 npm run setup（见 README）';
  if (!p.id) return '还没有角色：在 characters/ 里放一份角色档案（见 docs/characters.md）';
  if (!p.model) return p.name + '的档案里没写模型（model）';
  if (fs.existsSync(modelFile(p.id))) return '';
  const psd = psdPath(p.id);
  if (psd && fs.existsSync(psd)) {
    const st = MB.st[p.id] || {};
    if (st.state === 'error') return p.name + '的模型生成失败：' + st.message;
    const miss = mbMissing();
    if (miss.length) return p.name + '的模型还没生成：缺 ' + miss.map((m) => path.basename(m)).join('、') + '（见 README「从 PSD 生成模型」）';
    return '正在用 PSD 生成' + p.name + '的模型……';
  }
  return p.name + '的模型文件不在：' + path.relative(__dirname, modelFile(p.id)).split(path.sep).join('/') + '（见 README「角色模型」）';
}
// 渲染端要的：模型、rig、尾巴、台词、衣服状态
//   模型这次运行里重新生成过 ⇒ 地址带 ?v=<时刻>，渲染端连贴图一起绕开缓存
function characterInfo() {
  const p = prof();
  const problem = modelProblem(p);
  const model = problem ? '' : modelFile(p.id);
  return {
    id: p.id, name: p.name, callUser: p.callUser || '主人', title: p.title || '', problem,
    modelUrl: model ? pathToFileURL(model).href + (MB.rev[p.id] ? '?v=' + MB.rev[p.id] : '') : '',
    rig: p.rig || null, lines: p.lines || null, tail: p.tail || null,
    cloth: cfg.cloth,
  };
}
// 菜单 / 控制中心要的
function charSnapshot() {
  const p = prof();
  return { mode: cfg.character, active: activeChar, name: p.name, callUser: p.callUser || '主人', list: charList(),
    defaultCustom: String(p.custom || ''), defaultTheme: defaultTheme(activeChar),
    demoLine: p.lines && Array.isArray(p.lines.stats) && p.lines.stats.length ? String(p.lines.stats[0]) : '' };
}
function switchCharacter(why) {
  const next = resolveChar();
  if (next === activeChar) { saveCfg(); pushMenuState(); pushCenterCfg(); return; }
  syncLive();
  const prev = activeChar;
  activeChar = next;
  loadLive(next);
  saveCfg();
  plog('character ' + prev + ' -> ' + next + ' (' + why + ')');
  fitSoon('character');   // 新角色的轮廓宽窄不一样：贴在屏幕边上时可能露出去一截
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:character', characterInfo());
    win.webContents.send('pet:theme', cfg.theme);
    win.webContents.send('pet:tune', cfg.tune);
    win.webContents.send('pet:bubble-cfg', cfg.bubble);
  }
  try { if (tray) tray.setToolTip(prof().name + (minimizedToTray ? ' · 已最小化，点击恢复' : ' · 桌宠')); } catch (e) { /* ignore */ }
  pushCenterCfg();
  pushMenuState();
}
function setCharacterMode(mode) {
  if (mode && !CHARS[mode]) return;
  cfg.character = mode || '';
  switchCharacter('pick ' + (mode || 'first'));
}

// ---- ★ 模型实时生成：档案写了 psd 的角色，控制中心「系统」页能打开它；PSD 一保存就重新生成模型、原地换上 ----
//   tools/model_build/psd_prepare.py 把手改的 PSD 理顺（全部可见、蒙版 / 剪贴图层合进像素、单层闭眼拆左右、# 开头的跳过）
//   → PSD2Live（约 3～7 秒）→ 产物检查过再换进模型目录（旧的留在 <模型目录>/.prev）→ 通知渲染端重载。
//   生成失败：桌宠保持上一版，控制中心显示原因。
//   PSD2Live 两种都行：官方免安装包解压到 tools/psd2live/（PSD2Live.exe，自带 Java），或者自己编的 PSD2Live.jar（要 Java 21）。
//   工具路径在设置文件 config.json 的 modelBuild {python, java, jar} 里改（jar 也可以写 PSD2Live.exe 的路径）；
//   不写 = PATH 里的 python / tools/psd2live/PSD2Live.exe，没有就 tools/psd2live/PSD2Live.jar + JAVA_HOME 或 PATH 里的 java。
const MB = { st: {}, sig: {}, seen: {}, buildSig: {}, rev: {}, busy: null, again: {}, queue: [], timers: {}, watchers: {} };
function mbTools() {
  const o = cfg.modelBuild || {};
  const javaHome = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : '';
  const dir = path.join(__dirname, 'tools', 'psd2live');
  const exe = path.join(dir, process.platform === 'win32' ? 'PSD2Live.exe' : 'PSD2Live');
  const jar = o.jar || (fs.existsSync(exe) ? exe : path.join(dir, 'PSD2Live.jar'));
  return {
    python: o.python || 'python',
    java: o.java || (javaHome && fs.existsSync(javaHome) ? javaHome : 'java'),
    jar,
    native: !/\.jar$/i.test(jar),   // 官方安装包里的 PSD2Live.exe：直接运行，不用 java
    prepare: path.join(__dirname, 'tools', 'model_build', 'psd_prepare.py'),
  };
}
function psdPath(id) {
  const p = prof(id).psd;
  if (typeof p !== 'string' || !p) return null;
  return charPath(prof(id), p);
}
function modelFile(id) { return charPath(prof(id), String(prof(id).model)); }
function fileSig(p) { try { const s = fs.statSync(p); return s.size + ':' + Math.round(s.mtimeMs); } catch (e) { return null; } }
// 除了 PSD 本身，档案里会改变生成结果的设置：psdSkipLayers（这些图层不进模型）。
//   生成时连同 PSD 的内容指纹记进模型旁边的 <名字>.build.json（src/model-stamp.js）；设置改了而 PSD 没动 ⇒ 启动时也重新生成一次
function mbOpts(id) {
  const s = prof(id).psdSkipLayers;
  return { skip: Array.isArray(s) ? s.map(String).filter((x) => x.trim()) : [] };
}
function mbStampFile(id) { return modelFile(id).replace(/\.model3\.json$/i, '.build.json'); }
// 命令在不在：写了路径就看文件；只写了名字（python / java）就到 PATH 里找
function cmdExists(cmd) {
  if (path.isAbsolute(cmd) || /[\\/]/.test(cmd)) return fs.existsSync(cmd);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').concat(['']) : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) { if (fs.existsSync(path.join(dir, cmd + ext.toLowerCase())) || fs.existsSync(path.join(dir, cmd + ext))) return true; }
  }
  return false;
}
function mbMissing() {
  const t = mbTools();
  return (t.native ? ['python', 'jar', 'prepare'] : ['python', 'java', 'jar', 'prepare']).filter((k) => !cmdExists(t[k])).map((k) => t[k]);
}
// 控制中心要的：当前角色的 PSD 在哪、生成到哪一步了
function mbSnapshot(id) {
  id = id || activeChar;
  const psd = psdPath(id);
  return Object.assign({ id, name: prof(id).name, psd, exists: !!(psd && fs.existsSync(psd)), missing: psd ? mbMissing() : [], state: 'idle' }, MB.st[id] || {});
}
function mbSet(id, patch) {
  MB.st[id] = Object.assign({}, MB.st[id] || {}, patch);
  if (id === activeChar && centerWin && !centerWin.isDestroyed()) {
    try { centerWin.webContents.send('center:model', mbSnapshot(id)); } catch (e) { /* ignore */ }
  }
}
// 跑一个子进程（不弹窗），stdout 按行回调（PSD2Live 的进度行）；超时就停掉它
function mbRun(cmd, args, timeoutMs, onLine, extraEnv) {
  return new Promise((resolve) => {
    let out = '', err = '', buf = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd: __dirname, windowsHide: true, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }, extraEnv || {}) });
    } catch (e) { resolve({ code: -1, out, err: e.message }); return; }
    const timer = setTimeout(() => {
      err += '\n超过 ' + Math.round(timeoutMs / 1000) + ' 秒没做完，已停下';
      try { child.kill(); } catch (e) { /* ignore */ }
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      out += s; buf += s;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (ln && onLine) onLine(ln); }
    });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { err += '\n' + e.message; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
function tailText(s, n) {
  return String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(-(n || 3)).join(' / ').slice(0, 400);
}
// 旧模型（<base>.*）挪进 .prev，新产物放进模型目录；中途出错就挪回去
// 挪文件 / 目录：同一个盘直接改名；跨盘（生成目录在用户数据目录、模型在程序目录，常常不在一个盘）就复制再删
function moveSync(from, to) {
  try { fs.renameSync(from, to); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    try { fs.cpSync(from, to, { recursive: true }); } catch (e2) {
      try { fs.rmSync(to, { recursive: true, force: true }); } catch (e3) { /* ignore */ }   // 别留半份
      throw e2;
    }
    fs.rmSync(from, { recursive: true, force: true });
  }
}
function mbSwap(outDir, dir, base) {
  const prev = path.join(dir, '.prev');
  fs.rmSync(prev, { recursive: true, force: true });
  fs.mkdirSync(prev, { recursive: true });
  const moved = [], placed = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(base + '.')) { fs.renameSync(path.join(dir, f), path.join(prev, f)); moved.push(f); }
    }
    for (const f of fs.readdirSync(outDir)) { moveSync(path.join(outDir, f), path.join(dir, f)); placed.push(f); }
  } catch (e) {
    for (const f of placed) { try { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); } catch (e2) { /* ignore */ } }
    for (const f of moved) { try { fs.renameSync(path.join(prev, f), path.join(dir, f)); } catch (e2) { /* ignore */ } }
    throw e;
  }
}
async function mbBuild(id, why) {
  const psd = psdPath(id);
  const model = modelFile(id);
  const dir = path.dirname(model);
  const base = path.basename(model).replace(/\.model3\.json$/i, '');
  const stage = path.join(DATA_DIR, 'model_build', id);
  const outDir = path.join(stage, 'out');
  const tools = mbTools();
  const sig = fileSig(psd);
  const psdSha1 = fileSha1(psd);
  const t0 = Date.now();
  MB.buildSig[id] = sig;
  mbSet(id, { state: 'build', stage: '整理 PSD', startedAt: t0, why, message: '', warnings: [], notes: [], unknown: [] });
  plog('model build ' + id + ' start (' + why + ')');
  try {
    if (!sig) throw new Error('找不到 PSD：' + psd);
    const missing = mbMissing();
    if (missing.length) throw new Error('缺生成工具：' + missing.join('、'));
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const staged = path.join(stage, base + '.psd');
    const opts = mbOpts(id);
    const r1 = await mbRun(tools.python, ['-I', '-X', 'utf8', tools.prepare, psd, staged]
      .concat(opts.skip.length ? ['--skip', JSON.stringify(opts.skip)] : []), 120000);
    // 退出码 2 = 脚本自己写好的一句话原因；别的退出码是意外，带上最后几行输出
    if (r1.code === 2) throw new Error(tailText(r1.err, 1) || '整理 PSD 失败');
    if (r1.code !== 0) throw new Error('整理 PSD 失败：' + tailText(r1.err || r1.out));
    let prep = {};
    try { prep = JSON.parse(String(r1.out).trim().split(/\r?\n/).pop()); } catch (e) { /* 没有摘要也照样生成 */ }
    mbSet(id, { stage: '生成模型', notes: Array.isArray(prep.notes) ? prep.notes.slice(0, 20) : [], layers: Array.isArray(prep.layers) ? prep.layers.length : 0 });
    const p2lArgs = ['--input', staged, '--output', outDir, '--lang', 'zh'];
    const onP2lLine = (ln) => {
      const m = /^(\d+)%\s+(.+)$/.exec(ln);
      if (m) mbSet(id, { stage: m[2] + '（' + m[1] + '%）' });
    };
    // 官方安装包的 PSD2Live.exe 自带 Java：编码参数经 JAVA_TOOL_OPTIONS 给（它会在 stderr 多打一行 Picked up…，下面滤掉）
    const r2 = tools.native
      ? await mbRun(tools.jar, p2lArgs, 180000, onP2lLine, { JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8' })
      : await mbRun(tools.java, ['-Xmx4g', '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-jar', tools.jar].concat(p2lArgs), 180000, onP2lLine);
    if (r2.code !== 0) throw new Error('PSD2Live 失败：' + tailText(r2.err || r2.out));
    const warnings = String(r2.err || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^Picked up JAVA_TOOL_OPTIONS/.test(s)).slice(0, 40);
    // 生成工具不认识的图层名（照样显示，但不会被当成嘴 / 眼睛这些部件）：档案 psdExtraLayers 里写了的是本来就这样的，不提示
    const unknownLine = warnings.find((w) => /未知图层/.test(w));
    const extra = Array.isArray(prof(id).psdExtraLayers) ? prof(id).psdExtraLayers : [];
    const unknown = unknownLine ? unknownLine.slice(unknownLine.lastIndexOf('：') + 1).split(/[,，]\s*/).map((s) => s.trim())
      .filter((s) => s && extra.indexOf(s) < 0) : [];
    // 产物检查：model3.json 读得出来、里面引用的 moc3 / 贴图 / 物理都在
    const mj = JSON.parse(fs.readFileSync(path.join(outDir, base + '.model3.json'), 'utf8'));
    const refs = mj.FileReferences || {};
    if (!refs.Moc || !Array.isArray(refs.Textures) || !refs.Textures.length) throw new Error('产物不完整（没有 moc3 或贴图）');
    for (const f of [refs.Moc].concat(refs.Textures, refs.Physics ? [refs.Physics] : [])) {
      if (!fs.existsSync(path.join(outDir, f))) throw new Error('产物缺文件：' + f);
    }
    fs.writeFileSync(path.join(outDir, base + '.build.json'), JSON.stringify({ psd: sig, sha1: psdSha1, opts, at: new Date().toISOString() }) + '\n');
    mbSet(id, { stage: '换上新模型' });
    mbSwap(outDir, dir, base);
    MB.rev[id] = Date.now();
    MB.sig[id] = sig;
    const ms = Date.now() - t0;
    mbSet(id, { state: 'ok', stage: '', endedAt: Date.now(), ms, warnings, unknown, message: '' });
    plog('model build ' + id + ' ok ' + ms + 'ms warnings=' + warnings.length);
    if (id === activeChar) { if (win && !win.isDestroyed()) { win.webContents.send('pet:model-reload', characterInfo()); fitSoon('model'); } }
    else if (resolveChar() === id) switchCharacter('model built');   // 之前因为没有模型先显示了默认角色
  } catch (e) {
    MB.sig[id] = sig;   // 这一版生成不了：等下一次保存，不反复重试
    mbSet(id, { state: 'error', stage: '', endedAt: Date.now(), ms: Date.now() - t0, message: e.message });
    plog('model build ' + id + ' failed: ' + e.message);
    // 还一版模型都没有：气泡里那句「正在生成」换成失败原因
    if (id === activeChar && !fs.existsSync(model) && win && !win.isDestroyed()) win.webContents.send('pet:model-reload', characterInfo());
  }
}
// 同一时间只生成一个；生成中又存了一次 ⇒ 做完再来一遍
function mbQueue(id, why) {
  if (MB.busy) {
    if (MB.busy === id) MB.again[id] = why;
    else if (MB.queue.indexOf(id) < 0) MB.queue.push(id);
    return;
  }
  MB.busy = id;
  mbBuild(id, why).finally(() => {
    MB.busy = null;
    const again = MB.again[id];
    delete MB.again[id];
    if (again) mbQueue(id, again);
    else if (MB.queue.length) mbQueue(MB.queue.shift(), 'queued');
  });
}
// PSD 变了：等它写完（大小和修改时间 1.2 秒不再变）再生成
function mbCheck(id) {
  const psd = psdPath(id);
  if (!psd) return;
  const sig = fileSig(psd);
  if (!sig || sig === MB.sig[id] || (MB.busy === id && sig === MB.buildSig[id])) return;
  if (MB.seen[id] !== sig) {
    MB.seen[id] = sig;
    if (MB.busy !== id) mbSet(id, { state: 'wait', stage: '等 PSD 存完' });
    clearTimeout(MB.timers[id]);
    MB.timers[id] = setTimeout(() => mbCheck(id), 1200);
    return;
  }
  mbQueue(id, 'saved');
}
function mbWatch() {
  const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; } };
  for (const id in CHARS) {
    const psd = psdPath(id);
    if (!psd) continue;
    // 模型就是这份 PSD、按现在的档案设置生成的 = 已经是这一版；否则（桌宠没开时改过 PSD / 改了 psdSkipLayers）下面第一次检查就生成
    const stamp = readStamp(mbStampFile(id));
    const current = fs.existsSync(modelFile(id)) && stampCurrent({ stamp, opts: mbOpts(id),
      psdSha1: stamp && stamp.sha1 ? fileSha1(psd) : null, modelMtime: mtime(modelFile(id)), psdMtime: mtime(psd) });
    if (current) MB.sig[id] = fileSig(psd);
    else if (!sameOpts(stamp, mbOpts(id))) plog('model watch ' + id + ': build options changed ' + JSON.stringify(mbOpts(id)));
    // 生成工具没装（刚下载、只想用自带模型）：启动时不去生成，直接用现成的模型；真改了 PSD 再报缺什么
    if (!MB.sig[id] && fs.existsSync(modelFile(id)) && mbMissing().length) {
      MB.sig[id] = fileSig(psd);
      plog('model watch ' + id + ': tools missing, using the existing model');
    }
    try {
      MB.watchers[id] = fs.watch(path.dirname(psd), { persistent: false }, () => {
        clearTimeout(MB.timers[id]);
        MB.timers[id] = setTimeout(() => mbCheck(id), 400);
      });
    } catch (e) { plog('model watch ' + id + ' failed: ' + e.message); }
    plog('model watch ' + id + ' -> ' + psd + (MB.sig[id] ? '' : ' (PSD newer than model)'));
  }
  // fs.watch 偶尔漏事件（某些保存方式）：每 3 秒再看一眼
  setInterval(() => { for (const id in CHARS) if (psdPath(id)) mbCheck(id); }, 3000);
  for (const id in CHARS) if (psdPath(id)) mbCheck(id);
}

function loadCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    if (typeof j.size === 'number') cfg.size = Math.round(Math.max(SIZE_MIN, Math.min(SIZE_MAX, j.size)));
    // ★ 多角色：每个角色一份
    if (j.chars && typeof j.chars === 'object') {
      for (const id in j.chars) if (CHARS[id]) cfg.chars[id] = cleanCharState(id, j.chars[id]);
    }
    if (typeof j.character === 'string' && (j.character === '' || CHARS[j.character])) cfg.character = j.character;
    if (j.bubble && typeof j.bubble.on === 'boolean') cfg.bubble.on = j.bubble.on;
    if (j.bubble && typeof j.bubble.say === 'boolean') cfg.bubble.say = j.bubble.say;
    // ★ 气泡内容编排 —— 白名单式载入：不补这几行 ⇒ config.json 里写了也读不回来
    if (j.bubble && Array.isArray(j.bubble.items)) {
      cfg.bubble.items = j.bubble.items.filter(function (k) { return BUBBLE_ITEM_KEYS.indexOf(k) >= 0; });
    }
    if (j.bubble && Array.isArray(j.bubble.order)) {
      const seen = j.bubble.order.filter(function (k) { return BUBBLE_ITEM_KEYS.indexOf(k) >= 0; });
      for (const k of BUBBLE_ITEM_KEYS) if (seen.indexOf(k) < 0) seen.push(k);   // 缺项补齐，保证每项都在
      cfg.bubble.order = seen;
    }
    if (j.bubble && j.bubble.levels && typeof j.bubble.levels === 'object') {
      for (const k of BUBBLE_ITEM_KEYS) {
        if (j.bubble.levels[k] === 'big' || j.bubble.levels[k] === 'small') cfg.bubble.levels[k] = j.bubble.levels[k];
      }
    }
    // bubble.custom（自定义文本）跟角色走：在 cfg.chars[id].custom 里
    // ★ 气泡长宽：白名单成对维护，缺行则 config.json 写了也读不回来
    if (j.bubble && typeof j.bubble.wPct === 'number' && isFinite(j.bubble.wPct)) {
      cfg.bubble.wPct = Math.round(Math.max(60, Math.min(100, j.bubble.wPct)));
    }
    if (j.bubble && typeof j.bubble.hPx === 'number' && isFinite(j.bubble.hPx)) {
      cfg.bubble.hPx = Math.round(Math.max(40, Math.min(200, j.bubble.hPx)));
    }
    // 主题（3 质感 × 5 颜色）跟角色走：在 cfg.chars[id].theme 里
    if (typeof j.autostart === 'boolean') cfg.autostart = j.autostart;
    if (j.pos && Number.isFinite(j.pos.x) && Number.isFinite(j.pos.y)) cfg.pos = { x: Math.round(j.pos.x), y: Math.round(j.pos.y) };
    if (typeof j.mouseThrough === 'boolean') cfg.mouseThrough = j.mouseThrough;   // ★ 不影响鼠标（缺这行 ⇒ config.json 里的开关永远读不进来）
    // ★ 模型实时生成的工具路径（不写 = PATH 里的 python / java、tools/psd2live/PSD2Live.jar）
    if (j.modelBuild && typeof j.modelBuild === 'object') {
      cfg.modelBuild = {};
      for (const k of ['python', 'java', 'jar']) if (typeof j.modelBuild[k] === 'string' && j.modelBuild[k]) cfg.modelBuild[k] = j.modelBuild[k];
    }
    cfg.voice = voice.cleanConfig(j.voice);
    if (j.api && typeof j.api === 'object') {
      if (typeof j.api.enabled === 'boolean') cfg.api.enabled = j.api.enabled;
      const port = Number(j.api.port);
      if (Number.isInteger(port) && port >= 1024 && port <= 65535) cfg.api.port = port;
    }
  } catch (e) { plog('cfg none (first run)'); }
  if (DEFAULT_CHAR && !cfg.chars[DEFAULT_CHAR]) cfg.chars[DEFAULT_CHAR] = cleanCharState(DEFAULT_CHAR, null);
  activeChar = resolveChar();
  if (activeChar) loadLive(activeChar);
  plog('cfg loaded size=' + cfg.size + ' character=' + (cfg.character || '(first)') + ' active=' + (activeChar || '(none)') + ' cloth=' + JSON.stringify(cfg.cloth) + ' theme=' + cfg.theme.style + '/' + cfg.theme.color + ' bubbleOn=' + cfg.bubble.on + ' bubbleSay=' + cfg.bubble.say + ' mouseThrough=' + cfg.mouseThrough + ' voice=' + voice.describe(cfg.voice));
}
function saveCfg() {
  if (activeChar) syncLive();   // 当前角色的衣服 / 摆动 / 主题 / 自定义文本存回它自己那份
  try { fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2)); } catch (e) { /* ignore */ }
}
// ---- ★ 陪伴统计（stats.json）：累计陪伴时长 + 被摸次数（休眠 / 息屏不计时、只记左键摸）----
const STATS_PATH = path.join(DATA_DIR, 'stats.json');
const STATS_IDLE_LIMIT = 300;   // 秒：系统空闲超过这个值（含息屏/挂机）就不算陪伴
const stats = { firstSeen: '', lastSeen: '', totalMs: 0, clicks: 0, sessions: 0 };
let statsTickAt = Date.now();
let statsSuspended = false;     // 系统休眠中（powerMonitor.suspend → resume）

function loadStats() {
  try {
    const j = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
    if (j) {
      if (typeof j.totalMs === 'number' && isFinite(j.totalMs)) stats.totalMs = Math.max(0, j.totalMs);
      if (typeof j.clicks === 'number' && isFinite(j.clicks)) stats.clicks = Math.max(0, Math.floor(j.clicks));
      if (typeof j.sessions === 'number' && isFinite(j.sessions)) stats.sessions = Math.max(0, Math.floor(j.sessions));
      if (typeof j.firstSeen === 'string') stats.firstSeen = j.firstSeen;
    }
    plog('stats loaded totalMs=' + stats.totalMs + ' clicks=' + stats.clicks + ' sessions=' + stats.sessions);
  } catch (e) { plog('stats none (first run)'); }
}
function saveStats() {
  try {
    stats.lastSeen = new Date().toISOString();
    // writeFileSync 默认 utf8 无 BOM（勿改用 Set-Content/带 BOM 的写法）
    fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
  } catch (e) { plog('stats save failed: ' + (e && e.message)); }
}
// 陪伴计时：每 30 秒结算一次；空闲（>5 分钟无输入＝挂机/息屏）与休眠期间都不计
function statsTick() {
  const now = Date.now();
  const dt = now - statsTickAt;
  statsTickAt = now;
  if (dt <= 0) return;
  if (dt > 5 * 60 * 1000) return;              // 跨度过大（休眠/长挂机）⇒ 这一段整体丢弃
  if (statsSuspended) return;
  let idle = 0;
  try { idle = powerMonitor.getSystemIdleTime(); } catch (e) { idle = 0; }
  if (idle >= STATS_IDLE_LIMIT) return;        // 人不在（含息屏）⇒ 不计
  stats.totalMs += dt;
  saveStats();
}
function statsSummary() {
  return { ms: stats.totalMs, clicks: stats.clicks, sessions: stats.sessions, firstSeen: stats.firstSeen };
}

// ---- ★ 说话：一句话交给 src/voice 合成（用哪个服务、先后顺序、音色都在设置里），
//   PCM 片段推给渲染端边收边播、按音量对口型；文字同时出在气泡里（「说话只留台词」开着时）。
//   谁来要：右键菜单「说一句」、点角色（设置里开了才念）、空闲时偶尔说一句（开了才说）、本机接口 POST /say（插件用）。
//   正在说的时候又来一句：排队，最多排 3 句；「停下」（Ctrl+Alt+U 或菜单）清空队列并掐掉正在念的。
const SAY = { busy: false, queue: [], abort: null, lastError: '', lastText: '', lastAt: 0 };
// 密钥（云端合成的 API Key）落盘前用系统的加密存储（Windows 上是 DPAPI）封一下，界面里只显示「已填」
const voiceSecret = {
  seal(plain) {
    try { if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(String(plain)).toString('base64'); } catch (e) { /* 退回明文存 */ }
    return 'raw:' + Buffer.from(String(plain), 'utf8').toString('base64');
  },
  open(sealed) {
    const s = String(sealed || '');
    try {
      if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
      if (s.startsWith('raw:')) return Buffer.from(s.slice(4), 'base64').toString('utf8');
    } catch (e) { plog('voice key unreadable: ' + e.message); }
    return '';
  },
};
function sendPet(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
// 这个角色能念的台词：档案 lines.say，没有就用 lines.stats（点角色时气泡里那些）
function sayLines() {
  const l = prof().lines;
  if (l && Array.isArray(l.say) && l.say.length) return l.say;
  if (l && Array.isArray(l.stats) && l.stats.length) return l.stats;
  return [];
}
function pickLine() {
  const lines = sayLines();
  return lines.length ? String(lines[Math.floor(Math.random() * lines.length)]) : '';
}
function sayOnce() {
  const line = pickLine();
  if (!line) { plog('say: 当前角色没有台词'); return Promise.resolve(false); }
  return sayText(line);
}
// show = 气泡里显示的原文；念的是清理过的（去掉网址、代码、括号里的动作描写等）
//   opts.bubble === false：不另弹文字气泡（点角色时台词已经在数据气泡里了）
function sayText(text, opts) {
  const show = String(text == null ? '' : text).trim().slice(0, 400);
  if (!show) return Promise.resolve(false);
  return new Promise((resolve) => {
    const job = { show, speak: voice.speechText(show), bubble: !(opts && opts.bubble === false), resolve };
    if (SAY.busy) {
      if (SAY.queue.length >= 3) { plog('say: queue full, dropped'); resolve(false); return; }
      SAY.queue.push(job);
      return;
    }
    void sayRun(job);
  });
}
async function sayRun(job) {
  SAY.busy = true;
  pushMenuState();
  SAY.lastText = job.show;
  SAY.lastAt = Date.now();
  sendPet('pet:say-pending', { text: job.show });
  if (job.bubble) sendPet('pet:say-text', { text: job.show });
  let ok = false;
  if (cfg.voice.enabled && job.speak) {
    const ac = new AbortController();
    SAY.abort = ac;
    try {
      const r = await voice.speak(cfg.voice, job.speak, {
        signal: ac.signal, log: plog, secret: voiceSecret,
        onChunk: (sampleRate, pcm, seq) => sendPet('pet:say-chunk', { seq, sampleRate, b64: pcm.toString('base64') }),
      });
      ok = r.ok;
      SAY.lastError = r.ok ? '' : r.error;
      plog(r.ok ? 'say ok via ' + r.engine + ' chunks=' + r.chunks + ' ' + r.ms + 'ms' : 'say failed: ' + r.error);
      if (r.ok) sendPet('pet:say-end', { segments: r.chunks });
      else if (!ac.signal.aborted) sendPet('pet:say-fail', { text: job.show, error: r.error });
    } catch (e) { SAY.lastError = e.message; plog('say error ' + e.message); }
    SAY.abort = null;
  }
  SAY.busy = false;
  pushCenterVoice();
  pushMenuState();
  job.resolve(ok);
  const next = SAY.queue.shift();
  if (next) void sayRun(next);
}
function sayStop(why) {
  for (const j of SAY.queue.splice(0)) j.resolve(false);
  if (SAY.abort) { try { SAY.abort.abort(); } catch (e) { /* ignore */ } }
  sendPet('pet:say-stop', {});
  plog('say stop (' + (why || '-') + ')');
}
function voiceStateText() {
  if (!cfg.voice.enabled) return '关';
  if (SAY.busy) return '在说话';
  return SAY.lastError ? '没念出来' : '待机';
}
// 空闲时偶尔说一句：voice.idleMinutes 分钟没人碰它就念一句台词（0 = 不说）；电脑没人用（空闲超过 5 分钟）时不说
let lastTouchAt = Date.now();
function idleTalkTick() {
  const m = Number(cfg.voice.idleMinutes) || 0;
  if (!(m > 0) || SAY.busy || cfg.mouseThrough || minimizedToTray) return;
  if (Date.now() - Math.max(lastTouchAt, SAY.lastAt) < m * 60000) return;
  let idle = 0;
  try { idle = powerMonitor.getSystemIdleTime(); } catch (e) { idle = 0; }
  if (idle >= 300) return;
  lastTouchAt = Date.now();
  void sayOnce();
}
function pushCenterVoice() {
  if (centerWin && !centerWin.isDestroyed()) {
    try { centerWin.webContents.send('center:voice', voiceSnapshot()); } catch (e) { /* ignore */ }
  }
}
function voiceSnapshot() {
  return { config: voice.publicConfig(cfg.voice), state: voiceStateText(), lastError: SAY.lastError, engines: voice.ENGINES, qwenVoices: voice.QWEN_VOICES };
}


// 气泡数据的唯一出处：点击（pet:click）、右键菜单都从这里取
//   —— 少一处字段就是 NaN/undefined
function bubblePayload() {
  const s = statsSummary();
  // 数据行按 config.bubble 的编排生成 → { data:[{key,label,value,level}] }
  const dayMs = 24 * 3600 * 1000;
  const firstAt = Date.parse(stats.firstSeen || '');
  const days = isFinite(firstAt) ? Math.max(1, Math.floor((Date.now() - firstAt) / dayMs) + 1) : 1;
  const values = {
    days: String(days),
    touches: String(stats.clicks || 0),
    voice: voiceStateText(),
    custom: cfg.bubble.custom || '',
  };
  const order = (cfg.bubble.order && cfg.bubble.order.length) ? cfg.bubble.order : BUBBLE_ITEM_KEYS;
  const picked = order.filter(function (k) { return (cfg.bubble.items || []).indexOf(k) >= 0; });
  s.wPct = cfg.bubble.wPct;   // ★ 气泡长宽跟着 payload 一起下发（宿主侧按它设 CSS 变量）
  s.hPx = cfg.bubble.hPx;
  s.data = picked.map(function (k) {
    return {
      key: k,
      label: BUBBLE_ITEM_LABEL[k] || k,
      short: BUBBLE_ITEM_SHORT[k] || BUBBLE_ITEM_LABEL[k] || k,   // ★ 窄窗用的短标签
      value: values[k],
      level: (cfg.bubble.levels && cfg.bubble.levels[k]) === 'small' ? 'small' : 'big',
    };
  });
  return s;
}
function refreshTrayMenu() {
  // 托盘不挂系统菜单 —— 点托盘图标弹的是「同一个独立菜单窗」
  try { if (tray) tray.setContextMenu(null); } catch (e) { /* ignore */ }
}

// 爱心眼（常驻开关）：菜单勾选后瞳孔上的粉色爱心一直跳动；PET_HEART=1 可让启动时默认开着（自检用）
let heartEye = process.env.PET_HEART === '1';
let curBand = BUBBLE_BAND;   // 当前窗口高度里含的气泡带宽（改带宽走相对增减，避开 DIP 舍入漂移）
let win = null;
let tray = null;
let minimizedToTray = false;
let lastMoveAt = 0;

function minimizeToTray() {
  // 没有恢复入口时不隐藏，避免托盘创建失败后找不回桌宠。
  if (!tray || tray.isDestroyed() || !win || win.isDestroyed()) return;
  minimizedToTray = true;
  closeMenuWin();
  if (dragging) nativeDragEnd();
  helperCmd('AUTO 0', true);
  lastHelperHitbox = ''; lastHelperMask = ''; lastInside = null;
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.send('pet:inside', false);
  win.webContents.send('pet:minimized', true);
  sayStop('minimize');
  if (centerWin && !centerWin.isDestroyed()) centerWin.hide();
  win.hide();
  tray.setToolTip(prof().name + ' · 已最小化，点击恢复');
  pushMenuState();
  plog('minimized to tray');
}

function restoreFromTray() {
  if (!win || win.isDestroyed()) return;
  minimizedToTray = false;
  win.showInactive();
  win.webContents.send('pet:minimized', false);
  win.setIgnoreMouseEvents(true, { forward: true });
  lastInside = null; lastHelperHitbox = ''; lastHelperMask = '';
  armAutoFallback();
  if (tray && !tray.isDestroyed()) tray.setToolTip(prof().name + ' · 桌宠');
  pushMenuState();
  plog('restored from tray');
}

// 日志：用户数据目录下的 main.log / renderer.log；启动时超过 5 MB 就换成 *.old.log 重新记
const LOG_MAX = 5 * 1024 * 1024;
function logFile(name) {
  const p = path.join(DATA_DIR, name);
  try { if (fs.statSync(p).size > LOG_MAX) fs.renameSync(p, p.replace(/\.log$/, '.old.log')); } catch (e) { /* 还没有 */ }
  return p;
}
const MAIN_LOG = logFile('main.log');
const RENDERER_LOG = logFile('renderer.log');
// 主进程侧日志（启动时 stdout 看不到，统一落盘便于取证）
function plog(msg) {
  try { fs.appendFileSync(MAIN_LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch (e) { /* ignore */ }
}


// 测试用：PET_POS=x,y 把桌宠窗口放在这里（隔离实例放到屏幕外截图，不打扰桌面），
//   控制中心 / 右键菜单也跟着贴在它旁边、不往屏幕里夹
const TEST_POS = (() => {
  const p = String(process.env.PET_POS || '').split(',').map((v) => Math.round(Number(v)));
  return p.length === 2 && p.every((v) => isFinite(v)) ? p : null;
})();

let posTimer = null;
function rememberPos() {
  if (TEST_POS) return;
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    if (cfg.pos && cfg.pos.x === x && cfg.pos.y === y) return;
    cfg.pos = { x, y };
    saveCfg();
  }, 1000);
}
function createWindow() {
  // screen API 和 BrowserWindow 的坐标都是 DIP；上次的位置还在屏幕上就放回去，否则放主屏右下角
  const d = screen.getPrimaryDisplay();
  const s = cfg.size;
  const h = s + bandPx();      // ★ 顶部多留一条气泡带（气泡关掉＝0 ⇒ 正方形；关台词＝56）
  const pos = TEST_POS ? { x: TEST_POS[0], y: TEST_POS[1] }
    : startPos(cfg.pos, s, h, screen.getAllDisplays().map((x) => x.workArea), d.workArea);
  plog('display bounds=' + JSON.stringify(d.bounds) + ' work=' + JSON.stringify(d.workArea) + ' sf=' + d.scaleFactor + ' start=' + pos.x + ',' + pos.y);
  win = new BrowserWindow({
    width: s,
    height: h,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,   // 关键：桌宠常年不聚焦，禁用后台节流才能保住 rAF 帧率（眨眼/发丝物理才准）
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  curBand = bandPx();   // 记录本次窗口高度里含的带宽（后续改带宽按相对量增减）
  // 窗口位置变化只记时间戳（移动完全交给 helper 的原生跟随循环），停下 1 秒后记住位置（下次启动放回这里）
  win.on('move', () => { lastMoveAt = Date.now(); rememberPos(); });
  win.setVisibleOnAllWorkspaces(true);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!minimizedToTray) win.showInactive(); });
  // 默认整窗穿透（鼠标事件 forward 给渲染进程做命中测试）
  win.setIgnoreMouseEvents(true, { forward: true });
  win.on('closed', () => { win = null; closePanel(); });
  // 渲染进程的日志落盘（排查问题用）；这一次运行最多记 20 MB
  let rendererLogBytes = 0;
  win.webContents.on('console-message', (e) => {
    if (rendererLogBytes > 20 * 1024 * 1024) return;
    const line = `[${new Date().toISOString()}] ${e.level} ${e.message}\n`;
    rendererLogBytes += line.length;
    try { fs.appendFileSync(RENDERER_LOG, line); } catch (e) { /* ignore */ }
  });
  // ★ 说话自检：PET_SAY=1 → 启动 3.5 秒后说一句
  if (process.env.PET_SAY === '1') setTimeout(() => { void sayOnce(); }, 3500);
}

function trayIcon() {
  const p = path.join(__dirname, 'assets', 'icon-32.png');
  if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  return nativeImage.createEmpty();
}


function sendAction(id) {
  if (win) win.webContents.send('pet:action', id);
}

function sendHeart() {
  if (win) win.webContents.send('pet:heart', heartEye);
  plog('heart ' + heartEye);
}


function applySize(px) {
  const s = Math.round(Math.max(SIZE_MIN, Math.min(SIZE_MAX, px || cfg.size)));
  cfg.size = s;
  saveCfg();
  if (win) {
    // 右下角锚定：改尺寸时「脚」的位置不动，看起来是贴着屏幕右下角长大/缩小
    const [x, y] = win.getPosition();
    const [w0, h0] = win.getSize();
    const hNew = s + bandPx();      // ★ 高度 = 宽度 + 气泡带（气泡关掉时带宽 0）
    win.setBounds({ x: Math.round(x + (w0 - s)), y: Math.round(y + (h0 - hNew)), width: s, height: hNew });
    fitSoon('size');
  }
  // 面板不跟随（跟随会让拖滑条时面板乱跑、滑块瞬移）——只在打开时定位一次
}

// ★ 气泡带高度应用：带宽随「总开关 / 台词开关」变 ⇒ 窗口高度跟着改，脚不动。
//   用相对量（新带宽 − 旧带宽），不用 w0 + band：窗口宽度带 DIP 舍入，绝对值算会越改越漂。
function applyBand() {
  if (!win || win.isDestroyed()) return;
  const nb = bandPx();
  const [x, y] = win.getPosition();
  const [w0, h0] = win.getSize();
  const hNew = h0 - curBand + nb;
  if (hNew !== h0) win.setBounds({ x, y: Math.round(y + (h0 - hNew)), width: w0, height: hNew });
  curBand = nb;
}
// ★ 气泡总开关：关掉＝渲染端不弹气泡，同时把窗口顶部那条气泡带收掉（脚不动）
function setBubbleOn(on) {
  cfg.bubble.on = !!on;
  saveCfg();
  applyBand();
  if (win && !win.isDestroyed()) win.webContents.send('pet:bubble', cfg.bubble.on);   // 渲染端据此决定弹不弹
  refreshTrayMenu();   // 菜单勾选态同步
  plog('bubble on=' + cfg.bubble.on + ' band=' + bandPx());
}
// ★「台词」开关：关掉＝气泡只留大字数据，带高 74 → 56
function setBubbleSay(on) {
  cfg.bubble.say = !!on;
  saveCfg();
  applyBand();
  if (win && !win.isDestroyed()) win.webContents.send('pet:bubble-say', cfg.bubble.say);
  refreshTrayMenu();
  plog('bubble say=' + cfg.bubble.say + ' band=' + bandPx());
}

// ★ 不影响鼠标（点击穿透，2026-09-24 定）：true ＝ 整窗永不接管鼠标。
//   为什么不能只写一句 setIgnoreMouseEvents：挡鼠标的有两条路，必须一起关 ——
//   ① 主进程 cursorTick 每 30ms 自判命中，会把穿透态切回接管态；
//   ② 输入兜底 helper（AUTO）自己轮询按键、自己判命中、自己发起拖动。
function setMouseThrough(on) {
  cfg.mouseThrough = !!on;
  saveCfg();
  if (cfg.mouseThrough) {
    if (dragging) nativeDragEnd();          // 正拖着就当场松手
    helperCmd('AUTO 0', true);              // 关掉 helper 的 AUTO 兜底（第二条抢鼠标的路）
    lastHelperHitbox = ''; lastHelperMask = '';   // 让恢复时能把命中框 / 轮廓重推一次
    lastInside = null;                      // 强制下一拍重判（开着时判出来恒为 false）
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(true, { forward: true });
      win.webContents.send('pet:inside', false);
    }
  } else {
    armAutoFallback();                      // 恢复兜底：TARGET + AUTO 1
    lastInside = null;                      // 下一拍按命中框自己重判
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true });   // 先穿透，等下一拍判命中
  }
  refreshTrayMenu();                        // 菜单勾选态同步
  // ★ 把穿透状态推给渲染端：开着＝除角色外的可点悬浮件全隐、抽屉收起
  if (win && !win.isDestroyed()) win.webContents.send('pet:mouse-through', cfg.mouseThrough);
  plog('mouseThrough=' + cfg.mouseThrough);
}

function sendCloth() {
  if (win) win.webContents.send('pet:cloth', cfg.cloth);
}

// 外观调节下发（摇晃/头部/身体比例）—— 面板拖动时实时推给渲染端
function sendTune() {
  if (win) win.webContents.send('pet:tune', cfg.tune);
}

// ---- 控制中心（无边框窗：7 页签 + 12 套主题 + 气泡编排；取代旧设置面板）----
let centerWin = null;
let centerPage = 'role';

// 把最新 cfg 推给控制中心（任何写盘后都调它，UI 不轮询）
function pushCenterCfg() {
  if (centerWin && !centerWin.isDestroyed()) {
    // ★ 多角色：衣服开关的清单 / 名字跟当前角色走，和 cfg 一起推（控制中心据此重建「角色」页）
    const snap = Object.assign({}, cfg, { clothKeys: clothKeys(), clothLabels: clothLabels(), tuneDefaults: defaultTune(activeChar), character: charSnapshot(), model: mbSnapshot() });
    try { centerWin.webContents.send('center:cfg', snap); } catch (e) { /* ignore */ }
  }
}

// ---- ★ 右键菜单窗（2026-09-26 方案 B）----
//   为什么要有它：实测「原来的原生菜单会挡桌宠、只能贴窗口边弹」；自绘在桌宠窗里也必然遮角色
//   （窗只有 200×266）。⇒ 独立小窗，定位到鼠标位置，主题跟 cfg.theme 走，点空白/失焦即收起。
let menuWin = null;
let menuRequested = false;
let menuShownAt = 0;   // 菜单窗本次弹出的时刻（blur 最小驻留用）
const MENU_W = 236, MENU_H = 272;   // 含最小化 / 恢复和可选角色行

function menuState() {
  return { mouseThrough: !!cfg.mouseThrough, speaking: !!SAY.busy, minimized: minimizedToTray, theme: cfg.theme, chars: charSnapshot() };
}
function pushMenuState() {
  if (menuWin && !menuWin.isDestroyed()) {
    try { menuWin.webContents.send('menu:cfg', menuState()); } catch (e) { /* ignore */ }
  }
}
function closeMenuWin() {
  menuRequested = false;
  if (menuWin && !menuWin.isDestroyed()) menuWin.hide();
}
function menuPick(id) {
  closeMenuWin();
  try {
    if (id === 'center') openCenter();
    else if (id === 'minimize') { if (minimizedToTray) restoreFromTray(); else minimizeToTray(); }
    else if (id === 'theme') openCenter('look');
    else if (id === 'through') setMouseThrough(!cfg.mouseThrough);
    else if (id.indexOf('char:') === 0) setCharacterMode(id.slice(5));
    else if (id === 'say') {
      if (SAY.busy) sayStop('menu');
      else void sayOnce();
    } else if (id === 'quit') { app.quit(); return; }
    else plog('menu unknown pick ' + id);
  } catch (e) { plog('menu pick err ' + (e && e.message)); }
  plog('menu pick ' + id);
}
function openMenuAtCursor() {
  menuRequested = true;
  let pt = { x: 0, y: 0 };
  try { pt = screen.getCursorScreenPoint(); } catch (e) { /* ignore */ }
  // ★ screen API 返回 DIP、setBounds 也收 DIP ⇒ 不用换算；按鼠标所在的那块屏幕的工作区夹取
  const dipPt = { x: pt.x, y: pt.y };
  let { x, y } = menuPos(pt, MENU_W, MENU_H, screen.getDisplayNearestPoint(pt).workArea);
  if (TEST_POS && win) { const wb = win.getBounds(); x = wb.x - MENU_W - 8; y = wb.y; }
  const bounds = { x: Math.round(x), y: Math.round(y), width: MENU_W, height: MENU_H };

  if (!menuWin || menuWin.isDestroyed()) {
    menuWin = new BrowserWindow({
      width: MENU_W, height: MENU_H, frame: false, resizable: false, transparent: true,
      hasShadow: false, alwaysOnTop: true, skipTaskbar: true, show: false, focusable: true,
      webPreferences: {
        preload: path.join(__dirname, 'renderer', 'menu-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    menuWin.setAlwaysOnTop(true, 'screen-saver');
    menuWin.setVisibleOnAllWorkspaces(true);
    menuWin.loadFile(path.join(__dirname, 'renderer', 'menu.html'));
    // ★ blur 关闭要带最小驻留（要「点击后就关掉」⇒ 守卫由 600ms 收到 200ms）：
    //   菜单窗 focusable:true，任何外部进程抢焦点都会让它秒收，所以留一小段守卫；
    //   但守卫太长会把「弹出后马上点别处」一起吞掉 ⇒ 只保留 200ms。
    menuWin.on('blur', () => {
      if (Date.now() - menuShownAt < 200) { plog('menu blur ignored (too soon)'); return; }
      closeMenuWin();
    });
    menuWin.on('closed', () => { menuWin = null; });
    menuWin.once('ready-to-show', () => {
      if (!menuRequested || !menuWin || menuWin.isDestroyed()) return;
      menuWin.setBounds(bounds);
      menuWin.show();
      menuShownAt = Date.now();
      // ★ 「菜单被桌宠挡住」：桌宠也是 screen-saver 级置顶 ⇒ 每次弹出都要
      //   重新声明置顶级别并 moveTop()，把菜单窗压到桌宠之上。
      try { menuWin.setAlwaysOnTop(true, 'screen-saver'); menuWin.moveTop(); } catch (e) { /* ignore */ }
      menuWin.focus();
      pushMenuState();
    });
  } else {
    menuWin.setBounds(bounds);
    menuWin.show();
    menuShownAt = Date.now();
    try { menuWin.setAlwaysOnTop(true, 'screen-saver'); menuWin.moveTop(); } catch (e) { /* ignore */ }
    menuWin.focus();
    pushMenuState();
  }
  plog('menu open at ' + bounds.x + ',' + bounds.y
    + ' raw=' + pt.x + ',' + pt.y
    + ' flip=' + (Math.round(dipPt.x) !== Math.round(x) ? 'X' : '-') + (Math.round(dipPt.y) !== Math.round(y) ? 'Y' : '-'));
}

// ★ 主题应用（2026-09-26 方案 B）：只改渲染端 class + CSS 变量，落盘走 saveCfg
function applyTheme(style, color) {
  if (THEME_STYLES.indexOf(style) >= 0) cfg.theme.style = style;
  if (THEME_COLORS.indexOf(color) >= 0) cfg.theme.color = color;
  saveCfg();
  if (win && !win.isDestroyed()) win.webContents.send('pet:theme', cfg.theme);
  pushCenterCfg();
  pushMenuState();   // ★ 菜单窗也跟着换肤（同一套 m-*/c-* 口径）
  plog('theme ' + cfg.theme.style + '/' + cfg.theme.color);
}

// ★ 气泡编排应用（2026-09-26 方案 B）：部分字段补丁式更新
function applyBubblePatch(p) {
  if (!p || typeof p !== 'object') return;
  if (typeof p.say === 'boolean') cfg.bubble.say = p.say;
  if (Array.isArray(p.items)) cfg.bubble.items = p.items.filter(function (k) { return BUBBLE_ITEM_KEYS.indexOf(k) >= 0; });
  if (Array.isArray(p.order)) {
    const seen = p.order.filter(function (k) { return BUBBLE_ITEM_KEYS.indexOf(k) >= 0; });
    for (const k of BUBBLE_ITEM_KEYS) if (seen.indexOf(k) < 0) seen.push(k);
    cfg.bubble.order = seen;
  }
  if (p.levels && typeof p.levels === 'object') {
    for (const k of BUBBLE_ITEM_KEYS) {
      if (p.levels[k] === 'big' || p.levels[k] === 'small') cfg.bubble.levels[k] = p.levels[k];
    }
  }
  if (typeof p.custom === 'string') cfg.bubble.custom = p.custom.slice(0, 60);
  // ★ 长宽（2026-09-26）：宽度是窗宽百分比，高度同时决定窗口顶部气泡带的高度
  if (typeof p.wPct === 'number' && isFinite(p.wPct)) cfg.bubble.wPct = Math.round(Math.max(60, Math.min(100, p.wPct)));
  if (typeof p.hPx === 'number' && isFinite(p.hPx)) cfg.bubble.hPx = Math.round(Math.max(40, Math.min(200, p.hPx)));
  saveCfg();
  applyBand();   // ★ 高度变了要同步改窗口高（右下角锚定、脚不动）
  if (win && !win.isDestroyed()) win.webContents.send('pet:bubble-cfg', cfg.bubble);
  pushCenterCfg();
  plog('bubble cfg items=' + JSON.stringify(cfg.bubble.items) + ' order=' + JSON.stringify(cfg.bubble.order));
}

function openCenter(page) {
  if (minimizedToTray) restoreFromTray();
  if (typeof page === 'string' && page) centerPage = page;
  if (centerWin && !centerWin.isDestroyed()) {
    try { centerWin.webContents.send('center:page', centerPage); } catch (e) { /* ignore */ }
    positionCenter(); centerWin.show(); return;
  }
  centerWin = new BrowserWindow({
    width: 620, height: 700, frame: false, resizable: false, transparent: true,
    hasShadow: false, alwaysOnTop: true, skipTaskbar: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'center-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  centerWin.setAlwaysOnTop(true, 'screen-saver');
  centerWin.setVisibleOnAllWorkspaces(true);
  centerWin.loadFile(path.join(__dirname, 'renderer', 'center.html'));
  centerWin.once('ready-to-show', () => { positionCenter(); if (!minimizedToTray && centerWin && !centerWin.isDestroyed()) centerWin.show(); });
  centerWin.on('closed', () => { centerWin = null; });
  plog('center open page=' + centerPage);
}

function positionCenter() {
  if (!centerWin || centerWin.isDestroyed() || !win) return;
  const b = win.getBounds();
  const pb = centerWin.getBounds();
  if (TEST_POS) { centerWin.setBounds({ x: b.x + b.width + 8, y: b.y }); return; }
  // ★ 控制中心优先贴桌宠**右侧**（放不下才翻到左侧），底边对齐、8px 间隙；按桌宠所在的那块屏幕夹取
  centerWin.setBounds(besidePos(b, pb.width, pb.height, screen.getDisplayMatching(b).workArea));
}

function closePanel() {
  if (centerWin && !centerWin.isDestroyed()) centerWin.close();
  centerWin = null;
}

let dragging = false;
// 拖拽速度差分：拖动期间窗口由常驻 helper 原生跟手（8ms SetWindowPos），渲染端拿不到任何位移，
// 所以「拖动速度」只能在这里算好推过去 —— 渲染端拿它做「头固定·身体倾斜」的弹簧-阻尼物理。
let dragPrevX = 0, dragPrevY = 0, dragPrevT = 0, dragVX = 0, dragVY = 0;
function dragVelReset() { dragPrevT = 0; dragVX = 0; dragVY = 0; }

// ---- 角色命中框 + 穿透开关（主进程独占判定）----
// 为什么不能让渲染端判定：桌面宠默认处于穿透态（WS_EX_TRANSPARENT），要靠「穿透态下仍能收到
// forward 的 mousemove → 命中角色 → 关穿透 → 才收得到 mousedown」。但只要鼠标下面有别的
// 可命中窗口（例如别的程序的全屏透明宿主窗口），鼠标消息就被它整个吃掉，桌宠一次 mousemove
// 都收不到 ⇒ 永远停在穿透态 ⇒ 点不中、拖不动。所以改由主进程按光标轮询自己判命中：
// 渲染端只上报角色包围盒（CSS 像素，相对窗口客户区），主进程决定 setIgnoreMouseEvents。
let hitBox = null;        // { left, top, right, bottom } —— 渲染端上报（贴身包围盒：按画出来的像素算）
// ★ 命中轮廓（点击范围贴合角色）：渲染端把角色画出来的像素按 cell 见方的格子记成位图
//   （有像素的格子外扩一格），{ cell, cols, rows, bits: Buffer }，第 i 格 = cy * cols + cx，bits[i>>3] 的第 (i&7) 位。
//   有它就按格子判命中（透明的地方不挡鼠标），没有（模型还没画出来）才退回 hitBox 方框。
let hitMask = null;
function maskHit(m, x, y) {
  const cx = Math.floor(x / m.cell), cy = Math.floor(y / m.cell);
  if (cx < 0 || cy < 0 || cx >= m.cols || cy >= m.rows) return false;
  const i = cy * m.cols + cx;
  return !!(m.bits[i >> 3] & (1 << (i & 7)));
}
let lastInside = null;    // 上一帧命中状态（变化才切开关，避免每帧调 API）
let lastInsideAt = 0;     // 上次判定命中的时刻（用于释放滞后）
let insideSince = 0;      // 连续处于「接管态」的起点（健康自检用）

// 光标屏幕坐标 → 窗口内相对坐标。Electron 的 screen API 在 Windows 上按 DIP 返回，
// 万一拿到的是物理像素也不出错 ⇒ 两种口径都算，取「落在窗口内」的那一种
function cursorRel(cx, cy, wx, wy, ww, wh, sf) {
  const a = { x: cx - wx, y: cy - wy, phy: false };
  const b = { x: cx / sf - wx, y: cy / sf - wy, phy: true };
  const ok = (r) => r.x > -8 && r.x < ww + 8 && r.y > -8 && r.y < wh + 8;
  if (!ok(a) && ok(b)) return b;
  return a;
}

// 系统原生拖动：常驻 PowerShell helper，发 WM_NCLBUTTONDOWN + HTCAPTION
// （等价 Tauri 的 startDragging；不占 app-region，因此右键不受影响）
let dragHelper = null;
let lastHelperSpawnAt = 0;   // 节流：helper 崩溃循环时不反复 spawn

function startDragHelper() {
  lastHelperSpawnAt = Date.now();
  lastHelperHitbox = ''; lastHelperMask = '';   // 新起的 helper 什么都没有：命中框 / 轮廓下一拍重推
  try {
    dragHelper = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'tools', 'drag-helper.ps1')],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    let rbuf = '';
    dragHelper.stdout.on('data', (d) => {
      rbuf += String(d);
      let i;
      while ((i = rbuf.indexOf('\n')) >= 0) {
        const line = rbuf.slice(0, i).trim();
        rbuf = rbuf.slice(i + 1);
        if (line) handleHelperLine(line);
      }
      if (rbuf.length > 4096) rbuf = '';   // 防御：异常长行不囤积
    });
    dragHelper.stderr.on('data', (d) => { const s = String(d).trim(); if (s) plog('[helper:err] ' + s); });
    dragHelper.on('exit', () => {
      plog('helper exited');
      dragHelper = null;
      // ★ helper 是拖动的执行端（含输入兜底）：挂了必须自己拉回来（节流防崩溃循环）
      if (Date.now() - lastHelperSpawnAt > 5000) setTimeout(() => { if (!dragHelper) startDragHelper(); }, 1200);
    });
    plog('helper spawned');
    setTimeout(() => armAutoFallback(), 600);   // ★ 输入兜底：helper 起来后武装
  } catch (e) { dragHelper = null; }
}

// 原生跟随器（照搬 Petra：拖动交给独立进程以 8ms 周期 SetWindowPos，不经渲染端算位移）
function helperCmd(line, quiet) {
  if (!dragHelper || !dragHelper.stdin || !dragHelper.stdin.writable) {
    if (quiet) {
      // 静默命令同时当心跳：helper 死了要能拉回来（HITBOX 每拍都发），但要节流
      if (Date.now() - lastHelperSpawnAt > 5000) startDragHelper();
      return;
    }
    plog('helper not ready, respawn for: ' + line);
    startDragHelper();
    setTimeout(() => {
      if (dragHelper && dragHelper.stdin && dragHelper.stdin.writable) {
        dragHelper.stdin.write(line + '\n');
        plog('sent(late) ' + line);
      } else {
        plog('helper STILL not writable, dropped: ' + line);
      }
    }, 350);
    return;
  }
  try {
    dragHelper.stdin.write(line + '\n');
    if (!quiet) plog('sent ' + line);
  } catch (e) { plog('write failed: ' + (e && e.message)); }
}

function nativeDragStart() {
  if (minimizedToTray) return;
  if (!win) { plog('nativeDragStart: no win'); return; }
  dragging = true;
  dragVelReset();
  try { win.moveTop(); } catch (e) { /* ignore */ }   // 拖动期间也保持最上（别被别的 topmost 桌宠压住）
  try {
    const buf = win.getNativeWindowHandle();
    const hwnd = buf.readBigUInt64LE ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
    plog('nativeDragStart hwnd=' + hwnd);
    helperCmd('DRAGSTART ' + hwnd);
    // ★ 参考 Petra（screen.rs drag_follow）：夹的是「角色包围盒」而不是整窗 ⇒ 角色永不跑出屏幕（透明边距可以）
    //   单位＝物理像素、相对窗口左上角：hitBox 是窗口内 CSS 坐标（＝DIP），乘 scaleFactor 即可
    try {
      const [ww, wh] = win.getSize();
      let sf = 1;
      try {
        const c = screen.getCursorScreenPoint();
        const d = screen.getDisplayNearestPoint(c) || screen.getPrimaryDisplay();
        sf = (d && d.scaleFactor) || 1;
      } catch (e2) { sf = 1; }
      const b = hitBox;
      const box = b
        ? [Math.round(b.left * sf), Math.round(b.top * sf), Math.round(b.right * sf), Math.round(b.bottom * sf)]
        : [0, 0, Math.round(ww * sf), Math.round(wh * sf)];   // 还没收到 hitBox 就先用整窗兜底
      helperCmd('BOUNDS ' + box.join(' '));
      plog('drag bounds(phy)=' + box.join(',') + ' sf=' + sf);
    } catch (e2) { plog('drag bounds failed: ' + (e2 && e2.message)); }
  } catch (e) { plog('nativeDragStart failed: ' + (e && e.message)); }
}

function nativeDragEnd() {
  if (!dragging) { helperCmd('DRAGEND'); return; }
  dragging = false;
  dragVelReset();
  plog('nativeDragEnd');
  helperCmd('DRAGEND');
  if (win && !win.isDestroyed()) win.webContents.send('pet:dragvel', { vx: 0, vy: 0, dragging: false });
}

// ---- ★ 输入兜底（AUTO fallback，2026-09-21）----
// 症状：显示器息屏唤醒后，Windows 不再把这个永不激活（WS_EX_NOACTIVATE）窗口的 WM_LBUTTONDOWN 投递下来，
//   鼠标移动照到、按下被吃 ⇒ 拖不动 + 单击无反应，而其他窗口一切正常。
// 实测排除：EX 位正确 / 命中测试指向本窗 / 任何进程都没持鼠标捕获 / 按下时机无竞态；注入 WM_LBUTTONDOWN 立刻生效
//   ⇒ 坏的只有「系统投递」这一段。
// 处置：把渲染端从链路里摘出去 —— helper 自己轮询按键状态（GetAsyncKeyState）、自己驱动原生跟随器。
function petHwndNum() {
  try {
    const buf = win.getNativeWindowHandle();
    return buf.readBigUInt64LE ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
  } catch (e) { return 0; }
}

function armAutoFallback() {
  const h = petHwndNum();
  if (!h) return;
  helperCmd('TARGET ' + h, true);
  helperCmd('AUTO ' + (minimizedToTray || cfg.mouseThrough ? '0' : '1'), true);
  plog('AUTO fallback armed hwnd=' + h);
}

let lastHelperHitbox = '';
function pushHitboxToHelper(boxPhy) {
  const s = boxPhy.join(' ');
  if (s === lastHelperHitbox) return;
  lastHelperHitbox = s;
  helperCmd('HITBOX ' + s, true);
}
// 命中轮廓也给 helper（它的输入兜底按格子判命中）：格子边长换成物理像素
let lastHelperMask = '';
function pushMaskToHelper(m, sf) {
  const s = (m.cell * sf).toFixed(3) + ' ' + m.cols + ' ' + m.rows + ' ' + m.b64;
  if (s === lastHelperMask) return;
  lastHelperMask = s;
  helperCmd('MASK ' + s, true);
}
// ★ 换角色 / 改大小 / 模型重新生成之后，角色（贴身包围盒）要是有一截出了屏幕，就整只挪回来
//   （helper 按物理像素算，和拖动时夹边同一套）。包围盒四边先各收 FIT_SLACK：发梢、尾巴摆动那几像素不算，免得一点点往里挪
//   只挪一次：等新模型画出来、头发尾巴的物理落定（FIT_SETTLE）后按那一刻的包围盒挪
//   （一开始是 5 秒内每次都挪，头发慢慢摆开时窗口会一点一点往里蹭，换角色时蹭了 2 秒）
const FIT_SLACK = 8, FIT_SETTLE = 1200;
let fitAt = 0, fitUntil = 0;
function fitSoon(why) { fitAt = Date.now() + FIT_SETTLE; fitUntil = fitAt + 4000; plog('fit on screen armed (' + why + ')'); }
function fitOnScreen(b) {
  const now = Date.now();
  if (!win || win.isDestroyed() || dragging || TEST_POS || now < fitAt || now > fitUntil) return;
  if (b.right - b.left <= 2 * FIT_SLACK || b.bottom - b.top <= 2 * FIT_SLACK) return;
  fitUntil = 0;
  let sf = 1;
  try { sf = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1; } catch (e) { /* ignore */ }
  const h = petHwndNum();
  const box = [b.left + FIT_SLACK, b.top + FIT_SLACK, b.right - FIT_SLACK, b.bottom - FIT_SLACK].map((v) => Math.round(v * sf));
  if (h) helperCmd('FIT ' + h + ' ' + box.join(' '), true);
}

let lastClickAt = 0;
let lastMenuAt = 0;      // 右键菜单去重：渲染端与 AUTO 兜底都可能请求弹菜单
// ★ 渲染端自己收到的按下（2026-10-17 改）：helper 的输入兜底每次松手都报 EVT CLICK（带按住了多久），
//   这一下按下渲染端也收到了（mousedown → pet:click）就不再补，没收到（按下被系统吞了）才由兜底补一次点击。
//   以前用「渲染端 2 秒内说过话」来猜，桌宠一直在报命中轮廓之后它永远「说过话」，兜底的点击全被拦掉了。
const rendererPresses = [];   // 渲染端报上来的按下时刻（最近几次）
function noteRendererPress() {
  rendererPresses.push(Date.now());
  if (rendererPresses.length > 8) rendererPresses.shift();
}
function rendererGotPress(pressAt) {
  return rendererPresses.some((t) => Math.abs(t - pressAt) < 150);
}
// at：兜底点击的位置（窗口内 CSS 像素），渲染端拿它判断点到头还是尾巴
function onPetClicked(source, silent, at) {
  const now = Date.now();
  if (source === 'renderer') noteRendererPress();
  if (now - lastClickAt < 150) { plog('click dedup from ' + source); return null; }
  lastClickAt = now;
  lastTouchAt = now;
  stats.clicks++;
  saveStats();
  plog('click +1 (' + source + ') total=' + stats.clicks);
  const payload = Object.assign({}, bubblePayload(), at ? { at } : {});
  // ★ 点角色时念台词（设置里开了才念）：气泡里显示的就是念的这一句
  if (cfg.voice.enabled && cfg.voice.clickTalk && !SAY.busy) {
    const line = pickLine();
    if (line) { payload.say = line; void sayText(line, { bubble: false }); }
  }
  if (!silent && win && !win.isDestroyed()) win.webContents.send('pet:clicked', payload);
  return payload;
}
// helper 报的物理像素（屏幕坐标）→ 桌宠窗口内的 CSS 像素
function helperPointRel(px, py) {
  if (!win || win.isDestroyed() || !isFinite(px) || !isFinite(py)) return null;
  try {
    const d = screen.getDisplayNearestPoint({ x: Math.round(px), y: Math.round(py) }) || screen.getPrimaryDisplay();
    const dip = screen.screenToDipPoint ? screen.screenToDipPoint({ x: px, y: py }) : { x: px / (d.scaleFactor || 1), y: py / (d.scaleFactor || 1) };
    const [wx, wy] = win.getPosition();
    return { x: Math.round(dip.x - wx), y: Math.round(dip.y - wy) };
  } catch (e) { return null; }
}

function handleHelperLine(line) {
  if (line.indexOf('EVT ') === 0) {
    const p = line.slice(4).trim().split(/\s+/);
    const kind = p[0];
    if (minimizedToTray && ['DRAGSTART', 'CLICK', 'RCLICK'].includes(kind)) {
      if (kind === 'DRAGSTART') helperCmd('DRAGEND', true);
      return;
    }
    if (kind === 'DRAGSTART') {
      plog('AUTO DRAGSTART ' + p.slice(1).join(','));
      if (!dragging) { dragging = true; dragVelReset(); }
      try {
        if (win && !win.isDestroyed()) { win.moveTop(); win.webContents.send('pet:dragauto', true); }
      } catch (e) { /* ignore */ }
    } else if (kind === 'DRAGEND') {
      plog('AUTO DRAGEND ' + p.slice(1).join(','));
      dragging = false;
      dragVelReset();
      try {
        if (win && !win.isDestroyed()) {
          win.webContents.send('pet:dragvel', { vx: 0, vy: 0, dragging: false });
          win.webContents.send('pet:dragauto', false);
        }
      } catch (e) { /* ignore */ }
    } else if (kind === 'CLICK') {
      // 松手时才报：按下时刻 = 现在 − 按住的时长（老 helper 不带时长，就按刚刚按下算）
      const hold = Number(p[3]) || 0;
      if (rendererGotPress(Date.now() - hold)) plog('AUTO CLICK handled by renderer');
      else {
        closeMenuWin();   // 和渲染端点击一样：点桌宠即收起菜单
        onPetClicked('auto', false, helperPointRel(Number(p[1]), Number(p[2])));
      }
    } else if (kind === 'RCLICK') {
      // 按下就报；渲染端收到右键时会自己开菜单（pet:menu 记 lastMenuAt），两边都开也只是同一个菜单窗再摆一次
      const now = Date.now();
      if (now - lastMenuAt < 400) { plog('menu dedup from auto'); return; }
      lastMenuAt = now;
      plog('AUTO RCLICK ' + p.slice(1).join(','));
      try { openMenuAtCursor(); }   // ★ 2026-09-26：与 pet:menu 同一条路（独立菜单窗），不再弹原生菜单
      catch (e) { plog('menu open failed: ' + (e && e.message)); }
    } else {
      plog('[helper] ' + line);
    }
    return;
  }
  plog('[helper] ' + line);
}

// ---- ★ 息屏/休眠/锁屏唤醒后的「自愈」----
// 症状（实测）：电脑息屏唤醒后拖不动；三进程都活着、主进程也在跑，
//   但 main.log 自某刻起彻底静默（cursorTick 的 HITBOX 只在 inside 变化时打 ⇒ 判定不再变化）、
//   按下时连 nativeDragStart 都没有 ⇒ 透明置顶窗口的「状态冻结」：
//   命中判定输入失效 / helper 的 stdin 管道不再认 / 置顶与初始穿透态丢失。
// 处置：唤醒时主动把状态重建一遍（重置拖拽与命中、强制下一拍重判、探一次 helper、重申置顶与初始穿透）。
function onSystemResume(reason) {
  plog('WAKE ' + reason + ' → 自愈：重置拖拽/命中、确认 helper、重申置顶与初始穿透');
  dragging = false;
  lastInside = null;      // 强制下一拍重新判定并切 setIgnoreMouseEvents
  insideSince = 0;
  dragVelReset();
  if (!dragHelper) {
    plog('WAKE helper 不在 → 重新拉起');
    startDragHelper();
  } else {
    helperCmd('QUITCHECK');   // 探一下 stdin 是否还可写（helper 不认的命令会忽略，但能暴露管道问题）
  }
  if (win && !win.isDestroyed()) {
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      if (!minimizedToTray && !win.isVisible()) win.showInactive();
      win.setIgnoreMouseEvents(true, { forward: true });   // 回到「先穿透，由主进程轮询接管」
      win.webContents.send('pet:wake', Date.now());        // 让渲染端清掉可能卡住的拖拽状态
    } catch (e) { plog('WAKE win 操作失败: ' + (e && e.message)); }
  }
  armAutoFallback();   // ★ 自愈时重新武装输入兜底（helper 若被重拉，TARGET/AUTO 要重发）
}

app.whenReady().then(() => {
  loadProfiles();   // ★ 多角色：先读角色档案，loadCfg 按它理顺每个角色的衣服 / 主题 / 摆动
  loadCfg();
  // ★ 陪伴统计：加载 + 本次会话计入 + 首次陪伴时间 + 每 30 秒结算一次（空闲/休眠不计，见 statsTick）
  loadStats();
  stats.sessions++;
  if (!stats.firstSeen) stats.firstSeen = new Date().toISOString();
  saveStats();
  setInterval(statsTick, 30000);
  startDragHelper();
  // ★ 系统唤醒/解锁时自愈（powerMonitor 在 Windows 上会发 resume / unlock-screen）
  try {
    powerMonitor.on('resume', () => { statsSuspended = false; statsTickAt = Date.now(); onSystemResume('resume'); });
    powerMonitor.on('unlock-screen', () => onSystemResume('unlock-screen'));
    powerMonitor.on('suspend', () => { statsSuspended = true; statsTickAt = Date.now(); saveStats(); });   // 休眠期间不计时
  } catch (e) { plog('powerMonitor 注册失败: ' + (e && e.message)); }
  createWindow();
  mbWatch();   // ★ 模型实时生成：盯着各角色的 PSD，保存了就重新生成
  // ★ 全局快捷键：正在说话时按下 = 停下（PET_HOTKEY 可改；被别的程序占了会注册失败，日志里有记录）
  const HOTKEY = process.env.PET_HOTKEY || 'Control+Alt+U';
  try {
    const ok = globalShortcut.register(HOTKEY, () => { if (SAY.busy) sayStop('hotkey'); });
    plog('hotkey ' + HOTKEY + ' (stop speaking) registered=' + ok);
  } catch (e) { plog('hotkey register fail: ' + e.message); }
  setTimeout(() => armAutoFallback(), 800);   // ★ 输入兜底：窗口就绪后把 TARGET/AUTO 发给 helper
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip(prof().name + ' · 桌宠');
    // 最小化时左键恢复；平时左键和右键都弹独立菜单窗。
    tray.setContextMenu(null);
    tray.on('click', () => {
      if (minimizedToTray) restoreFromTray();
      else { plog('tray click -> menu window'); openMenuAtCursor(); }
    });
    tray.on('right-click', () => { plog('tray right-click -> menu window'); openMenuAtCursor(); });
  } catch (e) { /* 托盘图标缺失时忽略 */ }

  ipcMain.on('pet:mouse', (_e, ignore) => {
    // ★ 穿透锁：不影响鼠标开着时，渲染端不许把这个窗口切回接管态
    if (cfg.mouseThrough) return;
    if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  ipcMain.on('pet:native-drag-start', () => { closeMenuWin(); nativeDragStart(); });   // ★ 点/拖桌宠即收起菜单（桌宠窗 focusable:false，不会产生 blur）
  ipcMain.on('pet:native-drag-end', () => { nativeDragEnd(); });
  // 角色命中框（渲染端上报，CSS 像素 / 相对窗口客户区）：主进程用它判命中、切穿透开关
  ipcMain.on('pet:hitbox', (_e, b) => {
    if (b && typeof b.left === 'number' && typeof b.right === 'number' &&
        typeof b.top === 'number' && typeof b.bottom === 'number') {
      hitBox = b;
      fitOnScreen(b);
    }
  });
  // 命中轮廓（渲染端上报，见 hitMask）：{ cell, cols, rows, bits: base64 }；null = 不用轮廓（退回方框）
  let hitMaskLogged = '';
  ipcMain.on('pet:hitmask', (_e, m) => {
    if (!m) { hitMask = null; return; }
    const cell = Number(m.cell), cols = m.cols | 0, rows = m.rows | 0;
    let bits = null;
    try { bits = Buffer.from(String(m.bits || ''), 'base64'); } catch (e) { bits = null; }
    if (!(cell > 0) || cols <= 0 || rows <= 0 || !bits || bits.length * 8 < cols * rows) return;
    hitMask = { cell, cols, rows, bits, b64: String(m.bits) };
    const sig = String(m.id || activeChar) + ' ' + cols + 'x' + rows;
    if (sig !== hitMaskLogged) {
      hitMaskLogged = sig;
      let n = 0;
      for (let i = 0; i < cols * rows; i++) if (bits[i >> 3] & (1 << (i & 7))) n++;
      plog('HITMASK ' + sig + ' cell=' + cell + ' on=' + n + '/' + (cols * rows) + (m.ms ? ' ms=' + m.ms : ''));
    }
  });
  ipcMain.on('pet:menu', () => {
    lastMenuAt = Date.now();   // 兜底随后报的右键就不再开第二次
    // ★ 2026-09-26 方案 B：不再弹 Electron 原生菜单（会盖住桌宠、只能贴窗口边），
    //   改开独立菜单窗，从鼠标位置弹出 —— 不占桌宠窗口、不遮角色。
    openMenuAtCursor();
  });
  // ★ 宿主侧右键入口（preload.js 的 petAPI.openMenu）：同上
  ipcMain.on('pet:open-menu', () => { lastMenuAt = Date.now(); openMenuAtCursor(); });
  ipcMain.on('pet:hide', () => minimizeToTray());
  ipcMain.handle('pet:minimized-state', () => minimizedToTray);
  ipcMain.on('pet:quit', () => app.quit());
  ipcMain.on('pet:size', (_e, px) => applySize(Number(px)));
  // ★ 气泡高度自适应：渲染端测完气泡实际高度后上报，
  //   主进程把窗口顶部那条带撑到刚好（差值 ≤4px 不动，防抖）；右下角锚定、脚不动。
  ipcMain.on('pet:bubble-height', (_e, px) => {
    const h = Math.max(40, Math.min(340, Math.round(Number(px) || 0)));
    if (!h) return;
    if (Math.abs(h - bubbleBandOverride) <= 4) return;
    bubbleBandOverride = h;
    applyBand();
    plog('bubble band = ' + h);
  });
  // ★ 宿主主窗 → 控制中心 / 主题 / 穿透 的转发（2026-09-26 方案 B）：宿主 preload 与控制中心 preload 是两套
  ipcMain.on('pet:center-open-page', (_e, page) => openCenter(typeof page === 'string' && page ? page : undefined));
  ipcMain.on('pet:center-theme', (_e, t) => { if (t) applyTheme(t.style, t.color); });
  ipcMain.on('pet:center-mouse-through', (_e, v) => setMouseThrough(!!v));
  // ===== ★ 控制中心 IPC（2026-09-26 方案 B · 取代旧设置面板）=====
  ipcMain.handle('center:init', () => ({
    size: cfg.size, sizes: SIZES, sizeMin: SIZE_MIN, sizeMax: SIZE_MAX,
    cloth: cfg.cloth, clothKeys: clothKeys(), clothLabels: clothLabels(),
    character: charSnapshot(),
    model: mbSnapshot(),
    bubble: cfg.bubble, bubbleItemKeys: BUBBLE_ITEM_KEYS, bubbleItemLabels: BUBBLE_ITEM_LABEL,
    tune: cfg.tune, tuneRange: TUNE_RANGE, tuneDefaults: defaultTune(activeChar),
    theme: cfg.theme, themeStyles: THEME_STYLES, themeColors: THEME_COLORS,
    stats: statsSummary(),
    mouseThrough: cfg.mouseThrough,
    page: centerPage,
    heart: heartEye,
    autostart: !!cfg.autostart,
    voice: voiceSnapshot(),
    api: Object.assign({ enabled: cfg.api.enabled }, localApi.info()),
    dataDir: DATA_DIR,
  }));
  ipcMain.on('center:size', (_e, px) => applySize(Number(px)));
  ipcMain.on('center:cloth', (_e, key, on) => {
    if (clothKeys().indexOf(key) < 0) return;
    cfg.cloth[key] = !!on;
    saveCfg();
    sendCloth();
    pushCenterCfg();
    plog('cloth ' + key + '=' + cfg.cloth[key]);
  });
  ipcMain.on('center:tune', (_e, key, value) => {
    const v = clampTune(key, Number(value));
    if (v === undefined) return;
    cfg.tune[key] = v;
    saveCfg();
    sendTune();
  });
  ipcMain.on('center:tune-reset', (_e, key) => {
    const def = defaultTune(activeChar);   // ★ 多角色：复位到这个角色的默认（代码默认值 + 档案覆盖）
    if (typeof key === 'string' && TUNE_RANGE[key]) cfg.tune[key] = def[key];
    else for (const k in TUNE_RANGE) cfg.tune[k] = def[k];
    saveCfg();
    sendTune();
    pushCenterCfg();
    plog('tune reset key=' + (key || 'all'));
  });
  ipcMain.on('center:bubble', (_e, patch) => {
    if (patch && typeof patch.on === 'boolean') setBubbleOn(patch.on);
    applyBubblePatch(patch);
  });
  ipcMain.on('center:theme', (_e, t) => { if (t) applyTheme(t.style, t.color); });
  ipcMain.on('center:open-page', (_e, page) => {
    if (typeof page === 'string' && page) centerPage = page;
    if (centerWin && !centerWin.isDestroyed()) centerWin.webContents.send('center:page', centerPage);
  });
  // ★ 语音页：读 / 改设置、试听、停下、列出 Windows 自带的语音
  ipcMain.handle('center:voice-get', () => voiceSnapshot());
  ipcMain.handle('center:voice-set', (_e, patch) => {
    cfg.voice = voice.applyPatch(cfg.voice, patch, voiceSecret);
    saveCfg();
    pushCenterVoice();
    plog('voice cfg ' + voice.describe(cfg.voice));
    return voiceSnapshot();
  });
  ipcMain.handle('center:voice-test', async (_e, text) => {
    const t = String(text || '').trim() || pickLine() || '你好，我在这里。';
    const spoken = await sayText(t);
    return { ok: spoken, error: spoken ? '' : (cfg.voice.enabled ? SAY.lastError : '语音关着') };
  });
  ipcMain.on('center:voice-stop', () => sayStop('center'));
  ipcMain.handle('center:voice-system-list', () => voice.listSystemVoices({ log: plog }));
  // ★ 本机接口：开关、换令牌（换了以后插件要用新令牌）
  ipcMain.handle('center:api', (_e, cmd) => {
    if (cmd === 'regen') { localApi.regenerateToken(DATA_DIR); plog('local api token regenerated'); }
    else if (cmd === 'toggle') { cfg.api.enabled = !cfg.api.enabled; saveCfg(); restartApi(); }
    else if (cmd === 'copy') { clipboard.writeText(localApi.info().token || ''); return { ok: true }; }
    return Object.assign({ enabled: cfg.api.enabled }, localApi.info());
  });
  // ★ 爱心眼（常驻开关）：与托盘菜单共用同一份运行时状态（不落盘，保持原行为）
  ipcMain.on('center:heart', (_e, on) => { heartEye = !!on; sendHeart(); pushCenterCfg(); });
  // ★ 开机自启（Electron 原生登录项）——真实调用，不做假接线
  ipcMain.on('center:autostart', (_e, on) => {
    cfg.autostart = !!on;
    saveCfg();
    try {
      app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: [__dirname] });
    } catch (e) { plog('autostart err ' + (e && e.message)); }
    pushCenterCfg();
    plog('autostart=' + cfg.autostart);
  });
  ipcMain.on('center:mouse-through', (_e, v) => setMouseThrough(!!v));
  // ★ 多角色：控制中心「角色」页选排第一的 / 某个角色
  ipcMain.on('center:character', (_e, mode) => setCharacterMode(String(mode || '')));
  ipcMain.on('center:hide', () => minimizeToTray());
  ipcMain.on('center:quit', () => app.quit());
  ipcMain.on('center:reload-model', () => { if (win && !win.isDestroyed()) win.webContents.reload(); });
  // ★ 模型实时生成（2026-10-17）：「系统」页 —— state | open（用默认程序打开 PSD，一般是 Photoshop）| folder | rebuild
  //   PET_NO_SHELL=1（测试）：不真去打开 Photoshop / 资源管理器，只记日志
  ipcMain.handle('center:model', async (_e, cmd) => {
    const id = activeChar;
    const psd = psdPath(id);
    if (cmd === 'state') return mbSnapshot(id);
    if (cmd === 'data') {
      const err = process.env.PET_NO_SHELL === '1' ? '' : await shell.openPath(DATA_DIR);
      return err ? { ok: false, error: err } : { ok: true };
    }
    if (!psd) return { ok: false, error: prof(id).name + '没有登记 PSD' };
    if (cmd === 'rebuild') { mbQueue(id, 'manual'); return { ok: true }; }
    if (!fs.existsSync(psd)) return { ok: false, error: '找不到 ' + psd };
    const test = process.env.PET_NO_SHELL === '1';
    if (cmd === 'open') {
      const err = test ? '' : await shell.openPath(psd);
      plog('model open ' + psd + (test ? ' (test, not opened)' : '') + (err ? ' failed: ' + err : ''));
      return err ? { ok: false, error: err } : { ok: true };
    }
    if (cmd === 'folder') {
      if (!test) shell.showItemInFolder(psd);
      plog('model folder ' + psd + (test ? ' (test, not opened)' : ''));
      return { ok: true };
    }
    return { ok: false, error: 'unknown cmd ' + cmd };
  });
  ipcMain.on('center:close', () => closePanel());
  // ===== ★ 右键菜单窗 IPC（2026-09-26 方案 B）=====
  ipcMain.handle('menu:init', () => menuState());
  ipcMain.on('menu:pick', (_e, id) => menuPick(String(id || '')));
  ipcMain.on('menu:close', () => closeMenuWin());
  // ★ 多角色：渲染端启动时拉一次现在是谁（模型 / rig / 尾巴 / 台词），换角色时推 pet:character
  ipcMain.handle('pet:character-state', () => characterInfo());
  // 服装状态（渲染端加载完主动拉一次，避免早发丢失）
  ipcMain.handle('pet:cloth-state', () => cfg.cloth);
  // ★ 渲染后端：渲染端 boot() 拉它决定走 psd 骨骼还是官方 live2d
  ipcMain.handle('pet:render-state', () => 'live2d');   // ★ PSD 后端已移除：恒 live2d
  // 外观调节状态（同上，渲染端启动时主动拉一次）
  ipcMain.handle('pet:tune-state', () => cfg.tune);
  // ★ 气泡总开关状态（同上：渲染端加载完主动拉一次，避免早发丢失）
  ipcMain.handle('pet:bubble-state', () => cfg.bubble.on);
  // ★「台词」开关状态（同上）
  ipcMain.handle('pet:bubble-say-state', () => cfg.bubble.say);
  // ★ 主题状态（2026-09-26 方案 B，同上：启动主动拉一次避免早发丢失）
  ipcMain.handle('pet:theme-state', () => cfg.theme);
  // ★ 气泡编排状态（同上）
  ipcMain.handle('pet:bubble-cfg-state', () => cfg.bubble);
  // ★ 不影响鼠标（点击穿透）状态：渲染端加载完主动拉一次（同上，避免早发丢失）
  ipcMain.handle('pet:mouse-through-state', () => cfg.mouseThrough);
  // ★ 点击上报：被摸次数 +1，并把累计统计回传给渲染端（头顶气泡显示）
  ipcMain.handle('pet:click', () => {
    closeMenuWin();   // 点桌宠即收起菜单
    // 渲染端点自己已经播过反馈动画：这里只记账，不回推；150 ms 内的重复点击（兜底补的）只回数据
    return onPetClicked('renderer', true) || bubblePayload();
  });
  // 爱心眼开关状态（渲染端加载完模型后主动拉一次，避免早发丢失）
  ipcMain.handle('pet:heart-state', () => heartEye);
  // ★ 让桌宠说一句（渲染端 / 自检都能触发）
  ipcMain.on('pet:say', () => { void sayOnce(); });

  // 全屏鼠标位置：空闲 30ms、拖拽时 16ms（拖拽要够密的采样才算得出甩动速度）
  // 同一循环里：① 差分窗口位置 = 拖动速度（一阶低通滤掉 helper 8ms 步进的抖动）
  //            ② 用上报的角色包围盒自己判命中 → 切 setIgnoreMouseEvents（不依赖渲染端 mousemove）
  // 测试用：PET_CURSOR_FILE=<json 文件> 里写 {"x","y"}（DIP）当作鼠标位置，隔离实例不用动真鼠标就能测命中；
  //   PET_HELPER_INJECT=<文件>：文件里每行一条 helper 输出（如 EVT CLICK x y holdMs），读完删掉，当作 helper 说的
  const CURSOR_FILE = process.env.PET_CURSOR_FILE || '';
  const HELPER_INJECT = process.env.PET_HELPER_INJECT || '';
  function injectHelperLines() {
    let t = '';
    try { t = fs.readFileSync(HELPER_INJECT, 'utf8'); fs.unlinkSync(HELPER_INJECT); } catch (e) { return; }
    for (const ln of t.split(/\r?\n/)) if (ln.trim()) handleHelperLine(ln.trim());
  }
  function cursorPoint() {
    if (CURSOR_FILE) {
      try { const j = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')); return { x: Number(j.x) || 0, y: Number(j.y) || 0 }; } catch (e) { return { x: -99999, y: -99999 }; }
    }
    return screen.getCursorScreenPoint();
  }
  function cursorTick() {
    if (HELPER_INJECT) injectHelperLines();
    if (fitUntil && hitBox) fitOnScreen(hitBox);   // 换角色等之后的「挪回屏幕」到点就做（不用等下一次包围盒变化）
    if (win && !win.isDestroyed() && win.isVisible()) {
      try {
        const c = cursorPoint();
        const [wx, wy] = win.getPosition();
        const [ww, wh] = win.getSize();
        win.webContents.send('pet:cursor', { sx: c.x, sy: c.y, wx, wy, ww, wh });
        if (dragging) {
          const now = Date.now();
          if (dragPrevT) {
            const dt = Math.max(1, now - dragPrevT) / 1000;
            dragVX = dragVX * 0.55 + ((wx - dragPrevX) / dt) * 0.45;
            dragVY = dragVY * 0.55 + ((wy - dragPrevY) / dt) * 0.45;
          }
          dragPrevX = wx; dragPrevY = wy; dragPrevT = now;
          win.webContents.send('pet:dragvel', { vx: dragVX, vy: dragVY, dragging: true });
        }
        // ---- 命中判定（主进程权威）----
        const disp = screen.getDisplayNearestPoint(c) || screen.getPrimaryDisplay();
        const sf = (disp && disp.scaleFactor) || 1;
        const rel = cursorRel(c.x, c.y, wx, wy, ww, wh, sf);
        const b = hitBox;
        const tnow = Date.now();
        const HIT_PAD = 10;   // 命中框外扩：角色边缘也给得到（原来 ±4，边缘一来回就漏判）
        // 原始命中（不含迟滞）——★ 2026-09-21 修：时间戳只认它。
        //   原来写成「if (inside) lastInsideAt = tnow」（拿迟滞后的结果刷新），迟滞会自己给自己续命：
        //   一旦某拍原始判 false 被迟滞拉回 true，就永远满足「400ms 内」⇒ inside 永久 true ⇒
        //   窗口永久停在接管态 + 每 30ms moveTop（透明区也照吃鼠标），日志里 HEAL 被反复触发 300+ 次。
        // ★ 2026-10-17：有命中轮廓就按轮廓判（轮廓自己外扩了一格，不再加 HIT_PAD）
        const m = hitMask;
        const rawHit = dragging ? true : m ? maskHit(m, rel.x, rel.y) : !!(b &&
          rel.x >= b.left - HIT_PAD && rel.x <= b.right + HIT_PAD &&
          rel.y >= b.top - HIT_PAD && rel.y <= b.bottom + HIT_PAD);
        if (rawHit) lastInsideAt = tnow;
        // 释放滞后（迟滞）：一离开就切回穿透的话，从边缘按下时正好撞在穿透瞬间，
        // 点击会落到下面那个全屏宿主窗口上（实测症状：「拖不动」而 inside 日志却一直在 true/false 翻）
        let inside = rawHit || !!(lastInside && tnow - lastInsideAt < 400);
        // ★ 不影响鼠标（点击穿透）：开着就恒定判「不在窗口上」
        //   ⇒ 窗口永远穿透、不吃鼠标、不抬升、不抢焦点（收口在这一处，上面各路命中一并作废）
        if (cfg.mouseThrough) inside = false;
        // ★ 健康自检（兜底，覆盖「显示器单独断电」这类不触发 powerMonitor 的情况）：
        //   没人会把鼠标压在角色上整整 5 分钟 ⇒ 接管态持续过久 ＝ 状态冻结 ⇒ 主动重置命中状态自愈
        if (inside) {
          if (!insideSince) insideSince = tnow;
          else if (tnow - insideSince > 5 * 60 * 1000) {
            plog('HEAL 接管态已持续 ' + Math.round((tnow - insideSince) / 1000) + 's → 重置命中状态重判');
            insideSince = tnow;
            lastInside = null;
          }
        } else insideSince = 0;
        // Petra 打开设置窗口时会把自己再顶到最上 ⇒ 一次性抬升不够：
        // 只要光标还压在角色上，就每个 tick 持续抬（30ms 一次），保证点击落得到本窗口
        if (inside && typeof win.moveTop === 'function') {
      // ★ 「菜单被桌宠挡住」的根因就在这一句：桌宠在命中态每 30ms moveTop 一次，
      //   独立菜单窗刚弹出就被压到下面 ⇒ 菜单窗可见时**跳过这次提升**，菜单才能压在桌宠之上。
      const menuVisible = !!(menuWin && !menuWin.isDestroyed() && menuWin.isVisible());
      if (!menuVisible) win.moveTop();
    }
        if (inside !== lastInside) {
          lastInside = inside;
          win.setIgnoreMouseEvents(!inside, { forward: true });
          win.webContents.send('pet:inside', inside);
          plog('HITBOX inside=' + inside + ' rel=' + Math.round(rel.x) + ',' + Math.round(rel.y) +
            ' box=' + (b ? [b.left, b.top, b.right, b.bottom].join(',') : 'none') +
            ' win=' + [wx, wy, ww, wh].join(',') + ' sf=' + sf + ' phy=' + rel.phy);
          // 测试时顺便问 helper 同一个点（它的输入兜底按自己那份轮廓判），日志里应和上面这行一致
          if (CURSOR_FILE) helperCmd('TESTHIT ' + Math.round(rel.x * sf) + ' ' + Math.round(rel.y * sf), true);
        }
        // ★ 输入兜底：把命中框（物理 px，相对窗口左上）报给 helper，让它自己判命中、自己发起拖动
        //   ★ 不影响鼠标开着时不推：AUTO 已经被 setMouseThrough 关掉，再推命中框只会让它留着旧框
        if (b && !cfg.mouseThrough) pushHitboxToHelper([
          Math.round(b.left * sf), Math.round(b.top * sf),
          Math.round(b.right * sf), Math.round(b.bottom * sf)
        ]);
        if (m && !cfg.mouseThrough) pushMaskToHelper(m, sf);
      } catch (e) { /* ignore */ }
    }
    setTimeout(cursorTick, dragging ? 16 : 30);
  }
  cursorTick();

  // ★ 空闲时偶尔说一句（设置里 voice.idleMinutes > 0 才说）
  setInterval(idleTalkTick, 30000);
  // ★ 本机接口（给插件用）
  restartApi();
});

// ---- ★ 本机接口：只听 127.0.0.1，要带令牌（令牌在用户数据目录的 api-token.txt）；详见 src/local-api.js 和 docs ----
function restartApi() {
  localApi.stop();
  if (!cfg.api.enabled) { plog('local api off'); return; }
  localApi.start({
    port: cfg.api.port, dataDir: DATA_DIR, log: plog,
    handlers: {
      state: () => ({
        character: { id: activeChar, name: prof().name }, characters: charList(),
        speaking: !!SAY.busy, voice: voiceStateText(), visible: !!(win && !win.isDestroyed() && win.isVisible()),
        mouseThrough: !!cfg.mouseThrough, actions: ACTION_IDS,
      }),
      say: async (body) => {
        const text = String((body && body.text) || '').trim();
        if (!text) return { ok: false, error: 'text 不能为空' };
        const spoken = await sayText(text);
        return { ok: true, spoken, error: spoken ? '' : (cfg.voice.enabled ? SAY.lastError : '语音关着') };
      },
      stop: () => { sayStop('api'); return { ok: true }; },
      action: (body) => {
        const id = String((body && body.id) || '');
        if (id && ACTION_IDS.indexOf(id) < 0) return { ok: false, error: '没有这个动作：' + id };
        sendAction(id);
        return { ok: true };
      },
      character: (body) => {
        const id = String((body && body.id) || '');
        if (id && !CHARS[id]) return { ok: false, error: '没有这个角色：' + id };
        setCharacterMode(id);
        return { ok: true, active: activeChar };
      },
    },
  });
}
// 右键菜单 / 本机接口能用的动作（renderer/actions.js 里的 id；空串 = 随机一个）
const ACTION_IDS = ['nod', 'shake', 'tilt', 'lookAround', 'lookSide', 'yawn', 'stretch', 'happy', 'surprised', 'sleepy', 'sway'];

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ }
  try { localApi.stop(); } catch (e) { /* ignore */ }
  try { if (dragHelper) dragHelper.kill(); } catch (e) { /* ignore */ }
});
