/**
 * layout.js — 网格布局纯函数（无 DOM / Eagle 依赖，可单测）
 *
 * 规则：3 列；收起态最多 9 张；网格最多 3 行；0 张时高度 0。
 * 展开态仍保持最多 3 行，多出的卡片在网格内部滚动。
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

  function rowsFor(count) {
    var n = Math.max(0, Math.floor(Number(count) || 0));
    if (n === 0) return 0;
    return Math.min(MAX_ROWS, Math.ceil(n / COLUMNS));
  }

  /**
   * 依据运行时实测的 cellH / rowGap 计算网格像素高度，
   * 避免硬编码缩图尺寸（缩图宽度随检查器宽度变化）。
   */
  function heightFor(count, cellH, rowGap) {
    var rows = rowsFor(count);
    if (rows === 0) return 0;
    var h = Number(cellH) || 0;
    var g = Number(rowGap) || 0;
    return Math.round(rows * h + (rows - 1) * g);
  }

  var api = {
    VISIBLE_LIMIT: VISIBLE_LIMIT,
    COLUMNS: COLUMNS,
    MAX_ROWS: MAX_ROWS,
    visibleCount: visibleCount,
    needsToggle: needsToggle,
    rowsFor: rowsFor,
    heightFor: heightFor
  };

  global.Layout = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
