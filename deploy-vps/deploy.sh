#!/usr/bin/env bash
# VPSでのデプロイ用スクリプト: 最新を取得してビルド・再起動する
# 使い方: cd ~/<repo>/deploy-vps && ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "== git pull =="
git pull --ff-only

# 秘密ファイルが無ければ雛形から作成を促す（初回のみ）
for f in .env livekit.yaml egress.yaml; do
  if [ ! -f "$f" ]; then
    echo "!! $f がありません。$f.example からコピーして鍵を設定してください:"
    echo "   cp $f.example $f && \$EDITOR $f"
    exit 1
  fi
done
mkdir -p data recordings

echo "== docker compose up -d --build =="
docker compose up -d --build
docker compose ps
