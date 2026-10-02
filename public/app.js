'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { materials: [], packages: [], basisVersion: 0 };

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 ${res.status}`);
    err.status = res.status;
    err.details = data && data.details;
    err.data = data;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

function errText(e) {
  return e.message + (e.details && e.details.code === 'STALE_BASIS' ? '' : '');
}

// ---------------- 数据加载 ----------------
async function loadState() {
  const [s, mats, pkgs] = await Promise.all([
    api('GET', '/api/state'),
    api('GET', '/api/materials'),
    api('GET', '/api/packages'),
  ]);
  state.materials = mats;
  state.packages = pkgs;
  state.basisVersion = s.basisVersion;
  $('#basisVersion').textContent = s.basisVersion;
  const rb = $('#reviewBadge');
  if (s.reviewCount > 0) { rb.textContent = `需复核：${s.reviewCount}`; rb.classList.remove('hidden'); }
  else rb.classList.add('hidden');
  renderMaterials();
  renderMaterialPick();
  renderPackages();
}

// ---------------- Tabs ----------------
$$('.tab').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.tabpanel').forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
  $$('.tabpanel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${btn.dataset.tab}`));
}));

// ---------------- 素材页 ----------------
function renderMaterials() {
  const box = $('#materialsList');
  if (!state.materials.length) {
    box.innerHTML = '<div class="small-muted">还没有素材，先在上方登记一个。</div>';
    return;
  }
  box.innerHTML = state.materials.map((m) => `
    <div class="card" data-id="${m.id}">
      <h3>${esc(m.title)} <span class="small-muted">#${m.id}</span></h3>
      <div class="meta">${esc(m.kind || '未分类')}${m.note ? ' · ' + esc(m.note) : ''}</div>

      <div class="section-title">来源（本素材使用了下列素材，逐层向上核验）</div>
      <div>${m.sources.map((s) => `
        <span class="chip">← ${esc(s.sourceTitle)}
          <span class="small-muted">(${esc(s.relation)})</span>
          <button title="删除来源关系" data-act="del-link" data-id="${s.id}">×</button>
        </span>`).join('') || '<span class="small-muted">无</span>'}
      </div>
      <form class="mini" data-act="add-link">
        <input type="hidden" name="materialId" value="${m.id}" />
        <select name="sourceMaterialId" required>
          <option value="">选择来源素材…</option>
          ${state.materials.filter((x) => x.id !== m.id && !m.sources.some((s) => s.sourceMaterialId === x.id))
            .map((x) => `<option value="${x.id}">${esc(x.title)}</option>`).join('')}
        </select>
        <input name="relation" placeholder="关系（如 配乐）" style="width:110px" />
        <button class="btn btn-small" type="submit" data-go="save">＋ 来源</button>
        <button class="btn btn-small btn-primary" type="submit" data-go="preview">预演影响</button>
      </form>

      <div class="section-title">授权</div>
      ${m.authorizations.length ? `
        <table class="auth">
          <tr><th>媒介</th><th>地区</th><th>有效期</th><th>状态</th><th>授权方</th><th></th></tr>
          ${m.authorizations.map((a) => `
            <tr class="${a.revoked ? 'revoked' : ''}">
              <td>${esc(a.media)}</td><td>${esc(a.region)}</td>
              <td>${a.validFrom} → ${a.validTo}</td>
              <td>${a.revoked ? '<span class="pill pill-bad">已撤销</span>' : '<span class="pill pill-ok">有效</span>'}</td>
              <td>${esc(a.licensor || '')}</td>
              <td class="pkg-actions">
                <button class="btn btn-small" data-act="edit-auth" data-id="${a.id}">改</button>
                ${a.revoked ? '' : `<button class="btn btn-small" data-act="revoke" data-id="${a.id}">撤销</button>`}
                <button class="btn btn-small btn-danger" data-act="del-auth" data-id="${a.id}">删除</button>
              </td>
            </tr>`).join('')}
        </table>` : '<span class="small-muted">无授权登记</span>'}
      <form class="mini" data-act="add-auth">
        <input type="hidden" name="materialId" value="${m.id}" />
        <input type="hidden" name="authorizationId" value="" />
        <input name="media" placeholder="媒介（* 任意）" style="width:100px" required />
        <input name="region" placeholder="地区（* 任意）" style="width:100px" required />
        <input name="validFrom" type="date" required />
        <input name="validTo" type="date" required />
        <input name="licensor" placeholder="授权方" style="width:100px" />
        <label class="revoked-edit hidden" title="修改时可直接把授权置为已撤销"><input type="checkbox" name="revoked" /> 已撤销</label>
        <button class="btn btn-small" type="submit" data-go="save">＋ 授权</button>
        <button class="btn btn-small btn-primary" type="submit" data-go="preview">预演影响</button>
        <button class="btn btn-small hidden" type="button" data-act="cancel-edit-auth">取消修改</button>
      </form>

      <div class="section-title">被用于</div>
      <div>${m.usedBy.map((u) => `<span class="chip">${esc(u.materialTitle)} <span class="small-muted">(${esc(u.relation)})</span></span>`).join('') || '<span class="small-muted">无</span>'}</div>
    </div>`).join('');
}

$('#addMaterialForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('POST', '/api/materials', { title: f.title.value, kind: f.kind.value });
    f.reset();
    await loadState();
    toast('素材已登记');
  } catch (err) { toast(errText(err), true); }
});

// 依据表单构造变更操作载荷（字段沿用既有编辑接口）
function authFormChange(form) {
  const authorizationId = Number(form.authorizationId.value || 0);
  if (authorizationId) {
    return {
      operation: 'authorization.update',
      authorizationId,
      media: form.media.value, region: form.region.value,
      validFrom: form.validFrom.value, validTo: form.validTo.value,
      licensor: form.licensor.value,
      revoked: form.revoked.checked,
    };
  }
  return {
    operation: 'authorization.create',
    materialId: Number(form.materialId.value),
    media: form.media.value, region: form.region.value,
    validFrom: form.validFrom.value, validTo: form.validTo.value,
    licensor: form.licensor.value,
  };
}

function resetAuthForm(form) {
  form.reset();
  form.authorizationId.value = '';
  form.querySelector('[data-go="save"]').textContent = '＋ 授权';
  form.querySelector('.revoked-edit').classList.add('hidden');
  form.querySelector('[data-act="cancel-edit-auth"]').classList.add('hidden');
}

function fillAuthFormForEdit(form, auth) {
  form.authorizationId.value = auth.id;
  form.media.value = auth.media;
  form.region.value = auth.region;
  form.validFrom.value = auth.validFrom;
  form.validTo.value = auth.validTo;
  form.licensor.value = auth.licensor || '';
  form.revoked.checked = !!auth.revoked;
  form.querySelector('[data-go="save"]').textContent = '保存修改';
  form.querySelector('.revoked-edit').classList.remove('hidden');
  form.querySelector('[data-act="cancel-edit-auth"]').classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('#materialsList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.card');
  try {
    if (btn.dataset.act === 'edit-auth') {
      const matId = Number(card.dataset.id);
      const mat = state.materials.find((x) => x.id === matId);
      const auth = mat.authorizations.find((a) => a.id === Number(btn.dataset.id));
      const form = card.querySelector('form[data-act="add-auth"]');
      fillAuthFormForEdit(form, auth);
      return;
    }
    if (btn.dataset.act === 'cancel-edit-auth') {
      resetAuthForm(btn.closest('form'));
      return;
    }

    let change = null;
    let confirmMsg = '';
    if (btn.dataset.act === 'del-link') {
      change = { operation: 'source.delete', linkId: Number(btn.dataset.id) };
      confirmMsg = '删除该来源关系？（可能影响已发布包资格）';
    } else if (btn.dataset.act === 'revoke') {
      change = { operation: 'authorization.revoke', authorizationId: Number(btn.dataset.id) };
      confirmMsg = '撤销该授权？依赖它的已发布包将被标记为需复核。';
    } else if (btn.dataset.act === 'del-auth') {
      change = { operation: 'authorization.delete', authorizationId: Number(btn.dataset.id) };
      confirmMsg = '删除该授权？此变更不可从快照中追溯恢复。';
    }
    if (!change) return;

    if ($('#previewMode').checked) {
      await openChangePreview(change);
      return;
    }
    if (!confirm(confirmMsg)) return;
    if (change.operation === 'source.delete') {
      await api('DELETE', `/api/source-links/${change.linkId}`);
      toast('来源关系已删除，已重新计算已发布包资格');
    } else if (change.operation === 'authorization.revoke') {
      await api('POST', `/api/authorizations/${change.authorizationId}/revoke`);
      toast('授权已撤销，已重新计算已发布包资格');
    } else {
      await api('DELETE', `/api/authorizations/${change.authorizationId}`);
      toast('授权已删除，已重新计算已发布包资格');
    }
    await loadState();
  } catch (err) { toast(errText(err), true); }
});

$('#materialsList').addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-act]');
  if (!form) return;
  e.preventDefault();
  const go = e.submitter && e.submitter.dataset.go === 'preview' ? 'preview' : 'save';
  try {
    if (form.dataset.act === 'add-link') {
      const change = {
        operation: 'source.create',
        materialId: Number(form.materialId.value),
        sourceMaterialId: Number(form.sourceMaterialId.value),
        relation: form.relation.value,
      };
      if (go === 'preview' || $('#previewMode').checked) {
        await openChangePreview(change, undefined, form);
        return;
      }
      await api('POST', `/api/materials/${change.materialId}/sources`, {
        sourceMaterialId: change.sourceMaterialId,
        relation: change.relation,
      });
      toast('来源关系已登记');
    } else if (form.dataset.act === 'add-auth') {
      const change = authFormChange(form);
      if (go === 'preview' || $('#previewMode').checked) {
        await openChangePreview(change, undefined, form);
        return;
      }
      // 关闭预演模式时沿用既有接口直接保存
      if (change.operation === 'authorization.update') {
        await api('PATCH', `/api/authorizations/${change.authorizationId}`, change);
        toast('授权已修改');
      } else {
        await api('POST', `/api/materials/${change.materialId}/authorizations`, change);
        toast('授权已登记');
      }
      resetAuthForm(form);
    }
    await loadState();
  } catch (err) {
    if (err.status === 409 && err.details && err.details.cyclePath) {
      const cycle = err.details.cycle || err.details.cyclePath;
      const names = cycle.map((id) => {
        const m = state.materials.find((x) => x.id === id);
        return m ? m.title : `#${id}`;
      });
      toast(`${err.message} 闭环路径：${names.join(' → ')}`, true);
    } else toast(errText(err), true);
  }
});

