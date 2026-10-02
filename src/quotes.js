'use strict';

// 授权报价组合预览（只读）
//
// 策展人为待发布 / 需复核展览包录入若干“拟取得的授权报价”，每项注明
// 素材、媒介、地区、有效期与非负整数成本。系统基于同一份当前授权与来源
// 关系，求总成本最低的报价组合，使每站每个入展素材及其全部来源节点，均由
//   - 一份现有有效授权，或
//   - 一份所选报价
// 独自覆盖整站整段展期：
//   * 共享节点只核算一次（一份报价可同时覆盖多站 / 多个节点，费用只算一次）；
//   * 同一站同一节点不得用多份短授权（或多份短报价）拼接；
//   * 总成本并列时先取报价数少者，再按输入序号序列取字典序最小。
// 无解时列出仍缺授权的站次、节点与全部来源路径。
//
// 预览不写入授权、包、状态或快照，依据版本不变；已发布包不可预览。
//
// 模型：把“某站某节点当前无现有授权覆盖”视为一个需求，报价是覆盖若干需求
// 的集合，问题即带权集合覆盖（NP-hard）。规模为策展人一次录入的报价数，
// 这里用 单例强制 + 支配消解 + MRV 分支定界 + 记忆化 求精确最优解，
// 超出安全步数上限时明确报错（绝不返回近似方案冒充最优）。

const {
  isValidDate,
  scopeMatches,
  loadGraph,
  collectChains,
  basisVersion,
  loadStops,
  STOP_REASON_TEXT,
  REASON_TEXT,
} = require('./verify');

class QuoteError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const str = (v) => (v === null || v === undefined ? '' : String(v));

// 现有授权对（节点 × 站次）的判定：与 verify.evalNode 同一套规则，
// 返回 null 表示已有一份授权独自覆盖，否则给出失格原因码。
function existingReason(authRows, { medium, region, useFrom, useTo }) {
  if (authRows.length === 0) return 'no_auth';
  const active = authRows.filter((a) => !a.revoked);
  if (active.length === 0) return 'revoked';
  const mediaOk = active.filter((a) => scopeMatches(a.media, medium));
  const regionOk = active.filter((a) => scopeMatches(a.region, region));
  const scopeOk = active.filter((a) => scopeMatches(a.media, medium) && scopeMatches(a.region, region));
  const cover = scopeOk.find((a) => a.valid_from <= useFrom && a.valid_to >= useTo);
  if (cover) return null;
  if (scopeOk.length === 0) {
    if (mediaOk.length === 0 && regionOk.length === 0) return 'media_region';
    if (mediaOk.length === 0) return 'media';
    return 'region';
  }
  return 'date';
}

function quoteMisses(q, { medium, region, useFrom, useTo }) {
  // 报价视为“取得后即有效（未撤销）”；只核验媒介 / 地区 / 有效期三维度。
  const misses = [];
  if (!scopeMatches(q.media, medium)) misses.push('media');
  if (!scopeMatches(q.region, region)) misses.push('region');
  if (!(q.validFrom <= useFrom && q.validTo >= useTo)) misses.push('date');
  return misses;
}

const QUOTE_MISS_TEXT = {
  media: '报价媒介不覆盖该站媒介',
  region: '报价地区不覆盖该站地区',
  date: '报价有效期不能独自覆盖该站整段展期（短报价不可拼接）',
};

