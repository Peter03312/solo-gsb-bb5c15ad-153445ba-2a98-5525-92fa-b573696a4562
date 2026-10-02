'use strict';

// 变更影响预演 / 确认提交
//
// 支持的单笔变更（字段与校验完全沿用既有编辑接口）：
//   authorization.create  POST   /api/materials/:id/authorizations
//   authorization.update  PATCH  /api/authorizations/:id
//   authorization.revoke  POST   /api/authorizations/:id/revoke
//   authorization.delete  DELETE /api/authorizations/:id
//   source.create         POST   /api/materials/:id/sources
//   source.delete         DELETE /api/source-links/:id
//
// 预演（previewChange）：在 SAVEPOINT 内模拟变更、重算全部已发布包，再回滚，
//   只返回“因该变更将由合格转为不合格”的已发布包、问题节点与原因，以及依据版本；
//   不改动授权、来源关系、包状态或快照。
// 确认（commitChange）：在单个事务内重新校验输入/目标/成环、核对依据版本，
//   应用变更后重算影响并与预演清单比对；任一不符则整体回滚，无部分写入。
//   通过后按现有规则执行变更、标记需复核并追加不可变快照。

const { isValidDate, findPath, loadGraph, verifyStoredPackage, loadStops, revalidatePublished } = require('./verify');
const { nowIso } = require('./db');

class ChangeError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const str = (v) => (v === null || v === undefined ? '' : String(v));

const OPERATIONS = [
  'authorization.create',
  'authorization.update',
  'authorization.revoke',
  'authorization.delete',
  'source.create',
  'source.delete',
];

function validateScope(body) {
  // 与既有授权接口一致：前端字段名为 media（媒介），兼容 medium
  const medium = str(body.media ?? body.medium).trim();
  const region = str(body.region).trim();
  if (!medium) throw new ChangeError(400, '媒介不能为空');
  if (!region) throw new ChangeError(400, '地区不能为空');
  return { medium, region };
}

function validateDateRange(from, to) {
  if (!isValidDate(from)) throw new ChangeError(400, `起始日期不合法：${from || '（空）'}（需为 YYYY-MM-DD）`);
  if (!isValidDate(to)) throw new ChangeError(400, `截止日期不合法：${to || '（空）'}（需为 YYYY-MM-DD）`);
  if (from > to) throw new ChangeError(400, `起止日期不合法：起始 ${from} 晚于截止 ${to}`);
}

function materialTitle(db, id) {
  const m = db.prepare('SELECT title FROM materials WHERE id=?').get(id);
  return m ? m.title : null;
}

// 目标失效：预演阶段按 404 返回；确认阶段按 409 TARGET_GONE 拒绝（不产生写入）
function gone(phase, message, codeDetails) {
  if (phase === 'commit') {
    throw new ChangeError(409, `目标已失效，拒绝提交：${message}`, { code: 'TARGET_GONE', ...codeDetails });
  }
  throw new ChangeError(404, message, codeDetails);
}

/**
 * 解析并校验一次变更请求，规则与既有编辑接口逐条一致。
 * phase: 'preview' | 'commit'，仅影响“目标不存在”时的状态码。
 * 返回归一化变更对象（含给前端展示用的 summary）。
 */