// ---------------- 展览包页 ----------------
function renderMaterialPick() {
  const pick = $('#materialPick');
  const selected = new Set($$('#materialPick input:checked').map((i) => i.value));
  if (!state.materials.length) { pick.innerHTML = '<span class="small-muted">请先到「素材与来源」页登记素材</span>'; return; }
  pick.innerHTML = state.materials.map((m) => `
    <label><input type="checkbox" name="materialIds" value="${m.id}" ${selected.has(String(m.id)) ? 'checked' : ''} />
      ${esc(m.title)} <span class="small-muted">#${m.id}</span></label>`).join('');
}

// ---------------- 多站行程编辑 ----------------
function stopRowHtml(s = {}, idx) {
  return `
    <tr class="stop-row">
      <td class="stop-idx">${idx + 1}</td>
      <td><input class="stop-name" placeholder="站点名称，如 北京首展" value="${esc(s.name || '')}" /></td>
      <td><input class="stop-medium" placeholder="屏幕放映 / *" value="${esc(s.medium || '')}" /></td>
      <td><input class="stop-region" placeholder="中国大陆 / *" value="${esc(s.region || '')}" /></td>
      <td><input class="stop-from" type="date" value="${s.useFrom || ''}" /></td>
      <td><input class="stop-to" type="date" value="${s.useTo || ''}" /></td>
      <td><button type="button" class="btn btn-small btn-danger" data-act="del-stop">删</button></td>
    </tr>`;
}

function renumberStops() {
  $$('#stopsTable .stop-row').forEach((tr, i) => { tr.querySelector('.stop-idx').textContent = i + 1; });
}

function addStopRow(s) {
  const tbl = $('#stopsTable');
  tbl.insertAdjacentHTML('beforeend', stopRowHtml(s, tbl.querySelectorAll('.stop-row').length));
  renumberStops();
}

function setMultiStopMode(on, stops) {
  $('#multiStopToggle').checked = !!on;
  $('#singleStopFields').classList.toggle('hidden', !!on);
  $('#stopsEditor').classList.toggle('hidden', !on);
  const f = $('#packageForm');
  ['medium', 'region', 'useFrom', 'useTo'].forEach((n) => { f[n].required = !on; });
  if (on) {
    $('#stopsTable').querySelectorAll('.stop-row').forEach((tr) => tr.remove());
    (stops && stops.length ? stops : [{}, {}]).forEach((s) => addStopRow(s));
  }
  // 档期搜索只适用于单站
  $('#scheduleFormBtn').classList.toggle('hidden', !!on);
}

$('#multiStopToggle').addEventListener('change', (e) => {
  setMultiStopMode(e.target.checked);
});
$('#addStopBtn').addEventListener('click', () => addStopRow({}));
$('#stopsTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="del-stop"]');
  if (!btn) return;
  btn.closest('.stop-row').remove();
  renumberStops();
});

function readStopsFromForm() {
  return $$('#stopsTable .stop-row').map((tr) => ({
    name: tr.querySelector('.stop-name').value.trim(),
    medium: tr.querySelector('.stop-medium').value.trim(),
    region: tr.querySelector('.stop-region').value.trim(),
    useFrom: tr.querySelector('.stop-from').value,
    useTo: tr.querySelector('.stop-to').value,
  }));
}

function readPkgForm() {
  const f = $('#packageForm');
  const b = {
    packageId: f.packageId.value ? Number(f.packageId.value) : null,
    name: f.name.value.trim(),
    materialIds: $$('#materialPick input:checked').map((i) => Number(i.value)),
  };
  if ($('#multiStopToggle').checked) {
    b.stops = readStopsFromForm();
  } else {
    b.medium = f.medium.value.trim();
    b.region = f.region.value.trim();
    b.useFrom = f.useFrom.value;
    b.useTo = f.useTo.value;
  }
  return b;
}

function fillPkgForm(pkg) {
  const f = $('#packageForm');
  f.packageId.value = pkg.id || '';
  f.name.value = pkg.name || '';
  renderMaterialPick();
  const ids = new Set((pkg.items || pkg.materialIds || []).map((x) => typeof x === 'object' ? x.id : x));
  $$('#materialPick input').forEach((i) => { i.checked = ids.has(Number(i.value)); });
  const stops = pkg.stops && pkg.stops.length >= 2 ? pkg.stops : null;
  if (stops) {
    setMultiStopMode(true, stops);
  } else {
    setMultiStopMode(false);
    f.medium.value = pkg.medium || '';
    f.region.value = pkg.region || '';
    f.useFrom.value = pkg.useFrom || '';
    f.useTo.value = pkg.useTo || '';
  }
  $('#pkgFormTitle').textContent = pkg.id ? `编辑待发布包 #${pkg.id}` : '新建待发布展览包';
  $('#savePkgBtn').textContent = pkg.id ? '保存修改' : '保存待发布包';
  $('#verifyPanel').classList.add('hidden');
}

$('#newPkgBtn').addEventListener('click', () => fillPkgForm({}));

$('#packageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = readPkgForm();
  try {
    let pkg;
    if (b.packageId) {
      pkg = await api('PATCH', `/api/packages/${b.packageId}`, b);
      toast('待发布包已更新');
    } else {
      pkg = await api('POST', '/api/packages', b);
      toast('待发布包已保存');
    }
    await loadState();
    fillPkgForm(pkg);
  } catch (err) { toast(errText(err), true); }
});

// ---- 核验 ----
$('#verifyPkgBtn').addEventListener('click', async () => {
  const b = readPkgForm();
  try {
    const body = b.packageId
      ? { packageId: b.packageId }
      : b.stops
        ? { materialIds: b.materialIds, stops: b.stops }
        : { materialIds: b.materialIds, medium: b.medium, region: b.region, useFrom: b.useFrom, useTo: b.useTo };
    const result = await api('POST', '/api/verify', body);
    if (result.multiStop) renderVerifyMulti(result, b);
    else renderVerify(result, b);
  } catch (err) { toast(errText(err), true); }
});

function pathHtml(pathArr) {
  return '<div class="path">' + pathArr.map((n, i) =>
    (i ? ' → ' : '') + `<span>${esc(n.title)}</span>`).join('') + '</div>';
}

function failingNodeCard(n) {
  return `
    <div class="card" style="margin-bottom:8px">
      <h3><span class="fail-node">${esc(n.title)}</span> <span class="small-muted">#${n.materialId}${n.isRoot ? '（入展品）' : ''}</span></h3>
      <div>${n.reasonText.map((t) => `<span class="pill pill-bad">${esc(t)}</span>`).join(' ')}</div>
      <div class="section-title">不合格来源路径（共 ${n.paths.length} 条）</div>
      ${n.paths.map((p) => '<div class="path">' + p.map((x, i) =>
        (i ? ' → ' : '') + `<span class="${x.materialId === n.materialId ? 'fail-node' : ''}">${esc(x.title)}</span>`).join('') + '</div>').join('')}
    </div>`;
}

// 多站核验结果：按站列出问题节点、原因与全部来源路径
function renderVerifyMulti(result, formData, mode = 'publish') {
  const panel = $('#verifyPanel');
  panel.classList.remove('hidden');
  const globalErrs = (result.globalErrors || []).map((m) => `<div class="errorline">${esc(m)}</div>`).join('');
  const itemErrs = (result.itemErrors || []).map((x) => `<div class="errorline">${esc(x.message)}</div>`).join('');

  const verdictText = mode === 'recheck'
    ? (result.eligible ? '✓ 复核通过：全部站点的全部来源链节点均合格，可恢复为已发布。'
                      : '✗ 复核不通过：仍有站点存在不合格节点，包保持需复核状态（须全站合格才恢复）。')
    : (result.eligible ? '✓ 核验通过：每一站的来源链节点都有未撤销且覆盖该站整段展期的授权，可以整包发布。'
                      : '✗ 核验不通过：存在失格站点或输入错误，整包禁止发布（任一站失败即整包不发布）。');

  const stopsHtml = result.stops.map((s) => `
    <div class="card stop-card ${s.eligible ? 'stop-ok' : 'stop-bad'}" style="margin-bottom:10px">
      <h3>第 ${s.position + 1} 站：${esc(s.name)}
        ${s.eligible ? '<span class="pill pill-ok">本站合格</span>' : `<span class="pill pill-bad">本站失格（${s.stats.failingCount} 个问题节点）</span>`}
        <span class="small-muted">${esc(s.medium)} ｜ ${esc(s.region)} ｜ ${s.useFrom} → ${s.useTo}</span>
      </h3>
      ${(s.errors || []).map((m) => `<div class="errorline">${esc(m)}</div>`).join('')}
      ${s.failingNodes.map(failingNodeCard).join('')}
    </div>`).join('');

  const actionArea = mode === 'publish' && result.eligible && formData.packageId ? `
      <div class="pkg-actions">
        <button class="btn btn-primary" id="publishBtn">按此次核验结果原子发布（冻结各站结果与清单）</button>
        <span class="small-muted">发布将在同一事务内重读行程、清单与授权依据并逐站重算；任一站变化或不合格都会整包拒绝。</span>
      </div>`
    : (mode === 'publish' && result.eligible ? '<div class="small-muted">请先「保存待发布包」，再执行发布。</div>' : '');

  panel.innerHTML = `
    <div class="verdict ${result.eligible ? 'pass' : 'fail'}">
      ${verdictText}
      <span class="sub">共 ${result.stats.stopCount} 站 · 失格 ${result.stats.failingStopCount} 站 · 入展品 ${result.stats.rootCount} 个 · 来源链节点 ${result.stats.nodeCount} 个 · 核验依据版本 ${result.basisVersion}</span>
    </div>
    ${globalErrs}${itemErrs}
    ${stopsHtml}
    ${actionArea}`;

  if (mode === 'publish' && result.eligible) {
    $('#publishBtn').addEventListener('click', () => doPublish(formData, result.basisVersion));
  }
}