// ---------- 输入报价校验（逐行收集全部错误，一次说清） ----------
function normalizeQuotes(db, rawQuotes, matById) {
  if (rawQuotes === undefined || rawQuotes === null) {
    throw new QuoteError(400, '缺少报价列表 quotes（数组；本轮没有任何拟取得报价时请传 []）',
      { code: 'INVALID_QUOTES' });
  }
  if (!Array.isArray(rawQuotes)) {
    throw new QuoteError(400, 'quotes 必须为数组（每项含 materialId/media/region/validFrom/validTo/cost）',
      { code: 'INVALID_QUOTES' });
  }
  const errors = [];
  const quotes = rawQuotes.map((raw, index) => {
    const msgs = [];
    const q = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

    const materialId = Number(q.materialId);
    if (!Number.isInteger(materialId) || materialId <= 0) {
      msgs.push('materialId 缺失或不是正整数');
    } else if (!matById.has(materialId)) {
      msgs.push(`报价指向的素材 #${materialId} 不存在`);
    }

    const media = str(q.media ?? q.medium).trim();
    if (!media) msgs.push('媒介为空（* 表示任意媒介）');
    const region = str(q.region).trim();
    if (!region) msgs.push('地区为空（* 表示任意地区）');

    const validFrom = str(q.validFrom).trim();
    const validTo = str(q.validTo).trim();
    if (!isValidDate(validFrom)) msgs.push(`起始日期不合法：${validFrom || '（空）'}（需为 YYYY-MM-DD）`);
    if (!isValidDate(validTo)) msgs.push(`截止日期不合法：${validTo || '（空）'}（需为 YYYY-MM-DD）`);
    if (isValidDate(validFrom) && isValidDate(validTo) && validFrom > validTo) {
      msgs.push(`有效期起止倒置：${validFrom} 晚于 ${validTo}`);
    }

    // 成本必须是非负整数（拒绝布尔、字符串、小数、负数）
    const cost = q.cost;
    let costOk = false;
    if (typeof cost === 'number' && Number.isInteger(cost) && cost >= 0) costOk = true;
    if (!costOk) msgs.push(`成本不是非负整数：${JSON.stringify(cost)}`);

    if (msgs.length) errors.push({ index, messages: msgs });
    return {
      index,
      materialId: Number.isInteger(materialId) ? materialId : null,
      media,
      region,
      validFrom,
      validTo,
      cost: costOk ? cost : null,
      licensor: str(q.licensor).trim(),
      note: str(q.note).trim(),
    };
  });

  if (errors.length) {
    throw new QuoteError(400,
      `报价预览被拒绝：${errors.length} 项报价字段不合法（已逐项列出，预览未执行、未写入任何数据）`,
      { code: 'INVALID_QUOTES', errors });
  }
  return quotes;
}

// ---------- 来源结构核验：成环 / 超深 / 截断 / 素材缺失一律拒绝预览 ----------
function buildClosure(db, roots, matById) {
  const missing = roots.filter((id) => !matById.has(id));
  if (missing.length) {
    throw new QuoteError(422,
      `来源链无法完整核验：入展素材不存在：#${[...new Set(missing)].join('、#')}，已拒绝预览`,
      { code: 'UNVERIFIABLE', missing: [...new Set(missing)] });
  }
  const adj = loadGraph(db);
  const nodePaths = new Map();
  const nodeIsRoot = new Map();
  const cyclicNodeIds = new Set();
  let truncated = false;
  let anyCycle = false;
  let anyDepth = false;

  for (const root of roots) {
    nodeIsRoot.set(root, true);
    const chains = collectChains(adj, root);
    truncated = truncated || chains.truncated;
    anyDepth = anyDepth || chains.tooDeep;
    for (const id of chains.cyclicNodes) { anyCycle = true; cyclicNodeIds.add(id); }
    for (const [id, paths] of chains.nodePaths) {
      if (!nodePaths.has(id)) nodePaths.set(id, []);
      const list = nodePaths.get(id);
      for (const p of paths) {
        const key = p.join('>');
        if (!list.some((x) => x.join('>') === key)) list.push(p.slice());
      }
    }
  }

  if (anyCycle || anyDepth || truncated) {
    const nodes = [...cyclicNodeIds].sort((a, b) => a - b).map((id) => ({
      materialId: id,
      title: matById.get(id) ? matById.get(id).title : `#${id}`,
    }));
    throw new QuoteError(422,
      '来源链无法完整核验（存在成环、超过最大深度或路径数超过安全上限），已拒绝报价预览；请先简化来源结构后重试。',
      { code: 'UNVERIFIABLE', cyclic: anyCycle, tooDeep: anyDepth, truncated, nodes });
  }

  const nodeIds = [...nodePaths.keys()].sort((a, b) => a - b);
  const pathDTOs = new Map();
  for (const id of nodeIds) {
    const dtos = nodePaths.get(id)
      .map((p) => p.map((pid) => ({
        materialId: pid,
        title: matById.get(pid) ? matById.get(pid).title : `#${pid}（已删除）`,
      })))
      .sort((a, b) => a.map((x) => x.materialId).join('>').localeCompare(b.map((x) => x.materialId).join('>')));
    pathDTOs.set(id, dtos);
  }
  return { adj, nodeIds, nodeIsRoot, pathDTOs };
}

