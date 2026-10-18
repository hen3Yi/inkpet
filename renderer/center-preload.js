// 桌宠 · 控制中心 preload
//   白名单暴露 center:* 通道给渲染端；只暴露具名方法，不把 ipcRenderer 本体交出去（渲染端拿不到任意通道）。
const { contextBridge, ipcRenderer } = require('electron');

// 主进程 → 渲染端 的推送白名单：只有这些通道允许被订阅
const PUSH_CHANNELS = [
  'center:cfg',
  'center:page',
  'center:theme',
  'center:voice',      // 语音设置 / 状态变了
  'center:model',      // PSD → 模型 生成到哪一步了
];

// 订阅一条推送，返回取消订阅的函数（白名单外一律拒绝）
function on(channel, cb) {
  if (PUSH_CHANNELS.indexOf(channel) < 0) {
    console.warn('[center-preload] 不在推送白名单里的通道：' + channel);
    return function () {};
  }
  if (typeof cb !== 'function') return function () {};
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return function off() {
    try { ipcRenderer.removeListener(channel, listener); } catch (e) { /* ignore */ }
  };
}

contextBridge.exposeInMainWorld('centerAPI', {
  // ---------- invoke（有返回） ----------
  init: () => ipcRenderer.invoke('center:init'),
  // ★ 模型实时生成：cmd = state | open（打开当前角色的 PSD）| folder | rebuild | data（打开数据目录）
  model: (cmd) => ipcRenderer.invoke('center:model', String(cmd || 'state')),
  // ★ 语音：读 / 改设置（patch 里 qwen.key 给明文，主进程加密保存）、试听、列出 Windows 自带的语音
  voiceGet: () => ipcRenderer.invoke('center:voice-get'),
  voiceSet: (patch) => ipcRenderer.invoke('center:voice-set', patch || {}),
  voiceTest: (text) => ipcRenderer.invoke('center:voice-test', text || ''),
  voiceSystemList: () => ipcRenderer.invoke('center:voice-system-list'),
  // ★ 本机接口：cmd = info | regen（换令牌）| toggle（开 / 关）| copy（令牌复制到剪贴板）
  api: (cmd) => ipcRenderer.invoke('center:api', String(cmd || 'info')),

  // ---------- send（无返回） ----------
  setSize: (px) => ipcRenderer.send('center:size', px),
  // 形态与 main.js 的 handler 对齐：cloth / tune 都是 (key, value) 两个位置参数
  setCloth: (key, value) => ipcRenderer.send('center:cloth', key, value),
  setTune: (key, value) => ipcRenderer.send('center:tune', key, value),
  resetTune: (key) => ipcRenderer.send('center:tune-reset', key === undefined ? null : key),
  setBubble: (patch) => ipcRenderer.send('center:bubble', patch || {}),
  setTheme: (style, color) => ipcRenderer.send('center:theme', { style, color }),
  openPage: (page) => ipcRenderer.send('center:open-page', page),
  voiceStop: () => ipcRenderer.send('center:voice-stop'),
  setMouseThrough: (on) => ipcRenderer.send('center:mouse-through', !!on),
  // ★ 多角色：角色 id（空串 = 排第一的那个）
  setCharacter: (id) => ipcRenderer.send('center:character', String(id || '')),
  setAutostart: (on) => ipcRenderer.send('center:autostart', !!on),
  // ★ 爱心眼（常驻开关）
  setHeart: (on) => ipcRenderer.send('center:heart', !!on),
  hide: () => ipcRenderer.send('center:hide'),
  quit: () => ipcRenderer.send('center:quit'),
  reloadModel: () => ipcRenderer.send('center:reload-model'),
  close: () => ipcRenderer.send('center:close'),

  // ---------- 订阅（主进程 → 渲染端） ----------
  on,
});
