#!/usr/bin/env node
'use strict';

// 独立离线发布凭证校验程序。
//
// 仅凭【凭证文件】与【对应公开密钥（一把或多把，含轮换前旧公钥）】工作，
// 不连接、不依赖馆内任何数据库或其它源码文件（本文件零第三方依赖，
// 仅使用 Node.js 内置 crypto/fs，可单独拷贝到审计环境运行）。
//
// 它会复算：
//   1. 签名（Ed25519，确定性 canonical JSON）；
//   2. 来源子图完整性（清单根节点沿边的可达闭包、成环、深度/路径上限，
//      并独立重算每个节点的全部来源路径后与封存路径逐一比对）；
//   3. 逐站整段覆盖（每站每个节点采用的那份未撤销条款是否独自覆盖该站
//           媒介/地区/闭区间展期——短授权不可拼接）。
// 输出逐站结论；任何不一致都给出明确篡改/失配原因。
//
// 用法：
//   node scripts/verify-attestation.js <凭证.json|-> [公钥.pem ...] [--key=pub.pem] [--json]
//     <凭证.json|->                 凭证文件路径；- 表示从标准输入读取
//     公钥.pem / --key=公钥.pem      一个或多个可信公钥（PEM，SPKI）；
//                                   不给定时读取环境变量 ATTEST_TRUSTED_KEYS
//                                   指向的文件（多把公钥可依次放在同一文件）
//     --json                        机器可读 JSON（默认输出人读结论）
//
// 退出码：0 = 凭证有效；1 = 凭证无效/被篡改/密钥不受信；2 = 用法或输入错误。

const fs = require('fs');
const crypto = require('crypto');

// ---------- 历史规则（v1.0.0）：离线端固化，规则升级后旧凭证仍按此解释 ----------
const SUPPORTED_RULES = {
  '1.0.0': {
    algorithm: 'wildcard-scope-closed-interval-v1',
    maxChainDepth: 100,
    maxPathInstances: 5000,
    wildcard: '*',
    caseInsensitive: true,
    closedInterval: true,
    noSplitting: true,
  },
};

function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function scopeMatches(authValue, wanted) {
  if (authValue === '*') return true;
  return String(authValue).trim().toLowerCase() === String(wanted).trim().toLowerCase();
}

// 与发布端一致的全路径枚举（含相同的深度与路径实例上限）
function enumeratePaths(adj, root, maxDepth, maxInstances) {
  const nodePaths = new Map();
  const cyclicNodes = new Set();
  let truncated = false;
  let tooDeep = false;

  const pushPath = (stack) => {
    const id = stack[stack.length - 1];
    if (!nodePaths.has(id)) nodePaths.set(id, []);
    const list = nodePaths.get(id);
    const key = stack.join('>');
    if (!list.some((p) => p.join('>') === key)) list.push(stack.slice());
  };

  const dfs = (stack) => {
    if (truncated) return;
    pushPath(stack);
    if (stack.length > maxDepth) { tooDeep = true; return; }
    for (const kid of adj.get(stack[stack.length - 1]) || []) {
      if (truncated) return;
      if (stack.includes(kid)) { cyclicNodes.add(kid); continue; }
      stack.push(kid);
      dfs(stack);
      stack.pop();
      let total = 0;
      for (const arr of nodePaths.values()) total += arr.length;
      if (total >= maxInstances) { truncated = true; return; }
    }
  };

  dfs([root]);
  return { nodePaths, cyclicNodes, truncated, tooDeep };
}

function reason(code, message, extra) {
  return { code, message, ...(extra || {}) };
}

/**
 * 核心校验：输入凭证信封 + 可信公钥集合（PEM 字符串数组，或 {publicKeyPem}）。
 * 不读取数据库、不访问网络；尽量累积全部问题后统一返回。
 */
