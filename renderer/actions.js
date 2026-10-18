// 动作库（关键帧 + smoothstep 插值）——参数与结构照搬 Petra（github.com/Wumiu/Petra）的 src/live2d/actions.ts（MIT，Copyright (c) 2026 Wumiu(FengLing)，许可全文见 THIRD_PARTY.md）
// 通道对齐自研桌宠的 RigParams 子集：angleX/Y/Z（头三轴）、eyeX/Y（视线）、eyeOpenL/R（眼开合）、
// mouthOpen（嘴开）、irisScale（瞳缩放）、body（身体起伏）、armY（手臂高度 → handwear 层位移）
const smooth = (t) => t * t * (3 - 2 * t);

export const ACTIONS = [
  { id: 'nod', label: '点头', duration: 1.2, pool: 'low',
    keys: [{ t: 0, p: { angleY: 0 } }, { t: 0.5, p: { angleY: -1.0 } }, { t: 1, p: { angleY: 0 } }] },
  { id: 'shake', label: '摇头', duration: 1.1, pool: 'mid',
    keys: [{ t: 0, p: { angleX: 0 } }, { t: 0.25, p: { angleX: -1.0 } }, { t: 0.5, p: { angleX: 0 } },
           { t: 0.75, p: { angleX: 1.0 } }, { t: 1, p: { angleX: 0 } }] },
  { id: 'tilt', label: '歪头', duration: 1.0, pool: 'low',
    keys: [{ t: 0, p: { angleZ: 0 } }, { t: 0.5, p: { angleZ: -0.9 } }, { t: 1, p: { angleZ: 0 } }] },
  { id: 'lookAround', label: '张望', duration: 3.0, pool: 'low',
    keys: [
      { t: 0, p: { angleX: 0, angleY: 0, eyeX: 0, eyeY: 0 } },
      { t: 0.25, p: { angleX: 0.5, angleY: -0.2, eyeX: 0.5, eyeY: -0.15 } },
      { t: 0.5, p: { angleX: 0, angleY: 0, eyeX: 0, eyeY: 0 } },
      { t: 0.75, p: { angleX: -0.5, angleY: -0.2, eyeX: -0.5, eyeY: -0.15 } },
      { t: 1, p: { angleX: 0, angleY: 0, eyeX: 0, eyeY: 0 } }] },
  { id: 'lookSide', label: '左顾右盼', duration: 1.3, pool: 'mid',
    keys: [{ t: 0, p: { angleX: 0, eyeX: 0 } }, { t: 0.3, p: { angleX: 0.7, eyeX: 0.7 } },
           { t: 0.6, p: { angleX: -0.7, eyeX: -0.7 } }, { t: 1, p: { angleX: 0, eyeX: 0 } }] },
  { id: 'yawn', label: '打哈欠', duration: 2.5, pool: 'low',
    keys: [
      { t: 0, p: { mouthOpen: 0, eyeOpenL: 1, eyeOpenR: 1, angleY: 0 } },
      { t: 0.4, p: { mouthOpen: 1.2, eyeOpenL: 0.2, eyeOpenR: 0.2, angleY: -0.4 } },
      { t: 0.75, p: { mouthOpen: 0.9, eyeOpenL: 0.25, eyeOpenR: 0.25, angleY: -0.35 } },
      { t: 1, p: { mouthOpen: 0, eyeOpenL: 1, eyeOpenR: 1, angleY: 0 } }] },
  { id: 'stretch', label: '伸懒腰', duration: 2.2, pool: 'mid',
    keys: [{ t: 0, p: { body: 0, armY: 0 } }, { t: 0.4, p: { body: 0.45, armY: 1 } },
           { t: 0.7, p: { body: 0.45, armY: 1 } }, { t: 1, p: { body: 0, armY: 0 } }] },
  { id: 'happy', label: '开心跳', duration: 1.6, pool: 'mid',
    keys: [{ t: 0, p: { body: 0, armY: 0 } }, { t: 0.2, p: { body: 0.5, armY: 0.6 } },
           { t: 0.4, p: { body: -0.4, armY: 0 } }, { t: 0.6, p: { body: 0.5, armY: 0.6 } },
           { t: 0.8, p: { body: -0.4, armY: 0 } }, { t: 1, p: { body: 0, armY: 0 } }] },
  { id: 'surprised', label: '惊讶', duration: 1.4, pool: 'mid',
    keys: [
      { t: 0, p: { eyeOpenL: 1, eyeOpenR: 1, irisScale: 1, mouthOpen: 0.3, angleY: 0 } },
      { t: 0.35, p: { eyeOpenL: 1.08, eyeOpenR: 1.08, irisScale: 0.6, mouthOpen: 0.75, angleY: -0.35 } },
      { t: 0.75, p: { eyeOpenL: 1.08, eyeOpenR: 1.08, irisScale: 0.6, mouthOpen: 0.75, angleY: -0.35 } },
      { t: 1, p: { eyeOpenL: 1, eyeOpenR: 1, irisScale: 1, mouthOpen: 0.3, angleY: 0 } }] },
  { id: 'sleepy', label: '打盹', duration: 3.0, pool: 'low',
    keys: [{ t: 0, p: { eyeOpenL: 1, eyeOpenR: 1, body: 0, angleY: 0 } },
           { t: 0.3, p: { eyeOpenL: 0.35, eyeOpenR: 0.35, body: 0.15, angleY: -0.15 } },
           { t: 0.7, p: { eyeOpenL: 0.25, eyeOpenR: 0.25, body: 0.2, angleY: -0.2 } },
           { t: 1, p: { eyeOpenL: 1, eyeOpenR: 1, body: 0, angleY: 0 } }] },
  { id: 'sway', label: '摇摆', duration: 2.0, pool: 'low',
    keys: [{ t: 0, p: { body: 0, angleZ: 0 } }, { t: 0.25, p: { body: 1.0, angleZ: 0.5 } },
           { t: 0.5, p: { body: 0, angleZ: 0 } }, { t: 0.75, p: { body: -1.0, angleZ: -0.5 } },
           { t: 1, p: { body: 0, angleZ: 0 } }] },
];

export function findAction(id) { return ACTIONS.find((a) => a.id === id); }

export function pickPoolAction(level) {
  const allowed = level === 'low' ? ACTIONS.filter((a) => a.pool === 'low') : ACTIONS;
  if (!allowed.length) return null;
  return allowed[Math.floor(Math.random() * allowed.length)];
}

/** 按进度采样（关键帧之间 smoothstep 插值） */
export function sampleAction(action, progress) {
  const keys = action.keys;
  if (!keys.length) return {};
  if (progress <= keys[0].t) return { ...keys[0].p };
  if (progress >= keys[keys.length - 1].t) return { ...keys[keys.length - 1].p };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (progress >= a.t && progress <= b.t) {
      const span = (b.t - a.t) || 1;
      const local = smooth((progress - a.t) / span);
      const out = {};
      const ak = a.p, bk = b.p;
      const all = new Set([...Object.keys(ak), ...Object.keys(bk)]);
      for (const k of all) out[k] = (ak[k] ?? 0) + ((bk[k] ?? 0) - (ak[k] ?? 0)) * local;
      return out;
    }
  }
  return { ...keys[keys.length - 1].p };
}