function normalizeChange(db, rawBody, phase) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const op = str(body.operation).trim();
  if (!OPERATIONS.includes(op)) {
    throw new ChangeError(400, `未知或缺少变更操作 operation，支持：${OPERATIONS.join(' / ')}`);
  }

  if (op === 'authorization.create') {
    const materialId = Number(body.materialId);
    if (!Number.isInteger(materialId) || materialId <= 0) throw new ChangeError(400, '缺少合法的 materialId');
    if (!materialTitle(db, materialId)) gone(phase, `素材 #${materialId} 不存在`, { materialId });
    const { medium, region } = validateScope(body);
    const validFrom = str(body.validFrom).trim();
    const validTo = str(body.validTo).trim();
    validateDateRange(validFrom, validTo);
    const revoked = body.revoked ? 1 : 0;
    const licensor = str(body.licensor).trim() || null;
    const note = str(body.note).trim() || null;
    return {
      op, materialId, medium, region, validFrom, validTo, revoked, licensor, note,
      summary: `为素材《${materialTitle(db, materialId)}》#${materialId} 新增授权：${medium} / ${region}，有效期 ${validFrom} → ${validTo}${revoked ? '（登记即为已撤销）' : ''}`,
    };
  }

  if (op === 'authorization.update') {
    const authorizationId = Number(body.authorizationId);
    if (!Number.isInteger(authorizationId) || authorizationId <= 0) throw new ChangeError(400, '缺少合法的 authorizationId');
    const a = db.prepare('SELECT * FROM authorizations WHERE id=?').get(authorizationId);
    if (!a) gone(phase, `授权 #${authorizationId} 不存在（可能已被他人删除）`, { authorizationId });
    // 与 PATCH /api/authorizations/:id 一致：缺省字段沿用现值
    const medium = str(body.media ?? a.media).trim();
    const region = str(body.region ?? a.region).trim();
    const validFrom = str(body.validFrom ?? a.valid_from).trim();
    const validTo = str(body.validTo ?? a.valid_to).trim();
    const licensor = body.licensor === undefined ? a.licensor : str(body.licensor).trim() || null;
    const note = body.note === undefined ? a.note : str(body.note).trim() || null;
    if (!medium) throw new ChangeError(400, '媒介不能为空');
    if (!region) throw new ChangeError(400, '地区不能为空');
    validateDateRange(validFrom, validTo);
    const revoked = body.revoked === undefined ? a.revoked : (body.revoked ? 1 : 0);
    return {
      op, authorizationId, medium, region, validFrom, validTo, revoked, licensor, note,
      summary: `修改授权 #${authorizationId}（素材《${materialTitle(db, a.material_id)}》#${a.material_id}）：${medium} / ${region}，有效期 ${validFrom} → ${validTo}${revoked ? '，已撤销' : '，有效'}`,
    };
  }

  if (op === 'authorization.revoke' || op === 'authorization.delete') {
    const authorizationId = Number(body.authorizationId);
    if (!Number.isInteger(authorizationId) || authorizationId <= 0) throw new ChangeError(400, '缺少合法的 authorizationId');
    const a = db.prepare('SELECT * FROM authorizations WHERE id=?').get(authorizationId);
    if (!a) gone(phase, `授权 #${authorizationId} 不存在（可能已被他人删除）`, { authorizationId });
    const title = materialTitle(db, a.material_id);
    return op === 'authorization.revoke'
      ? { op, authorizationId, summary: `撤销授权 #${authorizationId}（素材《${title}》#${a.material_id}：${a.media} / ${a.region}，${a.valid_from} → ${a.valid_to}）` }
      : { op, authorizationId, summary: `删除授权 #${authorizationId}（素材《${title}》#${a.material_id}：${a.media} / ${a.region}，${a.valid_from} → ${a.valid_to}）` };
  }

  // source.create
  if (op === 'source.create') {
    const materialId = Number(body.materialId);
    const sourceId = Number(body.sourceMaterialId);
    if (!Number.isInteger(materialId) || materialId <= 0) throw new ChangeError(400, '缺少合法的 materialId');
    if (!Number.isInteger(sourceId) || sourceId <= 0) throw new ChangeError(400, '缺少合法的 sourceMaterialId');
    if (materialId === sourceId) throw new ChangeError(400, '素材不能以自身为来源');
    const mTitle = materialTitle(db, materialId);
    if (!mTitle) gone(phase, `素材 #${materialId} 不存在`, { materialId });
    const sTitle = materialTitle(db, sourceId);
    if (!sTitle) gone(phase, `来源素材 #${sourceId} 不存在`, { sourceMaterialId: sourceId });

    const dup = db
      .prepare('SELECT id FROM source_links WHERE material_id=? AND source_material_id=?')
      .get(materialId, sourceId);
    if (dup) {
      throw new ChangeError(409, '该来源关系已存在', { code: 'ALREADY_EXISTS', linkId: dup.id });
    }
    // 与 POST /api/materials/:id/sources 一致的成环预判
    const adj = loadGraph(db);
    const cyclePath = findPath(adj, sourceId, materialId);
    if (cyclePath) {
      throw new ChangeError(409, '添加该来源将形成闭环（来源关系不得成环）', {
        code: 'CYCLE',
        cyclePath,                            // 既有可达路径：source -> … -> material
        cycle: [materialId, ...cyclePath],    // 完整闭环：material -> source -> … -> material
      });
    }
    const relation = str(body.relation).trim() || '使用';
    return {
      op, materialId, sourceId, relation,
      summary: `新增来源关系：《${mTitle}》#${materialId} 使用了 ← 《${sTitle}》#${sourceId}（${relation}）`,
    };
  }

  // source.delete
  const linkId = Number(body.linkId ?? body.sourceLinkId);
  if (!Number.isInteger(linkId) || linkId <= 0) throw new ChangeError(400, '缺少合法的 linkId');
  const link = db.prepare('SELECT * FROM source_links WHERE id=?').get(linkId);
  if (!link) gone(phase, `来源关系 #${linkId} 不存在（可能已被他人删除）`, { linkId });
  const mTitle = materialTitle(db, link.material_id);
  const sTitle = materialTitle(db, link.source_material_id);
  return {
    op: 'source.delete', linkId,
    summary: `删除来源关系 #${linkId}：《${mTitle}》#${link.material_id} → 《${sTitle}》#${link.source_material_id}（${link.relation}）`,
  };
}

