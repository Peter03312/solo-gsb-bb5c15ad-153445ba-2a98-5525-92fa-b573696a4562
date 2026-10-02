'use strict';

// 初始化演示数据：仅在数据库为空时执行。
const { get, tx, nowIso } = require('./db');
const { revalidatePublished } = require('./verify');

const db = get();

function seed() {
  const count = db.prepare('SELECT COUNT(*) FROM materials').pluck().get();
  if (count > 0) {
    console.log('数据库已有数据，跳过演示数据初始化。');
    return;
  }

  tx(() => {
    const insMat = db.prepare('INSERT INTO materials(title, kind, note, created_at) VALUES (?,?,?,?)');
    const insLink = db.prepare('INSERT INTO source_links(material_id, source_material_id, relation, created_at) VALUES (?,?,?,?)');
    const insAuth = db.prepare(
      `INSERT INTO authorizations(material_id, media, region, valid_from, valid_to, revoked, licensor, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );

    // 素材：成片 -> 配乐 -> 背景影像 -> 字体
    const film = insMat.run('展馆宣传片《城脉》成片', 'video', '4K 成片', nowIso()).lastInsertRowid;
    const music = insMat.run('原创配乐《律动》', 'audio', '委约创作', nowIso()).lastInsertRowid;
    const footage = insMat.run('城市航拍素材', 'video', '第三方图库', nowIso()).lastInsertRowid;
    const font = insMat.run('标题字体“展宋”', 'font', '商用字体授权', nowIso()).lastInsertRowid;
    const photo = insMat.run('历史照片（馆藏扫描）', 'image', '尚未取得授权，用于演示不合格节点', nowIso()).lastInsertRowid;

    insLink.run(film, music, '配乐', nowIso());
    insLink.run(film, footage, '背景影像', nowIso());
    insLink.run(footage, photo, '画面引用', nowIso());
    insLink.run(film, font, '片头字幕', nowIso());

    insAuth.run(film, '*', '中国大陆', '2026-01-01', '2028-12-31', 0, '本馆摄制组', '全媒介', nowIso(), nowIso());
    insAuth.run(music, '*', '*', '2026-01-01', '2027-12-31', 0, '作曲家李某', '', nowIso(), nowIso());
    insAuth.run(footage, '屏幕放映', '中国大陆', '2025-01-01', '2027-06-30', 0, '航拍图库', '', nowIso(), nowIso());
    insAuth.run(footage, '屏幕放映', '中国大陆', '2024-01-01', '2024-12-31', 1, '航拍图库', '已撤销的旧授权', nowIso(), nowIso());
    insAuth.run(font, '*', '*', '2026-03-01', '2026-05-31', 0, '字库公司', '仅短期，用于演示日期不覆盖', nowIso(), nowIso());
    // 照片授权仅覆盖春季常设展期；秋季临时展（10–11 月）将因授权过期不合格
    insAuth.run(photo, '屏幕放映', '中国大陆', '2026-03-01', '2026-05-31', 0, '馆藏/家属授权', '仅春季展期', nowIso(), nowIso());

    // 一个已发布的合规包：春季展期内，film 全链 5 个节点均有覆盖授权
    const pkg1 = db
      .prepare("INSERT INTO packages(name, medium, region, use_from, use_to, status, published_at, created_at, updated_at) VALUES (?,?,?,?,?,'published',?,?,?)")
      .run('常设展「城市之光」屏展包', '屏幕放映', '中国大陆', '2026-03-01', '2026-05-31', nowIso(), nowIso(), nowIso())
      .lastInsertRowid;
    [film].forEach((mid, i) =>
      db.prepare('INSERT INTO package_items(package_id, material_id, position) VALUES (?,?,?)').run(pkg1, mid, i));
    const r1 = require('./verify').verifyPackage(db, {
      materialIds: [film], medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-05-31',
    });
    if (!r1.eligible) {
      throw new Error('演示数据自检失败：常设展包核验不合格：' + JSON.stringify(r1.failingNodes.map((n) => ({ id: n.materialId, reasons: n.reasons }))));
    }
    db.prepare(
      `INSERT INTO verification_snapshots(package_id, kind, basis_version, eligible, payload, created_at)
       VALUES (?,?,?,?,?,?)`
    ).run(pkg1, 'publish', r1.basisVersion, 1, JSON.stringify(r1), nowIso());

    // 一个待发布但当前不合格的包：秋季展期，照片与字体授权均不覆盖
    const pkg2 = db
      .prepare("INSERT INTO packages(name, medium, region, use_from, use_to, status, created_at, updated_at) VALUES (?,?,?,?,?,'draft',?,?)")
      .run('临时展屏展包（照片/字体授权过期）', '屏幕放映', '中国大陆', '2026-10-01', '2026-11-30', nowIso(), nowIso())
      .lastInsertRowid;
    db.prepare('INSERT INTO package_items(package_id, material_id, position) VALUES (?,?,?)').run(pkg2, film, 0);
  });

  console.log('演示数据已写入。');
}

seed();
