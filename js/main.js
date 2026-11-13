/**
 * main.js — 检查器区块 UI 与生命周期 (v1.6.0)
 *
 * v1.6.0：
 *   - 数量不再固定默认 9：未手动设置过的视频按 Sampler.autoCount(时长) 自动分桶；
 *     手动改数量 → auto=false 按视频记住；点「清空」→ 重置为 auto=true
 *   - 缓存按数量分规格 n<count>/，切换数量时旧规格保留、直接命中不重抽
 *   - 右键预览图 → 自绘菜单「设为封面」→ item.setCustomThumbnail()
 *   - 改数量只置 pendingPrune 标记；onPluginCreate 时清理用不到的规格
 * v1.5.0：逐帧落盘 / 可续抽 / 部分失败也算完成（占位卡片）
 * v1.4.0：单选稳态；全局设置必须在 onPluginCreate 内读取（v1.3.1 回归教训）
 *
 * 高度策略：只由操作事件触发，一个事件一次同步刷新；无任何定时器 / 间隔刷新。
 * 1s 轮询只用于检测选中项变化，不触碰高度。
 */
(function () {
  'use strict';

  var S = window.Sampler;
  var L = window.Layout;
  var Store = window.Store;
  var Capture = window.Capture;

  var DEFAULT_VIEWPORT = 320;
  var SAFE_MARGIN = 4;

  var state = {
    itemId: null,
    count: null,                // 当前生效张数；auto 且时长未知时为 null
    autoMode: false,
    running: {},                // itemId -> true：按视频去重，切换选中不中断后台任务
    meta: null,
    message: '',
    kind: 'hint',
    global: { autoGenerate: false, expanded: false },
    suppressed: {},
    lastCount: S.DEFAULT_COUNT,
    baseViewport: DEFAULT_VIEWPORT,
    lastWidth: 0,
    menuIndex: null
  };

  function $(id) { return document.getElementById(id); }

  function setMessage(text, kind) {
    state.message = text || '';
    state.kind = kind || 'hint';
  }

  function friendlyError(e) {
    var code = (e && e.message) ? e.message : String(e);
    if (code.indexOf('NODE_UNAVAILABLE') >= 0) return '当前检查器环境无法调用 Node 模块，FFmpeg 不可用。';
    if (code.indexOf('FFMPEG_NOT_INSTALLED') >= 0 || code.indexOf('FFMPEG_MODULE_MISSING') >= 0) {
      return '请先在 Eagle 插件设置中安装官方「FFmpeg 依赖插件」。';
    }
    if (code.indexOf('FFMPEG_PATHS_MISSING') >= 0) return 'FFmpeg 依赖插件未返回 ffprobe 路径，无法读取视频时长。';
    if (code.indexOf('DURATION') >= 0) return '无法读取该视频时长，FFmpeg 可能不支持此文件。';
    if (code.indexOf('NO_SELECTED_ITEM') >= 0) return '请先选中一个视频文件。';
    if (code.indexOf('TIMEOUT') >= 0) return 'FFmpeg 抽帧超时，请检查文件是否损坏。';
    if (code.indexOf('EACCES') >= 0 || code.indexOf('EPERM') >= 0) return '写入缓存被拒绝，请检查 Eagle 用户数据目录权限。';
    return '操作失败：' + code.slice(0, 160);
  }

  function syncBusy() {
    var busy = !!(state.itemId && state.running[state.itemId]);
    $('generate').disabled = busy;
    $('clear').disabled = busy;
    $('tileCount').disabled = busy;
    $('autoGenerate').disabled = busy;
    $('generate').textContent = busy ? '生成中…' : '生成';
  }

  function isMine(itemId) { return state.itemId === itemId; }

  function specOf(item, count, stat) {
    var s = stat || Store.fileStat(item.filePath);
    return { itemId: item.id, count: count, sourceSize: s.size, sourceMtime: s.mtimeMs };
  }

  function syncControls() {
    $('autoGenerate').checked = state.global.autoGenerate;
    $('generate').hidden = state.global.autoGenerate;
    $('clear').hidden = state.global.autoGenerate;
    var input = $('tileCount');
    if (state.count === null) {
      input.value = '';
      input.placeholder = '自动';
    } else {
      input.value = state.count;
      input.placeholder = '';
    }
    input.title = state.autoMode
      ? ('按时长自动：' + (state.count === null ? '待读取时长' : state.count + ' 张') + '；手动输入可覆盖')
      : '0 = 此视频不生成预览图';
  }

  function describe() {
    var meta = state.meta;
    if (!meta || !meta.times || meta.times.length === 0) return '';
    var total = meta.times.length;
    var visible = L.visibleCount(total, state.global.expanded);
    var parts = [];
    parts.push(total > L.VISIBLE_LIMIT ? '显示 ' + visible + ' / 共 ' + total + ' 张' : '共 ' + total + ' 张');
    parts.push('时长 ' + S.formatTime(meta.duration));
    parts.push('间隔 ' + Number(meta.gap).toFixed(1) + 's');
    if (state.autoMode) parts.push('自动');
    if (meta.truncated) parts.push('受最低间隔限制');
    if (meta.droppedFirst) parts.push('已跳过片头');
    var results = Array.isArray(meta.results) ? meta.results : [];
    var done = results.filter(function (r) { return r === true || r === false; }).length;
    var failed = results.filter(function (r) { return r === false; }).length;
    if (failed > 0) parts.push(failed + ' 张抽帧失败');
    if (meta.complete === false) parts.push('已完成 ' + done + ' / ' + total);
    return parts.join(' · ');
  }

  /** 纯同步、幂等的高度刷新。只由事件调用，一个事件一次。 */
  function refreshLayout() {
    var grid = $('grid');
    var cells = grid.querySelectorAll('.cell');
    var n = cells.length;
    var px;
    var overflow;
    var margin;

    if (state.baseViewport < 200) {
      state.baseViewport = window.innerHeight || DEFAULT_VIEWPORT;
    }

    if (n === 0) {
      px = '0px'; overflow = 'hidden'; margin = '0px';
    } else {
      var cellH = cells[0].getBoundingClientRect().height;
      var gap = parseFloat(window.getComputedStyle(grid).rowGap) || 8;
      var target = L.heightFor(n, cellH, gap, state.global.expanded);
      var wrapH = $('wrap').getBoundingClientRect().height;
      var gridH = grid.getBoundingClientRect().height;
      var chrome = Math.max(0, wrapH - gridH);
      var avail = Math.max(0, state.baseViewport - chrome - SAFE_MARGIN);
      var fit = L.fitHeight(target, avail);
      px = fit.height + 'px';
      overflow = fit.scroll ? 'auto' : 'hidden';
      margin = '6px';
    }

    if (grid.style.height === px && grid.style.overflowY === overflow && grid.style.marginTop === margin) return;
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

    // 渲染签名含 count：同一视频切换数量规格时必须重建卡片
    var sig = [
      state.itemId || '',
      state.count === null ? 'AUTO' : state.count,
      meta ? (meta.generatedAt || 0) : 0,
      visible,
      meta && meta.results ? meta.results.map(function (r) {
        return r === true ? '1' : (r === false ? '0' : '-');
      }).join('') : ''
    ].join('|');

    if (grid.getAttribute('data-sig') !== sig) {
      grid.innerHTML = '';
      for (var i = 0; i < visible; i++) {
        var cell = document.createElement('div');
        cell.className = 'cell';
        cell.setAttribute('data-index', String(i));

        var frameStatus = meta.results ? meta.results[i] : undefined;
        if (frameStatus === false) {
          var ph = document.createElement('div');
          ph.className = 'thumb placeholder';
          ph.textContent = '抽帧失败';
          cell.appendChild(ph);
        } else if (frameStatus === undefined) {
          var pending = document.createElement('div');
          pending.className = 'thumb placeholder pending';
          pending.textContent = '待抽帧';
          cell.appendChild(pending);
        } else {
          var img = document.createElement('img');
          img.className = 'thumb';
          img.alt = '';
          img.title = S.formatTime(meta.times[i]) + '（右键设为封面）';
          if (i === visible - 1) img.addEventListener('load', refreshLayout, { once: true });
          try { img.src = Store.thumbDataURL(state.itemId, state.count, i); }
          catch (e) { img.classList.add('placeholder'); }
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
    refreshLayout();
  }

  /** 逐张替换「待抽帧」占位：只改这一格，不整块 render、不刷新高度。 */
  function replacePendingCell(itemId, count, index, ok, times) {
    var cell = $('grid').children[index];
    if (!cell) return;
    var old = cell.querySelector('.thumb.pending');
    if (!old) return;
    var repl;
    if (ok) {
      repl = document.createElement('img');
      repl.className = 'thumb';
      repl.alt = '';
      repl.title = S.formatTime(times[index]) + '（右键设为封面）';
      try { repl.src = Store.thumbDataURL(itemId, count, index); }
      catch (e) {
        repl = document.createElement('div');
        repl.className = 'thumb placeholder';
        repl.textContent = '读取失败';
      }
    } else {
      repl = document.createElement('div');
      repl.className = 'thumb placeholder';
      repl.textContent = '抽帧失败';
    }
    cell.replaceChild(repl, old);
  }

  async function selectedItem() {
    var items = await eagle.item.getSelected();
    return items && items[0];
  }

  /* ---------- 右键菜单 → 设为封面 ---------- */

  function hideCellMenu() {
    var m = $('cellMenu');
    if (m) m.hidden = true;
    state.menuIndex = null;
  }

  function showCellMenu(x, y, index) {
    var m = $('cellMenu');
    if (!m) return;
    m.style.left = Math.max(0, Math.min(x, window.innerWidth - 140)) + 'px';
    m.style.top = Math.max(0, Math.min(y, window.innerHeight - 48)) + 'px';
    m.hidden = false;
    state.menuIndex = index;
  }

  async function setCover(index) {
    hideCellMenu();
    var meta = state.meta;
    if (!state.itemId || !meta || state.count === null) return;
    if (!meta.results || meta.results[index] !== true) {
      setMessage('该帧未成功生成，无法设为封面', 'warn');
      render();
      return;
    }
    try {
      var item = await selectedItem();
      if (!item || item.id !== state.itemId) {
        setMessage('请先选中该视频再设为封面', 'warn');
        render();
        return;
      }
      if (typeof item.setCustomThumbnail !== 'function') {
        throw new Error('当前 Eagle 版本不支持设置自定义封面');
      }
      var src = Store.thumbPathFor(meta, state.itemId, state.count, index);
      // 先复制到持久 covers/，避免缓存清理影响已设置的封面
      var cover = Store.copyToCover(state.itemId, src);
      await item.setCustomThumbnail(cover);
      setMessage('已将 ' + S.formatTime(meta.times[index]) + ' 设为封面', 'ok');
    } catch (e) {
      setMessage('设为封面失败：' + String((e && e.message) || e).slice(0, 120), 'error');
    }
    render();
  }

  /* ---------- 数量决策 ---------- */

  /** 优先从已有规格 meta 读时长（且校验源文件未变），否则才跑 ffprobe。 */
  async function durationOf(item, paths, stat) {
    var cached = Store.readAnyDuration(item.id, stat);
    if (cached) return cached;
    return await Capture.probeDuration(paths.ffprobe, item.filePath);
  }

  async function generate() {
    if (!state.itemId) {
      setMessage('请先选中一个视频文件', 'warn');
      render();
      return;
    }

    // 一次选中项快照：整个任务都用这个 item，切换选中不改变任务归属
    var item;
    try { item = await selectedItem(); }
    catch (e) { setMessage(friendlyError(e), 'error'); render(); return; }
    if (!item || item.id !== state.itemId) return;

    var taskId = item.id;
    if (state.running[taskId]) return;

    var paths;
    try { paths = await Capture.ensureFFmpeg(); }
    catch (e) { setMessage(friendlyError(e), 'error'); render(); return; }

    var stat = Store.fileStat(item.filePath);
    var cfg;
    try { cfg = Store.getItemConfig(taskId); }
    catch (e) { cfg = { tileCount: null, auto: true, activeCount: null }; }

    // 手动设 0：不读时长、不抽帧（0 张是用户的显式设置，不能被自动模式覆盖）
    if (!cfg.auto && cfg.tileCount === S.MIN_COUNT) {
      disableForItem(taskId);
      return;
    }

    var duration;
    try { duration = await durationOf(item, paths, stat); }
    catch (e) { setMessage(friendlyError(e), 'error'); render(); return; }

    var count = S.clampCount(cfg.auto ? S.autoCount(duration) : cfg.tileCount);
    state.count = count;
    state.autoMode = cfg.auto;
    state.lastCount = count;
    syncControls();
    try { Store.setActiveCount(taskId, count); } catch (e) { /* 不阻塞 */ }

    var spec = specOf(item, count, stat);
    var disk = Store.readMeta(taskId, count);

    // 完整结果（含已定失败帧）→ 直接复用，不重抽
    if (Store.isCacheValid(disk, spec)) {
      if (isMine(taskId)) { state.meta = disk; setMessage(describe(), 'hint'); render(); }
      return;
    }

    state.running[taskId] = true;
    syncBusy();

    try {
      var times, results, gap, truncated, droppedFirst;
      var resuming = Store.isResumable(disk, spec);
      if (resuming) {
        times = disk.times.slice();
        results = disk.results.slice();
        gap = disk.gap;
        truncated = !!disk.truncated;
        droppedFirst = !!disk.droppedFirst;
      } else {
        var p = S.plan(duration, count);
        if (p.reason === 'too-short' || p.times.length === 0) {
          if (isMine(taskId)) {
            setMessage('视频不足 ' + S.MIN_GAP + ' 秒（时长 ' + S.formatTime(duration) + '），无法生成预览图', 'warn');
            render();
          }
          return;
        }
        times = p.times; gap = p.gap; results = new Array(times.length);
        truncated = p.truncated; droppedFirst = p.droppedFirst;
      }

      Store.ensureSpecDir(taskId, count);
      var meta = {
        rule: Store.RULE_VERSION,
        requested: count,
        count: count,
        duration: duration,
        gap: gap,
        times: times,
        results: results,
        complete: false,
        truncated: truncated,
        droppedFirst: droppedFirst,
        sourceSize: stat.size,
        sourceMtime: stat.mtimeMs,
        generatedAt: Date.now()
      };
      Store.writeProgress(taskId, count, meta);
      // 新建规格才标记清理；续抽同一规格不标记（避免把正在对比的旧规格提前删掉）
      if (!resuming) { try { Store.markPrunePending(); } catch (e) { /* ignore */ } }

      var skip = results.map(function (r) { return r === true || r === false; });
      if (isMine(taskId)) { state.meta = meta; setMessage(describe(), 'hint'); render(); }

      await Capture.captureAll(
        paths.ffmpeg, item.filePath, times,
        times.map(function (_, i) { return Store.thumbFile(taskId, count, i); }),
        function (done, totalDone) {
          if (!isMine(taskId)) return;
          setMessage('正在抽帧 ' + done + ' / ' + totalDone + ' …', 'hint');
          $('status').textContent = state.message;   // 只更新文本，不刷新高度
        },
        {
          skip: skip,
          onFrame: function (i, ok) {
            results[i] = ok;
            meta.results = results.slice();
            meta.generatedAt = Date.now();
            try { Store.writeProgress(taskId, count, meta); } catch (e) { /* 落盘失败不中断抽帧 */ }
            if (isMine(taskId)) replacePendingCell(taskId, count, i, ok, times);
          }
        }
      );

      meta.complete = true;
      meta.results = results.slice();
      meta.failed = results.filter(function (x) { return x === false; }).length;
      meta.generatedAt = Date.now();
      Store.writeMeta(taskId, count, meta);

      if (isMine(taskId)) {
        state.meta = meta;
        setMessage(describe(), meta.failed > 0 ? 'warn' : 'ok');
        render();
      }
    } catch (e) {
      if (isMine(taskId)) { setMessage(friendlyError(e), 'error'); render(); }
    } finally {
      delete state.running[taskId];
      syncBusy();
    }
  }

  function clearPreview() {
    if (!state.itemId || state.running[state.itemId]) return;
    var id = state.itemId;
    try {
      Store.clearItem(id);                                     // 删所有规格的 jpg / meta
      Store.setItemConfig(id, { auto: true, activeCount: null }); // 清空 = 恢复按时长自动
    } catch (e) {
      setMessage(friendlyError(e), 'error');
      render();
      return;
    }
    state.suppressed[id] = true;
    state.meta = null;
    state.count = null;
    state.autoMode = true;
    syncControls();
    setMessage(
      state.global.autoGenerate ? '已清空，重新选择该视频后会按时长自动生成' : '已清空，下次生成将按时长自动决定张数',
      'hint'
    );
    render();
  }

  /** 数量设为 0：保持为显式手动设置，恢复需手动改回 1–30。 */
  function disableForItem(itemId) {
    var id = itemId || state.itemId;
    if (!id) return;
    try {
      Store.clearItem(id);
      Store.setItemConfig(id, { auto: false, tileCount: 0 });
    } catch (e) {
      setMessage(friendlyError(e), 'error');
      render();
      return;
    }
    state.count = 0;
    state.autoMode = false;
    state.lastCount = 0;
    $('tileCount').value = 0;
    state.meta = null;
    setMessage('数量设为 0：此视频不生成预览图，仅保留封面；改回 1–30 可恢复', 'hint');
    render();
  }

  var ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      var item = await selectedItem();
      var id = item ? item.id : null;
      if (id === state.itemId) return;

      state.itemId = id;
      state.meta = null;
      state.count = null;
      state.autoMode = false;
      hideCellMenu();
      syncBusy();
      if (id && state.suppressed[id]) delete state.suppressed[id];

      if (!id) {
        syncControls();
        setMessage('请选中一个视频文件', 'hint');
        render();
        return;
      }

      var stat = Store.fileStat(item.filePath);
      var cfg = Store.getItemConfig(id);
      var cachedDuration = Store.readAnyDuration(id, stat);

      if (!cfg.auto && cfg.tileCount === S.MIN_COUNT) {
        state.count = 0; state.autoMode = false; state.lastCount = 0;
        syncControls();
        setMessage('此视频已设为 0 张，不生成预览图；把「数量」改为 1–30 可恢复', 'hint');
        render();
        return;
      }

      // 自动模式且已有缓存 → 立即算出张数；无缓存则显示「自动」，等 generate() 取时长
      if (cfg.auto) {
        state.autoMode = true;
        state.count = cachedDuration ? S.autoCount(cachedDuration) : null;
      } else {
        state.autoMode = false;
        state.count = cfg.tileCount;
      }
      if (state.count !== null) state.lastCount = state.count;
      syncControls();

      if (state.count !== null && state.count !== S.MIN_COUNT) {
        // 切换数量后若走缓存命中（不经过 generate），也要更新当前生效规格，
        // 否则下次启动 pruneUnused 会按旧 activeCount 保留错的那套
        try { Store.setActiveCount(id, state.count); } catch (e) { /* 不阻塞 */ }
        var spec = specOf(item, state.count, stat);
        var disk = Store.readMeta(id, state.count);
        if (Store.isCacheValid(disk, spec)) {
          state.meta = disk;
          setMessage(describe(), 'hint');
          render();
          return;
        }
        if (Store.isResumable(disk, spec)) {
          state.meta = disk;
          setMessage(describe() + (state.global.autoGenerate ? ' · 继续生成中' : ' · 点「生成」继续'), 'hint');
          syncBusy();
          render();
          if (state.global.autoGenerate) await generate();
          return;
        }
      }

      state.meta = null;
      if (state.global.autoGenerate) {
        await generate();
      } else {
        setMessage(state.count === null
          ? '按时长自动决定张数，点「生成」开始'
          : '尚未生成预览图，点「生成」按钮自动生成', 'hint');
        render();
      }
    } catch (e) {
      state.meta = null;
      setMessage(friendlyError(e), 'error');
      render();
    } finally {
      ticking = false;
    }
  }

  eagle.onPluginCreate(async function () {
    // 全局设置必须在 onPluginCreate 内读取（Eagle 保证 API 就绪）。
    // v1.3.1 曾把它提前到脚本解析阶段，导致静默回退默认值 —— 不要重演。
    try {
      state.global = Store.getGlobal();
    } catch (e) {
      setMessage(friendlyError(e), 'error');
    }

    // 上次会话切换过数量 → 本次启动清理用不到的规格（用户拍板的可靠时机）
    try {
      if (Store.getPrunePending()) {
        var pruned = Store.pruneUnused();
        Store.clearPrunePending();
        if (pruned.removed > 0 && window.console) {
          console.log('[pv-grid] pruned ' + pruned.removed + ' obsolete cache specs');
        }
      }
    } catch (e) { /* 清理失败不影响启动 */ }

    syncControls();
    var bootWrap = $('wrap');
    if (bootWrap) bootWrap.classList.remove('booting');

    try {
      var theme = await eagle.app.theme;
      document.body.setAttribute('theme', theme || 'LIGHT');
    } catch (e) { /* 主题取不到时用默认 */ }

    state.baseViewport = window.innerHeight || DEFAULT_VIEWPORT;
    state.lastWidth = Math.round(window.innerWidth);

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

    // 右键预览图 → 自绘下拉菜单（检查器环境比宿主 contextMenu 更稳、可单测）
    $('grid').addEventListener('contextmenu', function (e) {
      var cell = e.target;
      while (cell && cell !== this && !(cell.classList && cell.classList.contains('cell'))) {
        cell = cell.parentNode;
      }
      if (!cell || cell === this) return;
      var index = Array.prototype.indexOf.call(this.children, cell);
      if (index < 0 || !state.meta || !state.meta.results || state.meta.results[index] !== true) return;
      e.preventDefault();
      showCellMenu(e.clientX, e.clientY, index);
    });
    $('setCover').addEventListener('click', function (e) {
      e.stopPropagation();
      var i = state.menuIndex;
      if (i !== null) setCover(i);
    });
    document.addEventListener('click', hideCellMenu);
    window.addEventListener('blur', hideCellMenu);

    $('autoGenerate').addEventListener('change', function () {
      state.global.autoGenerate = !!this.checked;
      try { Store.setGlobal({ autoGenerate: state.global.autoGenerate }); } catch (e) { /* ignore */ }
      syncControls();
      setMessage(state.global.autoGenerate ? '自动生成已开启：选择视频时自动生成' : '自动生成已关闭', 'hint');
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
      if (n === S.MIN_COUNT) { disableForItem(state.itemId); return; }

      // 手动改数量 → 退出自动模式，按视频记住
      try { Store.setItemConfig(state.itemId, { auto: false, tileCount: n }); } catch (e) { /* ignore */ }
      state.count = n;
      state.autoMode = false;
      syncControls();

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
    });

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
