import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startPos, menuPos, besidePos } = require('../src/window-pos.js');

// 150% 缩放的 4K 主屏（DIP 2560×1440，任务栏 48）+ 左边一块 1080p 副屏
const primary = { x: 0, y: 0, width: 2560, height: 1392 };
const left = { x: -1920, y: 0, width: 1920, height: 1040 };

test('startPos: 没记过位置就放主屏右下角', () => {
  assert.deepEqual(startPos(null, 280, 358, [primary, left], primary), { x: 2560 - 280 - 30, y: 1392 - 358 - 10 });
});

test('startPos: 记过的位置还在某块屏幕上就放回去（副屏的负坐标也算）', () => {
  assert.deepEqual(startPos({ x: 100, y: 200 }, 280, 358, [primary, left], primary), { x: 100, y: 200 });
  assert.deepEqual(startPos({ x: -1500, y: 300 }, 280, 358, [primary, left], primary), { x: -1500, y: 300 });
});

test('startPos: 记过的位置已经不在任何屏幕上（拔掉了副屏）就回主屏右下角', () => {
  assert.deepEqual(startPos({ x: -1500, y: 300 }, 280, 358, [primary], primary), { x: 2250, y: 1024 });
  assert.deepEqual(startPos({ x: NaN, y: 3 }, 280, 358, [primary], primary), { x: 2250, y: 1024 });
});

test('menuPos: 鼠标在中间就从鼠标处弹出，靠右下角就翻到左上', () => {
  assert.deepEqual(menuPos({ x: 500, y: 400 }, 220, 300, primary), { x: 500, y: 400 });
  assert.deepEqual(menuPos({ x: 2500, y: 1300 }, 220, 300, primary), { x: 2280, y: 1000 });
});

test('menuPos: 副屏上按副屏的工作区夹取', () => {
  assert.deepEqual(menuPos({ x: -100, y: 1000 }, 220, 300, left), { x: -320, y: 700 });
});

test('besidePos: 优先放右边，放不下放左边，底边对齐', () => {
  const pet = { x: 1000, y: 800, width: 280, height: 358 };
  assert.deepEqual(besidePos(pet, 420, 560, primary), { x: 1288, y: 598 });
  const atRight = { x: 2250, y: 1024, width: 280, height: 358 };
  assert.deepEqual(besidePos(atRight, 420, 560, primary), { x: 2250 - 420 - 8, y: 1024 + 358 - 560 });
});