function renderVerify(result, formData, mode = 'publish') {
  // mode: 'publish'（待发布包，可发布）| 'recheck'（已发布/需复核包，只能人工复核）
  const panel = $('#verifyPanel');
  panel.classList.remove('hidden');
  const globalErrs = (result.globalErrors || []).map((m) => `<div class="errorline">${esc(m)}</div>`).join('');
  const itemErrs = (result.itemErrors || []).map((x) => `<div class="errorline">${esc(x.message)}</div>`).join('');
  const fail = (result.failingNodes || []).map((n) => `
    <div class="card" style="margin-bottom:8px">
      <h3><span class="fail-node">${esc(n.title)}</span> <span class="small-muted">#${n.materialId}${n.isRoot ? '（入展品）' : ''}</span></h3>
      <div>${n.reasonText.map((t) => `<span class="pill pill-bad">${esc(t)}</span>`).join(' ')}</div>
      <div class="section-title">不合格来源路径（共 ${n.paths.length} 条${result.stats.pathCountTruncated ? '，过多已截断' : ''}）</div>
      ${n.paths.map((p) => '<div class="path">' + p.map((x, i) =>
        (i ? ' → ' : '') + `<span class="${x.materialId === n.materialId ? 'fail-node' : ''}">${esc(x.title)}</span>`).join('') + '</div>').join('')}
    </div>`).join('');

  const verdictText = mode === 'recheck'
    ? (result.eligible ? '✓ 复核通过：当前全部来源链节点均合格，可恢复为已发布。'
                      : '✗ 复核不通过：仍存在不合格节点，包保持需复核状态。')
    : (result.eligible ? '✓ 核验通过：来源链上每个节点都有未撤销且覆盖整段使用的授权，可以发布。'
                      : '✗ 核验不通过：存在不合格节点或输入错误，禁止发布。');

  const actionArea = mode === 'publish' && result.eligible && formData.packageId ? `
      <div class="pkg-actions">
        <button class="btn btn-primary" id="publishBtn">按此次核验结果原子发布</button>
        <span class="small-muted">发布将再次按当前数据重算并校验依据版本；若期间授权被修改会被拒绝。</span>
      </div>`
    : (mode === 'publish' && result.eligible ? '<div class="small-muted">请先「保存待发布包」，再执行发布。</div>' : '');

  panel.innerHTML = `
    <div class="verdict ${result.eligible ? 'pass' : 'fail'}">
      ${verdictText}
      <span class="sub">入展品 ${result.stats.rootCount} 个 · 来源链节点 ${result.stats.nodeCount} 个 · 不合格 ${result.stats.failingCount} 个 · 核验依据版本 ${result.basisVersion}</span>
    </div>
    ${globalErrs}${itemErrs}
    ${result.eligible ? '' : (fail || '<div class="small-muted">所有节点均满足授权要求（但可能存在上方全局错误）。</div>')}
    ${actionArea}`;

  if (mode === 'publish' && result.eligible) {
    $('#publishBtn').addEventListener('click', () => doPublish(formData, result.basisVersion));
  }
}

async function doPublish(formData, basisVersion) {
  if (!formData.packageId) { toast('请先「保存待发布包」，再发布', true); return; }
  try {
    const r = await api('POST', `/api/packages/${formData.packageId}/publish`, { basisVersion });
    toast(`发布成功，不可变快照 #${r.snapshotId} 已保存`);
    await loadState();
    fillPkgForm({});
    openSnapshot(r.snapshotId);
  } catch (err) {
    if (err.status === 409 && err.details && err.details.code === 'STALE_BASIS') {
      toast(`依据过期被拒绝：${err.message} 请点「核验」后重试发布。`, true);
      await loadState();
    } else if (err.status === 422 && err.data && err.data.details && err.data.details.result) {
      toast('核验未通过，已拒绝发布（本次核验记录已留存为快照）', true);
      await loadState();
      if (err.data.details.result.multiStop) renderVerifyMulti(err.data.details.result, formData);
      else renderVerify(err.data.details.result, formData);
    } else toast(errText(err), true);
  }
}

// ---- 档期规划：搜索可用起始日并选定改期 ----
$('#scheduleFormBtn').addEventListener('click', async () => {
  const b = readPkgForm();
  if (!b.packageId) {
    toast('请先「保存待发布包」，再搜索档期（档期搜索只针对已保存的待发布包）', true);
    return;
  }
  await openScheduleSearch(b.packageId);
});

$('#quoteFormBtn').addEventListener('click', () => {
  const b = readPkgForm();
  if (!b.packageId) {
    toast('请先「保存待发布包」，再做授权报价预览', true);
    return;
  }
  openQuotePreview(b.packageId);
});

async function openScheduleSearch(packageId) {
  // 始终以服务端当前包参数为准（展期天数取自包当前展期，无需信任表单）
  let pkg;
  try {
    pkg = await api('GET', `/api/packages/${packageId}`);
  } catch (err) { toast(errText(err), true); return; }

  $('#modalTitle').textContent = `档期搜索：${pkg.name} #${pkg.id}`;
  $('#modalBody').innerHTML = `
    <div class="edit-banner">
      <span>展期天数按包当前展期（含首尾）：<b>${pkg.useFrom} → ${pkg.useTo}</b></span>
      <span class="small-muted">媒介 ${esc(pkg.medium)} ｜ 地区 ${esc(pkg.region)} ｜ 素材 ${pkg.itemCount} 项</span>
    </div>
    <div class="mini" style="align-items:flex-end">
      <label class="pick-label" style="margin:0">规划窗口起
        <input type="date" id="planFrom" value="${pkg.useFrom || ''}" />
      </label>
      <label class="pick-label" style="margin:0">规划窗口止
        <input type="date" id="planTo" value="${pkg.useTo || ''}" />
      </label>
      <button class="btn btn-primary btn-small" id="scheduleSearchBtn">搜索可用起始日</button>
    </div>
    <div id="scheduleResult" class="schedule-result" style="margin-top:10px"></div>`;
  const foot = $('#modalFoot');
  foot.classList.remove('hidden');
  foot.innerHTML = `<button class="btn" id="scheduleCancel">关闭</button>`;
  $('#scheduleCancel').addEventListener('click', () => $('#modalBackdrop').classList.add('hidden'));
  $('#modalBackdrop').classList.remove('hidden');

  $('#scheduleSearchBtn').addEventListener('click', async () => {
    const planFrom = $('#planFrom').value;
    const planTo = $('#planTo').value;
    const box = $('#scheduleResult');
    box.innerHTML = '<div class="small-muted">搜索中…</div>';
    try {
      const r = await api('POST', `/api/packages/${packageId}/schedule/search`, { planFrom, planTo });
      renderScheduleResult(packageId, r);
    } catch (err) {
      box.innerHTML = `<div class="errorline">${esc(errText(err))}</div>`;
    }
  });

  // 默认直接搜索一次
  $('#scheduleSearchBtn').click();
}

function scheduleRangeHtml(packageId, r, idx) {
  const multi = r.startFrom !== r.startTo;
  return `
    <div class="schedule-range">
      <div class="schedule-range-head">
        <b>${esc(r.startFrom)}${multi ? ` → ${esc(r.startTo)}` : ''}</b>
        <span class="small-muted">${multi ? `共 ${r.dayCount || ''} 个连续可行起始日` : '单日可行'}</span>
        <span class="pill pill-ok">最早展期 ${r.earliestExhibitionFrom} → ${r.earliestExhibitionTo}</span>
      </div>
      <div class="mini" style="margin-top:4px">
        <label class="pick-label" style="margin:0">选定起始日
          <input type="date" id="pickStart_${idx}" min="${r.startFrom}" max="${r.startTo}" value="${r.startFrom}" />
        </label>
        <button class="btn btn-primary btn-small" data-range-idx="${idx}">按此档期改期</button>
      </div>
    </div>`;
}

