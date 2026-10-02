'use strict';

// 档期规划：为待发布展览包按当前展期天数（含首尾）查找
// “完整落在规划窗口内、且入展素材及全部上游来源节点均被同一份
// 未撤销 + 媒介/地区匹配的授权完整覆盖”的起始日；并在选定后于
// 事务内重验并改期。
//
// 基本换算（展期 durationDays 天，含首尾）：
//   起始日 s 的展期为 [s, s + durationDays - 1]
//   一份授权 [vf, vt] 完整覆盖它，当且仅当 vf <= s 且 vt >= s + durationDays - 1
//   即可行起始日 s ∈ [vf, vt - durationDays + 1]
// 每份授权单独折算一个区间；同节点多份授权给出的是“多区间并集”，
// 不满足长度的短授权折算为空——天然实现“同一节点短授权不可拼接”。

const crypto = require('crypto');
const { isValidDate, loadGraph, collectChains, basisVersion } = require('./verify');

class ScheduleError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const str = (v) => (v === null || v === undefined ? '' : String(v));

// ---------- 日期工具（UTC，YYYY-MM-DD 按天加减/比较，字符串天然字典序可比较） ----------
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysInclusive(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
}

// ---------- 闭区间（[lo, hi]，均含）工具 ----------
function mergeRanges(ranges) {
  const sorted = ranges.filter((r) => r && r.lo <= r.hi).sort((a, b) => a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.lo <= addDays(last.hi, 1)) {
      if (r.hi > last.hi) last.hi = r.hi;
    } else {
      out.push({ lo: r.lo, hi: r.hi });
    }
  }
  return out;
}

function intersectLists(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    const lo = x.lo > y.lo ? x.lo : y.lo;
    const hi = x.hi < y.hi ? x.hi : y.hi;
    if (lo <= hi) out.push({ lo, hi });
    // 标准区间交集归并：右端点较小者推进；相等则两个区间同时结束
    if (x.hi < y.hi) i++;
    else if (x.hi > y.hi) j++;
    else { i++; j++; }
  }
  return out;
}

const REASON_TEXT = {
  no_auth: '该节点未登记任何授权',
  revoked: '该节点的授权均已撤销',
  media: '无覆盖该展示媒介的有效授权',
  region: '无覆盖该展示地区的有效授权',
  media_region: '无覆盖该展示媒介与地区的有效授权',
  date: '无任何一份授权能独自覆盖整段展期（短授权不可拼接）',
};

// 媒介/地区命中规则与 verify.evalNode 完全一致：
// 未撤销；授权值相等或授权值为 *（忽略大小写）；授权必须单份独自覆盖整段展期。
function scopeHit(authValue, wanted) {
  if (authValue === '*') return true;
  return String(authValue).trim().toLowerCase() === String(wanted).trim().toLowerCase();
}
// ---------- 包载入与结构/参数校验 ----------
function loadDraftPackage(db, packageId) {
  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(packageId);
  if (!pkg) throw new ScheduleError(404, '展览包不存在');
  return pkg;
}

function assertDraft(pkg) {
  if (pkg.status !== 'draft') {
    throw new ScheduleError(409,
      `当前状态为 ${pkg.status}：已发布和需复核包不可改期；如需调整档期请使用「复制为待发布包」。`,
      { code: 'NOT_DRAFT', status: pkg.status });
  }
}

// 档期搜索只适用于单站包：多站巡展包必须明确拒绝
function assertSingleStop(db, pkg) {
  const n = db.prepare('SELECT COUNT(*) FROM package_stops WHERE package_id=?').pluck().get(pkg.id);
  if (n >= 2) {
    throw new ScheduleError(409,
      '档期搜索只适用于单站展览包；多站巡展包请逐站编排行程（站次不同媒介/地区/展期，不支持整包统一档期搜索）。',
      { code: 'MULTI_STOP_UNSUPPORTED', stopCount: n });
  }
}

function packageInput(pkg, items) {
  const medium = str(pkg.medium).trim();
  const region = str(pkg.region).trim();
  return {
    packageId: pkg.id,
    name: pkg.name,
    medium,
    region,
    useFrom: pkg.use_from || '',
    useTo: pkg.use_to || '',
    materialIds: items,
  };
}

