/**
 * capture.js — 通过官方 FFmpeg 依赖插件取时长并抽帧
 *
 * 重要：不用 <video> + canvas。检查器 iframe 与 Eagle 主播放器同属 Chromium 107，
 * 对不被该管线支持的编码一样解不动；FFmpeg 是独立解码链路，必须作为默认通道。
 *
 * v1.1.0 性能/防御优化：
 *   B 缩图 320 -> 192（检查器 3 列每列约 100px，320 是 3 倍冗余）
 *   D 缓存 getPaths() / isInstalled() 结果，避免每次生成重复 IPC
 *   E 显式 -accurate_seek，不依赖 FFmpeg 默认行为
 *   参数构造抽成纯函数 buildCaptureArgs()，便于单测（数组参数，中文路径安全）
 */
(function (global) {
  'use strict';

  var MAX_CONCURRENCY = 2;
  var THUMB_WIDTH = 192;
  var cachedPaths = null;   // 插件进程生命周期内不变，无需每次生成重新查询

  /** 单点抽帧参数：纯函数，可单测。-ss 前置 = 输入层快速 seek，只解一个短 GOP。 */
  function buildCaptureArgs(filePath, t, outPath) {
    return [
      '-y',
      '-accurate_seek',
      '-ss', String(t),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', 'scale=' + THUMB_WIDTH + ':-2',
      '-q:v', '3',
      outPath
    ];
  }

  /**
   * 原尺寸帧参数（v1.7.0）：故意不加任何 -vf scale，保留视频原始分辨率。
   * 用于右键菜单的「设为视频封面 / 复制 / 另存为」——192px 缩略图做封面太糊。
   * -q:v 2 是高质量 JPEG（FFmpeg 的 mjpeg 质量标度，越小越好），比缩图的 3 更清晰。
   */
  function buildFrameArgs(filePath, t, outPath) {
    return [
      '-y',
      '-accurate_seek',
      '-ss', String(t),
      '-i', filePath,
      '-frames:v', '1',
      '-q:v', '2',
      outPath
    ];
  }

  function childProcess() {
    if (typeof require !== 'function') throw new Error('NODE_UNAVAILABLE');
    return require('child_process');
  }

  function run(bin, args, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var cp = childProcess();
      var child;
      var done = false;
      var outBuf = '';
      var errBuf = '';

      try {
        child = cp.spawn(bin, args, { windowsHide: true });
      } catch (e) {
        return reject(e);
      }

      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { child.kill(); } catch (e) { /* ignore */ }
        reject(new Error('TIMEOUT'));
      }, timeoutMs || 60000);

      if (child.stdout) child.stdout.on('data', function (d) { outBuf += d.toString(); });
      if (child.stderr) child.stderr.on('data', function (d) { errBuf += d.toString(); });

      child.on('error', function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });

      child.on('close', function (code) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (code === 0) resolve(outBuf);
        else reject(new Error('EXIT_' + code + ': ' + errBuf.slice(-500)));
      });
    });
  }

  async function ensureFFmpeg() {
    if (cachedPaths) return cachedPaths;   // D：一次查询，后续复用
    var mod = eagle.extraModule && eagle.extraModule.ffmpeg;
    if (!mod) throw new Error('FFMPEG_MODULE_MISSING');
    if (typeof mod.isInstalled === 'function' && !(await mod.isInstalled())) {
      throw new Error('FFMPEG_NOT_INSTALLED');
    }
    var paths = await mod.getPaths();
    if (!paths || !paths.ffmpeg || !paths.ffprobe) throw new Error('FFMPEG_PATHS_MISSING');
    cachedPaths = paths;
    return paths;
  }

  async function probeDuration(ffprobe, filePath) {
    var out = await run(ffprobe, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      filePath
    ], 30000);
    var data;
    try { data = JSON.parse(out); } catch (e) { throw new Error('DURATION_PARSE_FAILED'); }
    var d = Number(data && data.format && data.format.duration);
    if (!isFinite(d) || d <= 0) throw new Error('DURATION_UNAVAILABLE');
    return d;
  }

  /**
   * -ss 放在 -i 之前是快速 seek；显式 -accurate_seek 会解码到精确目标点，
   * 因此时间码与出图一致（不会落到最近关键帧）。
   */
  async function captureOne(ffmpeg, filePath, t, outPath) {
    await run(ffmpeg, buildCaptureArgs(filePath, t, outPath), 60000);
  }

  /** 抽一张不缩放的原帧；输出是否落盘由调用方检查（便于单测注入 runner）。 */
  async function captureFrame(ffmpeg, filePath, t, outPath) {
    await run(ffmpeg, buildFrameArgs(filePath, t, outPath), 60000);
  }

  /**
   * opts.skip[i]     = 已决帧（成功或已定失败）→ 直接跳过，不重抽
   * opts.onFrame(i,ok)= 每完成一帧回调，供调用方逐帧落盘
   * opts.runner      = 注入单点抽帧实现，便于单测（默认真正 spawn FFmpeg）
   * onProgress       = 真实完成计数（含 skip），不再是「已分配索引 i+1」
   */
  async function captureAll(ffmpeg, filePath, times, outPaths, onProgress, opts) {
    opts = opts || {};
    var runner = opts.runner || captureOne;
    var skip = opts.skip || [];
    var results = new Array(times.length);
    var next = 0;
    var completed = 0;
    var failures = 0;

    async function worker() {
      while (true) {
        var i = next++;
        if (i >= times.length) return;
        if (skip[i]) {
          completed++;
          if (onProgress) onProgress(completed, times.length);
          continue;
        }
        var ok;
        try {
          await runner(ffmpeg, filePath, times[i], outPaths[i]);
          ok = true;
        } catch (e) {
          ok = false;
          failures++;
        }
        results[i] = ok;
        completed++;
        if (opts.onFrame) opts.onFrame(i, ok);
        if (onProgress) onProgress(completed, times.length);
      }
    }

    var workers = [];
    var n = Math.min(MAX_CONCURRENCY, times.length);
    for (var w = 0; w < n; w++) workers.push(worker());
    await Promise.all(workers);
    return { results: results, failures: failures };
  }

  var api = {
    MAX_CONCURRENCY: MAX_CONCURRENCY,
    THUMB_WIDTH: THUMB_WIDTH,
    buildCaptureArgs: buildCaptureArgs,
    buildFrameArgs: buildFrameArgs,
    ensureFFmpeg: ensureFFmpeg,
    probeDuration: probeDuration,
    captureOne: captureOne,
    captureFrame: captureFrame,
    captureAll: captureAll
  };

  global.Capture = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
