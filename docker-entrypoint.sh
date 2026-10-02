#!/bin/bash
set -e

# 首次启动且数据库为空时，可选写入演示数据（SEED_DEMO=1 开启）
if [ "${SEED_DEMO:-0}" = "1" ]; then
  echo "SEED_DEMO=1：检查并写入演示数据（数据库非空时自动跳过）..."
  node src/seed.js || echo "演示数据初始化失败，继续启动（应用会自动建表）"
fi

exec node src/server.js