function renderScheduleResult(packageId, r) {
  const box = $('#scheduleResult');
  const head = r.windowTooShort
    ? `<div class="verdict fail">规划窗口放不下 ${r.durationDays} 天的展期（含首尾），无可用档期。<span class="sub">${esc(r.message || '')}</span></div>`
    : (r.feasible
      ? `<div class="verdict pass">✓ 找到 ${r.ranges.length} 段连续可行起始日（展期固定 ${r.durationDays} 天，含首尾；每段给出最早展期）。
           <span class="sub">核验依据版本 ${r.basisVersion} ｜ 规划窗口 ${r.planFrom} → ${r.planTo} ｜ 选定后将在事务内重验，授权/包变化则拒绝改期</span></div>`
      : `<div class="verdict fail">✗ 规划窗口内无可行起始日（交集为空）。<span class="sub">${esc(r.message || '')}</span></div>`);

  const ranges = r.feasible ? r.ranges.map((x, i) => scheduleRangeHtml(packageId, x, i)).join('') : '';

  const restricted = (!r.feasible && !r.windowTooShort && r.restrictedNodes.length) ? `
    <div class="section-title">各受限节点在窗口内的可用起始日范围（取交集后为空）</div>
    <table class="auth">
      <tr><th>节点</th><th>限制原因</th><th>窗口内可用起始日范围</th></tr>
      ${r.restrictedNodes.map((n) => `
        <tr>
          <td>${esc(n.title)} <span class="small-muted">#${n.materialId}${n.isRoot ? '（入展品）' : ''}</span></td>
          <td>${n.reasonText ? `<span class="pill pill-bad">${esc(n.reasonText)}</span>` : '<span class="small-muted">—</span>'}</td>
          <td>${n.ranges.length
            ? n.ranges.map((x) => `<span class="chip">${x.startFrom} → ${x.startTo}</span>`).join('')
            : '<span class="pill pill-bad">窗口内无可用起始日</span>'}</td>
        </tr>`).join('')}
    </table>` : '';

  box.innerHTML = head + ranges + restricted;

  if (r.feasible) {
    box.querySelectorAll('button[data-range-idx]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.rangeIdx);
        const range = r.ranges[idx];
        const useFrom = $(`#pickStart_${idx}`).value;
        if (!useFrom || useFrom < range.startFrom || useFrom > range.startTo) {
          toast(`请在 ${range.startFrom} 至 ${range.startTo} 之间选择起始日`, true);
          return;
        }
        btn.disabled = true;
        try {
          const out = await api('POST', `/api/packages/${packageId}/schedule/apply`, {
            useFrom,
            searchToken: r.searchToken,
          });
          $('#modalBackdrop').classList.add('hidden');
          await loadState();
          toast(`档期已更新：${out.useFrom} → ${out.useTo}（展期 ${out.durationDays} 天，含首尾）`);
        } catch (err) {
          btn.disabled = false;
          if (err.status === 409 && err.details && (err.details.code === 'STALE_BASIS' || err.details.code === 'PACKAGE_CHANGED' || err.details.code === 'SLOT_INVALID')) {
            toast(`${err.message} 请重新搜索档期`, true);
            await loadState();
            // 以最新数据重新打开搜索
            await openScheduleSearch(packageId);
          } else {
            toast('改期被拒绝：' + errText(err), true);
          }
        }
      });
    });
  }
}

// ---- 包列表 ----
const STATUS_TEXT = { draft: '待发布', published: '已发布', needs_review: '需复核' };

function renderPackages() {
  const box = $('#packagesList');
  if (!state.packages.length) { box.innerHTML = '<div class="small-muted">还没有展览包。</div>'; return; }
  box.innerHTML = state.packages.map((p) => `
    <div class="panel" data-id="${p.id}">
      <div class="pkg-head">
        <h3>${esc(p.name)} <span class="small-muted">#${p.id}</span>
          <span class="pill ${p.status === 'published' ? 'pill-ok' : p.status === 'needs_review' ? 'pill-bad' : 'pill-neutral'}">${STATUS_TEXT[p.status]}</span>
        </h3>
        <div class="pkg-actions">
          ${p.status === 'draft' ? `<button class="btn btn-small" data-act="edit">编辑</button>` : ''}
          ${p.status === 'draft' ? `<button class="btn btn-small btn-primary" data-act="to-verify">去核验</button>` : ''}
          ${p.status === 'draft' && !p.multiStop ? `<button class="btn btn-small" data-act="schedule">档期搜索</button>` : ''}
          ${p.status === 'draft' ? `<button class="btn btn-small" data-act="substitutes">替代素材方案</button>` : ''}
          ${p.status !== 'published' ? `<button class="btn btn-small" data-act="quotes">授权报价预览</button>` : ''}
          ${p.status === 'draft' && p.multiStop ? '<span class="small-muted" title="档期搜索仅适用于单站包">多站行程在上方逐站编排（不支持整包档期搜索）</span>' : ''}
          ${p.status === 'needs_review' ? `<button class="btn btn-small btn-primary" data-act="recheck">重新核验（人工复核）</button>` : ''}
          <button class="btn btn-small" data-act="snapshot">查看最新快照</button>
          <button class="btn btn-small" data-act="copy">复制为待发布包</button>
          ${p.status === 'draft' ? `<button class="btn btn-small btn-danger" data-act="del">删除</button>` : ''}
        </div>
      </div>
      <div class="pkg-meta">
        ${p.multiStop
          ? `多站巡展：<b>${p.stopCount} 站</b>（整包共享素材 ${p.itemCount} 项）${p.publishedAt ? `｜ 发布于 ${p.publishedAt.slice(0, 19).replace('T', ' ')}` : ''}`
          : `媒介：${esc(p.medium)} ｜ 地区：${esc(p.region)} ｜ 使用期：${p.useFrom} → ${p.useTo}
        ｜ 素材 ${p.itemCount} 项${p.publishedAt ? `｜ 发布于 ${p.publishedAt.slice(0, 19).replace('T', ' ')}` : ''}`}
      </div>
      ${p.multiStop ? `
      <div class="pkg-meta" style="margin-top:4px">
        <div class="section-title">站次行程</div>
        ${(p.stops || []).map((s, i) => `<span class="chip">${i + 1}. ${esc(s.name)}（${esc(s.medium)} / ${esc(s.region)}，${s.useFrom} → ${s.useTo}）</span>`).join(' ')}
      </div>` : ''}
      <div class="pkg-meta" style="margin-top:4px">
        素材：${p.items.map((i) => esc(i.title)).join('、')}
      </div>
      ${p.latestSnapshot ? `<div class="small-muted" style="margin-top:4px">
        最新快照 #${p.latestSnapshot.id}（${{ publish: '发布', review: '自动复核', recheck: '人工复核' }[p.latestSnapshot.kind]}，
        依据版本 ${p.latestSnapshot.basisVersion}，${p.latestSnapshot.eligible ? '当时合格' : '当时不合格'}，
        ${p.latestSnapshot.createdAt.slice(0, 19).replace('T', ' ')}）— 发布快照 ${p.publishSnapshotId ? `#${p.publishSnapshotId}` : '无'} 始终保留
      </div>` : ''}
    </div>`).join('');
}

$('#packagesList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('.panel').dataset.id);
  const pkg = state.packages.find((x) => x.id === id);
  try {
    if (btn.dataset.act === 'edit' || btn.dataset.act === 'to-verify') {
      const full = await api('GET', `/api/packages/${id}`);
      fillPkgForm(full);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (btn.dataset.act === 'to-verify') {
        const result = await api('POST', '/api/verify', { packageId: id });
        if (result.multiStop) renderVerifyMulti(result, readPkgForm());
        else renderVerify(result, readPkgForm());
      }
    } else if (btn.dataset.act === 'snapshot') {
      await openSnapshot(pkg.latestSnapshot.id);
    } else if (btn.dataset.act === 'copy') {
      const copy = await api('POST', `/api/packages/${id}/copy`);
      await loadState();
      fillPkgForm(copy);
      toast('已复制为新的待发布包');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (btn.dataset.act === 'recheck') {
      const r = await api('POST', `/api/packages/${id}/recheck`);
      await loadState();
      if (r.result.multiStop) renderVerifyMulti(r.result, { packageId: id }, 'recheck');
      else renderVerify(r.result, { packageId: id }, 'recheck');
      toast(r.message, !r.restored);
    } else if (btn.dataset.act === 'schedule') {
      await openScheduleSearch(id);
    } else if (btn.dataset.act === 'quotes') {
      await openQuotePreview(id);
    } else if (btn.dataset.act === 'substitutes') {
      await openSubstitutePreview(id);
    } else if (btn.dataset.act === 'del') {
      if (!confirm('删除该待发布包？')) return;
      await api('DELETE', `/api/packages/${id}`);
      await loadState();
      toast('已删除');
    }
  } catch (err) { toast(errText(err), true); }
});

// ---- 快照弹层 ----
async function openSnapshot(snapshotId) {
  try {
    const s = await api('GET', `/api/snapshots/${snapshotId}`);
    $('#modalTitle').textContent =
      `核验快照 #${s.id}（${{ publish: '发布', review: '自动复核', recheck: '人工复核' }[s.kind]}）— 不可变`;
    $('#modalFoot').classList.add('hidden');
    $('#modalFoot').innerHTML = '';
    const p = s.payload;
    const headLine = p.multiStop
      ? `<span class="sub">生成于 ${s.createdAt} ｜ 依据版本 ${s.basisVersion} ｜ 多站巡展 ${p.request.stops.length} 站 ｜ 冻结素材清单（入展品 ID：${p.request.materialIds.join(', ') || '空'}）</span>
         <div class="section-title">冻结的各站行程与结果</div>
         <table class="auth">
           <tr><th>#</th><th>站点</th><th>媒介</th><th>地区</th><th>展期</th><th>结论</th></tr>
           ${p.stops.map((st) => `
             <tr>
               <td>${st.position + 1}</td><td>${esc(st.name)}</td><td>${esc(st.medium)}</td><td>${esc(st.region)}</td>
               <td>${st.useFrom} → ${st.useTo}</td>
               <td>${st.eligible ? '<span class="pill pill-ok">合格</span>' : `<span class="pill pill-bad">失格 ${st.stats.failingCount} 节点</span>`}</td>
             </tr>`).join('')}
         </table>`
      : `<span class="sub">生成于 ${s.createdAt} ｜ 依据版本 ${s.basisVersion} ｜ 媒介 ${esc(p.request.medium)} ｜ 地区 ${esc(p.request.region)} ｜ 使用期 ${p.request.useFrom} → ${p.request.useTo}</span>
      <div class="section-title">冻结素材清单（入展品 ID：${p.request.materialIds.join(', ') || '空'}）</div>`;
    $('#modalBody').innerHTML = `
      <div class="verdict ${s.eligible ? 'pass' : 'fail'}">
        ${s.eligible ? '该快照记录的核验结果：合格' : '该快照记录的核验结果：不合格'}
        ${headLine}
      </div>`;
    if (p.multiStop) {
      $('#modalBody').innerHTML += p.stops.map((st) => `
        <div class="stop-card ${st.eligible ? 'stop-ok' : 'stop-bad'}" style="margin-top:8px">
          <div class="section-title">第 ${st.position + 1} 站：${esc(st.name)}（${esc(st.medium)} / ${esc(st.region)}，${st.useFrom} → ${st.useTo}）</div>
          <table class="auth">
            <tr><th>节点</th><th>结论</th><th>命中授权</th><th>路径数</th></tr>
            ${st.nodes.map((n) => `
              <tr>
                <td>${esc(n.title)}${n.isRoot ? ' <span class="small-muted">（入展品）</span>' : ''}</td>
                <td>${n.eligible ? '<span class="pill pill-ok">合格</span>' : n.reasonText.map((t) => `<span class="pill pill-bad">${esc(t)}</span>`).join(' ')}</td>
                <td>${n.matchedAuthorization ? `#${n.matchedAuthorization.id}（${esc(n.matchedAuthorization.media)}/${esc(n.matchedAuthorization.region)}，${n.matchedAuthorization.validFrom}→${n.matchedAuthorization.validTo}）` : '<span class="small-muted">—</span>'}</td>
                <td>${(n.paths ? n.paths.length : (p.nodePaths || []).find((b) => b.materialId === n.materialId)?.paths.length) ?? 0}</td>
              </tr>`).join('')}
          </table>
        </div>`).join('');
    } else {
      $('#modalBody').innerHTML += `
        <table class="auth">
          <tr><th>节点</th><th>结论</th><th>命中授权</th><th>路径数</th></tr>
          ${p.nodes.map((n) => `
            <tr>
              <td>${esc(n.title)}${n.isRoot ? ' <span class="small-muted">（入展品）</span>' : ''}</td>
              <td>${n.eligible ? '<span class="pill pill-ok">合格</span>' : n.reasonText.map((t) => `<span class="pill pill-bad">${esc(t)}</span>`).join(' ')}</td>
              <td>${n.matchedAuthorization ? `#${n.matchedAuthorization.id}（${esc(n.matchedAuthorization.media)}/${esc(n.matchedAuthorization.region)}，${n.matchedAuthorization.validFrom}→${n.matchedAuthorization.validTo}）` : '<span class="small-muted">—</span>'}</td>
              <td>${n.paths.length}</td>
            </tr>`).join('')}
        </table>`;
    }
    $('#modalBody').innerHTML += `
      <div class="section-title">快照原始 JSON</div>
      <pre class="json">${esc(JSON.stringify(p, null, 2))}</pre>`;
    $('#modalBackdrop').classList.remove('hidden');
  } catch (err) { toast(errText(err), true); }
}
$('#modalClose').addEventListener('click', () => $('#modalBackdrop').classList.add('hidden'));
$('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') $('#modalBackdrop').classList.add('hidden'); });

