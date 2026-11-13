/**
 * 「重置」按钮静态契约单测（Node 16+ 直接运行）
 *   node test/reset.test.js
 *
 * 重点盯住两条容易回退的约定：
 *   1 按钮永远显示，不受「自动生成」开关影响；
 *   2 重置 = 回到按时长自动 + 立即刷新，但**不删除预览图**（那是「清空」的职责）。
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
var manifest = JSON.parse(read('manifest.json'));
var pkg = JSON.parse(read('package.json'));

var cases = [];
function test(name, fn) { cases.push({ name: name, fn: fn }); }

test('按钮在「生成」与「清空」之间，橙色，文案「重置」，且没有 hidden', function () {
  var g = html.indexOf('id="generate"');
  var r = html.indexOf('id="reset"');
  var c = html.indexOf('id="clear"');
  assert.ok(g >= 0 && r > g && c > r, '顺序必须是 生成 → 重置 → 清空');
  var tag = html.slice(html.lastIndexOf('<', r), html.indexOf('>', r) + 1);
  assert.ok(/class="btn warn"/.test(tag));
  assert.ok(tag.indexOf('hidden') === -1, '重置按钮不能带 hidden');
  assert.ok(/id="reset"[^>]*>重置<\/button>/.test(html));
});

test('两组主题都有橙色变量，.btn.warn 用它', function () {
  assert.strictEqual((css.match(/--reset:\s*#[0-9a-fA-F]{6};/g) || []).length, 2);
  assert.ok(/\.btn\.warn\s*\{[^}]*background:\s*var\(--reset\)/s.test(css));
  assert.ok(/\.btn\.warn:hover:not\(:disabled\)/.test(css));
});

test('常显：syncBusy 只禁用，任何地方都不隐藏 reset', function () {
  assert.ok(main.indexOf("$('reset').disabled = busy") >= 0);
  assert.ok(main.indexOf("$('reset').hidden") === -1);
  assert.ok(main.indexOf("getElementById('reset').hidden") === -1);
  // syncControls 里仍只隐藏 generate / clear
  assert.ok(main.indexOf("$('generate').hidden = state.global.autoGenerate") >= 0);
  assert.ok(main.indexOf("$('clear').hidden = state.global.autoGenerate") >= 0);
});

test('重置写回 auto:true、解除清空抑制、并立即调用 generate()', function () {
  var body = main.slice(main.indexOf('async function resetCount()'), main.indexOf('function clearPreview()'));
  assert.ok(body.indexOf('Store.setItemConfig(id, { auto: true, activeCount: null })') >= 0);
  assert.ok(body.indexOf('delete state.suppressed[id]') >= 0);
  assert.ok(body.indexOf('state.autoMode = true') >= 0);
  assert.ok(body.indexOf('await generate()') >= 0);
  assert.ok(body.indexOf('已重置为按时长自动') >= 0);
  // 关键负向契约：重置不能删缓存
  assert.ok(body.indexOf('Store.clearItem') === -1);
});

test('「清空」语义不变：仍删所有规格并抑制自动生成', function () {
  var body = main.slice(main.indexOf('function clearPreview()'), main.indexOf('function disableForItem()'));
  assert.ok(body.indexOf('Store.clearItem(id)') >= 0);
  assert.ok(body.indexOf('state.suppressed[id] = true') >= 0);
});

test('事件绑定与版本一致', function () {
  assert.ok(main.indexOf("$('reset').addEventListener('click', resetCount)") >= 0);
  assert.strictEqual(manifest.version, '1.8.0');
  assert.strictEqual(pkg.version, '1.8.0');
  assert.ok(pkg.scripts.test.indexOf('test/reset.test.js') >= 0);
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
