/**
 * 布局纯函数单测 —— 不依赖测试框架，Node 16+ 可直接运行：
 *   node test/layout.test.js
 */
'use strict';

var assert = require('assert');
var L = require('../js/layout.js');

var cases = [];
function test(name, fn) { cases.push({ name: name, fn: fn }); }

test('可见张数：收起最多 9，展开显示全部', function () {
  assert.strictEqual(L.visibleCount(0, false), 0);
  assert.strictEqual(L.visibleCount(5, false), 5);
  assert.strictEqual(L.visibleCount(9, false), 9);
  assert.strictEqual(L.visibleCount(12, false), 9);
  assert.strictEqual(L.visibleCount(12, true), 12);
  assert.strictEqual(L.visibleCount(30, true), 30);
});

test('展开按钮只在超过 9 张时出现', function () {
  assert.strictEqual(L.needsToggle(0), false);
  assert.strictEqual(L.needsToggle(9), false);
  assert.strictEqual(L.needsToggle(10), true);
  assert.strictEqual(L.needsToggle(30), true);
});

test('收起态行数封顶 3 行', function () {
  assert.strictEqual(L.rowsFor(0, false), 0);
  assert.strictEqual(L.rowsFor(1, false), 1);
  assert.strictEqual(L.rowsFor(3, false), 1);
  assert.strictEqual(L.rowsFor(4, false), 2);
  assert.strictEqual(L.rowsFor(6, false), 2);
  assert.strictEqual(L.rowsFor(7, false), 3);
  assert.strictEqual(L.rowsFor(9, false), 3);
  assert.strictEqual(L.rowsFor(30, false), 3);
});

test('展开态行数不封顶：12 张 4 行、30 张 10 行', function () {
  assert.strictEqual(L.rowsFor(0, true), 0);
  assert.strictEqual(L.rowsFor(9, true), 3);
  assert.strictEqual(L.rowsFor(10, true), 4);
  assert.strictEqual(L.rowsFor(12, true), 4);
  assert.strictEqual(L.rowsFor(30, true), 10);
});

test('高度：收起封顶 3 行；展开按实际行数变高', function () {
  assert.strictEqual(L.heightFor(0, 60, 8, false), 0);
  assert.strictEqual(L.heightFor(1, 60, 8, false), 60);
  assert.strictEqual(L.heightFor(4, 60, 8, false), 128);
  assert.strictEqual(L.heightFor(9, 60, 8, false), 196);
  assert.strictEqual(L.heightFor(30, 60, 8, false), 196);
  assert.strictEqual(L.heightFor(12, 60, 8, true), 264);   // 4 行
  assert.strictEqual(L.heightFor(30, 60, 8, true), 672);   // 10 行
});

test('fitHeight：装得下就直接用目标高度，装不下退回可用高度 + 滚动', function () {
  assert.deepStrictEqual(L.fitHeight(196, 300), { height: 196, scroll: false });
  assert.deepStrictEqual(L.fitHeight(300, 300), { height: 300, scroll: false });
  assert.deepStrictEqual(L.fitHeight(264, 226), { height: 226, scroll: true });
  assert.deepStrictEqual(L.fitHeight(672, 226), { height: 226, scroll: true });
  // 拿不到可用高度（0 / NaN）时不强行限制
  assert.deepStrictEqual(L.fitHeight(672, 0), { height: 672, scroll: false });
  assert.deepStrictEqual(L.fitHeight(264, NaN), { height: 264, scroll: false });
});

test('任意张数：收起不超过 3 行高度，展开高度不小于收起高度', function () {
  for (var n = 0; n <= 30; n++) {
    var h = L.heightFor(n, 60, 8, false);
    var e = L.heightFor(n, 60, 8, true);
    assert.ok(h >= 0 && h <= 196, '收起高度越界: n=' + n + ' h=' + h);
    assert.ok(e >= h, '展开高度小于收起高度: n=' + n);
  }
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