// ---- 授权报价组合预览（只读） ----
function quoteRowHtml(q = {}) {
  const matOpts = ['<option value="">选择素材…</option>']
    .concat(state.materials.map((m) =>
      `<option value="${m.id}" ${q.materialId === m.id ? 'selected' : ''}>${esc(m.title)} #${m.id}</option>`))
    .join('');
  return `
    <tr class="quote-row">
      <td><select class="q-material" required>${matOpts}</select></td>
      <td><input class="q-media" placeholder="屏幕放映 / *" value="${esc(q.media || '')}" required style="width:96px" /></td>
      <td><input class="q-region" placeholder="中国大陆 / *" value="${esc(q.region || '')}" required style="width:96px" /></td>
      <td><input class="q-from" type="date" value="${q.validFrom || ''}" required /></td>
      <td><input class="q-to" type="date" value="${q.validTo || ''}" required /></td>
      <td><input class="q-cost" type="number" min="0" step="1" placeholder="非负整数" value="${q.cost === undefined || q.cost === null ? '' : q.cost}" required style="width:90px" /></td>
      <td><button type="button" class="btn btn-small btn-danger" data-act="del-quote">删</button></td>
    </tr>`;
}

function addQuoteRow(q) {
  const tbl = $('#quoteTable');
  tbl.insertAdjacentHTML('beforeend', quoteRowHtml(q));
}

function readQuoteRows() {
  return $$('#quoteTable .quote-row').map((tr) => ({
    materialId: Number(tr.querySelector('.q-material').value) || 0,
    media: tr.querySelector('.q-media').value.trim(),
    region: tr.querySelector('.q-region').value.trim(),
    validFrom: tr.querySelector('.q-from').value,
    validTo: tr.querySelector('.q-to').value,
    cost: tr.querySelector('.q-cost').value === '' ? null : Number(tr.querySelector('.q-cost').value),
  }));
}

async function openQuotePreview(packageId) {
  let pkg;
  try {
    pkg = await api('GET', `/api/packages/${packageId}`);
  } catch (err) { toast(errText(err), true); return; }

  const scopeLine = pkg.multiStop
    ? `多站巡展 <b>${pkg.stopCount}</b> 站，整包共享素材 ${pkg.itemCount} 项；一份报价可覆盖多站，共享节点只核算一次`
    : `媒介 ${esc(pkg.medium)} ｜ 地区 ${esc(pkg.region)} ｜ 使用期 ${pkg.useFrom} → ${pkg.useTo} ｜ 素材 ${pkg.itemCount} 项`;
  const banned = pkg.status === 'published';

  $('#modalTitle').textContent = `授权报价组合预览：${pkg.name} #${pkg.id}`;
  $('#modalBody').innerHTML = `
    <div class="edit-banner">
      <span>${scopeLine}</span>
      <span class="pill ${banned ? 'pill-bad' : 'pill-neutral'}">${STATUS_TEXT[pkg.status]}</span>
    </div>
    ${banned ? '<div class="errorline">已发布包不可预览授权报价。如需调整请使用「复制为待发布包」。</div>' : `
    <div class="small-muted">
      每项报价注明素材、媒介、地区（<code>*</code> 通配任意值）、有效期与非负整数成本。
      预览<b>只读</b>：不写入授权、包、状态或快照，依据版本不变；同一站同一节点不得用短授权 / 短报价拼接。
    </div>
    <table class="auth" id="quoteTable">
      <tr><th>素材</th><th>媒介</th><th>地区</th><th>有效期起</th><th>有效期止</th><th>成本</th><th></th></tr>
    </table>
    <div class="pkg-actions" style="margin-top:6px">
      <button type="button" class="btn btn-small" id="addQuoteBtn">＋ 添加一项报价</button>
      <button type="button" class="btn btn-primary btn-small" id="runQuoteBtn">求最低成本组合（只读预览）</button>
    </div>
    <div id="quoteResult" class="schedule-result" style="margin-top:10px"></div>`}
  `;
  const foot = $('#modalFoot');
  foot.classList.remove('hidden');
  foot.innerHTML = `<button class="btn" id="quoteClose">关闭</button>`;
  $('#quoteClose').addEventListener('click', () => $('#modalBackdrop').classList.add('hidden'));
  $('#modalBackdrop').classList.remove('hidden');
  if (banned) return;

  addQuoteRow({});
  $('#addQuoteBtn').addEventListener('click', () => addQuoteRow({}));
  $('#quoteTable').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act="del-quote"]');
    if (!btn) return;
    btn.closest('.quote-row').remove();
  });
  $('#runQuoteBtn').addEventListener('click', async () => {
    const box = $('#quoteResult');
    box.innerHTML = '<div class="small-muted">求解中…</div>';
    try {
      const r = await api('POST', `/api/packages/${packageId}/quotes/preview`, { quotes: readQuoteRows() });
      renderQuoteResult(r, packageId);
    } catch (err) {
      const detail = err.details && Array.isArray(err.details.errors)
        ? err.details.errors.map((x) => `第 ${x.index + 1} 项：${x.messages.join('；')}`).join('<br/>')
        : '';
      box.innerHTML = `<div class="errorline">${esc(errText(err))}${detail ? `<br/>${detail}` : ''}</div>`;
    }
  });
}

function quoteCoverageRows(r) {
  return r.coverage.map((st) => `
    <div class="stop-card ${st.nodes.every((n) => n.coveredBy) ? 'stop-ok' : 'stop-bad'}" style="margin-top:6px">
      <div class="section-title">第 ${st.position + 1} 站：${esc(st.name)}（${esc(st.medium)} / ${esc(st.region)}，${st.useFrom} → ${st.useTo}）</div>
      <table class="auth">
        <tr><th>节点</th><th>覆盖依据</th></tr>
        ${st.nodes.map((n) => `
          <tr>
            <td>${esc(n.title)} <span class="small-muted">#${n.materialId}${n.isRoot ? '（入展品）' : ''}</span></td>
            <td>${n.coveredBy.kind === 'existing'
              ? `<span class="pill pill-ok">现有授权 #${n.coveredBy.authorizationId}</span>`
              : `<span class="pill pill-warn">所选报价 #${n.coveredBy.quoteIndex}（成本 ${n.coveredBy.cost}）</span>`}</td>
          </tr>`).join('')}
      </table>
    </div>`).join('');
}

