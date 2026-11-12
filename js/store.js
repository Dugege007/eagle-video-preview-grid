/**
 * store.js — 派生缓存读写
 *
 * 设计前提：本期不做自定义描述，时间点是 (时长, 数量) 的确定性函数，
 * 因此不保存任何用户数据；换机 / Eaglepack 迁移后自动重算重建即可。
 * 全部文件位于 eagle.app.userDataPath 下，不写 Eagle 资源库、不碰 metadata.json。
 */
(function (global) {
  'use strict';

  var PLUGIN_DIR = 'eagle-video-preview-grid';

  function node() {
    if (typeof require !== 'function') throw new Error('NODE_UNAVAILABLE');
    return { fs: require('fs'), path: require('path') };
  }

  function root() {
    return node().path.join(eagle.app.userDataPath, PLUGIN_DIR);
  }

  function ensureDir(dir) {
    var fs = node().fs;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function readJson(file, fallback) {
    try {
      return JSON.parse(node().fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(file, obj) {
    var n = node();
    ensureDir(n.path.dirname(file));
    n.fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  }

  function safeId(id) {
    return String(id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function settingsFile() {
    return node().path.join(root(), 'settings.json');
  }

  function getSettings() {
    var s = readJson(settingsFile(), {});
    return { tileCount: global.Sampler.clampCount(s.tileCount) };
  }

  function setSettings(s) {
    writeJson(settingsFile(), { tileCount: global.Sampler.clampCount(s.tileCount) });
  }

  function itemDir(itemId) {
    return node().path.join(root(), 'thumbs', safeId(itemId));
  }

  function ensureItemDir(itemId) {
    ensureDir(itemDir(itemId));
  }

  function metaFile(itemId) {
    return node().path.join(itemDir(itemId), 'meta.json');
  }

  function thumbFile(itemId, index) {
    return node().path.join(itemDir(itemId), index + '.jpg');
  }

  function readMeta(itemId) {
    return readJson(metaFile(itemId), null);
  }

  function writeMeta(itemId, meta) {
    writeJson(metaFile(itemId), meta);
  }

  function fileStat(filePath) {
    try {
      var st = node().fs.statSync(filePath);
      return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    } catch (e) {
      return { size: 0, mtimeMs: 0 };
    }
  }

  /** 参数或源文件任一变化即判定缓存失效；缺任一缩图也失效。 */
  function isCacheValid(meta, ctx) {
    if (!meta || !Array.isArray(meta.times) || meta.times.length === 0) return false;
    if (meta.count !== ctx.count) return false;
    if (meta.sourceSize !== ctx.sourceSize || meta.sourceMtime !== ctx.sourceMtime) return false;
    var fs = node().fs;
    for (var i = 0; i < meta.times.length; i++) {
      if (!fs.existsSync(thumbFile(ctx.itemId, i))) return false;
    }
    return true;
  }

  /**
   * 用 base64 data URL 而不是 file:/// 路径：规避 Windows 中文路径 / 空格 / # 的转义问题。
   */
  function thumbDataURL(itemId, index) {
    var buf = node().fs.readFileSync(thumbFile(itemId, index));
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  }

  function removeThumbs(itemId, count) {
    var fs = node().fs;
    for (var i = 0; i < count; i++) {
      try { fs.unlinkSync(thumbFile(itemId, i)); } catch (e) { /* 已不存在 */ }
    }
  }

  var api = {
    PLUGIN_DIR: PLUGIN_DIR,
    root: root,
    ensureItemDir: ensureItemDir,
    getSettings: getSettings,
    setSettings: setSettings,
    metaFile: metaFile,
    thumbFile: thumbFile,
    readMeta: readMeta,
    writeMeta: writeMeta,
    fileStat: fileStat,
    isCacheValid: isCacheValid,
    thumbDataURL: thumbDataURL,
    removeThumbs: removeThumbs
  };

  global.Store = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
