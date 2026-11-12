/**
 * main.js — 检查器区块的 UI 与生命周期
 *
 * 本期范围：一键生成静态预览图 + 图下小字时间码 + 前 9 张折叠展开。
 * 明确不做：点击跳转播放、快捷键、自定义取帧、可编辑描述、hover 播放。
 */
(function () {
  'use strict';

  var S = window.Sampler;
  var Store = window.Store;
  var Capture = window.Capture;
  var VISIBLE_LIMIT = 9;

  var state = {
    itemId: null,
    expanded: false,
    busy: false,
    meta: null,
    message: '',
    kind: 'hint'
  };

  function $(id) { return document.getElementById(id); }

  function setMessage(text, kind) {
    state.message = text || '';
    state.kind = kind || 'hint';
  }

  function friendlyError(e) {
    var code = (e && e.message) ? e.message : String(e);
    if (code.indexOf('NODE_UNAVAILABLE') >= 0) {
      return '当前检查器环境无法调用 Node 模块，FFmpeg 不可用（需确认检查器插件的 Node 集成）。';
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
    return '生成失败：' + code.slice(0, 160);
  }

  function setBusy(busy) {
    state.busy = busy;
    $('generate').disabled = busy;
    $('tileCount').disabled = busy;
    $('generate').textContent = busy ? '生成中…' : '生成';
  }

  function render() {
    var status = $('status');
    status.textContent = state.message;
    status.className = 'status ' + state.kind;

    var grid = $('grid');
    grid.innerHTML = '';
    $('toggle').hidden = true;
    $('counter').textContent = '';

    var meta = state.meta;
    if (!meta || !meta.times || meta.times.length === 0) return;

    var total = meta.times.length;
    var visible = state.expanded ? total : Math.min(VISIBLE_LIMIT, total);

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

    $('counter').textContent = '显示 ' + visible + ' / 共 ' + total + ' 张';
    if (total > VISIBLE_LIMIT) {
      var btn = $('toggle');
      btn.hidden = false;
      btn.textContent = state.expanded ? '收起 ▴' : '展开 ▾';
    }
  }

  async function refresh() {
    if (!state.itemId) {
      state.meta = null;
      setMessage('请选中一个视频文件', 'hint');
      render();
      return;
    }
    try {
      var items = await eagle.item.getSelected();
      var item = items && items[0];
      if (!item) {
        state.meta = null;
        setMessage('请选中一个视频文件', 'hint');
        render();
        return;
      }

      var stat = Store.fileStat(item.filePath);
      var settings = Store.getSettings();
      var meta = Store.readMeta(state.itemId);

      if (Store.isCacheValid(meta, {
        itemId: state.itemId,
        count: settings.tileCount,
        sourceSize: stat.size,
        sourceMtime: stat.mtimeMs
      })) {
        state.meta = meta;
        setMessage(
          '时长 ' + S.formatTime(meta.duration) + ' · 间隔 ' + Number(meta.gap).toFixed(1) + 's',
          'hint'
        );
      } else {
        state.meta = null;
        setMessage('尚未生成预览图，点「生成」按钮自动生成', 'hint');
      }
    } catch (e) {
      state.meta = null;
      setMessage(friendlyError(e), 'error');
    }
    render();
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
    try { Store.setSettings({ tileCount: count }); } catch (e) { /* 设置写失败不阻塞 */ }

    setBusy(true);
    setMessage('正在读取视频时长…', 'hint');
    render();

    try {
      var items = await eagle.item.getSelected();
      var item = items && items[0];
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
      state.expanded = false;

      var note = '共 ' + p.times.length + ' 张';
      if (p.truncated) note += '（低于设定数量：最低间隔 ' + S.MIN_GAP + 's）';
      if (p.droppedFirst) note += '（已跳过片头首段）';
      if (r.failures > 0) note += ' · ' + r.failures + ' 张抽帧失败';
      setMessage(note, r.failures > 0 ? 'warn' : 'ok');
    } catch (e) {
      setMessage(friendlyError(e), 'error');
    } finally {
      setBusy(false);
      render();
    }
  }

  var ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      // 官方 7 个 event 中没有「选中项变化」，只能轮询。
      var items = await eagle.item.getSelected();
      var item = items && items[0];
      var id = item ? item.id : null;
      if (id !== state.itemId) {
        state.itemId = id;
        state.expanded = false;
        await refresh();
      }
    } catch (e) {
      // 轮询异常不打断后续轮询
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
      $('tileCount').value = Store.getSettings().tileCount;
    } catch (e) {
      setMessage(friendlyError(e), 'error');
    }

    $('generate').addEventListener('click', generate);

    $('toggle').addEventListener('click', function () {
      state.expanded = !state.expanded;
      render();
    });

    $('tileCount').addEventListener('change', function () {
      var n = S.clampCount(this.value);
      this.value = n;
      try { Store.setSettings({ tileCount: n }); } catch (e) { /* ignore */ }
      if (state.meta && state.meta.count !== n) {
        state.meta = null;
        setMessage('数量已改为 ' + n + '，点「生成」重新生成', 'hint');
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