// 校验包自身参数（空包 / 缺媒介地区 / 非法原展期均为错误，而非“无档期”）
function assertValidPackage(input) {
  if (input.materialIds.length === 0) {
    throw new ScheduleError(400, '空展览包：尚未选取任何入展素材，无法规划档期', { code: 'EMPTY_PACKAGE' });
  }
  if (!input.medium) throw new ScheduleError(400, '包缺少展示媒介，无法规划档期', { code: 'INVALID_PACKAGE' });
  if (!input.region) throw new ScheduleError(400, '包缺少展示地区，无法规划档期', { code: 'INVALID_PACKAGE' });
  if (!isValidDate(input.useFrom) || !isValidDate(input.useTo) || input.useFrom > input.useTo) {
    throw new ScheduleError(400,
      `包的当前展期不合法（${input.useFrom || '（空）'} → ${input.useTo || '（空）'}），无法据其展期天数规划档期`,
      { code: 'INVALID_PACKAGE' });
  }
}

function parseWindow(rawFrom, rawTo) {
  const planFrom = str(rawFrom).trim();
  const planTo = str(rawTo).trim();
  if (!isValidDate(planFrom)) {
    throw new ScheduleError(400, `规划起始日不合法：${planFrom || '（空）'}（需为 YYYY-MM-DD）`, { code: 'INVALID_WINDOW' });
  }
  if (!isValidDate(planTo)) {
    throw new ScheduleError(400, `规划截止日不合法：${planTo || '（空）'}（需为 YYYY-MM-DD）`, { code: 'INVALID_WINDOW' });
  }
  if (planFrom > planTo) {
    throw new ScheduleError(400, `规划窗口不合法：起始 ${planFrom} 晚于截止 ${planTo}`, { code: 'INVALID_WINDOW' });
  }
  return { planFrom, planTo };
}

// 结构性核验：成环 / 超深 / 路径截断 / 素材缺失一律按无法核验处理
function checkStructure(db, roots) {
  const matRows = db.prepare('SELECT id, title, kind FROM materials').all();
  const matById = new Map(matRows.map((m) => [m.id, m]));

  const missing = roots.filter((id) => !matById.has(id));
  if (missing.length) {
    throw new ScheduleError(422, `入展素材不存在：#${[...new Set(missing)].join('、#')}`,
      { code: 'UNVERIFIABLE', missing: missing.map((id) => ({ materialId: id, reasons: ['missing'] })) });
  }

  const adj = loadGraph(db);
  const nodeTitles = new Map();
  const nodeReasons = new Map();
  const addReason = (id, reason) => {
    if (!nodeReasons.has(id)) nodeReasons.set(id, new Set());
    nodeReasons.get(id).add(reason);
  };
  let truncated = false;
  let anyDepth = false;
  for (const root of roots) {
    const { nodePaths, cyclicNodes, truncated: t, tooDeep } = collectChains(adj, root);
    truncated = truncated || t;
    anyDepth = anyDepth || tooDeep;
    for (const id of nodePaths.keys()) {
      if (matById.has(id) && !nodeTitles.has(id)) nodeTitles.set(id, matById.get(id).title);
      if (cyclicNodes.has(id)) addReason(id, 'cycle');
      if (tooDeep) addReason(id, 'depth');
    }
  }
  if (truncated || anyDepth || nodeReasons.size) {
    const nodes = [...nodeReasons.keys()].sort((a, b) => a - b).map((id) => ({
      materialId: id,
      title: nodeTitles.get(id) || `#${id}`,
      reasons: [...nodeReasons.get(id)],
    }));
    throw new ScheduleError(422,
      '来源结构存在成环或超过安全上限，档期规划无法在保证不漏判的前提下完成，请先简化来源结构后重试',
      { code: 'UNVERIFIABLE', truncated, tooDeep: anyDepth, nodes });
  }
  return { adj, matById, nodeTitles };
}

// 全部来源链节点（入展品 + 全部上游），按 id 升序
function collectNodes(adj, roots) {
  const seen = new Set(roots);
  const stack = [...roots];
  while (stack.length) {
    const cur = stack.pop();
    for (const up of adj.get(cur) || []) {
      if (!seen.has(up)) { seen.add(up); stack.push(up); }
    }
  }
  return [...seen].sort((a, b) => a - b);
}

