/**
 * 抽帧参数单测 —— 不依赖测试框架，Node 16+ 可直接运行：
 *   node test/capture.test.js
 *
 * 覆盖 v1.1.0 的 B（缩图宽度）、E（-accurate_seek）、以及数组参数路径安全。
 */
'use strict';

var assert = require('assert');
var C = require('../js/capture.js');

var cases = [];
function test(name, fn) { cases.push({ name: name, fn: fn }); }

test('参数顺序：-accurate_seek 与 -ss 都在 -i 之前（输入层快速 seek）', function () {
  var args = C.buildCaptureArgs('V.mp4', 12.5, '0.jpg');
  assert.ok(Array.isArray(args));
  assert.ok(args.indexOf('-accurate_seek') < args.indexOf('-i'));
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'));
  assert.ok(args.indexOf('-frames:v') > args.indexOf('-i'));
});

test('B：缩图宽度 192（scale=192:-2），不是旧的 320', function () {
  var args = C.buildCaptureArgs('V.mp4', 3, '0.jpg');
  assert.strictEqual(C.THUMB_WIDTH, 192);
  assert.ok(args.indexOf('scale=192:-2') !== -1);
  assert.ok(args.indexOf('scale=320:-2') === -1);
});

test('E：显式 -accurate_seek；-frames:v 1 单点输出；-q:v 3', function () {
  var args = C.buildCaptureArgs('V.mp4', 3, '0.jpg');
  assert.ok(args.indexOf('-accurate_seek') !== -1);
  assert.strictEqual(args[args.indexOf('-frames:v') + 1], '1');
  assert.strictEqual(args[args.indexOf('-q:v') + 1], '3');
});

test('时间点与路径原样传入（浮点秒、中文、空格都不做 shell 拼接）', function () {
  var src = 'D:\\素材\\我的 视频.mp4';
  var out = 'D:\\缓存\\0.jpg';
  var args = C.buildCaptureArgs(src, 10.37, out);
  assert.strictEqual(args[args.indexOf('-ss') + 1], '10.37');
  assert.strictEqual(args[args.indexOf('-i') + 1], src);
  assert.strictEqual(args[args.length - 1], out);
  assert.ok(args.indexOf('-y') !== -1);
});

test('并发上限仍为 2', function () {
  assert.strictEqual(C.MAX_CONCURRENCY, 2);
});

test('v1.7.0 原帧：不含 scale / -vf，保留视频原始分辨率', function () {
  var args = C.buildFrameArgs('V.mp4', 12.5, 'frame.jpg');
  assert.strictEqual(args.indexOf('-vf'), -1);
  assert.ok(args.join(' ').indexOf('scale=') === -1, '原帧不能被缩放');
});

test('v1.7.0 原帧：-q:v 2 高质量、单点、精确 seek、路径原样', function () {
  var src = 'D:\\素材\\我的 视频.mp4';
  var out = 'D:\\缓存\\frame.jpg';
  var args = C.buildFrameArgs(src, 10.37, out);
  assert.strictEqual(args[args.indexOf('-q:v') + 1], '2');
  assert.strictEqual(args[args.indexOf('-frames:v') + 1], '1');
  assert.ok(args.indexOf('-accurate_seek') < args.indexOf('-i'));
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'));
  assert.strictEqual(args[args.indexOf('-ss') + 1], '10.37');
  assert.strictEqual(args[args.indexOf('-i') + 1], src);
  assert.strictEqual(args[args.length - 1], out);
});

test('回归：缩图仍是 192px / -q:v 3，两套参数互不污染', function () {
  var thumb = C.buildCaptureArgs('V.mp4', 3, '0.jpg');
  assert.ok(thumb.join(' ').indexOf('scale=192:-2') >= 0);
  assert.strictEqual(thumb[thumb.indexOf('-q:v') + 1], '3');
  assert.strictEqual(typeof C.captureFrame, 'function');
});

test('skip 跳过已决帧、只抽 pending；onFrame 逐帧回调；进度是真实完成数', async function () {
  var called = [];
  var frames = [];
  var progress = [];
  var times = [1, 2, 3, 4];
  var outs = times.map(function (_, i) { return i + '.jpg'; });
  var r = await C.captureAll('ffmpeg', 'V.mp4', times, outs,
    function (done, total) { progress.push(done + '/' + total); },
    {
      skip: [true, false, true, false],
      runner: function () {
        called.push(arguments[2]);            // 第 3 个参数是时间点
        return Promise.resolve();
      },
      onFrame: function (i, ok) { frames.push(i + ':' + ok); }
    }
  );
  assert.deepStrictEqual(called.sort(function (a, b) { return a - b; }), [2, 4]);
  assert.deepStrictEqual(frames.sort(), ['1:true', '3:true']);
  assert.strictEqual(progress.length, 4);   // 含 2 次 skip，共 4 次完成事件
  assert.strictEqual(progress[progress.length - 1], '4/4');
  assert.strictEqual(r.failures, 0);
  assert.strictEqual(r.results[0], undefined);   // skip 帧不写 results，由调用方草稿保留
  assert.strictEqual(r.results[1], true);
});

test('单帧失败记为 false，不中断其它帧', async function () {
  var frames = [];
  var times = [10, 20, 30];
  var r = await C.captureAll('ffmpeg', 'V.mp4', times,
    times.map(function (_, i) { return i + '.jpg'; }),
    null,
    {
      runner: function (ff, fp, t) {
        if (t === 20) return Promise.reject(new Error('EXIT_1'));
        return Promise.resolve();
      },
      onFrame: function (i, ok) { frames.push(i + ':' + ok); }
    }
  );
  assert.strictEqual(r.failures, 1);
  assert.ok(frames.indexOf('1:false') >= 0);
  assert.ok(frames.indexOf('0:true') >= 0);
  assert.ok(frames.indexOf('2:true') >= 0);
});

var failed = 0;
(async function () {
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    try {
      await c.fn();                          // 同步与异步用例都支持
      console.log('  PASS  ' + c.name);
    } catch (e) {
      failed++;
      console.error('  FAIL  ' + c.name + '\n        ' + e.message);
    }
  }
  console.log('\n' + (cases.length - failed) + '/' + cases.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
