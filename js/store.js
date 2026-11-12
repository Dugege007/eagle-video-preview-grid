/**
 * store.js — 设置与派生缓存读写
 *
 * 作用域（v0.2.0）：
 *   settings.json                     全局：autoGenerate / expanded
 *   thumbs/<itemId>/config.json       单个视频资源：tileCount（清空预览图不删除）
 *   thumbs/<itemId>/meta.json + jpg   派生缓存：可随时重建 / 清空
 *
 * 全部位于 eagle.app.userDataPath 下；不写 Eagle 资源库、不碰 metadata.json。
 */
(function (global) {
  'use strict';

  var PLUGIN_DIR = 'eagle-video-preview-grid';
  // v2：输出规格改为缩图宽度 192（v1 为 320）。规格或采样规则变更时递增，旧缓存自动作废重建。
  var RULE_VERSION = 'v2';
  var dataURLCache = Object.create(null);   // C：内存缓存 base64，避免每次 render 重复读盘

  function cacheKey(itemId, index) {
    return safeId(itemId) + ':' + index;
  }

  /** 图片被替换 / 清空时，作废该视频的全部 base64 缓存。 */
  function invalidateThumbs(itemId) {
    var prefix = safeId(itemId) + ':';
    Object.keys(dataURLCache).forEach(function (k) {
      if (k.indexOf(prefix) === 0) delete dataURLCache[k];
    });
  }

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

  /* ---------- 全局设置 ---------- */

  function settingsFile() {
    return node().path.join(root(), 'settings.json');
  }

  function getGlobal() {
    var s = readJson(settingsFile(), {});
    return {
      autoGenerate: s.autoGenerate === true,   // 默认关闭
      expanded: s.expanded === true            // 默认收起
    };
  }

  function setGlobal(patch) {
    var cur = getGlobal();
    writeJson(settingsFile(), {
      autoGenerate: typeof patch.autoGenerate === 'boolean' ? patch.autoGenerate : cur.autoGenerate,
      expanded: typeof patch.expanded === 'boolean' ? patch.expanded : cur.expanded
    });
  }

  /* ---------- 单个视频资源的配置 ---------- */

  function itemDir(itemId) {
    return node().path.join(root(), 'thumbs', safeId(itemId));
  }

  function ensureItemDir(itemId) {
    ensureDir(itemDir(itemId));
  }

  function configFile(itemId) {
    return node().path.join(itemDir(itemId), 'config.json');
  }

  function getItemConfig(itemId) {
    var c = readJson(configFile(itemId), {});
    return { tileCount: global.Sampler.clampCount(c.tileCount) };
  }

  function setItemConfig(itemId, cfg) {
    writeJson(configFile(itemId), {
      tileCount: global.Sampler.clampCount(cfg.tileCount)
    });
  }

  /* ---------- 派生缓存 ---------- */

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
    invalidateThumbs(itemId);   // 新生成的图片替换旧缓存
  }

  function fileStat(filePath) {
    try {
      var st = node().fs.statSync(filePath);
      return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    } catch (e) {
      return { size: 0, mtimeMs: 0 };
    }
  }

  /** 数量 / 规则版本 / 源文件任一变化，或缺任一缩图 → 缓存失效。 */
  function isCacheValid(meta, ctx) {
    if (!meta || !Array.isArray(meta.times) || meta.times.length === 0) return false;
    if (meta.rule !== RULE_VERSION) return false;
    if (meta.count !== ctx.count) return false;
    if (meta.sourceSize !== ctx.sourceSize || meta.sourceMtime !== ctx.sourceMtime) return false;
    var fs = node().fs;
    for (var i = 0; i < meta.times.length; i++) {
      if (!fs.existsSync(thumbFile(ctx.itemId, i))) return false;
    }
    return true;
  }

  /**
   * 用 base64 data URL，规避 Windows 中文路径 / 空格 / # 的转义问题。
   * C：结果缓存在内存里；render() 复用 DOM 后，同一批图不会再重复读盘。
   */
  function thumbDataURL(itemId, index) {
    var k = cacheKey(itemId, index);
    if (dataURLCache[k]) return dataURLCache[k];
    var buf = node().fs.readFileSync(thumbFile(itemId, index));
    var url = 'data:image/jpeg;base64,' + buf.toString('base64');
    dataURLCache[k] = url;
    return url;
  }

  /**
   * 清空某个视频已生成的预览图：删除所有 jpg 与 meta.json，
   * 但保留 config.json（该视频自己的生成数量）。
   */
  function clearItem(itemId) {
    var n = node();
    var fs = n.fs;
    var dir = itemDir(itemId);
    try {
      fs.readdirSync(dir).forEach(function (f) {
        if (/^\d+\.jpg$/i.test(f)) {
          try { fs.unlinkSync(n.path.join(dir, f)); } catch (e) { /* 已不存在 */ }
        }
      });
    } catch (e) { /* 目录不存在 */ }
    try { fs.unlinkSync(metaFile(itemId)); } catch (e) { /* 已不存在 */ }
    invalidateThumbs(itemId);
  }

  var api = {
    PLUGIN_DIR: PLUGIN_DIR,
    RULE_VERSION: RULE_VERSION,
    root: root,
    getGlobal: getGlobal,
    setGlobal: setGlobal,
    ensureItemDir: ensureItemDir,
    getItemConfig: getItemConfig,
    setItemConfig: setItemConfig,
    metaFile: metaFile,
    thumbFile: thumbFile,
    readMeta: readMeta,
    writeMeta: writeMeta,
    fileStat: fileStat,
    isCacheValid: isCacheValid,
    thumbDataURL: thumbDataURL,
    invalidateThumbs: invalidateThumbs,
    clearItem: clearItem
  };

  global.Store = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
