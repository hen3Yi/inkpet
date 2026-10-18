// 桌宠 · 爱心眼特效（渲染端叠加，不碰模型）
//   层级（定）：瞳孔之上、前发之下 ——
//     · 画在 #stage 之上 → 盖住原瞳孔
//     · 再用 front hair 的像素 alpha 做 destination-out → 被刘海挡住的那部分被抹掉
//   位置/大小/透视（定：「爱心的透视关系必须和瞳孔一致」）：
//     · 拿内核 irides 层的 base→cur 顶点对做最小二乘仿射拟合（含缩放/旋转/错切）
//     · 虹膜本体（内容）中心/大小从该层像素里量（contentBox；img 是裁切图，须补 L.x/L.y）
//     · 每帧把该仿射矩阵原样套到爱心上 → 头部转动、眨眼压缩、视线位移全都与瞳孔一致
//   尺寸（定）：两眼一律 K 倍瞳孔本体，左右等大（不做「按可见高度收敛」——那会一大一小）
//   动感：双跳心跳曲线（lub-dub）缩放 + 轻微上浮 + 左上高光小亮心（定「不要飘心」）
const K = 0.78;            // 爱心相对虹膜本体的比例（一小一大不行，等大这版是对的）
const HX = 1.45, HY = 1.18, HY0 = 0.13;   // 心形路径的归一化范围（x∈±1.45，y∈-1.18..0.92）

function heartPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(0, 0.92);
  ctx.bezierCurveTo(-1.45, -0.05, -0.72, -1.18, 0, -0.5);
  ctx.bezierCurveTo(0.72, -1.18, 1.45, -0.05, 0, 0.92);
  ctx.closePath();
}

/** 画一颗心：几何中心在 (cx,cy)，总宽 w、总高 h */
function heart(ctx, cx, cy, w, h, rot, alpha, color) {
  if (alpha <= 0.004 || w <= 0.5 || h <= 0.5) return;
  const sx = (w / 2) / HX, sy = (h / 2) / HY;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot || 0);
  ctx.translate(0, HY0 * sy);              // 让心形的几何中心对上 (cx,cy)
  ctx.scale(sx, sy);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  heartPath(ctx);
  ctx.fill();
  ctx.restore();
}

/** 外圈柔光 + 实心两层（比 shadowBlur 便宜） */
function heartGlow(ctx, cx, cy, w, h, rot, alpha, color) {
  heart(ctx, cx, cy, w * 1.28, h * 1.28, rot, alpha * 0.3, color);
  heart(ctx, cx, cy, w, h, rot, alpha, color);
}

