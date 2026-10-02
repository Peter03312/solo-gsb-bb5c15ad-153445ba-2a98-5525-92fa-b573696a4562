'use strict';

// 核验引擎：来源链遍历 + 逐节点授权判定
// 授权通配符：媒介或地区填 * 表示覆盖任意值。匹配大小写不敏感。

const {
  RULES_VERSION,
  RULE_ALGORITHM,
  MAX_PATH_INSTANCES: RULE_MAX_PATH_INSTANCES,
  MAX_CHAIN_DEPTH: RULE_MAX_CHAIN_DEPTH,
} = require('./rules');

const MAX_PATH_INSTANCES = RULE_MAX_PATH_INSTANCES;
const MAX_CHAIN_DEPTH = RULE_MAX_CHAIN_DEPTH;

// 规则版本与参数：写入每份核验结果（发布快照与凭证据此引用）
function rulesInfo() {
  return {
    version: RULES_VERSION,
    algorithm: RULE_ALGORITHM,
    maxChainDepth: MAX_CHAIN_DEPTH,
    maxPathInstances: MAX_PATH_INSTANCES,
  };
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function scopeMatches(value, wanted) {
  if (value === '*') return true;
  return String(value).trim().toLowerCase() === String(wanted).trim().toLowerCase();
}

function loadGraph(db) {
  const links = db.prepare('SELECT material_id, source_material_id FROM source_links').all();
  const adj = new Map();
  for (const l of links) {
    if (!adj.has(l.material_id)) adj.set(l.material_id, []);
    adj.get(l.material_id).push(l.source_material_id);
  }
  return adj;
}

// BFS：从 from 到 to 的任意一条路径（含两端）。用于新增来源边时的成环预判。
function findPath(adj, from, to) {
  if (from === to) return [from];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adj.get(cur) || []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      if (next === to) {
        const path = [to];
        let p = cur;
        while (p !== null) { path.push(p); p = prev.get(p); }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

// 从一个入展品（root）沿全部来源边 DFS，记录每个节点的所有 root->node 路径
function collectChains(adj, root) {
  const nodePaths = new Map(); // materialId -> number[][] （去重后）
  const cyclicNodes = new Set();
  let truncated = false;
  let tooDeep = false;

  const pushPath = (id, stack) => {
    if (!nodePaths.has(id)) nodePaths.set(id, []);
    const list = nodePaths.get(id);
    const key = stack.join('>');
    if (!list.some((p) => p.join('>') === key)) list.push(stack.slice());
  };

  const dfs = (stack) => {
    if (truncated) return;
    const node = stack[stack.length - 1];
    pushPath(node, stack);
    if (stack.length > MAX_CHAIN_DEPTH) { tooDeep = true; return; }
    for (const kid of adj.get(node) || []) {
      if (truncated) return;
      if (stack.includes(kid)) { cyclicNodes.add(kid); continue; }
      stack.push(kid);
      dfs(stack);
      stack.pop();
      let total = 0;
      for (const arr of nodePaths.values()) total += arr.length;
      if (total >= MAX_PATH_INSTANCES) { truncated = true; return; }
    }
  };

  dfs([root]);
  return { nodePaths, cyclicNodes, truncated, tooDeep };
}

function evalNode(authRows, { medium, region, useFrom, useTo }) {
  const detail = authRows.map((a) => ({
    id: a.id,
    revoked: !!a.revoked,
    media: a.media,
    region: a.region,
    validFrom: a.valid_from,
    validTo: a.valid_to,
    mediaOk: !a.revoked && scopeMatches(a.media, medium),
    regionOk: !a.revoked && scopeMatches(a.region, region),
    dateOk:
      !a.revoked &&
      a.valid_from <= useFrom &&
      a.valid_to >= useTo,
  }));

  const active = detail.filter((d) => !d.revoked);
  let reason = null;
  let matched = null;

  if (detail.length === 0) {
    reason = 'no_auth';
  } else if (active.length === 0) {
    reason = 'revoked';
  } else {
    const mediaOk = active.filter((d) => d.mediaOk);
    const regionOk = active.filter((d) => d.regionOk);
    const scopeOk = active.filter((d) => d.mediaOk && d.regionOk);
    const cover = scopeOk.find((d) => d.dateOk);
    if (cover) {
      matched = authRows.find((a) => a.id === cover.id);
    } else if (scopeOk.length === 0) {
      if (mediaOk.length === 0 && regionOk.length === 0) reason = 'media_region';
      else if (mediaOk.length === 0) reason = 'media';
      else reason = 'region';
    } else {
      reason = 'date';
    }
  }

  return { reason, matched, detail };
}

const REASON_TEXT = {
  cycle: '来源关系成环，无法完成核验',
  depth: '来源链超过最大深度（100 层），疑似存在成环',
  no_auth: '该节点未登记任何授权',
  revoked: '该节点的授权均已撤销',
  media: '无覆盖该展示媒介的有效授权',
  region: '无覆盖该展示地区的有效授权',
  media_region: '无覆盖该展示媒介与地区的有效授权',
  date: '授权有效期不覆盖整段使用期',
};

function basisVersion(db) {
  return Number(db.prepare("SELECT value FROM meta WHERE key='basis_version'").pluck().get());
}

/**
 * 核验一个展览包候选（或已发布包）。
 * input: { materialIds:[], medium, region, useFrom, useTo }
 * 返回完整结果对象，可直接作为不可变快照 payload。
 */
function verifyPackage(db, input) {
  const materialIds = [...new Set(input.materialIds || [])].sort((a, b) => a - b);
  const medium = (input.medium || '').trim();
  const region = (input.region || '').trim();
  const useFrom = input.useFrom || '';
  const useTo = input.useTo || '';

  const globalErrors = [];
  if (materialIds.length === 0) globalErrors.push('展览包未选取任何素材');
  if (!medium) globalErrors.push('缺少展示媒介');
  if (!region) globalErrors.push('缺少展示地区');
  if (!isValidDate(useFrom)) globalErrors.push(`起始日期不合法：${useFrom || '（空）'}（需为 YYYY-MM-DD）`);
  if (!isValidDate(useTo)) globalErrors.push(`截止日期不合法：${useTo || '（空）'}（需为 YYYY-MM-DD）`);
  if (isValidDate(useFrom) && isValidDate(useTo) && useFrom > useTo) {
    globalErrors.push(`起止日期不合法：起始 ${useFrom} 晚于截止 ${useTo}`);
  }
  const datesValid = isValidDate(useFrom) && isValidDate(useTo) && useFrom <= useTo;

  const matRows = db.prepare('SELECT id, title, kind FROM materials').all();
  const matById = new Map(matRows.map((m) => [m.id, m]));

  const itemErrors = [];
  for (const id of materialIds) {
    if (!matById.has(id)) itemErrors.push({ materialId: id, reason: 'missing', message: `素材 #${id} 不存在` });
  }
  const roots = materialIds.filter((id) => matById.has(id));

  const adj = loadGraph(db);
  const authRows = db.prepare('SELECT * FROM authorizations').all();
  const authByMat = new Map();
  for (const a of authRows) {
    if (!authByMat.has(a.material_id)) authByMat.set(a.material_id, []);
    authByMat.get(a.material_id).push(a);
  }

  const nodes = new Map(); // id -> aggregated node
  let truncated = false;

  const ensureNode = (id, isRoot) => {
    if (!nodes.has(id)) {
      const m = matById.get(id);
      nodes.set(id, {
        materialId: id,
        title: m ? m.title : `#${id}（已删除）`,
        kind: m ? m.kind : null,
        isRoot,
        rootOf: [],
        paths: [],
        reasons: [],
        matchedAuthorization: null,
        candidates: [],
      });
    }
    const n = nodes.get(id);
    if (isRoot && !n.rootOf.includes(id)) n.rootOf.push(id);
    return n;
  };

  let anyCycle = false;
  let anyDepth = false;

  for (const root of roots) {
    ensureNode(root, true);
    const { nodePaths, cyclicNodes, truncated: t, tooDeep } = collectChains(adj, root);
    truncated = truncated || t;
    anyDepth = anyDepth || tooDeep;
    for (const id of cyclicNodes) anyCycle = true;

    for (const [id, paths] of nodePaths) {
      const node = ensureNode(id, id === root);
      if (id !== root && !node.rootOf.includes(root)) node.rootOf.push(root);
      for (const p of paths) {
        const key = p.join('>');
        if (!node.paths.some((x) => x.join('>') === key)) {
          node.paths.push(p.map((pid) => ({
            materialId: pid,
            title: matById.get(pid) ? matById.get(pid).title : `#${pid}（已删除）`,
          })));
        }
      }
      if (cyclicNodes.has(id) && !node.reasons.includes('cycle')) node.reasons.push('cycle');
      if (tooDeep && paths.some((p) => p.length > MAX_CHAIN_DEPTH) && !node.reasons.includes('depth')) {
        node.reasons.push('depth');
      }
    }
  }

  for (const node of nodes.values()) {
    node.paths.sort((a, b) => a.map((x) => x.materialId).join('>').localeCompare(b.map((x) => x.materialId).join('>')));
    if (datesValid && !node.reasons.length) {
      const ev = evalNode(authByMat.get(node.materialId) || [], { medium, region, useFrom, useTo });
      if (ev.reason) node.reasons.push(ev.reason);
      if (ev.matched) {
        node.matchedAuthorization = {
          id: ev.matched.id,
          media: ev.matched.media,
          region: ev.matched.region,
          validFrom: ev.matched.valid_from,
          validTo: ev.matched.valid_to,
        };
      }
      node.candidates = ev.detail;
    }
  }

  const nodeList = [...nodes.values()].sort((a, b) => a.materialId - b.materialId);
  const failingNodes = nodeList.filter((n) => n.reasons.length > 0);

  // 保护上限触发时不能“可能漏判却放行”：按不合格处理并提示简化来源结构后重试
  if (truncated) {
    globalErrors.push(`来源路径数量超过安全上限（${MAX_PATH_INSTANCES} 条路径实例），核验已截断；为避免漏判节点，本次按不通过处理。请简化来源结构后重试。`);
  }
  if (anyDepth) {
    globalErrors.push(`来源链深度超过 ${MAX_CHAIN_DEPTH} 层（疑似存在成环），本次按不通过处理。`);
  }

  const eligible =
    globalErrors.length === 0 &&
    itemErrors.length === 0 &&
    !anyCycle &&
    !anyDepth &&
    failingNodes.length === 0;

  return {
    generatedAt: new Date().toISOString(),
    basisVersion: basisVersion(db),
    rules: rulesInfo(),
    request: { materialIds, medium, region, useFrom, useTo },
    eligible,
    globalErrors,
    itemErrors,
    stats: {
      rootCount: roots.length,
      nodeCount: nodeList.length,
      failingCount: failingNodes.length,
      pathCountTruncated: truncated,
      cyclic: anyCycle,
    },
    failingNodes: failingNodes.map((n) => ({
      materialId: n.materialId,
      title: n.title,
      isRoot: n.isRoot,
      reasons: n.reasons,
      reasonText: n.reasons.map((r) => REASON_TEXT[r] || r),
      paths: n.paths,
    })),
    nodes: nodeList.map((n) => ({
      materialId: n.materialId,
      title: n.title,
      kind: n.kind,
      isRoot: n.isRoot,
      reasons: n.reasons,
      reasonText: n.reasons.map((r) => REASON_TEXT[r] || r),
      eligible: n.reasons.length === 0,
      paths: n.paths,
      matchedAuthorization: n.matchedAuthorization,
      candidates: n.candidates,
    })),
  };
}

// ---------- 多站巡展核验 ----------
// 整包共享同一份入展素材清单（及其全部来源链）；逐站用该站自己的
// 名称/媒介/地区/起止日期核验：每个节点在每个站都必须有一份未撤销授权
// 独自覆盖该站整段展期（不同站可用不同授权，同站不可拼接短授权）。

const STOP_REASON_TEXT = {
  cycle: '来源关系成环，无法完成核验',
  depth: '来源链超过最大深度（100 层），疑似存在成环',
  no_auth: '该站：该节点未登记任何授权',
  revoked: '该站：该节点的授权均已撤销',
  media: '该站：无覆盖该站展示媒介的有效授权',
  region: '该站：无覆盖该站展示地区的有效授权',
  media_region: '该站：无覆盖该站展示媒介与地区的有效授权',
  date: '该站：无任何一份授权能独自覆盖该站整段展期（短授权不可拼接）',
};

function normalizeStop(raw, index) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    index,
    name: strTrim(s.name),
    medium: strTrim(s.media ?? s.medium),
    region: strTrim(s.region),
    useFrom: typeof s.useFrom === 'string' ? s.useFrom.trim() : '',
    useTo: typeof s.useTo === 'string' ? s.useTo.trim() : '',
  };
}

function strTrim(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

// 站次自身字段校验；返回该站错误信息数组
function stopFieldErrors(st) {
  const errors = [];
  if (!st.name) errors.push(`第 ${st.index + 1} 站缺少站点名称`);
  if (!st.medium) errors.push(`第 ${st.index + 1} 站「${st.name || '未命名'}」缺少展示媒介`);
  if (!st.region) errors.push(`第 ${st.index + 1} 站「${st.name || '未命名'}」缺少展示地区`);
  if (!isValidDate(st.useFrom)) {
    errors.push(`第 ${st.index + 1} 站「${st.name || '未命名'}」起始日期不合法：${st.useFrom || '（空）'}（需为 YYYY-MM-DD）`);
  }
  if (!isValidDate(st.useTo)) {
    errors.push(`第 ${st.index + 1} 站「${st.name || '未命名'}」截止日期不合法：${st.useTo || '（空）'}（需为 YYYY-MM-DD）`);
  }
  if (isValidDate(st.useFrom) && isValidDate(st.useTo) && st.useFrom > st.useTo) {
    errors.push(`第 ${st.index + 1} 站「${st.name || '未命名'}」起止日期不合法：起始 ${st.useFrom} 晚于截止 ${st.useTo}`);
  }
  return errors;
}

// 站间不得重叠：按数组顺序展出，相邻站必须满足 前站.useTo < 后站.useFrom（首尾日均占用）
function stopOverlapErrors(stops) {
  const errors = [];
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1];
    const cur = stops[i];
    if (isValidDate(prev.useFrom) && isValidDate(prev.useTo) && prev.useFrom <= prev.useTo
      && isValidDate(cur.useFrom) && isValidDate(cur.useTo) && cur.useFrom <= cur.useTo
      && cur.useFrom <= prev.useTo) {
      errors.push(
        `第 ${i} 站「${prev.name}」展期至 ${prev.useTo}，与第 ${i + 1} 站「${cur.name}」起始 ${cur.useFrom} 重叠` +
        `（首尾日均占用，后一站须晚于 ${prev.useTo} 开始）`
      );
    }
  }
  return errors;
}

