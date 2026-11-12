/**
 * batch.js — 多选批量修改的纯函数（不依赖 Eagle / Node / DOM，可单测）
 *
 * manifest 的 inspector.multiSelect 设为 true 后，Eagle 在多选素材时也会显示插件，
 * eagle.item.getSelected() 返回 Item[]（官方：Promise<items: Item[]>）。
 * 这里负责：只挑出本插件支持的视频、用稳定的 id 集合判断「选中是否变化」、
 * 以及生成确认弹窗文案。所有涉及文件 / UI 的操作都留在 main.js。
 */
(function (global) {
  'use strict';

  // 与 manifest.preview 的扩展名列表保持一致
  var VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'flv', 'wmv'];

  function normalizeExt(s) {
    return String(s || '').trim().toLowerCase().replace(/^\./, '');
  }

  /** item.ext 优先；缺失时从 filePath 后缀回退。带点 / 大写都兼容。 */
  function isVideoItem(item) {
    if (!item) return false;
    var ext = normalizeExt(item.ext);
    if (!ext) {
      var m = /\.([a-z0-9]+)$/i.exec(String(item.filePath || ''));
      ext = m ? normalizeExt(m[1]) : '';
    }
    return VIDEO_EXTS.indexOf(ext) >= 0;
  }

  /** 过滤非视频，并丢掉缺 id / filePath 的异常项，避免后续写缓存时报错。 */
  function videosOnly(items) {
    var list = Array.isArray(items) ? items : (items ? [items] : []);
    return list.filter(function (it) {
      return isVideoItem(it) && it.id && it.filePath;
    });
  }

  /** 选中签名只与 id 集合有关：顺序变化不触发重复刷新；空选中返回 ''。 */
  function selectionSignature(items) {
    return videosOnly(items).map(function (it) {
      return String(it.id);
    }).sort().join('|');
  }

  function isMulti(items) {
    return videosOnly(items).length > 1;
  }

  /** 本次批量的「预计最多张数」= 视频数 × 每个视频的数量（实际可能更少）。 */
  function totalPlanned(count, n) {
    var k = Math.max(0, Math.floor(Number(count) || 0));
    var m = Math.max(0, Math.floor(Number(n) || 0));
    return k * m;
  }

  function confirmMessage(count, n) {
    return '确定将这 ' + count + ' 个视频的生成预览图张数统一改为 ' + n +
      ' 吗？（预计最多生成 ' + totalPlanned(count, n) + ' 张预览图）';
  }

  function confirmDetail(count, n) {
    var total = totalPlanned(count, n);
    var effect = n === 0
      ? '设为 0 表示这些视频不再生成预览图，已生成的缩图会被清空，本次共 0 张。'
      : '预计最多生成 ' + total + ' 张（' + count + ' 个视频 × ' + n +
        ' 张）；短视频受 5 秒最低间隔限制会更少，已有符合数量与规则的预览图会直接复用，实际张数可能更少。';
    return '会覆盖这 ' + count +
      ' 个视频各自原有的数量设置与已生成缩图，其他视频不受影响。' + effect + '请谨慎修改。';
  }

  /**
   * 首帧同步预填充的状态合并（纯函数，可单测）。
   * raw      = localStorage 里上次记住的 UI 状态（theme / count）
   * globals  = settings.json 的全局开关（权威，优先于默认值）
   * defaults = 兜底值
   * 注意 count 只作为「上一帧的近似值」：真正属于哪个视频要等 tick() 拿到
   * getSelected() 后覆盖，因此这里不做业务校验，钳制交给 Sampler.clampCount。
   */
  function bootState(raw, globals, defaults) {
    var p = (raw && typeof raw === 'object') ? raw : {};
    var g = (globals && typeof globals === 'object') ? globals : {};
    var d = (defaults && typeof defaults === 'object') ? defaults : {};
    return {
      theme: (typeof p.theme === 'string' && p.theme) ? p.theme : (d.theme || 'LIGHT'),
      autoGenerate: typeof g.autoGenerate === 'boolean' ? g.autoGenerate : !!d.autoGenerate,
      expanded: typeof g.expanded === 'boolean' ? g.expanded : !!d.expanded,
      // 0 是合法数量，不能用 || 判断缺失
      count: (p.count === 0 || p.count) ? p.count : d.count
    };
  }

  /** 批量结束的汇总文案。skipped = 缓存命中 / 时长不足；failed = 出错或抽帧有失败的视频。 */
  function summary(count, n, skipped, failed) {
    var s = '已统一修改 ' + count + ' 个视频的数量为 ' + n;
    if (skipped) s += ' · ' + skipped + ' 个跳过（已有缓存或时长不足）';
    if (failed) s += ' · ' + failed + ' 个有失败';
    return s;
  }

  var api = {
    VIDEO_EXTS: VIDEO_EXTS,
    normalizeExt: normalizeExt,
    isVideoItem: isVideoItem,
    videosOnly: videosOnly,
    selectionSignature: selectionSignature,
    isMulti: isMulti,
    totalPlanned: totalPlanned,
    bootState: bootState,
    confirmMessage: confirmMessage,
    confirmDetail: confirmDetail,
    summary: summary
  };

  global.Batch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