// 单节点：在 [loStart, hiStart] 内的可行起始日区间及受限原因
// （媒介/地区判定与 verify.evalNode 一致，未撤销；每份授权必须独自覆盖整段展期）
function evalNodeWindow(authRows, { medium, region, loStart, hiStart, durationDays }) {
  const active = authRows.filter((a) => !a.revoked);
  if (authRows.length === 0) return { ranges: [], reason: 'no_auth' };
  if (active.length === 0) return { ranges: [], reason: 'revoked' };

  const mediaOk = active.filter((a) => scopeHit(a.media, medium));
  const regionOk = active.filter((a) => scopeHit(a.region, region));
  const scopeOk = active.filter((a) => scopeHit(a.media, medium) && scopeHit(a.region, region));
  if (scopeOk.length === 0) {
    if (mediaOk.length === 0 && regionOk.length === 0) return { ranges: [], reason: 'media_region' };
    if (mediaOk.length === 0) return { ranges: [], reason: 'media' };
    return { ranges: [], reason: 'region' };
  }

  // s ∈ [vf, vt - durationDays + 1]，再与规划窗口允许的起始日区间取交
  const ranges = [];
  for (const a of scopeOk) {
    const lo = a.valid_from;
    const hi = addDays(a.valid_to, -(durationDays - 1));
    const l = lo < loStart ? loStart : lo;
    const h = hi > hiStart ? hiStart : hi;
    if (l <= h) ranges.push({ lo: l, hi: h });
  }
  return { ranges: mergeRanges(ranges), reason: ranges.length === 0 ? 'date' : null };
}

function rangeDTO(r, durationDays) {
  return {
    startFrom: r.lo,
    startTo: r.hi,
    dayCount: daysInclusive(r.lo, r.hi),
    earliestExhibitionFrom: r.lo,
    earliestExhibitionTo: addDays(r.lo, durationDays - 1),
  };
}

