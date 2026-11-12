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

test('行数：0 张 0 行；1-3 张 1 行；4-6 张 2 行；>=7 张封顶 3 行', function () {
  assert.strictEqual(L.rowsFor(0), 0);
  assert.strictEqual(L.rowsFor(1), 1);
  assert.strictEqual(L.rowsFor(3), 1);
  assert.strictEqual(L.rowsFor(4), 2);
  assert.strictEqual(L.rowsFor(6), 2);
  assert.strictEqual(L.rowsFor(7), 3);
  assert.strictEqual(L.rowsFor(9), 3);
  assert.strictEqual(L.rowsFor(30), 3);
});

test('高度：0 张为 0；随行数增长；封顶 3 行', function () {
  assert.strictEqual(L.heightFor(0, 60, 8), 0);
  assert.strictEqual(L.heightFor(1, 60, 8), 60);
  assert.strictEqual(L.heightFor(3, 60, 8), 60);
  assert.strictEqual(L.heightFor(4, 60, 8), 128);
  assert.strictEqual(L.heightFor(9, 60, 8), 196);
  assert.strictEqual(L.heightFor(30, 60, 8), 196);
});

test('任意张数：高度不超过 3 行 + 2 个行间距', function () {
  for (var n = 0; n <= 30; n++) {
    var h = L.heightFor(n, 60, 8);
    assert.ok(h >= 0 && h <= 196, 'n=' + n + ' h=' + h);
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
