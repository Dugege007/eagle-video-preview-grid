/**
 * main.js — 检查器区块 UI 与生命周期 (v1.3.0)
 *
 * 全局状态（settings.json）：自动生成开关、展开/折叠 —— 切换视频保持
 * 单项状态（thumbs/<itemId>/config.json）：生成数量 —— 各视频互相独立
 *   数量 0 表示该视频不生成预览图：清掉已有缩图、不调用 FFmpeg、网格高度 0。
 *   改回 1–30 立即恢复，不需要重新选择视频。
 * 内存状态：清空后的「抑制自动生成」标记，重新选择该视频时解除
 *
 * 多选（v1.3.0，manifest.multiSelect = true）：
 *   - 选中 >1 个视频时隐藏所有缩略图、隐藏「生成 / 清空」，提示「请谨慎修改」；
 *   - 数量输入确认后弹窗确认，确认才批量写入各视频配置并生成，取消不改动任何视频；
 *   - 多选时不触发「自动生成」，避免一次选中就批量抽帧。
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
  var B = window.Batch;
  var Store = window.Store;
  var Capture = window.Capture;

  var DEFAULT_VIEWPORT = 320;   // manifest 的 inspector.height，作为拿不到视口时的兜底
  var SAFE_MARGIN = 4;          // 防裁切的固定余量
  var BATCH_LOCK_KEY = 'pv-grid-batch-lock';
  var BATCH_LOCK_MS = 10000;    // 锁残留最多挡 10 秒，避免实例崩溃后永久不可用

  var state = {
    itemId: null,
    selection: [],              // 当前选中的视频 items（多选时为全部）
    selectionSig: null,         // 选中集合签名，只与视频 id 有关
    multi: false,
    busy: false,
    meta: null,
    message: '',
    kind: 'hint',
    global: { autoGenerate: false, expanded: false },
    suppressed: {},             // itemId -> true
    lastCount: S.DEFAULT_COUNT,
    baseViewport: DEFAULT_VIEWPORT, // 只取一次，之后永不更新
    lastWidth: 0                // 最近一次已知的 iframe 宽度
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
    // 自动生成开启时、或多选时：手动「生成」与「清空」都隐藏
    var hideManual = state.global.autoGenerate || state.multi;
    $('generate').hidden = hideManual;
    $('clear').hidden = hideManual;

    var input = $('tileCount');
    if (state.multi) {
      // 多选时各视频数量可能不同，不显示任何一个的值，避免误导
      input.value = '';
      input.placeholder = '批量';
    } else {
      input.placeholder = '';
      input.value = state.lastCount;
    }
  }

  function multiHint() {
    return '已选中 ' + state.selection.length + ' 个视频 · 预览图已隐藏 · 请谨慎修改';
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

    // 插件 iframe 刚创建时 Eagle 可能还没给它分配最终高度，
    // 首个视频的首次测量会偏小。只在基准明显不可信时重取一次，之后仍固定不变
    // （不引入定时器；这正是 v0.3.1 修掉反馈循环的关键约束）。
    if (state.baseViewport < 200) {
      state.baseViewport = window.innerHeight || DEFAULT_VIEWPORT;
    }

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
    // 多选时无条件隐藏所有缩略图（不是「显示某一个视频的图」）
    var meta = state.multi ? null : state.meta;
    var total = (meta && meta.times) ? meta.times.length : 0;
    var visible = L.visibleCount(total, state.global.expanded);
    var showToggle = L.needsToggle(total);

    // C：渲染签名只在「内容」变化时改变。状态文本更新 / 高度刷新不重建卡片、
    // 不重复读盘取 base64（store.js 也有一层内存缓存）。
    var sig = [
      state.multi ? 'MULTI' : (state.itemId || ''),
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
          // 首次生成时图片尚未解码完成，cellH 可能量到未布局的值。
          // 最后一张图 load 后再同步校准一次高度：纯事件、一次；
          // refreshLayout() 有幂等短路，值相同就不会写 DOM。
          if (i === visible - 1) {
            img.addEventListener('load', refreshLayout, { once: true });
          }
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

  /** 官方：getSelected() 返回 Promise<items: Item[]>；兼容非数组返回。 */
  async function selectedItems() {
    var items = await eagle.item.getSelected();
    if (!items) return [];
    return Array.isArray(items) ? items : [items];
  }

  async function selectedItem() {
    var items = await selectedItems();
    return items[0];
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

  /* ---------- 批量确认弹窗 ---------- */

  /**
   * 优先用官方 eagle.dialog.showMessageBox（返回 {response: 按钮索引}）；
   * 检查器环境不支持 / 调用失败时回退到区块内 DOM 模态框。
   * buttons 顺序刻意是 ['取消','确认']：回车默认落在「取消」，避免误改。
   * @returns {Promise<boolean>} 是否点了「确认」
   */
  function askConfirm(message, detail, title) {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(ok) {
        if (settled) return;
        settled = true;
        resolve(ok);
      }
      function domFallback() {
        var modal = $('confirm');
        $('confirmTitle').textContent = title || '批量修改确认';
        $('confirmMessage').textContent = message;
        $('confirmDetail').textContent = detail;
        modal.hidden = false;
        $('confirmOk').onclick = function () { modal.hidden = true; finish(true); };
        $('confirmCancel').onclick = function () { modal.hidden = true; finish(false); };
      }
      try {
        if (eagle.dialog && typeof eagle.dialog.showMessageBox === 'function') {
          var p = eagle.dialog.showMessageBox({
            title: title || '批量修改确认',
            message: message,
            detail: detail,
            buttons: ['取消', '确认'],
            type: 'warning'
          });
          if (p && typeof p.then === 'function') {
            p.then(function (r) { finish(!!r && r.response === 1); })
              .catch(domFallback);
            return;
          }
        }
      } catch (e) { /* 回退到 DOM */ }
      domFallback();
    });
  }

  /**
   * 若 Eagle 在 multiSelect 下创建了多个检查器 iframe 实例，同一批选择可能触发
   * 多次确认 / 重复抽帧。localStorage 同源共享，用它做轻量去重；
   * 不可用时放行（宁可重复也不阻止用户操作），完成时立即清除。
   */
  function claimBatch() {
    try {
      var now = Date.now();
      var prev = Number(localStorage.getItem(BATCH_LOCK_KEY) || 0);
      if (prev && now - prev < BATCH_LOCK_MS) return false;
      localStorage.setItem(BATCH_LOCK_KEY, String(now));
      return true;
    } catch (e) {
      return true;
    }
  }

  function releaseBatch() {
    try { localStorage.removeItem(BATCH_LOCK_KEY); } catch (e) { /* ignore */ }
  }

  /* ---------- 单选：生成 / 清空 / 设为 0（v1.2.0 行为，未改动） ---------- */

  async function generate() {
    if (state.busy || state.multi) return;
    if (!state.itemId) {
      setMessage('请先选中一个视频文件', 'warn');
      render();
      return;
    }

    var count = S.clampCount($('tileCount').value);
    $('tileCount').value = count;
    state.lastCount = count;

    // 0 张：该视频不生成预览图。连时长都不读，也不触发任何 FFmpeg 进程。
    if (count === S.MIN_COUNT) {
      disableForItem();
      return;
    }

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
    if (state.busy || state.multi || !state.itemId) return;
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

  /**
   * 数量设为 0：该视频不生成预览图。
   * 删除已生成的缩图缓存，config.json 写入 0（按视频各自保存），网格高度归 0。
   * 不调用 ffprobe / ffmpeg，也不写 suppressed —— 数量改回 1–30 可立即恢复生成。
   */
  function disableForItem() {
    var id = state.itemId;
    try {
      Store.clearItem(id);                       // 删 jpg + meta.json，保留 config.json
      Store.setItemConfig(id, { tileCount: 0 });
    } catch (e) {
      setMessage(friendlyError(e), 'error');
      render();
      return;
    }
    state.lastCount = 0;
    $('tileCount').value = 0;
    state.meta = null;
    setMessage('数量设为 0：此视频不生成预览图，仅保留封面；改回 1–30 可恢复', 'hint');
    render();                                  // 本次事件的一次刷新
  }

  /* ---------- 多选：批量应用 ---------- */

  /**
   * 确认后统一修改数量并生成。串行处理视频（每个视频内部抽帧并发 2），
   * 单个视频失败不中断整批；缓存符合数量 / 规则 / 源文件时直接跳过。
   * 不写 state.meta —— 多选态始终不显示缩略图。
   */
  async function batchApply(items, count) {
    if (state.busy) return;
    if (!claimBatch()) {
      setMessage('另一个检查器实例正在处理批量修改，请稍后再试', 'warn');
      render();
      return;
    }

    setBusy(true);
    var total = items.length;
    var skipped = 0;
    var failed = 0;
    var paths = null;

    try {
      if (count !== S.MIN_COUNT) {
        paths = await Capture.ensureFFmpeg();   // 依赖缺失时整批直接中止，不逐个报错
      }

      for (var i = 0; i < total; i++) {
        var item = items[i];
        setMessage('批量处理 ' + (i + 1) + ' / ' + total + ' …', 'hint');
        $('status').textContent = state.message;   // 只更新文本，不触发高度刷新

        try {
          Store.setItemConfig(item.id, { tileCount: count });

          if (count === S.MIN_COUNT) {
            Store.clearItem(item.id);              // clearItem 保留 config.json，0 已写入
            continue;
          }

          if (loadCacheIfValid(item, count)) { skipped++; continue; }

          var duration = await Capture.probeDuration(paths.ffprobe, item.filePath);
          var p = S.plan(duration, count);
          if (p.reason === 'too-short' || p.times.length === 0) { skipped++; continue; }

          Store.ensureItemDir(item.id);
          var outPaths = p.times.map(function (_, k) { return Store.thumbFile(item.id, k); });
          var r = await Capture.captureAll(
            paths.ffmpeg, item.filePath, p.times, outPaths,
            function (done, t) {
              setMessage('批量 ' + (i + 1) + '/' + total + ' · 抽帧 ' + done + '/' + t + ' …', 'hint');
              $('status').textContent = state.message;
            }
          );

          var stat = Store.fileStat(item.filePath);
          Store.writeMeta(item.id, {
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
          });
          if (r.failures > 0) failed++;
        } catch (e) {
          failed++;                              // 单视频失败不影响其余视频
        }
      }

      setMessage(B.summary(total, count, skipped, failed), failed ? 'warn' : 'ok');
    } catch (e) {
      setMessage(friendlyError(e), 'error');
    } finally {
      setBusy(false);
      releaseBatch();
      render();
    }
  }

  /* ---------- 选中项轮询（官方没有选中变化 event） ---------- */

  var ticking = false;
  async function tick() {
    if (ticking || state.busy) return;
    ticking = true;
    try {
      // 只检测「选中项变化」；不读取尺寸、不刷新高度。
      var items = await selectedItems();
      var sig = B.selectionSignature(items);
      if (sig === state.selectionSig) return;

      state.selectionSig = sig;
      var videos = B.videosOnly(items);
      state.selection = videos;
      state.multi = videos.length > 1;

      // 多选：隐藏所有缩略图、隐藏手动按钮、提示谨慎修改；不自动生成
      if (state.multi) {
        state.itemId = null;
        state.meta = null;
        syncControls();
        var ignored = items.length - videos.length;   // 混合选中时说明哪些被忽略
        setMessage(
          multiHint() +
          (ignored > 0 ? ' · 已忽略 ' + ignored + ' 个非视频素材' : '') +
          '；在「数量」输入后确认即可批量修改',
          'warn'
        );
        render();
        return;
      }

      var item = videos[0] || null;
      var id = item ? item.id : null;
      state.itemId = id;
      if (id && state.suppressed[id]) delete state.suppressed[id];  // 重新选择 -> 解除抑制

      if (!id) {
        state.meta = null;
        syncControls();
        setMessage('请选中一个视频文件', 'hint');
        render();
        return;
      }

      // 数量是单项配置：读这个视频自己的，不用上一次视频的值
      var cfg = Store.getItemConfig(id);
      state.lastCount = cfg.tileCount;
      syncControls();

      // 该视频设为 0 张：即使「自动生成」开启也跳过，不读缓存、不抽帧。
      if (cfg.tileCount === S.MIN_COUNT) {
        state.meta = null;
        setMessage('此视频已设为 0 张，不生成预览图；把「数量」改为 1–30 可恢复', 'hint');
        render();          // 重新选择资源：一次刷新
        return;
      }

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
        (state.multi ? '多选中 · 预览图已隐藏 · ' : '') +
        (state.global.autoGenerate ? '自动生成已开启：选择视频时自动生成' : '自动生成已关闭'),
        state.multi ? 'warn' : 'hint'
      );
      render();            // 开关切换：一次刷新
    });

    $('toggle').addEventListener('click', function () {
      if (state.multi) return;
      state.global.expanded = !state.global.expanded;
      try { Store.setGlobal({ expanded: state.global.expanded }); } catch (e) { /* ignore */ }
      setMessage(describe(), 'hint');
      render();            // 展开 / 收起：一次刷新
    });

    $('tileCount').addEventListener('change', async function () {
      if (state.busy) return;
      var input = this;
      var raw = input.value;

      /* ---- 多选：先弹窗确认，取消则不改任何视频 ---- */
      if (state.multi) {
        if (String(raw).trim() === '') { input.value = ''; return; }  // 空输入不算修改
        var snapshot = state.selection.slice();
        var k = snapshot.length;
        if (!k) { input.value = ''; return; }

        var bn = S.clampCount(raw);
        var ok = await askConfirm(B.confirmMessage(k, bn), B.confirmDetail(k, bn));

        // 弹窗期间用户可能改了选择；以弹窗时那批视频为准，不一致就放弃并要求重新确认
        if (ok && (!state.multi ||
                   B.selectionSignature(state.selection) !== B.selectionSignature(snapshot))) {
          setMessage(state.multi
            ? multiHint() + ' · 选择已变化，请重新输入数量确认'
            : '选择已变化，未执行批量修改', 'warn');
          syncControls();
          render();
          return;
        }
        if (!ok) {
          setMessage(state.multi
            ? multiHint() + ' · 已取消，未改动任何视频'
            : '已取消批量修改，未改动任何视频', 'hint');
          syncControls();     // 多选时把输入框恢复为空；单选时恢复该视频自己的数量
          render();
          return;
        }

        input.value = bn;
        await batchApply(snapshot, bn);
        return;
      }

      /* ---- 单选：v1.2.0 原有逻辑 ---- */
      var n = S.clampCount(raw);
      input.value = n;
      state.lastCount = n;
      if (!state.itemId) return;

      // 0 张统一走同一入口：不论「自动生成」开关状态，都立即清缓存并记住该设置，
      // 绝不会因为开关开启而被 generate() 重新生成回来。
      if (n === S.MIN_COUNT) {
        disableForItem();
        return;
      }

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
