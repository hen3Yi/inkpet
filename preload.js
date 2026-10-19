// 桌宠窗口的 preload：渲染端（renderer/pet.js）能用的主进程接口都在这里
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  setIgnoreMouse: (v) => ipcRenderer.send('pet:mouse', v),
  nativeDragStart: () => ipcRenderer.send('pet:native-drag-start'),
  nativeDragEnd: () => ipcRenderer.send('pet:native-drag-end'),
  menu: () => ipcRenderer.send('pet:menu'),
  hide: () => ipcRenderer.send('pet:hide'),
  quit: () => ipcRenderer.send('pet:quit'),
  setSize: (k) => ipcRenderer.send('pet:size', k),
  onCursor: (cb) => ipcRenderer.on('pet:cursor', (_e, d) => cb(d)),
  onDragVel: (cb) => ipcRenderer.on('pet:dragvel', (_e, d) => cb(d)),
  onWake: (cb) => ipcRenderer.on('pet:wake', (_e, t) => cb(t)),
  // 点击上报：主进程把「被摸次数」+1 并回传气泡数据
  click: () => ipcRenderer.invoke('pet:click'),
  // 命中框上报（主进程按光标轮询自己判命中，穿透开关不再依赖渲染端能否收到 mousemove）
  reportHitbox: (b) => ipcRenderer.send('pet:hitbox', b),
  // ★ 命中轮廓：角色画出来的像素按格子记成位图，主进程按它判命中（透明的地方不挡鼠标）
  reportHitmask: (m) => ipcRenderer.send('pet:hitmask', m),
  onInside: (cb) => ipcRenderer.on('pet:inside', (_e, v) => cb(v)),
  onMinimized: (cb) => ipcRenderer.on('pet:minimized', (_e, v) => cb(v)),
  minimizedState: () => ipcRenderer.invoke('pet:minimized-state'),
  // ★ 输入兜底：拖动由 helper 自己发起 / 结束时推这个通道
  onDragAuto: (cb) => ipcRenderer.on('pet:dragauto', (_e, v) => cb(v)),
  // ★ 兜底点击：窗口收不到 mousedown 时由主进程代播点击反馈（动画脉冲 + 音效 + 气泡）
  onClicked: (cb) => ipcRenderer.on('pet:clicked', (_e, d) => cb(d)),
  onAction: (cb) => ipcRenderer.on('pet:action', (_e, id) => cb(id)),
  onHeart: (cb) => ipcRenderer.on('pet:heart', (_e, v) => cb(v)),
  heartState: () => ipcRenderer.invoke('pet:heart-state'),
  onCloth: (cb) => ipcRenderer.on('pet:cloth', (_e, v) => cb(v)),
  clothState: () => ipcRenderer.invoke('pet:cloth-state'),
  // ★ 多角色：现在是谁（模型 / rig / 尾巴 / 台词 / 衣服），换角色时主进程推 pet:character
  characterState: () => ipcRenderer.invoke('pet:character-state'),
  onCharacter: (cb) => ipcRenderer.on('pet:character', (_e, v) => cb(v)),
  // ★ 模型实时生成：PSD 保存后主进程生成好新模型，推 pet:model-reload（同一角色，地址带 ?v=）
  onModelReload: (cb) => ipcRenderer.on('pet:model-reload', (_e, v) => cb(v)),
  // 外观调节（摇晃 / 头部 / 身体比例）：主进程推、渲染端实时套用
  onTune: (cb) => ipcRenderer.on('pet:tune', (_e, v) => cb(v)),
  tuneState: () => ipcRenderer.invoke('pet:tune-state'),
  // ★ 气泡总开关：主进程推 + 启动主动拉一次（避免早发丢失）
  onBubble: (cb) => ipcRenderer.on('pet:bubble', (_e, v) => cb(v)),
  bubbleState: () => ipcRenderer.invoke('pet:bubble-state'),
  // ★ 台词行开关（同上）
  onBubbleSay: (cb) => ipcRenderer.on('pet:bubble-say', (_e, v) => cb(v)),
  bubbleSayState: () => ipcRenderer.invoke('pet:bubble-say-state'),
  // ★ 不影响鼠标（点击穿透）
  onMouseThrough: (cb) => ipcRenderer.on('pet:mouse-through', (_e, v) => cb(v)),
  mouseThroughState: () => ipcRenderer.invoke('pet:mouse-through-state'),
  // ★ 主题：3 质感 × 5 颜色，渲染端据此切 class + CSS 变量
  onTheme: (cb) => ipcRenderer.on('pet:theme', (_e, v) => cb(v)),
  themeState: () => ipcRenderer.invoke('pet:theme-state'),
  // ★ 气泡内容编排：主进程按 config.bubble 生成数据行，改编排时推给宿主刷新
  onBubbleCfg: (cb) => ipcRenderer.on('pet:bubble-cfg', (_e, v) => cb(v)),
  bubbleCfgState: () => ipcRenderer.invoke('pet:bubble-cfg-state'),
  // ★ 宿主主窗 → 控制中心 / 主题 / 穿透 的转发桥
  centerOpenPage: (page) => ipcRenderer.send('pet:center-open-page', page),
  centerTheme: (t) => ipcRenderer.send('pet:center-theme', t),
  centerMouseThrough: (v) => ipcRenderer.send('pet:center-mouse-through', v),
  // ★ 右键菜单：主进程开独立菜单窗、从鼠标位置弹出
  openMenu: () => ipcRenderer.send('pet:open-menu'),
  // ★ 气泡高度自适应：渲染端测出气泡实际内容高度后上报，主进程把窗口带撑到刚好
  reportBubbleHeight: (px) => ipcRenderer.send('pet:bubble-height', px),
  // 拖拽闲置事件（pet.js 有订阅点；主进程目前不发，补一个桥避免 undefined 调用抛错）
  onDragIdle: (cb) => ipcRenderer.on('pet:drag-idle', (_e, v) => cb(v)),
  // ★ 说话：念一句台词；主进程边合成边推 PCM 片段（say-chunk），渲染端排程连播、按音量张嘴
  say: () => ipcRenderer.send('pet:say'),
  onSayPending: (cb) => ipcRenderer.on('pet:say-pending', (_e, d) => cb(d)),
  onSayText: (cb) => ipcRenderer.on('pet:say-text', (_e, d) => cb(d)),
  onSayChunk: (cb) => ipcRenderer.on('pet:say-chunk', (_e, d) => cb(d)),
  onSayEnd: (cb) => ipcRenderer.on('pet:say-end', (_e, d) => cb(d)),
  onSayFail: (cb) => ipcRenderer.on('pet:say-fail', (_e, d) => cb(d)),
  // ★ 停下正在念的（已排上的音频也停）
  onSayStop: (cb) => ipcRenderer.on('pet:say-stop', (_e, d) => cb(d)),
});
