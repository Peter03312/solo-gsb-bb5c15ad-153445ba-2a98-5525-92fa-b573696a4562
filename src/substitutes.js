'use strict';

// 替代素材方案：预览（只读） / 确认（单事务原子应用）
//
// 策展人可为【待发布】包中至多 6 件入展素材分别指定 1～8 件现有替代素材；
// 未指定的素材保持不变。整次请求只要出现以下任一情况即被整体拒绝（不落任何数据）：
//   - 重复编号（同一原素材出现多次；同一素材在同一候选组内重复）
//   - 非包内原素材（被替代 materialId 不在当前清单中）
//   - 不存在的候选（候选 materialId 在素材表中不存在）
//
// 预览对“每件原素材及其候选中恰选一件”的全部组合枚举：按替换后的去重清单
// （沿原清单顺序首次出现去重，再按 id 升序作为入展根集合）重算完整来源链与
// 单站/多站逐站授权资格。仅全站合格的方案可选，裁决顺序：
//   1) 替换件数最少；
//   2) 最终去重清单（id 升序）字典序最小；
//   3) 原清单顺序上每件原素材的选中编号（原素材=0，候选按提交顺序 1..8）字典序最小。
// 无解时返回【当前清单】的逐站缺口，不修改包。
//
// 确认在同一事务内核对：包仍为待发布、依据版本/清单指纹/行程指纹未变、令牌完整、
// 候选仍存在，并由服务端按同一输入重算最优方案与令牌比对、再次整站核验；
// 过期 / 输入不符 / 重算失格均整体拒绝，不部分修改。

const crypto = require('crypto');
const {
  isValidDate,
  loadGraph,
  collectChains,
  verifyPackage,
  verifyMultiStop,
  loadStops,
  normalizeStop,
  stopFieldErrors,
  stopOverlapErrors,
  basisVersion,
} = require('./verify');
const { existingReason } = require('./quotes');

class SubstituteError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const MAX_ENTRIES = 6;
const MAX_CANDIDATES = 8;

const str = (v) => (v === null || v === undefined ? '' : String(v));

// ---------- 指纹 ----------
function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// 清单指纹：入展素材 id 升序的确定性哈希
function listFingerprint(sortedMaterialIds) {
  return sha256({ materialIds: [...sortedMaterialIds].sort((a, b) => a - b) });
}

// 行程指纹：单站取包顶层媒介/地区/展期；多站取按 position 排序的完整站次
function itineraryFingerprint(pkg, stopRows) {
  if (stopRows.length >= 2) {
    return sha256({
      multiStop: true,
      stops: stopRows.map((s) => ({
        name: s.name,
        medium: s.medium,
        region: s.region,
        useFrom: s.useFrom ?? s.use_from,
        useTo: s.useTo ?? s.use_to,
      })),
    });
  }
  return sha256({
    multiStop: false,
    medium: pkg.medium,
    region: pkg.region,
    useFrom: pkg.use_from,
    useTo: pkg.use_to,
  });
}

// ---------- 包 / 行程载入与校验 ----------
// 返回 { pkg, origins(原清单顺序 materialId[]), stopRows, multiStop, stops(核验入参) }
function loadDraftContext(db, packageId) {
  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(packageId);
  if (!pkg) throw new SubstituteError(404, '展览包不存在');
  if (pkg.status !== 'draft') {
    throw new SubstituteError(409,
      `当前状态为 ${pkg.status}：替代素材方案仅适用于待发布包；已发布/需复核包的清单已冻结，请使用「复制为待发布包」。`,
      { code: 'NOT_DRAFT', status: pkg.status });
  }

  const itemRows = db
    .prepare('SELECT material_id, position FROM package_items WHERE package_id=? ORDER BY position, material_id')
    .all(packageId);
  const origins = itemRows.map((r) => r.material_id);
  if (origins.length === 0) {
    throw new SubstituteError(400, '空展览包：尚未选取任何入展素材，无法编排替代素材方案', { code: 'EMPTY_PACKAGE' });
  }

  const stopRows = loadStops(db, packageId);
  const multiStop = stopRows.length >= 2;
  let stops;
  if (multiStop) {
    stops = stopRows.map((s, i) => normalizeStop({
      name: s.name, media: s.medium, region: s.region, useFrom: s.useFrom, useTo: s.useTo,
    }, i));
    const fieldErrors = stops.flatMap((s) => stopFieldErrors(s));
    if (fieldErrors.length) {
      throw new SubstituteError(400, `多站行程字段不合法，无法编排替代方案：${fieldErrors.join('；')}`,
        { code: 'INVALID_STOPS', errors: fieldErrors });
    }
    const overlap = stopOverlapErrors(stops);
    if (overlap.length) {
      throw new SubstituteError(409, overlap.join('；'), { code: 'STOPS_OVERLAP', errors: overlap });
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
      throw new SubstituteError(400, `包参数不合法，无法编排替代素材方案：${errs.join('；')}`,
        { code: 'INVALID_PACKAGE', errors: errs });
    }
    stops = [normalizeStop({ name: pkg.name, media: medium, region, useFrom, useTo }, 0)];
  }

  return { pkg, origins, stopRows, multiStop, stops };
}

