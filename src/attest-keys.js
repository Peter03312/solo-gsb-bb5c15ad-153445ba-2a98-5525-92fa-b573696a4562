'use strict';

// 本机持久化签名密钥环（Ed25519，PEM 文件）。
// - 首次需要签名时惰性生成当前密钥（不改变现有启动行为）；
// - 轮换时把旧密钥的公钥永久追加进公钥归档，旧凭证可继续验证；
// - 私钥文件 0600、目录 0700；公钥归档可导出给离线审计环境。

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 密钥目录：
//   1) ATTEST_KEY_DIR 显式指定；
//   2) 否则若设置了 DB_PATH，落在数据库同级 attestation-keys/（容器内即 /data 卷，
//      与数据库同一持久卷，无需额外挂载即可“持久化”，保持现有启动方式可用）；
//   3) 否则使用用户主目录 ~/.exhibit-attestation。
function defaultKeyDir() {
  if (process.env.ATTEST_KEY_DIR) return process.env.ATTEST_KEY_DIR;
  if (process.env.DB_PATH) return path.join(path.dirname(process.env.DB_PATH), 'attestation-keys');
  return path.join(os.homedir() || process.cwd(), '.exhibit-attestation');
}
const KEY_DIR = defaultKeyDir();
const PRIVATE_KEY_PEM = path.join(KEY_DIR, 'attestation-ed25519-current.pem');
const PUBLIC_KEY_PEM = path.join(KEY_DIR, 'attestation-ed25519-current.pub.pem');
const PUBLIC_KEY_ARCHIVE = path.join(KEY_DIR, 'attestation-pubkeys.json');

const ED25519_PEM_HEADER = '-----BEGIN PUBLIC KEY-----';

function ensureDir() {
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(KEY_DIR, 0o700); } catch { /* 某些卷不支持 chmod，忽略 */ }
}

function readArchive() {
  if (!fs.existsSync(PUBLIC_KEY_ARCHIVE)) return { keys: [] };
  const parsed = JSON.parse(fs.readFileSync(PUBLIC_KEY_ARCHIVE, 'utf8'));
  if (!parsed || !Array.isArray(parsed.keys)) throw new Error('公钥归档格式损坏');
  return parsed;
}

function writeArchive(archive) {
  ensureDir();
  const tmp = PUBLIC_KEY_ARCHIVE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(archive, null, 2) + '\n', { mode: 0o644 });
  fs.renameSync(tmp, PUBLIC_KEY_ARCHIVE);
}

function keyIdFromPublic(publicPem) {
  const der = crypto.createPublicKey(publicPem).export({ format: 'der', type: 'spki' });
  // 取 SPKI DER 的 SHA-256 前 16 字节作短指纹，稳定且与具体序列化无关
  return 'ed25519-' + crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
}

function keyInfo(publicPem, extra = {}) {
  return {
    kid: keyIdFromPublic(publicPem),
    algorithm: 'Ed25519',
    publicKeyPem: publicPem,
    ...extra,
  };
}

function listPublicKeys() {
  const seen = new Map();
  for (const k of readArchive().keys) seen.set(k.kid, k);
  if (fs.existsSync(PUBLIC_KEY_PEM)) {
    const pem = fs.readFileSync(PUBLIC_KEY_PEM, 'utf8');
    seen.set(keyIdFromPublic(pem), keyInfo(pem, seen.get(keyIdFromPublic(pem)) || {}));
  }
  return [...seen.values()];
}

// 当前私钥；不存在则生成第一把并登记公钥
function currentKey() {
  if (!fs.existsSync(PRIVATE_KEY_PEM)) return rotateKey('initial');
  const privatePem = fs.readFileSync(PRIVATE_KEY_PEM, 'utf8');
  const priv = crypto.createPrivateKey(privatePem);
  const pubPem = crypto.createPublicKey(priv).export({ format: 'pem', type: 'spki' });
  return { privateKey: priv, ...keyInfo(pubPem) };
}

// 生成新密钥：旧公钥（连同其停用时间）进入归档；当前密钥成为新密钥
function rotateKey(reason = 'rotated') {
  ensureDir();
  const archive = readArchive();
  const have = new Set(archive.keys.map((k) => k.kid));
  if (fs.existsSync(PUBLIC_KEY_PEM)) {
    const oldPem = fs.readFileSync(PUBLIC_KEY_PEM, 'utf8');
    const oldKid = keyIdFromPublic(oldPem);
    if (!have.has(oldKid)) {
      archive.keys.push(keyInfo(oldPem, { activatedAt: null, retiredAt: new Date().toISOString() }));
    }
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { format: 'pem', type: 'spki' },
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  });
  const activatedAt = new Date().toISOString();
  const kid = keyIdFromPublic(publicKey);

  const privTmp = PRIVATE_KEY_PEM + '.tmp';
  fs.writeFileSync(privTmp, privateKey, { mode: 0o600 });
  fs.renameSync(privTmp, PRIVATE_KEY_PEM);
  try { fs.chmodSync(PRIVATE_KEY_PEM, 0o600); } catch { /* 忽略 */ }
  fs.writeFileSync(PUBLIC_KEY_PEM, publicKey, { mode: 0o644 });

  if (!have.has(kid)) archive.keys.push(keyInfo(publicKey, { activatedAt }));
  writeArchive(archive);

  return { privateKey: crypto.createPrivateKey(privateKey), kid, algorithm: 'Ed25519', publicKeyPem: publicKey };
}

// 确定性 JSON：键按字典序排序、数组保序——发布端与离线端必须得到同一字节串
function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

function sign(message) {
  const key = currentKey();
  const data = Buffer.from(message, 'utf8');
  const sigBuf = crypto.sign(null, data, key.privateKey);
  return { kid: key.kid, algorithm: 'Ed25519', signature: sigBuf.toString('base64') };
}

function parsePemOrKidKey(value) {
  if (typeof value === 'string' && value.includes(ED25519_PEM_HEADER)) {
    return crypto.createPublicKey(value.trim());
  }
  return null;
}

// 用给定公钥集合（PEM 字符串 / KeyObject / 归档条目）校验签名
function verify(message, signatureB64, keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  const data = Buffer.from(message, 'utf8');
  const sig = Buffer.from(signatureB64, 'base64');
  for (const entry of list) {
    let keyObject = null;
    if (entry && typeof entry === 'object' && entry.publicKeyPem) keyObject = parsePemOrKidKey(entry.publicKeyPem);
    else if (typeof entry === 'string') keyObject = parsePemOrKidKey(entry);
    else if (entry && entry.asymmetricKeyType === 'ed25519') keyObject = entry;
    if (!keyObject) continue;
    try {
      if (crypto.verify(null, data, keyObject, sig)) return true;
    } catch { /* 该公钥不适用，继续试下一把 */ }
  }
  return false;
}

module.exports = {
  KEY_DIR,
  PRIVATE_KEY_PEM,
  PUBLIC_KEY_PEM,
  PUBLIC_KEY_ARCHIVE,
  canonicalJSON,
  currentKey,
  rotateKey,
  listPublicKeys,
  keyIdFromPublic,
  sign,
  verify,
};
