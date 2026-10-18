// 右键菜单小窗：主题跟着主进程走，点哪项就把 id 交给主进程（menu:pick）
(function () {
  var api = window.menuAPI;
  var root = document.documentElement;
  if (!api) { return; }

  // 主题：读主进程当前值，落在 html 的 m-*/c-* 上（与宿主窗、控制中心同一套 class 口径）
  function applyTheme(t) {
    if (!t) { return; }
    var styles = ['m-glass', 'm-acrylic', 'm-flat'];
    var colors = ['c-sakura', 'c-celadon', 'c-midnight', 'c-amber', 'c-ink'];
    for (var i = 0; i < styles.length; i++) root.classList.remove(styles[i]);
    for (var j = 0; j < colors.length; j++) root.classList.remove(colors[j]);
    root.classList.add('m-' + (t.style || 'glass'));
    root.classList.add('c-' + (t.color || 'sakura'));
  }

  function applyState(s) {
    if (!s) { return; }
    var through = document.querySelector('.mi[data-id="through"]');
    if (through) through.classList.toggle('on', !!s.mouseThrough);
    // 正在说话时这一项变成「停下」（Ctrl+Alt+U 也能停）
    var say = document.querySelector('.mi[data-id="say"] .lbl');
    if (say) say.textContent = s.speaking ? '停下' : '说一句';
    var sayKey = document.querySelector('.mi[data-id="say"] .key');
    if (sayKey) sayKey.textContent = s.speaking ? 'Ctrl+Alt+U' : 'S';
    applyChars(s.chars);
    applyTheme(s.theme);
  }

  // ★ 角色一行：每个角色一个；点了 = menu:pick 'char:<id>'
  function applyChars(c) {
    var box = document.getElementById('charChips');
    var row = document.getElementById('charRow');
    if (!box || !row) { return; }
    if (!c || !c.list || c.list.length < 2) { row.style.display = 'none'; return; }
    row.style.display = '';
    box.textContent = '';
    var items = c.list;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var el = document.createElement('span');
      el.className = 'chip' + (c.active === it.id ? ' on' : '');
      el.textContent = it.name;
      el.setAttribute('data-char', it.id);
      box.appendChild(el);
    }
  }

  api.init().then(applyState).catch(function () { /* 读不到就用默认样式 */ });
  if (api.onCfg) api.onCfg(applyState);

  document.getElementById('menu').addEventListener('click', function (e) {
    var chip = e.target && e.target.closest ? e.target.closest('.chip') : null;
    if (chip) { api.pick('char:' + chip.getAttribute('data-char')); return; }
    var el = e.target && e.target.closest ? e.target.closest('.mi') : null;
    if (!el || !el.getAttribute('data-id')) { return; }
    api.pick(el.getAttribute('data-id'));
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { api.close(); return; }
    var map = { m: 'through', s: 'say', q: 'quit' };
    var id = map[String(e.key || '').toLowerCase()];
    if (id && !e.ctrlKey && !e.altKey) { api.pick(id); }
  });
})();