// ---------- 输入校验（逐组收集全部错误，一次说清；任一错误整次拒绝） ----------
/**
 * rawBody.substitutions: [{ materialId, candidateIds:[...] }]
 * origins：当前包原清单（按原顺序）。
 * 返回按【原清单顺序】排好的归一化条目：
 *   [{ position, materialId, candidateIds:[1..8 件，保留提交顺序] }]
 */
function validateSpec(rawBody, origins, matById) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const rawList = body.substitutions;
  if (rawList === undefined || rawList === null) {
    throw new SubstituteError(400, '缺少 substitutions（数组；每项 {materialId, candidateIds}；本轮不替换任何素材时传 []）',
      { code: 'INVALID_SUBSTITUTIONS' });
  }
  if (!Array.isArray(rawList)) {
    throw new SubstituteError(400, 'substitutions 必须为数组（每项含 materialId 与 1～8 个 candidateIds）',
      { code: 'INVALID_SUBSTITUTIONS' });
  }
  if (rawList.length > MAX_ENTRIES) {
    throw new SubstituteError(400, `一次至多为 ${MAX_ENTRIES} 件入展素材指定替代素材（当前 ${rawList.length} 件），已整次拒绝`,
      { code: 'INVALID_SUBSTITUTIONS', errors: [{ field: 'substitutions', message: `条目数 ${rawList.length} 超过上限 ${MAX_ENTRIES}` }] });
  }

  const originSet = new Set(origins);
  const originPosition = new Map(origins.map((id, i) => [id, i]));
  const errors = [];
  const seenOrigin = new Set();
  const normalized = [];

  rawList.forEach((raw, index) => {
    const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const mid = Number(entry.materialId);
    if (!Number.isInteger(mid) || mid <= 0) {
      errors.push({ index, field: 'materialId', message: `第 ${index + 1} 组 materialId 缺失或不是正整数` });
      return; // 该组无法继续定位，后续校验无意义
    }
    if (!originSet.has(mid)) {
      errors.push({ index, field: 'materialId', message: `第 ${index + 1} 组原素材 #${mid} 不在包内入展清单中（只能替换包内原素材）` });
    }
    if (seenOrigin.has(mid)) {
      errors.push({ index, field: 'materialId', message: `原素材 #${mid} 重复编号：每件原素材至多给出一组替代候选` });
    }
    seenOrigin.add(mid);

    const candsRaw = entry.candidateIds;
    if (!Array.isArray(candsRaw) || candsRaw.length < 1) {
      errors.push({ index, field: 'candidateIds', message: `第 ${index + 1} 组（原素材 #${mid}）候选不能为空：至少指定 1 件替代素材` });
      return;
    }
    if (candsRaw.length > MAX_CANDIDATES) {
      errors.push({ index, field: 'candidateIds',
        message: `第 ${index + 1} 组（原素材 #${mid}）候选 ${candsRaw.length} 件，超过上限 ${MAX_CANDIDATES} 件` });
      return;
    }

    const candIds = [];
    const seenCand = new Set();
    candsRaw.forEach((c, ci) => {
      const cid = Number(c);
      if (!Number.isInteger(cid) || cid <= 0) {
        errors.push({ index, field: 'candidateIds', message: `第 ${index + 1} 组第 ${ci + 1} 个候选编号不是正整数：${JSON.stringify(c)}` });
        return;
      }
      if (cid === mid) {
        errors.push({ index, field: 'candidateIds', message: `第 ${index + 1} 组候选 #${cid} 与原素材相同（原素材本身即“不替换”选项，无需列为候选）` });
      }
      if (seenCand.has(cid)) {
        errors.push({ index, field: 'candidateIds', message: `第 ${index + 1} 组候选 #${cid} 重复编号：同组候选不得重复` });
      }
      seenCand.add(cid);
      if (!matById.has(cid)) {
        errors.push({ index, field: 'candidateIds', message: `候选素材 #${cid} 不存在` });
      }
      candIds.push(cid);
    });

    if (errors.length === 0 || originSet.has(mid)) {
      normalized.push({
        position: originPosition.has(mid) ? originPosition.get(mid) : null,
        materialId: mid,
        candidateIds: candIds,
      });
    }
  });

  if (errors.length) {
    throw new SubstituteError(400,
      `替代素材请求被整次拒绝：${errors.length} 处编号/候选不合法（已逐组列出，未做任何修改）`,
      { code: 'INVALID_SUBSTITUTIONS', errors });
  }

  // 按原清单顺序排列（选中编号的并列裁决以原清单顺序为准）
  normalized.sort((a, b) => a.position - b.position);
  return normalized;
}

