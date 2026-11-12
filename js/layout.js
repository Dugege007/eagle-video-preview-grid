/**
 * layout.js — 网格布局纯函数（无 DOM / Eagle 依赖，可单测）
 *
 * 收起态：最多 9 张、最多 3 行（高度封顶 3 行）。
 * 展开态：显示全部张数，行数不封顶 —— 高度随张数变化（v0.3.0）。
 * 若目标高度超过 iframe 可用高度，由 fitHeight() 退回内部滚动，避免内容被裁掉。
 */
(function (global) {
  'use strict';

  var VISIBLE_LIMIT = 9;
  var COLUMNS = 3;
  var MAX_ROWS = 3;

  function visibleCount(total, expanded) {
    var n = Math.max(0, Math.floor(Number(total) || 0));
    return expanded ? n : Math.min(VISIBLE_LIMIT, n);
  }

  function needsToggle(total) {
    return Math.max(0, Math.floor(Number(total) || 0)) > VISIBLE_LIMIT;
  }

  /** expanded=true 时行数不封顶；收起态最多 MAX_ROWS 行。 */
  function rowsFor(count, expanded) {
    var n = Math.max(0, Math.floor(Number(count) || 0));
    if (n === 0) return 0;
    var rows = Math.ceil(n / COLUMNS);
    return expanded ? rows : Math.min(MAX_ROWS, rows);
  }

  /** 依据运行时实测的 cellH / rowGap 计算目标像素高度。 */
  function heightFor(count, cellH, rowGap, expanded) {
    var rows = rowsFor(count, expanded);
    if (rows === 0) return 0;
    var h = Number(cellH) || 0;
    var g = Number(rowGap) || 0;
    return Math.round(rows * h + (rows - 1) * g);
  }

  /**
   * 可用高度保护：目标高度装不进 iframe 时，退回「占满可用高度 + 内部滚动」，
   * 而不是硬撑高度让内容被宿主裁掉。
   * avail <= 0 表示拿不到可用高度，此时按目标高度处理。
   */
  function fitHeight(target, avail) {
    var t = Math.max(0, Math.round(Number(target) || 0));
    var a = Math.max(0, Math.round(Number(avail) || 0));
    if (a <= 0 || t <= a) return { height: t, scroll: false };
    return { height: a, scroll: true };
  }

  var api = {
    VISIBLE_LIMIT: VISIBLE_LIMIT,
    COLUMNS: COLUMNS,
    MAX_ROWS: MAX_ROWS,
    visibleCount: visibleCount,
    needsToggle: needsToggle,
    rowsFor: rowsFor,
    heightFor: heightFor,
    fitHeight: fitHeight
  };

  global.Layout = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