function verifyAttestation(envelope, trustedKeys) {
  const tamperReasons = [];
  const keys = (trustedKeys || []).map((k) => (k && typeof k === 'object' ? k.publicKeyPem : k)).filter(Boolean);
  const keyObjects = [];
  for (const pem of keys) {
    try { keyObjects.push(crypto.createPublicKey(pem)); } catch { /* 跳过坏 PEM */ }
  }

  const add = (r) => { if (!tamperReasons.some((x) => x.code === r.code && JSON.stringify(x) === JSON.stringify(r))) tamperReasons.push(r); };

  let body = null;
  let sigInfo = null;
  let envelopeOk = true;
  if (!envelope || typeof envelope !== 'object') {
    add(reason('ENVELOPE_MALFORMED', '凭证不是 JSON 对象'));
    envelopeOk = false;
  } else {
    body = envelope.body;
    sigInfo = envelope.signature;
    if (!body || typeof body !== 'object') {
      add(reason('ENVELOPE_MALFORMED', '凭证缺少 body'));
      envelopeOk = false;
    }
    if (!sigInfo || typeof sigInfo.value !== 'string') {
      add(reason('SIGNATURE_MISSING', '凭证缺少 signature.value'));
    }
    if (envelope.format !== 'exhibit-package-attestation') {
      add(reason('ENVELOPE_FORMAT_UNKNOWN', `凭证 format 不是 exhibit-package-attestation（实际 ${envelope.format}）`));
    }
  }

  // 1) 签名
  let validSignature = false;
  let signingKeyTrusted = false;
  if (envelopeOk && sigInfo && typeof sigInfo.value === 'string') {
    const message = Buffer.from(canonicalJSON(body), 'utf8');
    const sig = Buffer.from(sigInfo.value, 'base64');
    if (sig.toString('base64') !== sigInfo.value.replace(/\s/g, '')) {
      add(reason('SIGNATURE_MALFORMED', '签名不是合法 base64'));
    }
    for (const key of keyObjects) {
      try {
        if (crypto.verify(null, message, key, sig)) {
          validSignature = true;
          signingKeyTrusted = true;
          break;
        }
      } catch { /* 试下一把 */ }
    }
    if (!validSignature) {
      add(keys.length === 0
        ? reason('SIGNING_KEY_NOT_TRUSTED', '未提供任何可信公钥，无法验证签名（请用签发端导出的公钥，含轮换前旧公钥）')
        : reason('SIGNATURE_INVALID', '签名与任何可信公钥均不匹配：凭证 body 已被篡改或公钥不对应'));
    }
  }

  const out = {
    conclusion: 'FAIL',
    validSignature,
    signingKeyTrusted,
    signerKid: sigInfo ? sigInfo.kid : null,
    rulesVersion: body && body.rules ? body.rules.version : null,
    packageId: body ? body.packageId : null,
    packageName: body ? body.packageName : null,
    snapshotId: body ? body.snapshotId : null,
    sealContext: body ? body.sealContext : null,
    basisVersion: body ? body.basisVersion : null,
    multiStop: body ? !!body.multiStop : null,
    stops: [],
    sourceChain: { complete: false, reachableNodeIds: [], cycleNodes: [], truncated: false, tooDeep: false },
    tamperReasons,
  };
  if (!envelopeOk) {
    out.ok = false;
    return finalize(out);
  }

  // 2) 规则版本与参数
  const rules = body.rules;
  let maxDepth = 100;
  let maxInstances = 5000;
  if (!rules || typeof rules.version !== 'string') {
    add(reason('RULES_VERSION_MISSING', '凭证缺少核验规则版本 rules.version'));
  } else {
    const expected = SUPPORTED_RULES[rules.version];
    if (!expected) {
      add(reason('UNSUPPORTED_RULES_VERSION', `离线校验程序不支持规则版本 ${rules.version}（支持：${Object.keys(SUPPORTED_RULES).join(', ')}），请更新校验程序`));
    } else {
      maxDepth = expected.maxChainDepth;
      maxInstances = expected.maxPathInstances;
      for (const [k, v] of Object.entries(expected)) {
        if (rules[k] !== v) {
          add(reason('RULE_PARAMS_MISMATCH', `规则参数 ${k} 被改动：封存值 ${JSON.stringify(rules[k])}，版本 ${rules.version} 要求 ${JSON.stringify(v)}`, { param: k }));
        }
      }
    }
  }

  // 3) 结构字段
  const manifestIds = Array.isArray(body.manifest && body.manifest.materialIds)
    ? body.manifest.materialIds : null;
  if (!manifestIds) add(reason('MANIFEST_MISSING', '凭证缺少清单 manifest.materialIds'));
  const materials = Array.isArray(body.materials) ? body.materials : null;
  if (!materials) add(reason('MATERIALS_MISSING', '凭证缺少 materials 节点清单'));
  const edges = body.sourceSubgraph && Array.isArray(body.sourceSubgraph.edges)
    ? body.sourceSubgraph.edges : null;
  if (!edges) add(reason('SUBGRAPH_MISSING', '凭证缺少来源子图 sourceSubgraph.edges'));
  const stops = body.itinerary && Array.isArray(body.itinerary.stops)
    ? body.itinerary.stops : null;
  if (!stops) add(reason('ITINERARY_MISSING', '凭证缺少逐站行程 itinerary.stops'));
  const terms = Array.isArray(body.terms) ? body.terms : null;
  if (!terms) add(reason('TERMS_MISSING', '凭证缺少实际采用的授权条款 terms'));
  const adoptions = Array.isArray(body.adoptions) ? body.adoptions : null;
  if (!adoptions) add(reason('ADOPTIONS_MISSING', '凭证缺少站×节点采用关系 adoptions'));
  const pathsBlock = Array.isArray(body.paths) ? body.paths : null;
  if (!pathsBlock) add(reason('PATHS_MISSING', '凭证缺少全部来源路径 paths'));

  if (body.itinerary && body.itinerary.multiStop !== body.multiStop) {
    add(reason('MULTI_STOP_FLAG_MISMATCH', 'body.multiStop 与 itinerary.multiStop 不一致'));
  }

  // 行程合法性（与发布端同一套规则：多站 ≥2、相邻不重叠、日期/媒介/地区合法）
  const validStops = [];
  if (stops) {
    if (body.multiStop && stops.length < 2) {
      add(reason('ITINERARY_INVALID', `多站凭证行程不足 2 站（实际 ${stops.length} 站）`));
    }
    const positions = new Set();
    for (const s of stops) {
      const probs = [];
      if (!Number.isInteger(s.position) || positions.has(s.position)) probs.push('position 缺失或重复');
      positions.add(s.position);
      if (body.multiStop && !s.name) probs.push('缺站点名称');
      if (!s.medium) probs.push('缺媒介');
      if (!s.region) probs.push('缺地区');
      if (!isValidDate(s.useFrom)) probs.push(`起始日期不合法：${s.useFrom}`);
      if (!isValidDate(s.useTo)) probs.push(`截止日期不合法：${s.useTo}`);
      if (isValidDate(s.useFrom) && isValidDate(s.useTo) && s.useFrom > s.useTo) probs.push('起始晚于截止');
      if (probs.length) {
        add(reason('STOP_INVALID', `第 ${s.position} 站「${s.name || ''}」行程不合法：${probs.join('；')}`, { stopPosition: s.position }));
      } else {
        validStops.push(s);
      }
    }
    const byPos = [...stops].sort((a, b) => a.position - b.position);
    for (let i = 1; i < byPos.length; i++) {
      const prev = byPos[i - 1];
      const cur = byPos[i];
      if (isValidDate(prev.useFrom) && isValidDate(prev.useTo) && isValidDate(cur.useFrom)
        && cur.useFrom <= prev.useTo) {
        add(reason('STOPS_OVERLAP',
          `第 ${prev.position} 站展期至 ${prev.useTo}，与第 ${cur.position} 站起始 ${cur.useFrom} 重叠（首尾日均占用）`));
      }
    }
  }

  // 4) 来源子图复算
  const materialMap = new Map();
  const reachable = new Set();
  const adj = new Map();
  let structuralOk = !!(manifestIds && materials && edges && adoptions && pathsBlock);

  if (materials) {
    for (const m of materials) {
      if (!Number.isInteger(m.materialId)) { add(reason('MATERIAL_BAD_ID', `materials 中存在非法节点：${JSON.stringify(m)}`)); structuralOk = false; continue; }
      if (materialMap.has(m.materialId)) add(reason('MATERIAL_DUPLICATE', `节点 #${m.materialId} 在 materials 中重复`));
      materialMap.set(m.materialId, m);
    }
  }
  if (edges) {
    const edgeSet = new Set();
    for (const e of edges) {
      if (!Number.isInteger(e.from) || !Number.isInteger(e.to)) {
        add(reason('EDGE_MALFORMED', `子图边非法：${JSON.stringify(e)}`)); structuralOk = false; continue;
      }
      const key = `${e.from}>${e.to}`;
      if (edgeSet.has(key)) add(reason('EDGE_DUPLICATE', `子图边重复：${key}`));
      edgeSet.add(key);
      if (materials && (!materialMap.has(e.from) || !materialMap.has(e.to))) {
        add(reason('EDGE_NODE_UNKNOWN', `子图边 ${key} 引用了 materials 之外的节点`)); structuralOk = false;
      }
      if (!adj.has(e.from)) adj.set(e.from, []);
      if (!adj.get(e.from).includes(e.to)) adj.get(e.from).push(e.to);
    }
  }

  if (manifestIds) {
    for (const id of manifestIds) {
      if (!Number.isInteger(id)) { add(reason('MANIFEST_BAD_ID', `清单含非法素材 id：${id}`)); structuralOk = false; continue; }
      if (materials && !materialMap.has(id)) {
        add(reason('MANIFEST_NODE_MISSING', `清单素材 #${id} 不在 materials 节点集中`)); structuralOk = false;
      }
    }
    // 可达闭包 + 全部来源路径独立复算（根顺序固定，边按 id 升序，保证确定性）
    if (edges && materials) {
      for (const id of [...adj.keys()].sort((a, b) => a - b)) adj.set(id, [...new Set(adj.get(id))].sort((a, b) => a - b));
      const recomputedPaths = new Map();
      let anyTruncated = false;
      let anyTooDeep = false;
      const cycleAll = new Set();
      for (const root of manifestIds) {
        const { nodePaths, cyclicNodes, truncated, tooDeep } = enumeratePaths(adj, root, maxDepth, maxInstances);
        anyTruncated = anyTruncated || truncated;
        anyTooDeep = anyTooDeep || tooDeep;
        for (const id of cyclicNodes) cycleAll.add(id);
        reachable.add(root);
        for (const [nid, paths] of nodePaths) {
          reachable.add(nid);
          if (!recomputedPaths.has(nid)) recomputedPaths.set(nid, []);
          const list = recomputedPaths.get(nid);
          for (const p of paths) {
            const key = p.join('>');
            if (!list.some((x) => x.join('>') === key)) list.push(p);
          }
        }
      }
      out.sourceChain = {
        complete: false,
        reachableNodeIds: [...reachable].sort((a, b) => a - b),
        cycleNodes: [...cycleAll].sort((a, b) => a - b),
        truncated: anyTruncated,
        tooDeep: anyTooDeep,
      };

      if (cycleAll.size) {
        add(reason('CYCLE_DETECTED', `来源子图成环，环上节点：${[...cycleAll].sort((a, b) => a - b).join(', ')}`));
        structuralOk = false;
      }
      if (anyTooDeep) { add(reason('CHAIN_DEPTH_EXCEEDED', `来源链深度超过规则上限 ${maxDepth}`)); structuralOk = false; }
      if (anyTruncated) { add(reason('PATH_INSTANCE_LIMIT_EXCEEDED', `来源路径实例超过规则上限 ${maxInstances}，复算被截断，不能据此放行`)); structuralOk = false; }

      // 子图完整性：封存节点必须全部可由清单到达；可达边必须全部出现在子图中（不可漏边）
      for (const m of materials) {
        if (!reachable.has(m.materialId)) {
          add(reason('ORPHAN_MATERIAL', `节点 #${m.materialId} 不能由任何清单素材沿来源边到达：子图被增补或清单被删减`));
          structuralOk = false;
        }
      }
      for (const id of reachable) {
        if (!materialMap.has(id)) {
          add(reason('REACHABLE_NODE_MISSING', `来源闭包节点 #${id} 未列入 materials`));
          structuralOk = false;
        }
      }

      // 封存 paths 与独立复算结果逐一比对（路径形状，忽略标题）
      if (pathsBlock) {
        const sealedMap = new Map(pathsBlock.map((p) => [p.materialId, p.paths || []]));
        const allIds = new Set([...recomputedPaths.keys(), ...sealedMap.keys()]);
        for (const id of allIds) {
          const calc = new Set((recomputedPaths.get(id) || []).map((p) => p.join('>')));
          const got = new Set((sealedMap.get(id) || []).map((p) => (p || []).map((x) => x.materialId).join('>')));
          for (const bad of [...got].filter((k) => k === '' || k.split('>').some((x) => !/^\d+$/.test(x)))) {
            add(reason('PATH_MALFORMED', `节点 #${id} 的封存路径格式非法：${bad}`)); structuralOk = false;
          }
          for (const k of got) {
            if (!calc.has(k)) {
              add(reason('PATH_FORGED', `节点 #${id} 的封存路径 ${k} 在复算来源子图中不存在（路径被伪造或边被删改）`)); structuralOk = false;
            }
          }
          for (const k of calc) {
            if (!got.has(k)) {
              add(reason('PATH_OMITTED', `节点 #${id} 缺少复算所得来源路径 ${k}（路径被删漏）`)); structuralOk = false;
            }
          }
        }
        // 路径上的节点/标题一致性
        for (const block of pathsBlock) {
          for (const p of block.paths || []) {
            for (const x of p) {
              if (!materialMap.has(x.materialId)) {
                add(reason('PATH_NODE_UNKNOWN', `节点 #${block.materialId} 的路径引用未知节点 #${x.materialId}`)); structuralOk = false;
              } else if (x.title !== undefined && materialMap.get(x.materialId).title !== null
                && x.title !== materialMap.get(x.materialId).title) {
                add(reason('PATH_TITLE_MISMATCH', `路径中节点 #${x.materialId} 标题与 materials 不一致`));
              }
            }
            if (manifestIds && p.length && !manifestIds.includes(p[0].materialId)) {
              add(reason('PATH_NOT_ROOTED', `节点 #${block.materialId} 的路径未从清单素材开始：${(p || []).map((x) => x.materialId).join('>')}`));
              structuralOk = false;
            }
          }
        }
      }
    }
  }
  out.sourceChain.complete = structuralOk && reachable.size > 0
    && (!materials || materials.every((m) => reachable.has(m.materialId)));

  // 5) 条款
  const termMap = new Map();
  if (terms) {
    for (const t of terms) {
      if (!Number.isInteger(t.id) || !Number.isInteger(t.materialId)) {
        add(reason('TERM_MALFORMED', `条款字段非法：${JSON.stringify(t)}`)); continue;
      }
      if (termMap.has(t.id)) add(reason('TERM_DUPLICATE', `授权条款 #${t.id} 重复`));
      if (t.revoked === true) add(reason('TERM_REVOKED', `封存条款 #${t.id} 标记为已撤销，不能作为采用依据`));
      if (!t.media || !t.region || !isValidDate(t.validFrom) || !isValidDate(t.validTo)
        || t.validFrom > t.validTo) {
        add(reason('TERM_INVALID', `条款 #${t.id} 媒介/地区/有效期字段不完整或非法`));
      }
      termMap.set(t.id, t);
    }
  }

  // 6) 逐站整段覆盖复算
  const nodeIdsForStops = materials ? materials.map((m) => m.materialId).sort((a, b) => a - b) : [];
  const adoptionMap = new Map();
  if (adoptions) {
    for (const a of adoptions) {
      const key = `${a.stopPosition}>${a.materialId}`;
      if (adoptionMap.has(key)) {
        add(reason('ADOPTION_DUPLICATE', `第 ${a.stopPosition} 站节点 #${a.materialId} 出现多份采用关系（同站不可拼接）`));
      }
      adoptionMap.set(key, a);
    }
  }

  const stopConclusions = (stops || []).map((s) => {
    const nodeResults = nodeIdsForStops.map((nid) => {
      const nodeReasons = [];
      const a = adoptionMap.get(`${s.position}>${nid}`);
      let coveredBy = null;
      if (!a) {
        nodeReasons.push(reason('ADOPTION_MISSING', `第 ${s.position} 站节点 #${nid} 缺少实际采用授权`));
      } else {
        const t = termMap.get(a.authorizationId);
        if (!t) {
          nodeReasons.push(reason('TERM_MISSING', `第 ${s.position} 站节点 #${nid} 采用的授权 #${a.authorizationId} 不在条款封存中`));
        } else {
          if (t.materialId !== nid) {
            nodeReasons.push(reason('TERM_WRONG_NODE', `授权 #${t.id} 属于节点 #${t.materialId}，被用于节点 #${nid}`));
          }
          if (t.revoked === true) nodeReasons.push(reason('TERM_REVOKED', `采用的授权 #${t.id} 已撤销`));
          if (!scopeMatches(t.media, s.medium)) {
            nodeReasons.push(reason('MEDIA_MISMATCH', `授权 #${t.id} 媒介「${t.media}」不覆盖本站媒介「${s.medium}」`));
          }
          if (!scopeMatches(t.region, s.region)) {
            nodeReasons.push(reason('REGION_MISMATCH', `授权 #${t.id} 地区「${t.region}」不覆盖本站地区「${s.region}」`));
          }
          if (!(t.validFrom <= s.useFrom && t.validTo >= s.useTo)) {
            nodeReasons.push(reason('DATE_NOT_COVERED',
              `授权 #${t.id} 有效期 ${t.validFrom}~${t.validTo} 不能独自覆盖本站整段 ${s.useFrom}~${s.useTo}（短授权不可拼接）`));
          }
          coveredBy = t.id;
        }
      }
      if (nodeReasons.length) nodeReasons.forEach((r) => add({ ...r, stopPosition: s.position, materialId: nid }));
      return { materialId: nid, coveredByAuthorizationId: coveredBy, eligible: nodeReasons.length === 0,
        reasons: nodeReasons.map((r) => ({ code: r.code, message: r.message })) };
    });
    // 反向检查：采用关系引用了不存在的站/节点
    if (adoptions) {
      for (const a of adoptions.filter((x) => x.stopPosition === s.position)) {
        if (!nodeIdsForStops.includes(a.materialId)) {
          add(reason('ADOPTION_UNKNOWN_NODE', `第 ${s.position} 站采用关系引用未知节点 #${a.materialId}`));
        }
      }
    }
    const eligible = nodeResults.length > 0 && nodeResults.every((n) => n.eligible)
      && isValidDate(s.useFrom) && isValidDate(s.useTo) && !!s.medium && !!s.region;
    return {
      position: s.position, name: s.name || null, medium: s.medium, region: s.region,
      useFrom: s.useFrom, useTo: s.useTo, eligible,
      nodeCount: nodeResults.length, failingNodes: nodeResults.filter((n) => !n.eligible).map((n) => n.materialId),
      nodes: nodeResults,
    };
  });
  out.stops = stopConclusions;

  if (adoptions) {
    const stopPositions = new Set((stops || []).map((s) => s.position));
    for (const a of adoptions) {
      if (!stopPositions.has(a.stopPosition)) {
        add(reason('ADOPTION_UNKNOWN_STOP', `采用关系引用了不存在的站次 ${a.stopPosition}`));
      }
    }
  }

  const allStopsCovered = stopConclusions.length > 0 && stopConclusions.every((s) => s.eligible);
  const flagsOk = body.multiStop ? (stops && stops.length >= 2) : true;
  const overall = validSignature && structuralOk && allStopsCovered && flagsOk
    && !stopConclusions.some((s) => s.failingNodes.length > 0);
  out.conclusion = overall ? 'PASS' : 'FAIL';
  out.ok = overall;
  return out;
}

