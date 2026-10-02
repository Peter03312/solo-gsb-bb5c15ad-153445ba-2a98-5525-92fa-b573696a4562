#!/usr/bin/env node
'use strict';

// 本机发布签名密钥管理 CLI（与 HTTP API 操作同一密钥环目录）。
//
// 用法：
//   node scripts/attestation-keys.js init       # 首次生成当前签名密钥（不生成也会在首次发布时惰性生成）
//   node scripts/attestation-keys.js public     # 打印当前公钥 PEM（交给审计方）
//   node scripts/attestation-keys.js list       # 列出公钥归档（含轮换前旧公钥，JSON）
//   node scripts/attestation-keys.js export-pub <文件>   # 把全部受信公钥（当前+历史）导出为一个 PEM 文件
//   node scripts/attestation-keys.js rotate [原因]       # 轮换：旧公钥自动保留，供旧凭证验证
//
// 密钥目录默认 ~/.exhibit-attestation，可用环境变量 ATTEST_KEY_DIR 覆盖
// （容器中建议挂载/指定到持久卷，与 DB_PATH 一同备份）。

const fs = require('fs');
const keyring = require('../src/attest-keys');

function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'init': {
      const k = keyring.currentKey();
      console.log(`当前签名密钥就绪：kid=${k.kid}，目录=${keyring.KEY_DIR}`);
      break;
    }
    case 'public': {
      const k = keyring.currentKey();
      process.stdout.write(k.publicKeyPem);
      break;
    }
    case 'list': {
      console.log(JSON.stringify({ keyDir: keyring.KEY_DIR, keys: keyring.listPublicKeys() }, null, 2));
      break;
    }
    case 'export-pub': {
      if (!arg) { console.error('用法: export-pub <输出文件>'); process.exit(2); }
      const pem = keyring.listPublicKeys().map((k) => k.publicKeyPem).join('\n');
      fs.writeFileSync(arg, pem.endsWith('\n') ? pem : pem + '\n', { mode: 0o644 });
      console.log(`已导出 ${keyring.listPublicKeys().length} 把受信公钥（含历史公钥）到 ${arg}`);
      break;
    }
    case 'rotate': {
      const k = keyring.rotateKey(arg || 'cli-rotate');
      console.log(`已轮换为新签名密钥：kid=${k.kid}`);
      console.log('旧公钥已保留在归档中，旧凭证仍可用导出的公钥集合离线验证。');
      break;
    }
    default:
      console.error('未知命令。可用：init | public | list | export-pub <文件> | rotate [原因]');
      process.exit(2);
  }
}

main();