/**
 * 多站巡展核验。
 * input: { materialIds:[], stops:[{name, medium/media, region, useFrom, useTo}, ...] }
 * 结果按站给出问题节点、原因与全部来源路径；整包合格当且仅当每一站均合格。
 */
function verifyMultiStop(db, input) {
  const materialIds = [...new Set(input.materialIds || [])].sort((a, b) => a - b);
  const rawStops = Array.isArray(input.stops) ? input.stops : null;

  const globalErrors = [];
  if (materialIds.length === 0) globalErrors.push('展览包未选取任何素材');
  if (!rawStops) {
    globalErrors.push('多站巡展请求缺少行程 stops（数组，至少 2 站；单站包请使用顶层 medium/region/useFrom/useTo 字段）');
  } else if (rawStops.length < 2) {
    globalErrors.push(`多站巡展行程至少需要 2 站（当前 ${rawStops.length} 站）；单站展请使用包顶层媒介/地区/日期字段`);
  }
  const stops = rawStops ? rawStops.map((s, i) => normalizeStop(s, i)) : [];

  // 逐站字段错误
  const stopErrors = stops.map((s) => stopFieldErrors(s));
  const allStopFieldsValid = stops.length >= 2 && stopErrors.every((e) => e.length === 0);
  if (stops.length >= 2) {
    const overlapErrors = allStopFieldsValid ? stopOverlapErrors(stops) : [];
    globalErrors.push(...overlapErrors);
  }
  for (let i = 0; i < stops.length; i++) {
    for (const e of stopErrors[i]) globalErrors.push(e);
  }

  const stopsValid = stops.length >= 2 && allStopFieldsValid && stopOverlapErrors(stops).length === 0;

  // 素材缺失
  const matRows = db.prepare('SELECT id, title, kind FROM materials').all();
  const matById = new Map(matRows.map((m) => [m.id, m]));
  const itemErrors = [];
  for (const id of materialIds) {
    if (!matById.has(id)) itemErrors.push({ materialId: id, reason: 'missing', message: `素材 #${id} 不存在` });
  }
  const roots = materialIds.filter((id) => matById.has(id));

  // 来源链只遍历一次：全部入展品 → 节点路径集合（各站共享同一来源结构）
  const adj = loadGraph(db);
  const nodePaths = new Map(); // materialId -> 路径（去重）
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

  // 结构性原因（成环/超深）：对每个站都成立
  const structuralReasons = new Map();
  for (const id of nodeIds) {
    const reasons = [];
    if (cyclicNodeIds.has(id)) reasons.push('cycle');
    if (anyDepth && nodePaths.get(id).some((p) => p.length > MAX_CHAIN_DEPTH)) reasons.push('depth');
    structuralReasons.set(id, reasons);
  }

  const authRows = db.prepare('SELECT * FROM authorizations').all();
  const authByMat = new Map();
  for (const a of authRows) {
    if (!authByMat.has(a.material_id)) authByMat.set(a.material_id, []);
    authByMat.get(a.material_id).push(a);
  }

  // 逐站核验
  const stopResults = stops.map((st) => {
    const nodes = nodeIds.map((id) => {
      const reasons = [...(structuralReasons.get(id) || [])];
      let matchedAuthorization = null;
      let candidates = [];
      if (stopsValid && reasons.length === 0) {
        const ev = evalNode(authByMat.get(id) || [], {
          medium: st.medium, region: st.region, useFrom: st.useFrom, useTo: st.useTo,
        });
        if (ev.reason) reasons.push(ev.reason);
        if (ev.matched) {
          matchedAuthorization = {
            id: ev.matched.id,
            media: ev.matched.media,
            region: ev.matched.region,
            validFrom: ev.matched.valid_from,
            validTo: ev.matched.valid_to,
          };
        }
        candidates = ev.detail;
      }
      return {
        materialId: id,
        title: matById.get(id) ? matById.get(id).title : `#${id}（已删除）`,
        kind: matById.get(id) ? matById.get(id).kind : null,
        isRoot: nodeIsRoot.get(id) === true,
        reasons,
        eligible: reasons.length === 0,
        matchedAuthorization,
        candidates,
      };
    });
    const failingNodes = nodes.filter((n) => !n.eligible).map((n) => ({
      materialId: n.materialId,
      title: n.title,
      isRoot: n.isRoot,
      reasons: n.reasons,
      reasonText: n.reasons.map((r) => STOP_REASON_TEXT[r] || REASON_TEXT[r] || r),
      paths: pathDTOs.get(n.materialId),
    }));
    return {
      position: st.index,
      name: st.name,
      medium: st.medium,
      region: st.region,
      useFrom: st.useFrom,
      useTo: st.useTo,
      valid: stopErrors[st.index].length === 0,
      errors: stopErrors[st.index],
      eligible: stopErrors[st.index].length === 0 && failingNodes.length === 0,
      stats: {
        nodeCount: nodes.length,
        failingCount: failingNodes.length,
      },
      failingNodes,
      nodes,
    };
  });

  if (truncated) {
    globalErrors.push(`来源路径数量超过安全上限（${MAX_PATH_INSTANCES} 条路径实例），核验已截断；为避免漏判节点，本次按不通过处理。请简化来源结构后重试。`);
  }
  if (anyDepth) {
    globalErrors.push(`来源链深度超过 ${MAX_CHAIN_DEPTH} 层（疑似存在成环），本次按不通过处理。`);
  }

  const totalFailing = stopResults.reduce((acc, s) => acc + s.stats.failingCount, 0);
  const eligible = globalErrors.length === 0
    && itemErrors.length === 0
    && !anyCycle
    && !anyDepth
    && stopsValid
    && totalFailing === 0;

  return {
    generatedAt: new Date().toISOString(),
    basisVersion: basisVersion(db),
    rules: rulesInfo(),
    multiStop: true,
    request: {
      materialIds,
      stops: stops.map((s) => ({ position: s.index, name: s.name, medium: s.medium, region: s.region, useFrom: s.useFrom, useTo: s.useTo })),
    },
    eligible,
    globalErrors,
    itemErrors,
    stats: {
      rootCount: roots.length,
      nodeCount: nodeIds.length,
      stopCount: stops.length,
      failingStopCount: stopResults.filter((s) => !s.eligible).length,
      failingNodeCountTotal: totalFailing,
      pathCountTruncated: truncated,
      cyclic: anyCycle,
    },
    stops: stopResults,
    // 跨站汇总的问题节点（每个节点 × 每个失格站一条），便于旧界面/清单消费
    failingNodes: stopResults.flatMap((s) => s.failingNodes.map((n) => ({
      ...n,
      stopPosition: s.position,
      stopName: s.name,
    }))),
    // 来源链各站共享：全部来源路径只在此封存一份（避免按站重复），供快照/凭证消费
    nodePaths: nodeIds.map((id) => ({ materialId: id, paths: pathDTOs.get(id) })),
  };
}