// 在事务（含 SAVEPOINT）内执行单笔变更
function applyChange(db, c) {
  if (c.op === 'authorization.create') {
    const info = db
      .prepare(
        `INSERT INTO authorizations(material_id, media, region, valid_from, valid_to, revoked, licensor, note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(c.materialId, c.medium, c.region, c.validFrom, c.validTo, c.revoked, c.licensor, c.note, nowIso(), nowIso());
    return { authorizationId: Number(info.lastInsertRowid) };
  }
  if (c.op === 'authorization.update') {
    db.prepare(
      `UPDATE authorizations SET media=?, region=?, valid_from=?, valid_to=?, revoked=?, licensor=?, note=?, updated_at=? WHERE id=?`
    ).run(c.medium, c.region, c.validFrom, c.validTo, c.revoked, c.licensor, c.note, nowIso(), c.authorizationId);
    return { authorizationId: c.authorizationId };
  }
  if (c.op === 'authorization.revoke') {
    db.prepare('UPDATE authorizations SET revoked=1, updated_at=? WHERE id=?').run(nowIso(), c.authorizationId);
    return { authorizationId: c.authorizationId };
  }
  if (c.op === 'authorization.delete') {
    db.prepare('DELETE FROM authorizations WHERE id=?').run(c.authorizationId);
    return { authorizationId: c.authorizationId };
  }
  if (c.op === 'source.create') {
    const info = db
      .prepare('INSERT INTO source_links(material_id, source_material_id, relation, created_at) VALUES (?,?,?,?)')
      .run(c.materialId, c.sourceId, c.relation, nowIso());
    return { linkId: Number(info.lastInsertRowid) };
  }
  db.prepare('DELETE FROM source_links WHERE id=?').run(c.linkId);
  return { linkId: c.linkId };
}

function loadPublishedPackages(db) {
  return db
    .prepare("SELECT * FROM packages WHERE status='published' ORDER BY id")
    .all()
    .map((pkg) => {
      const items = db
        .prepare('SELECT material_id FROM package_items WHERE package_id=? ORDER BY position, material_id')
        .all(pkg.id)
        .map((r) => r.material_id);
      const stops = loadStops(db, pkg.id);
      return { pkg, items, stops };
    });
}

function verifyEntry(db, entry) {
  return verifyStoredPackage(db, entry.pkg, entry.items, entry.stops);
}

// 影响条目：仅“由合格变不合格”的已发布包 + 问题节点（变更后结果）与原因。
// 多站包按站列出失格站及其问题节点（含全部来源路径）；单站包保持旧字段。
function buildImpact(entries, beforeById, resultsAfter) {
  const impact = [];
  for (let i = 0; i < entries.length; i++) {
    const { pkg, stops } = entries[i];
    const before = beforeById.get(pkg.id);
    const after = resultsAfter[i];
    if (!before.eligible || after.eligible) continue;
    if (after.multiStop) {
      impact.push({
        packageId: pkg.id,
        packageName: pkg.name,
        multiStop: true,
        stopCount: after.stats.stopCount,
        failingStops: after.stops
          .filter((s) => !s.eligible)
          .map((s) => ({
            position: s.position,
            name: s.name,
            medium: s.medium,
            region: s.region,
            useFrom: s.useFrom,
            useTo: s.useTo,
            failingNodes: s.failingNodes,
          })),
        failingNodes: after.failingNodes,
      });
    } else {
      impact.push({
        packageId: pkg.id,
        packageName: pkg.name,
        multiStop: false,
        medium: pkg.medium,
        region: pkg.region,
        useFrom: pkg.use_from,
        useTo: pkg.use_to,
        failingNodes: after.failingNodes,
      });
    }
  }
  return impact;
}

// 影响清单的规范化指纹：含包 id 与每站问题节点/原因，排序保证确定性
function impactFingerprint(impact) {
  const canon = (impact || []).map((e) => {
    if (e.multiStop) {
      const stops = e.failingStops || [];
      return {
        packageId: e.packageId,
        stops: stops
          .map((s) => ({
            position: s.position,
            nodes: s.failingNodes
              .map((n) => ({ materialId: n.materialId, reasons: [...n.reasons].sort() }))
              .sort((a, b) => a.materialId - b.materialId),
          }))
          .sort((a, b) => a.position - b.position),
      };
    }
    return {
      packageId: e.packageId,
      nodes: e.failingNodes
        .map((n) => ({ materialId: n.materialId, reasons: [...n.reasons].sort() }))
        .sort((a, b) => a.materialId - b.materialId),
    };
  }).sort((a, b) => a.packageId - b.packageId);
  return JSON.stringify(canon);
}

// 取当前依据版本（任何授权/来源写入都会经触发器使其 +1）
function currentBasis(db) {
  return Number(db.prepare("SELECT value FROM meta WHERE key='basis_version'").pluck().get());
}

// 用回滚型 SAVEPOINT 执行模拟：结果带回事务外，数据一律不落库
class SimulationRollback {}
function simulate(db, fn) {
  let output;
  const runner = db.transaction(() => {
    output = fn();
    throw new SimulationRollback();
  });
  try {
    runner();
  } catch (e) {
    if (!(e instanceof SimulationRollback)) throw e;
  }
  return output;
}

/**
 * 影响预演：不落任何数据。
 * 返回 { operation, summary, basisVersion, impact, impactFingerprint }
 */
function previewChange(db, rawBody) {
  const change = normalizeChange(db, rawBody, 'preview');
  const basisVersion = currentBasis(db);

  return simulate(db, () => {
    const entries = loadPublishedPackages(db);
    const beforeResults = entries.map((e) => verifyEntry(db, e));
    const beforeById = new Map(entries.map((e, i) => [e.pkg.id, beforeResults[i]]));

    applyChange(db, change);

    const afterResults = entries.map((e) => verifyEntry(db, e));
    const impact = buildImpact(entries, beforeById, afterResults);

    return {
      operation: change.op,
      summary: change.summary,
      basisVersion, // 预演所依据的版本（模拟写入已回滚，库内版本不变）
      impact,
      impactFingerprint: impactFingerprint(impact),
      mutated: false,
    };
  });
}

/**
 * 确认提交：事务内完成全部检查与写入；任何不符整体回滚。
 * rawBody 需携带预演结果：basisVersion 与 impact（原样回传即可）。
 */
function commitChange(db, rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  if (body.basisVersion === undefined || body.basisVersion === null) {
    throw new ChangeError(400, '缺少预演依据版本 basisVersion，请先调用影响预演');
  }
  const clientBasis = Number(body.basisVersion);
  if (!Number.isInteger(clientBasis)) throw new ChangeError(400, 'basisVersion 必须为整数');
  if (!Array.isArray(body.impact)) throw new ChangeError(400, '缺少预演影响清单 impact（数组，空影响传 []）');

  const run = db.transaction(() => {
    // 1) 依据版本必须与预演时一致
    const basisBefore = currentBasis(db);
    if (clientBasis !== basisBefore) {
      throw new ChangeError(
        409,
        `预演依据已过期：预演时版本 ${clientBasis}，当前版本 ${basisBefore}，授权或来源关系在此期间被修改。请重新预演后再确认。`,
        { code: 'STALE_BASIS', clientBasis, currentBasis: basisBefore }
      );
    }

    // 2) 输入合法性、目标有效性、成环——与预演同一套规则重放（目标已删 -> TARGET_GONE）
    const change = normalizeChange(db, body, 'commit');

    // 3) 重算预演影响（事务内、变更未落库前先取现状）
    const entries = loadPublishedPackages(db);
    const beforeResults = entries.map((e) => verifyEntry(db, e));
    const beforeById = new Map(entries.map((e, i) => [e.pkg.id, beforeResults[i]]));

    // 4) 应用变更（触发器使依据版本 +1）
    const applied = applyChange(db, change);

    // 5) 重算影响并与预演清单核对
    const afterResults = entries.map((e) => verifyEntry(db, e));
    const impact = buildImpact(entries, beforeById, afterResults);
    if (impactFingerprint(impact) !== impactFingerprint(body.impact)) {
      throw new ChangeError(
        409,
        '预演影响清单与当前重算结果不一致，拒绝提交（无任何写入）。请按最新结果重新预演后再确认。',
        {
          code: 'IMPACT_MISMATCH',
          expected: impactFingerprint(impact),
          submitted: impactFingerprint(body.impact),
          impact, // 附上服务端最新影响，便于前端直接刷新清单
        }
      );
    }

    // 6) 按现有规则执行：标记需复核 + 追加不可变 review 快照（只处理 published -> 不合格）
    revalidatePublished(db);

    return {
      operation: change.op,
      summary: change.summary,
      applied,
      basisVersion: currentBasis(db),
      impact,
      mutated: true,
    };
  });

  return run();
}

module.exports = {
  ChangeError,
  OPERATIONS,
  normalizeChange,
  previewChange,
  commitChange,
  impactFingerprint,
};
