// 桌宠 · Live2D 驱动（官方 Cubism Web Framework 版）
//   加载 / 驱动 / 绘制一只 Live2D 模型：指针追随、呼吸、眨眼由调用方（renderer/pet.js）给参数，
//   拖拽时身体绕脖子转、四肢 / 衣摆弹簧摆动、口型、服装开关、命中分区这些「跟着模型走」的设定在 rig 里
//   （角色档案 characters/<id>.json 的 rig 段，没给就用下面的 DEFAULT_RIG）。
//
// 依据：CubismSdkForWeb-5-r.5 / Samples/TypeScript/Demo/src/lappmodel.ts 的关键流程
//   renderer.startUp(gl) → renderer.loadShaders(path) → setMvpMatrix + setRenderState + drawModel
//   CubismMoc.create(buffer, checkMocConsistency=false)：PSD2Live 生成的 moc3 过不了官方一致性校验，必须关
//
// 这个文件不含任何 Live2D 的代码；@framework 指向你自己下载的 Cubism SDK for Web 的 Framework/src，
// 由 scripts/build-live2d.mjs（npm run setup 会调用）打包成 renderer/vendor/live2d/pet-live2d.js。

import { CubismFramework } from '@framework/live2dcubismframework';
import { CubismMoc } from '@framework/model/cubismmoc';
import { CubismModelSettingJson } from '@framework/cubismmodelsettingjson';
import { CubismRenderer_WebGL } from '@framework/rendering/cubismrenderer_webgl';
import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { CubismModelMatrix } from '@framework/math/cubismmodelmatrix';
import { CubismPhysics } from '@framework/physics/cubismphysics';
import { CubismEyeBlink } from '@framework/effect/cubismeyeblink';
import { CubismShader_WebGL } from '@framework/rendering/cubismshader_webgl';
import { CubismDefaultParameterId } from '@framework/cubismdefaultparameterid';

