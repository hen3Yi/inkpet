import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformProportions } from '../live2d/proportions.mjs';

const opts = { sx: 1, sy: 1, headDy: 0, head: false,
  pivot: { x: 640, y: 800 }, neck: { x: 650, y: 500 }, ppu: 1280, ox: 640, oy: 640 };
const raw = (points) => new Float32Array(points.flatMap(([x, y]) => [(x - 640) / 1280, (640 - y) / 1280]));
const canvas = (v) => Array.from({ length: v.length / 2 }, (_, i) => [640 + v[i * 2] * 1280, 640 - v[i * 2 + 1] * 1280]);
function close(a, b) { a.flat().forEach((v, i) => assert.ok(Math.abs(v - b.flat()[i]) < 0.001, `${v} != ${b.flat()[i]}`)); }

test('比例复位保持顶点不变', () => {
  const points = [[400, 500], [700, 900]];
  const v = raw(points); transformProportions(v, opts); close(canvas(v), points);
});
test('横向与纵向缩放分别生效，胯部枢轴固定', () => {
  const v = raw([[640, 800], [740, 1000]]);
  transformProportions(v, { ...opts, sx: 1.6, sy: 0.6 });
  close(canvas(v), [[640, 800], [800, 920]]);
});
test('头跟随缩放后的颈根平移，保持头部大小；headDy 使用画布像素', () => {
  const body = raw([[650, 500]]), head = raw([[650, 500], [750, 400]]);
  const tune = { ...opts, sx: 1.6, sy: 0.6 };
  transformProportions(body, tune);
  transformProportions(head, { ...tune, head: true, headDy: 24 });
  const b = canvas(body)[0], h = canvas(head);
  close(h, [[b[0], b[1] + 24], [b[0] + 100, b[1] - 76]]);
});
test('头部下移独立于身体比例，可向上移动', () => {
  const v = raw([[650, 500]]);
  transformProportions(v, { ...opts, head: true, headDy: -80 });
  close(canvas(v), [[650, 420]]);
});
