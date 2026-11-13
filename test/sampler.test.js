/**
 * 采样算法单测 —— 不依赖测试框架，Node 16+ 可直接运行：
 *   node test/sampler.test.js
 */
'use strict';

var assert = require('assert');
var S = require('../js/sampler.js');

var cases = [];
function test(name, fn) { cases.push({ name: name, fn: fn }); }

test('需求方给的例子：28s / 9 张 -> 3/8/13/18/23s', function () {
  var p = S.plan(28, 9);
  assert.deepStrictEqual(p.times, [3, 8, 13, 18, 23]);
  assert.strictEqual(p.actual, 5);
  assert.strictEqual(p.gap, 5);
  assert.strictEqual(p.truncated, true);
  assert.strictEqual(p.reason, 'ok');
});

test('标准情形：100s / 9 张 -> 10..90s（分 10 段取中间 9 个连接处）', function () {
  var p = S.plan(100, 9);
  assert.deepStrictEqual(p.times, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  assert.strictEqual(p.actual, 9);
  assert.strictEqual(p.gap, 10);
  assert.strictEqual(p.truncated, false);
});

test('恰好 5s 间隔：50s / 9 张 -> 5..45s', function () {
  var p = S.plan(50, 9);
  assert.deepStrictEqual(p.times, [5, 10, 15, 20, 25, 30, 35, 40, 45]);
  assert.strictEqual(p.actual, 9);
});

test('边界：40s / 9 张首点落在 0s，按保护规则跳过片头首段 -> 5..35s（7 张）', function () {
  var p = S.plan(40, 9);
  assert.deepStrictEqual(p.times, [5, 10, 15, 20, 25, 30, 35]);
  assert.strictEqual(p.actual, 7);
  assert.strictEqual(p.droppedFirst, true);
});

test('短视频：12s / 9 张 -> 2/7s（首部余 2s 截断）', function () {
  var p = S.plan(12, 9);
  assert.deepStrictEqual(p.times, [2, 7]);
});

test('过短视频：4s / 9 张 -> 不生成', function () {
  var p = S.plan(4, 9);
  assert.deepStrictEqual(p.times, []);
  assert.strictEqual(p.reason, 'too-short');
});

test('无效时长：0 / 负数 / NaN -> invalid-duration', function () {
  assert.strictEqual(S.plan(0, 9).reason, 'invalid-duration');
  assert.strictEqual(S.plan(-10, 9).reason, 'invalid-duration');
  assert.strictEqual(S.plan(NaN, 9).reason, 'invalid-duration');
});

test('自定义数量：210s / 20 张 -> 10..200s（20 张，第 10 张后折叠）', function () {
  var p = S.plan(210, 20);
  assert.strictEqual(p.actual, 20);
  assert.strictEqual(p.times[0], 10);
  assert.strictEqual(p.times[19], 200);
});

test('数量钳制：0 合法，非法值回退 9，上限 30，小数向下取整', function () {
  assert.strictEqual(S.MIN_COUNT, 0);
  assert.strictEqual(S.clampCount(0), 0);
  assert.strictEqual(S.clampCount('0'), 0);
  assert.strictEqual(S.clampCount(-3), 9);
  assert.strictEqual(S.clampCount(NaN), 9);
  assert.strictEqual(S.clampCount(''), 9);          // 空输入不能当成 0
  assert.strictEqual(S.clampCount(undefined), 9);
  assert.strictEqual(S.clampCount(null), 9);
  assert.strictEqual(S.clampCount('abc'), 9);
  assert.strictEqual(S.clampCount(99), 30);
  assert.strictEqual(S.clampCount(3.7), 3);
  assert.strictEqual(S.plan(100, 0).requested, 0);
});

test('数量设为 0：不生成任何时间点，且优先于时长判断', function () {
  [100, 28, 4, 0, NaN, -10].forEach(function (T) {
    var p = S.plan(T, 0);
    assert.deepStrictEqual(p.times, [], 'T=' + T);
    assert.strictEqual(p.actual, 0, 'T=' + T);
    assert.strictEqual(p.requested, 0, 'T=' + T);
    assert.strictEqual(p.reason, 'zero-count', 'T=' + T);
    assert.strictEqual(p.truncated, false, 'T=' + T);
    assert.strictEqual(p.droppedFirst, false, 'T=' + T);
  });
});

test('任意输入都满足：相邻间隔 >= 5s、首点 >= 1s、末点 < 时长（含 0 张）', function () {
  for (var T = 1; T <= 600; T += 0.5) {
    for (var n = 0; n <= 30; n += 1) {
      if (n === 0) {
        assert.strictEqual(S.plan(T, n).reason, 'zero-count');
        continue;
      }
      var p = S.plan(T, n);
      if (p.times.length === 0) continue;
      assert.ok(p.times[0] >= S.MIN_FIRST_POINT, '首点过 early: T=' + T + ' n=' + n);
      assert.ok(p.times[p.times.length - 1] < T, '末点超出时长: T=' + T + ' n=' + n);
      for (var i = 1; i < p.times.length; i++) {
        assert.ok(p.times[i] - p.times[i - 1] >= S.MIN_GAP - 1e-6,
          '间隔不足 5s: T=' + T + ' n=' + n);
      }
    }
  }
});

test('时间码格式化', function () {
  assert.strictEqual(S.formatTime(3), '00:03');
  assert.strictEqual(S.formatTime(65), '01:05');
  assert.strictEqual(S.formatTime(3661), '1:01:01');
  assert.strictEqual(S.formatTime(10.37), '00:10');
});

test('autoCount：10 档分桶边界（下界含、上界不含）', function () {
  var cases = [
    [1, 3], [29.9, 3],
    [30, 6], [59.9, 6],
    [60, 9], [119.9, 9],
    [120, 12], [299.9, 12],
    [300, 15], [599.9, 15],
    [600, 18], [1199.9, 18],
    [1200, 21], [2399.9, 21],
    [2400, 24], [3599.9, 24],
    [3600, 27], [7199.9, 27],
    [7200, 30], [99999, 30]
  ];
  cases.forEach(function (c) {
    assert.strictEqual(S.autoCount(c[0]), c[1], 'T=' + c[0]);
  });
});

test('autoCount：每档恰好 +3 张、边界全部凑整、末档 30', function () {
  var buckets = S.AUTO_BUCKETS;
  assert.strictEqual(buckets.length, 10);
  buckets.forEach(function (b, i) {
    assert.strictEqual(b.count, 3 * (i + 1), 'bucket ' + i);
  });
  assert.strictEqual(buckets[0].count, 3);
  assert.strictEqual(buckets[buckets.length - 1].count, 30);
  assert.deepStrictEqual(
    buckets.slice(0, -1).map(function (b) { return b.max; }),
    [30, 60, 120, 300, 600, 1200, 2400, 3600, 7200]
  );
});

test('autoCount：时长无效回退 9；30s 以下配合 plan 实际不超过 3 张', function () {
  assert.strictEqual(S.autoCount(0), 9);
  assert.strictEqual(S.autoCount(-5), 9);
  assert.strictEqual(S.autoCount(NaN), 9);
  [5, 10, 20, 29].forEach(function (T) {
    assert.ok(S.plan(T, S.autoCount(T)).actual <= 3, 'T=' + T);
  });
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
