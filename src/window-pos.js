// 窗口摆放：都是纯函数，坐标一律是 DIP（Electron 的 screen API 和 setBounds 用的都是 DIP），
// workArea = 某块屏幕去掉任务栏后的矩形 {x, y, width, height}（副屏的 x / y 可能是负数）。
'use strict';

function inside(a, x, y) {
  return x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height;
}

// 启动位置：上次的位置还在某块屏幕的工作区里（窗口中心落在里面）就放回去，否则放主屏右下角
function startPos(saved, w, h, workAreas, primary) {
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    if (workAreas.some((a) => inside(a, saved.x + w / 2, saved.y + h / 2))) return { x: Math.round(saved.x), y: Math.round(saved.y) };
  }
  return {
    x: Math.round(Math.max(primary.x, primary.x + primary.width - w - 30)),
    y: Math.round(Math.max(primary.y, primary.y + primary.height - h - 10)),
  };
}

// 右键菜单：从鼠标处弹出；右边 / 下边放不下就翻到鼠标的左边 / 上边，整个菜单留在工作区里
function menuPos(pt, w, h, a) {
  let x = pt.x;
  let y = pt.y;
  if (x + w > a.x + a.width - 4) x = Math.max(a.x + 4, x - w);
  if (y + h > a.y + a.height - 4) y = Math.max(a.y + 4, y - h);
  y = Math.max(a.y + 4, Math.min(y, a.y + a.height - h - 4));
  return { x: Math.round(x), y: Math.round(y) };
}

// 控制中心：贴在桌宠右边（放不下就放左边），底边对齐，间隔 8 px
function besidePos(b, w, h, a) {
  let x = b.x + b.width + 8;
  if (x + w > a.x + a.width - 8) x = b.x - w - 8;
  if (x < a.x + 8) x = Math.max(a.x + 8, Math.min(a.x + a.width - w - 8, b.x));
  const y = Math.max(a.y + 8, Math.min(a.y + a.height - h - 8, b.y + b.height - h));
  return { x: Math.round(x), y: Math.round(y) };
}

module.exports = { startPos, menuPos, besidePos };
