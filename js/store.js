/**
 * store.js — 设置与派生缓存读写 (v1.6.0)
 *
 *   settings.json                            全局：autoGenerate / expanded / pendingPrune
 *   thumbs/<itemId>/config.json               单个视频：auto / tileCount / activeCount
 *   thumbs/<itemId>/n<count>/meta.json + jpg  按数量分规格的派生缓存（v1.6.0）
 *   covers/<itemId>.jpg                      设为封面用的持久副本（不随缓存清理删除）
 *   frames/<itemId>.jpg                      右键操作临时抽出的原尺寸帧（固定文件名、每视频一张）
 *
 * v1.5.0 的旧缓存是平铺的 `meta.json` + `<index>.jpg`，一律视为 count=9 兼容读取，
 * **不迁移文件、不升 RULE_VERSION**，升级后旧视频直接命中、零重抽。
 *
 * config 语义（用户 2026-11-13 拍板「保留旧设置，仅新视频自动」）：
 *   文件缺失 / auto:true  → 按时长自动决定数量
 *   旧文件（无 auto）     → auto:false，保留原有 tileCount
 *   用户手动改数量        → auto:false
 *   点「清空」            → 重置为 auto:true
 *
 * 全部位于 eagle.app.userDataPath 下；除「设为封面」外不写 Eagle 资源库、不碰 metadata.json。
 */
