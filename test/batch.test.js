/**
 * 多选批量纯函数单测 —— 不依赖测试框架，Node 16+ 可直接运行：
 *   node test/batch.test.js
 */
'use strict';

var assert = require('assert');
var B = require('../js/batch.js');

var cases = [];
function test(name, fn) { cases.push({ name: name, fn: fn }); }

function item(id, ext, filePath) {
  return { id: id, ext: ext, filePath: filePath || ('C:\\视频\\' + id + '.' + (ext || 'mp4')) };
}

test('isVideoItem：manifest 支持的 8 种格式，大小写 / 前导点兼容', function () {
  B.VIDEO_EXTS.forEach(function (ext) {
    assert.strictEqual(B.isVideoItem(item('a', ext)), true, ext);
    assert.strictEqual(B.isVideoItem(item('a', ext.toUpperCase())), true, ext);
    assert.strictEqual(B.isVideoItem(item('a', '.' + ext)), true, ext);
  });
  assert.strictEqual(B.isVideoItem(item('a', 'jpg')), false);
  assert.strictEqual(B.isVideoItem(item('a', 'png')), false);
  assert.strictEqual(B.isVideoItem(null), false);
});

test('isVideoItem：ext 缺失时从 filePath 后缀回退', function () {
  assert.strictEqual(B.isVideoItem({ id: 'x', filePath: 'D:\\素材\\中文 空格.MP4' }), true);
  assert.strictEqual(B.isVideoItem({ id: 'x', filePath: 'D:\\素材\\封面.PNG' }), false);
  assert.strictEqual(B.isVideoItem({ id: 'x', filePath: 'D:\\素材\\无扩展名' }), false);
});

test('videosOnly：过滤非视频、缺 id / filePath 的异常项；单对象也兼容', function () {
  var list = [
    item('v1', 'mp4'),
    item('img', 'jpg'),
    item('v2', 'mov'),
    { id: 'no-path', ext: 'mkv' },
    { ext: 'avi', filePath: 'x.avi' }
  ];
  assert.deepStrictEqual(B.videosOnly(list).map(function (x) { return x.id; }), ['v1', 'v2']);
  assert.strictEqual(B.videosOnly(item('solo', 'webm')).length, 1);
  assert.deepStrictEqual(B.videosOnly(null), []);
});

test('selectionSignature：只与视频 id 集合有关，顺序变化不触发刷新', function () {
  var a = [item('A', 'mp4'), item('B', 'mov')];
  var b = [item('B', 'mov'), item('A', 'mp4')];
  assert.strictEqual(B.selectionSignature(a), B.selectionSignature(b));
  assert.notStrictEqual(B.selectionSignature(a), B.selectionSignature([item('A', 'mp4')]));
  // 混入图片不影响签名
  assert.strictEqual(B.selectionSignature(a.concat([item('pic', 'jpg')])), B.selectionSignature(a));
  assert.strictEqual(B.selectionSignature([]), '');
});

test('isMulti：只有 >1 个视频才算多选', function () {
  assert.strictEqual(B.isMulti([item('A', 'mp4')]), false);
  assert.strictEqual(B.isMulti([item('A', 'mp4'), item('pic', 'jpg')]), false);
  assert.strictEqual(B.isMulti([item('A', 'mp4'), item('B', 'mov')]), true);
});

test('totalPlanned：视频数 × 数量，非法值按 0 处理', function () {
  assert.strictEqual(B.totalPlanned(3, 12), 36);
  assert.strictEqual(B.totalPlanned(1, 9), 9);
  assert.strictEqual(B.totalPlanned(5, 0), 0);
  assert.strictEqual(B.totalPlanned(0, 9), 0);
  assert.strictEqual(B.totalPlanned(NaN, 9), 0);
  assert.strictEqual(B.totalPlanned(-2, 9), 0);
});

test('确认文案：写明视频数、数量与「总共要生成的张数」', function () {
  var msg = B.confirmMessage(3, 12);
  assert.ok(msg.indexOf('3 个视频') >= 0 && msg.indexOf('12') >= 0);
  assert.ok(msg.indexOf('36 张') >= 0, '弹窗主文本必须写明总张数');
  assert.ok(B.confirmDetail(3, 12).indexOf('36 张') >= 0);
  assert.ok(B.confirmDetail(3, 12).indexOf('请谨慎修改') >= 0);
  assert.ok(B.confirmMessage(3, 0).indexOf('0 张') >= 0);
  assert.ok(B.confirmDetail(3, 0).indexOf('不再生成预览图') >= 0);
  assert.ok(B.confirmDetail(3, 0).indexOf('清空') >= 0);
});

test('bootState：合并上次主题/数量与 settings.json 全局开关，count=0 不算缺失', function () {
  var d = { theme: 'LIGHT', autoGenerate: false, expanded: false, count: 9 };
  assert.deepStrictEqual(B.bootState(null, null, d), {
    theme: 'LIGHT', autoGenerate: false, expanded: false, count: 9
  });
  assert.deepStrictEqual(
    B.bootState({ theme: 'DARK', count: 0 }, { autoGenerate: true, expanded: true }, d),
    { theme: 'DARK', autoGenerate: true, expanded: true, count: 0 }
  );
  assert.strictEqual(B.bootState({ count: 12 }, {}, d).count, 12);
  assert.strictEqual(B.bootState('bad-json', {}, d).theme, 'LIGHT');
  assert.strictEqual(B.bootState({ theme: '' }, {}, d).theme, 'LIGHT');
});

test('summary：包含跳过 / 失败计数', function () {
  var s = B.summary(5, 9, 2, 1);
  assert.ok(s.indexOf('5 个视频') >= 0 && s.indexOf('9') >= 0);
  assert.ok(s.indexOf('2 个跳过') >= 0 && s.indexOf('1 个有失败') >= 0);
  assert.strictEqual(B.summary(2, 0, 0, 0), '已统一修改 2 个视频的数量为 0');
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