function renderQuoteResult(r, packageId) {
  const box = $('#quoteResult');
  if (!r.feasible) {
    box.innerHTML = `
      <div class="verdict fail">✗ 无解：总成本最低的报价组合不存在——以下站次仍有节点无法由现有授权或任何报价独自覆盖整段展期。
        <span class="sub">同站短授权 / 短报价不可拼接；预览未写入任何数据。</span></div>
      ${r.gaps.map((g) => `
        <div class="stop-card stop-bad" style="margin-top:8px">
          <h3>第 ${g.position + 1} 站：${esc(g.name)} <span class="pill pill-bad">缺授权 ${g.missingCount} 节点</span>
            <span class="small-muted">${esc(g.medium)} ｜ ${esc(g.region)} ｜ ${g.useFrom} → ${g.useTo}</span></h3>
          ${g.nodes.map((n) => `
            <div class="impact-node">
              <b>${esc(n.title)}</b> <span class="small-muted">#${n.materialId}${n.isRoot ? '（入展品）' : ''}</span>
              <div><span class="pill pill-bad">现有授权：${esc(n.existingReasonText)}</span></div>
              ${n.noQuoteForNode ? '<div class="small-muted">未录入任何指向该素材的报价。</div>' : `
                <div class="section-title">各报价为何不能独自覆盖本站</div>
                <table class="auth">
                  <tr><th>报价#</th><th>媒介/地区</th><th>有效期</th><th>成本</th><th>不满足项</th><th></th></tr>
                  ${n.quoteFailures.map((f) => `
                    <tr>
                      <td>${f.index}</td><td>${esc(f.media)} / ${esc(f.region)}</td>
                      <td>${f.validFrom} → ${f.validTo}</td><td>${f.cost}</td>
                      <td>${f.missText.length ? f.missText.map((t) => `<span class="pill pill-bad">${esc(t)}</span>`).join(' ') : '<span class="pill pill-ok">可覆盖</span>'}</td>
                      <td><button type="button" class="btn btn-small" data-act="use-gap" data-material="${n.materialId}"
                            data-media="${esc(g.medium)}" data-region="${esc(g.region)}" data-from="${g.useFrom}" data-to="${g.useTo}">按本站参数补一项</button></td>
                    </tr>`).join('')}
                </table>`}
              <div class="section-title">来源路径（共 ${n.paths.length} 条）</div>
              ${n.paths.map((p) => '<div class="path">' + p.map((x, i) =>
                (i ? ' → ' : '') + `<span class="${x.materialId === n.materialId ? 'fail-node' : ''}">${esc(x.title)}</span>`).join('') + '</div>').join('')}
            </div>`).join('')}
        </div>`).join('')}`;
    box.querySelectorAll('button[data-act="use-gap"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        addQuoteRow({
          materialId: Number(btn.dataset.material),
          media: btn.dataset.media,
          region: btn.dataset.region,
          validFrom: btn.dataset.from,
          validTo: btn.dataset.to,
          cost: null,
        });
        $('#quoteTable').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    return;
  }

  const selRows = r.selectedQuotes.length
    ? `<table class="auth">
         <tr><th>报价#</th><th>素材</th><th>媒介/地区</th><th>有效期</th><th>成本</th><th>覆盖（站 × 节点，共 ${r.selectedQuotes.reduce((a, q) => a + q.coverCount, 0)} 项需求）</th></tr>
         ${r.selectedQuotes.map((q) => `
           <tr>
             <td><b>${q.index}</b></td>
             <td>${esc(q.materialTitle)} <span class="small-muted">#${q.materialId}</span></td>
             <td>${esc(q.media)} / ${esc(q.region)}</td>
             <td>${q.validFrom} → ${q.validTo}</td>
             <td><b>${q.cost}</b></td>
             <td>${q.covers.map((c) => `<span class="chip">${r.multiStop ? `第${c.stopPosition + 1}站·` : ''}${esc(c.materialTitle)}</span>`).join('')}</td>
           </tr>`).join('')}
       </table>`
    : '<div class="small-muted">现有授权已覆盖全部需求，无需取得任何报价。</div>';

  const unused = r.unselectedQuotes.length
    ? `<div class="section-title">未选用的 ${r.unselectedQuotes.length} 项报价（更贵、冗余或并列时报价数 / 序号字典序不优）</div>
       <div>${r.unselectedQuotes.map((q) =>
         `<span class="chip">#${q.index} ${esc(q.materialTitle)}（${q.cost}，可覆盖 ${q.coverCount} 项需求）</span>`).join('')}</div>`
    : '';

  box.innerHTML = `
    <div class="verdict pass">✓ ${esc(r.message)}
      <span class="sub">总成本 <b>${r.totalCost}</b> ｜ 选中报价 ${r.quoteCountSelected} / ${r.stats.quoteCount} 项 ｜
      需求 ${r.stats.requirementCount} 项（现有授权覆盖 ${r.stats.existingCoveredCount} 项）｜
      来源链节点 ${r.stats.nodeCount} 个 · 站次 ${r.stats.stopCount} ｜ 依据版本 ${r.basisVersion}（未变化）</span></div>
    ${selRows}${unused}
    <div class="section-title">逐站逐节点覆盖依据</div>
    ${quoteCoverageRows(r)}`;
}

// ---- 替代素材方案：只读预览 + 事务确认（仅待发布包） ----
function subRowHtml(pkg, entry = {}) {
  const inPkg = state.materials.filter((m) => pkg.items.some((i) => i.id === m.id));
  const originOpts = ['<option value="">选择包内原素材…</option>']
    .concat(inPkg.map((m) =>
      `<option value="${m.id}" ${entry.materialId === m.id ? 'selected' : ''}>${esc(m.title)} #${m.id}</option>`))
    .join('');
  return `
    <div class="sub-row" style="border:1px solid #ddd;border-radius:6px;padding:6px;margin:6px 0">
      <div class="pkg-actions">
        原素材 <select class="s-origin" required>${originOpts}</select>
        <button type="button" class="btn btn-small btn-danger" data-act="del-sub">删除本组</button>
      </div>
      <div class="small-muted">候选（1～8 件，编号即填写顺序；原素材本身为编号 0＝不替换）：</div>
      <div class="s-cands pkg-actions" data-cands="${esc((entry.candidateIds || []).join(','))}">
        ${(entry.candidateIds || []).map((cid) => subCandChip(cid)).join('')}
        <select class="s-cand-pick">
          <option value="">添加候选素材…</option>
          ${state.materials.map((m) => `<option value="${m.id}">${esc(m.title)} #${m.id}</option>`).join('')}
        </select>
      </div>
    </div>`;
}

function subCandChip(cid) {
  const m = state.materials.find((x) => x.id === cid);
  return `<span class="chip" data-cid="${cid}">#${cid} ${esc(m ? m.title : '（不存在）')}
    <a href="#" data-act="del-cand" title="移除候选" style="margin-left:4px">✕</a></span>`;
}

function readSubEntries() {
  return $$('#subBox .sub-row').map((row) => ({
    materialId: Number(row.querySelector('.s-origin').value) || 0,
    candidateIds: (row.querySelector('.s-cands').dataset.cands || '').split(',').filter(Boolean).map(Number),
  })).filter((e) => e.materialId);
}

async function openSubstitutePreview(packageId) {
  let pkg;
  try {
    pkg = await api('GET', `/api/packages/${packageId}`);
  } catch (err) { toast(errText(err), true); return; }
  if (pkg.status !== 'draft') { toast('仅待发布包可编排替代素材方案', true); return; }

  const scopeLine = pkg.multiStop
    ? `多站巡展 <b>${pkg.stopCount}</b> 站，整包共享素材 ${pkg.itemCount} 项；方案须<b>每一站</b>整段覆盖合格`
    : `媒介 ${esc(pkg.medium)} ｜ 地区 ${esc(pkg.region)} ｜ 使用期 ${pkg.useFrom} → ${pkg.useTo} ｜ 素材 ${pkg.itemCount} 项`;

  $('#modalTitle').textContent = `替代素材方案：${pkg.name} #${pkg.id}`;
  $('#modalBody').innerHTML = `
    <div class="edit-banner"><span>${scopeLine}</span><span class="pill pill-neutral">待发布</span></div>
    <div class="small-muted">
      至多为 <b>6</b> 件包内原素材分别指定 <b>1～8</b> 件现有候选；未指定的素材保持不变。
      系统对每件原素材及其候选“恰选一件”的全部组合重算<b>完整来源链与逐站授权资格</b>，
      仅全站合格方案可选，依次按 <b>替换件数最少 → 最终去重清单升序 → 原清单顺序的选中编号</b> 取最优。预览只读。
    </div>
    <div id="subBox"></div>
    <div class="pkg-actions" style="margin-top:6px">
      <button type="button" class="btn btn-small" id="addSubBtn">＋ 为一件原素材指定候选</button>
      <button type="button" class="btn btn-primary btn-small" id="runSubBtn">枚举并预览最优方案（只读）</button>
    </div>
    <div id="subResult" class="schedule-result" style="margin-top:10px"></div>`;
  const foot = $('#modalFoot');
  foot.classList.remove('hidden');
  foot.innerHTML = `<button class="btn" id="subClose">关闭</button>`;
  $('#subClose').addEventListener('click', () => $('#modalBackdrop').classList.add('hidden'));
  $('#modalBackdrop').classList.remove('hidden');

  const box = $('#subBox');
  const addRow = (entry) => box.insertAdjacentHTML('beforeend', subRowHtml(pkg, entry));
  addRow();
  $('#addSubBtn').addEventListener('click', () => {
    if ($$('#subBox .sub-row').length >= 6) { toast('一次至多 6 组', true); return; }
    addRow();
  });
  box.addEventListener('click', (e) => {
    const delRow = e.target.closest('button[data-act="del-sub"]');
    if (delRow) { delRow.closest('.sub-row').remove(); return; }
    const delCand = e.target.closest('a[data-act="del-cand"]');
    if (delCand) {
      e.preventDefault();
      const chip = delCand.closest('.chip');
      const candsBox = chip.closest('.s-cands');
      const cid = Number(chip.dataset.cid);
      candsBox.dataset.cands = candsBox.dataset.cands.split(',').filter(Boolean)
        .map(Number).filter((x) => x !== cid).join(',');
      chip.remove();
    }
  });
  box.addEventListener('change', (e) => {
    const pick = e.target.closest('.s-cand-pick');
    if (!pick || !pick.value) return;
    const candsBox = pick.closest('.s-cands');
    const cid = Number(pick.value);
    const cands = candsBox.dataset.cands.split(',').filter(Boolean).map(Number);
    if (cands.includes(cid)) { toast('同组候选不能重复', true); pick.value = ''; return; }
    if (cands.length >= 8) { toast('每组至多 8 件候选', true); pick.value = ''; return; }
    cands.push(cid);
    candsBox.dataset.cands = cands.join(',');
    pick.parentElement.insertAdjacentHTML('afterbegin', subCandChip(cid));
    pick.value = '';
  });

  $('#runSubBtn').addEventListener('click', async () => {
    const out = $('#subResult');
    out.innerHTML = '<div class="small-muted">枚举全部方案并重算来源链/逐站核验中…</div>';
    try {
      const r = await api('POST', `/api/packages/${packageId}/substitutes/preview`, { substitutions: readSubEntries() });
      renderSubResult(r, packageId, pkg);
    } catch (err) {
      const detail = err.details && Array.isArray(err.details.errors)
        ? err.details.errors.map((x) => `· ${esc(x.message)}`).join('<br/>')
        : '';
      out.innerHTML = `<div class="errorline">${esc(errText(err))}${detail ? `<br/>${detail}` : ''}</div>`;
    }
  });
}

