'use strict';

// 核验规则的“确定性核心”：仅包含纯函数与常量，不依赖数据库。
// 发布封存（attest.js）与离线独立校验程序（scripts/verify-attestation.js）
// 使用同一份定义；规则变更必须提升 RULES_VERSION，旧凭证仍按其记录的版本由
// 离线校验程序中的历史规则解释。

const RULES_VERSION = '1.0.0';
const RULE_ALGORITHM = 'wildcard-scope-closed-interval-v1';

const MAX_PATH_INSTANCES = 5000;
const MAX_CHAIN_DEPTH = 100;

// 媒介/地区匹配：授权填 * 通配任意值；忽略大小写与首尾空白
function scopeMatches(authValue, wanted) {
  if (authValue === '*') return true;
  return String(authValue).trim().toLowerCase() === String(wanted).trim().toLowerCase();
}

// 有效期按闭区间覆盖整段使用期（单份授权必须独自覆盖，不跨授权拼接）
function dateCovers(validFrom, validTo, useFrom, useTo) {
  return validFrom <= useFrom && validTo >= useTo;
}

// 依据一份授权条款，判定是否独自覆盖某站（媒介/地区/展期）。
// revoked 条款一律不命中（凭证中封存的条款均应为未撤销）。
function termCoversStop(term, stop) {
  if (!term || term.revoked === true) return false;
  return scopeMatches(term.media, stop.medium)
    && scopeMatches(term.region, stop.region)
    && dateCovers(term.validFrom, term.validTo, stop.useFrom, stop.useTo);
}

// 日期合法性（与 verify.js 保持一致：严格 YYYY-MM-DD 日历日）
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// 相邻站不得重叠：首尾日均占用，后一站起始日须严格晚于前一站截止日
function stopsOverlap(stops) {
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1];
    const cur = stops[i];
    if (cur.useFrom <= prev.useTo) return true;
  }
  return false;
}

module.exports = {
  RULES_VERSION,
  RULE_ALGORITHM,
  MAX_PATH_INSTANCES,
  MAX_CHAIN_DEPTH,
  scopeMatches,
  dateCovers,
  termCoversStop,
  isValidDate,
  stopsOverlap,
};