// ---------- 来源闭包 / 逐站授权预计算 ----------
// 为“原素材 ∪ 全部候选”中每个可能的根素材预算：
//   structuralOk：该根的来源遍历可完整核验（无环 / 不超深 / 路径未截断 / 素材存在）
//   closureMask ：该根全部来源节点（含自身）在全局节点位索引上的位掩码
// 再为每一站预算每个节点“是否已有一份未撤销授权独自覆盖整段展期”的位掩码。
function precompute(db, possibleRoots, stops) {
  const matRows = db.prepare('SELECT id, title, kind FROM materials').all();
  const matById = new Map(matRows.map((m) => [m.id, m]));
  const adj = loadGraph(db);

  const rootInfo = new Map();
  const nodeIndex = new Map();
  const bitOf = (id) => {
    if (!nodeIndex.has(id)) nodeIndex.set(id, BigInt(nodeIndex.size));
    return 1n << nodeIndex.get(id);
  };

  for (const root of possibleRoots) {
    if (!matById.has(root)) {
      rootInfo.set(root, { exists: false, structuralOk: false, closureMask: 0n });
      continue;
    }
    const chains = collectChains(adj, root);
    let mask = 0n;
    for (const id of chains.nodePaths.keys()) mask |= bitOf(id);
    // 与 verifyPackage/verifyMultiStop 的合格判定完全一致：
    // 遍历截断 / 超深 / 到达环上节点均按不合格处理（不漏判放行）
    const structuralOk = !chains.truncated && !chains.tooDeep && chains.cyclicNodes.size === 0;
    rootInfo.set(root, { exists: true, structuralOk, closureMask: mask });
  }

  const authRows = db.prepare('SELECT * FROM authorizations').all();
  const authByMat = new Map();
  for (const a of authRows) {
    if (!authByMat.has(a.material_id)) authByMat.set(a.material_id, []);
    authByMat.get(a.material_id).push(a);
  }

  const coverMasks = stops.map((st) => {
    let mask = 0n;
    for (const id of nodeIndex.keys()) {
      const rows = authByMat.get(id) || [];
      if (existingReason(rows, st) === null) mask |= bitOf(id);
    }
    return mask;
  });

  return { matById, rootInfo, coverMasks };
}

