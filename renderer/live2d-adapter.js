// 桌宠 · Live2D 适配层（官方 Cubism framework 版）
//   目的：把官方后端包装成 pet.js 期望的 PsdRuntime 形状 —— 主循环 loop()、fit()、
//   hitTest()、事件绑定、服装/气泡/心跳那些代码**一行都不用改**，只在 boot() 里换载入那一段。
//
// 与 psd 骨骼的差异（刻意对齐，避免主循环分叉）：
//   - update(dtSec, ov)：ov.eyeOpenL/eyeOpenR → 取 min 写 ParamEye*Open（与 PsdRuntime 同语义）
//   - characterBounds / canvasWidth / canvasHeight：给 fit() 与 hitTest() 同一套口径
//   - layers / deform / fadeAlpha / BP / NP：PSD 专属，这里给**空壳**，让比例 hook 空转而不报错。
//     服装开关**另有出口**：setCloth(on) → 后端按 drawable 名压不透明度（2026-09-22 起可用）
//   - 画布缓冲区固定 = 模型原始尺寸（1280），不跟随 CSS 尺寸 ⇒ 与 PSD 同口径、无锯齿

// pet-live2d.js 由 npm run setup 用 live2d/driver.js + 你下载的官方 Cubism SDK for Web 的 Framework 打包出来（不随项目分发）
import { PetLive2D } from './vendor/live2d/pet-live2d.js';

const SHADER_PATH = './vendor/live2d/Shaders/WebGL/';

// ★ 爱心眼（heartfx）要的「层」代理：形状对齐 PSD 的 layers 约定（bn / side / base / cur / img），
//   数据换成官方 framework 的 drawable 顶点（模型坐标，与 PSD 的层顶点同一口径）。
//   cur 用 getter ⇒ heartfx 每帧读到的都是当前姿态的顶点，仿射拟合照旧成立。
function fxLayer(inner, name, bn, side) {
  return {
    name, bn, side,
    img: null, x: 0, y: 0,          // live2d 没有「层裁切图」⇒ heartfx 走顶点路径
    get base() { return inner.drawableBase(name); },
    get cur() { return inner.drawableVerts(name); },
  };
}
function makeFxLayers(inner) {
  return [
    fxLayer(inner, 'ArtMeshIridesL', 'irides', 'L'),
    fxLayer(inner, 'ArtMeshIridesR', 'irides', 'R'),
    fxLayer(inner, 'ArtMeshEyewhiteL', 'eyewhite', 'L'),
    fxLayer(inner, 'ArtMeshEyewhiteR', 'eyewhite', 'R'),
    fxLayer(inner, 'ArtMeshFrontHair', 'front hair', ''),
  ];
}

