// 桌宠 · 右键菜单窗 preload（独立小窗：从鼠标位置弹出，不占桌宠窗口）
//   白名单暴露：pick(id) 上报点了哪一项；init() 拉当前状态（穿透/语音）；onCfg 订阅状态变化。
//   不把 ipcRenderer 本体交出去。
const { contextBridge, ipcRenderer } = require('electron');

const PUSH = ['menu:cfg'];

contextBridge.exposeInMainWorld('menuAPI', {
  init: () => ipcRenderer.invoke('menu:init'),
  pick: (id) => ipcRenderer.send('menu:pick', String(id || '')),
  close: () => ipcRenderer.send('menu:close'),
  onCfg: (cb) => {
    if (typeof cb !== 'function') return function () {};
    const h = (_e, v) => cb(v);
    ipcRenderer.on('menu:cfg', h);
    return function () { try { ipcRenderer.removeListener('menu:cfg', h); } catch (e) { /* ignore */ } };
  },
});