function lexLess(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

// ---------- 枚举全部“恰选一件”方案并按三级准则取最优 ----------
/**
 * slots：原清单顺序，每项 { materialId, choices:[self, cand1, ...], isEntry }
 * 仅 isEntry 槽位计入替换件数（choiceIndex>0 时 +1）。
 * 返回 { feasible, best }；best = { choices:[idx per slot], applied:[{materialId,choiceIndex,isEntry}],
 *        finalOrdered:[ids 去重首现], finalSorted:[ids], replacementCount }
 */
function enumerateBest(slots, rootInfo, coverMasks) {
  const S = slots.length;
  let considered = 0;
  let best = null;

  const choice = new Array(S).fill(0);

  function planOk(applied) {
    let union = 0n;
    const seen = new Set();
    const ordered = [];
    for (const a of applied) {
      const info = rootInfo.get(a.materialId);
      if (!info || !info.exists || !info.structuralOk) return null;
      if (!seen.has(a.materialId)) {
        seen.add(a.materialId);
        ordered.push(a.materialId);
        union |= info.closureMask;
      }
    }
    for (const cm of coverMasks) {
      if ((union & cm) !== union) return null; // 某站存在未被任何一份授权独自覆盖的节点
    }
    return ordered;
  }

  function rec(i, applied, replacementCount) {
    if (i === S) {
      considered++;
      const ordered = planOk(applied);
      if (ordered === null) return;
      const finalSorted = [...ordered].sort((a, b) => a - b);
      // 原清单顺序上，“可替换槽位”的选中编号序列（0=保持原素材，1..=候选）
      const entryChoices = [];
      for (let k = 0; k < S; k++) if (slots[k].isEntry) entryChoices.push(choice[k]);
      const cand = { finalSorted, replacementCount, entryChoices };
      if (best === null
        || replacementCount < best.replacementCount
        || (replacementCount === best.replacementCount
          && (lexLess(finalSorted, best.finalSorted)
            || (finalSorted.join() === best.finalSorted.join() && lexLess(entryChoices, best.entryChoices))))) {
        best = { ...cand, ordered, choices: choice.slice() };
      }
      return;
    }
    const slot = slots[i];
    for (let c = 0; c < slot.choices.length; c++) {
      choice[i] = c;
      const isReplace = slot.isEntry && c > 0;
      applied.push({ materialId: slot.choices[c], choiceIndex: c, isEntry: slot.isEntry });
      rec(i + 1, applied, replacementCount + (isReplace ? 1 : 0));
      applied.pop();
    }
  }

  rec(0, [], 0);
  return { best, consideredPlans: considered };
}

// 用既有核验引擎对替换后的去重清单做一次完整重算（单站 / 多站逐站）
function fullVerify(db, ctx, finalSorted) {
  if (ctx.multiStop) {
    return verifyMultiStop(db, {
      materialIds: finalSorted,
      stops: ctx.stopRows.map((s) => ({
        name: s.name, medium: s.medium, region: s.region, useFrom: s.useFrom, useTo: s.useTo,
      })),
    });
  }
  const p = ctx.pkg;
  return verifyPackage(db, {
    materialIds: finalSorted,
    medium: p.medium,
    region: p.region,
    useFrom: p.use_from,
    useTo: p.use_to,
  });
}

// 从完整核验结果抽出统一的逐站摘要（单站/多站一致）
function stopSummaries(result, ctx) {
  if (ctx.multiStop) {
    return result.stops.map((s) => ({
      position: s.position,
      name: s.name,
      medium: s.medium,
      region: s.region,
      useFrom: s.useFrom,
      useTo: s.useTo,
      eligible: s.eligible,
      nodeCount: s.stats.nodeCount,
      failingNodeCount: s.stats.failingCount,
      failingNodes: s.failingNodes,
    }));
  }
  return [{
    position: 0,
    name: ctx.pkg.name,
    medium: str(ctx.pkg.medium).trim(),
    region: str(ctx.pkg.region).trim(),
    useFrom: ctx.pkg.use_from,
    useTo: ctx.pkg.use_to,
    eligible: result.eligible,
    nodeCount: result.stats.nodeCount,
    failingNodeCount: result.stats.failingCount,
    failingNodes: result.failingNodes,
  }];
}

// ---------- 令牌 ----------
function buildApplyToken(db, ctx, spec, best) {
  const selection = [];
  let si = 0;
  ctx.origins.forEach((mid, position) => {
    if (si < spec.length && spec[si].position === position) {
      const entry = spec[si++];
      const ci = best.choices[position];
      const selectedMaterialId = ci === 0 ? mid : entry.candidateIds[ci - 1];
      selection.push({ position, materialId: mid, choiceIndex: ci, selectedMaterialId });
    }
  });
  return {
    packageId: ctx.pkg.id,
    basisVersion: basisVersion(db),
    listFingerprint: listFingerprint(ctx.origins),
    itineraryFingerprint: itineraryFingerprint(ctx.pkg, ctx.stopRows),
    substitutions: spec.map((e) => ({ position: e.position, materialId: e.materialId, candidateIds: e.candidateIds.slice() })),
    selection,
    finalMaterialIds: best.finalSorted.slice(),
    replacementCount: best.replacementCount,
  };
}

// ---------- 主入口：预览（只读） ----------
function previewSubstitutions(db, packageId, rawBody) {
  const ctx = loadDraftContext(db, packageId);
  const matRows = db.prepare('SELECT id, title, kind FROM materials').all();
  const matById = new Map(matRows.map((m) => [m.id, m]));
  const spec = validateSpec(rawBody, ctx.origins, matById);

  // 原清单顺序构造槽位：可替换组 [原素材, 候选1..]，其余槽位固定为自身
  const entryByPos = new Map(spec.map((e) => [e.position, e]));
  const slots = ctx.origins.map((mid, position) => {
    const entry = entryByPos.get(position);
    return entry
      ? { materialId: mid, choices: [mid, ...entry.candidateIds], isEntry: true }
      : { materialId: mid, choices: [mid], isEntry: false };
  });

  const possibleRoots = [...new Set(slots.flatMap((s) => s.choices))].sort((a, b) => a - b);
  const pre = precompute(db, possibleRoots, ctx.stops);
  const { best, consideredPlans } = enumerateBest(slots, pre.rootInfo, pre.coverMasks);

  const origListFp = listFingerprint(ctx.origins);
  const itinFp = itineraryFingerprint(ctx.pkg, ctx.stopRows);
  const specEcho = spec.map((e) => ({
    position: e.position,
    materialId: e.materialId,
    materialTitle: matById.get(e.materialId) ? matById.get(e.materialId).title : null,
    candidates: e.candidateIds.map((cid) => ({
      materialId: cid,
      title: matById.get(cid) ? matById.get(cid).title : null,
    })),
    choiceCount: e.candidateIds.length,
  }));

  const base = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    packageId: ctx.pkg.id,
    packageName: ctx.pkg.name,
    multiStop: ctx.multiStop,
    stopCount: ctx.multiStop ? ctx.stopRows.length : 1,
    basisVersion: basisVersion(db),
    originalMaterialIds: [...ctx.origins].sort((a, b) => a - b),
    originalListFingerprint: origListFp,
    itineraryFingerprint: itinFp,
    substitutions: specEcho,
    consideredPlans,
  };

  // 无解：返回【当前清单】的逐站缺口，不修改包、不下发确认令牌
  if (!best) {
    const current = fullVerify(db, ctx, [...ctx.origins].sort((a, b) => a - b));
    return {
      ...base,
      feasible: false,
      message: consideredPlans === 1
        ? '当前清单本身即不合格，且未指定任何替代素材：以下为当前清单的逐站缺口。包未被修改。'
        : `枚举的 ${consideredPlans} 种替换方案中不存在让全部站次整段覆盖合格的方案：以下为当前清单（不替换）的逐站缺口，可据此调整候选后重试。包未被修改。`,
      current,
      stops: stopSummaries(current, ctx),
    };
  }

  const result = fullVerify(db, ctx, best.finalSorted);
  if (!result.eligible) {
    // 防御性分支：预计算与核验引擎同源，正常不会到达；到达时按无解处理，绝不下发令牌
    const current = fullVerify(db, ctx, [...ctx.origins].sort((a, b) => a - b));
    return {
      ...base,
      feasible: false,
      message: '重算选定方案时未能确认全站合格，已按无解处理且不修改包；请重新预览。',
      current,
      stops: stopSummaries(current, ctx),
    };
  }

  // 替换明细：先按原清单顺序逐槽确定选中素材（用于首次出现去重说明）
  const chosenAt = ctx.origins.map((mid) => mid); // 每个槽位最终选中的 materialId
  const replacements = [];
  const selection = [];
  let si = 0;
  ctx.origins.forEach((mid, position) => {
    if (si < spec.length && spec[si].position === position) {
      const entry = spec[si++];
      const ci = best.choices[position];
      const selectedMaterialId = ci === 0 ? mid : entry.candidateIds[ci - 1];
      chosenAt[position] = selectedMaterialId;
      selection.push({
        position,
        materialId: mid,
        materialTitle: matById.get(mid).title,
        choiceIndex: ci,
        selectedMaterialId,
        selectedTitle: matById.get(selectedMaterialId) ? matById.get(selectedMaterialId).title : null,
        replaced: ci > 0,
      });
      if (ci > 0) {
        replacements.push({
          position,
          choiceIndex: ci,
          from: { materialId: mid, title: matById.get(mid).title },
          to: { materialId: selectedMaterialId, title: matById.get(selectedMaterialId).title },
        });
      }
    }
  });

  const finalItems = best.ordered.map((mid) => ({
    materialId: mid,
    title: matById.get(mid) ? matById.get(mid).title : `#${mid}`,
    kind: matById.get(mid) ? matById.get(mid).kind : null,
  }));

  // 去重折叠：同一素材被多个位置选中时，仅保留原清单顺序中的首次出现
  const removedByDedupe = [];
  const seenFinal = new Set();
  chosenAt.forEach((selectedId, position) => {
    if (seenFinal.has(selectedId)) {
      removedByDedupe.push({
        position,
        materialId: selectedId,
        title: matById.get(selectedId) ? matById.get(selectedId).title : null,
      });
    } else {
      seenFinal.add(selectedId);
    }
  });

  const token = buildApplyToken(db, ctx, spec, best);

  return {
    ...base,
    feasible: true,
    replacementCount: best.replacementCount,
    selection,
    replacements,
    finalMaterialIds: best.finalSorted,
    finalItems,
    removedByDedupe,
    tieBreak: {
      first: 'replacementCount',
      then: ['finalMaterialIdsAsc', 'choiceSequenceInOriginalOrder'],
      replacementCount: best.replacementCount,
      finalMaterialIds: best.finalSorted,
      choiceSequence: best.choices.filter((_, i) => slots[i].isEntry),
    },
    verification: result,
    stops: stopSummaries(result, ctx),
    applyToken: token,
    message: best.replacementCount === 0
      ? '最优方案为不替换任何素材（替换件数 0）：当前清单已全站合格。确认不会改动清单。'
      : `最优方案：替换 ${best.replacementCount} 件（已按替换件数最少 → 最终清单升序 → 原清单顺序选中编号裁决并列）；确认后原子更新清单。`,
  };
}