// opts.modelUrl / opts.rig 来自角色档案（characters/<id>.json，主进程经 pet:character-state 给）；
// rig 不给 = 驱动（live2d/driver.js）里的默认 rig
export async function createLive2DRuntime(canvas, opts = {}) {
  const log = opts.log || console.log;
  if (!opts.modelUrl) throw new Error('没有模型地址（角色档案的 model）');
  const inner = new PetLive2D(canvas, { shaderPath: SHADER_PATH, log, rig: opts.rig || null });
  await inner.load(opts.modelUrl);

  const cx = inner.pixelWidth / 2, cy = inner.pixelHeight / 2;
  // 爱心眼判「睁眼可见度」用（heartfx 读 rt.cur.eyeOpenL/R）；每帧在 update 里同步
  const curState = { eyeOpenL: 1, eyeOpenR: 1 };

  return {
    _inner: inner,
    live2d: true,
    canvasWidth: inner.pixelWidth,
    canvasHeight: inner.pixelHeight,
    characterBounds: inner.characterBounds(),
    // ★ 特效层代理（爱心眼）；PSD 专属的其余表面属性仍是空壳
    layers: makeFxLayers(inner),
    cur: curState,
    partsCount: 0,
    strandCount: 0,
    autoBlink: false,
    BP: { cx, cy },
    NP: { cx, cy },
    deform() { },
    fadeAlpha() { return 1; },

    update(dtSec, ov) {
      // ★ 画布缓冲区固定开成**模型原始尺寸**（1280×1280），CSS 尺寸那侧由 pet.js 的 fit() 管。
      //   这与 PSD 模式同一口径（psd-runtime 也是把 canvas.width 设成模型 CW/CH）：
      //   高分辨率缓冲区 + 缩小显示 ⇒ 天然抗锯齿。
      //   ⚠️ 踩过的坑（实测「锯齿太严重」）：这里原先写的是
      //   `canvas.width = canvas.clientWidth`（＝CSS 尺寸 ≈260px），而屏幕是 150% 缩放 ⇒
      //   等于把 260px 的图硬拉到 390 物理像素显示，边缘全是台阶。
      const pw = inner.pixelWidth, ph = inner.pixelHeight;
      if (pw > 0 && ph > 0 && (canvas.width !== pw || canvas.height !== ph)) {
        canvas.width = pw; canvas.height = ph;
      }
      // ★ 指针追随：主循环算好的「全屏鼠标 → 视线」（ov.eyeX/eyeY ∈ -1..1）转交后端，
      //   后端映射到 ParamAngleX/Y（摆头）＋ ParamEyeBallX/Y（转眼球）；物理读同一批参数
      //   ⇒ 前发/后发自己摆起来，不需要在主循环里写任何摆动。
      if (ov) {
        inner.setPointer(ov.eyeX, ov.eyeY);
        // ★ 摇晃 / 拖拽摆动：口径照搬 PSD 主循环（body ±1、angleZ ±0.35、bodySwing ±1.5）
        inner.setMotion(ov.body, ov.angleZ, ov.bodySwing, ov.dragVelX);
        // ★ 连续口型（2026-09-22）：主循环按播放音量算出的 ov.mouthOpen（0~1）直写 ParamMouthOpenY
        if (typeof ov.mouthOpen === 'number') inner.setMouthOpen(ov.mouthOpen);
      }
      const l = (ov && typeof ov.eyeOpenL === 'number') ? ov.eyeOpenL : 1;
      const r = (ov && typeof ov.eyeOpenR === 'number') ? ov.eyeOpenR : 1;
      curState.eyeOpenL = l; curState.eyeOpenR = r;   // ★ 爱心眼判「睁眼可见度」读的就是它
      inner.setEyeOpen(Math.min(l, r));
      inner.update(dtSec * 1000);
      inner.draw();
    },

    /** ★ 口型（live2d 模式）：'smile' 平时｜'triangle' 点击/拖拽｜'open' 语音 —— **必须转发**，
     *  漏了这层 pet.js 的 rt.setMouth 就是 undefined、会被 if 静默跳过。 */
    setMouth(mode) { inner.setMouth(mode); },

    /** ★ 连续口型（0~1）：音量驱动唇动；0 ⇒ 回到 setMouth 的枚举口径 */
    setMouthOpen(v) { if (inner.setMouthOpen) inner.setMouthOpen(v); },

    /** ★ 服装开关（live2d 模式）：{ topwear:true, bottomwear:false, ... } */
    setCloth(on) { inner.setClothMask(on || null); },

    /** ★ 面板「呼吸 / 摇晃」＋「视线追随」两组：呼吸周期/幅度、头/眼追随灵敏度
     *  （摇晃那三项由主循环的 ov 直接带过来，不用另设） */
    setTune(t) {
      if (!t) return;
      inner.setBreath(t.breathPeriod, t.breathAmp);
      inner.setFollow(t.headFollow, t.eyeFollow);
      inner.setDragTilt(t.dragTilt);
      inner.setDragBody(t.dragBody);
      inner.setLimbArm(t.limbArm);   // ★ 手臂摆幅倍率（面板「四肢摆动」组）
    },

    /** ★ 额外参数（尾巴 ParamTailWag 等）：-1..1；模型里没有就不写 */
    setExtra(name, v) { inner.setExtra(name, v); },
    /** 模型里有没有这个参数（有尾巴的角色才有 ParamTailWag） */
    hasParam: (name) => inner.pIdx[name] !== undefined,
    /** ★ 抖耳朵（档案 rig.ears 为空的角色什么都不做） */
    earTwitch() { inner.earTwitch(); },
    hasEars: () => inner.rig.ears.length > 0,
    /** ★ 点到了哪儿：模型画布坐标 → 'head' | 'tail' | … | 'body' | null */
    hitPart: (x, y) => inner.hitPart(x, y),

    probe: () => inner.probe(),
    release: () => inner.release(),
  };
}
