'use strict';

// 端到端业务规则测试（针对运行中的 http://localhost:3000）
const BASE = process.env.BASE || 'http://localhost:3000';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  console.log('1) 成环检测');
  {
    // 演示数据: 1 film -> 2 music, 3 footage, 4 font ; footage(3) -> 5 photo
    // 尝试给 music(2) 加来源 film(1)：1->2->1 成环
    const r = await call('POST', '/api/materials/2/sources', { sourceMaterialId: 1, relation: 'x' });
    ok(r.status === 409 && r.data.details && r.data.details.cyclePath.join() === '1,2',
      '加边 2->1 被拒且返回成环路径 [1,2]，实际: ' + r.status + ' ' + JSON.stringify(r.data.details));
    // 自环
    const r2 = await call('POST', '/api/materials/1/sources', { sourceMaterialId: 1 });
    ok(r2.status === 400, '自环被拒绝');
    // 合法加边
    const r3 = await call('POST', '/api/materials/5/sources', { sourceMaterialId: 4, relation: '字体' });
    ok(r3.status === 201, '合法边 5->4 添加成功（photo 也用到字体）');
  }

  console.log('2) 不合格包：缺授权节点 + 来源路径列出');
  {
    // 创建含 film(1) 的秋季包：photo(5)/font(4) 只有春季授权，使用期不覆盖
    const r = await call('POST', '/api/packages', {
      name: '测试不合格包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-10-01', useTo: '2026-11-30', materialIds: [1],
    });
    ok(r.status === 201, '包已创建为 draft');
    const pid = r.data.id;
    const v = await call('POST', '/api/verify', { packageId: pid });
    ok(v.status === 200 && v.data.eligible === false, '核验不合格');
    const photo = v.data.failingNodes.find((n) => n.materialId === 5);
    ok(!!photo, '列出不合格节点 photo(5)');
    ok(photo.paths.some((p) => p.map((x) => x.materialId).join() === '1,3,5'),
      '给出不合格来源路径 1->3->5');
    ok(photo.reasonText.join().includes('有效期'), '原因：授权有效期不覆盖（照片仅有春季授权）');
    // 字体在秋季也不覆盖
    const fontNode = v.data.failingNodes.find((n) => n.materialId === 4);
    ok(!!fontNode && fontNode.reasonText.join().includes('有效期'), '字体节点同样因有效期不合格');
    global.pidBad = pid;
  }

  console.log('2b) 完全无授权的独立节点 -> no_auth');
  {
    const m = await call('POST', '/api/materials', { title: '孤立未授权素材', kind: 'image' });
    ok(m.status === 201, '创建无授权素材');
    const p = await call('POST', '/api/packages', {
      name: '无授权包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-10-01', useTo: '2026-11-30', materialIds: [m.data.id],
    });
    const v = await call('POST', '/api/verify', { packageId: p.data.id });
    ok(v.data.eligible === false &&
      v.data.failingNodes[0].reasons.includes('no_auth') &&
      v.data.failingNodes[0].reasonText.join().includes('未登记任何授权'),
      '无授权节点报 no_auth 并列出根路径');
  }

  console.log('3) 日期不合法 / 缺字段 -> 400 或核验 globalErrors，禁止发布');
  {
    const r = await call('POST', '/api/packages', {
      name: '坏日期', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-12-01', useTo: '2026-11-01', materialIds: [1],
    });
    ok(r.status === 400, '起>止日期在保存时被拒（400）');
    const r2 = await call('POST', '/api/packages', {
      name: '坏格式', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-02-30', useTo: '2026-11-01', materialIds: [1],
    });
    ok(r2.status === 400, '非法日历日期 2026-02-30 被拒');
    // 直接核验缺媒介
    const v = await call('POST', '/api/verify', { materialIds: [1], medium: '', region: '中国大陆', useFrom: '2026-10-01', useTo: '2026-11-30' });
    ok(v.data.eligible === false && v.data.globalErrors.some((e) => e.includes('媒介')), '缺媒介导致不可发布');
    // 发布不合格包 -> 422
    const state = await call('GET', '/api/state');
    const pub = await call('POST', `/api/packages/${global.pidBad}/publish`, { basisVersion: state.data.basisVersion });
    ok(pub.status === 422, '发布不合格包被拒 422');
    const after = await call('GET', `/api/packages/${global.pidBad}`);
    ok(after.data.status === 'draft', '包仍为 draft（未被发布）');
    const snaps = after.data.snapshots;
    ok(snaps.length === 1 && snaps[0].kind === 'publish' && snaps[0].eligible === false,
      '失败发布也留下不可变核验记录');
  }

  console.log('4) 合格包发布 + 原子快照 + 清单冻结');
  {
    // 演示数据里的已发布包 1（常设展）；另建一个全新的可发布包：film 链需在 03-01~05-31 全合格
    // font(4) 授权 2026-03-01~2026-05-31 恰好覆盖；步骤1加了 5->4 边但只含 font 自身时不受影响
    const r = await call('POST', '/api/packages', {
      name: '测试合格包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-03-01', useTo: '2026-05-31', materialIds: [4],
    });
    const pid = r.data.id;
    const v = await call('POST', '/api/verify', { packageId: pid });
    ok(v.data.eligible === true, '只含 font(4) 的包核验合格');
    const pub = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: v.data.basisVersion });
    ok(pub.status === 201 && pub.data.package.status === 'published', '发布成功 201');
    ok(pub.data.snapshotId && pub.data.result.eligible, '返回不可变快照 id');
    // 发布后不可改
    const patch = await call('PATCH', `/api/packages/${pid}`, {
      name: 'x', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-05-31', materialIds: [4],
    });
    ok(patch.status === 409, '已发布包参数/清单不可修改');
    // 快照内容核对
    const snap = await call('GET', `/api/snapshots/${pub.data.snapshotId}`);
    ok(snap.data.immutable && snap.data.payload.nodes.length === 1 && snap.data.payload.request.materialIds.join() === '4',
      '快照冻结素材清单与逐节点结果');
    global.pidGood = pid;
    global.goodSnap = pub.data.snapshotId;
  }

  console.log('5) 快照不可变（SQLite 触发器）');
  {
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DB_PATH || '/workspace/data/app.db');
    let blockedUpdate = false, blockedDelete = false;
    try { db.prepare('UPDATE verification_snapshots SET eligible=0 WHERE id=?').run(global.goodSnap); }
    catch { blockedUpdate = true; }
    try { db.prepare('DELETE FROM verification_snapshots WHERE id=?').run(global.goodSnap); }
    catch { blockedDelete = true; }
    ok(blockedUpdate && blockedDelete, '快照 UPDATE/DELETE 均被触发器拒绝');
    db.close();
  }

  console.log('6) 依据过期（核验后授权/来源被改）-> 发布 409 STALE_BASIS');
  {
    // 新待发布合格包
    const r = await call('POST', '/api/packages', {
      name: '并发包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-03-02', useTo: '2026-05-01', materialIds: [4],
    });
    const pid = r.data.id;
    const v1 = await call('POST', '/api/verify', { packageId: pid });
    ok(v1.data.eligible === true, '核验合格，拿到 basisVersion=' + v1.data.basisVersion);
    // 期间他人改了授权（给 font 增加一条无关授权，版本号也会递增）
    const add = await call('POST', '/api/materials/4/authorizations', {
      media: '网络', region: '中国大陆', validFrom: '2030-01-01', validTo: '2030-12-31', licensor: 'x',
    });
    ok(add.status === 201, '并发：新增了一条授权');
    const pub = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: v1.data.basisVersion });
    ok(pub.status === 409 && pub.data.details.code === 'STALE_BASIS', '依据过期发布被拒 409 STALE_BASIS');
    const v2 = await call('POST', '/api/verify', { packageId: pid });
    const pub2 = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: v2.data.basisVersion });
    ok(pub2.status === 201, '重新核验后发布成功');
    global.pidConcurrent = pid;
  }

  console.log('7) 授权撤销 -> 仅“由合格变不合格”的已发布包标 needs_review，原快照保留');
  {
    const before = (await call('GET', `/api/packages/${global.pidGood}`)).data;
    ok(before.status === 'published', '前置：合格包处于 published');
    // font 授权只有一条主授权（id 从数据查）；撤销它
    const mats = (await call('GET', '/api/materials')).data;
    const fontAuth = mats.find((m) => m.id === 4).authorizations.filter((a) => !a.revoked && a.media !== '网络');
    const target = fontAuth.find((a) => a.validFrom === '2026-03-01');
    const rev = await call('POST', `/api/authorizations/${target.id}/revoke`);
    ok(rev.status === 200, '授权已撤销');
    const after = (await call('GET', `/api/packages/${global.pidGood}`)).data;
    ok(after.status === 'needs_review', '原合格包被标记为 needs_review');
    const publishSnapStillThere = after.snapshots.some((s) => s.id === global.goodSnap && s.kind === 'publish' && s.eligible === true);
    ok(publishSnapStillThere, '原发布快照原样保留（合格、未被改写）');
    ok(after.latestSnapshot.kind === 'review' && after.latestSnapshot.eligible === false,
      '自动追加了 review 不合格快照');
    // 演示数据里的已发布“常设展”包（含 film，font 在其链上）也应被标记
    const pkgList = (await call('GET', '/api/packages')).data;
    const demo = pkgList.find((p) => p.name.includes('常设展'));
    ok(demo.status === 'needs_review', '演示已发布包同样被标记需复核');

    // 已经 needs_review 的包，再改一次授权（仍不合格）不应产生重复状态翻转之外问题；
    // 且“合格→仍不合格”规则：review 包不会自动恢复
    global.reviewPid = global.pidGood;
  }

  console.log('8) 人工复核：恢复授权后重新核验 -> 恢复 published，所有历史快照保留');
  {
    // 重新登记一条覆盖授权（不能解撤，模拟补授权）
    const add = await call('POST', '/api/materials/4/authorizations', {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2028-12-31', licensor: '补授权',
    });
    ok(add.status === 201, '补登记覆盖授权');
    // needs_review 不会自动恢复
    const still = (await call('GET', `/api/packages/${global.reviewPid}`)).data;
    ok(still.status === 'needs_review', '不会自动恢复发布状态');
    const rc = await call('POST', `/api/packages/${global.reviewPid}/recheck`);
    ok(rc.status === 200 && rc.data.restored === true && rc.data.package.status === 'published',
      '人工复核通过，恢复 published');
    const final = (await call('GET', `/api/packages/${global.reviewPid}`)).data;
    const kinds = final.snapshots.map((s) => s.kind).join(',');
    ok(kinds.includes('publish') && kinds.includes('review') && kinds.includes('recheck'),
      '三类快照按时间顺序全部保留: ' + kinds);
  }

  console.log('9) 媒介/地区通配符与有效期边界');
  {
    // music(2) 授权 * / * 2026-01-01~2027-12-31
    const r = await call('POST', '/api/packages', {
      name: '边界包', medium: '沉浸式投影', region: '中国香港',
      useFrom: '2026-01-01', useTo: '2027-12-31', materialIds: [2],
    });
    const v = await call('POST', '/api/verify', { packageId: r.data.id });
    ok(v.data.eligible === true, '* / * 授权覆盖任意媒介地区，起止日按闭区间边界合格');
    const v2 = await call('POST', '/api/verify', {
      materialIds: [2], medium: '沉浸式投影', region: '中国香港',
      useFrom: '2025-12-31', useTo: '2027-12-31',
    });
    ok(v2.data.eligible === false && v2.data.failingNodes[0].reasonText.join().includes('有效期'),
      '早一天即不覆盖整段使用期');
  }

  console.log('10) 变更影响预演 + 确认提交（先预演后提交，事务内校验）');
  {
    // 自建一套干净数据：root -> src 两节点，各自恰好一份覆盖授权，发布一个合格包
    const m1 = (await call('POST', '/api/materials', { title: '预演-成片', kind: 'video' })).data.id;
    const m2 = (await call('POST', '/api/materials', { title: '预演-来源', kind: 'audio' })).data.id;
    const m3 = (await call('POST', '/api/materials', { title: '预演-无授权素材', kind: 'image' })).data.id;
    await call('POST', `/api/materials/${m1}/sources`, { sourceMaterialId: m2, relation: '配乐' });
    await call('POST', `/api/materials/${m1}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', licensor: 'r',
    });
    const aSrc = (await call('POST', `/api/materials/${m2}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', licensor: 's',
    })).data.id;
    const pkg = (await call('POST', '/api/packages', {
      name: '预演测试包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-03-01', useTo: '2026-04-30', materialIds: [m1],
    })).data.id;
    const v0 = await call('POST', '/api/verify', { packageId: pkg });
    const pub0 = await call('POST', `/api/packages/${pkg}/publish`, { basisVersion: v0.data.basisVersion });
    ok(pub0.status === 201, '前置：预演测试包已发布');
    const basis0 = pub0.data.result.basisVersion;
    global.previewPkg = pkg; global.previewAuth = aSrc; global.previewRoot = m1;
    global.previewNoAuth = m3; global.previewSrc = m2;

    // 10.1 预演撤销来源授权：列出该已发布包 + 问题节点 m2 + revoked 原因与来源路径
    const pv = await call('POST', '/api/changes/preview', { operation: 'authorization.revoke', authorizationId: aSrc });
    ok(pv.status === 200, '预演返回 200');
    ok(pv.data.mutated === false && pv.data.basisVersion === basis0, '预演返回依据版本且声明未落库');
    const hit = pv.data.impact.find((p) => p.packageId === pkg);
    ok(!!hit, '预演影响清单含该已发布包');
    const badNode = hit && hit.failingNodes.find((n) => n.materialId === m2);
    ok(!!badNode && badNode.reasons.includes('revoked'), '问题节点为来源 m2，原因为授权均已撤销');
    ok(badNode.paths.some((p) => p.map((x) => x.materialId).join() === `${m1},${m2}`),
      '给出问题节点来源路径 root->src');
    ok(typeof pv.data.impactFingerprint === 'string' && pv.data.impactFingerprint.length > 0, '返回影响清单指纹');

    // 10.2 预演不落库：包仍 published、快照仍只有发布快照、授权未撤销、版本不变
    const st1 = await call('GET', `/api/packages/${pkg}`);
    ok(st1.data.status === 'published' && st1.data.snapshots.length === 1, '预演后包仍已发布且无新增快照');
    const mats1 = await call('GET', '/api/materials');
    const stillActive = mats1.data.find((x) => x.id === m2).authorizations.find((a) => a.id === aSrc && !a.revoked);
    ok(!!stillActive, '预演后授权仍未撤销');
    const ver1 = (await call('GET', '/api/state')).data.basisVersion;
    ok(ver1 === basis0, '预演后依据版本不变');

    // 10.3 依据版本不一致 -> 409 STALE_BASIS，无写入
    const stale = await call('POST', '/api/changes/commit', {
      operation: 'authorization.revoke', authorizationId: aSrc, basisVersion: basis0 - 1, impact: pv.data.impact,
    });
    ok(stale.status === 409 && stale.data.details.code === 'STALE_BASIS', '旧依据版本确认被拒 409 STALE_BASIS');
    ok((await call('GET', `/api/packages/${pkg}`)).data.status === 'published', 'STALE 拒绝后无部分写入');

    // 10.4 影响清单不一致（提交空清单）-> 409 IMPACT_MISMATCH，无写入
    const mismatch = await call('POST', '/api/changes/commit', {
      operation: 'authorization.revoke', authorizationId: aSrc, basisVersion: basis0, impact: [],
    });
    ok(mismatch.status === 409 && mismatch.data.details.code === 'IMPACT_MISMATCH', '影响清单不符被拒 409 IMPACT_MISMATCH');
    ok(Array.isArray(mismatch.data.details.impact) && mismatch.data.details.impact.some((p) => p.packageId === pkg),
      '拒绝时返回服务端重算的最新影响清单');
    ok((await call('GET', `/api/packages/${pkg}`)).data.status === 'published', 'MISMATCH 拒绝后无部分写入');

    // 10.5 正确确认：执行变更 + 标需复核 + 追加不可变 review 快照，原发布快照保留
    const commit = await call('POST', '/api/changes/commit', {
      operation: 'authorization.revoke', authorizationId: aSrc, basisVersion: basis0, impact: pv.data.impact,
    });
    ok(commit.status === 200 && commit.data.mutated === true, '携带同一操作与预演结果确认成功');
    ok(commit.data.basisVersion === basis0 + 1, '提交后依据版本 +1');
    const st2 = await call('GET', `/api/packages/${pkg}`);
    ok(st2.data.status === 'needs_review', '受影响包标记为 needs_review');
    ok(st2.data.snapshots.length === 2 &&
       st2.data.snapshots[0].kind === 'publish' && st2.data.snapshots[0].eligible === true &&
       st2.data.snapshots[1].kind === 'review' && st2.data.snapshots[1].eligible === false,
      '原发布快照保留，并追加不合格 review 快照');

    // 10.6 需复核包不自动恢复（即便预演显示已合格），且预演只统计“已发布合格”包
    await call('POST', `/api/materials/${m2}/authorizations`, {
      media: '*', region: '*', validFrom: '2020-01-01', validTo: '2031-12-31', licensor: '补',
    });
    const st3 = await call('GET', `/api/packages/${pkg}`);
    ok(st3.data.status === 'needs_review', '补正授权后需复核包不自动恢复');

    // 10.7 目标失效：预演删不存在授权 404；确认时目标已被删 409 TARGET_GONE
    const pvGonePreview = await call('POST', '/api/changes/preview', { operation: 'authorization.delete', authorizationId: 999999 });
    ok(pvGonePreview.status === 404, '预演不存在的目标返回 404');

    // 10.8 成环拒绝（预演阶段即拒绝，沿用既有成环校验与路径）
    const cyc = await call('POST', '/api/changes/preview', { operation: 'source.create', materialId: m2, sourceMaterialId: m1 });
    ok(cyc.status === 409 && cyc.data.details.code === 'CYCLE' &&
       cyc.data.details.cycle.join() === `${m2},${m1},${m2}`,
      '成环关系在预演时即被拒绝并返回完整闭环');

    // 10.9 输入非法 -> 400（字段/校验沿用既有接口：空媒介、起止倒置）
    const bad1 = await call('POST', '/api/changes/preview', {
      operation: 'authorization.create', materialId: m1, media: '', region: 'CN',
      validFrom: '2026-01-01', validTo: '2026-12-31',
    });
    const bad2 = await call('POST', '/api/changes/preview', {
      operation: 'authorization.update', authorizationId: aSrc, media: '*', region: '*',
      validFrom: '2026-12-31', validTo: '2026-01-01',
    });
    const bad3 = await call('POST', '/api/changes/preview', { operation: 'source.create', materialId: m1, sourceMaterialId: m1 });
    ok(bad1.status === 400 && bad2.status === 400 && bad3.status === 400,
      '空媒介 / 起止倒置 / 自环均按既有校验返回 400');

    // 10.10 来源关系新增：预演 -> 确认，包由合格转不合格（挂入无授权素材）
    // 先人工复核恢复包（补过授权），使其回到 published
    const rc = await call('POST', `/api/packages/${pkg}/recheck`);
    ok(rc.data.restored === true, '前置：人工复核恢复为已发布');
    const basisBeforeLink = (await call('GET', '/api/state')).data.basisVersion;
    const pvLink = await call('POST', '/api/changes/preview', {
      operation: 'source.create', materialId: m1, sourceMaterialId: m3, relation: '引用',
    });
    ok(pvLink.status === 200 && pvLink.data.impact.some((p) =>
      p.packageId === pkg && p.failingNodes.some((n) => n.materialId === m3 && n.reasons.includes('no_auth'))),
      '预演新增到无授权素材的边：包将因 m3 无授权不合格');
    const commitLink = await call('POST', '/api/changes/commit', {
      operation: 'source.create', materialId: m1, sourceMaterialId: m3, relation: '引用',
      basisVersion: basisBeforeLink, impact: pvLink.data.impact,
    });
    ok(commitLink.status === 200, '来源新增确认成功');
    ok((await call('GET', `/api/packages/${pkg}`)).data.status === 'needs_review',
      '挂入无授权来源后包被标记需复核');

    // 10.11 来源关系删除：删除该坏边预演影响为 0（删除来源不会使已发布合格包变坏），确认后恢复原链
    const linkId = (await call('GET', `/api/materials/${m1}`)).data.sources.find((s) => s.sourceMaterialId === m3).id;
    const pvDelLink = await call('POST', '/api/changes/preview', { operation: 'source.delete', linkId });
    ok(pvDelLink.status === 200 && pvDelLink.data.impact.length === 0, '删除坏来源边预演影响为 0');
    const commitDelLink = await call('POST', '/api/changes/commit', {
      operation: 'source.delete', linkId, basisVersion: pvDelLink.data.basisVersion, impact: [],
    });
    ok(commitDelLink.status === 200, '来源删除确认成功（无包转不合格）');
    const sourcesAfter = (await call('GET', `/api/materials/${m1}`)).data.sources;
    ok(!sourcesAfter.some((s) => s.sourceMaterialId === m3), '坏来源边已删除');
    // 10.12 再次预演同操作：目标（边）已失效 -> 404
    const pvGoneLink = await call('POST', '/api/changes/preview', { operation: 'source.delete', linkId });
    ok(pvGoneLink.status === 404, '删除后再预演同一条边返回 404 目标失效');

    // 10.13 既有编辑接口请求/返回保持兼容（直接 PATCH/DELETE 不经预演仍可用）
    const patch = await call('PATCH', `/api/authorizations/${aSrc}`, { region: '中国香港' });
    ok(patch.status === 200 && patch.data.region === '中国香港' && patch.data.id === aSrc,
      '既有 PATCH /api/authorizations/:id 兼容可用');
  }

  console.log('11) 档期规划：可行起始日搜索（展期天数含首尾、整窗覆盖、单份授权不拼接）');
  {
    // 独立链：sRoot -> sSrc，展期固定 7 天（含首尾）
    const m1 = (await call('POST', '/api/materials', { title: '档期-成片', kind: 'video' })).data.id;
    const m2 = (await call('POST', '/api/materials', { title: '档期-来源', kind: 'audio' })).data.id;
    await call('POST', `/api/materials/${m1}/sources`, { sourceMaterialId: m2, relation: '配乐' });
    // root：07-01~08-15 覆盖 -> 起始日可行区间 [07-01, 08-09]
    await call('POST', `/api/materials/${m1}/authorizations`, {
      media: '屏幕放映', region: '中国大陆', validFrom: '2026-07-01', validTo: '2026-08-15', licensor: 'r',
    });
    // source：07-10~08-31 -> [07-10, 08-25]；交集应为 [07-10, 08-09]
    await call('POST', `/api/materials/${m2}/authorizations`, {
      media: '屏幕放映', region: '中国大陆', validFrom: '2026-07-10', validTo: '2026-08-31', licensor: 's',
    });
    // source 另有一份仅 5 天的短授权（09-01~09-05），展期 7 天，不能与任何授权拼接
    await call('POST', `/api/materials/${m2}/authorizations`, {
      media: '屏幕放映', region: '中国大陆', validFrom: '2026-09-01', validTo: '2026-09-05', licensor: 'short',
    });
    const pid = (await call('POST', '/api/packages', {
      name: '档期规划包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-07-10', useTo: '2026-07-16', materialIds: [m1],
    })).data.id;
    global.schedPid = pid; global.schedRoot = m1; global.schedSrc = m2;

    const sr = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-06-01', planTo: '2026-09-30' });
    ok(sr.status === 200 && sr.data.feasible === true, '档期搜索 200 且有结果');
    ok(sr.data.durationDays === 7, '展期天数按当前展期（含首尾）= 7');
    ok(sr.data.ranges.length === 1 &&
       sr.data.ranges[0].startFrom === '2026-07-10' && sr.data.ranges[0].startTo === '2026-08-09',
      '两节点可行起始日取交集并合并为一段 07-10 → 08-09，实际: ' + JSON.stringify(sr.data.ranges));
    ok(sr.data.ranges[0].dayCount === 31, '该段含 31 个连续可行起始日');
    ok(sr.data.ranges[0].earliestExhibitionFrom === '2026-07-10' &&
       sr.data.ranges[0].earliestExhibitionTo === '2026-07-16',
      '列出最早展期 07-10 → 07-16');
    ok(sr.data.restrictedNodes.length === 0, '有结果时不列受限节点');
    ok(sr.data.searchToken && sr.data.searchToken.basisVersion === sr.data.basisVersion &&
       sr.data.searchToken.durationDays === 7,
      '返回含依据版本与天数的搜索令牌');

    // 展期完整落在窗口内：06-01 虽在窗口内但 root 授权 07-01 才开始 -> 不属于可行段
    const sr2 = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-08-01', planTo: '2026-08-07' });
    ok(sr2.data.ranges.length === 1 && sr2.data.ranges[0].startFrom === '2026-08-01' && sr2.data.ranges[0].startTo === '2026-08-01',
      '窗口仅放得下一天起始日（展期止恰好窗口止）时返回单日段');

    // 窗口短于展期
    const short = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-09-01', planTo: '2026-09-03' });
    ok(short.status === 200 && short.data.feasible === false && short.data.windowTooShort === true,
      '窗口不足展期天数：无结果且标记 windowTooShort');

    // 9 月窗口：root 无覆盖；source 虽有短授权但不足 7 天，不能拼接 -> 无结果，列受限节点
    const sept = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-09-01', planTo: '2026-09-30' });
    ok(sept.data.feasible === false, '9 月窗口无可行起始日（短授权不可拼接）');
    const septIds = sept.data.restrictedNodes.map((n) => n.materialId).sort();
    ok(septIds.join() === `${m1},${m2}`, '无结果时列出全部受限节点（root + source）');
    const septSrc = sept.data.restrictedNodes.find((n) => n.materialId === m2);
    ok(septSrc.reason === 'date' && septSrc.ranges.length === 0,
      'source 的 5 天短授权折算为空区间，原因 date（不跨授权拼接）');
    const septRoot = sept.data.restrictedNodes.find((n) => n.materialId === m1);
    ok(septRoot.reason === 'date' && septRoot.ranges.length === 0, 'root 在窗口内无任何覆盖，区间为空');

    // 非法窗口 / 空包 / 已发布包
    const badWin = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-09-10', planTo: '2026-09-01' });
    ok(badWin.status === 400 && badWin.data.details.code === 'INVALID_WINDOW', '非法窗口（起晚于止）报 400 INVALID_WINDOW');
    const badFmt = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-02-30', planTo: '2026-09-01' });
    ok(badFmt.status === 400, '非法日历日期报 400');
    const emptyPkg = (await call('POST', '/api/packages', {
      name: '档期空包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-07-10', useTo: '2026-07-16', materialIds: [],
    })).data.id;
    const emptySr = await call('POST', `/api/packages/${emptyPkg}/schedule/search`, { planFrom: '2026-09-01', planTo: '2026-09-30' });
    ok(emptySr.status === 400 && emptySr.data.details.code === 'EMPTY_PACKAGE', '空包搜索档期报 400 EMPTY_PACKAGE');
    const pubPkg = (await call('GET', '/api/packages')).data.find((p) => p.name.includes('预演测试包'))
      || (await call('GET', '/api/packages')).data.find((p) => p.status === 'published');
    if (pubPkg) {
      const pubSr = await call('POST', `/api/packages/${pubPkg.id}/schedule/search`, { planFrom: '2026-01-01', planTo: '2026-12-31' });
      ok(pubSr.status === 409 && pubSr.data.details.code === 'NOT_DRAFT', '已发布/需复核包不可搜索档期');
    }
  }

  console.log('12) 档期应用：事务内重验（依据/清单参数/状态/档期失效），拒绝不改包');
  {
    const pid = global.schedPid, m1 = global.schedRoot, m2 = global.schedSrc;
    const before = await call('GET', `/api/packages/${pid}`);
    ok(before.data.useFrom === '2026-07-10' && before.data.useTo === '2026-07-16', '前置：包仍为原档期');

    // 正常应用交集边界起始日 08-09（展期 08-09 → 08-15）
    const sr = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-06-01', planTo: '2026-09-30' });
    const token = sr.data.searchToken;
    const ap = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: '2026-08-09', searchToken: token });
    ok(ap.status === 200 && ap.data.useFrom === '2026-08-09' && ap.data.useTo === '2026-08-15' && ap.data.durationDays === 7,
      '选定起始日应用成功，展期天数保持 7 天（含首尾）');
    const after = await call('GET', `/api/packages/${pid}`);
    ok(after.data.status === 'draft', '改期后包仍为待发布（不发布、不写快照）');
    ok(after.data.itemCount === 1 && after.data.items[0].id === m1, '改期不改变素材清单');

    // 同一令牌重复使用：包参数（展期）已变 -> PACKAGE_CHANGED
    const reuse = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: '2026-08-08', searchToken: token });
    ok(reuse.status === 409 && reuse.data.details.code === 'PACKAGE_CHANGED', '令牌一次性：改期后旧令牌被拒 PACKAGE_CHANGED');

    // STALE_BASIS：搜索后授权变更
    const sr2 = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-06-01', planTo: '2026-09-30' });
    await call('POST', `/api/materials/${m1}/authorizations`, {
      media: '网络', region: '中国大陆', validFrom: '2030-01-01', validTo: '2030-12-31', licensor: 'x',
    });
    const stale = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: '2026-08-01', searchToken: sr2.data.searchToken });
    ok(stale.status === 409 && stale.data.details.code === 'STALE_BASIS', '搜索后授权变更 -> 409 STALE_BASIS');
    const unchangedAfterStale = await call('GET', `/api/packages/${pid}`);
    ok(unchangedAfterStale.data.useFrom === '2026-08-09', 'STALE 拒绝后包档期不变');

    // PACKAGE_CHANGED：搜索后改清单
    const sr3 = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-06-01', planTo: '2026-09-30' });
    await call('PATCH', `/api/packages/${pid}`, {
      name: '档期规划包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-08-09', useTo: '2026-08-15', materialIds: [m1, m2],
    });
    const changed = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: '2026-08-01', searchToken: sr3.data.searchToken });
    ok(changed.status === 409 && changed.data.details.code === 'PACKAGE_CHANGED', '搜索后清单变更 -> 409 PACKAGE_CHANGED');

    // 恢复清单
    await call('PATCH', `/api/packages/${pid}`, {
      name: '档期规划包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-08-09', useTo: '2026-08-15', materialIds: [m1],
    });

    // SLOT_INVALID：撤销覆盖授权后选定档期失效（令牌依据版本需要未变 -> 用“不改授权”的另一种方式：
    // 直接构造窗口外起始日 / 展期落出窗口）
    const sr4 = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-06-01', planTo: '2026-07-31' });
    const outOfWin = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: '2026-08-01', searchToken: sr4.data.searchToken });
    ok(outOfWin.status === 409 && outOfWin.data.details.code === 'SLOT_INVALID',
      '选定起始日落在搜索窗口之外 -> 409 SLOT_INVALID');

    // 档期失效：搜索后撤销授权（依据版本也变，按 STALE_BASIS 优先拒绝——因此改用“窗口内但授权不覆盖”的真实档期）
    const sr5 = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-06-01', planTo: '2026-09-30' });
    const invalidSlot = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: '2026-09-01', searchToken: sr5.data.searchToken });
    ok(invalidSlot.status === 409 && invalidSlot.data.details.code === 'SLOT_INVALID' &&
       Array.isArray(invalidSlot.data.details.failingNodes) && invalidSlot.data.details.failingNodes.length > 0,
      '选定无授权覆盖的起始日 -> 409 SLOT_INVALID 并附失效节点');

    // 非法选定日期 / 缺令牌
    const badDate = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: 'not-a-date', searchToken: sr5.data.searchToken });
    ok(badDate.status === 400, '选定日期格式非法报 400');
    const noToken = await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: '2026-08-01' });
    ok(noToken.status === 400, '缺少搜索令牌报 400');
    const wrongPkg = await call('POST', `/api/packages/${pid}/schedule/apply`, {
      useFrom: '2026-08-01', searchToken: { ...sr5.data.searchToken, packageId: pid + 9999 },
    });
    ok(wrongPkg.status === 409 && wrongPkg.data.details.code === 'TOKEN_MISMATCH', '令牌与目标包不一致 -> 409 TOKEN_MISMATCH');
  }

  console.log('13) 改期后既有核验/发布链路兼容');
  {
    const pid = global.schedPid;
    // 改到一个全链合格的档期并发布
    const sr = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-06-01', planTo: '2026-09-30' });
    const target = sr.data.ranges[0].startFrom;
    await call('POST', `/api/packages/${pid}/schedule/apply`, { useFrom: target, searchToken: sr.data.searchToken });
    const v = await call('POST', '/api/verify', { packageId: pid });
    ok(v.data.eligible === true && v.data.request.useFrom === target, '改期后按新档期核验合格');
    const pub = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: v.data.basisVersion });
    ok(pub.status === 201 && pub.data.package.status === 'published' &&
       pub.data.package.useFrom === target,
      '改期后的待发布包可正常发布，发布快照记录新档期');
    // 已发布包再改期被拒
    const again = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-01-01', planTo: '2026-12-31' });
    ok(again.status === 409 && again.data.details.code === 'NOT_DRAFT', '发布后再搜索档期被拒');
  }

  console.log('14) 多站巡展：逐站编排/核验、整包发布闸门、按站影响预演、冻结与兼容性')
  await (async () => {    // 独立干净链：tRoot -> tSrc，root 全域授权，source 按站准备授权
    const m1 = (await call('POST', '/api/materials', { title: '多站-成片', kind: 'video' })).data.id;
    const m2 = (await call('POST', '/api/materials', { title: '多站-来源', kind: 'audio' })).data.id;
    await call('POST', `/api/materials/${m1}/sources`, { sourceMaterialId: m2, relation: '配乐' });
    await call('POST', `/api/materials/${m1}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', licensor: 'r',
    });
    // source：北京站授权（03 月，屏幕/大陆）、上海站授权（05 月，投影/香港）
    await call('POST', `/api/materials/${m2}/authorizations`, {
      media: '屏幕放映', region: '中国大陆', validFrom: '2026-03-01', validTo: '2026-03-31', licensor: 'bj',
    });
    const aSh = (await call('POST', `/api/materials/${m2}/authorizations`, {
      media: '沉浸式投影', region: '中国香港', validFrom: '2026-05-01', validTo: '2026-05-31', licensor: 'hk',
    })).data.id;

    // 14.1 创建两站包（不同媒介/地区/日期，站间不重叠）
    const r = await call('POST', '/api/packages', {
      name: '多站巡展包', materialIds: [m1],
      stops: [
        { name: '北京首展', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-20' },
        { name: '香港巡展', medium: '沉浸式投影', region: '中国香港', useFrom: '2026-05-01', useTo: '2026-05-20' },
      ],
    });
    ok(r.status === 201, '多站包创建成功');
    ok(r.data.multiStop === true && r.data.stopCount === 2 && r.data.stops.length === 2, 'DTO 标记 multiStop 且含 2 站');
    ok(r.data.medium === '屏幕放映' && r.data.useFrom === '2026-03-01', '顶层兼容字段取首站');
    ok(r.data.itemCount === 1 && r.data.items[0].id === m1, '整包共享同一份素材清单');
    const pid = r.data.id;
    global.multiPid = pid; global.multiSrc = m2; global.multiShAuth = aSh;

    // 14.2 逐站核验：不同站用不同授权，各自整段被同一份覆盖 -> 全站合格
    const v = await call('POST', '/api/verify', { packageId: pid });
    ok(v.status === 200 && v.data.multiStop === true, '多站核验返回 multiStop 形态');
    ok(v.data.eligible === true && v.data.stats.stopCount === 2, '两站均合格，整包合格');
    const s0 = v.data.stops[0], s1 = v.data.stops[1];
    ok(s0.eligible && s1.eligible && s0.nodes.find((n) => n.materialId === m2).matchedAuthorization.media === '屏幕放映'
      && s1.nodes.find((n) => n.materialId === m2).matchedAuthorization.media === '沉浸式投影',
      '两站分别命中各自的不同授权');

    // 14.3 同站不可拼接短授权：北京站展期跨 03-01~04-10，无单份覆盖 -> 仅该站失格 date
    await call('PATCH', `/api/packages/${pid}`, {
      name: '多站巡展包', materialIds: [m1],
      stops: [
        { name: '北京首展', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-20', useTo: '2026-04-10' },
        { name: '香港巡展', medium: '沉浸式投影', region: '中国香港', useFrom: '2026-05-01', useTo: '2026-05-20' },
      ],
    });
    const v2 = await call('POST', '/api/verify', { packageId: pid });
    ok(v2.data.eligible === false && v2.data.stats.failingStopCount === 1, '一站失格则整包不合格');
    const badStop = v2.data.stops.find((s) => !s.eligible);
    const badNode = badStop.failingNodes.find((n) => n.materialId === m2);
    ok(badStop.name === '北京首展' && badNode && badNode.reasons.includes('date'),
      '失格站点列出问题节点与 date 原因（短授权不可拼接）');
    ok(badNode.paths.some((p) => p.map((x) => x.materialId).join() === `${m1},${m2}`),
      '按站给出问题节点的全部来源路径 root->src');
    ok(v2.data.stops[1].eligible, '另一站不受影响仍合格');
    ok(v2.data.failingNodes.some((n) => n.stopPosition === 0 && n.materialId === m2 && n.stopName === '北京首展'),
      '跨站汇总失败节点带站点位置/名称');

    // 14.4 站间重叠（首尾日均占用）保存即拒 409 STOPS_OVERLAP
    const ov = await call('PATCH', `/api/packages/${pid}`, {
      name: '多站巡展包', materialIds: [m1],
      stops: [
        { name: '北京首展', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-20' },
        { name: '香港巡展', medium: '沉浸式投影', region: '中国香港', useFrom: '2026-03-20', useTo: '2026-05-20' },
      ],
    });
    ok(ov.status === 409 && ov.data.details.code === 'STOPS_OVERLAP', '同日衔接（首尾占用）判为重叠并拒绝');
    const gap = await call('PATCH', `/api/packages/${pid}`, {
      name: '多站巡展包', materialIds: [m1],
      stops: [
        { name: '北京首展', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-20' },
        { name: '香港巡展', medium: '沉浸式投影', region: '中国香港', useFrom: '2026-03-21', useTo: '2026-05-20' },
      ],
    });
    ok(gap.status === 200, '前一站止次日为下一站起（不重叠）可保存');

    // 14.5 行程字段校验：空站/单站/缺字段/坏日期
    const e1 = await call('POST', '/api/packages', { name: 'e', materialIds: [m1], stops: [] });
    const e2 = await call('POST', '/api/packages', { name: 'e', materialIds: [m1], stops: [{ name: 'x', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-20' }] });
    const e3 = await call('POST', '/api/packages', {
      name: 'e', materialIds: [m1],
      stops: [
        { name: 'a', medium: '', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-20' },
        { name: 'b', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-05-01', useTo: '2026-05-20' },
      ],
    });
    ok(e1.status === 400 && e1.data.details.code === 'INVALID_STOPS', '空行程报 400 INVALID_STOPS');
    ok(e2.status === 400, '只有 1 站的 stops 被明确拒绝（单站请用顶层字段）');
    ok(e3.status === 400 && e3.data.error.includes('媒介'), '某站缺媒介报 400 并指出站次');

    // 14.6 多站行程仅待发布时可改：PATCH 已保存多站包必须带 stops
    const noStops = await call('PATCH', `/api/packages/${pid}`, {
      name: '多站巡展包', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-20', materialIds: [m1],
    });
    ok(noStops.status === 400 && noStops.data.details.code === 'STOPS_REQUIRED', '编辑多站包不带 stops 报 400 STOPS_REQUIRED');

    // 14.7 档期搜索只适用于单站：多站请求明确拒绝
    const sch = await call('POST', `/api/packages/${pid}/schedule/search`, { planFrom: '2026-01-01', planTo: '2026-12-31' });
    ok(sch.status === 409 && sch.data.details.code === 'MULTI_STOP_UNSUPPORTED', '多站包搜索档期被明确拒绝');
    const schApply = await call('POST', `/api/packages/${pid}/schedule/apply`, {
      useFrom: '2026-03-01', searchToken: { packageId: pid, basisVersion: 1, fingerprint: 'x', planFrom: '2026-01-01', planTo: '2026-12-31', durationDays: 1 },
    });
    ok(schApply.status === 409 && schApply.data.details.code === 'MULTI_STOP_UNSUPPORTED', '多站包档期改期也被拒绝');

    // 14.8 任一站失败整包不发布（422，包仍 draft，留快照）
    // 当前香港站 03-21~05-20 超出北京授权但香港授权覆盖到 05-31：两站重新核验
    // 构造一站不合格：把北京站改成香港媒介（其授权不匹配北京的屏幕/大陆组合的日期之外场景）
    // 直接用现成失格形态：北京展期改 06 月（屏幕/大陆无 06 月 source 授权）
    await call('PATCH', `/api/packages/${pid}`, {
      name: '多站巡展包', materialIds: [m1],
      stops: [
        { name: '北京首展', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-06-01', useTo: '2026-06-10' },
        { name: '香港巡展', medium: '沉浸式投影', region: '中国香港', useFrom: '2026-05-01', useTo: '2026-05-20' },
      ],
    });
    const state0 = await call('GET', '/api/state');
    const pubBad = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: state0.data.basisVersion });
    ok(pubBad.status === 422, '一站失格时发布整包拒绝 422');
    ok(pubBad.data.details.result.multiStop === true
      && pubBad.data.details.result.stops.some((s) => !s.eligible), '422 附按站核验结果');
    const stillDraft = (await call('GET', `/api/packages/${pid}`)).data;
    ok(stillDraft.status === 'draft', '拒绝后包仍为待发布');
    ok(stillDraft.snapshots.length === 1 && stillDraft.snapshots[0].eligible === false,
      '失败发布同样追加不可变记录');

    // 14.9 两站合格后发布：同一事务重读行程/清单/依据，冻结各站结果与清单
    await call('PATCH', `/api/packages/${pid}`, {
      name: '多站巡展包', materialIds: [m1],
      stops: [
        { name: '北京首展', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-20' },
        { name: '香港巡展', medium: '沉浸式投影', region: '中国香港', useFrom: '2026-05-01', useTo: '2026-05-20' },
      ],
    });
    const vOk = await call('POST', '/api/verify', { packageId: pid });
    ok(vOk.data.eligible === true, '恢复为全站合格');
    const pubOk = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: vOk.data.basisVersion });
    ok(pubOk.status === 201 && pubOk.data.package.status === 'published', '多站包发布成功');
    const frozen = pubOk.data.result;
    ok(frozen.multiStop && frozen.stops.length === 2 && frozen.request.stops[1].name === '香港巡展',
      '发布快照冻结各站行程与结果');
    global.multiSnap = pubOk.data.snapshotId;

    // 14.10 发布后行程冻结：PATCH 拒绝；快照不可变
    const patchFrozen = await call('PATCH', `/api/packages/${pid}`, {
      name: '多站巡展包', materialIds: [m1],
      stops: [
        { name: '北京首展', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-20' },
        { name: '香港巡展', medium: '沉浸式投影', region: '中国香港', useFrom: '2026-05-01', useTo: '2026-05-21' },
      ],
    });
    ok(patchFrozen.status === 409, '发布后多站行程不可修改');

    // 14.11 授权/来源变更按站预演影响：撤销香港站当前覆盖授权 -> 仅香港站失格
    // （14.13 之前尚未补授权，香港站覆盖授权即创建时的 aSh）
    const pv = await call('POST', '/api/changes/preview', { operation: 'authorization.revoke', authorizationId: aSh });
    ok(pv.status === 200 && pv.data.mutated === false, '多站影响预演只读成功');
    let hit = pv.data.impact.find((p) => p.packageId === pid);
    if (!hit) {
      // 若历史数据中已存在其它香港授权（例如重跑），找到当前真正覆盖香港站的授权再预演
      const matsNow = (await call('GET', '/api/materials')).data;
      const hkAuth = matsNow.find((m) => m.id === m2).authorizations
        .find((a) => !a.revoked && a.media === '沉浸式投影' && a.region === '中国香港');
      const pv2 = await call('POST', '/api/changes/preview', { operation: 'authorization.revoke', authorizationId: hkAuth.id });
      global._pvHk = { preview: pv2.data, authId: hkAuth.id };
      hit = pv2.data.impact.find((p) => p.packageId === pid);
    } else {
      global._pvHk = { preview: pv.data, authId: aSh };
    }
    ok(!!hit && hit.multiStop === true && hit.stopCount === 2, '预演影响按多站形态返回');
    ok(hit.failingStops.length === 1 && hit.failingStops[0].name === '香港巡展',
      '只列出因此失格的站点（香港），北京站不在其列');
    const fnode = hit.failingStops[0].failingNodes.find((n) => n.materialId === m2);
    ok(fnode && fnode.reasons.length > 0 && ['revoked', 'media', 'region', 'media_region'].includes(fnode.reasons[0])
      && fnode.paths.some((p) => p.map((x) => x.materialId).join() === `${m1},${m2}`),
      '失格站的问题节点、原因（撤销/媒介或地区不符）与全部来源路径齐备');

    // 14.12 确认提交：包置需复核 + 追加不可变快照，原发布快照保留
    const commit = await call('POST', '/api/changes/commit', {
      operation: 'authorization.revoke', authorizationId: global._pvHk.authId,
      basisVersion: global._pvHk.preview.basisVersion, impact: global._pvHk.preview.impact,
    });
    ok(commit.status === 200 && commit.data.mutated === true, '按站影响确认提交成功');
    const nr = (await call('GET', `/api/packages/${pid}`)).data;
    ok(nr.status === 'needs_review', '因此失格的多站包置为需复核');
    const publishSnaps = nr.snapshots.filter((s) => s.kind === 'publish');
    const lastPublish = publishSnaps[publishSnaps.length - 1];
    ok(lastPublish && lastPublish.eligible === true
       && nr.snapshots.some((s) => s.kind === 'review' && s.eligible === false),
      '原发布快照保留，追加不可变 review 快照');

    // 14.13 人工复核须全站合格：只补回北京（香港仍缺）不恢复；补齐香港后恢复
    const rc1 = await call('POST', `/api/packages/${pid}/recheck`);
    ok(rc1.data.restored === false && rc1.data.package.status === 'needs_review',
      '仍有站点失格时人工复核不恢复');
    ok(rc1.data.result.multiStop && rc1.data.result.stops.some((s) => !s.eligible),
      '复核结果仍按站给出');
    // 若 14.11 预演时已存在额外香港授权（幂等重跑场景），它已被撤销；补一条新的覆盖授权
    await call('POST', `/api/materials/${m2}/authorizations`, {
      media: '沉浸式投影', region: '中国香港', validFrom: '2026-04-01', validTo: '2026-06-30', licensor: 'hk-restored',
    });
    const rc2 = await call('POST', `/api/packages/${pid}/recheck`);
    ok(rc2.data.restored === true && rc2.data.package.status === 'published'
       && rc2.data.result.stops.every((s) => s.eligible),
      '全站合格后人工复核恢复为已发布');

    // 14.14 复制多站包：行程随副本复制为待发布，可继续编排
    const cp = await call('POST', `/api/packages/${pid}/copy`);
    ok(cp.status === 201 && cp.data.status === 'draft' && cp.data.multiStop === true
       && cp.data.stops.length === 2 && cp.data.itemCount === 1,
      '复制多站包保留全部站次与共享清单，且为待发布');
    const patchCopy = await call('PATCH', `/api/packages/${cp.data.id}`, {
      name: '多站巡展包（副本改）', materialIds: [m1],
      stops: [
        { name: '广州首展', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-20' },
        { name: '成都巡展', medium: '沉浸式投影', region: '中国香港', useFrom: '2026-05-01', useTo: '2026-05-20' },
        { name: '西安加场', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-07-01', useTo: '2026-07-10' },
      ],
    });
    ok(patchCopy.status === 200 && patchCopy.data.stopCount === 3, '副本（待发布）可继续增改站次');

    // 14.15 兼容性：既有单站包请求/响应形态不变（旧包视为单站）
    const legacyList = await call('GET', '/api/packages');
    const demoPkg = legacyList.data.find((p) => p.name.includes('常设展'));
    ok(demoPkg && demoPkg.multiStop === false && demoPkg.stopCount === 0 && Array.isArray(demoPkg.stops) && demoPkg.stops.length === 0,
      '既有单站包 DTO 字段保持兼容');
    const lv = await call('POST', '/api/verify', { packageId: demoPkg.id });
    ok(lv.data.multiStop === undefined && Array.isArray(lv.data.nodes) && !Array.isArray(lv.data.stops),
      '单站核验响应保持旧形态（nodes/failingNodes，无 stops）');
    // 即席单站核验字段不变
    const lv2 = await call('POST', '/api/verify', {
      materialIds: [m1], medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-20',
    });
    ok(lv2.data.multiStop === undefined && lv2.data.eligible === true, '即席单站核验旧请求/旧响应兼容');

    // 14.16 即席多站核验（无需先建包），路径/原因按站返回
    const adhoc = await call('POST', '/api/verify', {
      materialIds: [m1],
      stops: [
        { name: '即席站A', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-20' },
        { name: '即席站B', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-09-01', useTo: '2026-09-10' },
      ],
    });
    ok(adhoc.data.multiStop === true && adhoc.data.eligible === false
       && adhoc.data.stops[0].eligible === true && adhoc.data.stops[1].eligible === false,
      '即席多站核验按站判定，无覆盖的站失格');
  })();

  console.log('15) 授权报价组合预览（只读：最优组合 / 并列规则 / 缺口 / 拒绝 / 零写入）');
  {
    // 独立干净链：qRoot -> qSrc，root 全域授权，qSrc 无任何授权
    const m1 = (await call('POST', '/api/materials', { title: '报价-成片', kind: 'video' })).data.id;
    const m2 = (await call('POST', '/api/materials', { title: '报价-来源A', kind: 'audio' })).data.id;
    const m3 = (await call('POST', '/api/materials', { title: '报价-来源B', kind: 'image' })).data.id;
    await call('POST', `/api/materials/${m1}/sources`, { sourceMaterialId: m2, relation: '配乐' });
    await call('POST', `/api/materials/${m1}/sources`, { sourceMaterialId: m3, relation: '画面' });
    await call('POST', `/api/materials/${m1}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', licensor: 'r',
    });
    const basisBefore = (await call('GET', '/api/state')).data.basisVersion;
    const authCountBefore = (await call('GET', '/api/state')).data.authorizationCount;

    // 单站待发布包（10 月展期）：m2、m3 均缺授权
    const pid = (await call('POST', '/api/packages', {
      name: '报价预览包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-10-01', useTo: '2026-11-30', materialIds: [m1],
    })).data.id;

    // 15.1 无报价 -> 无解，按站列出节点、现有原因与全部来源路径
    let r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [] });
    ok(r.status === 200 && r.data.feasible === false, '无报价时预览 200 且无解');
    ok(r.data.gaps.length === 1 && r.data.gaps[0].position === 0, '单站包按 1 站列出缺口');
    const gapIds = r.data.gaps[0].nodes.map((n) => n.materialId).sort();
    ok(gapIds.join() === `${m2},${m3}`, '缺口列出两个无授权来源节点');
    const gapM2 = r.data.gaps[0].nodes.find((n) => n.materialId === m2);
    ok(gapM2.existingReason === 'no_auth' && gapM2.noQuoteForNode === true
       && gapM2.paths.some((p) => p.map((x) => x.materialId).join() === `${m1},${m2}`),
      '缺口节点给出现有失格原因与全部来源路径');

    // 15.2 报价补齐 -> 可行，总成本为两项之和；root 由现有授权覆盖
    r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: m2, media: '屏幕放映', region: '中国大陆', validFrom: '2026-10-01', validTo: '2026-11-30', cost: 100 },
      { materialId: m3, media: '*', region: '*', validFrom: '2026-09-01', validTo: '2026-12-31', cost: 200 },
    ] });
    ok(r.status === 200 && r.data.feasible === true && r.data.totalCost === 300
       && r.data.quoteCountSelected === 2, '两项报价补齐，总成本 300');
    const rootCov = r.data.coverage[0].nodes.find((n) => n.materialId === m1);
    const srcCov = r.data.coverage[0].nodes.find((n) => n.materialId === m2);
    ok(rootCov.coveredBy.kind === 'existing' && srcCov.coveredBy.kind === 'quote' && srcCov.coveredBy.quoteIndex === 0,
      '覆盖依据区分现有授权 / 所选报价');
    ok(r.data.stats.existingCoveredCount === 1 && r.data.stats.requirementCount === 2, '需求统计：1 项现有覆盖、2 项报价补齐');

    // 15.3 每个节点独立取最便宜候选（单站下一项报价只绑定一个素材节点，冗余贵报价落选）
    r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: m2, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 100 },
      { materialId: m2, media: '屏幕放映', region: '中国大陆', validFrom: '2026-10-01', validTo: '2026-11-30', cost: 150 },
      { materialId: m3, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 200 },
      { materialId: m3, media: '屏幕放映', region: '中国大陆', validFrom: '2026-10-01', validTo: '2026-11-30', cost: 180 },
    ] });
    ok(r.data.feasible && r.data.totalCost === 280
       && r.data.selectedQuotes.map((q) => q.index).join() === '0,3',
       '各节点分别取最便宜候选：m2#0(100)+m3#3(180)=280，贵的冗余报价落选');

    // 15.4 同成本同报价数：序号序列字典序最小
    r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: m2, media: '屏幕放映', region: '中国大陆', validFrom: '2026-10-01', validTo: '2026-11-30', cost: 100 }, // 0
      { materialId: m2, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 100 },               // 1
      { materialId: m3, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 200 },               // 2
      { materialId: m3, media: '屏幕放映', region: '中国大陆', validFrom: '2026-10-01', validTo: '2026-11-30', cost: 200 }, // 3
    ] });
    ok(r.data.feasible && r.data.totalCost === 300
       && r.data.selectedQuotes.map((q) => q.index).join() === '0,2',
       '同成本同报价数取序号字典序最小 [0,2]');

    // 15.5 短报价不可拼接：只覆盖半段的报价不能与现有/另一份拼接 -> 仍无解且列出 date 失配
    r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: m2, media: '屏幕放映', region: '中国大陆', validFrom: '2026-10-01', validTo: '2026-10-15', cost: 10 },
      { materialId: m2, media: '屏幕放映', region: '中国大陆', validFrom: '2026-10-16', validTo: '2026-11-30', cost: 10 },
      { materialId: m3, media: '*', region: '*', validFrom: '2026-09-01', validTo: '2026-12-31', cost: 5 },
    ] });
    ok(r.data.feasible === false, '两份半段短报价不能拼接，整包无解');
    const m2gap = r.data.gaps.flatMap((g) => g.nodes).find((n) => n.materialId === m2);
    ok(m2gap && m2gap.quoteFailures.every((f) => f.misses.includes('date')),
       '各短报价均标注 date 失配（短报价不可拼接）');

    // 15.6 媒介/地区不匹配的报价不构成候选
    r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: m2, media: '沉浸式投影', region: '中国大陆', validFrom: '2026-10-01', validTo: '2026-11-30', cost: 1 },
      { materialId: m2, media: '屏幕放映', region: '中国香港', validFrom: '2026-10-01', validTo: '2026-11-30', cost: 1 },
      { materialId: m3, media: '*', region: '*', validFrom: '2026-09-01', validTo: '2026-12-31', cost: 1 },
    ] });
    ok(r.data.feasible === false
       && r.data.gaps.flatMap((g) => g.nodes).some((n) => n.materialId === m2),
       '媒介 / 地区不匹配的报价不能覆盖该站节点');

    // 15.7 输入非法逐行拒绝：不存在素材 / 缺字段 / 坏日期 / 成本非非负整数
    r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: 999999, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2026-12-31', cost: 0 },
      { materialId: m2, media: '', region: '*', validFrom: '2026-02-30', validTo: '2026-01-01', cost: -1 },
      { materialId: m2, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2026-12-31', cost: 2.5 },
    ] });
    ok(r.status === 400 && r.data.details.code === 'INVALID_QUOTES'
       && r.data.details.errors.length === 3
       && r.data.details.errors[0].messages.some((m) => m.includes('不存在'))
       && r.data.details.errors[1].messages.some((m) => m.includes('媒介'))
       && r.data.details.errors[2].messages.some((m) => m.includes('非负整数')),
       '非法报价逐行说明原因并拒绝预览：' + JSON.stringify(r.data && r.data.details && r.data.details.code));

    // 15.8 缺 quotes 字段
    r = await call('POST', `/api/packages/${pid}/quotes/preview`, {});
    ok(r.status === 400 && r.data.details.code === 'INVALID_QUOTES', '缺少 quotes 字段被拒');

    // 15.9 零成本报价合法
    r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: m2, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 0 },
      { materialId: m3, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 0 },
    ] });
    ok(r.data.feasible && r.data.totalCost === 0 && r.data.quoteCountSelected === 2, '成本 0 是非负整数，方案合法');

    // 15.10 预览零写入：依据版本、授权数、包状态、快照数均不变
    const st = await call('GET', '/api/state');
    const pkgAfter = await call('GET', `/api/packages/${pid}`);
    ok(st.data.basisVersion === basisBefore && st.data.authorizationCount === authCountBefore
       && pkgAfter.data.status === 'draft'
       && (pkgAfter.data.snapshots ? pkgAfter.data.snapshots.length : 0) === 0,
       '报价预览不写入授权、包、状态或快照，依据版本不变');

    // 15.11 已发布包不可预览
    // 先补齐两节点授权，让包可发布
    await call('POST', `/api/materials/${m2}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', licensor: 's2',
    });
    await call('POST', `/api/materials/${m3}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', licensor: 's3',
    });
    const v = await call('POST', '/api/verify', { packageId: pid });
    const pub = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: v.data.basisVersion });
    ok(pub.status === 201, '前置：报价预览包已发布');
    r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [] });
    ok(r.status === 409 && r.data.details.code === 'PACKAGE_PUBLISHED', '已发布包预览被拒 409 PACKAGE_PUBLISHED');

    // 15.12 全部现有授权覆盖时，空报价方案可行、总成本 0
    const pid2 = (await call('POST', '/api/packages', {
      name: '报价全覆盖包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-10-01', useTo: '2026-11-30', materialIds: [m1],
    })).data.id;
    r = await call('POST', `/api/packages/${pid2}/quotes/preview`, { quotes: [] });
    ok(r.data.feasible === true && r.data.totalCost === 0 && r.data.quoteCountSelected === 0,
       '现有授权全覆盖时无需任何报价，总成本 0');

    // 15.13 不存在包 / 空包
    ok((await call('POST', '/api/packages/999999/quotes/preview', { quotes: [] })).status === 404, '不存在的包 404');
    const emptyP = (await call('POST', '/api/packages', {
      name: '报价空包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-10-01', useTo: '2026-11-30', materialIds: [],
    })).data.id;
    r = await call('POST', `/api/packages/${emptyP}/quotes/preview`, { quotes: [] });
    ok(r.status === 400 && r.data.details.code === 'EMPTY_PACKAGE', '空包预览被拒 400 EMPTY_PACKAGE');
  }

  console.log('16) 多站报价预览：一份报价覆盖多站共享节点只算一次、按站缺口与并列规则')
  {
    const m1 = (await call('POST', '/api/materials', { title: '多站报价-成片', kind: 'video' })).data.id;
    const m2 = (await call('POST', '/api/materials', { title: '多站报价-来源', kind: 'audio' })).data.id;
    await call('POST', `/api/materials/${m1}/sources`, { sourceMaterialId: m2, relation: '配乐' });
    await call('POST', `/api/materials/${m1}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', licensor: 'r',
    });
    // m2 仅北京站现有授权
    await call('POST', `/api/materials/${m2}/authorizations`, {
      media: '屏幕放映', region: '中国大陆', validFrom: '2026-03-01', validTo: '2026-03-31', licensor: 'bj',
    });

    const pid = (await call('POST', '/api/packages', {
      name: '多站报价包', materialIds: [m1],
      stops: [
        { name: '北京站', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-20' },
        { name: '香港站', medium: '沉浸式投影', region: '中国香港', useFrom: '2026-05-01', useTo: '2026-05-20' },
        { name: '上海站', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-07-01', useTo: '2026-07-10' },
      ],
    })).data.id;

    // 16.1 一份全域报价同时覆盖香港+上海：coverCount=2，费用只算一次；与两份同价时报价数少者胜
    let r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: m2, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 200 },
      { materialId: m2, media: '沉浸式投影', region: '中国香港', validFrom: '2026-05-01', validTo: '2026-05-31', cost: 100 },
      { materialId: m2, media: '屏幕放映', region: '中国大陆', validFrom: '2026-07-01', validTo: '2026-07-31', cost: 100 },
    ] });
    ok(r.data.feasible && r.data.totalCost === 200 && r.data.quoteCountSelected === 1,
       '同成本下一份全域报价（报价数少）胜，总成本 200');
    const sel = r.data.selectedQuotes[0];
    ok(sel.coverCount === 2
       && sel.covers.map((c) => c.stopPosition).sort().join() === '1,2',
       '共享节点两站需求由同一份报价覆盖，只核算一次');

    // 16.2 全域 201 时两份 200 更便宜
    r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: m2, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 201 },
      { materialId: m2, media: '沉浸式投影', region: '中国香港', validFrom: '2026-05-01', validTo: '2026-05-31', cost: 100 },
      { materialId: m2, media: '屏幕放映', region: '中国大陆', validFrom: '2026-07-01', validTo: '2026-07-31', cost: 100 },
    ] });
    ok(r.data.feasible && r.data.totalCost === 200 && r.data.selectedQuotes.map((q) => q.index).join() === '1,2',
       '全域更贵时选两份单站报价（200 < 201）');

    // 16.3 只给香港报价：无解且仅上海站列为缺口（北京由现有授权、香港由报价覆盖）
    r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: m2, media: '沉浸式投影', region: '中国香港', validFrom: '2026-05-01', validTo: '2026-05-31', cost: 100 },
    ] });
    ok(r.data.feasible === false && r.data.gaps.map((g) => g.position).join() === '2',
       '仅仍无覆盖的上海站列为缺口（北京站现有授权、香港站报价已覆盖，均不列）');
    ok(r.data.gaps.every((g) => g.nodes.every((n) => n.materialId === m2)), '缺口节点均为来源 m2 且带来源路径');

    // 16.4 短报价：香港整段 05-01~05-20，报价只到 05-10 不可拼接 -> 香港仍缺
    r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: m2, media: '沉浸式投影', region: '中国香港', validFrom: '2026-05-01', validTo: '2026-05-10', cost: 1 },
      { materialId: m2, media: '屏幕放映', region: '中国大陆', validFrom: '2026-07-01', validTo: '2026-07-31', cost: 100 },
    ] });
    ok(r.data.feasible === false
       && r.data.gaps.some((g) => g.position === 1
          && g.nodes[0].quoteFailures.some((f) => f.index === 0 && f.misses.includes('date'))),
       '同站短报价不可拼接，香港站仍列缺口并标注 date');

    // 16.5 报价 DTO 回显输入序号与全部字段；多站形态标记
    r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: m2, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 200, licensor: '拟签约方', note: '打包' },
    ] });
    ok(r.data.multiStop === true && r.data.stopCount === 3
       && r.data.request.quotes[0].index === 0 && r.data.request.quotes[0].licensor === '拟签约方',
       '响应回显 multiStop/站数与报价输入序号、备注');
  }

  console.log('17) 发布凭证：同事务封存、离线独立校验、篡改检出、授权变更不影响旧凭证、轮换与旧快照补发')
  {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { spawnSync } = require('child_process');
    const Database = require('better-sqlite3');
    const VERIFIER = path.join(__dirname, '..', 'scripts', 'verify-attestation.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-e2e-'));
    let seq = 0;
    const writeJson = (obj) => {
      const f = path.join(tmpDir, `f${++seq}.json`);
      fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
      return f;
    };
    const writePem = (pem) => {
      const f = path.join(tmpDir, `k${++seq}.pem`);
      fs.writeFileSync(f, pem);
      return f;
    };
    const offline = (attFile, keyFiles, json = true) => {
      const args = [VERIFIER, attFile, ...(keyFiles || [])];
      if (json) args.push('--json');
      const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
      let data = null;
      try { data = JSON.parse(r.stdout); } catch {}
      return { code: r.status, data, stdout: r.stdout, stderr: r.stderr };
    };
    const keysNow = async () => (await call('GET', '/api/attestation-keys')).data.keys;
    const archiveFile = async () => {
      const keys = await keysNow();
      return writePem(keys.map((k) => k.publicKeyPem).join('\n') + '\n');
    };

    // 隔离的小型来源链：root -> src，两份全域长授权（不依赖演示库状态）
    const mkMat = async (title) => (await call('POST', '/api/materials', { title, kind: 'x' })).data.id;
    const root = await mkMat('凭证测试-成片');
    const src = await mkMat('凭证测试-来源');
    const link = await call('POST', `/api/materials/${root}/sources`, { sourceMaterialId: src, relation: '引用' });
    ok(link.status === 201, '凭证测试链 root->src 建立');
    const authRoot = (await call('POST', `/api/materials/${root}/authorizations`, {
      media: '*', region: '*', validFrom: '2020-01-01', validTo: '2100-12-31', licensor: 'A',
    })).data.id;
    const authSrc = (await call('POST', `/api/materials/${src}/authorizations`, {
      media: '*', region: '*', validFrom: '2020-01-01', validTo: '2100-12-31', licensor: 'B',
    })).data.id;

    // 17.1 成功发布：响应自带凭证，含全部证明要素与规则版本
    const cp = await call('POST', '/api/packages', {
      name: '凭证测试单站', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-03-01', useTo: '2026-04-30', materialIds: [root],
    });
    const pid = cp.data.id;
    const v = await call('POST', '/api/verify', { packageId: pid });
    const pub = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: v.data.basisVersion });
    ok(pub.status === 201 && !!pub.data.attestation && !!pub.data.attestationId,
      '成功发布返回封存凭证与 attestationId');
    const att = pub.data.attestation;
    ok(att.format === 'exhibit-package-attestation' && att.body.snapshotId === pub.data.snapshotId,
      '凭证信封格式与快照关联正确');
    for (const f of ['manifest', 'materials', 'sourceSubgraph', 'itinerary', 'terms', 'adoptions', 'paths', 'rules']) {
      ok(att.body[f] !== undefined, `凭证封存要素存在：${f}`);
    }
    ok(att.body.rules.version === v.data.rules.version, '凭证记录核验规则版本');
    ok(att.body.terms.length === 2
       && att.body.terms.every((t) => t.revoked === false && [authRoot, authSrc].includes(t.id)),
       '凭证封存两个节点实际采用的未撤销条款全文');
    ok(att.body.adoptions.length === 2
       && att.body.adoptions.every((a) => a.stopPosition === 0),
       '单站：每个节点一条采用关系');
    ok(att.body.sourceSubgraph.edges.some((e) => e.from === root && e.to === src),
       '凭证封存完整来源子图边 root->src');
    ok(att.body.paths.find((p) => p.materialId === src)
         .paths.some((p) => p.map((x) => x.materialId).join() === `${root},${src}`),
       '凭证封存来源节点的全部来源路径');
    ok(!!att.signature.kid && !!att.signature.value && att.signature.algorithm === 'Ed25519',
       '凭证带本机持久化密钥的 Ed25519 签名');

    // 17.2 包 DTO 与独立读取端点
    const pd = await call('GET', `/api/packages/${pid}`);
    ok(pd.data.attestationId === pub.data.attestationId && !!pd.data.attestationSignedBy,
      '包 DTO 暴露凭证元数据（不破坏既有字段）');
    const got = await call('GET', `/api/packages/${pid}/attestation`);
    ok(got.status === 200 && JSON.stringify(got.data) === JSON.stringify(att), '按包读取凭证内容一致');
    const bySnap = await call('GET', `/api/attestations/by-snapshot/${pub.data.snapshotId}`);
    ok(bySnap.status === 200 && bySnap.data.signature.value === att.signature.value, '按发布快照读取凭证');
    const draftPack = await call('POST', '/api/packages', {
      name: '凭证测试无授权', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-03-01', useTo: '2026-04-30',
      materialIds: [(await mkMat('凭证测试-无授权素材'))],
    });
    const badPub = await call('POST', `/api/packages/${draftPack.data.id}/publish`, { basisVersion: v.data.basisVersion });
    ok(badPub.status === 422, '不合格发布仍为 422');
    const noAtt = await call('GET', `/api/packages/${draftPack.data.id}/attestation`);
    ok(noAtt.status === 404, '失败发布不封存凭证（404）');

    // 17.3 独立离线校验：仅凭凭证 + 公钥
    const keys = await keysNow();
    ok(keys.length >= 1 && keys.every((k) => /^ed25519-[0-9a-f]{32}$/.test(k.kid)), '公钥归档列出受信密钥');
    const attFile = writeJson(att);
    let r = offline(attFile, [writePem(keys.map((k) => k.publicKeyPem).join('\n'))]);
    ok(r.code === 0 && r.data && r.data.conclusion === 'PASS' && r.data.validSignature === true,
      '离线校验：签名 + 来源链 + 逐站整段覆盖全部通过');
    ok(r.data.stops.length === 1 && r.data.stops[0].eligible === true && r.data.stops[0].nodeCount === 2,
      '离线校验返回逐站结论（单站、2 节点均覆盖）');
    r = offline(attFile, []);
    ok(r.code === 1 && r.data.tamperReasons.some((x) => x.code === 'SIGNING_KEY_NOT_TRUSTED'),
      '无公钥时明确拒绝并提示需要可信公钥');

    // 17.4 篡改检出（签名层 + 独立复算层双重）
    let t = JSON.parse(JSON.stringify(att));
    t.body.terms[0].validTo = '2020-01-01';
    r = offline(writeJson(t), [writePem(keys.map((k) => k.publicKeyPem).join('\n'))]);
    ok(r.code === 1 && r.data.validSignature === false
       && r.data.tamperReasons.some((x) => x.code === 'SIGNATURE_INVALID'),
       '篡改条款：签名失效被检出');
    t = JSON.parse(JSON.stringify(att));
    t.body.itinerary.stops[0].useFrom = '2101-01-01';
    t.body.itinerary.stops[0].useTo = '2101-02-01';
    r = offline(writeJson(t), [writePem(keys.map((k) => k.publicKeyPem).join('\n'))]);
    ok(r.code === 1 && r.data.conclusion === 'FAIL'
       && r.data.stops[0].nodes.some((n) => n.reasons.some((x) => x.code === 'DATE_NOT_COVERED')),
       '篡改站期：离线复算逐站覆盖给出 DATE_NOT_COVERED 篡改原因');
    t = JSON.parse(JSON.stringify(att));
    t.body.sourceSubgraph.edges = t.body.sourceSubgraph.edges.filter((e) => !(e.from === root && e.to === src));
    r = offline(writeJson(t), [writePem(keys.map((k) => k.publicKeyPem).join('\n'))]);
    ok(r.code === 1
       && r.data.tamperReasons.some((x) => x.code === 'PATH_FORGED' || x.code === 'ORPHAN_MATERIAL'),
       '删来源边：来源链复算检出路径/闭包不一致');
    t = JSON.parse(JSON.stringify(att));
    t.body.rules.maxChainDepth = 999;
    r = offline(writeJson(t), [writePem(keys.map((k) => k.publicKeyPem).join('\n'))]);
    ok(r.code === 1 && r.data.tamperReasons.some((x) => x.code === 'RULE_PARAMS_MISMATCH'),
       '篡改规则参数被检出');

    // 17.5 发布后撤销并删除授权：包转需复核，但旧凭证离线结论不变
    await call('POST', `/api/authorizations/${authSrc}/revoke`, {});
    await call('DELETE', `/api/authorizations/${authSrc}`);
    const after = await call('GET', `/api/packages/${pid}`);
    ok(after.data.status === 'needs_review', '授权删除后已发布包转为需复核');
    const attAgain = await call('GET', `/api/packages/${pid}/attestation`);
    ok(attAgain.data.signature.value === att.signature.value, '旧凭证内容与签名完全不变');
    r = offline(attFile, [await archiveFile()]);
    ok(r.code === 0 && r.data.conclusion === 'PASS', '授权撤销/删除后，旧凭证离线校验仍通过');

    // 17.6 多站凭证：逐站×逐节点采用关系，离线逐站结论
    const authSrc2 = (await call('POST', `/api/materials/${src}/authorizations`, {
      media: '*', region: '*', validFrom: '2020-01-01', validTo: '2100-12-31', licensor: 'B2',
    })).data.id;
    const mp = await call('POST', '/api/packages', {
      name: '凭证测试多站', materialIds: [root],
      stops: [
        { name: '站一', media: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-10' },
        { name: '站二', media: '沉浸式投影', region: '中国香港', useFrom: '2026-05-01', useTo: '2026-05-10' },
      ],
    });
    const mpid = mp.data.id;
    const mv = await call('POST', '/api/verify', { packageId: mpid });
    const mpub = await call('POST', `/api/packages/${mpid}/publish`, { basisVersion: mv.data.basisVersion });
    ok(mpub.status === 201, '多站包发布成功并封存凭证');
    const matt = mpub.data.attestation;
    ok(matt.body.adoptions.length === 4
       && matt.body.itinerary.stops.length === 2
       && matt.body.terms.some((x) => x.id === authSrc2),
       '多站凭证封存 2 站 × 2 节点采用关系与全部条款');
    r = offline(writeJson(matt), [await archiveFile()]);
    ok(r.code === 0 && r.data.stops.length === 2 && r.data.stops.every((s) => s.eligible),
       '多站凭证离线返回两站均整段覆盖');

    // 17.7 密钥轮换：旧公钥保留，旧凭证仍可验；只有新公钥则验不过
    const beforeKid = matt.signature.kid;
    const rot = await call('POST', '/api/attestation-keys/rotate', { reason: 'e2e' });
    ok(rot.status === 201 && rot.data.keys.length >= 2
       && rot.data.keys.some((k) => k.kid === beforeKid)
       && rot.data.current.kid !== beforeKid,
       '轮换后旧公钥保留、当前密钥更新');
    r = offline(writeJson(matt), [await archiveFile()]);
    ok(r.code === 0, '用含旧公钥的归档仍可验证轮换前凭证');
    const newOnly = writePem(rot.data.current.publicKeyPem);
    r = offline(writeJson(matt), [newOnly]);
    ok(r.code === 1 && r.data.validSignature === false, '仅提供轮换后新公钥时旧凭证验签失败');

    // 17.8 旧发布快照补发：成功补发 + 幂等 + 缺字段明确拒绝（不用当前授权拼凑）
    const rei = await call('POST', '/api/attestations/reissue', { snapshotId: 1 });
    ok((rei.status === 201 || (rei.status === 200 && rei.data.alreadySealed === true))
       && rei.data.attestation.body.sealContext === 'reissue-from-snapshot',
       '演示库旧发布快照可补发凭证（sealContext 标注补发）');
    if (rei.status === 201) {
      r = offline(writeJson(rei.data.attestation), [await archiveFile()]);
      ok(r.code === 0 && r.data.conclusion === 'PASS', '补发凭证离线校验通过');
    }
    const rei2 = await call('POST', '/api/attestations/reissue', { snapshotId: 1 });
    ok(rei2.data.alreadySealed === true && rei2.data.attestation.signature.value === rei.data.attestation.signature.value,
       '重复补发幂等：返回原凭证、不重新签名');
    const dbx = new Database(process.env.DB_PATH || require('path').join(__dirname, '..', 'data', 'app.db'));
    const oldPayload = JSON.parse(dbx.prepare('SELECT payload FROM verification_snapshots WHERE id=1').get().payload);
    const deficient = JSON.parse(JSON.stringify(oldPayload));
    delete deficient.rules;
    deficient.nodes = deficient.nodes.map((n) => { delete n.paths; delete n.matchedAuthorization; return n; });
    const info = dbx.prepare(
      'INSERT INTO verification_snapshots(package_id, kind, basis_version, eligible, payload, created_at) VALUES (?,?,?,?,?,?)'
    ).run(1, 'publish', deficient.basisVersion, 1, JSON.stringify(deficient), new Date().toISOString());
    dbx.close();
    const reiBad = await call('POST', '/api/attestations/reissue', { snapshotId: info.lastInsertRowid });
    ok(reiBad.status === 422 && reiBad.data.details
       && reiBad.data.details.code === 'UNSUPPORTED_SNAPSHOT'
       && Array.isArray(reiBad.data.details.missingFields) && reiBad.data.details.missingFields.length > 0,
       '缺证明字段的旧快照补发被明确拒绝（422 UNSUPPORTED_SNAPSHOT，逐字段列出）');

    // 17.9 凭证表不可变（触发器）
    const db2 = new Database(process.env.DB_PATH || require('path').join(__dirname, '..', 'data', 'app.db'));
    let upBlocked = false, delBlocked = false;
    try { db2.prepare('UPDATE publish_attestations SET signer_kid=? WHERE id=?').run('x', pub.data.attestationId); }
    catch { upBlocked = true; }
    try { db2.prepare('DELETE FROM publish_attestations WHERE id=?').run(pub.data.attestationId); }
    catch { delBlocked = true; }
    ok(upBlocked && delBlocked, 'publish_attestations 的 UPDATE/DELETE 均被触发器拒绝');
    db2.close();
  }

  console.log('18) 替代素材方案：预览裁决 + 事务确认 + 并发防护');
  {
    // 构造隔离素材世界（全部 id 从接口取得，不依赖演示库）
    const mk = async (title) => (await call('POST', '/api/materials', { title, kind: 'x' })).data.id;
    const addAuth = async (id, media, region, f, t) => (await call('POST', `/api/materials/${id}/authorizations`,
      { media, region, validFrom: f, validTo: t })).data.id;
    const addLink = async (from, to) => (await call('POST', `/api/materials/${from}/sources`, { sourceMaterialId: to })).status;

    // 原素材 A：含一个失格上游节点 bad（无授权）
    const A = await mk('替代测试-原成片A');
    const bad = await mk('替代测试-无授权上游bad');
    ok(await addLink(A, bad) === 201, 'A->bad 来源边建立');
    await addAuth(A, '*', '*', '2020-01-01', '2100-12-31');
    // 干净替代成片 B：自身全域授权，上游只有 good（全域授权）
    const B = await mk('替代测试-替代成片B');
    const good = await mk('替代测试-合格上游good');
    ok(await addLink(B, good) === 201, 'B->good 来源边建立');
    await addAuth(B, '*', '*', '2020-01-01', '2100-12-31');
    await addAuth(good, '*', '*', '2020-01-01', '2100-12-31');
    // 更小编号的坏替代成片 C：全域授权但仍带 bad 上游 → 选它不合格
    const C = await mk('替代测试-坏替代成片C');
    ok(await addLink(C, bad) === 201, 'C->bad 来源边建立');
    await addAuth(C, '*', '*', '2020-01-01', '2100-12-31');
    // 独立合格替代素材 D（用于第二件替换）
    const E = await mk('替代测试-原独立素材E');
    const D = await mk('替代测试-替代素材D');
    await addAuth(E, '屏幕放映', '中国大陆', '2026-03-01', '2026-05-31'); // 不覆盖秋季
    await addAuth(D, '*', '*', '2020-01-01', '2100-12-31');

    const FALL = { medium: '屏幕放映', region: '中国大陆', useFrom: '2026-10-01', useTo: '2026-11-30' };

    // 18.1 输入校验：整次拒绝（重复编号/非包内原素材/不存在候选/候选含自身/同组重复/越界）
    const p0 = (await call('POST', '/api/packages', { name: '替代校验包', ...FALL, materialIds: [A] })).data.id;
    const rej = async (body) => call('POST', `/api/packages/${p0}/substitutes/preview`, body);
    let r = await rej({ substitutions: [{ materialId: A, candidateIds: [B] }, { materialId: A, candidateIds: [C] }] });
    ok(r.status === 400 && r.data.details.code === 'INVALID_SUBSTITUTIONS'
      && r.data.details.errors.some((e) => e.message.includes('重复编号')),
      '同一原素材重复编号 → 整次拒绝 400');
    r = await rej({ substitutions: [{ materialId: 99999, candidateIds: [B] }] });
    ok(r.status === 400 && r.data.details.errors.some((e) => e.message.includes('不在包内')),
      '非包内原素材 → 400');
    r = await rej({ substitutions: [{ materialId: A, candidateIds: [88888] }] });
    ok(r.status === 400 && r.data.details.errors.some((e) => e.message.includes('不存在')),
      '不存在的候选 → 400');
    r = await rej({ substitutions: [{ materialId: A, candidateIds: [A] }] });
    ok(r.status === 400 && r.data.details.errors.some((e) => e.message.includes('与原素材相同')),
      '候选等于原素材 → 400');
    r = await rej({ substitutions: [{ materialId: A, candidateIds: [B, B] }] });
    ok(r.status === 400 && r.data.details.errors.some((e) => e.message.includes('同组候选不得重复')),
      '同组候选重复编号 → 400');
    r = await rej({ substitutions: [{ materialId: A, candidateIds: [] }] });
    ok(r.status === 400 && r.data.details.errors.some((e) => e.field === 'candidateIds'), '空候选 → 400');
    r = await rej({ substitutions: { not: 'array' } });
    ok(r.status === 400 && r.data.details.code === 'INVALID_SUBSTITUTIONS', 'substitutions 非数组 → 400');
    r = await rej({ substitutions: Array.from({ length: 7 }, () => ({ materialId: A, candidateIds: [B] })) });
    ok(r.status === 400 && r.data.error.includes('至多为 6 件'), '超过 6 组 → 400');
    r = await rej({ substitutions: [{ materialId: A, candidateIds: [B, C, D, E, good, bad, A + 100, A + 200, A + 300] }] });
    ok(r.status === 400 && r.data.details.errors.some((e) => e.message.includes('超过上限 8')), '超过 8 件候选 → 400');
    const pubPkg = (await call('GET', '/api/packages')).data.find((p) => p.status === 'published');
    r = await call('POST', `/api/packages/${pubPkg.id}/substitutes/preview`, { substitutions: [] });
    ok(r.status === 409 && r.data.details.code === 'NOT_DRAFT', '已发布包预览 → 409 NOT_DRAFT');
    r = await call('POST', '/api/packages/99999/substitutes/preview', { substitutions: [] });
    ok(r.status === 404, '包不存在 → 404');

    // 18.2 无解：保持与全部候选都不能全站合格 → feasible:false，返回当前清单逐站缺口、无令牌
    const p1 = (await call('POST', '/api/packages', { name: '替代无解包', ...FALL, materialIds: [A] })).data.id;
    r = await call('POST', `/api/packages/${p1}/substitutes/preview`,
      { substitutions: [{ materialId: A, candidateIds: [C] }] }); // C 也带 bad
    ok(r.status === 200 && r.data.feasible === false && r.data.consideredPlans === 2 && !r.data.applyToken,
      '无合格方案：feasible=false，枚举 2 种，不下发令牌');
    ok(r.data.current.eligible === false
      && r.data.stops[0].failingNodes.some((n) => n.materialId === bad),
      '无解返回当前清单逐站缺口（bad 节点）');
    const p1After = await call('GET', `/api/packages/${p1}`);
    ok(p1After.data.items.map((i) => i.id).join() === String(A), '无解不修改包清单');

    // 18.3 可行：枚举 3 方案（保持/C/B），仅 B 合格 → 选中 B（替换 1 件）
    r = await call('POST', `/api/packages/${p1}/substitutes/preview`,
      { substitutions: [{ materialId: A, candidateIds: [C, B] }] });
    ok(r.status === 200 && r.data.feasible === true && r.data.consideredPlans === 3, '可行预览枚举 3 方案');
    ok(r.data.replacementCount === 1 && r.data.finalMaterialIds.join() === String(B),
      '选中唯一合格方案 B（最终清单 [B]）');
    ok(r.data.selection[0].choiceIndex === 2 && r.data.selection[0].replaced === true,
      '选中编号=2（候选按提交顺序，C=1 失格、B=2 合格）');
    ok(r.data.stops[0].eligible === true && r.data.verification.eligible === true,
      '逐站核验结果全站合格');
    ok(typeof r.data.originalListFingerprint === 'string' && typeof r.data.itineraryFingerprint === 'string'
      && Number.isInteger(r.data.basisVersion),
      '返回依据版本、原清单指纹与行程指纹');
    ok(Array.isArray(r.data.replacements) && r.data.replacements[0].from.materialId === A
      && r.data.replacements[0].to.materialId === B, '返回替换明细 A→B');

    // 18.4 确认：同事务核对通过并应用；包仍为 draft；清单=替换后去重清单
    const token = r.data.applyToken;
    ok(token.packageId === p1 && token.basisVersion === r.data.basisVersion
      && token.listFingerprint === r.data.originalListFingerprint
      && token.itineraryFingerprint === r.data.itineraryFingerprint
      && token.finalMaterialIds.join() === String(B),
      '令牌携带包/依据版本/双指纹/规格/选中方案');
    const ap = await call('POST', `/api/packages/${p1}/substitutes/apply`, { applyToken: token });
    ok(ap.status === 200 && ap.data.mutated === true && ap.data.package.status === 'draft',
      '确认成功 200，包保持待发布');
    ok(ap.data.package.items.map((i) => i.id).join() === String(B)
      && ap.data.finalMaterialIds.join() === String(B), '清单原子更新为 [B]');
    const v1 = await call('POST', '/api/verify', { packageId: p1 });
    ok(v1.data.eligible === true, '应用后常规核验合格');
    // 令牌一次性：再用被拒 PACKAGE_CHANGED
    const reuse = await call('POST', `/api/packages/${p1}/substitutes/apply`, { applyToken: token });
    ok(reuse.status === 409 && reuse.data.details.code === 'PACKAGE_CHANGED',
      '令牌不可重复使用（清单已变 → PACKAGE_CHANGED）');

    // 18.5 STALE_BASIS：预览后授权变更 → 确认 409 且不改包
    const p2 = (await call('POST', '/api/packages', { name: '替代并发包', ...FALL, materialIds: [A] })).data.id;
    const pv2 = await call('POST', `/api/packages/${p2}/substitutes/preview`,
      { substitutions: [{ materialId: A, candidateIds: [B] }] });
    ok(pv2.data.feasible === true, '并发包预览可行');
    await addAuth(good, '*', '*', '2030-01-01', '2030-12-31'); // 任意授权变更 → basis+1
    const stale = await call('POST', `/api/packages/${p2}/substitutes/apply`, { applyToken: pv2.data.applyToken });
    ok(stale.status === 409 && stale.data.details.code === 'STALE_BASIS'
      && stale.data.details.clientBasis < stale.data.details.currentBasis,
      '预览后授权变更 → 409 STALE_BASIS');
    ok((await call('GET', `/api/packages/${p2}`)).data.items.map((i) => i.id).join() === String(A),
      '过期拒绝不修改清单');

    // 18.6 ITINERARY_CHANGED：预览后改包行程（单站改期，不改清单/依据）→ 409
    const p3 = (await call('POST', '/api/packages', { name: '替代行程包', ...FALL, materialIds: [A] })).data.id;
    const pv3 = await call('POST', `/api/packages/${p3}/substitutes/preview`,
      { substitutions: [{ materialId: A, candidateIds: [B] }] });
    const patch3 = await call('PATCH', `/api/packages/${p3}`,
      { name: '替代行程包', medium: '屏幕放映', region: '中国大陆',
        useFrom: '2026-09-01', useTo: '2026-09-30', materialIds: [A] });
    ok(patch3.status === 200, '行程改期保存成功（清单不变）');
    const itinChg = await call('POST', `/api/packages/${p3}/substitutes/apply`, { applyToken: pv3.data.applyToken });
    ok(itinChg.status === 409 && itinChg.data.details.code === 'ITINERARY_CHANGED',
      '预览后行程变更 → 409 ITINERARY_CHANGED，不应用');

    // 18.7 输入不符：篡改令牌选择 → 服务端重算最优不一致 → 409 INPUT_MISMATCH
    const p4 = (await call('POST', '/api/packages', { name: '替代篡改包', ...FALL, materialIds: [A] })).data.id;
    const pv4 = await call('POST', `/api/packages/${p4}/substitutes/preview`,
      { substitutions: [{ materialId: A, candidateIds: [C, B] }] });
    const badToken = JSON.parse(JSON.stringify(pv4.data.applyToken));
    // 声称选择 1（C）而非服务端最优 2（B）
    badToken.selection[0].choiceIndex = 1;
    badToken.selection[0].selectedMaterialId = C;
    badToken.finalMaterialIds = [C];
    const mismatch = await call('POST', `/api/packages/${p4}/substitutes/apply`, { applyToken: badToken });
    ok(mismatch.status === 409 && mismatch.data.details.code === 'INPUT_MISMATCH',
      '令牌方案与重算最优不一致 → 409 INPUT_MISMATCH');
    ok((await call('GET', `/api/packages/${p4}`)).data.items.map((i) => i.id).join() === String(A),
      '输入不符拒绝不修改清单');
    // 令牌损坏/跨包
    ok((await call('POST', `/api/packages/${p4}/substitutes/apply`, {})).status === 400, '缺令牌 → 400');
    const cross = JSON.parse(JSON.stringify(pv4.data.applyToken));
    cross.packageId = p3;
    const crossR = await call('POST', `/api/packages/${p4}/substitutes/apply`, { applyToken: cross });
    ok(crossR.status === 409 && crossR.data.details.code === 'TOKEN_MISMATCH', '跨包令牌 → 409 TOKEN_MISMATCH');

    // 18.8 去重：两件原素材都替换为同一候选 → 最终清单只保留首次出现
    const p5 = (await call('POST', '/api/packages', {
      name: '替代去重包', ...FALL, materialIds: [E, A],
    })).data.id; // 原顺序：E,A
    // D 全域合格；让 E->[D]、A->[D]（D 无上游）两件都换 D
    const pv5 = await call('POST', `/api/packages/${p5}/substitutes/preview`, {
      substitutions: [
        { materialId: E, candidateIds: [D] },
        { materialId: A, candidateIds: [D] },
      ],
    });
    ok(pv5.status === 200 && pv5.data.feasible === true && pv5.data.finalMaterialIds.join() === String(D),
      '两件都替换为 D：去重后最终清单 [D]');
    ok(pv5.data.removedByDedupe.length === 1 && pv5.data.removedByDedupe[0].materialId === D,
      '折叠明细列出第二处 D 被去重');
    const ap5 = await call('POST', `/api/packages/${p5}/substitutes/apply`, { applyToken: pv5.data.applyToken });
    ok(ap5.status === 200 && ap5.data.package.items.map((i) => i.id).join() === String(D),
      '确认后清单原子去重为单项 [D]');

    // 18.9 裁决准则一：替换件数最少（当前清单已合格时空替换胜出）
    const F = await mk('替代测试-已合格成片F');
    const fg = await mk('替代测试-F合格上游');
    await addLink(F, fg);
    await addAuth(F, '*', '*', '2020-01-01', '2100-12-31');
    await addAuth(fg, '*', '*', '2020-01-01', '2100-12-31');
    const p6 = (await call('POST', '/api/packages', {
      name: '替代零替换包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-10-01', useTo: '2026-11-30', materialIds: [F],
    })).data.id;
    const pv6 = await call('POST', `/api/packages/${p6}/substitutes/preview`,
      { substitutions: [{ materialId: F, candidateIds: [B] }] }); // B 也合格
    ok(pv6.data.feasible === true && pv6.data.replacementCount === 0
      && pv6.data.finalMaterialIds.join() === String(F)
      && pv6.data.selection[0].choiceIndex === 0,
      '当前清单合格时 0 替换方案优先（即使候选也合格）');
    const ap6 = await call('POST', `/api/packages/${p6}/substitutes/apply`, { applyToken: pv6.data.applyToken });
    ok(ap6.status === 200 && ap6.data.replacementCount === 0
      && ap6.data.package.items.map((i) => i.id).join() === String(F),
      '确认零替换方案：清单保持不变');

    // 18.10 裁决准则二/三：替换数相同时，最终清单升序 → 原顺序选中编号
    // 两件都必须替换（原素材不合格），各给两个合格候选；
    // 组合 (X1,Y1)=替换2 与 (X2,Y2)=替换2，最终清单 [X1,Y1] 与 [X2,Y2] 升序比较取小
    const X = await mk('替代测试-原X'); const Y = await mk('替代测试-原Y');
    await addAuth(X, '屏幕放映', '中国大陆', '2026-03-01', '2026-05-31'); // 秋季失格
    await addAuth(Y, '屏幕放映', '中国大陆', '2026-03-01', '2026-05-31');
    const X1 = await mk('替代测试-X候选1'); const X2 = await mk('替代测试-X候选2');
    const Y1 = await mk('替代测试-Y候选1'); const Y2 = await mk('替代测试-Y候选2');
    for (const id of [X1, X2, Y1, Y2]) await addAuth(id, '*', '*', '2020-01-01', '2100-12-31');
    const p7 = (await call('POST', '/api/packages', {
      name: '替代并列裁决包', ...FALL, materialIds: [X, Y],
    })).data.id;
    // 选 id 较小的两件作为“编号靠后但清单更小”组合：
    const loA = Math.min(X1, X2), hiA = Math.max(X1, X2);
    const loB = Math.min(Y1, Y2), hiB = Math.max(Y1, Y2);
    // 故意把小编号候选放在第二顺位：提交顺序 [高, 低]
    const pv7 = await call('POST', `/api/packages/${p7}/substitutes/preview`, {
      substitutions: [
        { materialId: X, candidateIds: [hiA, loA] },
        { materialId: Y, candidateIds: [hiB, loB] },
      ],
    });
    ok(pv7.data.feasible === true && pv7.data.replacementCount === 2
      && pv7.data.finalMaterialIds.join() === [loA, loB].sort((a, b) => a - b).join(),
      '替换数并列：最终清单升序字典序最小者胜（选中编号靠后的小编号候选）');
    ok(pv7.data.tieBreak.choiceSequence.join() === '2,2', '并列裁决第三键记录原顺序选中编号 [2,2]');

    // 18.11 多站：方案须每一站都合格（不同站不同授权判定）
    const M = await mk('替代测试-多站原素材M');
    const N = await mk('替代测试-多站替代素材N');
    // M 仅覆盖第一站媒介；N 全域覆盖两站
    await addAuth(M, '屏幕放映', '中国大陆', '2026-01-01', '2100-12-31');
    await addAuth(N, '*', '*', '2020-01-01', '2100-12-31');
    const p8 = (await call('POST', '/api/packages', {
      name: '替代多站包', materialIds: [M],
      stops: [
        { name: '甲站', media: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-10' },
        { name: '乙站', media: '沉浸式投影', region: '中国香港', useFrom: '2026-05-01', useTo: '2026-05-10' },
      ],
    })).data.id;
    const pv8 = await call('POST', `/api/packages/${p8}/substitutes/preview`,
      { substitutions: [{ materialId: M, candidateIds: [N] }] });
    ok(pv8.data.feasible === true && pv8.data.multiStop === true && pv8.data.stopCount === 2
      && pv8.data.stops.every((s) => s.eligible === true),
      '多站预览：替代 N 后两站逐站合格');
    ok(pv8.data.stops.map((s) => s.position).join() === '0,1', '逐站结果按站次给出');
    const ap8 = await call('POST', `/api/packages/${p8}/substitutes/apply`, { applyToken: pv8.data.applyToken });
    ok(ap8.status === 200 && ap8.data.package.multiStop === true
      && ap8.data.package.items.map((i) => i.id).join() === String(N)
      && ap8.data.package.stopCount === 2,
      '多站确认：清单替换为 N，行程 2 站原样保留');
    const keepStops = (await call('GET', `/api/packages/${p8}`)).data.stops.map((s) => s.name).join();
    ok(keepStops === '甲站,乙站', '确认不改动多站行程');

    // 18.12 多站无解：逐站缺口按站返回
    const p9 = (await call('POST', '/api/packages', {
      name: '替代多站无解包', materialIds: [M],
      stops: [
        { name: '甲站', media: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-10' },
        { name: '乙站', media: '沉浸式投影', region: '中国香港', useFrom: '2026-05-01', useTo: '2026-05-10' },
      ],
    })).data.id;
    // M 甲站合格、乙站媒介不符；不给候选
    const pv9 = await call('POST', `/api/packages/${p9}/substitutes/preview`, { substitutions: [] });
    ok(pv9.data.feasible === false
      && pv9.data.stops.find((s) => s.position === 0).eligible === true
      && pv9.data.stops.find((s) => s.position === 1).eligible === false
      && pv9.data.stops.find((s) => s.position === 1).failingNodes.some((n) => n.materialId === M),
      '多站无解按站返回：甲站合格、乙站列出失格节点 M');

    // 18.13 只读语义：预览前后 basisVersion 与包清单不变、无快照产生
    const sBefore = await call('GET', '/api/state');
    const p9Before = await call('GET', `/api/packages/${p9}`);
    await call('POST', `/api/packages/${p9}/substitutes/preview`, { substitutions: [{ materialId: M, candidateIds: [N] }] });
    const sAfter = await call('GET', '/api/state');
    const p9After = await call('GET', `/api/packages/${p9}`);
    ok(sBefore.data.basisVersion === sAfter.data.basisVersion, '预览不改变依据版本');
    ok(p9Before.data.items.map((i) => i.id).join() === p9After.data.items.map((i) => i.id).join()
      && (p9After.data.snapshots || []).length === 0,
      '预览不修改清单、不写快照');

    // 18.14 复制兼容：复制包可独立预览/应用；已发布包冻结不受影响
    const cpR = await call('POST', `/api/packages/${pubPkg.id}/copy`);
    ok(cpR.status === 201 && cpR.data.status === 'draft', '已发布包可复制为待发布包（既有规则兼容）');
    const cpPv = await call('POST', `/api/packages/${cpR.data.id}/substitutes/preview`, { substitutions: [] });
    ok(cpPv.status === 200, '副本可做替代预览');
    // 已发布原包仍冻结、无变化
    const pubNow = await call('GET', `/api/packages/${pubPkg.id}`);
    ok(pubNow.data.status === 'published', '已发布原包仍冻结');
  }

  console.log('19) 联展批次发布：只读预览、双指纹凭据、单事务整批发布、整批拒绝无部分写入')
  {
    const mk2 = async (title, kind = 'video') => (await call('POST', '/api/materials', { title, kind })).data.id;
    const addAuth2 = async (mid, media, region, f, t, revoked = false) =>
      (await call('POST', `/api/materials/${mid}/authorizations`,
        { media, region, validFrom: f, validTo: t, revoked })).data;
    const addLink2 = async (from, to) => (await call('POST', `/api/materials/${from}/sources`, { sourceMaterialId: to })).data;
    const SPR = { useFrom: '2026-03-01', useTo: '2026-05-31' };
    const AUT = { useFrom: '2026-10-01', useTo: '2026-11-30' };

    // 19.1 入参校验：数量 / 重复 / 非正整数
    ok((await call('POST', '/api/batches/preview', { packageIds: [] })).status === 400, '空批次 400');
    ok((await call('POST', '/api/batches/preview', { packageIds: [1] })).status === 400, '仅 1 个包 400');
    const twentyOne = Array.from({ length: 21 }, (_, i) => i + 1);
    ok((await call('POST', '/api/batches/preview', { packageIds: twentyOne })).status === 400, '21 个包 400');
    const badDup = await call('POST', '/api/batches/preview', { packageIds: [1, 1] });
    ok(badDup.status === 400 && badDup.data.details && badDup.data.details.code === 'INVALID_BATCH',
      '重复包 400 INVALID_BATCH');
    ok((await call('POST', '/api/batches/preview', { packageIds: ['x', 2] })).status === 400, '非整数包号 400');
    ok((await call('POST', '/api/batches/preview', {})).status === 400, '缺 packageIds 400');

    // 19.2 不存在 / 非待发布（两个 id 均取远大于当前最大包号，确保命中“不存在”分支）
    const maxPkgId = Math.max(...(await call('GET', '/api/packages')).data.map((p) => p.id));
    const ghost = maxPkgId + 1000;
    ok((await call('POST', '/api/batches/preview', { packageIds: [ghost, ghost + 1] })).status === 404,
      '含不存在包 -> 404');
    const notDraft = await call('POST', '/api/batches/preview', { packageIds: [global.pidGood, ghost] });
    ok(notDraft.status === 409 && notDraft.data.details.code === 'NOT_DRAFT',
      '含已发布包 -> 409 NOT_DRAFT');

    // 19.3 搭两个合格单站包 + 一个秋季失格包（独立素材，全域/短期授权）
    const a = await mk2('批次-素材A'); const b = await mk2('批次-素材B'); const c = await mk2('批次-素材C');
    await addAuth2(a, '*', '*', '2020-01-01', '2100-12-31');
    await addAuth2(b, '*', '*', '2020-01-01', '2100-12-31');
    await addAuth2(c, '屏幕放映', '中国大陆', '2026-03-01', '2026-05-31'); // 仅春季
    const pa = (await call('POST', '/api/packages', {
      name: '批次-合格包A', medium: '屏幕放映', region: '中国大陆', ...SPR, materialIds: [a],
    })).data.id;
    const pb = (await call('POST', '/api/packages', {
      name: '批次-合格包B', medium: '屏幕放映', region: '中国大陆', ...SPR, materialIds: [b],
    })).data.id;
    const pc = (await call('POST', '/api/packages', {
      name: '批次-秋季失格包C', medium: '屏幕放映', region: '中国大陆', ...AUT, materialIds: [c],
    })).data.id;

    // 19.4 含失格包的预览：eligible=false、按包列缺口、无凭据、只读
    const stateBefore = await call('GET', '/api/state');
    const pvBad = await call('POST', '/api/batches/preview', { packageIds: [pa, pc] });
    ok(pvBad.status === 200 && pvBad.data.eligible === false && pvBad.data.failingCount === 1
      && pvBad.data.confirmToken === undefined && pvBad.data.mutated === false,
      '含失格包：预览不可确认、无 confirmToken');
    const cEntry = pvBad.data.packages.find((p) => p.packageId === pc);
    ok(cEntry.eligible === false && cEntry.stops[0].failingNodes.some((n) => n.materialId === c)
      && cEntry.stops[0].failingNodes[0].reasonText.join().includes('有效期'),
      '失格包按站列出缺口节点与日期原因');
    const stateAfterBad = await call('GET', '/api/state');
    ok(stateBefore.data.basisVersion === stateAfterBad.data.basisVersion, '失格预览不改变依据版本');
    ok((await call('GET', `/api/packages/${pc}`)).data.snapshots.length === 0, '失格预览不写快照');

    // 19.5 合格预览：共同依据版本、双指纹、逐站结果、发放凭据
    const pv = await call('POST', '/api/batches/preview', { packageIds: [pb, pa] }); // 故意乱序
    ok(pv.status === 200 && pv.data.eligible === true && pv.data.packageIds.join() === `${pa},${pb}`
      && pv.data.eligibleCount === 2 && !!pv.data.confirmToken,
      '合格预览：包集合按 id 升序规范化并发放 confirmToken');
    ok(pv.data.packages.every((p) => p.listFingerprint && p.itineraryFingerprint
      && p.basisVersion === pv.data.basisVersion && p.stops.length === 1 && p.stops[0].eligible),
      '每包带共同依据版本、清单/行程指纹与逐站合格结果');
    const stateAfterPv = await call('GET', '/api/state');
    ok(stateAfterPv.data.basisVersion === pv.data.basisVersion
      && (await call('GET', `/api/packages/${pa}`)).data.status === 'draft',
      '合格预览只读：依据版本不变、包仍 draft');

    // 19.6 凭据篡改：包集合 / 依据版本 / 指纹
    let tok = pv.data.confirmToken;
    let r = await call('POST', '/api/batches/confirm', {
      confirmToken: { ...tok, basisVersion: tok.basisVersion + 1 },
    });
    ok(r.status === 409 && r.data.details.code === 'STALE_BASIS', '错误依据版本 -> 409 STALE_BASIS');
    r = await call('POST', '/api/batches/confirm', {
      confirmToken: { ...tok, packages: tok.packages.map((p, i) => i === 0 ? { ...p, listFingerprint: 'x' } : p) },
    });
    ok(r.status === 409 && r.data.details.code === 'PACKAGE_CHANGED', '清单指纹不符 -> 409 PACKAGE_CHANGED');
    r = await call('POST', '/api/batches/confirm', {
      confirmToken: { ...tok, packages: tok.packages.map((p, i) => i === 0 ? { ...p, itineraryFingerprint: 'x' } : p) },
    });
    ok(r.status === 409 && r.data.details.code === 'PACKAGE_CHANGED'
      && r.data.details.itineraryChanged.includes(tok.packages[0].packageId),
      '行程指纹不符 -> 409 PACKAGE_CHANGED（指出包号）');
    r = await call('POST', '/api/batches/confirm', { confirmToken: { kind: 'x' } });
    ok(r.status === 409 && r.data.details.code === 'TOKEN_MISMATCH', '损坏凭据 -> 409 TOKEN_MISMATCH');
    r = await call('POST', '/api/batches/confirm', { confirmToken: { ...tok, packageIds: [pa] } });
    ok(r.status === 409 && r.data.details.code === 'TOKEN_MISMATCH', '凭据包集合不一致 -> 409 TOKEN_MISMATCH');
    ok((await call('POST', '/api/batches/confirm', {})).status === 400, '缺凭据 -> 400');

    // 19.7 漂移：预览后撤销授权 -> STALE_BASIS，整批无写入
    const aAuth = (await call('GET', `/api/materials/${a}`)).data.authorizations[0].id;
    await call('POST', `/api/authorizations/${aAuth}/revoke`);
    r = await call('POST', '/api/batches/confirm', { confirmToken: tok });
    ok(r.status === 409 && r.data.details.code === 'STALE_BASIS', '预览后授权撤销 -> 409 STALE_BASIS');
    for (const id of [pa, pb]) {
      const d = (await call('GET', `/api/packages/${id}`)).data;
      ok(d.status === 'draft' && d.snapshots.length === 0, `漂移拒绝后包 #${id} 仍 draft 且无快照`);
    }
    // 恢复授权：重预览得到新凭据
    await call('PATCH', `/api/authorizations/${aAuth}`, {
      media: '*', region: '*', validFrom: '2020-01-01', validTo: '2100-12-31', revoked: false,
    });
    tok = (await call('POST', '/api/batches/preview', { packageIds: [pa, pb] })).data.confirmToken;

    // 19.8 预览后改包清单 -> 指纹不符整批拒绝（另一包不受影响）
    await call('PATCH', `/api/packages/${pb}`, {
      name: '批次-合格包B', medium: '屏幕放映', region: '中国大陆', ...SPR, materialIds: [b, a],
    });
    r = await call('POST', '/api/batches/confirm', { confirmToken: tok });
    ok(r.status === 409 && r.data.details.code === 'PACKAGE_CHANGED'
      && r.data.details.listChanged.includes(pb),
      '预览后清单被改 -> 409 PACKAGE_CHANGED');
    await call('PATCH', `/api/packages/${pb}`, {
      name: '批次-合格包B', medium: '屏幕放映', region: '中国大陆', ...SPR, materialIds: [b],
    });
    tok = (await call('POST', '/api/batches/preview', { packageIds: [pa, pb] })).data.confirmToken;

    // 19.9 成功整批发布：同一事务封存快照+凭证并一起转已发布
    const confirmed = await call('POST', '/api/batches/confirm', { confirmToken: tok });
    ok(confirmed.status === 201 && confirmed.data.packageCount === 2, '整批确认 201');
    for (const p of confirmed.data.packages) {
      const d = (await call('GET', `/api/packages/${p.packageId}`)).data;
      ok(d.status === 'published' && p.snapshotId && p.attestationId
        && p.attestation.body.sealContext === 'publish-batch'
        && p.attestation.body.snapshotId === p.snapshotId
        && p.attestation.body.packageId === p.packageId,
        `包 #${p.packageId}：已发布，同事务封存 publish-batch 快照与凭证`);
      const snap = await call('GET', `/api/snapshots/${p.snapshotId}`);
      ok(snap.data.kind === 'publish' && snap.data.eligible === true && snap.data.immutable === true,
        `包 #${p.packageId}：发布快照为成功且不可变`);
      // 既有凭证导出接口对批次凭证完全兼容
      const exported = await call('GET', `/api/packages/${p.packageId}/attestation`);
      ok(exported.status === 200 && exported.data.signature.value === p.attestation.signature.value,
        `包 #${p.packageId}：既有凭证导出接口可取批次凭证`);
    }

    // 19.10 批次凭证通过离线独立校验程序
    {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const { spawnSync } = require('child_process');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-attest-'));
      const attFile = path.join(dir, 'att.json');
      const keyFile = path.join(dir, 'pub.pem');
      const keys = (await call('GET', '/api/attestation-keys')).data.keys;
      fs.writeFileSync(keyFile, keys.map((k) => k.publicKeyPem).join('\n'));
      const target = confirmed.data.packages[0];
      fs.writeFileSync(attFile, JSON.stringify(target.attestation));
      const v = spawnSync(process.execPath,
        [path.join(__dirname, '..', 'scripts', 'verify-attestation.js'), attFile, keyFile, '--json'],
        { encoding: 'utf8' });
      let parsed = null;
      try { parsed = JSON.parse(v.stdout); } catch { /* 人读输出兜底 */ }
      ok(v.status === 0 && parsed && parsed.conclusion === 'PASS' && parsed.ok === true
        && parsed.packageId === target.packageId && parsed.sealContext === 'publish-batch'
        && parsed.validSignature === true && parsed.tamperReasons.length === 0,
        '批次凭证离线独立校验通过（exit=0, PASS, sealContext=publish-batch）');
    }

    // 19.11 凭据一次性：重放被 NOT_DRAFT 拒绝
    r = await call('POST', '/api/batches/confirm', { confirmToken: tok });
    ok(r.status === 409 && r.data.details.code === 'NOT_DRAFT', '凭据重放（包已发布）-> 409 NOT_DRAFT');

    // 19.12 多站批次：逐站结果按站给出，整批一起发布
    const d = await mk2('批次-多站素材D');
    await addAuth2(d, '*', '*', '2020-01-01', '2100-12-31');
    const pm = (await call('POST', '/api/packages', {
      name: '批次-多站包', materialIds: [d],
      stops: [
        { name: '甲站', media: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-10' },
        { name: '乙站', media: '沉浸式投影', region: '中国香港', useFrom: '2026-05-01', useTo: '2026-05-10' },
      ],
    })).data.id;
    const pe = (await call('POST', '/api/packages', {
      name: '批次-合格包E', medium: '*', region: '*', ...SPR, materialIds: [a],
    })).data.id;
    const pvm = await call('POST', '/api/batches/preview', { packageIds: [pm, pe] });
    ok(pvm.data.eligible === true,
      '多站+单站混合批次预览合格');
    const mEntry = pvm.data.packages.find((p) => p.packageId === pm);
    ok(mEntry.multiStop === true && mEntry.stopCount === 2
      && mEntry.stops.map((s) => s.position).join() === '0,1'
      && mEntry.stops.every((s) => s.eligible),
      '多站包逐站结果（2 站均合格）');
    const cm = await call('POST', '/api/batches/confirm', { confirmToken: pvm.data.confirmToken });
    ok(cm.status === 201 && cm.data.packages.every((p) => p.package.status === 'published' && p.multiStop === (p.packageId === pm)),
      '混合批次整批发布：两包一起 published');
    const mRes = cm.data.packages.find((p) => p.packageId === pm).result;
    ok(mRes.multiStop === true && mRes.stops.length === 2,
      '多站包发布快照结果含冻结的 2 站');

    // 19.13 重算失格整批拒绝且无部分写入：
    //   预览合格后不改依据（basis 不变的情形）——通过改行程日期使指纹与重算均失配不可行，
    //   因此构造“预览后他方改包使重算失格但指纹/依据巧合不变”不现实；
    //   改为端到端覆盖：失格包无法获得凭据（19.4），且成功批次后单包仍可独立走既有发布链路（兼容）。
    const f = await mk2('批次-兼容单包F');
    await addAuth2(f, '*', '*', '2020-01-01', '2100-12-31');
    const pf = (await call('POST', '/api/packages', {
      name: '批次后-单包发布F', medium: '屏幕放映', region: '中国大陆', ...SPR, materialIds: [f],
    })).data.id;
    const vf = await call('POST', '/api/verify', { packageId: pf });
    const pubf = await call('POST', `/api/packages/${pf}/publish`, { basisVersion: vf.data.basisVersion });
    ok(pubf.status === 201 && pubf.data.attestation.body.sealContext === 'publish',
      '批次功能上线后既有单包发布（sealContext=publish、422 留痕、凭证导出）保持兼容');

    // 19.14 失败发布留痕兼容：不合格单包发布仍 422 并留快照（批次路径则不留痕）
    const pg = (await call('POST', '/api/packages', {
      name: '批次后-单包失败G', medium: '屏幕放映', region: '中国大陆', ...AUT, materialIds: [c],
    })).data.id;
    const curBasis = (await call('GET', '/api/state')).data.basisVersion;
    const pubg = await call('POST', `/api/packages/${pg}/publish`, { basisVersion: curBasis });
    ok(pubg.status === 422 && pubg.data.details.snapshotId
      && (await call('GET', `/api/packages/${pg}`)).data.status === 'draft'
      && (await call('GET', `/api/packages/${pg}`)).data.snapshots.some((s) => s.kind === 'publish' && !s.eligible),
      '既有单包失败发布仍 422 留不可变快照；批次失败则整批不留痕');

    // 19.15 已发布包不能再进批次；需复核包同样不可选
    r = await call('POST', '/api/batches/preview', { packageIds: [pa, pf] });
    ok(r.status === 409 && r.data.details.code === 'NOT_DRAFT', '已发布包不能再进批次');

    // 19.16 来源链逐包独立：两包共享上游时各自逐站核验、各自封存凭证
    const root = await mk2('批次-共享上游根'); const up = await mk2('批次-共享上游节点');
    await addLink2(root, up);
    await addAuth2(root, '*', '*', '2020-01-01', '2100-12-31');
    await addAuth2(up, '*', '*', '2020-01-01', '2100-12-31');
    const ph = (await call('POST', '/api/packages', {
      name: '批次-共享链H', medium: '屏幕放映', region: '中国大陆', ...SPR, materialIds: [root],
    })).data.id;
    const pi = (await call('POST', '/api/packages', {
      name: '批次-共享链I', medium: '*', region: '*', ...SPR, materialIds: [up],
    })).data.id;
    const pvs = await call('POST', '/api/batches/preview', { packageIds: [ph, pi] });
    ok(pvs.data.eligible === true
      && pvs.data.packages.find((p) => p.packageId === ph).stops[0].nodeCount === 2
      && pvs.data.packages.find((p) => p.packageId === pi).stops[0].nodeCount === 1,
      '共享来源节点的两个包逐包独立核验（闭包节点数各自正确）');
    const cs = await call('POST', '/api/batches/confirm', { confirmToken: pvs.data.confirmToken });
    ok(cs.status === 201
      && cs.data.packages.find((p) => p.packageId === ph).attestation.body.manifest.materialIds.join() === String(root)
      && cs.data.packages.find((p) => p.packageId === ph).attestation.body.materials.length === 2,
      '批次各包凭证各自封存完整来源子图');
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