// ★ 2026-10-17 多角色：部件名、枢轴、口型这些「跟着模型走」的设定收进 rig（角色档案 characters/<id>.json 的 rig 段，
//   由 opts.rig 传进来）。没给 rig 就用下面这些默认值（PSD2Live 生成的模型的部件名，多数模型通用）。
var CLOTH_DRAWABLES = {
  topwear: ["ArtMeshTopwear", "ArtMeshTopwear2", "ArtMeshLayerL", "ArtMeshLayerR"],
  bottomwear: ["ArtMeshBottomwear"],
  socks: ["ArtMeshLayer2"],
  // ★ 实测（嘴层回到语义名后又挪位：Layer5→Layer2）
  footwear: ["ArtMeshFootwear"]
};
var POINTER_PARAMS = [
  "ParamAngleX",
  "ParamAngleY",
  "ParamEyeBallX",
  "ParamEyeBallY",
  "ParamAngleZ",
  "ParamBodyAngleX",
  "ParamBodyAngleZ",
  "ParamBreath",
  "ParamMouthOpenY"
  // ★ 张嘴层的姿态参数（嘴是语义层）——不缓存索引就写不了
];
var FX_DRAWABLES = ["ArtMeshIridesL", "ArtMeshIridesR", "ArtMeshEyewhiteL", "ArtMeshEyewhiteR", "ArtMeshFrontHair"];
var BODY_DRAWABLES = [
  "ArtMeshLayer",
  // body（实测：Layer4→Layer）
  "ArtMeshTopwear",
  "ArtMeshTopwear2",
  "ArtMeshLayerL",
  "ArtMeshLayerR",
  // topwear / topwear_back / sleeve_l / sleeve_r
  "ArtMeshBottomwear",
  // bottomwear
  "ArtMeshLayer2",
  // socks（退化名，实测：Layer5→Layer2）
  "ArtMeshFootwear",
  // footwear
  "ArtMeshLegwear",
  // legs
  "ArtMeshHandwearL",
  "ArtMeshHandwearR",
  // arm_l / arm_r
  "ArtMeshNeck"
  // ★ neck —— 2026-09-22 实测「身体会和脖子分离」：
  //   脖子原来不在名单里（照 PSD 口径排除），live2d 上身体一转它不动 ⇒ 接缝裂
];
var HEAD_DRAWABLES = [
  "ArtMeshFace",
  "ArtMeshEyewhiteL",
  "ArtMeshEyewhiteR",
  "ArtMeshIridesL",
  "ArtMeshIridesR",
  "ArtMeshEyelashL",
  "ArtMeshEyelashR",
  "ArtMeshEyeCloseL",
  "ArtMeshEyeCloseR",
  "ArtMeshEyebrowL",
  "ArtMeshEyebrowR",
  "ArtMeshMouth",
  "ArtMeshMouthOpen",
  "ArtMeshMouthClose",
  "ArtMeshFrontHair",
  "ArtMeshBackHair",
  "ArtMeshEars"
];
var MOUTH_DRAWABLES = {
  smile: "ArtMeshMouth",
  // mouth（平时）
  open: "ArtMeshMouthOpen",
  // mouth open（语音接入后用；现在只留接口）
  triangle: "ArtMeshMouthClose"
  // mouth close（点击 / 拖拽时）
};
var MOUTH_FORCE_VISIBLE = "";
var CREASE_DRAWABLE = "";
var MOUTH_FOLLOW_AFFINE = false;
var EYELASH_DRAWABLES = { L: "ArtMeshEyelashL", R: "ArtMeshEyelashR" };
var SWING_GAIN = 0.35;
var LIMB_SWING = [
  { key: "armL", draws: ["ArtMeshHandwearL"], root: [675, 725], tip: [866, 987], gain: 0.46, K: 300, C: 14, u0: 0.2 },
  { key: "armR", draws: ["ArtMeshHandwearR"], root: [606, 725], tip: [413, 987], gain: 0.46, K: 300, C: 14, u0: 0.2 },
  { key: "slvL", draws: ["ArtMeshLayerL"], root: [675, 725], tip: [866, 987], gain: 0.4, K: 300, C: 14, u0: 0.2 },
  { key: "slvR", draws: ["ArtMeshLayerR"], root: [606, 725], tip: [413, 987], gain: 0.4, K: 300, C: 14, u0: 0.2 },
  { key: "legs", draws: ["ArtMeshLegwear", "ArtMeshLayer2", "ArtMeshFootwear"], root: [639, 928], tip: [639, 1239], gain: 0.41, K: 250, C: 15 },
  { key: "skirt", draws: ["ArtMeshBottomwear"], root: [639, 910], tip: [639, 1043], gain: 0.26, K: 210, C: 12 },
  { key: "neck", draws: ["ArtMeshNeck"], root: [639, 711], tip: [639, 643], gain: 0.14, K: 340, C: 19 }
];
var LIMB_MAX = 1.05;
var BASE_BODY = 1;
var BASE_ANGLE_Z = 0.35;
var BASE_SWING = 1.5;
var clamp1 = (v) => v > 1 ? 1 : v < -1 ? -1 : v;
var DEFAULT_RIG = {
  cloth: CLOTH_DRAWABLES,
  fx: FX_DRAWABLES,
  body: BODY_DRAWABLES,
  head: HEAD_DRAWABLES,
  neck: "ArtMeshNeck",
  face: "ArtMeshFace",
  mouth: MOUTH_DRAWABLES,
  // ParamMouthOpenY 怎么给：replace = 原来的口径（有音量就直写音量，没有就 triangle 0 / 其余 1）；
  //   max = 只有一张嘴的模型（苏墨）：平时 / 点击 / 说话各给一个张开度，音量映射到 [lo, hi] 后和它取大，smooth > 0 时做低通
  mouthParam: { mix: "replace", smile: 1, open: 1, triangle: 0, lo: 0, hi: 1, smooth: 0 },
  // 嘴的绘制顺序挪到眉毛和前发之间（有的模型嘴层排序靠后才需要；没有眉毛 / 前发就不动）
  mouthOrder: true,
  mouthForceVisible: MOUTH_FORCE_VISIBLE,
  crease: CREASE_DRAWABLE,
  mouthFollowAffine: MOUTH_FOLLOW_AFFINE,
  eyelash: EYELASH_DRAWABLES,
  swingGain: SWING_GAIN,
  // 拖动时身体绕脖子转，头组只转 dragTilt 那么多；这里列的头组部件按 root→tip 的轴越往下越跟身体转：[{ draw, root, tip, u0 }]
  swingFollow: [],
  limbs: LIMB_SWING,
  // 手臂摆幅滑条（limbArm）管哪几条肢体
  armKeys: ["armL", "armR", "slvL", "slvR"],
  // 抖耳朵：[{ draw, root:[x,y], tip:[x,y], dir: ±1, gain, u0 }]（画布坐标；跟头动由耳朵自己的形变仿射带着走）
  ears: [],
  // 除了 POINTER_PARAMS 以外要写的模型参数（如苏墨的 ParamTailWag），setExtra(name, v) 给值（-1..1 映射到参数范围）
  extraParams: [],
  // 点击分区：head / tail 两组部件，front = 挡在尾巴前面的部件（点到它们就不算点尾巴）
  hit: { head: [], tail: [], front: [] }
};
function makeRig(r) {
  const o = Object.assign({}, DEFAULT_RIG, r || {});
  o.mouthParam = Object.assign({}, DEFAULT_RIG.mouthParam, r && r.mouthParam || {});
  o.hit = Object.assign({ head: [], tail: [], front: [] }, r && r.hit || {});
  for (const k of ["fx", "body", "head", "limbs", "armKeys", "ears", "extraParams", "swingFollow"]) if (!Array.isArray(o[k])) o[k] = DEFAULT_RIG[k];
  return o;
}
var frameworkReady = false;
function ensureFramework(log) {
  if (frameworkReady) return;
  CubismFramework.startUp();
  CubismFramework.initialize();
  frameworkReady = true;
  log("live2d(official): framework ready");
}
async function fetchArrayBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("fetch " + url + " -> " + res.status);
  return await res.arrayBuffer();
}
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed: " + url));
    img.src = url;
  });
}
export class PetLive2D {
  constructor(canvas, opts = {}) {
    this.canvas = undefined;
    this.gl = undefined;
    this.ready = (false);
    this.model = (null);
    this.moc = (null);
    this.renderer = (null);
    this.setting = (null);
    this.modelMatrix = (null);
    this.mvp = (new CubismMatrix44());
    this.physics = (null);
    this.eyeBlink = (null);
    this.shaderPath = undefined;
    this.log = undefined;
    /** 画布尺寸（像素，1280）：给 pet.js 的 fitView 用 */
    this.canvasWidth = (0);
    this.canvasHeight = (0);
    /** 画布尺寸（unit，官方语义 = 像素/PixelsPerUnit）：给 CubismModelMatrix 用 */
    this.unitWidth = (1);
    this.unitHeight = (1);
    this.pixelWidth = (1280);
    this.pixelHeight = (1280);
    /** canvasinfo 的换算参数：顶点 unit → 画布坐标（爱心眼等特效层用） */
    this.pixelsPerUnit = (1280);
    this.canvasOriginX = (640);
    this.canvasOriginY = (640);
    /** 由外部驱动的眼睛开合（null = 不干预） */
    this.eyeOpenOverride = (null);
    /** 由外部驱动的身体左右摆（度） */
    this.bodyAngleZ = (0);
    /** 统计 */
    this.frames = (0);
    // ★ 指针追随：-1..1，由 pet.js 的「全屏鼠标 → 视线」（ov.eyeX/eyeY）给。
    //   喂给模型后：ParamAngleX/Y 摆头、ParamEyeBallX/Y 转眼球；而物理的输入正是 ParamAngleX/Z
    //   ⇒ 头一动，前发/后发由 physics.evaluate 自己摆 —— 不用手写任何摆动。
    this.pointerX = (0);
    this.pointerY = (0);
    /** 平滑后的当前值（一阶低通，防鼠标瞬移时头猛甩） */
    this.curAngleX = (0);
    this.curAngleY = (0);
    this.curEyeBallX = (0);
    this.curEyeBallY = (0);
    /** 参数索引与上下限缓存（name → 值） */
    this.pIdx = ({});
    this.pMin = ({});
    this.pMax = ({});
    this.pDef = ({});
    /** drawable 名 → 索引缓存（服装开关用） */
    this.dIdx = ({});
    /** ★ 服装开关（null = 不干预）：{ topwear:false } 表示「上衣脱掉」 */
    this.clothMask = (null);
    // ★ 摇晃 / 拖拽摆动（2026-09-22）：口径照搬 PSD 主循环的 ov.body / ov.angleZ / ov.bodySwing
    this.motionBody = (0);
    this.motionAngleZ = (0);
    this.motionBodySwing = (0);
    /** 摆动的平滑当前值（PSD 内核同款 dt*14 低通；不做平滑会在拖拽起止时「立正」突跳） */
    this.curAngZ = (0);
    this.curBodyX = (0);
    this.curBodyZ = (0);
    /** ★ 追随灵敏度（面板「视线追随」组，0~2 倍；默认 1.0 = 与最初口径一致） */
    this.headFollow = (1);
    this.eyeFollow = (1);
    /** ★ 拖拽时头部跟随倾斜的比例（**默认 0 = 头不动**；要「头不动、身体绕脖子转」） */
    this.dragTilt = (0);
    /** ★ 拖拽时身体摆幅倍数（0 = 身体不动、1 = PSD 口径满幅；面板可调） */
    this.dragBody = (1);
    /** ★ 手臂（含袖子）摆动幅度倍率（面板可调）——照搬 PSD 的 LIMB_CFG gain(0.46) 在 live2d 上甩得太大，
     *  实测「拖拽时手臂摆动幅度太大 / 看着像袖子跟手分离」⇒ 默认缩到 0.5。 */
    this.limbArm = (1);
    /** 平滑后的拖拽摆动量（PSD 口径 ±1.5）与身体旋转枢轴（画布坐标 = 脖子中心） */
    this.curSwing = (0);
    this.bodyPivot = (null);
    /** ★ 四肢各自的弹簧状态 { a: 角度值, v: 角速度 } 与根部枢轴（画布坐标） */
    this.limbState = ({});
    /** 枢轴：x/y = 根部（旋转中心），tx/ty = 骨轴另一头（算权重衰减用） */
    this.limbPivot = ({});
    /** ★ 拖拽速度（口径＝PSD 的 limTgt：dragVX / LIMB_VREF，±1）——四肢弹簧的驱动量 */
    this.motionDragVelX = (0);
    /** ★ 口型模式：'smile'（平时）｜'triangle'（点击/拖拽）｜'open'（语音） */
    this.mouthMode = ("smile");
    this.mouthOpenV = (0);   // ★ 连续口型：来自播放音量的 0~1（0 = 用枚举三态）
    /** ★ drawable 默认姿态顶点快照（爱心眼要拿它当 base 做仿射拟合） */
    this.dBase = ({});
    // ★ 呼吸：周期/幅度面板可调（ParamBreath 是模型自带的呼吸参数）
    this.breathT = (0);
    this.breathPeriod = (3.4);
    this.breathAmp = (1);
    /** ★ 角色档案里的 rig（部件名 / 枢轴 / 口型 / 抖耳 / 点击分区），见 DEFAULT_RIG */
    this.rig = (null);
    /** ★ 额外参数（如 ParamTailWag）：name → -1..1，每帧写进模型 */
    this.extra = ({});
    /** ★ 单嘴模型（mouthParam.mix = max）平滑后的 ParamMouthOpenY；null = 还没写过 */
    this.curMouth = (null);
    /** ★ 抖耳计时（秒）；< 0 = 没在抖 */
    this.earT = (-1);
    /** 自己建的贴图（换角色 release 时删掉，同一块画布的 GL 上下文是共用的） */
    this.textures = ([]);
    this.canvas = canvas;
    this.log = opts.log || ((s) => console.log(s));
    this.rig = makeRig(opts.rig);
    this.shaderPath = opts.shaderPath || "./vendor/live2d/Shaders/WebGL/";
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true }) || canvas.getContext("experimental-webgl", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL \u4E0D\u53EF\u7528");
    this.gl = gl;
    this.gl.clearColor(0, 0, 0, 0);
    ensureFramework(this.log);
  }
  /** 加载模型：model3.json 的 URL；贴图/物理按 manifest 里的相对路径解析 */
  async load(modelJsonUrl) {
    // ★ 2026-10-17：地址带 ?v=…（模型刚重新生成过）⇒ moc3 / 物理 / 贴图都带上同一个 ?v=，绕开缓存
    const qAt = modelJsonUrl.indexOf("?");
    const q = qAt >= 0 ? modelJsonUrl.slice(qAt) : "";
    const path0 = qAt >= 0 ? modelJsonUrl.slice(0, qAt) : modelJsonUrl;
    const base = path0.slice(0, path0.lastIndexOf("/") + 1);
    const jsonBuf = await fetchArrayBuffer(modelJsonUrl);
    this.setting = new CubismModelSettingJson(jsonBuf, jsonBuf.byteLength);
    const mocName = this.setting.getModelFileName();
    const mocBuf = await fetchArrayBuffer(base + mocName + q);
    this.log("live2d(official): moc3 " + mocName + " (" + mocBuf.byteLength + " bytes)");
    this.moc = CubismMoc.create(mocBuf, false);
    if (!this.moc) throw new Error("CubismMoc.create \u5931\u8D25");
    this.model = this.moc.createModel();
    if (!this.model) throw new Error("createModel \u5931\u8D25");
    this.model.saveParameters();
    let ci = null;
    try {
      ci = this.model.getModel ? this.model.getModel().canvasinfo : null;
    } catch (e) {
    }
    this.unitWidth = this.model.getCanvasWidth();
    this.unitHeight = this.model.getCanvasHeight();
    this.pixelWidth = ci && ci.CanvasWidth ? ci.CanvasWidth : 1280;
    this.pixelHeight = ci && ci.CanvasHeight ? ci.CanvasHeight : 1280;
    this.pixelsPerUnit = ci && ci.PixelsPerUnit ? ci.PixelsPerUnit : 1280;
    this.canvasOriginX = ci && ci.CanvasOriginX ? ci.CanvasOriginX : this.pixelWidth / 2;
    this.canvasOriginY = ci && ci.CanvasOriginY ? ci.CanvasOriginY : this.pixelHeight / 2;
    this.canvasWidth = this.pixelWidth;
    this.canvasHeight = this.pixelHeight;
    this.log("canvasinfo: " + JSON.stringify(ci) + "  unit=" + this.unitWidth + "x" + this.unitHeight);
    this.modelMatrix = new CubismModelMatrix(this.unitWidth, this.unitHeight);
    try {
      const layout = /* @__PURE__ */ new Map();
      if (this.setting.getLayoutMap(layout)) this.modelMatrix.setupFromLayout(layout);
    } catch (e) {
      this.log("layout skipped: " + e.message);
    }
    const physName = this.setting.getPhysicsFileName();
    if (physName) {
      try {
        const physBuf = await fetchArrayBuffer(base + physName + q);
        this.physics = CubismPhysics.create(physBuf);
        if (this.physics) {
          this.physics.initialize(this.model);
          this.log("live2d(official): physics ok");
        }
      } catch (e) {
        this.log("physics skipped: " + e.message);
      }
    }
    try {
      this.eyeBlink = CubismEyeBlink.create(this.setting);
    } catch (e) {
      this.eyeBlink = null;
    }
    this.renderer = new CubismRenderer_WebGL();
    this.renderer.initialize(this.model);
    this.renderer.setIsPremultipliedAlpha(true);
    this.renderer.startUp(this.gl);
    this.renderer.loadShaders(this.shaderPath);
    this.renderer.setMvpMatrix(this.mvp);
    const texCount = this.setting.getTextureCount();
    this.log("gl: MAX_TEXTURE_SIZE=" + this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) + " MAX_CUBE=" + this.gl.getParameter(this.gl.MAX_CUBE_MAP_TEXTURE_SIZE) + " err=" + this.gl.getError());
    for (let i = 0; i < texCount; i++) {
      const name = this.setting.getTextureFileName(i);
      if (!name) continue;
      const img = await loadImage(base + name + q);
      const tex = this.gl.createTexture();
      this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
      this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      try {
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, img);
      } catch (e) {
        this.log("\u2717 texImage2D[" + i + "] " + e.message);
      }
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
      this.renderer.bindTexture(i, tex);
      this.textures.push(tex);
      this.log("tex[" + i + "] " + name + " img=" + img.width + "x" + img.height + " isTex=" + this.gl.isTexture(tex) + " err=" + this.gl.getError());
    }
    this.log("live2d(official): textures bound " + texCount);
    const R = this.rig;
    for (const n of POINTER_PARAMS) this.cacheParam(n);
    for (const n of R.extraParams) this.cacheParam(n);
    try {
      const core = this.model.getModel();
      const ids = core.drawables.ids;
      const all = /* @__PURE__ */ new Set();
      for (const k in R.cloth) for (const n of R.cloth[k]) all.add(n);
      for (const n of R.fx) all.add(n);
      for (const n of R.body) all.add(n);
      for (const n of R.head) all.add(n);
      all.add(R.neck);
      for (const cfg of R.limbs) for (const n of cfg.draws) all.add(n);
      for (const k in R.mouth) all.add(R.mouth[k]);
      if (R.crease) all.add(R.crease);
      if (R.mouthForceVisible) all.add(R.mouthForceVisible);
      all.add(R.face);
      for (const k in R.eyelash) all.add(R.eyelash[k]);
      for (const e of R.ears) all.add(e.draw);
      for (const g in R.hit) for (const n of R.hit[g]) all.add(n);
      // applyMouth 排嘴的绘制顺序要用眉毛和前发
      all.add("ArtMeshEyebrowL");
      all.add("ArtMeshEyebrowR");
      all.add("ArtMeshFrontHair");
      for (const n of all) {
        const i = ids.indexOf(n);
        if (i >= 0) this.dIdx[n] = i;
      }
      // \u2605 autoCloth \u91CC\u8981\u9690\u85CF\u7684\u7F51\u683C\u4E5F\u5FC5\u987B\u8FDB\u7D22\u5F15\u8868\uFF0C
      //   \u5426\u5219 applyClothMask \u62FF\u4E0D\u5230\u4E0B\u6807\u3001\u9759\u9ED8\u5931\u6548\uFF08\u65B0\u589E\u81EA\u52A8\u8054\u52A8\u65F6\u6700\u5BB9\u6613\u6F0F\u7684\u4E00\u6B65\uFF09
      if (Array.isArray(R.autoCloth)) {
        for (const rule of R.autoCloth) {
          if (!rule || !Array.isArray(rule.hide)) continue;
          for (const n of rule.hide) {
            if (this.dIdx[n] !== void 0) continue;
            const i = ids.indexOf(n);
            if (i >= 0) this.dIdx[n] = i;
            else this.log("autoCloth \u7F3A\u7F51\u683C: " + n);
          }
        }
      }
      const miss = [...all].filter((n) => !(n in this.dIdx));
      this.log("live2d(official): cloth drawables " + JSON.stringify(this.dIdx) + (miss.length ? "  \u7F3A: " + miss.join(",") : ""));
      // \u2605 2026-10-17 \u4E3B\u4EBA\u8981\u300C\u6709\u978B\u5B50\u65F6\u9690\u85CF\u811A\u90E8\u56FE\u5C42\u300D\uFF1A\u5148\u91CF\u4E24\u5F20\u817F\u56FE\uFF08legwear=ArtMeshLegwear2 / legwear_2=ArtMeshLegwear\uFF09\u5404\u81EA\u7684\u5305\u56F4\u76D2\uFF0C
      //   \u624D\u77E5\u9053\u54EA\u5F20\u662F\u300C\u817F\u300D\u3001\u54EA\u5F20\u662F\u300C\u811A\u300D\u3002\u6253\u4E00\u6B21\u65E5\u5FD7\u5C31\u591F\uFF08\u770B renderer.log \u7684 legwear bbox \u884C\uFF09\u3002
      for (const nm of ["ArtMeshLegwear", "ArtMeshLegwear2", "ArtMeshFootwear"]) {
        const i = this.dIdx[nm];
        if (i === void 0) continue;
        try {
          const v = core.drawables.vertexPositions[i];
          let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
          for (let k = 0; k < v.length; k += 2) {
            if (v[k] < x0) x0 = v[k];
            if (v[k] > x1) x1 = v[k];
            if (v[k + 1] < y0) y0 = v[k + 1];
            if (v[k + 1] > y1) y1 = v[k + 1];
          }
          this.log("legwear bbox " + nm + " x " + x0.toFixed(1) + "->" + x1.toFixed(1) + "  y " + y0.toFixed(1) + "->" + y1.toFixed(1));
        } catch (e) { this.log("legwear bbox fail " + nm + ": " + e.message); }
      }
      // \u2605 2026-10-17\uFF1A\u6A21\u578B\u91CC\u6709\u95ED\u5634\u753B\u5143\uFF08PSD \u7684 mouth close\uFF1APSD2Live \u8BA9\u5B83\u968F ParamMouthOpenY \u6DE1\u51FA\u3001\u5F20\u5F00\u7684\u5634\u538B\u6210\u4E00\u6761\u7F1D\uFF09
      //   \u21D2 \u6362\u7528\u6863\u6848\u91CC mouthParamWithClose \u7684\u53E3\u578B\u6863\u4F4D\uFF08\u5E73\u65F6\u95ED\u5634\u3001\u8BF4\u8BDD\u5F20\u5634\uFF09\uFF1B\u6CA1\u6709\u5C31\u7167\u65E7\u7528 mouthParam
      if (R.mouthParamWithClose && ids.indexOf(R.mouthCloseDraw || "ArtMeshMouthClose") >= 0) {
        R.mouthParam = Object.assign({}, R.mouthParam, R.mouthParamWithClose);
        this.log("live2d(official): mouth close found -> " + JSON.stringify(R.mouthParam));
      }
    } catch (e) {
      this.log("cloth idx skipped: " + e.message);
    }
    this.log("live2d(official): pointer params " + POINTER_PARAMS.concat(R.extraParams).map((n) => n + "=" + (this.pIdx[n] === void 0 ? "x" : this.pMin[n] + "~" + this.pMax[n])).join(" "));
    try {
      this.model.update();
    } catch (e) {
    }
    const needBase = /* @__PURE__ */ new Set([...R.fx, ...R.body, R.neck, R.face]);
    if (R.crease) needBase.add(R.crease);
    for (const k in R.eyelash) needBase.add(R.eyelash[k]);
    for (const k in R.mouth) needBase.add(R.mouth[k]);
    for (const cfg of R.limbs) for (const n of cfg.draws) needBase.add(n);
    for (const e of R.ears) needBase.add(e.draw);
    try {
      for (const n of needBase) {
        const v = this.drawableVerts(n);
        if (v && v.length >= 6) this.dBase[n] = new Float32Array(v);
      }
      this.log("live2d(official): fx drawables " + R.fx.map((n) => n + "=" + (this.dBase[n] ? (this.dBase[n].length >> 1) + "v" : "x")).join(" "));
    } catch (e) {
      this.log("fx base skipped: " + e.message);
    }
    try {
      const neck = this.drawableVerts(R.neck);
      if (neck && neck.length >= 6) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let k = 0; k < neck.length; k += 2) {
          const x = neck[k], y = neck[k + 1];
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        this.bodyPivot = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
      }
      this.log("live2d(official): body pivot " + (this.bodyPivot ? JSON.stringify(this.bodyPivot) : "x") + "  bodyDrawables=" + R.body.filter((n) => this.dIdx[n] !== void 0).length + "/" + R.body.length);
    } catch (e) {
      this.log("body pivot skipped: " + e.message);
    }
    try {
      for (const cfg of R.limbs) {
        this.limbPivot[cfg.key] = {
          x: cfg.root[0],
          y: cfg.root[1],
          tx: cfg.tip[0],
          ty: cfg.tip[1]
        };
        this.limbState[cfg.key] = { a: 0, v: 0 };
      }
      this.log("live2d(official): limb pivots " + R.limbs.map((c) => c.key + "=" + (this.limbPivot[c.key] ? Math.round(this.limbPivot[c.key].y) : "x")).join(" ") + "  ears=" + R.ears.filter((e) => this.dBase[e.draw]).length + "/" + R.ears.length + "  extra=" + R.extraParams.filter((n) => this.pIdx[n] !== void 0).join(","));
    } catch (e) {
      this.log("limb pivot skipped: " + e.message);
    }
    this.ready = true;
    this.log("live2d(official): model " + this.canvasWidth + "x" + this.canvasHeight + " ready");
  }
  /** 每帧：dtMs 毫秒。先恢复上帧参数 → 写外部驱动 → 物理 → update */
  update(dtMs) {
    if (!this.ready || !this.model) return;
    this.frames++;
    const dt = dtMs / 1e3;
    this.model.loadParameters();
    if (this.eyeOpenOverride !== null) {
      const idL = CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamEyeLOpen);
      const idR = CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamEyeROpen);
      this.model.setParameterValueById(idL, this.eyeOpenOverride);
      this.model.setParameterValueById(idR, this.eyeOpenOverride);
    }
    if (this.bodyAngleZ !== 0) {
      const idZ = CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamBodyAngleZ);
      this.model.setParameterValueById(idZ, this.bodyAngleZ);
    }
    const k = 1 - Math.exp(-dt * 12);
    const hx = clamp1(this.pointerX * this.headFollow);
    const hy = clamp1(this.pointerY * this.headFollow);
    const ex = clamp1(this.pointerX * this.eyeFollow);
    const ey = clamp1(this.pointerY * this.eyeFollow);
    this.curAngleX += (this.mapRange("ParamAngleX", hx) - this.curAngleX) * k;
    this.curAngleY += (this.mapRange("ParamAngleY", hy) - this.curAngleY) * k;
    this.curEyeBallX += (this.mapRange("ParamEyeBallX", ex) - this.curEyeBallX) * k;
    this.curEyeBallY += (this.mapRange("ParamEyeBallY", ey) - this.curEyeBallY) * k;
    this.setParam("ParamAngleX", this.curAngleX);
    this.setParam("ParamAngleY", this.curAngleY);
    this.setParam("ParamEyeBallX", this.curEyeBallX);
    this.setParam("ParamEyeBallY", this.curEyeBallY);
    this.breathT += dt;
    const br = 0.5 + 0.5 * Math.sin(this.breathT * 2 * Math.PI / this.breathPeriod);
    this.setParam("ParamBreath", this.mapUnit("ParamBreath", 0.5 + (br - 0.5) * this.breathAmp));
    const ks = Math.min(1, dt * 14);
    const tZ = this.mapRange("ParamAngleZ", clamp1(this.motionAngleZ / BASE_ANGLE_Z));
    const tBX = this.mapRange(
      "ParamBodyAngleX",
      clamp1(this.motionBody / BASE_BODY + this.dragBody * this.motionBodySwing / BASE_SWING)
    );
    const tBZ = this.mapRange("ParamBodyAngleZ", clamp1((this.motionBody + this.motionBodySwing) / BASE_SWING));
    this.curAngZ += (tZ - this.curAngZ) * ks;
    this.curBodyX += (tBX - this.curBodyX) * ks;
    this.curBodyZ += (tBZ - this.curBodyZ) * ks;
    this.setParam("ParamAngleZ", this.curAngZ);
    this.setParam("ParamBodyAngleX", this.curBodyX);
    this.setParam("ParamBodyAngleZ", this.curBodyZ);
    this.curSwing += (this.motionBodySwing * this.dragBody - this.curSwing) * ks;
    // ★ 连续口型（2026-09-22）：音量驱动时直写 0~1；mouthOpenV=0 时维持原来的枚举口径
    const mp = this.rig.mouthParam;
    if (mp.mix === "max") {
      // 只有一张嘴（苏墨）：平时 / 点击 / 说话各一个张开度，音量映射到 [lo, hi] 后和它取大
      const base = this.mouthMode === "triangle" ? mp.triangle : this.mouthMode === "open" ? mp.open : mp.smile;
      const want = this.mouthOpenV > 0 ? Math.max(base, mp.lo + (mp.hi - mp.lo) * this.mouthOpenV) : base;
      if (this.curMouth === null || !(mp.smooth > 0)) this.curMouth = want;
      else this.curMouth += (want - this.curMouth) * Math.min(1, dt * mp.smooth);
      this.setParam("ParamMouthOpenY", this.curMouth);
    } else {
      this.setParam("ParamMouthOpenY", this.mouthOpenV > 0 ? this.mouthOpenV : (this.mouthMode === "triangle" ? 0 : 1));
    }
    for (const n in this.extra) this.setParam(n, this.mapRange(n, clamp1(this.extra[n])));
    try {
      if (this.physics) this.physics.evaluate(this.model, dt);
    } catch (e) {
    }
    this.model.update();
    this.applyBodySwing();
    this.applyLimbs(dt);
    this.applyEars(dt);
    this.applyMouth();
    if (this.rig.mouthFollowAffine) this.applyMouthFollow();
    this.applyCrease();
    this.applyClothMask();
  }
  /** 查询参数索引 + 上下限 + 默认值（一次缓存） */
  cacheParam(name) {
    try {
      const id = CubismFramework.getIdManager().getId(name);
      const i = this.model.getParameterIndex(id);
      if (i >= 0) {
        this.pIdx[name] = i;
        this.pMin[name] = this.model.getParameterMinimumValue(i);
        this.pMax[name] = this.model.getParameterMaximumValue(i);
        this.pDef[name] = this.model.getParameterDefaultValue(i);
      }
    } catch (e) {
    }
  }
  /** t ∈ [-1,1] → 参数值：以**模型默认值**为中心按两侧幅度线性映射（默认值非零也不偏） */
  mapRange(name, t) {
    if (!(name in this.pIdx)) return 0;
    const d = this.pDef[name] || 0;
    return t >= 0 ? d + t * (this.pMax[name] - d) : d + t * (d - this.pMin[name]);
  }
  /** u ∈ [0,1] → 参数范围（呼吸这类单向参数用；PSD 口径的 0.5 是呼气中位） */
  mapUnit(name, u) {
    if (!(name in this.pIdx)) return 0;
    const lo = this.pMin[name], hi = this.pMax[name];
    return lo + Math.max(0, Math.min(1, u)) * (hi - lo);
  }
  setParam(name, v) {
    const i = this.pIdx[name];
    if (i === void 0) return;
    const lo = this.pMin[name], hi = this.pMax[name];
    this.model.setParameterValueByIndex(i, Math.max(lo, Math.min(hi, v)));
  }
  /**
   * ★ 拖拽摆动：照 PSD 内核的口径（`psd-runtime.js:636-642`）——**只转身体、头完全不动**：
   *   角度 = bodySwing × 0.35 弧度、绕「脖子中心」枢轴、只作用于 BODY_DRAWABLES（不含 neck、不含任何头部层）。
   *   为什么自己转顶点而不用 `ParamBodyAngle*`：那两个参数**在本模型里是空的**（写到满幅模型不动，分区差分实测）。
   *   与服装开关同理：必须在 `model.update()` 之后改，且**每帧都要改**（下一帧会被 native 重算回去）。
   */
  applyBodySwing() {
    if (!this.bodyPivot || Math.abs(this.curSwing) < 1e-4) return;
    const ang = Math.max(-0.6, Math.min(0.6, this.curSwing * this.rig.swingGain));
    this.rotateAroundNeck(this.rig.body, ang);
    if (Math.abs(this.dragTilt) > 1e-4) this.rotateAroundNeck(this.rig.head, ang * this.dragTilt);
    // 头组里垂在背后的长部件（苏墨的后发）：越往下越跟身体走，到 tip 处和身体转得一样多
    const rest = ang * (1 - this.dragTilt);
    if (Math.abs(rest) < 1e-4) return;
    const p = this.bodyPivot, ppu = this.pixelsPerUnit, ox = this.canvasOriginX, oy = this.canvasOriginY;
    for (const f of this.rig.swingFollow) {
      const i = this.dIdx[f.draw];
      if (i === void 0) continue;
      let v = null;
      try {
        v = this.model.getDrawableVertexPositions(i);
      } catch (e) {
        continue;
      }
      if (!v) continue;
      const axA = f.tip[0] - f.root[0], ayA = f.tip[1] - f.root[1];
      const l2 = axA * axA + ayA * ayA || 1;
      const u0 = f.u0 || 0;
      for (let k = 0; k < v.length; k += 2) {
        const x = ox + v[k] * ppu, y = oy - v[k + 1] * ppu;
        const u = ((x - f.root[0]) * axA + (y - f.root[1]) * ayA) / l2;
        if (u <= u0) continue;
        const w = Math.min(1, (u - u0) / Math.max(1e-6, 1 - u0));
        const ca = Math.cos(rest * w), sa = Math.sin(rest * w);
        const rx = x - p.x, ry = y - p.y;
        const nx = p.x + rx * ca - ry * sa, ny = p.y + rx * sa + ry * ca;
        v[k] = (nx - ox) / ppu;
        v[k + 1] = (oy - ny) / ppu;
      }
    }
  }
  /** ★ 把一批 drawable 的顶点绕「脖子中心」旋转 ang 弧度（身体摆动 / 头跟随**共用同一枢轴**，接缝才不会裂） */
  rotateAroundNeck(names, ang) {
    if (!this.bodyPivot || Math.abs(ang) < 1e-4) return;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const p = this.bodyPivot, ppu = this.pixelsPerUnit, ox = this.canvasOriginX, oy = this.canvasOriginY;
    for (const name of names) {
      const i = this.dIdx[name];
      if (i === void 0) continue;
      let v = null;
      try {
        v = this.model.getDrawableVertexPositions(i);
      } catch (e) {
        continue;
      }
      if (!v) continue;
      for (let k = 0; k < v.length; k += 2) {
        const x = ox + v[k] * ppu, y = oy - v[k + 1] * ppu;
        const rx = x - p.x, ry = y - p.y;
        const nx = p.x + rx * ca - ry * sa, ny = p.y + rx * sa + ry * ca;
        v[k] = (nx - ox) / ppu;
        v[k + 1] = (oy - ny) / ppu;
      }
    }
  }
  /**
   * ★ 四肢摇曳：照 pet.js 的 LIMB_CFG —— 每条肢体一条**二阶弹簧**（K/C），绕各自根部枢轴旋转，
   *   角度 = 弹簧值 × gain。驱动量是**未平滑**的拖拽摆动（motionBodySwing × dragBody，±1.5）。
   *   与身体摆动同一时机（model.update() 之后、每帧从 native 算出的干净顶点上叠加 ⇒ 不累积）。
   */
  applyLimbs(dt) {
    const target = -this.motionDragVelX;
    const ppu = this.pixelsPerUnit, ox = this.canvasOriginX, oy = this.canvasOriginY;
    for (const cfg of this.rig.limbs) {
      const st = this.limbState[cfg.key], p = this.limbPivot[cfg.key];
      if (!st || !p) continue;
      st.v += (cfg.K * (target - st.a) - cfg.C * st.v) * dt;
      st.a += st.v * dt;
      if (st.a > LIMB_MAX) {
        st.a = LIMB_MAX;
        st.v = 0;
      }
      if (st.a < -LIMB_MAX) {
        st.a = -LIMB_MAX;
        st.v = 0;
      }
      const limbScale = this.rig.armKeys.indexOf(cfg.key) >= 0 ? this.limbArm : 1;
      const ang = st.a * cfg.gain * limbScale;
      if (Math.abs(ang) < 1e-4) continue;
      const axA = p.tx - p.x, ayA = p.ty - p.y;
      const l2 = axA * axA + ayA * ayA || 1;
      for (const name of cfg.draws) {
        const i = this.dIdx[name];
        if (i === void 0) continue;
        let v = null;
        try {
          v = this.model.getDrawableVertexPositions(i);
        } catch (e) {
          continue;
        }
        if (!v) continue;
        for (let k = 0; k < v.length; k += 2) {
          const x = ox + v[k] * ppu, y = oy - v[k + 1] * ppu;
          const u = ((x - p.x) * axA + (y - p.y) * ayA) / l2;
          const u0 = cfg.u0 || 0;
          if (u <= u0) continue;
          const w = Math.min(1, (u - u0) / Math.max(1e-6, 1 - u0));
          const ca2 = Math.cos(ang * w), sa2 = Math.sin(ang * w);
          const rx = x - p.x, ry = y - p.y;
          const nx = p.x + rx * ca2 - ry * sa2, ny = p.y + rx * sa2 + ry * ca2;
          v[k] = (nx - ox) / ppu;
          v[k + 1] = (oy - ny) / ppu;
        }
      }
    }
  }
  /** ★ 抖一下耳朵（点头时由 pet.js 调；rig.ears 为空就什么都不做） */
  earTwitch() {
    if (this.rig.ears.length) this.earT = 0;
  }
  /**
   * ★ 抖耳朵：耳朵绕耳根快速甩两三下再停（角度 = gain × e^(−衰减·t) × sin(2π·频率·t)）。
   *   耳朵跟着头转：耳根 / 耳尖先用「这只耳朵 base→cur 的仿射」换到当前姿态，再绕当前耳根转；
   *   沿耳根→耳尖的轴越往外转得越多（u0 之前不动），和四肢一样每帧从 native 算出的顶点上叠加。
   */
  applyEars(dt) {
    if (this.earT < 0 || !this.rig.ears.length) return;
    this.earT += dt;
    const t = this.earT;
    if (t > 1.2) {
      this.earT = -1;
      return;
    }
    const ppu = this.pixelsPerUnit, ox = this.canvasOriginX, oy = this.canvasOriginY;
    for (const e of this.rig.ears) {
      const tt = t - (e.delay || 0);
      if (tt <= 0) continue;
      const ang = (e.gain || 0.3) * (e.dir || 1) * Math.exp(-tt * (e.decay || 5)) * Math.sin(2 * Math.PI * (e.freq || 6) * tt);
      if (Math.abs(ang) < 1e-4) continue;
      const i = this.dIdx[e.draw];
      const b = this.dBase[e.draw];
      if (i === void 0 || !b) continue;
      let raw = null;
      try {
        raw = this.model.getDrawableVertexPositions(i);
      } catch (err) {
        continue;
      }
      if (!raw || raw.length !== b.length) continue;
      const cur = this.toCanvas(raw);
      const A = this.fitAffine(b, cur);
      if (!A) continue;
      const tf = (p) => {
        const ux = p[0] - A.mbx, uy = p[1] - A.mby;
        return [A.mcx + A.a11 * ux + A.a12 * uy, A.mcy + A.a21 * ux + A.a22 * uy];
      };
      const r = tf(e.root), tp = tf(e.tip);
      const axA = tp[0] - r[0], ayA = tp[1] - r[1];
      const l2 = axA * axA + ayA * ayA || 1;
      const u0 = e.u0 || 0;
      for (let k = 0; k < cur.length; k += 2) {
        const x = cur[k], y = cur[k + 1];
        const u = ((x - r[0]) * axA + (y - r[1]) * ayA) / l2;
        if (u <= u0) continue;
        const w = Math.min(1, (u - u0) / Math.max(1e-6, 1 - u0));
        const ca = Math.cos(ang * w), sa = Math.sin(ang * w);
        const rx = x - r[0], ry = y - r[1];
        const nx = r[0] + rx * ca - ry * sa, ny = r[1] + rx * sa + ry * ca;
        raw[k] = (nx - ox) / ppu;
        raw[k + 1] = (oy - ny) / ppu;
      }
    }
  }
  /**
   * ★ 点到了哪儿：画布坐标 (x, y) 下最上面那个看得见的部件属于 rig.hit 的哪一组（head / tail …），
   *   都不属于就是 'body'，点空了是 null。按三角形判，用的是当前帧（含摆动）的顶点。
   */
  hitPart(x, y) {
    let core = null;
    try {
      core = this.model.getModel();
    } catch (e) {
      return null;
    }
    const d = core && core.drawables;
    if (!d) return null;
    const ux = (x - this.canvasOriginX) / this.pixelsPerUnit;
    const uy = (this.canvasOriginY - y) / this.pixelsPerUnit;
    const orders = d.renderOrders || d.drawOrders;
    let best = -1, bestOrder = -Infinity;
    for (let i = 0; i < d.count; i++) {
      if (!(d.opacities[i] > 0.05)) continue;
      const order = orders ? orders[i] : i;
      if (order <= bestOrder) continue;
      const v = d.vertexPositions[i], idx = d.indices[i];
      if (!v || !idx) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < v.length; k += 2) {
        if (v[k] < x0) x0 = v[k];
        if (v[k] > x1) x1 = v[k];
        if (v[k + 1] < y0) y0 = v[k + 1];
        if (v[k + 1] > y1) y1 = v[k + 1];
      }
      if (ux < x0 || ux > x1 || uy < y0 || uy > y1) continue;
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = idx[t] * 2, b = idx[t + 1] * 2, c = idx[t + 2] * 2;
        const d1 = (ux - v[b]) * (v[a + 1] - v[b + 1]) - (v[a] - v[b]) * (uy - v[b + 1]);
        const d2 = (ux - v[c]) * (v[b + 1] - v[c + 1]) - (v[b] - v[c]) * (uy - v[c + 1]);
        const d3 = (ux - v[a]) * (v[c + 1] - v[a + 1]) - (v[c] - v[a]) * (uy - v[a + 1]);
        const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
        if (!(neg && pos)) {
          best = i;
          bestOrder = order;
          break;
        }
      }
    }
    if (best < 0) return null;
    const name = String(d.ids[best]);
    for (const g in this.rig.hit) if (this.rig.hit[g].indexOf(name) >= 0) return g;
    return "body";
  }
  /** ★ 额外参数（如 ParamTailWag）：-1..1，按模型的参数范围映射；模型里没有这个参数就不写 */
  setExtra(name, v) {
    if (typeof v === "number" && isFinite(v)) this.extra[name] = v;
  }
  /**
     * ★ 嘴跟随头部（A 方案）：三个嘴层是 unknown ⇒ 只跟 head 的默认形变、不参与面部九轴。
     *   这里把它们套上 **ArtMeshFace 的 base→cur 仿射** —— 嘴在脸的**正中央**，仿射是内插不是外推，
     *   可靠（不像眼睑褶皱在睫毛区域外会失真）。必须在 model.update() 之后、每帧重算。
     */
  applyMouthFollow() {
    const fb = this.dBase[this.rig.face];
    const fc = this.drawableVerts(this.rig.face);
    if (!fb || !fc) return;
    const A = this.fitAffine(fb, fc);
    if (!A) return;
    const ppu = this.pixelsPerUnit, ox = this.canvasOriginX, oy = this.canvasOriginY;
    for (const key in this.rig.mouth) {
      const nm = this.rig.mouth[key];
      const i = this.dIdx[nm];
      const b = this.dBase[nm];
      if (i === void 0 || !b || b.length < 6) continue;
      let raw = null;
      try {
        raw = this.model.getDrawableVertexPositions(i);
      } catch (e) {
        continue;
      }
      if (!raw || raw.length < 6) continue;
      for (let k = 0; k < raw.length; k += 2) {
        const ux = b[k] - A.mbx, uy = b[k + 1] - A.mby;
        const nx = A.mcx + A.a11 * ux + A.a12 * uy;
        const ny = A.mcy + A.a21 * ux + A.a22 * uy;
        raw[k] = (nx - ox) / ppu;
        raw[k + 1] = (oy - ny) / ppu;
      }
    }
  }
  /**
   * ★ 口型三选一（互斥）：只让当前模式的嘴不透明、其余两个压 0。
   *   必须在 model.update() 之后（native 每帧会重算 opacities）。
   */
  applyMouth() {
    let core = null;
    try {
      core = this.model.getModel();
    } catch (e) {
      return;
    }
    const d = core && core.drawables ? core.drawables : null;
    if (!d) return;
    const ops = d.opacities;
    const M = this.rig.mouth;
    const iBrow = this.dIdx["ArtMeshEyebrowL"] !== void 0 ? this.dIdx["ArtMeshEyebrowL"] : this.dIdx["ArtMeshEyebrowR"];
    const iHair = this.dIdx["ArtMeshFrontHair"];
    if (this.rig.mouthOrder && d.drawOrders && iBrow !== void 0 && iHair !== void 0) {
      const ord = Math.round((d.drawOrders[iBrow] + d.drawOrders[iHair]) / 2);
      for (const key in M) {
        const i = this.dIdx[M[key]];
        if (i !== void 0) d.drawOrders[i] = ord;
      }
    }
    // 当前口型对应的那张嘴显示、别的压 0；几个口型共用一张嘴（苏墨）就一直显示它
    const cur = M[this.mouthMode] || M.smile;
    for (const key in M) {
      const i = this.dIdx[M[key]];
      if (i === void 0) continue;
      ops[i] = M[key] === cur ? 1 : 0;
    }
    if (this.rig.mouthForceVisible) {
      for (const key in M) {
        const i0 = this.dIdx[M[key]];
        if (i0 !== void 0) ops[i0] = 0;
      }
      const fi = this.dIdx[this.rig.mouthForceVisible];
      if (fi !== void 0) ops[fi] = 1;
    }
  }
  /**
   * ★ 眼睑褶皱跟随睫毛：把褶皱的顶点套上「同侧睫毛」的 base→cur 最小二乘仿射（与爱心眼同一手法）。
   *   必须在 model.update() 之后、每帧从 native 干净顶点重算。
   */
  applyCrease() {
    const crease = this.rig.crease;
    if (!crease) return;
    const ci = this.dIdx[crease];
    if (ci === void 0) return;
    const cb = this.dBase[crease];
    if (!cb || cb.length < 6) return;
    let raw = null;
    try {
      raw = this.model.getDrawableVertexPositions(ci);
    } catch (e) {
      return;
    }
    if (!raw || raw.length < 6) return;
    const A = {};
    for (const side in this.rig.eyelash) {
      const nm = this.rig.eyelash[side];
      const b = this.dBase[nm];
      const c = this.drawableVerts(nm);
      if (b && c && b.length === c.length) A[side] = this.fitAffine(b, c);
    }
    if (!A.L && !A.R) return;
    const ppu = this.pixelsPerUnit, ox = this.canvasOriginX, oy = this.canvasOriginY;
    const splitX = this.canvasOriginX;
    for (let k = 0; k < raw.length; k += 2) {
      const a = cb[k] < splitX ? A.L : A.R;
      if (!a) continue;
      const ux = cb[k] - a.mbx, uy = cb[k + 1] - a.mby;
      const nx = a.mcx + a.a11 * ux + a.a12 * uy;
      const ny = a.mcy + a.a21 * ux + a.a22 * uy;
      raw[k] = (nx - ox) / ppu;
      raw[k + 1] = (oy - ny) / ppu;
    }
  }
  /** 最小二乘仿射拟合（照搬 heartfx 的 fitAffine）：cur ≈ A·(base − mb) + mc */
  fitAffine(b, c) {
    const n = b.length >> 1;
    if (n < 3) return null;
    let mx = 0, my = 0, nx = 0, ny = 0;
    for (let k = 0; k < b.length; k += 2) {
      mx += b[k];
      my += b[k + 1];
      nx += c[k];
      ny += c[k + 1];
    }
    mx /= n;
    my /= n;
    nx /= n;
    ny /= n;
    let sxx = 0, sxy = 0, syy = 0, sxc = 0, syc = 0, sxd = 0, syd = 0;
    for (let k = 0; k < b.length; k += 2) {
      const bx = b[k] - mx, by = b[k + 1] - my;
      const cx2 = c[k] - nx, cy2 = c[k + 1] - ny;
      sxx += bx * bx;
      sxy += bx * by;
      syy += by * by;
      sxc += bx * cx2;
      syc += by * cx2;
      sxd += bx * cy2;
      syd += by * cy2;
    }
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) < 1e-6) return null;
    return {
      a11: (syy * sxc - sxy * syc) / det,
      a12: (sxx * syc - sxy * sxc) / det,
      a21: (syy * sxd - sxy * syd) / det,
      a22: (sxx * syd - sxy * sxd) / det,
      mbx: mx,
      mby: my,
      mcx: nx,
      mcy: ny
    };
  }
  /** 按 clothMask 把对应 drawable 的不透明度压到 0（自动恢复交回 native 的 update） */
  applyClothMask() {
    if (!this.clothMask) return;
    let core = null;
    try {
      core = this.model.getModel();
    } catch (e) {
      return;
    }
    const ops = core && core.drawables ? core.drawables.opacities : null;
    if (!ops) return;
    const C = this.rig.cloth;
    for (const key in C) {
      if (this.clothMask[key] !== false) continue;
      for (const n of C[key]) {
        const i = this.dIdx[n];
        if (i !== void 0) ops[i] = 0;
      }
    }
    // \u2605 2026-10-17 \uFF1A\u81EA\u52A8\u8054\u52A8\uFF08rig.autoCloth\uFF09\u2014\u2014\u67D0\u4EF6\u670D\u88C5\u7A7F\u7740\u65F6\uFF0C\u628A\u5B83\u76D6\u4F4F\u7684\u90E3\u4EF6\u81EA\u52A8\u538B\u6389\u3002
    //   \u82CF\u58A8\u7528\u5B83\u5B9E\u73B0\u300C\u6709\u978B\u5B50\u5C31\u9690\u85CF\u811A\u300D\uFF1A\u978B\u5B50\u5F00\u7740 \u21D2 \u811A\uFF08ArtMeshLegwear\uFF09\u4E0D\u753B\uFF1B\u978B\u5B50\u4E00\u5173 \u21D2 \u5149\u811A\u81EA\u5DF1\u9732\u51FA\u6765\u3002
    //   \u5224\u636E\u53EA\u770B clothMask \u91CC\u90A3\u4E00\u9879\u662F\u4E0D\u662F false\uFF1B\u6CA1\u8BBE\u8FC7\uFF08undefined\uFF09\u6309\u300C\u7A7F\u7740\u300D\u7B97\uFF0C\u4E0E\u5F00\u5173\u7684\u9ED8\u8BA4\u53E3\u5F84\u4E00\u81F4\u3002
    const A = this.rig.autoCloth;
    if (A) {
      for (const rule of A) {
        if (!rule || !rule.when || !Array.isArray(rule.hide)) continue;
        if (this.clothMask[rule.when] === false) continue;   // \u8BE5\u670D\u88C5\u5DF2\u8131 \u21D2 \u4E0D\u9690\u85CF
        for (const n of rule.hide) {
          const i = this.dIdx[n];
          if (i !== void 0) ops[i] = 0;
        }
      }
    }
  }
  /** 绘制到画布（含画布适配：模型 canvas → 视口等比缩放居中） */
  draw() {
    if (!this.ready || !this.renderer || !this.model) return;
    const w = this.canvas.width, h = this.canvas.height;
    this.gl.viewport(0, 0, w, h);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.mvp.loadIdentity();
    const aspect = w / h;
    if (aspect > 1) this.mvp.scale(1, aspect);
    else this.mvp.scale(1 / aspect, 1);
    this.mvp.multiplyByMatrix(this.modelMatrix);
    this.renderer.setMvpMatrix(this.mvp);
    this.renderer.setRenderState(null, [0, 0, w, h]);
    this.renderer.doDrawModel(this.shaderPath);
  }
  /** 供 pet.js 眨眼曲线使用：0 = 闭、1 = 睁 */
  setEyeOpen(v) {
    this.eyeOpenOverride = v;
  }
  /**
   * ★ 指针追随：传 -1..1 的归一化视线，直接给 pet.js 主循环的 `ov.eyeX / ov.eyeY` 即可。
   * 注意 y 是**屏幕语义**（向下为正，`ov.eyeY` 就是 cursor.y − 窗口中心 y）；模型参数以「向上为正」，
   * 所以这里翻一次号。x 不需要翻。
   */
  setPointer(x, y) {
    const cx = typeof x === "number" && isFinite(x) ? x : 0;
    const cy = typeof y === "number" && isFinite(y) ? y : 0;
    this.pointerX = Math.max(-1, Math.min(1, cx));
    this.pointerY = -Math.max(-1, Math.min(1, cy));
  }
  /** ★ 服装开关：{ topwear:true, bottomwear:false, ... }（false = 脱掉；null = 不干预） */
  setClothMask(mask) {
    this.clothMask = mask;
  }
  /**
   * ★ 摇晃 / 拖拽摆动：直接给 pet.js 主循环 `ov` 里的 body / angleZ / bodySwing
   * （PSD 口径：body ±1、angleZ ±0.35、bodySwing ±1.5）。映射到
   * ParamAngleZ（头左右倾）＋ ParamBodyAngleX/Z（身体）—— 而 BodyAngle/AngleZ 又都是物理的
   * 输入 ⇒ 身体一摆，前发后发跟着荡。
   */
  setMotion(body, angleZ, bodySwing, dragVelX) {
    this.motionBody = typeof body === "number" && isFinite(body) ? body : 0;
    this.motionAngleZ = typeof angleZ === "number" && isFinite(angleZ) ? angleZ : 0;
    this.motionBodySwing = typeof bodySwing === "number" && isFinite(bodySwing) ? bodySwing : 0;
    this.motionDragVelX = typeof dragVelX === "number" && isFinite(dragVelX) ? dragVelX : 0;
  }
  /** ★ 呼吸（面板「呼吸 / 摇晃」组可调）：周期秒 / 幅度（1.0 = 走满 ParamBreath 范围） */
  setBreath(period, amp) {
    if (typeof period === "number" && isFinite(period) && period > 0.2) this.breathPeriod = period;
    if (typeof amp === "number" && isFinite(amp)) this.breathAmp = amp;
  }
  /**
   * ★ 追随灵敏度（面板「视线追随」组）：头/眼各一个 0~2 倍系数，默认 1.0。
   * 分开调的理由：眼球可以很灵动、头转太勤反而烦；两者的观感诉求不同。
   */
  setFollow(head, eye) {
    if (typeof head === "number" && isFinite(head)) this.headFollow = Math.max(0, Math.min(2, head));
    if (typeof eye === "number" && isFinite(eye)) this.eyeFollow = Math.max(0, Math.min(2, eye));
  }
  /** ★ 拖拽时头部跟随倾斜的比例（0 = 头稳如 PSD 口径；1 = 头与身体一起倒） */
  setDragTilt(v) {
    if (typeof v === "number" && isFinite(v)) this.dragTilt = Math.max(0, Math.min(1, v));
  }
  /** ★ 口型切换（'smile' 平时｜'triangle' 点击/拖拽｜'open' 语音） */
  setMouth(mode) {
    if (mode === "smile" || mode === "triangle" || mode === "open") this.mouthMode = mode;
  }
  /**
   * ★ 连续口型（2026-09-22 · 要「随音量开合」）：0~1 直接写 ParamMouthOpenY。
   *   传 0 / null ⇒ 回到 setMouth 的枚举口径（smile/triangle/open 三态）。
   *   模型 model3.json 把 ParamMouthOpenY 归在 LipSync 组，天生就是唇动参数。
   */
  setMouthOpen(v) {
    if (v === null || v === void 0 || !isFinite(v)) { this.mouthOpenV = 0; return; }
    this.mouthOpenV = Math.max(0, Math.min(1, v));
  }
  /** ★ 拖拽时身体摆幅倍数（0 = 身体不动；1 = 满幅；>1 无意义——参数已到上限） */
  setDragBody(v) {
    if (typeof v === "number" && isFinite(v)) this.dragBody = Math.max(0, Math.min(2, v));
  }
  /** ★ 手臂（含袖子）摆动幅度倍率（0 = 手臂不甩；1 = 照搬 PSD 的 gain） */
  setLimbArm(v) {
    if (typeof v === "number" && isFinite(v)) this.limbArm = Math.max(0, Math.min(1.5, v));
  }
  /**
   * ★ 取 drawable 当前顶点，**换算到模型画布坐标**（与 PSD 的层顶点同一口径，爱心眼直接用）。
   * 踩过的坑：官方 `getDrawableVertexPositions` 返回的是 **unit 计**（除以 PixelsPerUnit），
   * 且原点在画布中心、Y 轴向上 —— 直接拿来用会得到 0.09 这种值、爱心飞到左上角。
   *   canvasX = CanvasOriginX + vx * PixelsPerUnit
   *   canvasY = CanvasOriginY − vy * PixelsPerUnit   （canvas 2D 的 Y 向下）
   */
  drawableVerts(name) {
    const i = this.dIdx[name];
    if (i === void 0) return null;
    try {
      return this.toCanvas(this.model.getDrawableVertexPositions(i));
    } catch (e) {
      return null;
    }
  }
  /** ★ 取 drawable 的默认姿态顶点快照（仿射拟合的 base，同样是画布坐标） */
  drawableBase(name) {
    return this.dBase[name] || null;
  }
  /** unit 顶点 → 画布坐标（见 drawableVerts 的换算说明） */
  toCanvas(v) {
    if (!v || !v.length) return null;
    const ppu = this.pixelsPerUnit, ox = this.canvasOriginX, oy = this.canvasOriginY;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i += 2) {
      out[i] = ox + v[i] * ppu;
      out[i + 1] = oy - v[i + 1] * ppu;
    }
    return out;
  }
  /** 画布坐标命中（与 pet.js 的同一口径：模型 canvas 空间） */
  characterBounds() {
    return { left: 0, top: 0, right: this.canvasWidth, bottom: this.canvasHeight };
  }
  probe() {
    let eyeOpacity = null, colors = null, shaderSets = -1, centerPx = null;
    try {
      const m = this.model.getModel();
      const ids = m.drawables.ids;
      const op = (n) => {
        const i = ids.indexOf(n);
        return i < 0 ? "x" : Number(m.drawables.opacities[i].toFixed(3));
      };
      eyeOpacity = {
        EyeCloseL: op("ArtMeshEyeCloseL"),
        EyeCloseR: op("ArtMeshEyeCloseR"),
        EyelashL: op("ArtMeshEyelashL"),
        IridesL: op("ArtMeshIridesL")
      };
      const iFace = ids.indexOf("ArtMeshFace");
      if (iFace >= 0) {
        const mc = m.drawables.multiplyColors ? m.drawables.multiplyColors[iFace] : null;
        const sc = m.drawables.screenColors ? m.drawables.screenColors[iFace] : null;
        colors = { face: { multiply: mc ? [mc.r, mc.g, mc.b, mc.a] : null, screen: sc ? [sc.r, sc.g, sc.b, sc.a] : null } };
      }
      shaderSets = this.model._shaderSets ? -1 : -1;
    } catch (e) {
      eyeOpacity = "err " + e.message;
    }
    try {
      const s = CubismShader_WebGL.getInstance();
      shaderSets = s && s._shaderSets ? s._shaderSets.length : -1;
    } catch (e) {
    }
    try {
      const px = new Uint8Array(4);
      this.gl.readPixels(
        Math.floor(this.canvas.width / 2),
        Math.floor(this.canvas.height / 2),
        1,
        1,
        this.gl.RGBA,
        this.gl.UNSIGNED_BYTE,
        px
      );
      centerPx = Array.from(px);
    } catch (e) {
      centerPx = "err " + e.message;
    }
    const hair = {};
    try {
      const m = this.model.getModel();
      const ids = m.drawables.ids;
      const op = (n) => {
        const i = ids.indexOf(n);
        return i < 0 ? "x" : Number(m.drawables.opacities[i].toFixed(3));
      };
      for (const n of [
        "ArtMeshTopwear",
        "ArtMeshTopwear2",
        "ArtMeshLayerL",
        "ArtMeshLayerR",
        "ArtMeshBottomwear",
        "ArtMeshLayer2",
        "ArtMeshFootwear"
      ]) hair[n] = op(n);
      for (const n of ["ArtMeshMouth", "ArtMeshMouthOpen", "ArtMeshMouthClose", "ArtMeshFace", "ArtMeshEyebrowL"]) {
        const i2 = ids.indexOf(n);
        let o = "x";
        try {
          o = i2 < 0 ? "x" : Number(m.drawables.opacities[i2].toFixed(3));
        } catch (err) {
          o = "opErr";
        }
        let r = "x";
        try {
          r = i2 < 0 ? "x" : Number(m.drawables.drawOrders[i2]);
        } catch (err) {
          r = "roErr";
        }
        hair[n + "_op"] = o;
        hair[n + "_ro"] = r;
        if (n === "ArtMeshMouth" || n === "ArtMeshMouthClose" || n === "ArtMeshMouthOpen" || n === "ArtMeshFace") {
          try {
            const bv = this.drawableVerts(n);
            if (bv && bv.length) {
              let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
              for (let k = 0; k < bv.length; k += 2) {
                if (bv[k] < x0) x0 = bv[k];
                if (bv[k] > x1) x1 = bv[k];
                if (bv[k + 1] < y0) y0 = bv[k + 1];
                if (bv[k + 1] > y1) y1 = bv[k + 1];
              }
              hair[n + "_box"] = [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)];
              hair[n + "_nv"] = bv.length >> 1;
            }
            if (n === "ArtMeshMouthClose" || n === "ArtMeshMouth" || n === "ArtMeshMouthOpen") {
              const d2 = this.model.getModel().drawables;
              hair[n + "_vc"] = d2.vertexCounts ? d2.vertexCounts[i2] : "x";
              hair[n + "_ic"] = d2.indexCounts ? d2.indexCounts[i2] : "x";
              hair[n + "_texi"] = d2.textureIndices ? d2.textureIndices[i2] : "x";
              try {
                const mi = d2.maskIndices ? d2.maskIndices[i2] : null;
                hair[n + "_mask"] = mi ? Array.from(mi).slice(0, 6) : "none";
              } catch (e2) {
                hair[n + "_mask"] = "err";
              }
              if (n === "ArtMeshMouthClose") {
                try {
                  const core2 = this.model.getModel();
                  const ppi = core2.drawables.parentPartIndices ? core2.drawables.parentPartIndices[i2] : -1;
                  const parts = core2.parts;
                  const pids = parts && parts.ids ? Array.from(parts.ids).map(String) : null;
                  const pops = parts && parts.opacities ? Array.from(parts.opacities) : null;
                  hair["MCpart"] = pids && pops && ppi >= 0 ? pids[ppi] + "=" + Number(Number(pops[ppi]).toFixed(2)) : "x";
                } catch (e4) {
                  hair["MCP"] = "err " + (e4.message || "unknown");
                }
              }
              try {
                const ic = d2.indices ? d2.indices[i2] : null;
                hair[n + "_idx"] = ic ? Array.from(ic).slice(0, 9) : "none";
              } catch (e2) {
                hair[n + "_idx"] = "err";
              }
            }
            const uvv = this.model.getDrawableVertexUvs(i2);
            if (uvv && uvv.length) {
              let u0 = 1e9, v0 = 1e9, u1 = -1e9, v1 = -1e9;
              for (let k = 0; k < uvv.length; k += 2) {
                if (uvv[k] < u0) u0 = uvv[k];
                if (uvv[k] > u1) u1 = uvv[k];
                if (uvv[k + 1] < v0) v0 = uvv[k + 1];
                if (uvv[k + 1] > v1) v1 = uvv[k + 1];
              }
              hair[n + "_uv"] = [u0, v0, u1, v1].map((q) => Number(q.toFixed(4)));
              hair[n + "_tex"] = this.model.getDrawableTextureIndex(i2);
            }
          } catch (err) {
            hair[n + "_box"] = "err";
          }
        }
      }
    } catch (e) {
    }
    const pv = {};
    try {
      for (const n of ["ParamBreath", "ParamAngleX", "ParamAngleZ", "ParamBodyAngleX", "ParamBodyAngleZ"]) {
        const i = this.pIdx[n];
        if (i !== void 0) pv[n] = Number(this.model.getParameterValueByIndex(i).toFixed(3));
      }
    } catch (e) {
    }
    return {
      ready: this.ready,
      canvas: [this.canvasWidth, this.canvasHeight],
      frames: this.frames,
      params: pv,
      breath: [Number(this.breathPeriod.toFixed(2)), Number(this.breathAmp.toFixed(2))],
      motion: [Number(this.motionBody.toFixed(3)), Number(this.motionAngleZ.toFixed(3)), Number(this.motionBodySwing.toFixed(3))],
      swing: Number(this.curSwing.toFixed(3)),
      pivot: this.bodyPivot,
      eyeOpenOverride: this.eyeOpenOverride,
      eyeOpacity,
      colors,
      shaderSets,
      centerPx,
      pointer: [Number(this.pointerX.toFixed(3)), Number(this.pointerY.toFixed(3))],
      angle: [Number(this.curAngleX.toFixed(2)), Number(this.curAngleY.toFixed(2))],
      clothMask: this.clothMask,
      clothOpacity: hair,
      glError: this.gl.getError()
    };
  }
  release() {
    this.ready = false;
    try {
      this.renderer?.release();
    } catch (e) {
    }
    try {
      for (const t of this.textures) this.gl.deleteTexture(t);
    } catch (e) {
    }
    this.textures = [];
    try {
      this.moc?.deleteModel?.(this.model);
      this.moc?.release?.();
    } catch (e) {
    }
    this.model = null;
    this.renderer = null;
  }
}
window.PetLive2D = PetLive2D;