// ---------- 精确求解：带权集合覆盖（单例强制 → 支配消解 → MRV 分支定界 + 记忆化） ----------
const SOLVE_NODE_CAP = 2_000_000;

function lexLess(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

function mergeSorted(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] < b[j]) out.push(a[i++]);
    else out.push(b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

/**
 * 输入：
 *   requirements: [{key, candidates:Set<quoteIndex>}]  当前无现有授权覆盖的需求
 *   quotes:       [{index, cost, covers:Set<reqKey>}]   全部合法报价（含无用报价）
 * 返回 { feasible, selected:Set<quoteIndex>, totalCost } 或 { feasible:false, emptyKeys:Set }
 */
function solveCover(requirements, quotes) {
  const reqByKey = new Map(requirements.map((r) => [r.key, r]));

  // 候选为空的需求：任何报价组合都无法覆盖 → 无解
  const emptyKeys = new Set();
  for (const r of requirements) {
    if (r.candidates.size === 0) emptyKeys.add(r.key);
  }
  if (emptyKeys.size) return { feasible: false, emptyKeys };

  // 需求按“候选报价集合相同”分组：同组需求必然同时被覆盖，压成一个位
  const groupsOf = new Map(); // signature -> keys[]
  for (const r of requirements) {
    const sig = [...r.candidates].sort((a, b) => a - b).join(',');
    if (!groupsOf.has(sig)) groupsOf.set(sig, []);
    groupsOf.get(sig).push(r.key);
  }
  const groupKeys = [...groupsOf.values()];
  const G = groupKeys.length;
  const keyToGroup = new Map();
  groupKeys.forEach((keys, gi) => keys.forEach((k) => keyToGroup.set(k, gi)));

  // 报价 → 覆盖的组位掩码（保留成本与输入序号）
  const qList = [];
  for (const q of quotes) {
    let mask = 0n;
    for (const key of q.covers) {
      if (keyToGroup.has(key)) mask |= 1n << BigInt(keyToGroup.get(key));
    }
    if (mask !== 0n) qList.push({ index: q.index, cost: q.cost, mask });
  }

  // 1) 单例强制：只能由某一份报价覆盖的组，该报价必选；连锁传播
  const forced = new Set();
  let covered = 0n;
  let changed = true;
  while (changed) {
    changed = false;
    for (let gi = 0; gi < G; gi++) {
      const bit = 1n << BigInt(gi);
      if (covered & bit) continue;
      const cands = qList.filter((q) => !(forced.has(q.index)) && (q.mask & bit));
      if (cands.length === 1) {
        forced.add(cands[0].index);
        covered |= cands[0].mask;
        changed = true;
      }
    }
  }

  // 残余问题：未覆盖的组 + 尚未选择的报价
  const residGroups = [];
  for (let gi = 0; gi < G; gi++) {
    if (!(covered & (1n << BigInt(gi)))) residGroups.push(gi);
  }
  if (residGroups.length === 0) {
    let totalCost = 0;
    for (const q of qList) if (forced.has(q.index)) totalCost += q.cost;
    return { feasible: true, selected: forced, totalCost };
  }

  let resid = qList.filter((q) => !forced.has(q.index)).map((q) => {
    let m = 0n;
    residGroups.forEach((gi, ri) => {
      if (q.mask & (1n << BigInt(gi))) m |= 1n << BigInt(ri);
    });
    return { index: q.index, cost: q.cost, mask: m };
  }).filter((q) => q.mask !== 0n);

  // 2) 支配消解（迭代到不动点）。q 支配 q' 的安全情形只有两种：
  //    a) q 覆盖 ⊇ q' 覆盖且成本严格更低（替换后总成本必降）；
  //    b) 覆盖完全相同、成本相同且 q 序号更小（替换后成本/数量不变而字典序更优）。
  //    注意：同成本但 q 覆盖严格超集时【不能】支配——超出部分可能冗余，
  //    而字典序规则可能更偏好序号更小的 q'（见求解器随机对照测试）。
  let removed = true;
  while (removed) {
    removed = false;
    for (let i = 0; i < resid.length && !removed; i++) {
      const qp = resid[i];
      for (let j = 0; j < resid.length; j++) {
        if (i === j) continue;
        const q = resid[j];
        const covers = (q.mask & qp.mask) === qp.mask; // q ⊇ q'
        if (!covers) continue;
        const strictlyBetter = q.cost < qp.cost
          || (q.cost === qp.cost && q.mask === qp.mask && q.index < qp.index);
        if (strictlyBetter) {
          resid.splice(i, 1);
          removed = true;
          break;
        }
      }
    }
  }

  const R = residGroups.length;
  const residFull = (1n << BigInt(R)) - 1n;

  // 每组的候选报价（残余）
  const groupCands = Array.from({ length: R }, (_, ri) => {
    const bit = 1n << BigInt(ri);
    return resid.filter((q) => q.mask & bit);
  });

  // 下界：打包（packing）下界——挑选候选报价集两两互不相交的未覆盖组，
  // 每组取最便宜候选；这些组只能由不同报价分别覆盖，故成本之和对
  // “覆盖剩余组所需最小成本”是合法乐观下界（前缀无关，可安全记忆化）。
  function lowerBound(mask) {
    let lb = 0;
    const used = new Set();
    for (let ri = 0; ri < R; ri++) {
      if (mask & (1n << BigInt(ri))) continue;
      const cands = groupCands[ri];
      if (cands.some((q) => used.has(q.index))) continue; // 与已计入组共享候选报价，跳过
      let min = cands[0];
      for (const q of cands) {
        if (q.cost < min.cost || (q.cost === min.cost && q.index < min.index)) min = q;
      }
      lb += min.cost;
      for (const q of cands) used.add(q.index);
    }
    return lb;
  }

  // 3) 记忆化分支定界。同一覆盖位形的最优后缀与到达路径无关：
  //    此前已选报价在该位形下只覆盖已覆盖组，永不会再被最优后缀选中。
  //    记忆只缓存后缀最优 (成本, 数量, 字典序)；不使用全局现任解剪枝，
  //    以保证记忆结果前缀无关；等成本时继续搜索（数量 / 字典序可能更优）。
  const memo = new Map(); // mask -> {cost,count,lex}
  let nodes = 0;

  function dfs(mask) {
    if (++nodes > SOLVE_NODE_CAP) {
      throw new QuoteError(422,
        `报价组合求解超过安全步数上限（${SOLVE_NODE_CAP} 步），为避免返回非最优方案已终止；请精简报价数量后重试。`,
        { code: 'SOLVE_LIMIT', nodeCount: nodes });
    }
    if (mask === residFull) return { cost: 0, count: 0, lex: [] };
    if (memo.has(mask)) return memo.get(mask);

    // MRV：候选报价最少的未覆盖组先分支（只统计还能新增覆盖的报价）
    let pickCands = null;
    for (let ri = 0; ri < R; ri++) {
      if (mask & (1n << BigInt(ri))) continue;
      const cands = groupCands[ri].filter((q) => q.mask & ~mask);
      if (pickCands === null || cands.length < pickCands.length) {
        pickCands = cands;
        if (cands.length === 1) break;
      }
    }

    // 分支顺序：成本升序、再输入序号升序（更快拿到优质现任后缀）
    pickCands.sort((a, b) => (a.cost - b.cost) || (a.index - b.index));

    let best = null;
    for (const q of pickCands) {
      // 前缀无关的安全剪枝：该分支总成本下界 = q.cost + 打包下界(submask)。
      // 严格大于当前局部最优时可剪；等成本必须继续（报价数可能更少、字典序可能更优）。
      if (best !== null) {
        const subMask = mask | q.mask;
        if (subMask !== residFull && q.cost + lowerBound(subMask) > best.cost) continue;
        if (subMask === residFull && q.cost > best.cost) continue;
        // 候选按成本升序：当前报价成本已高于局部最优成本，后续报价只会更贵
        if (q.cost > best.cost) break;
      }
      const sub = dfs(mask | q.mask);
      if (!sub) continue;
      const cand = { cost: q.cost + sub.cost, count: 1 + sub.count, lex: mergeSorted([q.index], sub.lex) };
      if (!best || cand.cost < best.cost
        || (cand.cost === best.cost && (cand.count < best.count
          || (cand.count === best.count && lexLess(cand.lex, best.lex))))) {
        best = cand;
      }
    }
    memo.set(mask, best);
    return best;
  }

  const suffix = dfs(0n);
  if (!suffix) return { feasible: false, emptyKeys };

  const selected = new Set(forced);
  for (const idx of suffix.lex) selected.add(idx);
  let totalCost = suffix.cost;
  for (const q of qList) if (forced.has(q.index)) totalCost += q.cost;
  return { feasible: true, selected, totalCost };
}

// ---------- 主入口 ----------
/**
 * 报价预览（只读）。
 * raw: { quotes: [...] }
 */
function previewQuotes(db, packageId, rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(packageId);
  if (!pkg) throw new QuoteError(404, '展览包不存在');
  if (pkg.status === 'published') {
    throw new QuoteError(409, '已发布包不可预览授权报价（报价预览仅用于待发布 / 需复核包）',
      { code: 'PACKAGE_PUBLISHED', status: pkg.status });
  }

  const roots = db
    .prepare('SELECT material_id FROM package_items WHERE package_id=? ORDER BY position, material_id')
    .all(packageId)
    .map((r) => r.material_id);
  if (roots.length === 0) {
    throw new QuoteError(400, '空展览包：尚未选取任何入展素材，无法预览报价方案', { code: 'EMPTY_PACKAGE' });
  }

  // 站次：多站取 package_stops；单站用包顶层字段构造唯一一站
  const stopRows = loadStops(db, packageId);
  const multiStop = stopRows.length >= 2;
  let stops;
  if (multiStop) {
    stops = stopRows.map((s, i) => ({
      position: i,
      name: s.name,
      medium: s.medium,
      region: s.region,
      useFrom: s.useFrom,
      useTo: s.useTo,
    }));
    const stopErrors = [];
    for (let i = 1; i < stops.length; i++) {
      const prev = stops[i - 1];
      const cur = stops[i];
      if (cur.useFrom <= prev.useTo) {
        stopErrors.push(`第 ${i} 站「${prev.name}」与第 ${i + 1} 站「${cur.name}」展期重叠`);
      }
    }
    if (stopErrors.length) {
      throw new QuoteError(409, stopErrors.join('；'), { code: 'STOPS_OVERLAP' });
    }
  } else {
    const medium = str(pkg.medium).trim();
    const region = str(pkg.region).trim();
    const useFrom = pkg.use_from || '';
    const useTo = pkg.use_to || '';
    const errs = [];
    if (!medium) errs.push('包缺少展示媒介');
    if (!region) errs.push('包缺少展示地区');
    if (!isValidDate(useFrom)) errs.push(`包起始日期不合法：${useFrom || '（空）'}`);
    if (!isValidDate(useTo)) errs.push(`包截止日期不合法：${useTo || '（空）'}`);
    if (isValidDate(useFrom) && isValidDate(useTo) && useFrom > useTo) errs.push('包起止日期倒置');
    if (errs.length) {
      throw new QuoteError(400, `包参数不合法，无法预览报价：${errs.join('；')}`, { code: 'INVALID_PACKAGE', errors: errs });
    }
    stops = [{ position: 0, name: pkg.name, medium, region, useFrom, useTo }];
  }

  const matRows = db.prepare('SELECT id, title, kind FROM materials').all();
  const matById = new Map(matRows.map((m) => [m.id, m]));

  // 报价逐行校验（引用不存在素材 / 缺字段 / 坏日期 / 成本非法都在此拒绝）
  const quotes = normalizeQuotes(db, body.quotes, matById);

  // 来源结构必须可完整核验，否则拒绝预览
  const { nodeIds, nodeIsRoot, pathDTOs } = buildClosure(db, roots, matById);

  const allAuth = db.prepare('SELECT * FROM authorizations').all();
  const authByMat = new Map();
  for (const a of allAuth) {
    if (!authByMat.has(a.material_id)) authByMat.set(a.material_id, []);
    authByMat.get(a.material_id).push(a);
  }

  // 逐站逐节点：现有授权能否独自覆盖；不能则生成需求并匹配候选报价
  const requirements = [];
  const existingCovered = []; // {stopPosition, materialId, authorizationId}
  const nodeEval = new Map(); // `${stopPosition}:${materialId}` -> {existingReason, quoteMissByIdx}
  let gapCount = 0;

  for (const st of stops) {
    for (const id of nodeIds) {
      const rows = authByMat.get(id) || [];
      const reason = existingReason(rows, st);
      const key = `${st.position}:${id}`;
      const evalEntry = { existingReason: reason, quoteMissByIdx: new Map() };
      nodeEval.set(key, evalEntry);
      if (reason === null) {
        const cover = rows
          .filter((a) => !a.revoked && scopeMatches(a.media, st.medium) && scopeMatches(a.region, st.region))
          .find((a) => a.valid_from <= st.useFrom && a.valid_to >= st.useTo);
        existingCovered.push({ stopPosition: st.position, materialId: id, authorizationId: cover ? cover.id : null });
        continue;
      }
      const candidates = new Set();
      for (const q of quotes) {
        if (q.materialId !== id) continue;
        const misses = quoteMisses(q, st);
        evalEntry.quoteMissByIdx.set(q.index, misses);
        if (misses.length === 0) candidates.add(q.index);
      }
      requirements.push({ key, stopPosition: st.position, materialId: id, candidates });
      if (candidates.size === 0) gapCount++;
    }
  }

  const quoteByIndex = new Map(quotes.map((q) => [q.index, q]));
  const quoteCovers = new Map(quotes.map((q) => [q.index, new Set()]));
  for (const r of requirements) {
    for (const idx of r.candidates) quoteCovers.get(idx).add(r.key);
  }
  const coverQuotes = quotes.map((q) => ({ index: q.index, cost: q.cost, covers: quoteCovers.get(q.index) }));

  const solution = requirements.length === 0
    ? { feasible: true, selected: new Set(), totalCost: 0 }
    : solveCover(requirements, coverQuotes);

  const base = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    basisVersion: basisVersion(db),
    packageId: pkg.id,
    packageName: pkg.name,
    multiStop,
    stopCount: multiStop ? stops.length : 1,
    status: pkg.status,
    request: {
      quotes: quotes.map((q) => ({
        index: q.index, materialId: q.materialId, media: q.media, region: q.region,
        validFrom: q.validFrom, validTo: q.validTo, cost: q.cost,
        licensor: q.licensor || null, note: q.note || null,
      })),
    },
    stats: {
      rootCount: roots.length,
      nodeCount: nodeIds.length,
      stopCount: stops.length,
      requirementCount: requirements.length,
      existingCoveredCount: existingCovered.length,
      quoteCount: quotes.length,
      gapCount,
    },
  };

  if (!solution.feasible) {
    // 无解：按站列出仍缺授权的节点、现有授权失格原因、各报价为何不覆盖与全部来源路径
    const emptyKeys = solution.emptyKeys;
    const gaps = [];
    for (const st of stops) {
      const nodes = [];
      for (const id of nodeIds) {
        const key = `${st.position}:${id}`;
        if (!emptyKeys.has(key)) continue;
        const ev = nodeEval.get(key);
        const nodeQuotes = quotes.filter((q) => q.materialId === id);
        const quoteFailures = nodeQuotes.map((q) => ({
          index: q.index,
          media: q.media,
          region: q.region,
          validFrom: q.validFrom,
          validTo: q.validTo,
          cost: q.cost,
          misses: ev.quoteMissByIdx.get(q.index) || [],
          missText: (ev.quoteMissByIdx.get(q.index) || []).map((c) => QUOTE_MISS_TEXT[c] || c),
        }));
        nodes.push({
          materialId: id,
          title: matById.get(id).title,
          kind: matById.get(id).kind,
          isRoot: nodeIsRoot.get(id) === true,
          existingReason: ev.existingReason,
          existingReasonText: STOP_REASON_TEXT[ev.existingReason] || REASON_TEXT[ev.existingReason] || ev.existingReason,
          noQuoteForNode: nodeQuotes.length === 0,
          quoteFailures,
          paths: pathDTOs.get(id),
        });
      }
      if (nodes.length) {
        gaps.push({
          position: st.position,
          name: st.name,
          medium: st.medium,
          region: st.region,
          useFrom: st.useFrom,
          useTo: st.useTo,
          missingCount: nodes.length,
          nodes: nodes.sort((a, b) => a.materialId - b.materialId),
        });
      }
    }
    return {
      ...base,
      feasible: false,
      totalCost: null,
      quoteCountSelected: 0,
      selectedQuotes: [],
      message: '不存在能补齐全部站次全部来源节点的报价组合：以下站次仍缺授权（已列出节点、现有授权/各报价的失格原因与全部来源路径）。预览未写入任何数据。',
      gaps,
    };
  }

  // 可行：确定每个无现有授权需求由哪一份选中报价覆盖（同价取序号小者，保证确定性）
  const selectedQuotes = [];
  for (const idx of [...solution.selected].sort((a, b) => a - b)) {
    const q = quoteByIndex.get(idx);
    const covers = [];
    for (const key of [...quoteCovers.get(idx)].sort()) {
      const [posStr, matStr] = key.split(':');
      covers.push({ stopPosition: Number(posStr), materialId: Number(matStr) });
    }
    selectedQuotes.push({
      index: q.index,
      materialId: q.materialId,
      materialTitle: matById.get(q.materialId).title,
      media: q.media,
      region: q.region,
      validFrom: q.validFrom,
      validTo: q.validTo,
      cost: q.cost,
      licensor: q.licensor || null,
      note: q.note || null,
      coverCount: covers.length,
      covers: covers.map((c) => ({
        ...c,
        stopName: stops[c.stopPosition].name,
        materialTitle: matById.get(c.materialId).title,
      })),
    });
  }

  const coverage = stops.map((st) => ({
    position: st.position,
    name: st.name,
    medium: st.medium,
    region: st.region,
    useFrom: st.useFrom,
    useTo: st.useTo,
    nodes: nodeIds.map((id) => {
      const key = `${st.position}:${id}`;
      const ev = nodeEval.get(key);
      let coveredBy;
      if (ev.existingReason === null) {
        const hit = existingCovered.find((e) => e.stopPosition === st.position && e.materialId === id);
        coveredBy = { kind: 'existing', authorizationId: hit.authorizationId };
      } else {
        const choices = [...solution.selected]
          .filter((idx) => quoteCovers.get(idx).has(key))
          .map((idx) => quoteByIndex.get(idx))
          .sort((a, b) => (a.cost - b.cost) || (a.index - b.index));
        const q = choices[0];
        coveredBy = { kind: 'quote', quoteIndex: q.index, cost: q.cost };
      }
      return {
        materialId: id,
        title: matById.get(id).title,
        kind: matById.get(id).kind,
        isRoot: nodeIsRoot.get(id) === true,
        coveredBy,
      };
    }),
  }));

  return {
    ...base,
    feasible: true,
    totalCost: solution.totalCost,
    quoteCountSelected: solution.selected.size,
    selectedQuotes,
    unselectedQuotes: quotes
      .filter((q) => !solution.selected.has(q.index))
      .map((q) => ({
        index: q.index,
        materialId: q.materialId,
        materialTitle: matById.get(q.materialId).title,
        media: q.media,
        region: q.region,
        validFrom: q.validFrom,
        validTo: q.validTo,
        cost: q.cost,
        coverCount: quoteCovers.get(q.index).size,
      })),
    coverage,
    message: solution.selected.size === 0
      ? '无需取得任何报价：现有授权已覆盖全部站次的全部来源链节点（总成本 0）。预览未写入任何数据。'
      : `最优方案：选取 ${solution.selected.size} 项报价，总成本 ${solution.totalCost}（共享节点只核算一次；同成本已按报价数、序号序列取最优）。预览未写入任何数据。`,
  };
}

module.exports = {
  QuoteError,
  previewQuotes,
  solveCover,
  existingReason,
  normalizeQuotes,
};
