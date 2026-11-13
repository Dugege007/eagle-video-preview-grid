/**
 * 缓存判定 / 多规格 / 旧格式兼容 / 清理单测 —— 不依赖测试框架：
 *   node test/cache.test.js
 *
 * 关键回归：
 *  - 9 张里 3 张抽帧失败仍命中缓存（失败帧没有 jpg 也算已定结果）
 *  - v1.5.0 旧平铺缓存（meta.json + <index>.jpg）视为 n9 直接命中、零重抽
 *  - 按数量分规格后切换数量不互相覆盖；pruneUnused 只删用不到的规格
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

function wipe() {
  var dir = Store.itemDir(ID);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

function put(files) {
  Object.keys(files).forEach(function (rel) {
    var p = path.join(Store.itemDir(ID), rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    var v = files[rel];
    fs.writeFileSync(p, v === 0 ? '' : (typeof v === 'string' ? v : 'jpeg-bytes'));
  });
}

function n9Thumbs() {
  var files = {};
  for (var i = 0; i < 6; i++) files['n9/' + i + '.jpg'] = 1;
  return files;
}

function legacyThumbs() {
  var files = { 'meta.json': JSON.stringify(makeMeta({})) };
  for (var i = 0; i < 6; i++) files[i + '.jpg'] = 1;
  return files;
}

var cases = [];
function test(name, fn) { cases.push({ name: name, fn: fn }); }

test('normalizeMeta：旧格式用 count 兜底 requested、按 results 是否填满推导 complete', function () {
  var old = Store.normalizeMeta(makeMeta({}));
  assert.strictEqual(old.requested, 9);
  assert.strictEqual(old.complete, true);
  var draft = Store.normalizeMeta(makeMeta({
    requested: 9,
    complete: false,
    results: [true, true, undefined, undefined, undefined, undefined, undefined, undefined, undefined]
  }));
  assert.strictEqual(draft.complete, false);
});

test('核心回归：6 张成功 + 3 张失败，只有 6 个 jpg 也命中（n9 规格）', function () {
  wipe();
  put(n9Thumbs());
  assert.strictEqual(Store.isCacheValid(makeMeta({ requested: 9, complete: true }), spec), true);
});

test('旧平铺缓存（v1.5.0）视为 n9 直接命中，零重抽', function () {
  wipe();
  put(legacyThumbs());
  var legacy = Store.readMeta(ID, 9);
  assert.ok(legacy, 'readMeta(9) 必须回退读到旧 meta.json');
  assert.strictEqual(Store.isLegacyMeta(legacy), true);
  assert.strictEqual(Store.isCacheValid(legacy, spec), true);
  assert.strictEqual(Store.isResumable(legacy, spec), false);
  assert.strictEqual(Store.isLegacyMeta(makeMeta({ requested: 9, complete: true })), false);
});

test('草稿 complete=false 不算命中，但可续抽', function () {
  wipe();
  put({ 'n9/0.jpg': 1, 'n9/1.jpg': 1 });
  var draft = makeMeta({
    requested: 9, complete: false,
    results: [true, true, undefined, undefined, undefined, undefined, undefined, undefined, undefined]
  });
  assert.strictEqual(Store.isCacheValid(draft, spec), false);
  assert.strictEqual(Store.isResumable(draft, spec), true);
  assert.strictEqual(Store.isResumable(makeMeta({ requested: 9, complete: true }), spec), false);
});

test('规格不一致失效：rule / requested / 源文件', function () {
  wipe();
  put(n9Thumbs());
  assert.strictEqual(Store.isCacheValid(makeMeta({ rule: 'v1', requested: 9, complete: true }), spec), false);
  assert.strictEqual(Store.isCacheValid(makeMeta({ requested: 12, complete: true }), spec), false);
  assert.strictEqual(Store.isCacheValid(makeMeta({ requested: 9, complete: true, sourceSize: 999 }), spec), false);
  assert.strictEqual(Store.isCacheValid(makeMeta({ requested: 9, complete: true, sourceMtime: 999 }), spec), false);
});

test('成功帧缺图 / 0 字节失效；失败帧缺图不影响', function () {
  wipe();
  var f = n9Thumbs(); delete f['n9/5.jpg'];
  put(f);
  assert.strictEqual(Store.isCacheValid(makeMeta({ requested: 9, complete: true }), spec), false);
  wipe();
  var g = n9Thumbs(); g['n9/5.jpg'] = 0;
  put(g);
  assert.strictEqual(Store.isCacheValid(makeMeta({ requested: 9, complete: true }), spec), false);
});

test('全部成功时仍要求每张 jpg 存在', function () {
  wipe();
  var allOk = makeMeta({ requested: 9, complete: true, results: new Array(9).fill(true) });
  assert.strictEqual(Store.isCacheValid(allOk, spec), false);
  var files = {};
  for (var i = 0; i < 9; i++) files['n9/' + i + '.jpg'] = 1;
  put(files);
  assert.strictEqual(Store.isCacheValid(allOk, spec), true);
});

test('config 语义：缺失=自动，旧文件=手动，setItemConfig 可重置为自动', function () {
  wipe();
  assert.deepStrictEqual(Store.getItemConfig(ID), { tileCount: null, auto: true, activeCount: null });
  Store.ensureItemDir(ID);
  fs.writeFileSync(path.join(Store.itemDir(ID), 'config.json'), JSON.stringify({ tileCount: 9 }));
  assert.strictEqual(Store.getItemConfig(ID).auto, false);
  assert.strictEqual(Store.getItemConfig(ID).tileCount, 9);
  Store.setItemConfig(ID, { auto: true, activeCount: 12 });
  assert.strictEqual(Store.getItemConfig(ID).auto, true);
  assert.strictEqual(Store.getItemConfig(ID).activeCount, 12);
  assert.strictEqual(Store.getItemConfig(ID).tileCount, null);
});

test('多规格隔离 + pruneUnused 只删用不到的规格', function () {
  wipe();
  put({ 'n9/0.jpg': 1, 'n12/0.jpg': 1, 'n20/0.jpg': 1, 'config.json': JSON.stringify({ auto: false, tileCount: 12, activeCount: 12 }) });
  assert.ok(fs.existsSync(path.join(Store.itemDir(ID), 'n9')));
  assert.ok(fs.existsSync(path.join(Store.itemDir(ID), 'n20')));
  var r = Store.pruneUnused();
  assert.ok(r.removed >= 2, 'n9 与 n20 都应被删');
  assert.ok(fs.existsSync(path.join(Store.itemDir(ID), 'n12')), '当前规格必须保留');
  assert.ok(!fs.existsSync(path.join(Store.itemDir(ID), 'n9')));
  assert.ok(!fs.existsSync(path.join(Store.itemDir(ID), 'n20')));
});

test('pendingPrune 标记：setGlobal 不丢其它字段，清理后可清除', function () {
  Store.setGlobal({ autoGenerate: true, expanded: true });
  Store.markPrunePending();
  var g = Store.getGlobal();
  assert.strictEqual(g.autoGenerate, true);
  assert.strictEqual(g.expanded, true);
  assert.strictEqual(g.pendingPrune, true);
  Store.clearPrunePending();
  assert.strictEqual(Store.getGlobal().pendingPrune, false);
  assert.strictEqual(Store.getGlobal().autoGenerate, true, '不能误清其它字段');
});

test('readAnyDuration：能从任一规格或旧 meta 读到时长', function () {
  wipe();
  put({ 'n12/meta.json': JSON.stringify(makeMeta({ requested: 12, duration: 456 })) });
  assert.strictEqual(Store.readAnyDuration(ID), 456);
  wipe();
  put({ 'meta.json': JSON.stringify(makeMeta({ duration: 78 })) });
  assert.strictEqual(Store.readAnyDuration(ID), 78);
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
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log('\n' + (cases.length - failed) + '/' + cases.length + ' passed');
process.exit(failed ? 1 : 0);
