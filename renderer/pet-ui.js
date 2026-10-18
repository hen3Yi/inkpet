// ============================================================
// 桌宠 · 宿主主窗的界面逻辑
//   只做三件事：
//     ① 主题：3 质感 × 5 颜色，class + CSS 变量（写盘只走 main.js，这里只改本页 class）
//     ② 菜单：本页不自绘菜单（小窗里必然遮角色）⇒ 只向主进程请求弹独立菜单小窗
//     ③ 不影响鼠标（穿透）时给 body 挂 class
//   角色渲染、点击命中、拖拽、气泡全部由 pet.js 负责 —— 本文件不碰它的链路。
// ============================================================
(function () {
  'use strict';
  const api = window.petAPI || {};
  const $ = (id) => document.getElementById(id);

  // ---------- 通道调用：存在就调，不存在只记一行（绝不自造通道、绝不因此报错） ----------
  function callHost(name, arg) {
    if (typeof api[name] === 'function') {
      try { return api[name](arg); } catch (e) { console.warn('[pet-ui] ' + name + ' failed: ' + e.message); }
    }
    console.log('[pet-ui] 宿主通道未接线：petAPI.' + name + '（preload.js 补上即自动生效）');
    return null;
  }

  // ---------- ① 主题 ----------
  const MATS = { glass: '暗色玻璃', acrylic: '浅色磨砂', flat: '实色纯平' };
  const COLS = { sakura: '樱粉', celadon: '青瓷', midnight: '午夜蓝', amber: '暖砂金', ink: '墨朱' };
  let theme = { style: 'glass', color: 'sakura' };

  function applyTheme(t, sync) {
    if (!t || !MATS[t.style] || !COLS[t.color]) return;
    theme = { style: t.style, color: t.color };
    const de = document.documentElement;
    de.className = de.className
      .replace(/\bm-[a-z]+\b/g, '').replace(/\bc-[a-z]+\b/g, '')
      .replace(/\s+/g, ' ').trim();
    de.classList.add('m-' + theme.style);
    de.classList.add('c-' + theme.color);
    if (sync !== false && api.centerTheme) api.centerTheme(theme);   // 持久化交给 main.js 的 saveCfg
  }
  // ★ 启动必须无条件先把「默认主题」落到 html 上：没有这一步，一旦主题通道还没接线（或读取失败），
  //   html 上就一个 m-*/c-* 都没有 ⇒ CSS 变量全空 ⇒ 气泡直接没样式（真机踩过）。
  applyTheme(theme, false);
  if (api.themeState) api.themeState().then(function (t) { if (t) applyTheme(t, false); }).catch(function () {});
  if (api.onTheme) api.onTheme(function (t) { if (t) applyTheme(t, false); });

  // ---------- ② 菜单：请求主进程弹独立菜单小窗 ----------
  // 宿主窗只有 cfg.size 那么大（200×266 时自绘菜单必然盖住角色、位置也被夹死），
  // 所以菜单搬到主进程的独立小窗：这里只把「鼠标位置」请求过去，并附带本页主题状态。
  function requestMenu(x, y) {
    callHost('openMenu', {
      screenX: x, screenY: y,          // 屏幕坐标（独立窗口定位用）
      style: theme.style, color: theme.color
    });
  }
  // 右键：不拦截、不 preventDefault —— pet.js 那侧的路径照走，本页只负责请求菜单窗
  window.addEventListener('contextmenu', function (e) {
    requestMenu(e.screenX, e.screenY);
  });
  // 键盘：Windows 标准的「上下文菜单键」与 Shift+F10 也请求同一个菜单窗
  window.addEventListener('keydown', function (e) {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      requestMenu(e.screenX || 0, e.screenY || 0);
      return;
    }
    const k = (e.key || '').toLowerCase();
    // 退出
    if (e.ctrlKey && !e.altKey && k === 'q') {
      e.preventDefault();
      if (api.quit) api.quit();
    }
  });

  // ---------- 不影响鼠标（穿透） ----------
  // 主进程是唯一权威：这里只跟着它的推送改本页 class（穿透态下本页没有可点件）
  function setMouseThrough(on) {
    document.body.classList.toggle('mouse-through', !!on);
    console.log('[pet-ui] mouse-through=' + !!on);
  }
  if (api.onMouseThrough) api.onMouseThrough(setMouseThrough);
  if (api.mouseThroughState) api.mouseThroughState().then(setMouseThrough).catch(function () {});

  console.log('[pet-ui] ready · 主题=' + theme.style + ':' + theme.color + ' · 菜单=独立窗（本页只请求，不自绘）');
})();
