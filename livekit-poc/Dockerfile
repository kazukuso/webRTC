# token-server イメージ（言語別キュー/JWT/録画制御/管理画面/SQLite永続ログ）
# build context = livekit-poc（token-server と web を同梱）
# better-sqlite3 のためネイティブビルド依存を入れる（prebuiltが使えれば未使用でもOK）。
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY web ./web
COPY token-server ./token-server

WORKDIR /app/token-server
RUN rm -f package-lock.json && rm -rf node_modules \
 && npm install --omit=dev --no-audit --no-fund
# 依存の取りこぼしをビルド時に検証（欠けていればここで失敗する）
RUN node -e "require('better-sqlite3');require('dotenv');require('express');require('cors');require('livekit-server-sdk');console.log('deps OK')"

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV DATA_DIR=/data
EXPOSE 3001
CMD ["node", "token-server/server.js"]