// 搜索令牌：记录搜索所依据的版本、包参数/清单指纹与窗口/天数；
// 应用时在事务内逐项重验。
function packageFingerprint(input) {
  const canon = {
    medium: input.medium,
    region: input.region,
    useFrom: input.useFrom,
    useTo: input.useTo,
    materialIds: [...input.materialIds].sort((a, b) => a - b),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

function makeSearchToken(db, input, plan, durationDays) {
  return {
    packageId: input.packageId,
    basisVersion: basisVersion(db),
    fingerprint: packageFingerprint(input),
    planFrom: plan.planFrom,
    planTo: plan.planTo,
    durationDays,
  };
}

/**
 * 档期搜索（只读）。
 * raw: { packageId, planFrom, planTo }
 * 返回可行起始日分段（升序、连续合并）；无结果时附每个受限节点在窗口内的可行范围。
 */
function searchSchedule(db, raw) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const packageId = Number(body.packageId);
  if (!Number.isInteger(packageId) || packageId <= 0) {
    throw new ScheduleError(400, '缺少合法的 packageId');
  }
  const pkg = loadDraftPackage(db, packageId);
  assertDraft(pkg);
  assertSingleStop(db, pkg);
  const items = db
    .prepare('SELECT material_id FROM package_items WHERE package_id=? ORDER BY position, material_id')
    .all(packageId)
    .map((r) => r.material_id);
  const input = packageInput(pkg, items);
  assertValidPackage(input);
  const plan = parseWindow(body.planFrom, body.planTo);

  const durationDays = daysInclusive(input.useFrom, input.useTo);
  const { adj, matById } = checkStructure(db, input.materialIds);
  const nodeIds = collectNodes(adj, input.materialIds);

  // 窗口内允许的起始日：展期（含首尾）须完整落在 [planFrom, planTo]
  const loStart = plan.planFrom;
  const hiStart = addDays(plan.planTo, -(durationDays - 1));

  const windowTooShort = loStart > hiStart;
  const authByMat = new Map();
  for (const a of db.prepare('SELECT * FROM authorizations').all()) {
    if (!authByMat.has(a.material_id)) authByMat.set(a.material_id, []);
    authByMat.get(a.material_id).push(a);
  }

  let feasible = windowTooShort ? [] : [{ lo: loStart, hi: hiStart }];
  const nodes = [];
  for (const id of nodeIds) {
    const ev = windowTooShort
      ? { ranges: [], reason: null }
      : evalNodeWindow(authByMat.get(id) || [], {
        medium: input.medium, region: input.region, loStart, hiStart, durationDays,
      });
    nodes.push({
      materialId: id,
      title: matById.get(id).title,
      isRoot: input.materialIds.includes(id),
      ranges: ev.ranges.map((r) => rangeDTO(r, durationDays)),
      reason: ev.reason,
      reasonText: ev.reason ? REASON_TEXT[ev.reason] : null,
    });
    if (!windowTooShort) feasible = intersectLists(feasible, ev.ranges);
  }
  feasible = mergeRanges(feasible);

  // 无结果时，列出“受限节点”在窗口内各自的可用起始日范围以解释交集：
  // 完全无匹配授权（reason）或可用范围未覆盖整个窗口起始日区间的节点；
  // 全窗口都可用的节点不构成约束，不列出。
  let restrictedNodes = [];
  if (!windowTooShort && feasible.length === 0) {
    restrictedNodes = nodes
      .filter((n) => {
        if (n.reason) return true;
        const rs = n.ranges;
        return !(rs.length === 1 && rs[0].startFrom === loStart && rs[0].startTo === hiStart);
      })
      .map((n) => ({
        materialId: n.materialId,
        title: n.title,
        isRoot: n.isRoot,
        reason: n.reason,
        reasonText: n.reasonText || '窗口内仅部分起始日可用授权覆盖',
        ranges: n.ranges,
      }));
  }

  const result = {
    packageId,
    packageName: pkg.name,
    medium: input.medium,
    region: input.region,
    currentUseFrom: input.useFrom,
    currentUseTo: input.useTo,
    durationDays,
    planFrom: plan.planFrom,
    planTo: plan.planTo,
    basisVersion: basisVersion(db),
    windowTooShort,
    feasible: feasible.length > 0,
    ranges: feasible.map((r) => rangeDTO(r, durationDays)),
    restrictedNodes,
    searchToken: makeSearchToken(db, input, plan, durationDays),
  };
  if (windowTooShort) {
    result.message = `规划窗口 ${plan.planFrom} → ${plan.planTo} 不足 ${durationDays} 天，放不下当前展期（含首尾共 ${durationDays} 天），无可用档期。`;
  } else if (!result.feasible) {
    result.message = '规划窗口内不存在让全部来源链节点同时被同一份匹配授权完整覆盖的起始日；下方列出各受限节点在窗口内的可用起始日范围（交集为空）。';
  }
  return result;
}

/**
 * 选定档期并应用到待发布包：单事务内重验，任一不符即拒绝且不改包。
 * raw: { packageId, useFrom, searchToken: {packageId,basisVersion,fingerprint,planFrom,planTo,durationDays} }
 */
function applySchedule(db, raw) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const packageId = Number(body.packageId);
  if (!Number.isInteger(packageId) || packageId <= 0) throw new ScheduleError(400, '缺少合法的 packageId');
  const token = body.searchToken;
  if (!token || typeof token !== 'object') {
    throw new ScheduleError(400, '缺少搜索令牌 searchToken，请先调用档期搜索');
  }
  const useFrom = str(body.useFrom).trim();
  if (!isValidDate(useFrom)) {
    throw new ScheduleError(400, `选定起始日不合法：${useFrom || '（空）'}（需为 YYYY-MM-DD）`, { code: 'INVALID_DATE' });
  }

  const run = db.transaction(() => {
    const pkg = loadDraftPackage(db, packageId);
    assertDraft(pkg);
    assertSingleStop(db, pkg);

    // 1) 令牌必须属于本包且结构完整
    const tokenPkg = Number(token.packageId);
    if (!Number.isInteger(tokenPkg) || tokenPkg !== packageId) {
      throw new ScheduleError(409, '搜索令牌与目标包不一致，请重新搜索档期',
        { code: 'TOKEN_MISMATCH', tokenPackageId: tokenPkg || null });
    }
    const clientBasis = Number(token.basisVersion);
    const durationDays = Number(token.durationDays);
    if (!Number.isInteger(clientBasis) || !Number.isInteger(durationDays) || durationDays <= 0
      || !isValidDate(str(token.planFrom)) || !isValidDate(str(token.planTo))
      || typeof token.fingerprint !== 'string') {
      throw new ScheduleError(409, '搜索令牌内容不完整或已损坏，请重新搜索档期', { code: 'TOKEN_MISMATCH' });
    }

    // 2) 包状态之外：搜索后授权/来源关系有变化 → 依据版本过期
    const currentBasis = basisVersion(db);
    if (clientBasis !== currentBasis) {
      throw new ScheduleError(409,
        `搜索后授权或来源关系已变更（依据版本 ${clientBasis} → ${currentBasis}），拒绝改期，请重新搜索档期。`,
        { code: 'STALE_BASIS', clientBasis, currentBasis });
    }

    // 3) 搜索后包参数或清单有变化 → 指纹不符
    const items = db
      .prepare('SELECT material_id FROM package_items WHERE package_id=? ORDER BY position, material_id')
      .all(packageId)
      .map((r) => r.material_id);
    const input = packageInput(pkg, items);
    if (input.materialIds.length === 0) {
      throw new ScheduleError(409, '包清单已被清空，拒绝改期，请重新编辑并搜索档期', { code: 'PACKAGE_CHANGED' });
    }
    if (packageFingerprint(input) !== token.fingerprint) {
      throw new ScheduleError(409, '搜索后包参数或素材清单已变更，拒绝改期，请重新搜索档期', { code: 'PACKAGE_CHANGED' });
    }
    assertValidPackage(input); // 结构变化（如清空清单）后兜底

    // 4) 选定档期必须仍落在搜索窗口内，且展期天数与搜索时一致
    const planFrom = str(token.planFrom);
    const planTo = str(token.planTo);
    if (useFrom < planFrom || useFrom > planTo) {
      throw new ScheduleError(409, `选定起始日 ${useFrom} 不在搜索窗口 ${planFrom} → ${planTo} 内，请重新选择`,
        { code: 'SLOT_INVALID', useFrom });
    }
    const useTo = addDays(useFrom, durationDays - 1);
    if (useTo > planTo) {
      throw new ScheduleError(409,
        `选定起始日 ${useFrom} 对应的展期（至 ${useTo}）不能完整落在规划窗口内，档期已失效，请重新搜索`,
        { code: 'SLOT_INVALID', useFrom, useTo });
    }

    // 5) 选定档期失效：按当前数据重验该档期，全部节点须被同一份匹配授权完整覆盖
    const { adj, matById } = checkStructure(db, input.materialIds);
    const nodeIds = collectNodes(adj, input.materialIds);
    const authByMat = new Map();
    for (const a of db.prepare('SELECT * FROM authorizations').all()) {
      if (!authByMat.has(a.material_id)) authByMat.set(a.material_id, []);
      authByMat.get(a.material_id).push(a);
    }
    const failing = [];
    for (const id of nodeIds) {
      const ev = evalNodeWindow(authByMat.get(id) || [], {
        medium: input.medium, region: input.region, loStart: useFrom, hiStart: useFrom, durationDays,
      });
      if (ev.reason || ev.ranges.length === 0) {
        failing.push({
          materialId: id,
          title: matById.get(id).title,
          isRoot: input.materialIds.includes(id),
          reason: ev.reason || 'date',
          reasonText: ev.reason ? REASON_TEXT[ev.reason] : REASON_TEXT.date,
        });
      }
    }
    if (failing.length) {
      throw new ScheduleError(409,
        `选定档期 ${useFrom} → ${useTo} 已失效：${failing.length} 个来源链节点无同一份匹配授权完整覆盖，请重新搜索档期。`,
        { code: 'SLOT_INVALID', useFrom, useTo, failingNodes: failing });
    }

    // 6) 全部重验通过：仅更新展期（保持展期天数不变），不动清单、状态与快照
    db.prepare('UPDATE packages SET use_from=?, use_to=?, updated_at=? WHERE id=?')
      .run(useFrom, useTo, new Date().toISOString(), packageId);

    return {
      packageId,
      useFrom,
      useTo,
      durationDays,
      basisVersion: currentBasis,
    };
  });

  return run();
}

module.exports = {
  ScheduleError,
  searchSchedule,
  applySchedule,
  addDays,
  daysInclusive,
  mergeRanges,
  intersectLists,
  packageFingerprint,
};
