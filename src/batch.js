'use strict';

// 联展批次发布：策展人选取 2～20 个【待发布】展览包组成一个联展批次。
//
// 预览（previewBatch，只读事务，不写入任何数据）：
//   - 逐包按当前授权与来源关系重算（单站或多站逐站，规则与既有核验完全一致）；
//   - 返回每包的单站/多站逐站核验结果、共同依据版本、各包清单指纹与行程指纹；
//   - 只要有一个包失格（或非待发布/不存在），列出缺口且不发放确认凭据（confirmToken），
//     禁止确认。预览绝不写库（无快照、无凭证、无状态变化、依据版本不变）。
//
// 确认（confirmBatch，单个 SQLite 事务）：
//   - 服务端核对凭据：包集合（数量、id、顺序无关地按升序比对）、各包仍为 draft、
//     共同依据版本、各包清单指纹与行程指纹；
//   - 在同一事务内按当前授权及来源关系对【全部包】重新核验；
//   - 全部合格时：先为每包封存不可变发布快照与签名发布凭证（与单包发布同构、
//     sealContext:"publish-batch"），再把所有包一起转为 published；
//   - 包不存在、凭据不符、状态或依据变化、任一包重算失格：整批拒绝，
//     不产生任何快照、凭证或部分发布（失败不留痕——批次是一个原子闸门）。
//
// 与既有单包发布的关系：单包发布 /publish 的行为（含 422 失败留痕、凭证导出、
// 补发、离线校验）完全不变；批次内每包封存的快照与凭证与单包发布同构，
// 可被既有 GET /api/packages/:id/attestation、离线校验程序直接消费。

const {
  verifyStoredPackage,
  loadStops,
  basisVersion,
} = require('./verify');
const { listFingerprint, itineraryFingerprint } = require('./substitutes');
const { buildAttestation } = require('./attest');
const { nowIso } = require('./db');

const MIN_PACKAGES = 2;
const MAX_PACKAGES = 20;

class BatchError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// ---------- 入参解析：packageIds 必须为 2～20 个互不相同的正整数 ----------
function parsePackageIds(rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const raw = body.packageIds;
  if (raw === undefined || raw === null || !Array.isArray(raw)) {
    throw new BatchError(400,
      '缺少 packageIds（数组；联展批次需选取 2～20 个待发布展览包）',
      { code: 'INVALID_BATCH' });
  }
  if (raw.length < MIN_PACKAGES || raw.length > MAX_PACKAGES) {
    throw new BatchError(400,
      `联展批次需选取 ${MIN_PACKAGES}～${MAX_PACKAGES} 个待发布展览包（当前 ${raw.length} 个）`,
      { code: 'INVALID_BATCH', count: raw.length, min: MIN_PACKAGES, max: MAX_PACKAGES });
  }
  const bad = [];
  const ids = [];
  raw.forEach((v, i) => {
    const id = Number(v);
    if (!Number.isInteger(id) || id <= 0) bad.push({ index: i, value: v });
    else ids.push(id);
  });
  if (bad.length) {
    throw new BatchError(400,
      '联展批次的 packageIds 必须全部为正整数包编号',
      { code: 'INVALID_BATCH', invalid: bad });
  }
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort((a, b) => a - b);
  if (duplicates.length) {
    throw new BatchError(400,
      `联展批次中不能重复选取同一展览包（重复：${duplicates.join(', ')}）`,
      { code: 'INVALID_BATCH', duplicates });
  }
  // 服务端按 id 升序规范化包集合（凭据与比对均以升序为准，与提交顺序无关）
  return [...new Set(ids)].sort((a, b) => a - b);
}

