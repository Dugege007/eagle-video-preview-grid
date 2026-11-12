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

var failed = 0;
cases.forEach(function (c) {
  try {
    c.fn();
    console.log('  PASS  ' + c.name);
  } catch (e) {
    failed++;
    console.error('  FAIL  ' + c.name + '\n        ' + e.message);
  }
});
console.log('\n' + (cases.length - failed) + '/' + cases.length + ' passed');
process.exit(failed ? 1 : 0);