(function (global) {
  'use strict';

  var PLUGIN_DIR = 'eagle-video-preview-grid';
  var RULE_VERSION = 'v2';       // 保持：旧缓存零重抽兼容，不升级
  var LEGACY_COUNT = 9;          // 旧平铺缓存对应的数量
  var dataURLCache = Object.create(null);

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
    var s = readJson(settingsFile(), {}) || {};
    return {
      autoGenerate: s.autoGenerate === true,
      expanded: s.expanded === true,
      pendingPrune: s.pendingPrune === true
    };
  }

  /** 保留 settings.json 里所有未列出的字段（尤其 pendingPrune），避免被覆盖丢失。 */
  function setGlobal(patch) {
    var cur = readJson(settingsFile(), {}) || {};
    if (typeof patch.autoGenerate === 'boolean') cur.autoGenerate = patch.autoGenerate;
    if (typeof patch.expanded === 'boolean') cur.expanded = patch.expanded;
    if (typeof patch.pendingPrune === 'boolean') cur.pendingPrune = patch.pendingPrune;
    writeJson(settingsFile(), cur);
  }

  function getPrunePending() { return getGlobal().pendingPrune; }
  function markPrunePending() { setGlobal({ pendingPrune: true }); }
  function clearPrunePending() { setGlobal({ pendingPrune: false }); }

  /* ---------- 单个视频资源的配置 ---------- */

  function itemDir(itemId) {
    return node().path.join(root(), 'thumbs', safeId(itemId));
  }

  function ensureItemDir(itemId) { ensureDir(itemDir(itemId)); }

  function configFile(itemId) {
    return node().path.join(itemDir(itemId), 'config.json');
  }

  /**
   * 文件缺失 = 新视频 = 自动模式；旧文件（无 auto 字段）一律视为手动值保留。
   * activeCount 是「最近一次实际生效的张数」，供同步清理时判断保留哪套规格
   * （自动模式下按时长算需要 ffprobe，清理是同步的，所以用这个记录值）。
   */
  function getItemConfig(itemId) {
    var c = readJson(configFile(itemId), null);
    if (!c || typeof c !== 'object') return { tileCount: null, auto: true, activeCount: null };
    var auto = c.auto === true;
    var active = (typeof c.activeCount === 'number') ? global.Sampler.clampCount(c.activeCount) : null;
    return {
      tileCount: auto ? null : global.Sampler.clampCount(c.tileCount),
      auto: auto,
      activeCount: active
    };
  }

  function setItemConfig(itemId, cfg) {
    var cur = readJson(configFile(itemId), {}) || {};
    var out = { auto: cfg.auto === true };
    if (!out.auto) out.tileCount = global.Sampler.clampCount(cfg.tileCount);
    var active = (cfg.activeCount === undefined) ? cur.activeCount : cfg.activeCount;
    if (typeof active === 'number') out.activeCount = global.Sampler.clampCount(active);
    writeJson(configFile(itemId), out);
  }

  /** 只记录本次生效张数，不改变 auto / tileCount 语义。 */
  function setActiveCount(itemId, count) {
    var cur = getItemConfig(itemId);
    setItemConfig(itemId, {
      auto: cur.auto,
      tileCount: cur.tileCount,
      activeCount: count
    });
  }

  /* ---------- 派生缓存：按数量分规格 ---------- */

  function specDir(itemId, count) {
    return node().path.join(itemDir(itemId), 'n' + count);
  }

  function ensureSpecDir(itemId, count) { ensureDir(specDir(itemId, count)); }

  function metaFile(itemId, count) {
    return node().path.join(specDir(itemId, count), 'meta.json');
  }

  function thumbFile(itemId, count, index) {
    return node().path.join(specDir(itemId, count), index + '.jpg');
  }

  /* v1.5.0 旧平铺格式，视为 n9 */
  function legacyMetaFile(itemId) {
    return node().path.join(itemDir(itemId), 'meta.json');
  }

  function legacyThumbFile(itemId, index) {
    return node().path.join(itemDir(itemId), index + '.jpg');
  }

  /** 旧格式没有 requested / complete；用它决定 jpg 走旧平铺路径。 */
  function isLegacyMeta(meta) {
    return !!meta && meta.requested === undefined && meta.complete === undefined;
  }

  function thumbPathFor(meta, itemId, count, index) {
    return isLegacyMeta(meta)
      ? legacyThumbFile(itemId, index)
      : thumbFile(itemId, count, index);
  }

  function readMeta(itemId, count) {
    var m = readJson(metaFile(itemId, count), null);
    if (!m && count === LEGACY_COUNT) m = readJson(legacyMetaFile(itemId), null);
    return m;
  }

  /** 草稿与最终结果都写在对应规格目录里，不影响其它规格。 */
  function writeProgress(itemId, count, meta) {
    writeJson(metaFile(itemId, count), meta);
  }

  function writeMeta(itemId, count, meta) {
    writeJson(metaFile(itemId, count), meta);
    invalidateThumbs(itemId);
  }

  function invalidateThumbs(itemId) {
    var prefix = safeId(itemId) + ':';
    Object.keys(dataURLCache).forEach(function (k) {
      if (k.indexOf(prefix) === 0) delete dataURLCache[k];
    });
  }

  /**
   * 从任一规格读时长，避免自动模式下每次切换都跑 ffprobe。
   * 传入 stat 时只接受与当前源文件一致的 meta（换过源文件则必须重新 probe）。
   */
  function readAnyDuration(itemId, stat) {
    var n = node();
    var dir = itemDir(itemId);
    var entries;
    try { entries = n.fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
    var candidates = [legacyMetaFile(itemId)];
    entries.forEach(function (ent) {
      if (ent.isDirectory() && /^n\d+$/.test(ent.name)) {
        candidates.push(n.path.join(dir, ent.name, 'meta.json'));
      }
    });
    for (var i = 0; i < candidates.length; i++) {
      var m = readJson(candidates[i], null);
      if (!m || !isFinite(Number(m.duration)) || Number(m.duration) <= 0) continue;
      if (stat && (m.sourceSize !== stat.size || m.sourceMtime !== stat.mtimeMs)) continue;
      return Number(m.duration);
    }
    return null;
  }

  function fileStat(filePath) {
    try {
      var st = node().fs.statSync(filePath);
      return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    } catch (e) {
      return { size: 0, mtimeMs: 0 };
    }
  }

  /** 兼容读取 meta：旧格式用 count 兜底 requested、按 results 是否填满推导 complete。 */
  function normalizeMeta(meta) {
    if (!meta || !Array.isArray(meta.times) || meta.times.length === 0) return null;
    var results = Array.isArray(meta.results) ? meta.results : [];
    var full = results.length === meta.times.length && results.every(function (r) {
      return r === true || r === false;
    });
    return {
      meta: meta,
      results: results,
      requested: (typeof meta.requested === 'number') ? meta.requested : meta.count,
      complete: (typeof meta.complete === 'boolean') ? meta.complete : full
    };
  }

  function sameSpec(meta, ctx) {
    var n = normalizeMeta(meta);
    if (!n || meta.rule !== RULE_VERSION) return false;
    if (n.requested !== ctx.count) return false;
    if (meta.sourceSize !== ctx.sourceSize || meta.sourceMtime !== ctx.sourceMtime) return false;
    return true;
  }

  /** 完整命中：已跑完（含已定失败帧），每张成功帧的 jpg 存在且非空。 */
  function isCacheValid(meta, ctx) {
    var n = normalizeMeta(meta);
    if (!n || !n.complete || !sameSpec(meta, ctx)) return false;
    var fs = node().fs;
    for (var i = 0; i < n.meta.times.length; i++) {
      if (n.results[i] === false) continue;      // 失败帧是占位卡片，本来就没 jpg
      if (n.results[i] !== true) return false;   // 还有 pending
      try {
        if (fs.statSync(thumbPathFor(meta, ctx.itemId, ctx.count, i)).size <= 0) return false;
      } catch (e) {
        return false;
      }
    }
    return true;
  }

  function isResumable(meta, ctx) {
    var n = normalizeMeta(meta);
    return !!n && !n.complete && sameSpec(meta, ctx);
  }

  function thumbDataURL(itemId, count, index) {
    var k = safeId(itemId) + ':' + count + ':' + index;
    if (dataURLCache[k]) return dataURLCache[k];
    var fs = node().fs;
    var p = thumbFile(itemId, count, index);
    if (!fs.existsSync(p) && count === LEGACY_COUNT) p = legacyThumbFile(itemId, index);
    var buf = fs.readFileSync(p);
    var url = 'data:image/jpeg;base64,' + buf.toString('base64');
    dataURLCache[k] = url;
    return url;
  }

  /** 「清空」：删除所有规格目录与旧平铺 jpg/meta，但保留 config.json。 */
  function clearItem(itemId) {
    var n = node();
    var fs = n.fs;
    var dir = itemDir(itemId);
    try {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(function (ent) {
        var p = n.path.join(dir, ent.name);
        if (ent.isDirectory() && /^n\d+$/.test(ent.name)) {
          try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        } else if (!ent.isDirectory() && /^(\d+\.jpg|meta\.json)$/i.test(ent.name)) {
          try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
        }
      });
    } catch (e) { /* 目录不存在 */ }
    invalidateThumbs(itemId);
  }

  /**
   * 清理「用不到的」规格：每个视频只保留 config.activeCount（或 tileCount）对应的
   * n<count>/ 目录；其余规格目录全部删除。旧平铺文件只在当前规格不是 n9 时删除。
   * covers/ 不受影响（已设为封面的图必须保留）。
   * 只在 onPluginCreate 且 pendingPrune 时调用，切换数量的当次会话不清。
   */
  function pruneUnused() {
    var n = node();
    var fs = n.fs;
    var base = n.path.join(root(), 'thumbs');
    var removed = 0;
    var entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (e) {
      return { removed: 0 };
    }
    entries.forEach(function (ent) {
      if (!ent.isDirectory()) return;
      var dir = n.path.join(base, ent.name);
      var cfg = readJson(n.path.join(dir, 'config.json'), {}) || {};
      var keep = null;
      if (typeof cfg.activeCount === 'number') {
        keep = 'n' + global.Sampler.clampCount(cfg.activeCount);
      } else if (cfg.auto !== true && cfg.tileCount != null) {
        keep = 'n' + global.Sampler.clampCount(cfg.tileCount);
      }
      var files;
      try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      files.forEach(function (f) {
        var p = n.path.join(dir, f.name);
        var isSpec = f.isDirectory() && /^n\d+$/.test(f.name);
        var isLegacy = !f.isDirectory() && /^(\d+\.jpg|meta\.json)$/i.test(f.name);
        if (!isSpec && !isLegacy) return;
        if (isSpec) {
          if (keep && f.name === keep) return;
          try { fs.rmSync(p, { recursive: true, force: true }); removed++; } catch (e) { /* ignore */ }
        } else {
          if (!keep || keep === 'n' + LEGACY_COUNT) return;
          try { fs.unlinkSync(p); removed++; } catch (e) { /* ignore */ }
        }
      });
    });
    return { removed: removed };
  }

  /* ---------- 右键菜单用的原尺寸帧 ---------- */

  /** 固定文件名：每个视频只留最近抽出的一张原帧，不随操作次数累积。 */
  function frameFile(itemId) {
    return node().path.join(root(), 'frames', safeId(itemId) + '.jpg');
  }

  function ensureFrameDir() { ensureDir(node().path.join(root(), 'frames')); }

  /** 任意本地 JPEG -> data URL，供 <a download> 兜底另存为使用。 */
  function fileDataURL(filePath) {
    return 'data:image/jpeg;base64,' + node().fs.readFileSync(filePath).toString('base64');
  }

  /* ---------- 设为封面用的持久副本 ---------- */

  function coverFile(itemId) {
    return node().path.join(root(), 'covers', safeId(itemId) + '.jpg');
  }

  /** 固定文件名：每个视频只留一份，不随切换封面累积；也不被 pruneUnused 删除。 */
  function copyToCover(itemId, srcPath) {
    var n = node();
    var dst = coverFile(itemId);
    ensureDir(n.path.dirname(dst));
    n.fs.copyFileSync(srcPath, dst);
    return dst;
  }

  var api = {
    PLUGIN_DIR: PLUGIN_DIR,
    RULE_VERSION: RULE_VERSION,
    LEGACY_COUNT: LEGACY_COUNT,
    root: root,
    getGlobal: getGlobal,
    setGlobal: setGlobal,
    getPrunePending: getPrunePending,
    markPrunePending: markPrunePending,
    clearPrunePending: clearPrunePending,
    itemDir: itemDir,
    ensureItemDir: ensureItemDir,
    ensureSpecDir: ensureSpecDir,
    specDir: specDir,
    getItemConfig: getItemConfig,
    setItemConfig: setItemConfig,
    setActiveCount: setActiveCount,
    metaFile: metaFile,
    thumbFile: thumbFile,
    legacyMetaFile: legacyMetaFile,
    legacyThumbFile: legacyThumbFile,
    isLegacyMeta: isLegacyMeta,
    thumbPathFor: thumbPathFor,
    readMeta: readMeta,
    readAnyDuration: readAnyDuration,
    writeMeta: writeMeta,
    writeProgress: writeProgress,
    fileStat: fileStat,
    normalizeMeta: normalizeMeta,
    sameSpec: sameSpec,
    isResumable: isResumable,
    isCacheValid: isCacheValid,
    thumbDataURL: thumbDataURL,
    invalidateThumbs: invalidateThumbs,
    clearItem: clearItem,
    pruneUnused: pruneUnused,
    coverFile: coverFile,
    copyToCover: copyToCover,
    frameFile: frameFile,
    ensureFrameDir: ensureFrameDir,
    fileDataURL: fileDataURL
  };

  global.Store = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