// ---------- 读取包上下文（清单 / 行程 / 指纹）；不存在或非 draft 在此报错 ----------
function loadPackageContext(db, id, { allowNonDraft = false } = {}) {
  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
  if (!pkg) {
    throw new BatchError(404, `联展批次中的展览包 #${id} 不存在`, { code: 'PACKAGE_NOT_FOUND', packageId: id });
  }
  if (!allowNonDraft && pkg.status !== 'draft') {
    throw new BatchError(409,
      `联展批次只能由待发布包组成：包 #${id}「${pkg.name}」当前状态为 ${pkg.status}`,
      { code: 'NOT_DRAFT', packageId: id, status: pkg.status });
  }
  const items = db
    .prepare('SELECT material_id FROM package_items WHERE package_id=? ORDER BY position, material_id')
    .all(id)
    .map((r) => r.material_id);
  const stopRows = loadStops(db, id);
  return {
    pkg,
    items,
    stopRows,
    multiStop: stopRows.length >= 2,
    listFp: listFingerprint(items),
    itineraryFp: itineraryFingerprint(pkg, stopRows),
  };
}

// ---------- 逐站摘要（单站包归一化为 1 站；多站包按站给出） ----------
function stopSummaries(ctx, result) {
  if (ctx.multiStop) {
    return (result.stops || []).map((s) => ({
      position: s.position,
      name: s.name,
      medium: s.medium,
      region: s.region,
      useFrom: s.useFrom,
      useTo: s.useTo,
      eligible: s.eligible,
      errors: s.errors || [],
      nodeCount: s.stats ? s.stats.nodeCount : 0,
      failingNodeCount: s.stats ? s.stats.failingCount : 0,
      failingNodes: s.failingNodes || [],
    }));
  }
  return [{
    position: 0,
    name: ctx.pkg.name,
    medium: (ctx.pkg.medium || '').trim(),
    region: (ctx.pkg.region || '').trim(),
    useFrom: ctx.pkg.use_from,
    useTo: ctx.pkg.use_to,
    eligible: result.eligible,
    errors: [],
    nodeCount: result.stats ? result.stats.nodeCount : 0,
    failingNodeCount: result.stats ? result.stats.failingCount : 0,
    failingNodes: result.failingNodes || [],
  }];
}

// 逐包预览条目（含逐站核验缺口）
function buildPackageEntry(db, ctx, commonBasis) {
  const result = verifyStoredPackage(db, ctx.pkg, ctx.items, ctx.stopRows);
  return {
    packageId: ctx.pkg.id,
    packageName: ctx.pkg.name,
    status: ctx.pkg.status,
    multiStop: ctx.multiStop,
    stopCount: ctx.multiStop ? ctx.stopRows.length : 1,
    itemCount: ctx.items.length,
    materialIds: [...ctx.items].sort((a, b) => a - b),
    eligible: result.eligible,
    globalErrors: result.globalErrors || [],
    itemErrors: result.itemErrors || [],
    basisVersion: result.basisVersion,
    listFingerprint: ctx.listFp,
    itineraryFingerprint: ctx.itineraryFp,
    stops: stopSummaries(ctx, result),
    result, // 完整核验结果（与 /api/verify 同构；快照 payload 即以此封存）
  };
}

// ---------- 主入口：预览（只读事务；不写入任何数据） ----------
function previewBatch(db, rawBody) {
  const packageIds = parsePackageIds(rawBody);
  return db.transaction(() => {
    const commonBasis = basisVersion(db);
    const contexts = packageIds.map((id) => loadPackageContext(db, id));
    const packages = contexts.map((ctx) => buildPackageEntry(db, ctx, commonBasis));
    const eligible = packages.every((p) => p.eligible);
    const failing = packages.filter((p) => !p.eligible);

    const preview = {
      generatedAt: new Date().toISOString(),
      mutated: false,
      kind: 'joint-exhibition-batch-preview',
      packageIds,
      packageCount: packageIds.length,
      basisVersion: commonBasis,
      eligible,
      eligibleCount: packages.length - failing.length,
      failingCount: failing.length,
      packages: packages.map(stripResultForPreview),
      message: eligible
        ? `联展批次 ${packageIds.length} 个包逐包（逐站）重算全部合格：可携带预览凭据在同一事务内整批发布。预览未写入任何数据。`
        : `联展批次存在 ${failing.length} 个失格包：已按包列出缺口，禁止确认。预览未写入任何数据。`,
    };

    if (!eligible) return preview; // 失格：不发放凭据，禁止确认

    // 全部合格：发放一次性确认凭据（携带包集合、共同依据版本、各包双指纹）
    preview.confirmToken = {
      kind: 'joint-exhibition-batch-confirm',
      packageIds,
      basisVersion: commonBasis,
      packages: packages.map((p) => ({
        packageId: p.packageId,
        listFingerprint: p.listFingerprint,
        itineraryFingerprint: p.itineraryFingerprint,
      })),
    };
    return preview;
  })();
}