// ---------- 主入口：确认（单事务；过期/输入不符/重算失格整体拒绝） ----------
function applySubstitutions(db, packageId, rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  if (!body.applyToken || typeof body.applyToken !== 'object') {
    throw new SubstituteError(400, '缺少确认令牌 applyToken，请先调用替代素材预览');
  }
  const token = body.applyToken;

  const run = db.transaction(() => {
    // 0) 令牌完整性
    const tokenPkg = Number(token.packageId);
    if (!Number.isInteger(tokenPkg) || tokenPkg !== packageId
      || typeof token.listFingerprint !== 'string' || typeof token.itineraryFingerprint !== 'string'
      || !Number.isInteger(Number(token.basisVersion))
      || !Array.isArray(token.substitutions) || !Array.isArray(token.selection)
      || !Array.isArray(token.finalMaterialIds)) {
      throw new SubstituteError(409, '确认令牌内容不完整或已损坏，请重新预览替代方案', { code: 'TOKEN_MISMATCH' });
    }

    // 1) 包仍须存在且为待发布
    const ctx = loadDraftContext(db, packageId); // 非 404/409 NOT_DRAFT 在此抛出

    // 2) 依据版本未变（预览后授权/来源关系被增删改）
    const currentBasis = basisVersion(db);
    if (Number(token.basisVersion) !== currentBasis) {
      throw new SubstituteError(409,
        `预览后授权或来源关系已变更（依据版本 ${token.basisVersion} → ${currentBasis}），拒绝应用，请重新预览。`,
        { code: 'STALE_BASIS', clientBasis: Number(token.basisVersion), currentBasis });
    }

    // 3) 清单指纹与行程指纹未变
    const curListFp = listFingerprint(ctx.origins);
    if (curListFp !== token.listFingerprint) {
      throw new SubstituteError(409, '预览后包的入展素材清单已变更，拒绝应用，请重新预览替代方案',
        { code: 'PACKAGE_CHANGED', currentMaterialIds: [...ctx.origins].sort((a, b) => a - b) });
    }
    const curItinFp = itineraryFingerprint(ctx.pkg, ctx.stopRows);
    if (curItinFp !== token.itineraryFingerprint) {
      throw new SubstituteError(409, '预览后包的（单站参数或多站）行程已变更，拒绝应用，请重新预览替代方案',
        { code: 'ITINERARY_CHANGED' });
    }

    // 4) 令牌内嵌的替代规格必须仍能通过同一套输入校验（防篡改/防陈旧结构）
    const matRows = db.prepare('SELECT id, title, kind FROM materials').all();
    const matById = new Map(matRows.map((m) => [m.id, m]));
    let spec;
    try {
      spec = validateSpec({ substitutions: token.substitutions }, ctx.origins, matById);
    } catch (e) {
      if (e instanceof SubstituteError && e.status === 400) {
        throw new SubstituteError(409, '确认令牌中的替代规格与当前包不符或已损坏，请重新预览',
          { code: 'INPUT_MISMATCH', errors: e.details && e.details.errors });
      }
      throw e;
    }
    for (const sel of token.selection) {
      const cid = Number(sel.selectedMaterialId);
      if (!Number.isInteger(cid) || !matById.has(cid)) {
        throw new SubstituteError(409, `选中的素材 #${cid} 已不存在，请重新预览替代方案`,
          { code: 'INPUT_MISMATCH', selection: sel });
      }
    }

    // 5) 服务端按同一规格重算最优方案，必须与令牌选择逐项一致
    const entryByPos = new Map(spec.map((e) => [e.position, e]));
    const slots = ctx.origins.map((mid, position) => {
      const entry = entryByPos.get(position);
      return entry
        ? { materialId: mid, choices: [mid, ...entry.candidateIds], isEntry: true }
        : { materialId: mid, choices: [mid], isEntry: false };
    });
    const possibleRoots = [...new Set(slots.flatMap((s) => s.choices))].sort((a, b) => a - b);
    const pre = precompute(db, possibleRoots, ctx.stops);
    const { best } = enumerateBest(slots, pre.rootInfo, pre.coverMasks);
    if (!best) {
      // 典型情形：预览后选中候选素材被删除等导致重算已无合格方案
      const current = fullVerify(db, ctx, [...ctx.origins].sort((a, b) => a - b));
      throw new SubstituteError(422,
        '按当前数据重算时已不存在全站合格的替代方案，拒绝应用且不修改包；请重新预览。',
        { code: 'RECOMPUTE_DISQUALIFIED', current });
    }

    const serverSelection = [];
    let si = 0;
    ctx.origins.forEach((mid, position) => {
      if (si < spec.length && spec[si].position === position) {
        const entry = spec[si++];
        const ci = best.choices[position];
        serverSelection.push({
          position, materialId: mid,
          choiceIndex: ci,
          selectedMaterialId: ci === 0 ? mid : entry.candidateIds[ci - 1],
        });
      }
    });
    const clientSelection = [...token.selection]
      .map((s) => ({ position: s.position, materialId: s.materialId, choiceIndex: s.choiceIndex, selectedMaterialId: s.selectedMaterialId }))
      .sort((a, b) => a.position - b.position);
    const sameSelection = serverSelection.length === clientSelection.length
      && serverSelection.every((s, i) =>
        s.position === clientSelection[i].position
        && s.materialId === clientSelection[i].materialId
        && s.choiceIndex === clientSelection[i].choiceIndex
        && s.selectedMaterialId === clientSelection[i].selectedMaterialId);
    if (!sameSelection || best.finalSorted.join() !== token.finalMaterialIds.map(Number).sort((a, b) => a - b).join()) {
      throw new SubstituteError(409,
        '令牌方案与服务端按当前数据重算的最优方案不一致（输入不符），拒绝应用，请重新预览。',
        { code: 'INPUT_MISMATCH', serverSelection, serverFinalMaterialIds: best.finalSorted });
    }

    // 6) 应用前用核验引擎对最终去重清单再做一次权威整站重算
    const result = fullVerify(db, ctx, best.finalSorted);
    if (!result.eligible) {
      throw new SubstituteError(422,
        '最终清单重算未达全站合格，拒绝应用且不修改包。',
        { code: 'RECOMPUTE_DISQUALIFIED', result });
    }

    // 7) 全部通过：原子重写清单（沿原清单顺序首次出现去重），不动行程、状态与快照
    db.prepare('DELETE FROM package_items WHERE package_id=?').run(packageId);
    const ins = db.prepare('INSERT INTO package_items(package_id, material_id, position) VALUES (?,?,?)');
    best.ordered.forEach((mid, i) => ins.run(packageId, mid, i));
    db.prepare('UPDATE packages SET updated_at=? WHERE id=?').run(new Date().toISOString(), packageId);

    return {
      packageId,
      basisVersion: currentBasis,
      replacementCount: best.replacementCount,
      finalMaterialIds: best.finalSorted,
      result,
      stops: stopSummaries(result, ctx),
    };
  });

  return run();
}

module.exports = {
  SubstituteError,
  previewSubstitutions,
  applySubstitutions,
  listFingerprint,
  itineraryFingerprint,
  MAX_ENTRIES,
  MAX_CANDIDATES,
};
