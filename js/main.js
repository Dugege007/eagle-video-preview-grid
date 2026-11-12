/**
 * main.js — 检查器区块 UI 与生命周期 (v0.3.0)
 *
 * 全局状态（settings.json）：自动生成开关、展开/折叠 —— 切换视频保持
 * 单项状态（thumbs/<itemId>/config.json）：生成数量 —— 各视频互相独立
 * 内存状态：清空后的「抑制自动生成」标记，重新选择该视频时解除
 *
 * 高度策略：官方没有运行时改检查器 iframe 高度的 API，因此把「刷新高度」
 * 做成幂等的 refreshLayout()，挂到所有关键时机；展开时行数不封顶，
 * 并做防裁切保护（超出 iframe 可用高度时退回内部滚动）。
 *
 * 明确不做：点击跳转播放、快捷键、自定义取帧、可编辑描述、hover 播放。
 */
(function () {
  'use strict';

  var S = window.Sampler;
  var L = window.Layout;
  var Store = window.Store;
  var Capture = window.Capture;

  var state = {
    itemId: null,
    busy: false,
    meta: null,
    message: '',
    kind: 'hint',
    global: { autoGenerate: false, expanded: false },
    suppressed: {},                 // itemId -> true
    lastCount: S.DEFAULT_COUNT,
    lastInnerHeight: 0
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
   * 尽力而为地同步宿主 iframe 高度（官方无对应 API）。
   * 多路尝试：frameElement 的 style / height 属性、宿主 document 里承载本窗口的
   * iframe / webview 元素。全部包在 try/catch 里，宿主不允许就静默退回固定高度。
   */
  function tryResizeHost(h) {
    if (!h || h < 20) return false;
    var px = Math.ceil(h) + 'px';
    var ok = false;
    try {
      var fe = window.frameElement;
      if (fe) {
        if (fe.style) {
          fe.style.height = px;
          fe.style.minHeight = px;
        }
        try { fe.setAttribute('height', String(Math.ceil(h))); } catch (e) { /* ignore */ }
        ok = true;
      }
    } catch (e) { /* 跨域 / webview */ }

    try {
      if (window.parent && window.parent !== window) {
        var list = window.parent.document.querySelectorAll('iframe,webview');
        for (var i = 0; i < list.length; i++) {
          try {
            if (list[i].contentWindow === window) {
              list[i].style.height = px;
              list[i].style.minHeight = px;
              ok = true;
              break;
            }
          } catch (e2) { /* 单个元素无权限 */ }
        }
      }
    } catch (e3) { /* 宿主文档不可访问 */ }

    return ok;
  }

  /** 只读探测：判断 eagle.window 是否指向可控的检查器窗口（不调用 setSize）。 */
  async function probeHost() {
    try {
      var size = (eagle.window && typeof eagle.window.getSize === 'function')
        ? await eagle.window.getSize()
        : null;
      var w = size && size[0];
      var h = size && size[1];
      console.log('[pv-grid] host probe', {
        frameElement: !!window.frameElement,
        innerHeight: window.innerHeight,
        windowGetSize: size,
        looksLikeInspectorWindow: !!(w && h && w <= 600 && h <= 1200)
      });
    } catch (e) {
      console.log('[pv-grid] host probe unavailable:', e && e.message);
    }
  }

  /**
   * 幂等的高度刷新：按当前 DOM 里的卡片数、实测行高、展开状态、
   * 以及 iframe 当前可用视口高度，重新计算网格高度。
   * 这是「自适应」的核心动作，可在任意操作之后重复调用。
   */
  function refreshLayout() {
    var grid = $('grid');
    var cells = grid.querySelectorAll('.cell');
    var n = cells.length;

    if (n === 0) {
      grid.style.height = '0px';
      grid.style.marginTop = '0px';
      grid.style.overflowY = 'hidden';
      tryResizeHost($('wrap').getBoundingClientRect().height);
      return;
    }

    var cellH = cells[0].getBoundingClientRect().height;
    var gap = parseFloat(window.getComputedStyle(grid).rowGap) || 8;
    var target = L.heightFor(n, cellH, gap, state.global.expanded);

    // 除网格外的固定开销（工具栏 / 状态行 / footer / padding）
    var wrapH = $('wrap').getBoundingClientRect().height;
    var gridH = grid.getBoundingClientRect().height;
    var chrome = Math.max(0, wrapH - gridH);
    var avail = Math.max(0, window.innerHeight - chrome - 4);
    var fit = L.fitHeight(target, avail);

    grid.style.marginTop = '6px';
    grid.style.height = fit.height + 'px';
    grid.style.overflowY = fit.scroll ? 'auto' : 'hidden';

    tryResizeHost(Math.ceil($('wrap').getBoundingClientRect().height));
  }

  var refreshTimerA = null;
  var refreshTimerB = null;
  /** 对抗宿主重排：rAF + 两段延时各刷一次。带防抖，进度更新不会堆积。 */
  function scheduleRefresh() {
    if (window.requestAnimationFrame) window.requestAnimationFrame(refreshLayout);
    clearTimeout(refreshTimerA);
    clearTimeout(refreshTimerB);
    refreshTimerA = setTimeout(refreshLayout, 120);
    refreshTimerB = setTimeout(refreshLayout, 400);
  }

  function render() {
    var status = $('status');
    status.textContent = state.message;
    status.className = 'status ' + state.kind;

    var grid = $('grid');
    grid.innerHTML = '';

    var meta = state.meta;
    var total = (meta && meta.times) ? meta.times.length : 0;
    var visible = L.visibleCount(total, state.global.expanded);
    var showToggle = L.needsToggle(total);

    if (total === 0) {
      $('footer').hidden = true;
      refreshLayout();
      scheduleRefresh();
      return;
    }

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

    $('footer').hidden = !showToggle;
    $('toggle').textContent = state.global.expanded ? '收起 ▴' : '展开 ▾';
    refreshLayout();
    scheduleRefresh();
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
          $('status').textContent = state.message;
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
      // 宿主高度若被撑高 / 检查器宽度变化，轮询里也能感知并重算
      var ih = window.innerHeight;
      if (ih !== state.lastInnerHeight) {
        state.lastInnerHeight = ih;
        refreshLayout();
      }

      // 官方 7 个 event 中没有「选中项变化」，只能轮询
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
        render();
        scheduleRefresh();   // 重新选择资源后刷新高度
        return;
      }

      state.meta = null;
      if (state.global.autoGenerate) {
        await generate();
      } else {
        setMessage('尚未生成预览图，点「生成」按钮自动生成', 'hint');
        render();
      }
      scheduleRefresh();     // 重新选择资源后刷新高度
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
    state.lastInnerHeight = window.innerHeight;
    probeHost();

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
      render();
    });

    $('toggle').addEventListener('click', function () {
      state.global.expanded = !state.global.expanded;
      try { Store.setGlobal({ expanded: state.global.expanded }); } catch (e) { /* ignore */ }
      setMessage(describe(), 'hint');
      render();
      scheduleRefresh();   // 展开 / 收起后按当前张数刷新高度
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
        render();
      }
      scheduleRefresh();   // 重设数量后刷新高度
    });

    // 拖拽检查器宽度：iframe 尺寸变化会触发 resize；mouseup 兜底「松开后」再刷一次
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(refreshLayout, 120);
    });
    window.addEventListener('mouseup', function () {
      setTimeout(refreshLayout, 60);
      setTimeout(refreshLayout, 220);
    });

    await tick();
    setInterval(tick, 1000);
  });

  eagle.onThemeChanged(function (theme) {
    document.body.setAttribute('theme', theme || 'LIGHT');
  });
})();
