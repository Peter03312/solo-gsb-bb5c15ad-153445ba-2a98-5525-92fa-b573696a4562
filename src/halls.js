'use strict';

// 展厅编号（hall number）占用与冲突检测。
//
// 规则（本轮新增，全部既有“无编号”行为保持兼容）：
//   - 策展人可为【待发布单站包】或【巡展的每一站】填写【可选】展厅编号；
//   - 编号去首尾空白、匹配忽略大小写（存储保留去空白后的原始写法，比对用归一化键）；
//   - 未填写（null/空串/全空白）的包/站不参与占用，沿用原流程；
//   - 待发布包的编号仅保存、不预占；已发布及需复核包持续占用（发布后编号随冻结行程冻结）；
//   - 同一展厅（归一化后相同）的占用展期按首尾均包含计算，闭区间不得被不同包重叠使用
//     （重叠 ⇔ aFrom ≤ bTo 且 bFrom ≤ aTo）；
//   - 同一多站包自身的站间展期不重叠由既有 STOPS_OVERLAP 规则保证；同一包同一展厅的
//     多个非相邻站展期不相交，因此“占用者≠待判定包”即可判定为冲突。

class HallError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// 展厅编号归一化：去首尾空白并转小写；空值归一为 null（表示未填写）
function normalizeHallNo(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function hallKey(value) {
  const n = normalizeHallNo(value);
  return n === null ? null : n.toLowerCase();
}

// 闭区间展期重叠：首尾日期均包含
function dateRangesOverlap(fromA, toA, fromB, toB) {
  return fromA <= toB && fromB <= toA;
}

// 计算两个同展厅占用的重叠日期（闭区间交）；不重叠或日期非法时返回 null
function overlapDates(fromA, toA, fromB, toB) {
  const lo = fromA > fromB ? fromA : fromB;
  const hi = toA < toB ? toA : toB;
  if (lo > hi) return null;
  return { from: lo, to: hi };
}

// ---------- 当前占用读取：仅已发布 / 需复核包（待发布不预占） ----------
// 返回占用条目数组：
//   { packageId, packageName, packageStatus, stopPosition(null=单站),
//     stopName(null=单站), hallNo(存储写法), hallKey, useFrom, useTo }
function currentOccupancies(db, { excludePackageId = null } = {}) {
  const rows = [];

  // 单站占用：packages.hall_no 非空且包为已发布/需复核
  const single = db.prepare(
    `SELECT p.id AS package_id, p.name AS package_name, p.status AS package_status,
            p.hall_no AS hall_no, p.use_from AS use_from, p.use_to AS use_to
       FROM packages p
      WHERE p.status IN ('published','needs_review')
        AND p.hall_no IS NOT NULL AND trim(p.hall_no) <> ''
        AND EXISTS (SELECT 1 FROM package_stops ps WHERE ps.package_id = p.id) = 0`
  ).all();
  for (const r of single) {
    if (excludePackageId != null && r.package_id === excludePackageId) continue;
    rows.push({
      packageId: r.package_id,
      packageName: r.package_name,
      packageStatus: r.package_status,
      stopPosition: null,
      stopName: null,
      hallNo: r.hall_no.trim(),
      hallKey: hallKey(r.hall_no),
      useFrom: r.use_from,
      useTo: r.use_to,
    });
  }

  // 多站占用：每个填了编号的站独立占用（非待发布包的站次已由触发器冻结）
  const multi = db.prepare(
    `SELECT p.id AS package_id, p.name AS package_name, p.status AS package_status,
            ps.position AS position, ps.name AS stop_name, ps.hall_no AS hall_no,
            ps.use_from AS use_from, ps.use_to AS use_to
       FROM package_stops ps JOIN packages p ON p.id = ps.package_id
      WHERE p.status IN ('published','needs_review')
        AND ps.hall_no IS NOT NULL AND trim(ps.hall_no) <> ''
      ORDER BY p.id, ps.position`
  ).all();
  for (const r of multi) {
    if (excludePackageId != null && r.package_id === excludePackageId) continue;
    rows.push({
      packageId: r.package_id,
      packageName: r.package_name,
      packageStatus: r.package_status,
      stopPosition: r.position,
      stopName: r.stop_name,
      hallNo: r.hall_no.trim(),
      hallKey: hallKey(r.hall_no),
      useFrom: r.use_from,
      useTo: r.use_to,
    });
  }

  return rows;
}

// ---------- 待判定占用（一个包的单站或多站行程，含可选编号） ----------
// claims: [{ packageId, packageName?, stopPosition, stopName?, hallNo, useFrom, useTo, validDate? }]
// 仅 hallNo 非空、日期合法（validDate !== false）的条目参与比对。
function packageClaims(packageId, packageName, hallNo, useFrom, useTo, validDate = true) {
  const hn = normalizeHallNo(hallNo);
  if (hn === null || validDate === false) return [];
  return [{
    packageId,
    packageName: packageName || null,
    stopPosition: null,
    stopName: null,
    hallNo: hn,
    hallKey: hallKey(hn),
    useFrom,
    useTo,
  }];
}

function stopClaims(packageId, packageName, stops) {
  // stops: [{ position, name, hallNo, useFrom, useTo, validDate? }]
  const claims = [];
  for (const s of stops || []) {
    const hn = normalizeHallNo(s.hallNo);
    if (hn === null || s.validDate === false) continue;
    claims.push({
      packageId,
      packageName: packageName || null,
      stopPosition: Number.isInteger(s.position) ? s.position : null,
      stopName: s.name || null,
      hallNo: hn,
      hallKey: hallKey(hn),
      useFrom: s.useFrom,
      useTo: s.useTo,
    });
  }
  return claims;
}

// 从核验结果（verifyPackage / verifyMultiStop 的返回）提取本包的待判定占用。
// 仅提取日期合法的站：多站取 valid=true 的站；单站由 globalErrors 中无日期类错误判定。
function claimsFromResult(result, packageId, packageName) {
  if (!result) return [];
  if (result.multiStop === true) {
    return stopClaims(packageId, packageName, (result.stops || []).map((s) => ({
      position: s.position,
      name: s.name,
      hallNo: s.hallNo,
      useFrom: s.useFrom,
      useTo: s.useTo,
      validDate: s.valid !== false,
    })));
  }
  const req = result.request || {};
  const hasDateError = (result.globalErrors || []).some((m) =>
    typeof m === 'string' && (m.includes('日期') ));
  return packageClaims(packageId, packageName, req.hallNo, req.useFrom, req.useTo, !hasDateError);
}

// 计算单包对“当前已占用展厅”的冲突（排除自身：已发布包重算时不应与自己冲突；
// 草稿自身本就不在占用集合中，排除亦无副作用）。返回扁平冲突列表。
function currentConflictsForPackage(db, packageId, packageName, result) {
  const claims = claimsFromResult(result, packageId, packageName);
  const byPkg = new Map([[packageId, { packageName, claims }]]);
  const report = conflictsAgainstCurrent(db, byPkg, { excludePackageId: packageId });
  return flattenReport(report);
}

function conflictEntry(claim, occ) {
  const ov = overlapDates(claim.useFrom, claim.useTo, occ.useFrom, occ.useTo);
  if (!ov) return null;
  return {
    hallNo: occ.hallNo,
    normalizedHallNo: occ.hallKey,
    packageId: occ.packageId,
    packageName: occ.packageName,
    packageStatus: occ.packageStatus,
    stopPosition: occ.stopPosition,
    stopName: occ.stopName,
    overlapFrom: ov.from,
    overlapTo: ov.to,
  };
}

// 由 (claim, conflictEntry) 组装报告条目
function makeReportItem(claim, pkgName, conflicts) {
  return {
    packageId: claim.packageId,
    packageName: pkgName || claim.packageName || null,
    stopPosition: claim.stopPosition,
    stopName: claim.stopName,
    hallNo: claim.hallNo,
    hallKey: claim.hallKey,
    conflicts,
  };
}

// 一组待判定占用（可跨多个待发布包——用于批次）对一批“占用者”记录做冲突检测。
// 同包占用者自动跳过（同包站间不重叠已由 STOPS_OVERLAP 保证）。
function detectConflicts(claimsByPackage, occupied) {
  const reportMap = new Map();
  const push = (claim, pkgName, conflict) => {
    if (!reportMap.has(claim.packageId)) reportMap.set(claim.packageId, []);
    const list = reportMap.get(claim.packageId);
    let item = list.find((x) => x.stopPosition === claim.stopPosition && x.hallKey === claim.hallKey);
    if (!item) {
      item = makeReportItem(claim, pkgName, []);
      list.push(item);
    }
    const dup = item.conflicts.some((c) =>
      c.packageId === conflict.packageId && c.stopPosition === conflict.stopPosition
      && c.overlapFrom === conflict.overlapFrom && c.overlapTo === conflict.overlapTo);
    if (!dup) item.conflicts.push(conflict);
  };

  for (const [pid, entry] of claimsByPackage) {
    for (const claim of entry.claims) {
      for (const occ of occupied) {
        if (occ.packageId === pid) continue;
        if (occ.hallKey !== claim.hallKey) continue;
        const hit = conflictEntry(claim, occ);
        if (hit) push(claim, entry.packageName, hit);
      }
    }
  }
  return finalizeReport(reportMap);
}

// 一组待判定占用对【当前已占用】展厅（已发布/需复核）的冲突
function conflictsAgainstCurrent(db, claimsByPackage, { excludePackageId = null } = {}) {
  const occupied = currentOccupancies(db, { excludePackageId });
  return detectConflicts(claimsByPackage, occupied);
}

// 批次内部互查：草稿不预占，但同批提交会同时转为占用，故各包须两两互查。
// claimsByPackage: Map(packageId -> { packageName, claims:[] })
function conflictsInternal(claimsByPackage) {
  const allClaims = [];
  for (const [pid, entry] of claimsByPackage) {
    for (const c of entry.claims) allClaims.push({ ...c, packageId: pid });
  }
  // 把其它包的待判定占用视为“占用者”，status 标注为本批内部
  const others = allClaims.map((c) => ({ ...c, packageStatus: 'draft(batch)' }));
  return detectConflicts(claimsByPackage, others);
}

function flattenReport(report) {
  const flat = [];
  for (const item of report) {
    for (const c of item.conflicts) {
      flat.push({
        packageId: item.packageId,
        packageName: item.packageName,
        stopPosition: item.stopPosition,
        stopName: item.stopName,
        hallNo: item.hallNo,
        conflict: c,
      });
    }
  }
  return flat;
}

function finalizeReport(reportMap) {
  const report = [];
  for (const items of reportMap.values()) {
    for (const item of items) {
      item.conflicts.sort((a, b) =>
        a.packageId - b.packageId
        || String(a.stopPosition).localeCompare(String(b.stopPosition))
        || a.overlapFrom.localeCompare(b.overlapFrom));
      report.push(item);
    }
  }
  report.sort((a, b) =>
    a.packageId - b.packageId
    || String(a.stopPosition).localeCompare(String(b.stopPosition))
    || a.hallKey.localeCompare(b.hallKey));
  return report;
}

// 合并多份扁平冲突列表（对当前占用 + 批次内部）并去重
function mergeReports(...flatLists) {
  const seen = new Set();
  const merged = [];
  for (const list of flatLists) {
    for (const f of list || []) {
      if (!f || !f.conflict) continue;
      const c = f.conflict;
      const key = [f.packageId, f.stopPosition, f.hallNo,
        c.packageId, c.stopPosition, c.overlapFrom, c.overlapTo].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(f);
    }
  }
  merged.sort((a, b) =>
    a.packageId - b.packageId
    || String(a.stopPosition).localeCompare(String(b.stopPosition))
    || a.conflict.packageId - b.conflict.packageId
    || String(a.conflict.stopPosition).localeCompare(String(b.conflict.stopPosition)));
  return merged;
}

// 按包汇总冲突（批次预览/确认按包列出冲突包、站次与重叠日期）
function groupConflictsByPackage(flatConflicts) {
  const map = new Map();
  for (const f of flatConflicts) {
    if (!map.has(f.packageId)) {
      map.set(f.packageId, {
        packageId: f.packageId,
        packageName: f.packageName,
        claims: [],
      });
    }
    const pkg = map.get(f.packageId);
    let claim = pkg.claims.find((c) => c.stopPosition === f.stopPosition && c.hallNo === f.hallNo);
    if (!claim) {
      claim = { stopPosition: f.stopPosition, stopName: f.stopName, hallNo: f.hallNo, conflicts: [] };
      pkg.claims.push(claim);
    }
    if (!claim.conflicts.some((c) =>
      c.packageId === f.conflict.packageId && c.stopPosition === f.conflict.stopPosition
      && c.overlapFrom === f.conflict.overlapFrom && c.overlapTo === f.conflict.overlapTo)) {
      claim.conflicts.push(f.conflict);
    }
  }
  return [...map.values()].sort((a, b) => a.packageId - b.packageId);
}

// 人读冲突说明（单包发布 422 / 批次拒绝信息）
function describeConflict(f) {
  const where = f.stopPosition == null
    ? `单站展（展厅 ${f.hallNo}）`
    : `第 ${f.stopPosition + 1} 站「${f.stopName || ''}」（展厅 ${f.hallNo}）`;
  const c = f.conflict;
  const other = c.stopPosition == null
    ? `包 #${c.packageId}「${c.packageName || ''}」`
    : `包 #${c.packageId}「${c.packageName || ''}」第 ${c.stopPosition + 1} 站「${c.stopName || ''}」`;
  return `${where}与${other}（展厅 ${c.hallNo}）展期重叠：重叠日期 ${c.overlapFrom} ～ ${c.overlapTo}（首尾均含）`;
}

module.exports = {
  HallError,
  normalizeHallNo,
  hallKey,
  dateRangesOverlap,
  overlapDates,
  currentOccupancies,
  packageClaims,
  stopClaims,
  claimsFromResult,
  currentConflictsForPackage,
  conflictsAgainstCurrent,
  conflictsInternal,
  flattenReport,
  mergeReports,
  groupConflictsByPackage,
  describeConflict,
};