function subStopsHtml(r) {
  return r.stops.map((st) => `
    <div class="stop-card ${st.eligible ? 'stop-ok' : 'stop-bad'}" style="margin-top:6px">
      <div class="section-title">${r.multiStop ? `第 ${st.position + 1} 站：` : ''}${esc(st.name)}
        （${esc(st.medium)} / ${esc(st.region)}，${st.useFrom} → ${st.useTo}）
        ${st.eligible ? '<span class="pill pill-ok">合格</span>'
          : `<span class="pill pill-bad">失格 ${st.failingNodeCount} 节点</span>`}</div>
      ${st.eligible ? `<div class="small-muted">来源链节点 ${st.nodeCount} 个，均有一份未撤销授权独自覆盖整段展期。</div>` : `
        <table class="auth"><tr><th>节点</th><th>原因</th><th>来源路径</th></tr>
          ${st.failingNodes.map((n) => `
            <tr><td>${esc(n.title)} #${n.materialId}</td>
              <td>${n.reasonText.map((t) => esc(t)).join('；')}</td>
              <td class="small-muted">${(n.paths || []).map((p) => p.map((x) => `#${x.materialId}`).join(' → ')).join('；')}</td>
            </tr>`).join('')}
        </table>`}
    </div>`).join('');
}

function renderSubResult(r, packageId, pkg) {
  const box = $('#subResult');
  if (!r.feasible) {
    box.innerHTML = `
      <div class="verdict fail">✗ 无解：${esc(r.message || '不存在全站合格的替换方案')}</div>
      <div class="small-muted">以下为<b>当前清单（不替换）</b>的逐站缺口；包未被修改，未产生任何写入。</div>
      ${subStopsHtml(r)}
      <div class="small-muted">枚举方案数 ${r.consideredPlans} ｜ 依据版本 ${r.basisVersion}</div>`;
    return;
  }
  box.innerHTML = `
    <div class="verdict pass">✓ 最优方案：替换 <b>${r.replacementCount}</b> 件，全部 ${r.stopCount} 站合格
      <span class="sub">（共枚举 ${r.consideredPlans} 种恰选方案；依据版本 ${r.basisVersion}）</span></div>
    <table class="auth">
      <tr><th>原顺序</th><th>原素材</th><th>选中</th><th>编号</th><th>结果</th></tr>
      ${r.selection.map((s) => `
        <tr>
          <td>${s.position + 1}</td>
          <td>${esc(s.materialTitle)} #${s.materialId}</td>
          <td>${esc(s.selectedTitle)} #${s.selectedMaterialId}</td>
          <td>${s.choiceIndex}</td>
          <td>${s.replaced ? '<span class="pill pill-warn">替换</span>' : '<span class="pill pill-ok">保持</span>'}</td>
        </tr>`).join('')}
    </table>
    <div class="small-muted">替换后去重清单（升序）：[${r.finalMaterialIds.join(', ')}]
      ${r.removedByDedupe.length ? `；折叠重复位置：${r.removedByDedupe.map((d) => `第${d.position + 1}位 ${esc(d.title)}`).join('、')}` : ''}</div>
    <div class="section-title">逐站核验结果（按替换后去重清单重算完整来源链）</div>
    ${subStopsHtml(r)}
    <div class="pkg-actions" style="margin-top:8px">
      <button type="button" class="btn btn-primary" id="applySubBtn">确认并应用所选清单（同一事务）</button>
      <span class="small-muted">确认时再次核对包仍为待发布、依据版本/清单/行程指纹未变并重算；任一不符整体拒绝。</span>
    </div>`;
  $('#applySubBtn').addEventListener('click', async () => {
    if (!confirm(`确认应用该替代方案（替换 ${r.replacementCount} 件）？`)) return;
    try {
      const out = await api('POST', `/api/packages/${packageId}/substitutes/apply`, { applyToken: r.applyToken });
      $('#modalBackdrop').classList.add('hidden');
      toast(out.message);
      await loadState();
    } catch (err) {
      $('#subResult').insertAdjacentHTML('beforeend',
        `<div class="errorline" style="margin-top:8px">确认被拒绝：${esc(errText(err))}（未做任何修改，请重新预览）</div>`);
      await loadState();
    }
  });
}

// ---- 变更影响预演 + 确认提交 ----
const OP_LABEL = {
  'authorization.create': '新增授权',
  'authorization.update': '修改授权',
  'authorization.revoke': '撤销授权',
  'authorization.delete': '删除授权',
  'source.create': '新增来源关系',
  'source.delete': '删除来源关系',
};

function impactNodesHtml(n) {
  return `
    <div class="impact-node">
      <b>${esc(n.title)}</b> <span class="small-muted">#${n.materialId}${n.isRoot ? '（入展品）' : ''}</span>
      <div>${n.reasonText.map((t) => `<span class="pill pill-bad">${esc(t)}</span>`).join(' ')}</div>
      <div class="section-title">不合格来源路径（共 ${n.paths.length} 条）</div>
      ${n.paths.map((p) => '<div class="path">' + p.map((x, i) =>
        (i ? ' → ' : '') + `<span class="${x.materialId === n.materialId ? 'fail-node' : ''}">${esc(x.title)}</span>`).join('') + '</div>').join('')}
    </div>`;
}

function impactListHtml(impact) {
  if (!impact.length) {
    return '<div class="verdict pass" style="margin-top:8px">✓ 该变更不会使任何已发布展览包由合格转为不合格。</div>';
  }
  return `<div class="verdict fail" style="margin-top:8px">
      ✗ 以下 ${impact.length} 个已发布展览包将由合格转为不合格（确认后标记为需复核并追加不可变复核快照，不自动恢复）
    </div>` + impact.map((p) => `
    <div class="impact-pkg">
      <h4>${esc(p.packageName)} <span class="small-muted">#${p.packageId}</span>
        ${p.multiStop ? '<span class="pill pill-bad">多站巡展</span>' : ''}
        <span class="pill pill-ok">当前：已发布</span> → <span class="pill pill-bad">确认后：需复核</span></h4>
      ${p.multiStop
        ? `<div class="small-muted">多站巡展共 ${p.stopCount} 站，以下 ${p.failingStops.length} 站将失格（不同站可用不同授权，同站不可拼接）：</div>
           ${p.failingStops.map((st) => `
             <div class="stop-card stop-bad" style="margin-top:6px">
               <div class="section-title">第 ${st.position + 1} 站：${esc(st.name)}（${esc(st.medium)} / ${esc(st.region)}，${st.useFrom} → ${st.useTo}）— ${st.failingNodes.length} 个问题节点</div>
               ${st.failingNodes.map(impactNodesHtml).join('')}
             </div>`).join('')}`
        : `<div class="small-muted">媒介：${esc(p.medium)} ｜ 地区：${esc(p.region)} ｜ 使用期：${p.useFrom} → ${p.useTo}</div>
           <div class="section-title">问题节点（${p.failingNodes.length} 个）及原因</div>
           ${p.failingNodes.map(impactNodesHtml).join('')}`}
    </div>`).join('');
}

// 发起预演并打开弹层（sourceForm 为发起预演的表单，成功提交后用于复位）
async function openChangePreview(change, staleNote, sourceForm) {
  let preview;
  try {
    preview = await api('POST', '/api/changes/preview', change);
  } catch (err) {
    if (err.status === 409 && err.details && err.details.cyclePath) {
      const cycle = err.details.cycle || err.details.cyclePath;
      const names = cycle.map((id) => {
        const m = state.materials.find((x) => x.id === id);
        return m ? m.title : `#${id}`;
      });
      toast(`${err.message} 闭环路径：${names.join(' → ')}`, true);
    } else {
      toast('预演被拒绝：' + errText(err), true);
    }
    return;
  }

  $('#modalTitle').textContent = `影响预演：${OP_LABEL[preview.operation] || preview.operation}（依据版本 ${preview.basisVersion}）`;
  $('#modalBody').innerHTML = `
    ${staleNote ? `<div class="stale-banner">${esc(staleNote)}</div>` : ''}
    <div class="edit-banner">
      <span><b>拟执行操作：</b>${esc(preview.summary)}</span>
      <span class="small-muted">依据版本：<b>${preview.basisVersion}</b></span>
    </div>
    <div class="small-muted">预演只读取当前数据，未改动授权、来源关系、包状态或任何快照；请在确认前不要由他人修改授权或来源关系。</div>
    ${impactListHtml(preview.impact)}`;

  const foot = $('#modalFoot');
  foot.classList.remove('hidden');
  foot.innerHTML = `
    <button class="btn" id="previewCancel">取消（不做任何改动）</button>
    <button class="btn" id="previewReplay">重新预演</button>
    <button class="btn btn-primary" id="previewConfirm">确认提交同一操作及预演结果</button>`;
  $('#previewCancel').addEventListener('click', () => $('#modalBackdrop').classList.add('hidden'));
  $('#previewReplay').addEventListener('click', () => openChangePreview(change, undefined, sourceForm));
  $('#previewConfirm').addEventListener('click', () => commitPreviewedChange(change, preview, sourceForm));
  $('#modalBackdrop').classList.remove('hidden');
}

