'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;

function open() {
  if (db) return db;
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function get() {
  return open();
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO meta(key, value) VALUES ('basis_version', '0');

    -- 素材（数字展品及其来源节点）
    CREATE TABLE IF NOT EXISTS materials (
      id         INTEGER PRIMARY KEY,
      title      TEXT NOT NULL,
      kind       TEXT,
      note       TEXT,
      created_at TEXT NOT NULL
    );

    -- 来源关系：material_id 使用了 source_material_id（边 material -> source）
    CREATE TABLE IF NOT EXISTS source_links (
      id                 INTEGER PRIMARY KEY,
      material_id        INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      source_material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      relation           TEXT NOT NULL DEFAULT '使用',
      created_at         TEXT NOT NULL,
      UNIQUE(material_id, source_material_id),
      CHECK(material_id <> source_material_id)
    );

    -- 授权：媒介 / 地区 / 有效期 / 撤销状态
    CREATE TABLE IF NOT EXISTS authorizations (
      id         INTEGER PRIMARY KEY,
      material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      media      TEXT NOT NULL,
      region     TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to   TEXT NOT NULL,
      revoked    INTEGER NOT NULL DEFAULT 0,
      licensor   TEXT,
      note       TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 展览包
    CREATE TABLE IF NOT EXISTS packages (
      id           INTEGER PRIMARY KEY,
      name         TEXT NOT NULL,
      medium       TEXT,
      region       TEXT,
      use_from     TEXT,
      use_to       TEXT,
      status       TEXT NOT NULL DEFAULT 'draft',  -- draft | published | needs_review
      published_at TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    -- 包内素材清单（整包共享；发布后冻结）
    CREATE TABLE IF NOT EXISTS package_items (
      package_id  INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      material_id INTEGER NOT NULL REFERENCES materials(id),
      position    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(package_id, material_id)
    );

    -- 多站巡展行程：仅多站包有行（≥2 行），单站包沿用 packages 顶层列、无行。
    -- 站按 position 顺序展出；站间不得重叠（首尾日均占用，由应用层校验）。
    CREATE TABLE IF NOT EXISTS package_stops (
      id         INTEGER PRIMARY KEY,
      package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      position   INTEGER NOT NULL,
      name       TEXT NOT NULL,
      medium     TEXT NOT NULL,
      region     TEXT NOT NULL,
      use_from   TEXT NOT NULL,
      use_to     TEXT NOT NULL,
      UNIQUE(package_id, position)
    );

    -- 行程冻结：非待发布包（已发布/需复核）的站次不可改、不可删
    CREATE TRIGGER IF NOT EXISTS trg_stop_freeze_upd BEFORE UPDATE ON package_stops
    BEGIN
      SELECT RAISE(ABORT, 'itinerary is frozen: package is not a draft')
      WHERE EXISTS (SELECT 1 FROM packages WHERE id = NEW.package_id AND status <> 'draft');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_stop_freeze_del BEFORE DELETE ON package_stops
    BEGIN
      SELECT RAISE(ABORT, 'itinerary is frozen: package is not a draft')
      WHERE EXISTS (SELECT 1 FROM packages WHERE id = OLD.package_id AND status <> 'draft');
    END;

    -- 不可变核验快照：发布快照 + 自动复核快照 + 手动复核快照，只追加
    CREATE TABLE IF NOT EXISTS verification_snapshots (
      id            INTEGER PRIMARY KEY,
      package_id    INTEGER NOT NULL REFERENCES packages(id),
      kind          TEXT NOT NULL,             -- publish | review | recheck
      basis_version INTEGER NOT NULL,
      eligible      INTEGER NOT NULL,
      payload       TEXT NOT NULL,             -- 完整核验结果 JSON
      created_at    TEXT NOT NULL
    );

    -- 发布凭证：与发布快照同一事务封存的可导出签名凭证，只追加、不可变
    CREATE TABLE IF NOT EXISTS publish_attestations (
      id                  INTEGER PRIMARY KEY,
      package_id          INTEGER NOT NULL REFERENCES packages(id),
      verification_snapshot_id INTEGER NOT NULL REFERENCES verification_snapshots(id),
      signer_kid          TEXT NOT NULL,             -- 签发所用持久化密钥 id
      seal_context        TEXT NOT NULL,             -- publish | reissue-from-snapshot
      envelope            TEXT NOT NULL,             -- 完整凭证 JSON（自包含，可导出离线校验）
      created_at          TEXT NOT NULL,
      UNIQUE(verification_snapshot_id)
    );

    -- 任何对授权或来源关系的增删改都使核验依据版本号 +1
    CREATE TRIGGER IF NOT EXISTS trg_basis_authz_ins AFTER INSERT ON authorizations
    BEGIN UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'basis_version'; END;
    CREATE TRIGGER IF NOT EXISTS trg_basis_authz_upd AFTER UPDATE ON authorizations
    BEGIN UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'basis_version'; END;
    CREATE TRIGGER IF NOT EXISTS trg_basis_authz_del AFTER DELETE ON authorizations
    BEGIN UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'basis_version'; END;
    CREATE TRIGGER IF NOT EXISTS trg_basis_link_ins AFTER INSERT ON source_links
    BEGIN UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'basis_version'; END;
    CREATE TRIGGER IF NOT EXISTS trg_basis_link_upd AFTER UPDATE ON source_links
    BEGIN UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'basis_version'; END;
    CREATE TRIGGER IF NOT EXISTS trg_basis_link_del AFTER DELETE ON source_links
    BEGIN UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'basis_version'; END;

    -- 快照不可变、不可删
    CREATE TRIGGER IF NOT EXISTS trg_snapshot_no_update BEFORE UPDATE ON verification_snapshots
    BEGIN SELECT RAISE(ABORT, 'verification snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_snapshot_no_delete BEFORE DELETE ON verification_snapshots
    BEGIN SELECT RAISE(ABORT, 'verification snapshots are immutable'); END;

    -- 发布凭证同样不可改、不可删
    CREATE TRIGGER IF NOT EXISTS trg_attestation_no_update BEFORE UPDATE ON publish_attestations
    BEGIN SELECT RAISE(ABORT, 'publish attestations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_attestation_no_delete BEFORE DELETE ON publish_attestations
    BEGIN SELECT RAISE(ABORT, 'publish attestations are immutable'); END;
  `);
}

function tx(fn) {
  return db.transaction(fn)();
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = { get, open, tx, nowIso };
