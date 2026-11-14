/**
 * manifest 支持格式静态契约单测（Node 16+ 直接运行）
 *   node test/formats.test.js
 *
 * 作用：以后增删格式时，必须同步改 manifest、README 与本测试的期望集合，
 * 避免「代码支持了但文档没写」或「加了却漏了 .ts」这类回归。
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

var manifest = JSON.parse(read('manifest.json'));
var pkg = JSON.parse(read('package.json'));
var readme = read('README.md');

// 既有 8 种 + v1.9.0 新增 5 种（Eagle 官方支持格式页列出的视频容器）
var EXPECTED = [
  'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'flv', 'wmv',
  'ts', 'mts', 'm2ts', 'f4v', '3gp'
];
var ADDED_IN_190 = ['ts', 'mts', 'm2ts', 'f4v', '3gp'];

var cases = [];
function test(name, fn) { cases.push({ name: name, fn: fn }); }

function previewKey() { return Object.keys(manifest.preview)[0]; }
function extList() { return previewKey().split(','); }

test('preview 只有一组配置，扩展名集合与期望完全一致（13 种）', function () {
  assert.strictEqual(Object.keys(manifest.preview).length, 1);
  assert.deepStrictEqual(extList(), EXPECTED);
  assert.strictEqual(extList().length, 13);
});

test('v1.9.0 新增的 5 种官方视频格式都在（ts / mts / m2ts / f4v / 3gp）', function () {
  var list = extList();
  ADDED_IN_190.forEach(function (ext) {
    assert.ok(list.indexOf(ext) >= 0, '缺少 ' + ext);
  });
});

test('键格式合法：无空格、无空项、无重复、全小写、不带点号', function () {
  var raw = previewKey();
  assert.strictEqual(raw.indexOf(' '), -1);
  var list = extList();
  assert.ok(list.every(function (e) { return e.length > 0; }));
  assert.strictEqual(new Set(list).size, list.length);
  list.forEach(function (e) {
    assert.strictEqual(e, e.toLowerCase(), e);
    assert.ok(/^[a-z0-9]+$/.test(e), e);
  });
});

test('检查器结构未因扩展名变化而改动', function () {
  var ins = manifest.preview[previewKey()].inspector;
  assert.strictEqual(ins.path, 'index.html');
  assert.strictEqual(ins.height, 320);
  assert.strictEqual(ins.multiSelect, false);
  assert.strictEqual(manifest.devTools, false);
  assert.ok(manifest.dependencies.indexOf('ffmpeg') >= 0);
  assert.strictEqual(manifest.platform, 'all');
  assert.strictEqual(manifest.arch, 'all');
});

test('README 的支持格式列表写明全部新增格式', function () {
  var line = readme.split('\n').filter(function (l) { return l.indexOf('支持 mp4') === 0; })[0] || '';
  assert.ok(line.length > 0, 'README 缺少支持格式列表');
  EXPECTED.forEach(function (ext) {
    assert.ok(line.indexOf(ext) >= 0, 'README 漏写 ' + ext);
  });
});

test('版本与测试脚本一致', function () {
  assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version));
  assert.strictEqual(pkg.version, manifest.version);
  assert.ok(pkg.scripts.test.indexOf('test/formats.test.js') >= 0);
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
