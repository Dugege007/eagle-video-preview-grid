/**
 * 缓存判定 / 旧格式兼容单测 —— 不依赖测试框架：
 *   node test/cache.test.js
 *
 * 关键回归：9 张里 3 张抽帧失败时，缓存必须命中（失败帧没有 jpg 也算已定结果），
 * 不能像 v1.4.0 之前那样每次从头重抽全部。
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-cache-'));
global.eagle = { app: { userDataPath: tmp } };
global.Sampler = require('../js/sampler.js');
var Store = require('../js/store.js');

var ID = 'ITEM_A';
var spec = { itemId: ID, count: 9, sourceSize: 1234, sourceMtime: 5678 };
var TIMES = [3, 8, 13, 18, 23, 28, 33, 38, 43];
var MIXED = [true, true, true, true, true, true, false, false, false];

function makeMeta(extra) {
  var m = {
    rule: Store.RULE_VERSION,
    count: 9,
    duration: 60,
    gap: 5,
    times: TIMES.slice(),
    results: MIXED.slice(),
    sourceSize: 1234,
    sourceMtime: 5678
  };
  Object.keys(extra || {}).forEach(function (k) { m[k] = extra[k]; });
  return m;
}

function clearThumbs() {
  var dir = path.join(tmp, Store.PLUGIN_DIR, 'thumbs', ID);
  try {
    fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
  } catch (e) { /* 目录不存在 */ }
}

function putThumbs(indices, bytes) {
  Store.ensureItemDir(ID);
  indices.forEach(function (i) {
    fs.writeFileSync(Store.thumbFile(ID, i), bytes === 0 ? '' : 'jpeg-bytes');
  });
}

var cases = [];
function test(name, fn) { cases.push({ name: name, fn: fn }); }

test('normalizeMeta：旧格式用 count 兜底 requested、按 results 是否填满推导 complete', function () {
  var old = normalize(makeMeta({}));
  assert.strictEqual(old.requested, 9);
  assert.strictEqual(old.complete, true);       // 9 项全 true/false → 旧格式视为已跑完

  var draft = normalize(makeMeta({
    requested: 9,
    complete: false,
    results: [true, true, undefined, undefined, undefined, undefined, undefined, undefined, undefined]
  }));
  assert.strictEqual(draft.complete, false);
  assert.strictEqual(draft.requested, 9);
});

test('核心回归：6 张成功 + 3 张失败，只有 6 个 jpg 也能命中缓存', function () {
  clearThumbs();
  putThumbs([0, 1, 2, 3, 4, 5]);
  assert.strictEqual(Store.isCacheValid(makeMeta({ requested: 9, complete: true }), spec), true);
  // 旧格式（截图里那批缓存）同样命中，不需要重抽或迁移文件
  assert.strictEqual(Store.isCacheValid(makeMeta({}), spec), true);
});

test('草稿 complete=false 不算命中，但可续抽', function () {
  clearThumbs();
  putThumbs([0, 1]);
  var draft = makeMeta({
    requested: 9,
    complete: false,
    results: [true, true, undefined, undefined, undefined, undefined, undefined, undefined, undefined]
  });
  assert.strictEqual(Store.isCacheValid(draft, spec), false);
  assert.strictEqual(Store.isResumable(draft, spec), true);
  assert.strictEqual(Store.isResumable(makeMeta({ requested: 9, complete: true }), spec), false);
});

test('规格不一致一律失效：rule / requested / 源文件', function () {
  clearThumbs();
  putThumbs([0, 1, 2, 3, 4, 5]);
  assert.strictEqual(Store.isCacheValid(makeMeta({ rule: 'v1', requested: 9, complete: true }), spec), false);
  assert.strictEqual(Store.isCacheValid(makeMeta({ requested: 12, complete: true }), spec), false);
  assert.strictEqual(Store.isCacheValid(makeMeta({ requested: 9, complete: true, sourceSize: 999 }), spec), false);
  assert.strictEqual(Store.isCacheValid(makeMeta({ requested: 9, complete: true, sourceMtime: 999 }), spec), false);
});

test('成功帧缺图 / 0 字节图失效；失败帧缺图不影响', function () {
  clearThumbs();
  putThumbs([0, 1, 2, 3, 4]);                 // 少一张成功帧（index 5）
  assert.strictEqual(Store.isCacheValid(makeMeta({ requested: 9, complete: true }), spec), false);

  clearThumbs();
  putThumbs([0, 1, 2, 3, 4]);
  putThumbs([5], 0);                          // index 5 是 0 字节
  assert.strictEqual(Store.isCacheValid(makeMeta({ requested: 9, complete: true }), spec), false);
});

test('全部成功时仍要求每张 jpg 存在', function () {
  clearThumbs();
  var allOk = makeMeta({ requested: 9, complete: true, results: new Array(9).fill(true) });
  assert.strictEqual(Store.isCacheValid(allOk, spec), false);
  putThumbs([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.strictEqual(Store.isCacheValid(allOk, spec), true);
});

function normalize(m) { return Store.normalizeMeta(m); }

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
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log('\n' + (cases.length - failed) + '/' + cases.length + ' passed');
process.exit(failed ? 1 : 0);