// 读取已存储包（单站/多站）并按其形态核验。stops 由调用方/本函数从 package_stops 载入。
function loadStops(db, packageId) {
  return db.prepare('SELECT position, name, medium, region, use_from, use_to FROM package_stops WHERE package_id=? ORDER BY position')
    .all(packageId)
    .map((r) => ({
      position: r.position,
      name: r.name,
      medium: r.medium,
      region: r.region,
      useFrom: r.use_from,
      useTo: r.use_to,
    }));
}

function verifyStoredPackage(db, pkg, items, stopsRows) {
  const stops = stopsRows || loadStops(db, pkg.id);
  if (stops.length >= 2) {
    return verifyMultiStop(db, {
      materialIds: items,
      stops: stops.map((s) => ({
        name: s.name, medium: s.medium, region: s.region, useFrom: s.useFrom ?? s.use_from, useTo: s.useTo ?? s.use_to,
      })),
    });
  }
  return verifyPackage(db, {
    materialIds: items,
    medium: pkg.medium,
    region: pkg.region,
    useFrom: pkg.use_from,
    useTo: pkg.use_to,
  });
}

// 授权/来源变更后：仅把“由合格变不合格”的已发布包标为需复核，追加 review 快照。
function revalidatePublished(db) {
  const rows = db
    .prepare("SELECT * FROM packages WHERE status IN ('published','needs_review') ORDER BY id")
    .all();
  const flagged = [];
  for (const pkg of rows) {
    const items = db
      .prepare('SELECT material_id FROM package_items WHERE package_id=? ORDER BY position, material_id')
      .all(pkg.id)
      .map((r) => r.material_id);
    const result = verifyStoredPackage(db, pkg, items);
    if (pkg.status === 'published' && !result.eligible) {
      db.prepare("UPDATE packages SET status='needs_review', updated_at=? WHERE id=?")
        .run(new Date().toISOString(), pkg.id);
      db.prepare(
        `INSERT INTO verification_snapshots(package_id, kind, basis_version, eligible, payload, created_at)
         VALUES (?,?,?,?,?,?)`
      ).run(pkg.id, 'review', result.basisVersion, 0, JSON.stringify(result), new Date().toISOString());
      flagged.push({ packageId: pkg.id, name: pkg.name, result });
    }
  }
  return flagged;
}

module.exports = {
  isValidDate,
  scopeMatches,
  loadGraph,
  findPath,
  collectChains,
  basisVersion,
  verifyPackage,
  verifyMultiStop,
  verifyStoredPackage,
  loadStops,
  stopFieldErrors,
  stopOverlapErrors,
  normalizeStop,
  revalidatePublished,
  REASON_TEXT,
  STOP_REASON_TEXT,
};