// 预览对外结构：缺口需要逐站失格节点；完整 result 仅保留在服务端事务内封存路径不对外重复膨胀，
// 但为与既有 /api/verify 体验一致，仍给出 stops（已含 failingNodes）。这里不返回完整 result。
function stripResultForPreview(p) {
  const { result, commonBasis, ...rest } = p;
  return rest;
}

// ---------- 主入口：确认（单事务；任一不符整批拒绝，不产生任何写入） ----------
function confirmBatch(db, rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  if (!body.confirmToken || typeof body.confirmToken !== 'object') {
    throw new BatchError(400, '缺少预览凭据 confirmToken，请先调用联展批次预览', { code: 'TOKEN_MISMATCH' });
  }
  const token = body.confirmToken;

  return db.transaction(() => {
    // 0) 凭据结构完整性
    const tokenIds = Array.isArray(token.packageIds)
      ? token.packageIds.map(Number)
      : null;
    const tokenPkgClaims = Array.isArray(token.packages) ? token.packages : null;
    if (token.kind !== 'joint-exhibition-batch-confirm'
      || !tokenIds || tokenIds.length < MIN_PACKAGES || tokenIds.length > MAX_PACKAGES
      || !tokenPkgClaims || tokenPkgClaims.length !== tokenIds.length
      || !Number.isInteger(Number(token.basisVersion))
      || tokenPkgClaims.some((c) => !c || typeof c.listFingerprint !== 'string' || typeof c.itineraryFingerprint !== 'string')) {
      throw new BatchError(409, '联展批次确认凭据内容不完整或已损坏，请重新预览', { code: 'TOKEN_MISMATCH' });
    }
    const normalizedTokenIds = [...new Set(tokenIds)].sort((a, b) => a - b);
    if (normalizedTokenIds.length !== tokenIds.length
      || tokenPkgClaims.some((c, i) => Number(c.packageId) !== normalizedTokenIds[i])) {
      throw new BatchError(409, '联展批次确认凭据中的包集合不一致或已损坏，请重新预览', { code: 'TOKEN_MISMATCH' });
    }

    // 1) 包集合逐包核对：存在、仍为待发布
    const contexts = normalizedTokenIds.map((id) => loadPackageContext(db, id));

    // 2) 共同依据版本未变
    const currentBasis = basisVersion(db);
    if (Number(token.basisVersion) !== currentBasis) {
      throw new BatchError(409,
        `预览后授权或来源关系已变更（依据版本 ${token.basisVersion} → ${currentBasis}），整批拒绝，请重新预览。`,
        { code: 'STALE_BASIS', clientBasis: Number(token.basisVersion), currentBasis });
    }

    // 3) 各包清单指纹 / 行程指纹未变
    const claimById = new Map(tokenPkgClaims.map((c) => [Number(c.packageId), c]));
    const changedPackages = [];
    for (const ctx of contexts) {
      const claim = claimById.get(ctx.pkg.id);
      const changes = [];
      if (claim.listFingerprint !== ctx.listFp) changes.push('list');
      if (claim.itineraryFingerprint !== ctx.itineraryFp) changes.push('itinerary');
      if (changes.length) {
        changedPackages.push({
          packageId: ctx.pkg.id,
          packageName: ctx.pkg.name,
          changed: changes,
        });
      }
    }
    if (changedPackages.length) {
      throw new BatchError(409,
        `预览后有 ${changedPackages.length} 个包的清单或行程被修改，整批拒绝，请重新预览。`,
        {
          code: 'PACKAGE_CHANGED',
          listChanged: changedPackages.filter((p) => p.changed.includes('list')).map((p) => p.packageId),
          itineraryChanged: changedPackages.filter((p) => p.changed.includes('itinerary')).map((p) => p.packageId),
          packages: changedPackages,
        });
    }

    // 4) 同一事务内按当前授权与来源关系重算【全部】包
    const results = contexts.map((ctx) => ({
      ctx,
      result: verifyStoredPackage(db, ctx.pkg, ctx.items, ctx.stopRows),
    }));
    const disqualified = results.filter((r) => !r.result.eligible);
    if (disqualified.length) {
      // 任一包重算失格：整批拒绝，不封存任何快照/凭证、不发布任何包
      throw new BatchError(422,
        `联展批次重算后有 ${disqualified.length} 个包不合格，整批拒绝：未产生快照、凭证或部分发布。请修正后重新预览。`,
        {
          code: 'RECOMPUTE_DISQUALIFIED',
          packages: disqualified.map((r) => ({
            packageId: r.ctx.pkg.id,
            packageName: r.ctx.pkg.name,
            multiStop: r.ctx.multiStop,
            globalErrors: r.result.globalErrors || [],
            itemErrors: r.result.itemErrors || [],
            stops: stopSummaries(r.ctx, r.result),
            result: r.result,
          })),
        });
    }

    // 5) 全部合格：先逐包封存不可变发布快照 + 签名凭证，再一起转为已发布。
    //    整个循环与状态翻转处于同一事务：任一插入失败（含不可变触发器）整体回滚。
    const createdAt = nowIso();
    const sealed = [];
    for (const { ctx, result } of results) {
      const payloadText = JSON.stringify(result);
      const snap = db.prepare(
        `INSERT INTO verification_snapshots(package_id, kind, basis_version, eligible, payload, created_at)
         VALUES (?,?,?,?,?,?)`
      ).run(ctx.pkg.id, 'publish', result.basisVersion, 1, payloadText, createdAt);
      const snapshotId = snap.lastInsertRowid;

      // 与单包发布完全同构的自包含签名凭证；sealContext 标注其经联展批次同事务封存
      const envelope = buildAttestation(db, {
        result,
        packageId: ctx.pkg.id,
        packageName: ctx.pkg.name,
        snapshotId,
        snapshotCreatedAt: createdAt,
        snapshotPayloadText: payloadText,
        sealContext: 'publish-batch',
      });
      const att = db.prepare(
        `INSERT INTO publish_attestations(package_id, verification_snapshot_id, signer_kid, seal_context, envelope, created_at)
         VALUES (?,?,?,?,?,?)`
      ).run(ctx.pkg.id, snapshotId, envelope.signature.kid, 'publish-batch', JSON.stringify(envelope), createdAt);

      sealed.push({
        packageId: ctx.pkg.id,
        packageName: ctx.pkg.name,
        multiStop: ctx.multiStop,
        snapshotId,
        attestationId: att.lastInsertRowid,
        envelope,
        result,
      });
    }

    // 全部快照/凭证封存成功后，再统一把整批翻转为 published
    const publishStmt = db.prepare(
      "UPDATE packages SET status='published', published_at=?, updated_at=? WHERE id=? AND status='draft'"
    );
    for (const ctx of contexts) {
      const info = publishStmt.run(createdAt, createdAt, ctx.pkg.id);
      if (info.changes !== 1) {
        // 防御性：事务内状态被并发翻转（正常单线程下不会到达）→ 整体回滚
        throw new BatchError(409,
          `包 #${ctx.pkg.id} 在批次提交时已不是待发布状态，整批拒绝。`,
          { code: 'NOT_DRAFT', packageId: ctx.pkg.id });
      }
    }

    return {
      sealedAt: createdAt,
      basisVersion: currentBasis,
      packageIds: normalizedTokenIds,
      packageCount: normalizedTokenIds.length,
      packages: sealed.map((s) => ({
        packageId: s.packageId,
        packageName: s.packageName,
        multiStop: s.multiStop,
        snapshotId: s.snapshotId,
        attestationId: s.attestationId,
        attestation: s.envelope,
        result: s.result,
      })),
    };
  })();
}

module.exports = {
  BatchError,
  previewBatch,
  confirmBatch,
  MIN_PACKAGES,
  MAX_PACKAGES,
};
