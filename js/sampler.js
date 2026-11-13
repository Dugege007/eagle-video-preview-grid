/**
 * sampler.js — 确定性采样算法（纯函数，不依赖 Eagle / Node / DOM）
 *
 * 规则（由需求方口述并形式化）：
 *   视频时长 T 分成 N+1 段，去掉首尾，只取中间 N 个分界点；
 *   但相邻两点间隔不得低于 5 秒。短视频从尾部往前对齐，尾部保留完整段，
 *   首部不足 5 秒的余数段直接截断（28s/9 张 -> 3/8/13/18/23s）。
 *
 *   gap0 = T / (N + 1)
 *   gap  = max(gap0, MIN_GAP)
 *   M    = min(N, floor(T / gap))
 *   t_i  = T - M*gap + (i-1)*gap      (i = 1..M)
 *
 *   N = 0 是合法值：该视频不生成预览图（reason = 'zero-count'），
 *   连时长都不需要读取；用于「全程只有一个画面、有封面就够」的视频。
 *
 * 该文件同时挂到 window.Sampler（检查器 iframe 用 <script> 加载）
 * 与 module.exports（Node 单测用 require 加载）。
 */
(function (global) {
  'use strict';

  var MIN_GAP = 5;           // 最低时间间隔，秒
  var DEFAULT_COUNT = 9;     // 兜底数量（拿不到时长 / 非法输入时）
  var MIN_COUNT = 0;         // 0 = 该视频不生成预览图
  var MAX_COUNT = 30;        // 输入上限，防止误填导致大量 spawn
  var MIN_FIRST_POINT = 1;   // 首点保护阈值：早于 1s 视为片头黑帧

  /**
   * 时长自动分桶（v1.6.0 引入，v1.6.1 按用户给的新表修订）。
   * 8 档，下界含、上界不含；最后一档 >= 3600s 为 30 张。
   * 边界（秒）：60 / 120 / 300 / 600 / 1200 / 2400 / 3600，全部凑整、非线性递增。
   * 注意：新表不再保证「每档恰好 +3」，40min 之后跳档（18 -> 24 -> 30）。
   */
  var AUTO_BUCKETS = [
    { max: 60,       count: 3 },
    { max: 120,      count: 6 },
    { max: 300,      count: 9 },
    { max: 600,      count: 12 },
    { max: 1200,     count: 15 },
    { max: 2400,     count: 18 },
    { max: 3600,     count: 24 },
    { max: Infinity, count: 30 }
  ];

  /** 按视频时长返回默认张数；时长无效时回退 DEFAULT_COUNT。 */
  function autoCount(duration) {
    var T = Number(duration);
    if (!isFinite(T) || T <= 0) return DEFAULT_COUNT;
    for (var i = 0; i < AUTO_BUCKETS.length; i++) {
      if (T < AUTO_BUCKETS[i].max) return AUTO_BUCKETS[i].count;
    }
    return MAX_COUNT;
  }

  /**
   * 合法范围 0–30；空值 / 非数字 / 负数回退默认 9，小数向下取整。
   * 空字符串必须单独判断：Number('') === 0，否则清空输入框会被误当成「设为 0」。
   */
  function clampCount(value) {
    var raw = (value === undefined || value === null) ? '' : String(value).trim();
    if (raw === '') return DEFAULT_COUNT;
    var n = Math.floor(Number(raw));
    if (!isFinite(n) || n < MIN_COUNT) return DEFAULT_COUNT;
    return Math.min(n, MAX_COUNT);
  }

  function buildTimes(T, gap, m) {
    var out = [];
    for (var i = 1; i <= m; i++) {
      out.push(T - m * gap + (i - 1) * gap);
    }
    return out;
  }

  /**
   * @param {number} duration 视频时长（秒）
   * @param {number} count    期望张数
   * @returns {{duration:number, requested:number, actual:number, gap:number,
   *            times:number[], truncated:boolean, droppedFirst:boolean, reason:string}}
   */
  function plan(duration, count) {
    var n = clampCount(count);
    var T = Number(duration);
    var result = {
      duration: T,
      requested: n,
      actual: 0,
      gap: MIN_GAP,
      times: [],
      truncated: false,
      droppedFirst: false,
      reason: 'ok'
    };

    // 0 张优先于时长判断：不需要读时长、不需要抽帧，也不产生任何时间点。
    if (n === MIN_COUNT) {
      result.reason = 'zero-count';
      result.gap = 0;
      return result;
    }

    if (!isFinite(T) || T <= 0) {
      result.reason = 'invalid-duration';
      return result;
    }

    var gap0 = T / (n + 1);
    var gap = Math.max(gap0, MIN_GAP);
    result.gap = gap;

    var m = Math.min(n, Math.floor(T / gap));
    if (m <= 0) {
      result.reason = 'too-short';
      return result;
    }

    var times = buildTimes(T, gap, m);

    // 保护性默认：T 恰为 gap 整数倍时首点会落在 0 秒（片头黑帧），
    // 丢掉最靠首部的那一段，保持等距且全部落在完整段起点。
    if (times[0] < MIN_FIRST_POINT) {
      result.droppedFirst = true;
      m -= 1;
      times = m > 0 ? buildTimes(T, gap, m) : [];
    }

    if (times.length === 0) {
      result.reason = 'too-short';
      return result;
    }

    result.times = times.map(function (t) { return Math.round(t * 1000) / 1000; });
    result.actual = result.times.length;
    result.truncated = result.actual < n;
    return result;
  }

  /** 秒 -> MM:SS / HH:MM:SS（显示取整秒，抽帧仍用精确浮点） */
  function formatTime(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    var pad = function (v) { return v < 10 ? '0' + v : String(v); };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(r) : pad(m) + ':' + pad(r);
  }

  var api = {
    MIN_GAP: MIN_GAP,
    DEFAULT_COUNT: DEFAULT_COUNT,
    MIN_COUNT: MIN_COUNT,
    MAX_COUNT: MAX_COUNT,
    MIN_FIRST_POINT: MIN_FIRST_POINT,
    AUTO_BUCKETS: AUTO_BUCKETS,
    autoCount: autoCount,
    clampCount: clampCount,
    plan: plan,
    formatTime: formatTime
  };

  global.Sampler = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
