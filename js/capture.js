/**
 * capture.js — 通过官方 FFmpeg 依赖插件取时长并抽帧
 *
 * 重要：不用 <video> + canvas。检查器 iframe 与 Eagle 主播放器同属 Chromium 107，
 * 对不被该管线支持的编码一样解不动；FFmpeg 是独立解码链路，必须作为默认通道。
 */
(function (global) {
  'use strict';

  var MAX_CONCURRENCY = 2;

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
    var mod = eagle.extraModule && eagle.extraModule.ffmpeg;
    if (!mod) throw new Error('FFMPEG_MODULE_MISSING');
    if (typeof mod.isInstalled === 'function' && !(await mod.isInstalled())) {
      throw new Error('FFMPEG_NOT_INSTALLED');
    }
    var paths = await mod.getPaths();
    if (!paths || !paths.ffmpeg || !paths.ffprobe) throw new Error('FFMPEG_PATHS_MISSING');
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
   * -ss 放在 -i 之前是快速 seek；FFmpeg 的 accurate_seek 默认开启，
   * 会解码到精确目标点，因此时间码与出图一致（不会落到最近关键帧）。
   */
  async function captureOne(ffmpeg, filePath, t, outPath) {
    await run(ffmpeg, [
      '-y',
      '-ss', String(t),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', 'scale=320:-2',
      '-q:v', '3',
      outPath
    ], 60000);
  }

  async function captureAll(ffmpeg, filePath, times, outPaths, onProgress) {
    var results = new Array(times.length);
    var next = 0;
    var failures = 0;

    async function worker() {
      while (true) {
        var i = next++;
        if (i >= times.length) return;
        try {
          await captureOne(ffmpeg, filePath, times[i], outPaths[i]);
          results[i] = true;
        } catch (e) {
          results[i] = false;
          failures++;
        }
        if (onProgress) onProgress(i + 1, times.length);
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
    ensureFFmpeg: ensureFFmpeg,
    probeDuration: probeDuration,
    captureOne: captureOne,
    captureAll: captureAll
  };

  global.Capture = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
