/**
 * 首帧同步预填充的静态契约回归测试
 *   node test/boot.test.js
 *
 * 防止以后又把「数量 9 / 生成 / 清空 / 自动生成关」写回静态 HTML，
 * 或把 bootControls() 挪到 await 之后 —— 那正是切换素材时闪烁的根因。
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

var html = read('index.html');
var css = read('css/style.css');
var main = read('js/main.js');

var cases = [];
function test(name, fn) { cases.push({ name: name, fn: fn }); }

test('index.html 不再写死数量默认值 9', function () {
  var m = /<input[^>]*id="tileCount"[^>]*>/.exec(html);
  assert.ok(m, '找不到 tileCount 输入框');
  assert.ok(!/value\s*=\s*["']?9/.test(m[0]), 'tileCount 不能带静态 value="9"');
});

test('生成 / 清空按钮与 wrap 在静态 HTML 里默认隐藏', function () {
  [/<button[^>]*id="generate"[^>]*>/, /<button[^>]*id="clear"[^>]*>/].forEach(function (re) {
    var m = re.exec(html);
    assert.ok(m, '按钮缺失');
    assert.ok(/\bhidden\b/.test(m[0]), '按钮的静态 HTML 必须带 hidden');
  });
  var w = /<div[^>]*id="wrap"[^>]*>/.exec(html);
  assert.ok(w && /booting/.test(w[0]), 'wrap 必须带 booting 类');
  assert.ok(/\.wrap\.booting\s*\{[^}]*visibility\s*:\s*hidden/.test(css),
    'CSS 必须有 .wrap.booting 隐藏规则');
});

test('bootControls() 在 onPluginCreate 之前同步调用，且内部没有 await', function () {
  var call = main.indexOf('bootControls();');
  var hook = main.indexOf('eagle.onPluginCreate');
  assert.ok(call >= 0 && hook >= 0);
  assert.ok(call < hook, 'bootControls() 必须在任何异步 IPC 之前执行');

  var start = main.indexOf('function bootControls()');
  var end = main.indexOf('\n  function multiHint()');
  assert.ok(start >= 0 && end > start);
  var body = main.slice(start, end);
  assert.ok(!/\bawait\b/.test(body), 'bootControls 必须纯同步，不能有 await');
  assert.ok(body.indexOf("classList.remove('booting')") >= 0, '预填充后必须移除 booting');
});

test('主逻辑仍只有 1 个选中项轮询，没有新增定时器', function () {
  assert.strictEqual((main.match(/setInterval\(/g) || []).length, 1);
  assert.strictEqual((main.match(/setTimeout\(/g) || []).length, 0);
  assert.strictEqual((main.match(/requestAnimationFrame\(/g) || []).length, 0);
  assert.strictEqual((main.match(/addEventListener\('resize'/g) || []).length, 0);
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
