# token-server イメージ（言語別キュー/JWT/録画制御/管理画面/SQLite永続ログ）
# build context = livekit-poc（token-server と web を同梱）
# better-sqlite3 のためネイティブビルド依存を入れる（prebuiltが使えれば未使用でもOK）。
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY web ./web
# 背景処理モデル（セルフィーセグメンター）をビルド時に取得し自ドメインで配信（失敗しても継続）
RUN mkdir -p web/lkbg && (curl -fsSL -o web/lkbg/selfie_segmenter.tflite \
      https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite \
      && echo "[build] bg model fetched" || echo "[build] WARN: bg model fetch failed (背景機能は無効になります)")
COPY token-server ./token-server

WORKDIR /app/token-server
RUN rm -f package-lock.json && rm -rf node_modules \
 && npm install --omit=dev --no-audit --no-fund
# 依存の取りこぼしをビルド時に検証（欠けていればここで失敗する）
RUN node -e "require('better-sqlite3');require('dotenv');require('express');require('cors');require('livekit-server-sdk');require('stripe');console.log('deps OK')"

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV DATA_DIR=/data
EXPOSE 3001
CMD ["node", "token-server/server.js"]
