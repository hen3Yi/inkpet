// 桌宠 · 控制中心（5 页签 · 主题 · 气泡编排器 · 语音 · 本机接口）
//   铁律：一切写盘都走主进程（center:* IPC）——本页不写文件、不 require Node 模块、不硬编码绝对路径。
//   状态来源：center:init 取一次快照；center:cfg / center:theme / center:page / center:voice / center:model 只做推送刷新，本页不轮询。
(function () {
  'use strict';

  // preload 没就绪（或静态打开预览）时安全降级：界面照常渲染，写操作静默跳过。
  var api = window.centerAPI || {};
  function callable(name) { return typeof api[name] === 'function'; }
  function $id(id) { return document.getElementById(id); }

  // ---------------------------------------------------------------- 常量表
  var MATS = { glass: '暗色玻璃', acrylic: '浅色磨砂', flat: '实色纯平' };
  var COLS = { sakura: '樱粉', celadon: '青瓷', midnight: '午夜蓝', amber: '暖砂金', ink: '墨朱' };
  var MAT_ORDER = ['glass', 'acrylic', 'flat'];
  var COL_ORDER = ['sakura', 'celadon', 'midnight', 'amber', 'ink'];
  // ★ 多角色：现在显示谁（主进程快照里的 character；mode 空串 = 排第一的那个）
  var CHAR = { mode: '', active: '', name: '', callUser: '主人', list: [], defaultCustom: '', demoLine: '' };

  // 气泡可编排项（id 与 config.bubble.items / order / levels 一一对应）
  var ITEMS = [
    { id: 'days',    label: '陪伴天数' },
    { id: 'touches', label: '被摸次数' },
    { id: 'voice',   label: '语音状态' },
    { id: 'custom',  label: '自定义文本' }
  ];
  var DEF_ITEMS = ['days', 'touches'];
  var DEF_ORDER = ['days', 'touches', 'voice', 'custom'];
  var DEF_LEVELS = { days: 'big', touches: 'big' };
  var DEF_CUSTOM = '';
  // 预览用示例台词（没有「小字」项时顶上台词行，让单行裁切效果可见）
var SAY_DEMO = '';   // 预览用的台词：取当前角色档案 lines.stats 的第一句（charSnapshot.demoLine），没有就不显示
  // 气泡尺寸（走 center:bubble 的 wPct / hPx；范围与主进程 loadCfg / applyBubblePatch 的 clamp 一致）
  var DEF_WPCT = 96, DEF_HPX = 78;
  var W_MIN = 60, W_MAX = 100, H_MIN = 40, H_MAX = 200;

  // 外观页参数（key 与主进程 TUNE_RANGE 一一对应；范围从 init.tuneRange 取，这里只是无快照时的占位）
  var TUNE_DEF = {
    swayPeriod:   { label: '摇晃周期', fmt: 'd1s' },
    swayBody:     { label: '摇晃幅度', fmt: 'd2' },
    swayZ:        { label: '左右摆幅', fmt: 'd2' },
    breathPeriod: { label: '呼吸周期', fmt: 'd1s' },
    breathAmp:    { label: '呼吸幅度', fmt: 'd2' },
    headFollow:   { label: '头部灵敏度', fmt: 'd2x' },
    eyeFollow:    { label: '眼球灵敏度', fmt: 'd2x' },
    dragTilt:     { label: '拖拽头跟随', fmt: 'd2' },
    dragBody:     { label: '拖拽身体摆幅', fmt: 'd2x' },
    limbArm:      { label: '手臂摆幅', fmt: 'd2x' },
    blinkMin:     { label: '最短间隔', fmt: 'd1s' },
    blinkMax:     { label: '最长间隔', fmt: 'd1s' },
    blinkDouble:  { label: '连眨概率', fmt: 'pct' },
    headDy:       { label: '头部下移', fmt: 'px' },
    bodySx:       { label: '身体横向', fmt: 'd2x' },
    bodySy:       { label: '身体纵向', fmt: 'd2x' },
    clickVol:     { label: '点击音量', fmt: 'pct' }
  };
  var TUNE_GROUPS = [
    { name: '呼吸 / 摇晃', keys: ['breathPeriod', 'breathAmp', 'swayPeriod', 'swayBody', 'swayZ'] },
    { name: '视线追随',   keys: ['headFollow', 'eyeFollow', 'dragTilt', 'dragBody'] },
    { name: '四肢摆动',   keys: ['limbArm'] },
    { name: '眨眼',       keys: ['blinkMin', 'blinkMax', 'blinkDouble'] },
    { name: '头部 / 身体', keys: ['headDy', 'bodySx', 'bodySy'] },
    { name: '点击反馈',   keys: ['clickVol'] }
  ];
  var CLOTH = [];   // 服装 / 配件开关清单：跟当前角色走（快照里的 clothKeys / clothLabels）
  var ROLE_KEYS = ['bodySy', 'bodySx', 'headDy'];

  // 主进程快照可能带来权威清单（clothKeys/clothLabels、bubbleItemKeys/bubbleItemLabels）：
  //   有就用它的（单一权威源），没有才用上面内置的表 —— 避免标签两处漂移。
  function setClothTable(keys, labels) {
    if (!Array.isArray(keys) || !keys.length) return;
    var byKey = {};
    CLOTH.forEach(function (c) { byKey[c.key] = c.label; });
    var next = keys.map(function (k) { return { key: k, label: (labels && labels[k]) || byKey[k] || k }; });
    CLOTH.length = 0;
    Array.prototype.push.apply(CLOTH, next);
  }
  function setItemTable(keys, labels) {
    if (!Array.isArray(keys) || !keys.length) return;
    var byKey = {};
    ITEMS.forEach(function (c) { byKey[c.id] = c.label; });
    var next = keys.map(function (k) { return { id: k, label: (labels && labels[k]) || byKey[k] || k }; });
    ITEMS.length = 0;
    Array.prototype.push.apply(ITEMS, next);
  }

  // ---------------------------------------------------------------- 状态
  var S = {
    size: 430, sizeMin: 200, sizeMax: 800, sizes: null,
    cloth: {},
    bubble: { on: true, say: true, items: DEF_ITEMS.slice(), order: DEF_ORDER.slice(), levels: clone(DEF_LEVELS), custom: DEF_CUSTOM, wPct: DEF_WPCT, hPx: DEF_HPX },
    tune: {}, tuneRange: {}, tuneDefaults: {},
    theme: { style: 'glass', color: 'sakura' },
    stats: null, mouseThrough: false, autostart: false,
    ready: false
  };
  var ORD = [];        // 运行时编排顺序（含 label / on / size / value）
  var ordSel = null;   // 选中的编排行 key

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function safeArr(v, fb) { return Array.isArray(v) && v.length ? v.slice() : fb.slice(); }

  // ---------------------------------------------------------------- 小工具
  var toastT = null;
  function toast(msg) {
    var t = $id('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove('on'); }, 1700);
  }
  function fmtVal(mode, n) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    if (mode === 'd1s') return v.toFixed(1) + ' s';
    if (mode === 'd2x') return v.toFixed(2) + '×';
    if (mode === 'd2') return v.toFixed(2);
    if (mode === 'pct') return Math.round(v * 100) + ' %';
    if (mode === 'px') return Math.round(v) + ' px';
    if (mode === 'pctv') return Math.round(v) + '%';    // 值本身就是百分数（气泡宽度）
    if (mode === 'pxv') return Math.round(v) + 'px';    // 值本身就是 px（气泡高度）
    if (mode === 'sec') return Math.round(v) + ' 秒';
    if (mode === 'min') return v > 0 ? Math.round(v) + ' 分钟' : '不说';
    return String(v);
  }
  function rangeOf(key) {
    var r = S.tuneRange && S.tuneRange[key];
    if (Array.isArray(r) && r.length >= 2) return { min: Number(r[0]), max: Number(r[1]), step: Number(r[2] || 0.01) };
    return { min: 0, max: 1, step: 0.01 };
  }
  function defOf(key) {
    var d = S.tuneDefaults && S.tuneDefaults[key];
    if (typeof d === 'number') return d;
    var r = rangeOf(key);
    return r.min;
  }
  function tuneOf(key) {
    var v = S.tune && S.tune[key];
    return typeof v === 'number' ? v : defOf(key);
  }

  // ---------------------------------------------------------------- 主题
  function applyTheme(save) {
    var de = document.documentElement;
    de.className = de.className
      .replace(/\bm-[a-z]+\b/g, '')
      .replace(/\bc-[a-z]+\b/g, '')
      .replace(/\s+/g, ' ').trim();
    de.classList.add('m-' + S.theme.style);
    de.classList.add('c-' + S.theme.color);

    var chips = document.querySelectorAll('#mats .chip');
    for (var i = 0; i < chips.length; i++) chips[i].classList.toggle('on', chips[i].getAttribute('data-mat') === S.theme.style);
    var sws = document.querySelectorAll('#swatches .sw');
    for (var j = 0; j < sws.length; j++) sws[j].classList.toggle('on', sws[j].getAttribute('data-col') === S.theme.color);
    var cur = $id('curTheme');
    if (cur) cur.textContent = '当前：' + (MATS[S.theme.style] || S.theme.style) + ' · ' + (COLS[S.theme.color] || S.theme.color);
    if (save !== false) renderPreview();
  }
  function setTheme(style, color, silent) {
    if (MATS[style]) S.theme.style = style;
    if (COLS[color]) S.theme.color = color;
    applyTheme(true);
    if (callable('setTheme')) api.setTheme(S.theme.style, S.theme.color);
    if (!silent) toast('主题：' + (MATS[S.theme.style] || '') + ' · ' + (COLS[S.theme.color] || ''));
  }

  // ---------------------------------------------------------------- 行构造
  function makeSliderRow(o) {
    // o: { key, label, min, max, step, value, fmt, search, onInput, onReset }
    var row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('data-key', o.key);
    if (o.search) row.setAttribute('data-search', o.search);

    var t = document.createElement('span'); t.className = 't';
    t.append(document.createTextNode(o.label));
    var k = document.createElement('span'); k.className = 'k'; k.textContent = o.key;
    t.append(k);

    var r = document.createElement('input');
    r.type = 'range';
    r.min = o.min; r.max = o.max; r.step = o.step; r.value = o.value;

    var v = document.createElement('span'); v.className = 'v'; v.textContent = fmtVal(o.fmt, o.value);
    var rb = document.createElement('button'); rb.className = 'rb'; rb.title = '复位'; rb.textContent = '↺';

    var th = 0;
    r.addEventListener('input', function () {
      v.textContent = fmtVal(o.fmt, r.value);
      clearTimeout(th);
      th = setTimeout(function () { o.onInput(Number(r.value)); }, 20);
    });
    function doReset() {
      var d = o.defVal;
      r.value = d; v.textContent = fmtVal(o.fmt, d);
      row.classList.add('flash');
      setTimeout(function () { row.classList.remove('flash'); }, 450);
      o.onReset(d);
    }
    rb.addEventListener('click', doReset);
    v.addEventListener('dblclick', doReset);      // 双击数值＝复位
    row.dataset.reset = '1';
    row.__reset = doReset;

    row.append(t, r, v, rb);
    return row;
  }

  function makeSwitchRow(o) {
    // o: { id, label, sub, search, value, onChange }
    var row = document.createElement('div');
    row.className = 'row';
    if (o.search) row.setAttribute('data-search', o.search);
    var t = document.createElement('span'); t.className = 't';
    t.append(document.createTextNode(o.label));
    var k = document.createElement('span'); k.className = 'k'; k.textContent = o.id;
    t.append(k);
    var sp = document.createElement('span');
    sp.style.flex = '1'; sp.style.fontSize = '11px'; sp.style.color = 'var(--dim)';
    sp.textContent = o.sub || '';
    var sw = document.createElement('button');
    sw.className = 'sw-on' + (o.value ? ' on' : '');
    sw.title = '切换';
    sw.addEventListener('click', function () {
      var on = !sw.classList.contains('on');
      sw.classList.toggle('on', on);
      o.onChange(on, sw);
    });
    row.append(t, sp, sw);
    row.__sw = sw;
    return row;
  }

  // ---------------------------------------------------------------- 角色页
  // ★ 多角色：「显示谁」一排 + 标题跟着角色名
  function renderChars() {
    var nm = CHAR.name || '桌宠';
    var title = $id('ccTitle'); if (title) title.textContent = nm + ' · 控制中心';
    document.title = nm + ' · 控制中心';
    var box = $id('charChips');
    if (!box) return;
    box.replaceChildren();
    (CHAR.list || []).forEach(function (it) {
      var b = document.createElement('button');
      b.className = 'chip' + (CHAR.active === it.id ? ' on' : '');
      b.textContent = it.name;
      b.addEventListener('click', function () {
        if (callable('setCharacter')) api.setCharacter(it.id);
        toast('显示' + it.name);
      });
      box.append(b);
    });
    var hint = $id('charHint');
    if (hint) {
      hint.textContent = (CHAR.list || []).length
        ? ('现在显示' + nm + '。自己加角色：在用户数据目录的 characters/ 里放一份角色档案（见 docs/）。')
        : '还没有角色：把模型放进 assets/live2d/，在 characters/ 里写一份角色档案（见 README）。';
    }
  }
  // 拖动中的滑条不要被重建打断（center:cfg 回推会在拖动过程中到达）
  function sliderBusy(container) {
    var a = document.activeElement;
    return !!(a && a.tagName === 'INPUT' && a.type === 'range' && container && container.contains(a));
  }

  function renderRole() {
    var box = $id('roleSliders');
    if (!box) return;
    if (sliderBusy(box)) return;
    box.replaceChildren();

    // 大小（走 center:size；不改窗口几何，由主进程按既有口径处理）
    box.append(makeSliderRow({
      key: 'size', label: '大小', min: S.sizeMin, max: S.sizeMax, step: 10, value: S.size, fmt: 'px',
      defVal: 430, search: '大小 size scale 角色尺寸 缩放',
      onInput: function (v) { S.size = v; if (callable('setSize')) api.setSize(v); },
      onReset: function (d) { S.size = d; if (callable('setSize')) api.setSize(d); toast('大小已复位'); }
    }));

    // 身体比例三项（走 center:tune）
    ROLE_KEYS.forEach(function (key) {
      var r = rangeOf(key), d = defOf(key);
      box.append(makeSliderRow({
        key: key, label: TUNE_DEF[key].label, min: r.min, max: r.max, step: r.step, value: tuneOf(key), fmt: TUNE_DEF[key].fmt,
        defVal: d, search: TUNE_DEF[key].label + ' ' + key + ' 身体 比例 头 脖子',
        onInput: function (v) { S.tune[key] = v; sendTune(key, v); },
        onReset: function () { resetTuneTo(key, d); }
      }));
    });

    var cb = $id('clothBox');
    if (cb) {
      cb.replaceChildren();
      CLOTH.forEach(function (c) {
        var lab = document.createElement('label'); lab.className = 'chk';
        lab.setAttribute('data-search', '服装 ' + c.label + ' ' + c.key + ' cloth');
        var inp = document.createElement('input');
        inp.type = 'checkbox'; inp.checked = S.cloth[c.key] !== false;
        inp.addEventListener('change', function () {
          S.cloth[c.key] = inp.checked;
          if (callable('setCloth')) api.setCloth(c.key, inp.checked);
          toast(c.label + '：' + (inp.checked ? '显示' : '隐藏'));
        });
        lab.append(inp, document.createTextNode(c.label));
        lab.__chk = inp;
        cb.append(lab);
      });
    }
  }

  // ---------------------------------------------------------------- 外观页
  function renderLook() {
    var box = $id('tuneGroups');
    if (!box) return;
    if (sliderBusy(box)) return;
    box.replaceChildren();
    TUNE_GROUPS.forEach(function (g) {
      var head = document.createElement('div');
      head.className = 'secT';
      head.textContent = g.name;
      box.append(head);
      g.keys.forEach(function (key) {
        var d = TUNE_DEF[key]; if (!d) return;
        var r = rangeOf(key), dv = defOf(key);
        box.append(makeSliderRow({
          key: key, label: d.label, min: r.min, max: r.max, step: r.step, value: tuneOf(key), fmt: d.fmt,
          defVal: dv, search: d.label + ' ' + key + ' 外观 参数 动作 tune',
          onInput: function (v) { S.tune[key] = v; sendTune(key, v); },
          onReset: function () { resetTuneTo(key, dv); }
        }));
      });
    });
  }
  function sendTune(key, value) {
    if (callable('setTune')) api.setTune(key, value);
  }
  function resetTuneTo(key, d) {
    S.tune[key] = d;
    if (callable('resetTune')) api.resetTune(key);   // 主进程复位（权威源）后会回推 cfg
    sendTune(key, d);
    toast(TUNE_DEF[key].label + ' 已复位');
  }

  // ---------------------------------------------------------------- 气泡与数据
  function buildOrd() {
    var order = safeArr(S.bubble.order, DEF_ORDER);
    var items = safeArr(S.bubble.items, DEF_ITEMS);
    var levels = (S.bubble.levels && typeof S.bubble.levels === 'object') ? S.bubble.levels : DEF_LEVELS;
    var known = {};
    ITEMS.forEach(function (it) { known[it.id] = it; });
    var list = [];
    order.forEach(function (id) { if (known[id]) { list.push(id); delete known[id]; } });
    ITEMS.forEach(function (it) { if (known[it.id]) list.push(it.id); });   // 新项补到末尾
    ORD = list.map(function (id) {
      return {
        key: id,
        label: (ITEMS.filter(function (x) { return x.id === id; })[0] || { label: id }).label,
        on: items.indexOf(id) >= 0,
        size: levels[id] === 'big' ? 'big' : 'small'
      };
    });
  }
  // 补丁式更新：only 指定这次只发哪些键（滑条只发 wPct / hPx，绝不整对象覆盖编排）
  function pushBubble(only) {
    if (!callable('setBubble')) return;
    function want(k) { return !only || only.indexOf(k) >= 0; }
    var patch = {};
    if (want('wPct')) patch.wPct = clampPct(S.bubble.wPct);
    if (want('hPx')) patch.hPx = clampHpx(S.bubble.hPx);
    if (want('items')) {
      var items = [], levels = {};
      ORD.forEach(function (it) { if (it.on) items.push(it.key); levels[it.key] = it.size; });
      var order = ORD.map(function (it) { return it.key; });
      S.bubble.items = items; S.bubble.order = order; S.bubble.levels = levels;
      patch.items = items; patch.order = order; patch.levels = levels; patch.custom = S.bubble.custom;
    }
    api.setBubble(patch);
  }
  function clampPct(v) {
    var n = Math.round(Number(v));
    return isFinite(n) ? Math.max(W_MIN, Math.min(W_MAX, n)) : DEF_WPCT;
  }
  function clampHpx(v) {
    var n = Math.round(Number(v));
    return isFinite(n) ? Math.max(H_MIN, Math.min(H_MAX, n)) : DEF_HPX;
  }

  function itemValue(id) {
    var st = S.stats || {};
    if (id === 'days') {
      if (typeof st.days === 'number') return st.days + ' 天';
      var ms = (typeof st.ms === 'number') ? st.ms : ((typeof st.totalMs === 'number') ? st.totalMs : 0);
      return ms > 0 ? ((ms / 86400000).toFixed(1) + ' 天') : '—';
    }
    if (id === 'touches') return (typeof st.clicks === 'number') ? (st.clicks + ' 次') : '—';
    if (id === 'voice') return VOICE.config && !VOICE.config.enabled ? '关' : (VOICE.state || '待机');
    if (id === 'custom') return S.bubble.custom || DEF_CUSTOM;
    return '—';
  }

  function renderOrd() {
    var wrap = $id('ordWrap');
    if (!wrap) return;
    wrap.replaceChildren();
    ORD.forEach(function (it, idx) {
      var row = document.createElement('div');
      row.className = 'ordRow' + (ordSel === it.key ? ' sel' : '');
      row.setAttribute('data-key', it.key);
      row.setAttribute('data-search', '气泡项 ' + it.label + ' ' + it.key + ' ' + (it.size === 'big' ? '大字' : '小字') + ' order item');

      var grip = document.createElement('span'); grip.className = 'grip'; grip.textContent = '⋮⋮';
      var chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = it.on;
      var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = it.label;
      var sz = document.createElement('button'); sz.type = 'button';
      sz.className = 'sz' + (it.size === 'big' ? ' big' : '');
      sz.textContent = it.size === 'big' ? '大字' : '小字';
      sz.title = '点击切换大字 / 小字';
      var up = document.createElement('button'); up.type = 'button'; up.className = 'mv'; up.textContent = '↑'; up.title = '上移';
      var dn = document.createElement('button'); dn.type = 'button'; dn.className = 'mv'; dn.textContent = '↓'; dn.title = '下移';

      chk.addEventListener('change', function () { it.on = chk.checked; renderOrd(); renderPreview(); pushBubble(); });
      sz.addEventListener('click', function () {
        it.size = it.size === 'big' ? 'small' : 'big';
        renderOrd(); renderPreview(); pushBubble();
      });
      up.addEventListener('click', function (e) { e.stopPropagation(); moveOrd(idx, -1); });
      dn.addEventListener('click', function (e) { e.stopPropagation(); moveOrd(idx, 1); });
      row.addEventListener('click', function (e) {
        if (e.target === chk || e.target === sz || e.target.tagName === 'BUTTON') return;
        ordSel = it.key; renderOrd();
      });

      // 自定义文本：就地输入
      if (it.key === 'custom') {
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.value = S.bubble.custom || CHAR.defaultCustom || DEF_CUSTOM;
        inp.placeholder = '想让她点一下就说的那句话';
        inp.style.cssText = 'flex:1;min-width:60px;height:22px;border-radius:6px;padding:0 7px;font-size:11px;' +
          'background:var(--surfSolid);border:1px solid var(--rowBd);color:var(--ink);outline:none';
        var deb = 0;
        inp.addEventListener('input', function () {
          S.bubble.custom = inp.value;
          clearTimeout(deb);
          deb = setTimeout(function () { renderPreview(); pushBubble(); }, 300);
        });
        inp.addEventListener('click', function (e) { e.stopPropagation(); ordSel = it.key; renderOrd(); });
        row.append(grip, chk, nm, inp, sz, up, dn);
      } else {
        row.append(grip, chk, nm, sz, up, dn);
      }
      wrap.append(row);
    });
  }
  function moveOrd(idx, dir) {
    var to = idx + dir;
    if (to < 0 || to >= ORD.length) return;
    var t = ORD[idx]; ORD[idx] = ORD[to]; ORD[to] = t;
    ordSel = t.key;
    renderOrd(); renderPreview(); pushBubble();
    toast('已' + (dir < 0 ? '上移' : '下移') + '：' + t.label);
  }
  function bigItems() { return ORD.filter(function (it) { return it.on && it.size === 'big'; }); }
  function smallItems() { return ORD.filter(function (it) { return it.on && it.size === 'small'; }); }
  function bigLineText() {
    return bigItems().map(function (it) { return it.label + ' ' + itemValue(it.key); }).join(' · ');
  }
  function smallLineText() {
    return smallItems().map(function (it) {
      return it.key === 'custom' ? itemValue(it.key) : (it.label + ' ' + itemValue(it.key));
    }).join(' · ');
  }
  function renderPreview() {
    var box = $id('preview'); if (!box) return;
    box.replaceChildren();

    // 气泡尺寸：宽度＝窗宽 × wPct%，高度＝hPx（与宿主侧同一口径）
    var wPct = clampPct(S.bubble.wPct);
    var hPx = clampHpx(S.bubble.hPx);
    var winW = (typeof S.size === 'number' && S.size > 0) ? S.size : 200;
    var base = Math.min(winW, 320);   // 预览区放不下就等比缩着示意（小字里注明）

    var stage = document.createElement('div');
    stage.className = 'pvStage';
    stage.style.width = base + 'px';
    stage.style.height = Math.max(hPx + 12, 120) + 'px';

    var pv = document.createElement('div');
    pv.className = 'pvBox';
    pv.style.width = wPct + '%';
    pv.style.height = hPx + 'px';

    var bigs = bigItems(), smalls = smallItems();
    if (!bigs.length && !smalls.length) {
      var e = document.createElement('div'); e.className = 'pEmpty';
      e.textContent = '（什么都没勾）';
      pv.append(e);
    } else {
      if (bigs.length) {
        var d = document.createElement('div'); d.className = 'pData';
        bigs.forEach(function (it, i) {
          if (i) d.append(document.createTextNode('  ·  '));
          var s = document.createElement('span');
          s.append(document.createTextNode(it.label + ' '));
          var b = document.createElement('b'); b.textContent = itemValue(it.key);
          s.append(b); d.append(s);
        });
        pv.append(d);
      }
      if (smalls.length) {
        var s2 = document.createElement('div'); s2.className = 'pSay'; s2.textContent = smallLineText();
        pv.append(s2);
      } else {
        // 没有小字项：台词行仍会在说话时出现 ⇒ 放一句示例，单行裁切一眼可见
        var s3 = document.createElement('div'); s3.className = 'pSay'; s3.textContent = CHAR.demoLine || SAY_DEMO;
        pv.append(s3);
      }
    }
    stage.append(pv);
    box.append(stage);

    var note = document.createElement('div');
    note.className = 'pvNote';
    note.textContent = '窗宽 ' + base + 'px' + (base === winW ? '' : '（示意）') +
      ' · 气泡 ' + wPct + '% × ' + hPx + 'px · 数据行与台词行都是单行' +
      (smalls.length ? '' : '（台词行示例）');
    box.append(note);
  }

  // ---------------------------------------------------------------- 气泡尺寸（气泡与数据页）
  function renderSizeRows() {
    var box = $id('sizeRows');
    if (!box) return;
    if (sliderBusy(box)) return;
    box.replaceChildren();

    box.append(makeSliderRow({
      key: 'wPct', label: '宽度', min: W_MIN, max: W_MAX, step: 1,
      value: clampPct(S.bubble.wPct), fmt: 'pctv', defVal: DEF_WPCT,
      search: '气泡宽度 wPct 宽 尺寸 气泡 比例',
      onInput: function (v) { S.bubble.wPct = clampPct(v); renderPreview(); pushBubble(['wPct']); },
      onReset: function () { S.bubble.wPct = DEF_WPCT; renderPreview(); pushBubble(['wPct']); toast('气泡宽度已复位 ' + DEF_WPCT + '%'); }
    }));

    box.append(makeSliderRow({
      key: 'hPx', label: '高度', min: H_MIN, max: H_MAX, step: 1,
      value: clampHpx(S.bubble.hPx), fmt: 'pxv', defVal: DEF_HPX,
      search: '气泡高度 hPx 高 尺寸 气泡 横条',
      onInput: function (v) { S.bubble.hPx = clampHpx(v); renderPreview(); pushBubble(['hPx']); },
      onReset: function () { S.bubble.hPx = DEF_HPX; renderPreview(); pushBubble(['hPx']); toast('气泡高度已复位 ' + DEF_HPX + 'px'); }
    }));

    var note = document.createElement('p');
    note.className = 'hd';
    note.style.margin = '2px 0 0';
    note.textContent = '宽度＝桌宠窗宽的百分比（60–100%），高度＝像素（40–200）—— 拖完立刻看下方预览。';
    box.append(note);
  }

  // ---------------------------------------------------------------- 语音页
  //   主进程推 center:voice：{ config（不含密钥；qwen.hasKey 说填没填）, state, lastError, engines:[{id,name,note}], qwenVoices:[{id,name}] }
  var VOICE = { config: null, state: '待机', lastError: '', engines: [], qwenVoices: [], sysVoices: null };
  function voiceSet(patch, okMsg) {
    if (!callable('voiceSet')) { toast('语音通道未就绪'); return; }
    api.voiceSet(patch).then(function (v) { applyVoice(v); if (okMsg) toast(okMsg); })
      .catch(function (e) { toast('没改成：' + (e && e.message ? e.message : String(e))); });
  }
  function applyVoice(v) {
    if (!v || typeof v !== 'object') return;
    if (v.config) VOICE.config = v.config;
    if (typeof v.state === 'string') VOICE.state = v.state;
    VOICE.lastError = v.lastError || '';
    if (Array.isArray(v.engines)) VOICE.engines = v.engines;
    if (Array.isArray(v.qwenVoices)) VOICE.qwenVoices = v.qwenVoices;
    renderVoice();
    renderPreview();
  }
  function refreshVoice() {
    if (!callable('voiceGet')) return;
    api.voiceGet().then(applyVoice).catch(function () {});
  }
  // 仅在用户主动勾选系统语音或点刷新时枚举，不在打开语音页时自动接入。
  function loadSysVoices(force) {
    if (!callable('voiceSystemList') || (VOICE.sysVoices && !force)) return;
    api.voiceSystemList().then(function (list) {
      VOICE.sysVoices = Array.isArray(list) ? list : [];
      renderVoice();
      if (force) toast('找到 ' + VOICE.sysVoices.length + ' 个系统语音');
    });
  }
  function renderVoice() {
    var c = VOICE.config;
    var st = $id('voiceState');
    if (st) st.textContent = c ? (c.enabled ? '现在：' + VOICE.state : '关着：只出气泡、不出声') : '—';
    var sw = $id('voiceSw'); if (sw) sw.classList.toggle('on', !!(c && c.enabled));
    var er = $id('voiceErr'); if (er) er.textContent = VOICE.lastError ? ('上一句没念出来：' + VOICE.lastError) : '';
    if (!c) return;
    var sysOptions = $id('sysVoiceOptions');
    if (sysOptions) sysOptions.hidden = c.engines.indexOf('system') < 0;
    // 合成服务：勾选 + 上下移（勾上的按顺序试，没勾的排在后面）
    var box = $id('engineRows');
    if (box) {
      box.replaceChildren();
      var order = c.engines.slice();
      VOICE.engines.forEach(function (e) { if (order.indexOf(e.id) < 0) order.push(e.id); });
      order.forEach(function (id) {
        var e = VOICE.engines.filter(function (x) { return x.id === id; })[0];
        if (!e) return;
        var pos = c.engines.indexOf(id), on = pos >= 0;
        var row = document.createElement('div'); row.className = 'row engRow';
        var lab = document.createElement('label'); lab.className = 'chk'; lab.style.cssText = 'padding:0;background:none;border:0';
        var chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = on;
        lab.append(chk);
        var nm = document.createElement('span'); nm.className = 'nm';
        nm.textContent = (on ? (pos + 1) + '. ' : '') + e.name + (id === 'qwen' && !c.qwen.hasKey ? '（还没填 Key）' : '');
        var nt = document.createElement('span'); nt.className = 'nt'; nt.textContent = e.note || '';
        nm.append(nt);
        var ord = document.createElement('span'); ord.className = 'ord';
        var up = document.createElement('button'); up.className = 'rb'; up.textContent = '↑'; up.title = '往前挪';
        var dn = document.createElement('button'); dn.className = 'rb'; dn.textContent = '↓'; dn.title = '往后挪';
        up.disabled = !on || pos === 0;
        dn.disabled = !on || pos === c.engines.length - 1;
        ord.append(up, dn);
        chk.addEventListener('change', function () {
          var list = c.engines.slice();
          if (chk.checked) { if (list.indexOf(id) < 0) list.push(id); } else list = list.filter(function (x) { return x !== id; });
          voiceSet({ engines: list }, e.name + '：' + (chk.checked ? '用' : '不用'));
          if (id === 'system' && chk.checked) loadSysVoices(false);
        });
        function move(d) {
          var list = c.engines.slice(), i = list.indexOf(id), j = i + d;
          if (i < 0 || j < 0 || j >= list.length) return;
          list[i] = list[j]; list[j] = id;
          voiceSet({ engines: list });
        }
        up.addEventListener('click', function () { move(-1); });
        dn.addEventListener('click', function () { move(1); });
        row.append(lab, nm, ord);
        box.append(row);
      });
      if (!c.engines.length) {
        var p = document.createElement('p'); p.className = 'hd'; p.textContent = '一个都没勾：只出气泡、不出声。'; box.append(p);
      }
    }
    // Windows 自带语音
    var sv = $id('sysVoice');
    if (sv && document.activeElement !== sv) {
      sv.replaceChildren();
      var o0 = document.createElement('option'); o0.value = ''; o0.textContent = '自动（有中文语音就用中文的）'; sv.append(o0);
      (VOICE.sysVoices || []).forEach(function (v) {
        var o = document.createElement('option'); o.value = v.name; o.textContent = v.name + (v.culture ? '（' + v.culture + '）' : ''); sv.append(o);
      });
      if (c.system.voice && !(VOICE.sysVoices || []).some(function (v) { return v.name === c.system.voice; })) {
        var ox = document.createElement('option'); ox.value = c.system.voice; ox.textContent = c.system.voice; sv.append(ox);
      }
      sv.value = c.system.voice || '';
    }
    var sr = $id('sysRows');
    if (sr && !sliderBusy(sr)) {
      sr.replaceChildren();
      sr.append(makeSliderRow({
        key: 'system.rate', label: '语速', min: -10, max: 10, step: 1, value: c.system.rate || 0, fmt: '', defVal: 0,
        search: '语速 快慢 rate windows 系统',
        onInput: function (v) { voiceSet({ system: { rate: v } }); },
        onReset: function (d) { voiceSet({ system: { rate: d } }, '语速已复位'); }
      }));
    }
    // 千问
    var qk = $id('qwenKey');
    if (qk) qk.placeholder = c.qwen.hasKey ? '已填（要换就填新的再保存）' : 'sk-…（只存在这台电脑上，加密保存）';
    var qv = $id('qwenVoice');
    if (qv && document.activeElement !== qv) {
      qv.replaceChildren();
      VOICE.qwenVoices.forEach(function (v) { var o = document.createElement('option'); o.value = v.id; o.textContent = v.id + ' · ' + v.name; qv.append(o); });
      if (c.qwen.voice && !VOICE.qwenVoices.some(function (v) { return v.id === c.qwen.voice; })) {
        var o2 = document.createElement('option'); o2.value = c.qwen.voice; o2.textContent = c.qwen.voice; qv.append(o2);
      }
      qv.value = c.qwen.voice;
    }
    var qr = $id('qwenRegion'); if (qr && document.activeElement !== qr) qr.value = c.qwen.region || 'cn';
    var hu = $id('httpUrl'); if (hu && document.activeElement !== hu) hu.value = c.http.url || '';
    // 什么时候说
    var tr = $id('talkRows');
    if (tr && !sliderBusy(tr)) {
      tr.replaceChildren();
      tr.append(makeSwitchRow({
        id: 'clickTalk', label: '点角色时念', sub: '点一下就念气泡里那句台词', value: !!c.clickTalk,
        search: '点击 念 台词 clickTalk',
        onChange: function (v) { voiceSet({ clickTalk: v }, '点角色时念：' + (v ? '开' : '关')); }
      }));
      tr.append(makeSliderRow({
        key: 'idleMinutes', label: '空闲时说一句', min: 0, max: 120, step: 5, value: c.idleMinutes || 0, fmt: 'min', defVal: 0,
        search: '空闲 自言自语 idle 多久',
        onInput: function (v) { voiceSet({ idleMinutes: v }); },
        onReset: function (d) { voiceSet({ idleMinutes: d }, '空闲时不说'); }
      }));
    }
  }
  function bindVoice() {
    var sw = $id('voiceSw');
    if (sw) sw.addEventListener('click', function () {
      var on = !(VOICE.config && VOICE.config.enabled);
      voiceSet({ enabled: on }, '出声：' + (on ? '开' : '关'));
    });
    var sv = $id('sysVoice');
    if (sv) sv.addEventListener('change', function () { voiceSet({ system: { voice: sv.value } }, '系统语音：' + (sv.value || '自动')); sv.blur(); });
    var svr = $id('sysVoiceRefresh'); if (svr) svr.addEventListener('click', function () { loadSysVoices(true); });
    var qk = $id('qwenKey'), qks = $id('qwenKeySave'), qkc = $id('qwenKeyClear');
    function saveKey() {
      var k = qk ? qk.value.trim() : '';
      if (!k) { toast('先填 API Key'); return; }
      voiceSet({ qwen: { key: k } }, 'API Key 已保存');
      qk.value = '';
    }
    if (qks) qks.addEventListener('click', saveKey);
    if (qk) qk.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveKey(); } });
    if (qkc) qkc.addEventListener('click', function () { voiceSet({ qwen: { key: '' } }, 'API Key 已清掉'); });
    var qv = $id('qwenVoice');
    if (qv) qv.addEventListener('change', function () { voiceSet({ qwen: { voice: qv.value } }, '音色：' + qv.value); qv.blur(); });
    var qvc = $id('qwenVoiceCustom');
    if (qvc) qvc.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var v = qvc.value.trim(); if (!v) return;
      voiceSet({ qwen: { voice: v } }, '音色：' + v);
      qvc.value = '';
    });
    var qr = $id('qwenRegion');
    if (qr) qr.addEventListener('change', function () { voiceSet({ qwen: { region: qr.value } }, '地域：' + (qr.value === 'intl' ? '新加坡' : '北京')); qr.blur(); });
    var hu = $id('httpUrl'), hus = $id('httpUrlSave');
    function saveUrl() { voiceSet({ http: { url: hu ? hu.value.trim() : '' } }, '接口地址已保存'); }
    if (hus) hus.addEventListener('click', saveUrl);
    if (hu) hu.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveUrl(); } });
    var vt = $id('voiceTest');
    if (vt) vt.addEventListener('click', function () {
      if (!callable('voiceTest')) return;
      toast('试听中…');
      api.voiceTest('').then(function (r) { if (!r || !r.ok) toast('没念出来：' + ((r && r.error) || '未知')); refreshVoice(); });
    });
    var vs = $id('voiceStop'); if (vs) vs.addEventListener('click', function () { if (callable('voiceStop')) api.voiceStop(); toast('停下了'); });
  }

  // ---------------------------------------------------------------- 系统页 · 本机接口 / 数据目录
  var API = null, DATA_DIR = '';
  function renderApi() {
    var a = API || {};
    var pill = $id('apiPill'), meta = $id('apiMeta'), tg = $id('apiToggle');
    if (pill) pill.textContent = !a.enabled ? '关着' : (a.listening ? '开着' : (a.error ? '出错' : '启动中'));
    if (meta) {
      meta.textContent = !a.enabled ? '关着：插件连不上桌宠。'
        : (a.error ? a.error : ('地址 ' + (a.url || '—') + ' ｜ 令牌存在 ' + (a.tokenFile || '—')));
    }
    if (tg) tg.textContent = a.enabled ? '关掉' : '打开';
    var dd = $id('dataDir'); if (dd) dd.textContent = DATA_DIR ? ('设置、统计、日志、自己加的角色都在：' + DATA_DIR) : '—';
  }
  function apiCmd(cmd, okText) {
    if (!callable('api')) return;
    api.api(cmd).then(function (r) {
      if (r && typeof r.port === 'number') API = r;
      renderApi();
      if (okText) toast(okText);
      if (cmd === 'toggle') setTimeout(function () { apiCmd('info'); }, 600);   // 端口开好要一会儿
    });
  }

  // ---------------------------------------------------------------- 系统页 · 模型（PSD 实时生成）
  //   主进程推 center:model：{ id, name, psd, exists, missing[], state: idle|wait|build|ok|error, stage, startedAt, endedAt, ms, why, message, notes[], warnings[] }
  var MODEL = null, modelTimer = null;
  function hhmmss(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function renderModel() {
    var title = $id('modelTitle');
    if (!title) return;
    var m = MODEL || {};
    var pill = $id('modelPill'), pth = $id('modelPath'), meta = $id('modelMeta'), notes = $id('modelNotes');
    var wbox = $id('modelWarnBox'), wsum = $id('modelWarnSum'), wl = $id('modelWarn');
    var bOpen = $id('modelOpen'), bRe = $id('modelRebuild'), bDir = $id('modelFolder');
    title.textContent = (m.name || CHAR.name || '当前角色') + '的模型';
    var building = m.state === 'build' || m.state === 'wait';
    if (bOpen) bOpen.disabled = !m.psd || !m.exists;
    if (bDir) bDir.disabled = !m.psd || !m.exists;
    if (bRe) bRe.disabled = !m.psd || !m.exists || building;
    clearInterval(modelTimer); modelTimer = null;
    if (!m.psd) {
      if (pill) pill.textContent = '没有 PSD';
      if (pth) pth.textContent = (m.name || '这个角色') + '的档案里没有登记 PSD，这里改不了模型。';
      if (meta) meta.textContent = '';
    } else {
      if (pth) { pth.textContent = m.psd; pth.title = m.psd; }
      var label = { idle: '待命', wait: '等存完', build: '生成中', ok: '已更新', error: '失败' }[m.state] || '待命';
      if (pill) pill.textContent = m.exists ? label : '找不到文件';
      var text = '';
      if (!m.exists) text = '找不到这个 PSD 文件。';
      else if (m.missing && m.missing.length) text = '缺生成工具：' + m.missing.join('、');
      else if (m.state === 'wait') text = 'PSD 刚改过，等它存完就开始生成…';
      else if (m.state === 'build') {
        var tick = function () {
          if (meta) meta.textContent = '正在生成：' + (m.stage || '…') + '（已用 ' + Math.max(0, Math.round((Date.now() - (m.startedAt || Date.now())) / 1000)) + ' 秒）';
        };
        tick();
        modelTimer = setInterval(tick, 1000);
      } else if (m.state === 'ok') {
        text = hhmmss(m.endedAt || Date.now()) + ' 更新好了（用时 ' + ((m.ms || 0) / 1000).toFixed(1) + ' 秒' + (m.why === 'manual' ? '，手动' : '') + '）。接着改、保存，桌宠会再换上。';
      } else if (m.state === 'error') {
        text = '生成失败，桌宠还是上一版：' + (m.message || '原因不明');
      } else text = '在 Photoshop 里改完按 Ctrl+S 保存，桌宠几秒后就换上新样子。';
      if (meta && m.state !== 'build') meta.textContent = text;
    }
    if (notes) notes.textContent = (m.notes && m.notes.length) ? ('整理 PSD：' + m.notes.join('；')) : '';
    var unk = $id('modelUnknown');
    if (unk) unk.textContent = (m.state === 'ok' && m.unknown && m.unknown.length)
      ? ('生成工具不认识这些图层名（照样显示，但不会当成嘴、眼睛这些部件来动）：' + m.unknown.join('、')) : '';
    var warns = (m.state === 'ok' && m.warnings) ? m.warnings : [];
    if (wbox) wbox.style.display = warns.length ? '' : 'none';
    if (wsum) wsum.textContent = '生成工具的提示 ' + warns.length + ' 条（一般不影响使用）';
    if (wl) {
      wl.replaceChildren();
      warns.forEach(function (w, i) {
        if (i) wl.append(document.createElement('br'));
        wl.append(document.createTextNode(w));
      });
    }
  }
  function modelCmd(cmd, okText) {
    if (!callable('model')) { toast('模型通道未就绪（center:model）'); return; }
    api.model(cmd).then(function (r) {
      if (r && r.ok) { if (okText) toast(okText); } else toast('没成：' + ((r && r.error) || '未知原因'));
    }).catch(function (e) { toast('没成：' + (e && e.message ? e.message : String(e))); });
  }

  // ---------------------------------------------------------------- 快照消费
  function applyCfg(snap, initial) {
    if (!snap || typeof snap !== 'object') return;

    if (typeof snap.size === 'number') S.size = snap.size;
    if (typeof snap.sizeMin === 'number') S.sizeMin = snap.sizeMin;
    if (typeof snap.sizeMax === 'number') S.sizeMax = snap.sizeMax;
    if (snap.sizes) S.sizes = snap.sizes;

    // ★ 多角色：衣服清单跟角色走 ⇒ 先换清单再读开关（换角色时旧角色的开关不留）
    if (snap.character && typeof snap.character === 'object') CHAR = snap.character;
    setClothTable(snap.clothKeys, snap.clothLabels);
    if (snap.cloth && typeof snap.cloth === 'object') {
      S.cloth = {};
      CLOTH.forEach(function (c) { S.cloth[c.key] = snap.cloth[c.key] !== false; });
    }
    if (snap.bubble && typeof snap.bubble === 'object') {
      var b = snap.bubble;
      if (typeof b.on === 'boolean') S.bubble.on = b.on;
      if (typeof b.say === 'boolean') S.bubble.say = b.say;
      if (Array.isArray(b.items)) S.bubble.items = b.items.slice();
      if (Array.isArray(b.order)) S.bubble.order = b.order.slice();
      if (b.levels && typeof b.levels === 'object') S.bubble.levels = clone(b.levels);
      if (typeof b.custom === 'string') S.bubble.custom = b.custom;
      if (typeof b.wPct === 'number' && isFinite(b.wPct)) S.bubble.wPct = clampPct(b.wPct);
      if (typeof b.hPx === 'number' && isFinite(b.hPx)) S.bubble.hPx = clampHpx(b.hPx);
    }
    if (snap.tune && typeof snap.tune === 'object') S.tune = clone(snap.tune);
    if (snap.tuneRange && typeof snap.tuneRange === 'object') S.tuneRange = clone(snap.tuneRange);
    if (snap.tuneDefaults && typeof snap.tuneDefaults === 'object') S.tuneDefaults = clone(snap.tuneDefaults);
    // 权威清单（有则覆盖内置表，保证标签与主进程一致；衣服清单上面已经按角色换过）
    setItemTable(snap.bubbleItemKeys, snap.bubbleItemLabels);
    if (snap.theme && typeof snap.theme === 'object') {
      if (MATS[snap.theme.style]) S.theme.style = snap.theme.style;
      if (COLS[snap.theme.color]) S.theme.color = snap.theme.color;
    }
    if (snap.stats && typeof snap.stats === 'object') S.stats = snap.stats;
    if (typeof snap.mouseThrough === 'boolean') S.mouseThrough = snap.mouseThrough;
    if (typeof snap.autostart === 'boolean') S.autostart = snap.autostart;
    if (snap.model && typeof snap.model === 'object') MODEL = snap.model;   // ★ 当前角色的 PSD / 生成状态（换角色时跟着换）
    if (snap.voice && typeof snap.voice === 'object') applyVoice(snap.voice);
    if (snap.api && typeof snap.api === 'object') API = snap.api;
    if (typeof snap.dataDir === 'string') DATA_DIR = snap.dataDir;

    applyTheme(false);
    renderAll();
    if (initial) {
      S.ready = true;
      if (typeof snap.page === 'string' && snap.page) setTab(snap.page);   // 主进程记住的页
    }
  }

  function renderAll() {
    renderChars();
    renderRole();
    renderLook();
    renderSizeRows();
    buildOrd();
    renderOrd();
    renderPreview();
    renderApi();
    renderModel();

    var onSw = $id('bubbleOnSw'); if (onSw) onSw.classList.toggle('on', S.bubble.on !== false);
    var saySw = $id('bubbleSaySw'); if (saySw) saySw.classList.toggle('on', S.bubble.say !== false);
    var thr = $id('throughSw'); if (thr) thr.classList.toggle('on', !!S.mouseThrough);
    var auto = $id('autostartSw'); if (auto) auto.classList.toggle('on', !!S.autostart);
  }

  // ---------------------------------------------------------------- 5 页签
  var currentTab = 'role';
  function setTab(k) {
    var tabs = document.querySelectorAll('#rail .tab');
    var ok = false;
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tab') === k;
      if (on) ok = true;
      tabs[i].classList.toggle('on', on);
    }
    if (!ok) return;
    currentTab = k;
    var search = $id('search');
    if (search) search.value = '';
    applySearch();
    // 切到语音页只取设置；不自动枚举系统语音。
    if (k === 'voice') refreshVoice();
    if (k === 'system') apiCmd('info');
  }

  // ---------------------------------------------------------------- 搜索
  function applySearch() {
    var search = $id('search'), hint = $id('hint');
    if (!search) return;
    var q = search.value.trim().toLowerCase();
    var pages = document.querySelectorAll('#pane .page');
    var ordWrap = $id('ordWrap'), pv = $id('preview'), pvT = null;

    if (!q) {
      Array.prototype.forEach.call(pages, function (p) {
        p.style.display = (p.getAttribute('data-page') === currentTab) ? 'block' : 'none';
        Array.prototype.forEach.call(p.querySelectorAll('[data-search]'), function (r) {
          if (r.classList.contains('row')) r.style.display = 'flex';
          else r.style.display = '';
        });
      });
      if (ordWrap) ordWrap.style.display = '';
      if (pv) pv.style.display = '';
      if (hint) hint.textContent = '';
      return;
    }

    var total = 0;
    Array.prototype.forEach.call(pages, function (pg) {
      var hits = 0;
      Array.prototype.forEach.call(pg.querySelectorAll('[data-search]'), function (r) {
        // 编排器「容器」不参与判定：由内部命中的行决定显隐（否则容器一藏，命中的行也看不见）
        if (r.classList.contains('ordBlock')) return;
        var hay = ((r.getAttribute('data-search') || '') + ' ' + r.textContent).toLowerCase();
        var hit = hay.indexOf(q) >= 0;
        if (r.classList.contains('row')) r.style.display = hit ? 'flex' : 'none';
        else r.style.display = hit ? '' : 'none';
        if (hit) hits++;
      });
      pg.style.display = hits ? 'block' : 'none';
      total += hits;
    });
    var ordHits = 0;
    if (ordWrap) {
      Array.prototype.forEach.call(ordWrap.querySelectorAll('.ordRow'), function (r) {
        if (r.style.display !== 'none' && r.textContent.toLowerCase().indexOf(q) >= 0) ordHits++;
        else if (r.style.display !== 'none' && ((r.getAttribute('data-search') || '') + ' ' + r.textContent).toLowerCase().indexOf(q) >= 0) ordHits++;
      });
      ordWrap.style.display = ordHits ? '' : 'none';
    }
    if (pv) pv.style.display = ordHits ? '' : 'none';
    if (hint) {
      hint.textContent = total
        ? ('搜索「' + search.value.trim() + '」· 命中 ' + total + ' 项（跨页显示）')
        : '没有匹配的设置项';
    }
  }

  // ---------------------------------------------------------------- 绑定
  function bind() {
    // 主题
    Array.prototype.forEach.call(document.querySelectorAll('#mats .chip'), function (b) {
      b.addEventListener('click', function () { setTheme(b.getAttribute('data-mat'), S.theme.color); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#swatches .sw'), function (b) {
      b.addEventListener('click', function () { setTheme(S.theme.style, b.getAttribute('data-col')); });
    });

    // 页签
    Array.prototype.forEach.call(document.querySelectorAll('#rail .tab'), function (t) {
      t.addEventListener('click', function () { setTab(t.getAttribute('data-tab')); });
    });

    // 关闭
    var cc = $id('ccClose'); if (cc) cc.addEventListener('click', function () { if (callable('close')) api.close(); });
    var cm = $id('ccMinimize'); if (cm) cm.addEventListener('click', function () { if (callable('hide')) api.hide(); });

    // 搜索
    var search = $id('search'); if (search) search.addEventListener('input', applySearch);

    // 编排器上下移 + 选中
    var up = $id('ordUp'), dn = $id('ordDown');
    if (up) up.addEventListener('click', function () {
      if (!ordSel) { toast('先在下面点一行，再上移'); return; }
      var i = -1;
      ORD.forEach(function (x, k) { if (x.key === ordSel) i = k; });
      if (i > 0) moveOrd(i, -1); else toast('已经在最上面');
    });
    if (dn) dn.addEventListener('click', function () {
      if (!ordSel) { toast('先在下面点一行，再下移'); return; }
      var i = -1;
      ORD.forEach(function (x, k) { if (x.key === ordSel) i = k; });
      if (i >= 0 && i < ORD.length - 1) moveOrd(i, 1); else toast('已经在最下面');
    });

    // 气泡两个开关
    var onSw = $id('bubbleOnSw');
    if (onSw) onSw.addEventListener('click', function () {
      S.bubble.on = !S.bubble.on; onSw.classList.toggle('on', S.bubble.on);
      if (callable('setBubble')) api.setBubble({ on: S.bubble.on });
      renderPreview();
      toast('点击才弹气泡：' + (S.bubble.on ? '开' : '关'));
    });
    var saySw = $id('bubbleSaySw');
    if (saySw) saySw.addEventListener('click', function () {
      S.bubble.say = !S.bubble.say; saySw.classList.toggle('on', S.bubble.say);
      if (callable('setBubble')) api.setBubble({ say: S.bubble.say });
      toast('说话只留台词：' + (S.bubble.say ? '开' : '关'));
    });

    // 语音页
    bindVoice();

    // 系统页
    var thr = $id('throughSw');
    if (thr) thr.addEventListener('click', function () {
      var on = !thr.classList.contains('on');
      thr.classList.toggle('on', on);
      if (callable('setMouseThrough')) api.setMouseThrough(on);
      toast('不影响鼠标：' + (on ? '开（整窗穿透）' : '关'));
    });
    var auto = $id('autostartSw');
    if (auto) auto.addEventListener('click', function () {
      var on = !auto.classList.contains('on');
      auto.classList.toggle('on', on);
      if (callable('setAutostart')) api.setAutostart(on);
      toast('开机自启：' + (on ? '开' : '关'));
    });
    var hp = $id('hidePet'); if (hp) hp.addEventListener('click', function () { if (callable('hide')) api.hide(); });
    var ccc = $id('closeCenter'); if (ccc) ccc.addEventListener('click', function () { if (callable('close')) api.close(); });
    var qp = $id('quitPet'); if (qp) qp.addEventListener('click', function () { if (callable('quit')) api.quit(); });
    var rm = $id('reloadModel'); if (rm) rm.addEventListener('click', function () {
      if (callable('reloadModel')) api.reloadModel();
      toast('已重新载入模型');
    });
    // ★ 系统页 · 模型（PSD）：打开 PSD（用系统默认程序，一般是 Photoshop）/ 重新生成 / 打开所在文件夹
    var mo = $id('modelOpen'); if (mo) mo.addEventListener('click', function () { modelCmd('open', '正在打开 PSD…'); });
    var mr = $id('modelRebuild'); if (mr) mr.addEventListener('click', function () { modelCmd('rebuild', '开始重新生成'); });
    var mf = $id('modelFolder'); if (mf) mf.addEventListener('click', function () { modelCmd('folder', ''); });
    var hs = $id('heartSw');
    if (hs) hs.addEventListener('click', function () {
      if (!callable('setHeart')) { toast('爱心眼通道未就绪（center:heart）'); return; }
      var on = !hs.classList.contains('on');
      hs.classList.toggle('on', on);
      api.setHeart(on);
    });

    // ★ 系统页 · 本机接口 / 数据目录
    var ac = $id('apiCopy'); if (ac) ac.addEventListener('click', function () { apiCmd('copy', '令牌已复制'); });
    var armedRegen = false, regenT = null, ar = $id('apiRegen');
    if (ar) ar.addEventListener('click', function () {
      if (!armedRegen) {
        armedRegen = true; ar.textContent = '再点一次确认（插件要换新令牌）';
        regenT = setTimeout(function () { armedRegen = false; ar.textContent = '换一个令牌'; }, 4000);
        return;
      }
      clearTimeout(regenT); armedRegen = false; ar.textContent = '换一个令牌';
      apiCmd('regen', '换好了：插件要用新令牌');
    });
    var at = $id('apiToggle'); if (at) at.addEventListener('click', function () { apiCmd('toggle', ''); });
    var od = $id('openDataDir'); if (od) od.addEventListener('click', function () { modelCmd('data', ''); });

    // 危险区：恢复全部默认（二次确认）
    var armed = false, armedT = null, ra = $id('resetAll');
    if (ra) ra.addEventListener('click', function () {
      if (!armed) {
        armed = true;
        ra.textContent = '再点一次确认恢复';
        ra.classList.add('armed');
        armedT = setTimeout(function () {
          armed = false; ra.textContent = '恢复全部默认'; ra.classList.remove('armed');
        }, 4000);
        return;
      }
      clearTimeout(armedT);
      armed = false;
      ra.textContent = '恢复全部默认'; ra.classList.remove('armed');

      var dt0 = CHAR.defaultTheme || { style: 'glass', color: 'sakura' };   // ★ 多角色：主题复位到这个角色的默认
      S.theme = { style: dt0.style, color: dt0.color };
      setTheme(dt0.style, dt0.color, true);
      var defCustom = CHAR.defaultCustom || DEF_CUSTOM;   // ★ 多角色：自定义文本复位到这个角色的默认
      S.bubble = { on: true, say: true, items: DEF_ITEMS.slice(), order: DEF_ORDER.slice(), levels: clone(DEF_LEVELS), custom: defCustom, wPct: DEF_WPCT, hPx: DEF_HPX };
      var onSw2 = $id('bubbleOnSw'); if (onSw2) onSw2.classList.add('on');
      var saySw2 = $id('bubbleSaySw'); if (saySw2) saySw2.classList.add('on');
      if (callable('setBubble')) api.setBubble({ on: true, say: true, items: DEF_ITEMS.slice(), order: DEF_ORDER.slice(), levels: clone(DEF_LEVELS), custom: defCustom, wPct: DEF_WPCT, hPx: DEF_HPX });
      if (callable('resetTune')) api.resetTune(null);
      S.tune = clone(S.tuneDefaults || {});
      ordSel = null;
      renderAll();
      toast('已恢复全部默认');
    });

    // 键盘：Esc 关闭 / Ctrl+K 聚焦搜索
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (callable('close')) api.close();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        var s = $id('search');
        if (s) { s.focus(); s.select(); }
      }
    });
  }

  // ---------------------------------------------------------------- 推送订阅
  function subscribe() {
    if (!callable('on')) return;
    api.on('center:cfg', function (snap) { applyCfg(snap, false); });
    api.on('center:theme', function (t) {
      if (!t) return;
      if (MATS[t.style]) S.theme.style = t.style;
      if (COLS[t.color]) S.theme.color = t.color;
      applyTheme(true);
    });
    api.on('center:page', function (p) { if (p) setTab(p); });
    api.on('center:voice', function (v) { applyVoice(v); });
    // ★ PSD → 模型 生成到哪一步了（只推当前角色的）
    api.on('center:model', function (m) { if (m && typeof m === 'object') { MODEL = m; renderModel(); } });
  }

  // ---------------------------------------------------------------- 启动
  bind();
  buildOrd();
  renderRole();
  renderLook();
  renderOrd();
  renderPreview();
  applyTheme(true);
  subscribe();

  if (callable('init')) {
    api.init().then(function (snap) { applyCfg(snap, true); })
      .catch(function (e) {
        toast('取快照失败：' + (e && e.message ? e.message : 'center:init'));
        renderApi();
      });
  } else {
    // 没有 preload 通道（例如离线打开本页看排版）：用内置占位渲染，写操作静默跳过。
    renderApi();
  }
})();
