'use strict';

// 发布凭证（attestation）构建与封存。
//
// 凭证只在“发布成功”时、与不可变发布快照于同一事务内封存，内容包含：
//   当时的清单、完整来源子图、逐站行程、每个站×节点实际采用的未撤销授权
//   条款全文、全部来源路径，以及核验规则版本与规则参数；用本机持久化
//   Ed25519 密钥签发。凭证自包含——授权随后修改/删除不影响旧凭证。
//
// 补发（reissue）仅对升级前的旧发布快照开放，且只读快照 payload 本身：
// 旧快照若缺少证明所需字段（如多站节点路径、完整条款字段），明确拒绝，
// 绝不读取当前授权/来源表拼凑。

const crypto = require('crypto');
const { loadGraph } = require('./verify');
const keyring = require('./attest-keys');
const {
  RULES_VERSION,
  RULE_ALGORITHM,
  MAX_PATH_INSTANCES,
  MAX_CHAIN_DEPTH,
} = require('./rules');

const FORMAT = 'exhibit-package-attestation';
const ENVELOPE_VERSION = 1;

class UnsupportedSnapshotError extends Error {
  constructor(message, missingFields) {
    super(message);
    this.status = 422;
    this.details = { code: 'UNSUPPORTED_SNAPSHOT', missingFields };
  }
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeResult(result) {
  const multi = result.multiStop === true;
  const stops = multi
    ? (result.request.stops || []).map((s) => ({
      position: s.position,
      name: s.name,
      medium: s.medium,
      region: s.region,
      useFrom: s.useFrom,
      useTo: s.useTo,
    }))
    : [{
      position: 0,
      name: null,
      medium: result.request.medium,
      region: result.request.region,
      useFrom: result.request.useFrom,
      useTo: result.request.useTo,
    }];
  // 每个节点（含标题等）取一份；多站各站节点集合相同，取第一站即可
  const nodeRows = multi ? (result.stops && result.stops[0] ? result.stops[0].nodes : []) : result.nodes;
  return { multi, stops, nodeRows: nodeRows || [] };
}

// 从核验结果中取“节点 -> 全部来源路径”。
// 单站：挂在每个 node DTO 上；多站：来源链各站共享，只在顶层 nodePaths 封存一份。
function extractPathsMap(multi, result) {
  const map = new Map();
  if (multi) {
    for (const block of result.nodePaths || []) map.set(block.materialId, block.paths);
  } else {
    for (const n of result.nodes || []) map.set(n.materialId, n.paths);
  }
  return map;
}

// 由结果中实际采用的授权（matchedAuthorization）汇总站×节点采用关系
function extractAdoptions(multi, result) {
  const adoptions = [];
  if (multi) {
    for (const stop of result.stops || []) {
      for (const n of stop.nodes || []) {
        if (n.matchedAuthorization && n.matchedAuthorization.id != null) {
          adoptions.push({
            stopPosition: stop.position,
            materialId: n.materialId,
            authorizationId: n.matchedAuthorization.id,
          });
        }
      }
    }
  } else {
    for (const n of result.nodes || []) {
      if (n.matchedAuthorization && n.matchedAuthorization.id != null) {
        adoptions.push({ stopPosition: 0, materialId: n.materialId, authorizationId: n.matchedAuthorization.id });
      }
    }
  }
  adoptions.sort((a, b) => a.stopPosition - b.stopPosition || a.materialId - b.materialId);
  return adoptions
    .filter((v, i, arr) => i === 0 || arr[i - 1].stopPosition !== v.stopPosition || arr[i - 1].materialId !== v.materialId);
}

function rulesBlock() {
  return {
    version: RULES_VERSION,
    algorithm: RULE_ALGORITHM,
    maxChainDepth: MAX_CHAIN_DEPTH,
    maxPathInstances: MAX_PATH_INSTANCES,
    wildcard: '*',
    caseInsensitive: true,
    closedInterval: true,
    noSplitting: true,
  };
}

function termFromRow(a) {
  return {
    id: a.id,
    materialId: a.material_id,
    media: a.media,
    region: a.region,
    validFrom: a.valid_from,
    validTo: a.valid_to,
    revoked: false,
    licensor: a.licensor ?? null,
  };
}

// ---- 发布当时：同一事务内从数据库封存（db 为事务内连接/同一 better-sqlite3 实例）----
function buildAttestation(db, opts) {
  const {
    result,
    packageId,
    packageName,
    snapshotId,
    snapshotCreatedAt,
    snapshotPayloadText,
    sealContext = 'publish',
  } = opts;

  if (!result.eligible) {
    throw new Error('内部错误：不能为不合格结果签发凭证');
  }
  const { multi, stops, nodeRows } = normalizeResult(result);
  const nodeIds = new Set(nodeRows.map((n) => n.materialId));

  // 完整来源子图：发布当时重读全部来源边，取来源闭包内的诱导边（含关系标注）
  const adj = loadGraph(db);
  const linkRows = db.prepare(
    'SELECT material_id, source_material_id, relation FROM source_links ORDER BY material_id, source_material_id'
  ).all();
  const edges = linkRows
    .filter((l) => nodeIds.has(l.material_id) && nodeIds.has(l.source_material_id))
    .map((l) => ({ from: l.material_id, to: l.source_material_id, relation: l.relation }))
    .sort((a, b) => a.from - b.from || a.to - b.to);

  // 防御性一致性检查：结果中出现的每个来源跳转必须能由子图边解释
  const pathsMap = extractPathsMap(multi, result);
  const edgeSet = new Set(edges.map((e) => `${e.from}>${e.to}`));
  for (const paths of pathsMap.values()) {
    for (const p of paths || []) {
      for (let i = 0; i + 1 < p.length; i++) {
        const key = `${p[i].materialId}>${p[i + 1].materialId}`;
        if (!edgeSet.has(key)) {
          throw new Error(`内部错误：来源路径边 ${key} 不在封存子图内`);
        }
      }
    }
  }
  if (multi) {
    // 多站结果必须在顶层封存全部来源路径（本版本 verifyMultiStop 已输出），否则不签发
    for (const n of nodeRows) {
      if (!Array.isArray(pathsMap.get(n.materialId))) {
        throw new Error(`内部错误：多站节点 #${n.materialId} 缺少来源路径，拒绝签发`);
      }
    }
  }

  const adoptions = extractAdoptions(multi, result);

  // 每个实际采用的授权：发布当时重读条款全文并断言未撤销
  const termIds = [...new Set(adoptions.map((a) => a.authorizationId))].sort((a, b) => a - b);
  const getAuth = db.prepare('SELECT * FROM authorizations WHERE id=?');
  const terms = [];
  for (const aid of termIds) {
    const row = getAuth.get(aid);
    if (!row) throw new Error(`内部错误：采用的授权 #${aid} 在发布事务内已不存在，拒绝签发`);
    if (row.revoked) throw new Error(`内部错误：采用的授权 #${aid} 已撤销，拒绝签发`);
    terms.push(termFromRow(row));
  }

  const body = {
    format: FORMAT,
    envelopeVersion: ENVELOPE_VERSION,
    kind: 'publish-credential',
    sealContext,
    packageId,
    packageName: packageName ?? null,
    snapshotId,
    snapshotKind: 'publish',
    snapshotCreatedAt: snapshotCreatedAt ?? null,
    snapshotPayloadSha256: snapshotPayloadText ? sha256Hex(snapshotPayloadText) : null,
    sealedAt: new Date().toISOString(),
    basisVersion: result.basisVersion,
    rules: rulesBlock(),
    multiStop: multi,
    manifest: { materialIds: [...(result.request.materialIds || [])].sort((a, b) => a - b) },
    materials: nodeRows
      .map((n) => ({ materialId: n.materialId, title: n.title, kind: n.kind ?? null }))
      .sort((a, b) => a.materialId - b.materialId),
    sourceSubgraph: { edges },
    itinerary: {
      multiStop: multi,
      stops: stops
        .map((s) => ({
          position: s.position, name: s.name ?? null, medium: s.medium,
          region: s.region, useFrom: s.useFrom, useTo: s.useTo,
        }))
        .sort((a, b) => a.position - b.position),
    },
    terms,
    adoptions,
    paths: [...pathsMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([materialId, paths]) => ({
        materialId,
        paths: (paths || [])
          .map((p) => p.map((x) => ({ materialId: x.materialId, title: x.title })))
          .map((p) => JSON.stringify(p))
          .sort()
          .map((p) => JSON.parse(p)),
      })),
  };

  return sealBody(body);
}

function sealBody(body) {
  const signature = keyring.sign(keyring.canonicalJSON(body));
  return {
    format: body.format,
    envelopeVersion: body.envelopeVersion,
    body,
    signature: {
      algorithm: signature.algorithm,
      kid: signature.kid,
      value: signature.signature,
    },
  };
}

// ---- 旧发布快照补发：只读快照 payload，不读当前授权/来源 ----
function buildAttestationFromSnapshot(opts) {
  const { snapshot, packageName = null } = opts;
  let result;
  try {
    result = JSON.parse(snapshot.payload);
  } catch {
    throw new UnsupportedSnapshotError('快照 payload 不是合法 JSON，无法补发凭证', ['payload']);
  }

  const missing = [];
  const multi = result.multiStop === true;
  const req = result.request || {};
  if (!Array.isArray(req.materialIds)) missing.push('request.materialIds');
  let stops;
  if (multi) {
    if (!Array.isArray(req.stops) || req.stops.length < 2) {
      missing.push('request.stops');
      stops = [];
    } else {
      stops = req.stops.map((s) => ({
        position: s.position, name: s.name ?? null, medium: s.medium, region: s.region,
        useFrom: s.useFrom, useTo: s.useTo,
      }));
    }
  } else {
    stops = [{
      position: 0, name: null,
      medium: req.medium, region: req.region, useFrom: req.useFrom, useTo: req.useTo,
    }];
    if (!req.medium || !req.region || !req.useFrom || !req.useTo) {
      missing.push('request.medium/region/useFrom/useTo');
    }
  }
  if (result.basisVersion === undefined) missing.push('basisVersion');

  const nodeSource = multi ? (result.stops && result.stops[0] ? result.stops[0].nodes : null) : result.nodes;
  if (!Array.isArray(nodeSource)) missing.push(multi ? 'stops[0].nodes' : 'nodes');

  const materials = [];
  const pathsEntries = [];
  const adoptions = [];

  // 多站：来源路径各站共享，旧快照须在顶层 nodePaths 完整封存（本版本才有）；
  // 旧版多站快照只在 failingNodes 里带部分路径，不能据此补发——明确拒绝。
  if (multi) {
    if (!Array.isArray(result.nodePaths)) {
      missing.push('nodePaths');
    } else {
      const npIds = new Set();
      for (const block of result.nodePaths) {
        npIds.add(block.materialId);
        if (!Array.isArray(block.paths)) {
          missing.push(`nodePaths[materialId=${block.materialId}].paths`);
        } else {
          pathsEntries.push([block.materialId, block.paths]);
        }
      }
      if (Array.isArray(nodeSource)) {
        for (const n of nodeSource) {
          if (!npIds.has(n.materialId)) missing.push(`nodePaths[materialId=${n.materialId}]`);
        }
      }
    }
  }

  if (Array.isArray(nodeSource)) {
    for (const n of nodeSource) {
      materials.push({ materialId: n.materialId, title: n.title, kind: n.kind ?? null });
      if (!multi && !Array.isArray(n.paths)) {
        missing.push(`nodes[materialId=${n.materialId}].paths`);
      } else if (!multi) {
        pathsEntries.push([n.materialId, n.paths]);
      }
    }
  }

  // 条款：旧快照仅封存“实际采用”的那一份（matchedAuthorization，4 个字段）
  const termMap = new Map();
  const pushAdoption = (stopPosition, n) => {
    const m = n.matchedAuthorization;
    if (!m || m.id == null) {
      missing.push(`nodes[materialId=${n.materialId}].matchedAuthorization`);
      return;
    }
    for (const f of ['media', 'region', 'validFrom', 'validTo']) {
      if (m[f] === undefined || m[f] === null) {
        missing.push(`nodes[materialId=${n.materialId}].matchedAuthorization.${f}`);
      }
    }
    adoptions.push({ stopPosition, materialId: n.materialId, authorizationId: m.id });
    if (!termMap.has(m.id)) {
      termMap.set(m.id, {
        id: m.id,
        materialId: n.materialId,
        media: m.media,
        region: m.region,
        validFrom: m.validFrom,
        validTo: m.validTo,
        revoked: false,
        licensor: null,
      });
    }
  };

  if (multi) {
    if (!Array.isArray(result.stops)) {
      missing.push('stops');
    } else {
      for (const stop of result.stops) {
        for (const n of stop.nodes || []) pushAdoption(stop.position, n);
      }
    }
  } else {
    for (const n of result.nodes || []) pushAdoption(0, n);
  }

  if (missing.length) {
    throw new UnsupportedSnapshotError(
      '该旧快照缺少离线证明所需字段，拒绝补发凭证（不能用当前授权拼凑；请在升级后重新核验并发布新包以获得凭证）',
      [...new Set(missing)].sort()
    );
  }

  // 来源子图只能由路径重建：旧快照未存关系标注，relation 置 null
  const nodeIds = new Set(materials.map((m) => m.materialId));
  const edgeSet = new Set();
  for (const [, paths] of pathsEntries) {
    for (const p of paths) {
      for (let i = 0; i + 1 < p.length; i++) {
        const from = p[i].materialId;
        const to = p[i + 1].materialId;
        nodeIds.add(from);
        nodeIds.add(to);
        edgeSet.add(`${from}>${to}`);
      }
    }
  }
  for (const id of nodeIds) {
    if (!materials.some((m) => m.materialId === id)) {
      materials.push({ materialId: id, title: null, kind: null });
    }
  }
  const edges = [...edgeSet]
    .map((k) => { const [from, to] = k.split('>').map(Number); return { from, to, relation: null }; })
    .sort((a, b) => a.from - b.from || a.to - b.to);

  adoptions.sort((a, b) => a.stopPosition - b.stopPosition || a.materialId - b.materialId);
  const body = {
    format: FORMAT,
    envelopeVersion: ENVELOPE_VERSION,
    kind: 'publish-credential',
    sealContext: 'reissue-from-snapshot',
    packageId: snapshot.package_id,
    packageName,
    snapshotId: snapshot.id,
    snapshotKind: snapshot.kind,
    snapshotCreatedAt: snapshot.created_at ?? null,
    snapshotPayloadSha256: sha256Hex(snapshot.payload),
    sealedAt: new Date().toISOString(),
    basisVersion: result.basisVersion,
    // 旧快照产生于规则版本化之前：按历史规则 1.0.0 解释，并显式标注
    rules: { ...rulesBlock(), version: RULES_VERSION, legacySnapshot: true },
    multiStop: multi,
    manifest: { materialIds: [...req.materialIds].sort((a, b) => a - b) },
    materials: materials.sort((a, b) => a.materialId - b.materialId),
    sourceSubgraph: { edges },
    itinerary: { multiStop: multi, stops },
    terms: [...termMap.values()].sort((a, b) => a.id - b.id),
    adoptions,
    paths: pathsEntries
      .sort((a, b) => a[0] - b[0])
      .map(([materialId, paths]) => ({
        materialId,
        paths: paths.map((p) => JSON.stringify(p)).sort().map((p) => JSON.parse(p)),
      })),
  };

  return sealBody(body);
}

module.exports = {
  FORMAT,
  ENVELOPE_VERSION,
  buildAttestation,
  buildAttestationFromSnapshot,
  sealBody,
  UnsupportedSnapshotError,
};