// 确认提交同一操作 + 预演结果
async function commitPreviewedChange(change, preview, sourceForm) {
  const btn = $('#previewConfirm');
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/changes/commit', {
      ...change,
      basisVersion: preview.basisVersion,
      impact: preview.impact,
    });
    $('#modalBackdrop').classList.add('hidden');
    await loadState();
    toast(`变更已执行（依据版本 ${r.basisVersion}）：${r.impact.length ? `${r.impact.length} 个已发布包标记为需复核` : '无已发布包受影响'}`);
    // 若预演由授权表单发起，提交成功后复位该表单
    if (sourceForm && sourceForm.matches('form[data-act="add-auth"]')) resetAuthForm(sourceForm);
  } catch (err) {
    btn.disabled = false;
    if (err.status === 409 && err.details && (err.details.code === 'STALE_BASIS' || err.details.code === 'IMPACT_MISMATCH')) {
      // 依据过期或影响清单漂移：关闭旧弹层，按当前数据重新预演并展示过期提示
      let note = err.message;
      if (err.details.code === 'IMPACT_MISMATCH') {
        note += ' 已按当前数据重新预演，下方为最新影响清单。';
      }
      await loadState();
      openChangePreview(change, note, sourceForm);
    } else {
      toast('提交被拒绝：' + errText(err), true);
    }
  }
}

// ---- 联展批次发布（2～20 个待发布包：只读预览 + 凭据确认、单事务整批发布） ----
const BATCH_MIN = 2;
const BATCH_MAX = 20;

function batchScopeLine(p) {
  return p.multiStop
    ? `多站巡展 ${p.stopCount} 站 · 素材 ${p.itemCount} 项`
    : `${p.medium} / ${p.region} · ${p.useFrom} → ${p.useTo} · 素材 ${p.itemCount} 项`;
}

// 逐站卡片（单站归一化为 1 站）：合格给概要，失格列问题节点、原因与来源路径
function batchStopsHtml(stops) {
  return (stops || []).map((st) => `
    <div class="stop-card ${st.eligible ? 'stop-ok' : 'stop-bad'}" style="margin-top:6px">
      <div class="section-title">第 ${st.position + 1} 站：${esc(st.name)}
        （${esc(st.medium)} / ${esc(st.region)}，${st.useFrom} → ${st.useTo}）
        ${st.eligible ? '<span class="pill pill-ok">合格</span>' : `<span class="pill pill-bad">失格 ${st.failingNodeCount} 节点</span>`}</div>
      ${(st.errors || []).map((m) => `<div class="errorline">${esc(m)}</div>`).join('')}
      ${st.eligible
        ? `<div class="small-muted">来源链节点 ${st.nodeCount} 个，均有一份未撤销授权独自覆盖该站整段展期。</div>`
        : (st.failingNodes || []).map(failingNodeCard).join('')}
    </div>`).join('');
}

function renderBatchPreview(box, r) {
  const head = r.eligible
    ? `<div class="verdict pass">✓ 批次预览通过：${r.packageCount} 个包逐包（逐站）重算全部合格，可整批发布。
         <span class="sub">共同核验依据版本 <b>${r.basisVersion}</b> ｜ 合格 ${r.eligibleCount}/${r.packageCount} ｜ 预览只读，未写入任何数据、依据版本不变</span></div>`
    : `<div class="verdict fail">✗ 批次预览不通过：${r.failingCount} 个包失格，已按包列出缺口并禁止确认。
         <span class="sub">共同核验依据版本 ${r.basisVersion} ｜ 合格 ${r.eligibleCount}/${r.packageCount} ｜ 预览不写入任何数据；请修正失格包后重新预览</span></div>`;

  const globalErrs = r.packages.flatMap((p) =>
    (p.globalErrors || []).map((m) => `<div class="errorline">包 #${p.packageId}「${esc(p.packageName)}」：${esc(m)}</div>`));

  box.innerHTML = head + globalErrs + r.packages.map((p) => `
    <div class="impact-pkg" style="border-color:${p.eligible ? '#cfe3d6' : '#f0c9c5'}">
      <h4>${esc(p.packageName)} <span class="small-muted">#${p.packageId}</span>
        ${p.multiStop ? '<span class="pill pill-neutral">多站巡展</span>' : '<span class="pill pill-neutral">单站</span>'}
        ${p.eligible ? '<span class="pill pill-ok">逐站合格</span>' : '<span class="pill pill-bad">失格</span>'}
      </h4>
      <div class="small-muted">${esc(batchScopeLine(p))} ｜ 清单指纹 <code>${p.listFingerprint.slice(0, 12)}</code> ｜ 行程指纹 <code>${p.itineraryFingerprint.slice(0, 12)}</code></div>
      ${batchStopsHtml(p.stops)}
    </div>`).join('');

  if (r.eligible && r.confirmToken) {
    box.insertAdjacentHTML('beforeend', `
      <div class="pkg-actions" style="margin-top:10px">
        <button type="button" class="btn btn-primary" id="batchConfirmBtn">确认整批发布（${r.packageCount} 个包，同一事务）</button>
        <span class="small-muted">服务端将核对包集合、待发布状态、共同依据版本与各包清单/行程指纹，并按当前授权与来源关系重算全部包；任一包失格或漂移都整批拒绝，不产生快照、凭证或部分发布。</span>
      </div>`);
    $('#batchConfirmBtn').addEventListener('click', () => doBatchConfirm(r));
  }
}

async function doBatchConfirm(preview) {
  if (!confirm(`确认把联展批次的 ${preview.packageCount} 个包一起发布？\n服务端将在同一事务内重算全部包并封存不可变快照与签名凭证；任一包失败则整批拒绝。`)) return;
  const btn = $('#batchConfirmBtn');
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/batches/confirm', { confirmToken: preview.confirmToken });
    $('#modalBackdrop').classList.add('hidden');
    await loadState();
    toast(`联展批次发布成功：${r.packageCount} 个包已一起转为已发布（快照 ${r.packages.map((p) => '#' + p.snapshotId).join('、')}）`);
  } catch (err) {
    btn.disabled = false;
    if (err.status === 409 || err.status === 422) {
      const box = $('#batchResult');
      box.insertAdjacentHTML('beforeend',
        `<div class="errorline" style="margin-top:10px">整批被拒绝：${esc(errText(err))}（未产生任何快照、凭证或部分发布；请重新预览）</div>`);
      await loadState();
      // 刷新弹层内包的可选状态（可能已被他人发布/修改）
      syncBatchPickState();
    } else {
      toast('整批发布失败：' + errText(err), true);
    }
  }
}

function syncBatchPickState() {
  $$('#batchPick input[type=checkbox]').forEach((cb) => {
    const id = Number(cb.value);
    const pkg = state.packages.find((x) => x.id === id);
    const label = cb.closest('label');
    if (!pkg) {
      cb.disabled = true;
      cb.checked = false;
      if (label) label.classList.add('pick-disabled');
      return;
    }
    const selectable = pkg.status === 'draft';
    cb.disabled = !selectable;
    if (!selectable) cb.checked = false;
    if (label) label.classList.toggle('pick-disabled', !selectable);
  });
  updateBatchSelection();
}

function updateBatchSelection() {
  const n = $$('#batchPick input:checked').length;
  const info = $('#batchPickInfo');
  if (info) {
    info.textContent = `已选 ${n} 个（需 ${BATCH_MIN}～${BATCH_MAX} 个待发布包）`;
    info.style.color = (n >= BATCH_MIN && n <= BATCH_MAX) ? '#14663a' : '#b4590f';
  }
  return n;
}

function openBatchModal() {
  const drafts = state.packages.filter((p) => p.status === 'draft');
  $('#modalTitle').textContent = '组建联展批次（2～20 个待发布包）';
  $('#modalBody').innerHTML = `
    <div class="small-muted" style="margin-bottom:8px">
      仅可勾选<b>待发布</b>包（已发布 / 需复核包不可选）。选定后点「逐包预览核验」：
      预览只读，按包给出单站或多站逐站结果、共同依据版本与各包清单/行程指纹；有包失格即禁止确认。
    </div>
    <div id="batchPick" class="pick">
      ${drafts.length
        ? drafts.map((p) => `
          <label title="${esc(batchScopeLine(p))}">
            <input type="checkbox" value="${p.id}" />
            ${esc(p.name)} <span class="small-muted">#${p.id}${p.multiStop ? ` · 多站${p.stopCount}站` : ''}</span>
          </label>`).join('')
        : '<span class="small-muted">当前没有待发布包，请先在上方新建并保存待发布包。</span>'}
    </div>
    <div class="pkg-actions" style="margin-top:8px">
      <button type="button" class="btn btn-primary btn-small" id="batchPreviewBtn">逐包预览核验（只读）</button>
      <span id="batchPickInfo" class="small-muted"></span>
    </div>
    <div id="batchResult" class="schedule-result" style="margin-top:10px"></div>`;
  const foot = $('#modalFoot');
  foot.classList.remove('hidden');
  foot.innerHTML = `<button class="btn" id="batchClose">关闭</button>`;
  $('#batchClose').addEventListener('click', () => $('#modalBackdrop').classList.add('hidden'));
  $('#modalBackdrop').classList.remove('hidden');

  $('#batchPick').addEventListener('change', updateBatchSelection);
  syncBatchPickState();

  $('#batchPreviewBtn').addEventListener('click', async () => {
    const ids = $$('#batchPick input:checked').map((cb) => Number(cb.value));
    const box = $('#batchResult');
    if (ids.length < BATCH_MIN || ids.length > BATCH_MAX) {
      box.innerHTML = `<div class="errorline">联展批次需选取 ${BATCH_MIN}～${BATCH_MAX} 个待发布包（当前 ${ids.length} 个）。</div>`;
      return;
    }
    box.innerHTML = '<div class="small-muted">按当前授权与来源关系逐包（逐站）重算中…</div>';
    try {
      const r = await api('POST', '/api/batches/preview', { packageIds: ids });
      renderBatchPreview(box, r);
    } catch (err) {
      box.innerHTML = `<div class="errorline">${esc(errText(err))}</div>`;
      if (err.status === 404 || err.status === 409) {
        await loadState();
        syncBatchPickState();
      }
    }
  });
}

$('#batchFormBtn').addEventListener('click', openBatchModal);

loadState().catch((e) => toast('初始化失败：' + e.message, true));