export class HeartFx {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.on = false;          // 常驻开关（右键菜单勾选）
    this.t = 0;
    this.rt = null;
    this.eye = { L: null, R: null };
    this.white = { L: null, R: null };   // 眼白（眼皮）层：闭眼时它被压扁 → 爱心套它就跟着被夹
    this.cb = { L: null, R: null };   // 虹膜本体（内容）中心/大小（画布坐标）
    this.hair = null;
    this.mask = null;
    this.maskPos = { x: 0, y: 0 };
    this.burst = 0;           // 开启瞬间的「噗通」脉冲
    this._w = 0; this._h = 0; this._dpr = 1;
  }

  /** PsdRuntime 加载完成后接入 */
  attach(rt) {
    this.rt = rt;
    const ir = rt.layers.filter((L) => L.bn === 'irides');
    for (const L of ir) {
      L._mb = this.meshBox(L.base);
      if (L.side === 'L') { this.eye.L = L; this.cb.L = this.contentBox(L); }
      else if (L.side === 'R') { this.eye.R = L; this.cb.R = this.contentBox(L); }
    }
    this.hair = rt.layers.filter((L) => L.bn === 'front hair')[0] || null;
    for (const L of rt.layers.filter((x) => x.bn === 'eyewhite')) {
      if (L.side === 'L') this.white.L = L;
      else if (L.side === 'R') this.white.R = L;
    }
    this.buildMask();
    console.log('HEARTFX irides=' + ir.length +
      ' eyes=' + !!this.eye.L + '/' + !!this.eye.R +
      ' white=' + !!this.white.L + '/' + !!this.white.R +
      ' body=' + JSON.stringify(this.cb.L) + '/' + JSON.stringify(this.cb.R) +
      ' hair=' + !!this.hair + ' mask=' + !!this.mask);
  }

  /** 从该层像素（裁切图 RGBA）量出虹膜本体的质心与外接框，坐标换算到画布 */
  contentBox(L) {
    const img = L && L.img;
    // ★ live2d 后端没有「层裁切图」（层代理的 img=null）⇒ 直接用 drawable 顶点外接框；
    //   顶点本来就是模型画布坐标，不需要再叠 (L.x, L.y) 偏移。
    if (!img || !img.data) return this.meshBox(L && L.base);
    const w = img.width, h = img.height, d = img.data;
    let sx = 0, sy = 0, sw = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const a = d[(y * w + x) * 4 + 3];
        if (a <= 12) continue;
        sx += x * a; sy += y * a; sw += a;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (!sw || !(x1 > x0)) return null;
    // 关键：img 是「该层内容的裁切图」，局部 (0,0) 对应画布 (L.x, L.y)（见 rigger.makePart）
    const ox = L.x || 0, oy = L.y || 0;
    return { cx: ox + sx / sw, cy: oy + sy / sw, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * irides 层 base→cur 的最小二乘仿射拟合：cur ≈ A·(base − mb) + mc
   * 瞳孔被缩放/旋转/错切（头部转动、眨眼压缩）时，A 里全都带着 —— 爱心套同一个 A，透视就一致
   */
  fitAffine(L) {
    const b = L && L.base, c = L && L.cur;
    if (!b || !c || b.length < 6 || b.length !== c.length) return null;
    const n = b.length >> 1;
    let mx = 0, my = 0, nx = 0, ny = 0;
    for (let k = 0; k < b.length; k += 2) { mx += b[k]; my += b[k + 1]; nx += c[k]; ny += c[k + 1]; }
    mx /= n; my /= n; nx /= n; ny /= n;
    let sxx = 0, sxy = 0, syy = 0, sxc = 0, syc = 0, sxd = 0, syd = 0;
    for (let k = 0; k < b.length; k += 2) {
      const bx = b[k] - mx, by = b[k + 1] - my;
      const cx2 = c[k] - nx, cy2 = c[k + 1] - ny;
      sxx += bx * bx; sxy += bx * by; syy += by * by;
      sxc += bx * cx2; syc += by * cx2;
      sxd += bx * cy2; syd += by * cy2;
    }
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) < 1e-6) return null;
    return {
      a11: (syy * sxc - sxy * syc) / det,
      a12: (sxx * syc - sxy * sxc) / det,
      a21: (syy * sxd - sxy * syd) / det,
      a22: (sxx * syd - sxy * sxd) / det,
      mbx: mx, mby: my, mcx: nx, mcy: ny,
    };
  }

  /** 顶点数组（画布坐标）的外接框 */
  meshBox(arr) {
    if (!arr || !arr.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < arr.length; k += 2) {
      const x = arr[k], y = arr[k + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!(x1 > x0)) return null;
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
  }

  /** 用 front hair 层的像素数据烘一张遮挡遮罩（记住它在画布上的落点） */
  buildMask() {
    const L = this.hair;
    if (!L || !L.img || !L.img.data) { this.mask = null; return; }
    try {
      const w = L.img.width, h = L.img.height;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cx = c.getContext('2d');
      const d = L.img.data;
      const src = d instanceof Uint8ClampedArray ? d : new Uint8ClampedArray(d);
      cx.putImageData(new ImageData(src, w, h), 0, 0);
      this.mask = c;
      this.maskPos = { x: L.x || 0, y: L.y || 0 };
    } catch (e) {
      console.log('HEARTFX mask failed: ' + (e && e.message));
      this.mask = null;
    }
  }

  setOn(v) {
    const on = !!v;
    if (on && !this.on) this.burst = 1;      // 开的那一下先「噗通」一跳
    this.on = on;
  }

  update(dt) {
    this.t += dt;
    this.burst = Math.max(0, this.burst - dt * 1.6);
  }

  /** front hair 相对静止位置的位移（呼吸/头部转动），用来把遮挡对上去 */
  maskOffset() {
    const L = this.hair;
    if (!L || !L.cur || !L.base) return { x: 0, y: 0 };
    const b = this.meshBox(L.base), c = this.meshBox(L.cur);
    if (!b || !c) return { x: 0, y: 0 };
    return { x: c.cx - b.cx, y: c.cy - b.cy };
  }

  draw(view, pulseScale) {
    const ctx = this.ctx, rt = this.rt;
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (this._w !== pw || this._h !== ph) {
      this.cv.width = pw; this.cv.height = ph;
      this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
      this._w = pw; this._h = ph;
    }
    this._dpr = dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    if (!view || !this.on) return;
    // ★ 点击脉冲缩放：与 pet.js 里 stage 的 transform **同参数、同 origin（底部中心）** ——
    //   爱心画在独立的 #fx 层上，不套这一步，点击那 0.2 秒里就会和眼睛错位。
    const k = (typeof pulseScale === 'number' && isFinite(pulseScale) && pulseScale > 0) ? pulseScale : 1;
    if (k !== 1) {
      ctx.translate(w / 2, h);
      ctx.scale(k, k);
      ctx.translate(-w / 2, -h);
    }
    const sc = view.sc, tx = view.tx, ty = view.ty;
    const toX = (x) => tx + x * sc;
    const toY = (y) => ty + y * sc;

    // ---- 瞳孔上的爱心（原瞳孔之上叠加，与瞳孔共用同一套透视变换）----
    // 双跳心跳：一次「噗通」两下（强-弱），周期约 0.95s
    const bt = (this.t % 0.95) / 0.95;
    const p1 = Math.exp(-Math.pow((bt - 0.07) / 0.075, 2));
    const p2 = 0.6 * Math.exp(-Math.pow((bt - 0.27) / 0.095, 2));
    const pulse = p1 + p2 + this.burst * 1.1;
    const s = 1 + 0.22 * pulse + 0.035 * Math.sin(this.t * 2.2);
    const lift = -1.6 * pulse;
    for (const side of ['L', 'R']) {
      const L = this.eye[side], cb = this.cb[side];
      if (!L || !cb) continue;
      // 位置用「瞳孔（irides）层」的变换 —— 内核的 eyeX/eyeY 视线位移**只加在 irides 层**上，
      //   若拿眼白定位，爱心就不会跟随视线（实测「眼睛跟随鼠标时，爱心眼没有跟随瞳孔」）
      // 形状用「眼白（眼皮）层」的线性部分 —— 闭眼时眼白被压扁，爱心才会被上下眼皮夹住
      const Fi = this.fitAffine(L);
      const Fw = this.fitAffine(this.white[side] || L);
      if (!Fi || !Fw) continue;
      const open = rt && rt.cur ? (side === 'L' ? rt.cur.eyeOpenL : rt.cur.eyeOpenR) : 1;
      const vis = Math.max(0, Math.min(1, (open - 0.1) / 0.4));
      if (vis <= 0.01) continue;
      const ux = cb.cx - Fi.mbx, uy = cb.cy - Fi.mby;
      const px = Fi.mcx + Fi.a11 * ux + Fi.a12 * uy;
      const py = Fi.mcy + Fi.a21 * ux + Fi.a22 * uy;
      const hw = cb.w * K * s, hh = cb.h * K * s;     // 画布单位（套进变换后再乘）
      ctx.save();
      ctx.translate(toX(px), toY(py) + lift * sc);
      ctx.scale(sc, sc);
      ctx.transform(Fw.a11, Fw.a21, Fw.a12, Fw.a22, 0, 0);   // 形状/透视取眼皮层（眨眼被夹）
      heartGlow(ctx, 0, 0, hw, hh, 0, 0.97 * vis, '#ff3d8f');
      heart(ctx, -hw * 0.26, -hh * 0.3, hw * 0.26, hh * 0.26, -0.25, 0.8 * vis, '#ffdcef');
      ctx.restore();
    }

    // ---- 层级：抹掉被前发（刘海）挡住的部分 ----
    if (this.mask && this.hair) {
      const off = this.maskOffset();
      const mp = this.maskPos || { x: 0, y: 0 };
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(this.mask, tx + (mp.x + off.x) * sc, ty + (mp.y + off.y) * sc,
        this.mask.width * sc, this.mask.height * sc);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}
