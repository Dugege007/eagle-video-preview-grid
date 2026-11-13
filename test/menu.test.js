/**
 * 右键菜单静态契约 + 原帧缓存路径单测（Node 16+ 直接运行）
 *   node test/menu.test.js
 *
 * 静态契约的作用：防止以后又把菜单改回单项、或把封面改回 192px 缩略图。
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var root = path.join(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

var html = read('index.html');
var main = read('js/main.js');
var css = read('css/style.css');

var cases = [];
function test(name, fn) { cases.push({ name: name, fn: fn }); }

test('菜单恰好三项，文案与顺序严格按用户指定', function () {
  var re = /<button id="(setCover|copyFrame|saveFrame)" class="cell-menu-item" type="button">([^<]+)<\/button>/g;
  var found = [];
  var m;
  while ((m = re.exec(html))) found.push([m[1], m[2]]);
  assert.deepStrictEqual(found, [
    ['setCover', '设为视频封面'],
    ['copyFrame', '复制'],
    ['saveFrame', '另存为']
  ]);
  assert.strictEqual((html.match(/class="cell-menu-item"/g) || []).length, 3);
});

test('三项之间有分隔线，菜单按三项高度定位', function () {
  assert.ok(html.indexOf('class="cell-menu-sep"') >= 0);
  assert.ok(css.indexOf('.cell-menu-sep') >= 0);
  assert.ok(main.indexOf('MENU_HEIGHT = 100') >= 0);
  assert.ok(main.indexOf('window.innerHeight - MENU_HEIGHT') >= 0);
});

test('三个按钮都绑定 click，且三个动作都走 withFrame', function () {
  assert.ok(main.indexOf("[['setCover', setCover], ['copyFrame', copyFrame], ['saveFrame', saveFrame]]") >= 0);
  // 4 次 = 函数定义 1 次 + setCover / copyFrame / saveFrame 各调用 1 次
  assert.strictEqual((main.match(/withFrame\(index,/g) || []).length, 4);
});

test('封面用原尺寸帧，不再把 192px 缩图传给 setCustomThumbnail', function () {
  assert.ok(main.indexOf('Store.thumbPathFor(meta') === -1);
  assert.ok(main.indexOf('Store.frameFile(state.itemId)') >= 0);
  assert.ok(main.indexOf('Capture.captureFrame(') >= 0);
  assert.ok(main.indexOf('Store.copyToCover(state.itemId, frame)') >= 0);
  assert.ok(main.indexOf('item.setCustomThumbnail(cover)') >= 0);
});

test('复制三层兜底、另存为两层兜底都在', function () {
  assert.ok(main.indexOf('clipboard.writeImage') >= 0);
  assert.ok(main.indexOf('navigator.clipboard.write') >= 0);
  assert.ok(main.indexOf('copyFiles([frame])') >= 0);
  assert.ok(main.indexOf('showSaveDialog') >= 0);
  assert.ok(main.indexOf('Store.fileDataURL(frame)') >= 0);
});

test('Store.frameFile 固定文件名、safeId 清洗、fileDataURL 正确', function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-menu-'));
  try {
    global.eagle = { app: { userDataPath: tmp } };
    var Store = require('../js/store.js');
    var expected = path.join(tmp, 'eagle-video-preview-grid', 'frames', 'abc_def.jpg');
    assert.strictEqual(Store.frameFile('abc/def'), expected);
    assert.strictEqual(Store.frameFile('abc/def'), Store.frameFile('abc/def'));
    Store.ensureFrameDir();
    assert.ok(fs.existsSync(path.dirname(expected)));

    var bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    var f = path.join(tmp, 'one.jpg');
    fs.writeFileSync(f, bytes);
    assert.strictEqual(Store.fileDataURL(f), 'data:image/jpeg;base64,' + bytes.toString('base64'));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
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
