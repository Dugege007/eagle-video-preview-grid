/**
 * main.js — 检查器区块 UI 与生命周期 (v1.1.0)
 *
 * 全局状态（settings.json）：自动生成开关、展开/折叠 —— 切换视频保持
 * 单项状态（thumbs/<itemId>/config.json）：生成数量 —— 各视频互相独立
 * 内存状态：清空后的「抑制自动生成」标记，重新选择该视频时解除
 *
 * 高度策略（v0.3.1 修复）：
 *   - 只由「操作事件」触发，一个事件只同步刷新一次；没有任何定时器 / 间隔刷新。
 *   - 可用高度用插件加载时记录的固定基准 baseViewport，绝不读取会随自身写入
 *     而变化的 window.innerHeight —— 这是 v0.3.0 高度逐次递减的根因。
 *   - 不再尝试改宿主 iframe 高度（实测无效，且是反馈循环的另一半）。
 *   - refreshLayout() 幂等：值没变就一个字都不写。
 *
 * 1s 轮询只用于检测「选中项变化」（官方 7 个 event 里没有该事件），不触碰高度。
 *
 * 明确不做：点击跳转播放、快捷键、自定义取帧、可编辑描述、hover 播放。
 */
(function () {
  'use strict';

  var S = window.Sampler;
  var L = window.Layout;
  var Store = window.Store;
  var Capture = window.Capture;

  var DEFAULT_VIEWPORT = 320;   // manifest 的 inspector.height，作为拿不到视口时的兜底
  var SAFE_MARGIN = 4;          // 防裁切的固定余量

  var state = {
    itemId: null,
    busy: false,
    meta: null,
    message: '',
    kind: 'hint',
    global: { autoGenerate: false, expanded: false },
    suppressed: {},                 // itemId -> true
    lastCount: S.DEFAULT_COUNT,
    baseViewport: DEFAULT_VIEWPORT, // 只取一次，之后永不更新
    lastWidth: 0                    // 最近一次已知的 iframe 宽度
  };

  function $(id) { return document.getElementById(id); }

  function setMessage(text, kind) {
    state.message = text || '';
    state.kind = kind || 'hint';
  }

  function friendlyError(e) {
    var code = (e && e.message) ? e.message : String(e);
    if (code.indexOf('NODE_UNAVAILABLE') >= 0) {
      return '当前检查器环境无法调用 Node 模块，FFmpeg 不可用。';
    }
    if (code.indexOf('FFMPEG_NOT_INSTALLED') >= 0 || code.indexOf('FFMPEG_MODULE_MISSING') >= 0) {
      return '请先在 Eagle 插件设置中安装官方「FFmpeg 依赖插件」。';
    }
    if (code.indexOf('FFMPEG_PATHS_MISSING') >= 0) {
      return 'FFmpeg 依赖插件未返回 ffprobe 路径，无法读取视频时长。';
    }
    if (code.indexOf('DURATION') >= 0) {
      return '无法读取该视频时长，FFmpeg 可能不支持此文件。';
    }
    if (code.indexOf('NO_SELECTED_ITEM') >= 0) {
      return '请先选中一个视频文件。';
    }
    if (code.indexOf('TIMEOUT') >= 0) {
      return 'FFmpeg 抽帧超时，请检查文件是否损坏。';
    }
    if (code.indexOf('EACCES') >= 0 || code.indexOf('EPERM') >= 0) {
      return '写入缓存被拒绝，请检查 Eagle 用户数据目录权限。';
    }
    return '操作失败：' + code.slice(0, 160);
  }

  function setBusy(busy) {
    state.busy = busy;
    $('generate').disabled = busy;
    $('clear').disabled = busy;
    $('tileCount').disabled = busy;
    $('autoGenerate').disabled = busy;
    $('generate').textContent = busy ? '生成中…' : '生成';
  }

  function syncControls() {
    $('autoGenerate').checked = state.global.autoGenerate;
    // 自动生成开启时：手动「生成」与「清空」都隐藏
    $('generate').hidden = state.global.autoGenerate;
    $('clear').hidden = state.global.autoGenerate;
    $('tileCount').value = state.lastCount;
  }

  function describe() {
    var meta = state.meta;
    if (!meta || !meta.times || meta.times.length === 0) return '';
    var total = meta.times.length;
    var visible = L.visibleCount(total, state.global.expanded);
    var parts = [];
    parts.push(total > L.VISIBLE_LIMIT
      ? '显示 ' + visible + ' / 共 ' + total + ' 张'
      : '共 ' + total + ' 张');
    parts.push('时长 ' + S.formatTime(meta.duration));
    parts.push('间隔 ' + Number(meta.gap).toFixed(1) + 's');
    if (meta.truncated) parts.push('受最低间隔限制');
    if (meta.droppedFirst) parts.push('已跳过片头');
    return parts.join(' · ');
  }

  /**
   * 纯同步、幂等的高度刷新。只由事件调用，一个事件一次。
   * 可用高度基于固定基准 baseViewport，不读取动态 window.innerHeight，
   * 因此重复调用永远得到同一个结果，不会逐次递减。
   */
  function refreshLayout() {
    var grid = $('grid');
    var cells = grid.querySelectorAll('.cell');
    var n = cells.length;
    var px;
    var overflow;
    var margin;

    if (n === 0) {
      px = '0px';
      overflow = 'hidden';
      margin = '0px';
    } else {
      var cellH = cells[0].getBoundingClientRect().height;
      var gap = parseFloat(window.getComputedStyle(grid).rowGap) || 8;
      var target = L.heightFor(n, cellH, gap, state.global.expanded);

      // 除网格外的固定开销（工具栏 / 状态行 / footer / padding）
      var wrapH = $('wrap').getBoundingClientRect().height;
      var gridH = grid.getBoundingClientRect().height;
      var chrome = Math.max(0, wrapH - gridH);
      var avail = Math.max(0, state.baseViewport - chrome - SAFE_MARGIN);
      var fit = L.fitHeight(target, avail);

      px = fit.height + 'px';
      overflow = fit.scroll ? 'auto' : 'hidden';
      margin = '6px';
    }

    // 幂等短路：值没变就不写 DOM，杜绝任何写入 -> resize -> 再写入的反馈循环
    if (grid.style.height === px &&
        grid.style.overflowY === overflow &&
        grid.style.marginTop === margin) return;
    grid.style.height = px;
    grid.style.overflowY = overflow;
    grid.style.marginTop = margin;
  }

  function render() {
    var status = $('status');
    status.textContent = state.message;
    status.className = 'status ' + state.kind;

    var grid = $('grid');
    var meta = state.meta;
    var total = (meta && meta.times) ? meta.times.length : 0;
    var visible = L.visibleCount(total, state.global.expanded);
    var showToggle = L.needsToggle(total);

    // C：渲染签名只在「内容」变化时改变。状态文本更新 / 高度刷新不重建卡片、
    // 不重复读盘取 base64（store.js 也有一层内存缓存）。
    var sig = [
      state.itemId || '',
      meta ? (meta.generatedAt || 0) : 0,
      visible,
      meta && meta.results ? meta.results.join('') : ''
    ].join('|');

    if (grid.getAttribute('data-sig') !== sig) {
      grid.innerHTML = '';
      for (var i = 0; i < visible; i++) {
        var cell = document.createElement('div');
        cell.className = 'cell';

        if (meta.results && meta.results[i] === false) {
          var ph = document.createElement('div');
          ph.className = 'thumb placeholder';
          ph.textContent = '抽帧失败';
          cell.appendChild(ph);
        } else {
          var img = document.createElement('img');
          img.className = 'thumb';
          img.alt = '';
          img.title = S.formatTime(meta.times[i]);
          try {
            img.src = Store.thumbDataURL(state.itemId, i);
          } catch (e) {
            img.classList.add('placeholder');
          }
          cell.appendChild(img);
        }

        var time = document.createElement('div');
        time.className = 'time';
        time.textContent = S.formatTime(meta.times[i]);
        cell.appendChild(time);

        grid.appendChild(cell);
      }
      grid.setAttribute('data-sig', sig);
    }

    $('footer').hidden = !showToggle;
    $('toggle').textContent = state.global.expanded ? '收起 ▴' : '展开 ▾';
    refreshLayout();         // 本次事件的一次刷新（内部幂等短路）
  }

  async function selectedItem() {
    var items = await eagle.item.getSelected();
    return items && items[0];
  }

  function loadCacheIfValid(item, count) {
    var stat = Store.fileStat(item.filePath);
    var meta = Store.readMeta(item.id);
    return Store.isCacheValid(meta, {
      itemId: item.id,
      count: count,
      sourceSize: stat.size,
      sourceMtime: stat.mtimeMs
    }) ? meta : null;
  }

  async function generate() {
    if (state.busy) return;
    if (!state.itemId) {
      setMessage('请先选中一个视频文件', 'warn');
      render();
      return;
    }

    var count = S.clampCount($('tileCount').value);
    $('tileCount').value = count;
    state.lastCount = count;
    try { Store.setItemConfig(state.itemId, { tileCount: count }); } catch (e) { /* 不阻塞 */ }

    // 已有符合数量 / 规则 / 源文件的缓存 -> 直接复用，不重复抽帧
    try {
      var item0 = await selectedItem();
      if (item0) {
        var cached = loadCacheIfValid(item0, count);
        if (cached) {
          state.meta = cached;
          setMessage(describe(), 'hint');
          render();
          return;
        }
      }
    } catch (e) { /* 缓存检查失败，继续走生成 */ }

    setBusy(true);
    setMessage('正在读取视频时长…', 'hint');
    render();

    try {
      var item = await selectedItem();
      if (!item) throw new Error('NO_SELECTED_ITEM');

      var paths = await Capture.ensureFFmpeg();
      var duration = await Capture.probeDuration(paths.ffprobe, item.filePath);
      var p = S.plan(duration, count);

      if (p.reason === 'too-short' || p.times.length === 0) {
        setMessage(
          '视频不足 ' + S.MIN_GAP + ' 秒（时长 ' + S.formatTime(duration) + '），无法生成预览图',
          'warn'
        );
        render();
        return;
      }

      Store.ensureItemDir(item.id);
      var outPaths = p.times.map(function (_, i) { return Store.thumbFile(item.id, i); });

      setMessage('正在抽帧 0 / ' + p.times.length + ' …', 'hint');
      render();

      var r = await Capture.captureAll(
        paths.ffmpeg, item.filePath, p.times, outPaths,
        function (done, total) {
          setMessage('正在抽帧 ' + done + ' / ' + total + ' …', 'hint');
          $('status').textContent = state.message;   // 只更新文本，不触发 render / 高度刷新
        }
      );

      var stat = Store.fileStat(item.filePath);
      var meta = {
        rule: Store.RULE_VERSION,
        count: count,
        duration: duration,
        gap: p.gap,
        times: p.times,
        results: r.results,
        truncated: p.truncated,
        droppedFirst: p.droppedFirst,
        sourceSize: stat.size,
        sourceMtime: stat.mtimeMs,
        generatedAt: Date.now()
      };
      Store.writeMeta(item.id, meta);

      state.meta = meta;
      var note = describe();
      if (r.failures > 0) note += ' · ' + r.failures + ' 张抽帧失败';
      setMessage(note, r.failures > 0 ? 'warn' : 'ok');
    } catch (e) {
      setMessage(friendlyError(e), 'error');
    } finally {
      setBusy(false);
      render();
    }
  }

  function clearPreview() {
    if (state.busy || !state.itemId) return;
    try {
      Store.clearItem(state.itemId);
    } catch (e) {
      setMessage(friendlyError(e), 'error');
      render();
      return;
    }
    state.suppressed[state.itemId] = true;
    state.meta = null;
    setMessage(
      state.global.autoGenerate ? '已清空，重新选择该视频后会再次生成' : '已清空',
      'hint'
    );
    render();
  }

  var ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      // 只检测「选中项变化」；不读取尺寸、不刷新高度。
      // 官方 7 个 event 里没有选中变化事件，这个 1s 轮询是必需的，且与高度无关。
      var item = await selectedItem();
      var id = item ? item.id : null;
      if (id === state.itemId) return;

      state.itemId = id;
      if (id && state.suppressed[id]) delete state.suppressed[id];  // 重新选择 -> 解除抑制

      if (!id) {
        state.meta = null;
        setMessage('请选中一个视频文件', 'hint');
        render();
        return;
      }

      // 数量是单项配置：读这个视频自己的，不用上一次视频的值
      var cfg = Store.getItemConfig(id);
      state.lastCount = cfg.tileCount;
      syncControls();

      var cached = loadCacheIfValid(item, cfg.tileCount);
      if (cached) {
        state.meta = cached;
        setMessage(describe(), 'hint');
        render();          // 重新选择资源：一次刷新
        return;
      }

      state.meta = null;
      if (state.global.autoGenerate) {
        await generate();
      } else {
        setMessage('尚未生成预览图，点「生成」按钮自动生成', 'hint');
        render();          // 重新选择资源：一次刷新
      }
      // 注意：state.global.expanded 是全局的，切换视频不重置
    } catch (e) {
      state.meta = null;
      setMessage(friendlyError(e), 'error');
      render();
    } finally {
      ticking = false;
    }
  }

  eagle.onPluginCreate(async function () {
    try {
      var theme = await eagle.app.theme;
      document.body.setAttribute('theme', theme || 'LIGHT');
    } catch (e) { /* 主题取不到时用默认 */ }

    try {
      state.global = Store.getGlobal();
    } catch (e) {
      setMessage(friendlyError(e), 'error');
    }
    syncControls();

    // 固定基准只取一次；之后即使 iframe 尺寸变化也不重新取值
    state.baseViewport = window.innerHeight || DEFAULT_VIEWPORT;
    state.lastWidth = Math.round(window.innerWidth);

    // 拖拽检查器分隔条时，鼠标松开发生在 Eagle 主窗口，插件 iframe 收不到 mouseup，
    // 所以上一版只能靠「再点一下 iframe 内部」才刷新。改用 ResizeObserver 捕获
    // 「布局宽度变化」这个可靠事件：只在宽度真的变化时同步刷新一次。
    // 高度变化（我们自己写 grid 高度导致的）直接忽略，避免写入->事件->再写入的反馈循环。
    // 无定时器、无防抖、无二次校准。
    if (typeof ResizeObserver === 'function') {
      var widthObserver = new ResizeObserver(function (entries) {
        var rect = entries && entries[0] && entries[0].contentRect;
        var w = Math.round(rect ? rect.width : window.innerWidth);
        if (w === state.lastWidth) return;
        state.lastWidth = w;
        refreshLayout();
      });
      widthObserver.observe(document.documentElement);
    }

    $('generate').addEventListener('click', generate);
    $('clear').addEventListener('click', clearPreview);

    $('autoGenerate').addEventListener('change', function () {
      state.global.autoGenerate = !!this.checked;
      try { Store.setGlobal({ autoGenerate: state.global.autoGenerate }); } catch (e) { /* ignore */ }
      syncControls();
      setMessage(
        state.global.autoGenerate ? '自动生成已开启：选择视频时自动生成' : '自动生成已关闭',
        'hint'
      );
      render();            // 开关切换：一次刷新
    });

    $('toggle').addEventListener('click', function () {
      state.global.expanded = !state.global.expanded;
      try { Store.setGlobal({ expanded: state.global.expanded }); } catch (e) { /* ignore */ }
      setMessage(describe(), 'hint');
      render();            // 展开 / 收起：一次刷新
    });

    $('tileCount').addEventListener('change', function () {
      var n = S.clampCount(this.value);
      this.value = n;
      state.lastCount = n;
      if (!state.itemId) return;
      try { Store.setItemConfig(state.itemId, { tileCount: n }); } catch (e) { /* ignore */ }

      if (state.global.autoGenerate && !state.suppressed[state.itemId]) {
        generate();
      } else {
        state.meta = null;
        setMessage(
          state.suppressed[state.itemId]
            ? '数量已记录；重新选择该视频后按新数量自动生成'
            : '数量已改为 ' + n + '，点「生成」重新生成',
          'hint'
        );
        render();          // 数量确认：一次刷新
      }
    });

    // iframe 内部点击 / 松开的兜底：与 ResizeObserver 共用同一个宽度基准，
    // 因此不会重复刷新；宽度没变就一次都不刷。
    window.addEventListener('mouseup', function () {
      var w = Math.round(window.innerWidth);
      if (w === state.lastWidth) return;
      state.lastWidth = w;
      refreshLayout();
    });

    await tick();
    setInterval(tick, 1000);   // 仅选中项轮询，与高度无关
  });

  eagle.onThemeChanged(function (theme) {
    document.body.setAttribute('theme', theme || 'LIGHT');
  });
})();