function finalize(out) {
  out.ok = out.conclusion === 'PASS';
  return out;
}

// ---------- CLI ----------
function readAllPem(file) {
  const text = fs.readFileSync(file, 'utf8');
  // 一个文件里可放多把 PEM 公钥
  return text.split(/(?=-----BEGIN PUBLIC KEY-----)/).map((s) => s.trim()).filter((s) => s.startsWith('-----BEGIN'));
}

function parseArgs(argv) {
  const args = { keys: [], json: false, file: null };
  for (const a of argv) {
    if (a === '--json') args.json = true;
    else if (a.startsWith('--key=')) args.keys.push(...readAllPem(a.slice(6)));
    else if (!args.file) args.file = a;
    else args.keys.push(...readAllPem(a));
  }
  return args;
}

function renderHuman(out) {
  const lines = [];
  lines.push(`结论：${out.conclusion === 'PASS' ? '通过 ✅' : '不通过 ❌'}`);
  lines.push(`包 #${out.packageId}${out.packageName ? '「' + out.packageName + '」' : ''}　发布快照 #${out.snapshotId}　封存场景：${out.sealContext || '?'}`);
  lines.push(`签名：${out.validSignature ? '有效' : '无效'}（kid=${out.signerKid || '?'}，可信密钥：${out.signingKeyTrusted ? '是' : '否'}）　规则版本：${out.rulesVersion || '?'}　依据版本：${out.basisVersion}`);
  lines.push(`来源链复算：${out.sourceChain.complete ? '完整' : '不完整'}（可达节点 ${out.sourceChain.reachableNodeIds.length} 个`
    + `${out.sourceChain.cycleNodes.length ? '，成环节点 ' + out.sourceChain.cycleNodes.join(',') : ''}`
    + `${out.sourceChain.truncated ? '，路径截断' : ''}${out.sourceChain.tooDeep ? '，超深' : ''}）`);
  lines.push('逐站结论：');
  for (const s of out.stops) {
    lines.push(`  第 ${s.position} 站「${s.name || '（单站）'}」 ${s.medium || '?'} / ${s.region || '?'} / ${s.useFrom || '?'}~${s.useTo || '?'}：`
      + `${s.eligible ? '整段覆盖 ✅' : '不通过 ❌'}（节点 ${s.nodeCount} 个`
      + `${s.failingNodes.length ? '，失格：#' + s.failingNodes.join(', #') : ''}）`);
    for (const n of s.nodes.filter((x) => !x.eligible)) {
      for (const r of n.reasons) lines.push(`      - 节点 #${n.materialId}：[${r.code}] ${r.message}`);
    }
  }
  if (out.tamperReasons.length) {
    lines.push('篡改/失配原因（独立复算发现）：');
    for (const r of out.tamperReasons) {
      const where = [r.stopPosition !== undefined ? `第${r.stopPosition}站` : null,
        r.materialId !== undefined ? `节点#${r.materialId}` : null].filter(Boolean).join(' ');
      lines.push(`  - [${r.code}]${where ? ' ' + where : ''} ${r.message}`);
    }
  }
  return lines.join('\n');
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('用法: node verify-attestation.js <凭证.json|-> [公钥.pem ...] [--key=pub.pem] [--json]');
    process.exit(2);
  }
  let raw;
  try {
    raw = args.file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(args.file, 'utf8');
  } catch (e) {
    console.error('读取凭证失败：' + e.message);
    process.exit(2);
  }
  if (!args.keys.length && process.env.ATTEST_TRUSTED_KEYS) {
    try { args.keys.push(...readAllPem(process.env.ATTEST_TRUSTED_KEYS)); } catch (e) {
      console.error('读取 ATTEST_TRUSTED_KEYS 失败：' + e.message);
      process.exit(2);
    }
  }
  let envelope;
  try { envelope = JSON.parse(raw); } catch (e) {
    console.error('凭证不是合法 JSON：' + e.message);
    process.exit(2);
  }
  const result = verifyAttestation(envelope, args.keys);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderHuman(result));
  process.exit(result.conclusion === 'PASS' ? 0 : 1);
}

module.exports = { verifyAttestation, canonicalJSON, renderHuman };
