/**
 * main.js — 检查器区块 UI 与生命周期 (v0.2.0)
 *
 * 全局状态（settings.json）：自动生成开关、展开/折叠 —— 切换视频保持
 * 单项状态（thumbs/<itemId>/config.json）：生成数量 —— 各视频互相独立
 * 内存状态：清空后的「抑制自动生成」标记，重新选择该视频时解除
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
    lastCount: S.DEFAULT_COUNT
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
    $('generate').hidden = state.global.autoGenerate;   // 自动生成开启时隐藏手动按钮
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
   * 网格高度随张数变化：0 张 -> 0；1-3 张 -> 1 行；4-6 -> 2 行；>=7 -> 3 行封顶。
   * 行高用运行时实测的 cell 高度，避免硬编码缩图尺寸。
   */
  function applyGridHeight(n) {
    var grid = $('grid');
    if (n <= 0) {
      grid.style.height = '0px';
      grid.style.marginTop = '0px';
      grid.style.overflowY = 'hidden';
    } else {
      var cell = grid.querySelector('.cell');
      var cellH = cell ? cell.getBoundingClientRect().height : 0;
      var gap = parseFloat(window.getComputedStyle(grid).rowGap) || 8;
      grid.style.height = L.heightFor(n, cellH, gap) + 'px';
      grid.style.marginTop = '6px';
      // 展开态（>9 张）保持 3 行高度，其余卡片在网格内部滚动
      grid.style.overflowY = (n > L.VISIBLE_LIMIT) ? 'auto' : 'hidden';
    }
    tryResizeHost();
  }

  /**
   * 尽力而为地同步宿主 iframe 高度。
   * 官方没有「运行时修改检查器区块高度」的 API（eagle.window.setSize 只作用于
   * 插件窗口，检查器插件没有 main）。若宿主是同源 iframe，frameElement 可直接改；
   * 若是 webview / 不允许访问，则静默退回 manifest 固定高度，内容仍顶部对齐。
   */
  function tryResizeHost() {
    try {
      var h = $('wrap').getBoundingClientRect().height;
      if (!h || h < 20) return;
      var fe = window.frameElement;
      if (fe && fe.style) fe.style.height = Math.ceil(h) + 'px';
    } catch (e) { /* 宿主不允许访问，静默 */ }
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
      applyGridHeight(0);
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
    applyGridHeight(visible);
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
    // 抑制自动生成：只有重新选择该视频（选中项 id 再次变化）才解除
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
        return;
      }

      state.meta = null;
      if (state.global.autoGenerate) {
        await generate();
      } else {
        setMessage('尚未生成预览图，点「生成」按钮自动生成', 'hint');
        render();
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
      state.global = Store.getGlobal();   // 自动生成默认关闭、展开状态全局保持
    } catch (e) {
      setMessage(friendlyError(e), 'error');
    }
    syncControls();

    $('generate').addEventListener('click', generate);
    $('clear').addEventListener('click', clearPreview);

    $('autoGenerate').addEventListener('change', function () {
      state.global.autoGenerate = !!this.checked;
      try { Store.setGlobal({ autoGenerate: state.global.autoGenerate }); } catch (e) { /* ignore */ }
      syncControls();
      // 按用户口径：开启当下不立即生成，等下一次「点击选择视频」时触发
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
    });

    $('tileCount').addEventListener('change', function () {
      var n = S.clampCount(this.value);
      this.value = n;
      state.lastCount = n;
      if (!state.itemId) return;
      try { Store.setItemConfig(state.itemId, { tileCount: n }); } catch (e) { /* ignore */ }

      if (state.global.autoGenerate && !state.suppressed[state.itemId]) {
        generate();   // 数量确认后自动刷新（generate 内部会先查缓存）
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
    });

    await tick();
    setInterval(tick, 1000);
  });

  eagle.onThemeChanged(function (theme) {
    document.body.setAttribute('theme', theme || 'LIGHT');
  });
})();
