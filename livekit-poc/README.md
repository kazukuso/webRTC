# LiveKit セルフホスト PoC スターターキット（通訳コールセンター）

LiveKitセルフホストで、通訳サービスの中核を動かせる最小構成。
確定設計（パターンA/B、言語別ルーティング、案内人共通プール、録画）をPoCに反映済み。

- **言語選択→言語別キュー**（通訳者の対応言語スキルでマッチング）
- **パターンA**：同一端末＋通訳者（2接続）
- **パターンB**：本人＋通訳者＋案内人の**3者通話**。接続方式は「両者確保後／段階接続」を選択
- **録画（Egress）**：通話をMP4保存

## 構成

```
livekit-poc/
├─ docker-compose.yaml     … Option2用（Redis + LiveKit server + Egress録画）
├─ livekit.yaml            … LiveKit server 設定（PoC用の鍵入り）
├─ egress.yaml             … 録画(Egress)サービス設定
├─ recordings/             … 録画MP4の出力先（自動生成）
├─ token-server/           … 言語別キュー＋割当＋JWT発行＋録画制御＋Web配信（Node/Express）
│   ├─ server.js           …  ※言語マスタ LANGUAGES に1行足すだけで言語追加
│   ├─ package.json
│   └─ .env.example
└─ web/
    ├─ index.html          … 入口（利用者端末 / 通訳者 / 案内人）
    ├─ user.html           … 利用者端末: モードA/B・言語選択→待機→通話
    ├─ staff.html          … 通訳者(言語スキル)/案内人: ?role=interpreter|guide
    └─ call.js             … 通話UIの共有ロジック（複数リモート対応, CDN）
```

## 前提

- Docker Desktop（LiveKit server 起動用）
- Node.js 18+（トークンサーバ用）
- カメラ・マイク付きPC。ブラウザは Chrome/Edge 推奨。

---

## Option 1：最速で試す（推奨・開発モード）

LiveKit を開発モード（固定キー devkey/secret）で1コンテナ起動する方法。

**1) LiveKit server を起動**

```
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp livekit/livekit-server:latest --dev --bind 0.0.0.0 --node-ip 127.0.0.1
```

- `--bind 0.0.0.0` … Dockerのポート公開を通すため全インターフェースで待受（無いと `--dev` は127.0.0.1にバインドし接続不可）
- `--node-ip 127.0.0.1` … メディアの広告先をホストから届くアドレスに（同一PCの2タブ検証用）
- 起動ログで `bindAddresses` に `0.0.0.0`、`nodeIP` が `127.0.0.1` になっていれば正解
- ※ 別の物理端末から試す場合は `127.0.0.1` ではなくホストのLAN IP＋TURNが必要

**2) トークンサーバ＆Web を起動**（別ターミナル）

```
cd token-server
copy .env.example .env        # Windows（Mac/Linux は cp .env.example .env）
npm install
npm start
```

`.env` は既定のまま（devkey/secret）でOK。

**3) ブラウザで確認（通訳フロー）**

トップ `http://localhost:3001` に、利用者端末 / 通訳者 / 案内人 の入口があります。端末コードは **1234**。

パターンB（3者）の確認手順：

1. **通訳者**: `/staff.html?role=interpreter` を開き、名前と対応言語（例: 英語）を選んでログイン→「応対可」
2. **案内人**: 別タブで `/staff.html?role=guide` を開き、ログイン→「応対可」
3. **利用者**: 別タブで `/user.html` を開き、モード **B**／接続方式（両者確保 or 段階接続）を選び、言語 **英語**・端末コード 1234 で受付
4. 利用者＋通訳者＋案内人の**3者通話**になれば成功

その他の確認ポイント：

- **言語別ルーティング**: 通訳者が「英語」のみ対応なら、利用者が「中国語」を選ぶと割り当てられず待機（中国語通訳がログインすると割当）
- **パターンA**: 利用者でモードAを選ぶと、通訳者だけ呼び出す2接続
- **段階接続**: B・段階接続では、案内人が離席でも先に通訳者とつながり、案内人が応対可になると後から参加
- **録画**: 通訳者画面の「● 録画開始 / ■ 録画停止」（Egress起動時。次項参照）

> 別端末検証は Option 1 の `--node-ip` 注記を参照（同一PCの複数タブでの確認を推奨）。

---

## Option 2：Redisあり構成（本番に近い）

**1) 起動**

```
docker compose up
```

（`livekit.yaml` の鍵 `APIcallcenter` / secret を使用）

**2) トークンサーバの .env を Option2 の鍵に合わせる**

```
LIVEKIT_API_KEY=APIcallcenter
LIVEKIT_API_SECRET=4e69181c87bc58ac27d8d84509590143bf0a87a47d944821
```

その後 `npm install && npm start`、ブラウザ手順は Option1 と同じ。

---

## 動作確認チェックリスト（計画書 4.7）

- [ ] 利用者・通訳者で相互に映像・音声が見える
- [ ] 誤った端末コードでは受付できない（401）
- [ ] マイク/カメラのオンオフが動作する
- [ ] 言語別ルーティング：対応言語外を選ぶと割当されず待機
- [ ] パターンA：通訳者のみ呼び出す（2接続）
- [ ] パターンB(両者確保)：通訳者＋案内人が揃って3者通話開始
- [ ] パターンB(段階接続)：通訳者先行→案内人が後から参加
- [ ] （録画）録画開始→停止でMP4が recordings/ に保存され再生できる
- [ ] （別端末・別回線）TURN無しだと繋がらない環境を把握 → 本番はTURN必須
- [ ] iOS Safari で動作するか

## 録画（Egress）を試す

録画は LiveKit Egress（別サービス）が担当し、通話をヘッドレスChromeで合成してMP4保存する。
本キットには `egress.yaml` と compose の egress サービス、録画開始/停止API、オペレータ画面の録画ボタンを同梱済み。

> **重要（ローカルの注意）**: 録画はメディアの「広告先IP(node_ip)」が要になる。
> ブラウザ(ホスト)とEgress(コンテナ)の両方から同じlivekitに届く必要があるため、
> `--dev` 単体や node_ip=127.0.0.1 のままでは録画が繋がらない。以下いずれかで対応する。

**方法A（推奨・確実）: Linux / WSL2 で host networking**
`docker-compose.yaml` の各サービスに `network_mode: host` を付けて起動すると、全コンポーネントが
127.0.0.1 で揃うため録画まで素直に通る。本番構成にも近い。

**方法B: Windows/Mac の Docker Desktop で試す**

1. PCのLAN IP（例 `192.168.1.100`）を調べる（`ipconfig`）
2. `livekit.yaml` の `rtc.node_ip` にそのIPを設定（コメントを外して記入）
3. `token-server/.env` の `LIVEKIT_URL` を `ws://192.168.1.100:7880` に変更
4. 起動して録画:
   ```
   docker compose up          # redis + livekit + egress
   cd token-server && npm start
   ```
5. ブラウザは `http://localhost:3001` のまま。通話成立後、オペレータ画面の「● 録画開始」→「■ 録画停止」
6. 録画MP4は `livekit-poc/recordings/` に出力される

**確認のポイント**
- `docker compose logs egress` にエラーが出ていないか
- 停止後、`recordings/` に `room-Sxx-....mp4` が生成され再生できるか

（本番はファイル出力ではなく S3互換ストレージ＋暗号化＋リテンションに置き換える）

## 本番化で置き換える点（PoCの割り切り）

- パスコード照合: 固定値 → **DBのハッシュ照合＋ワンタイム＋失効＋試行回数制限**
- 鍵: ファイル直書き → **環境変数/シークレット管理**、十分な長さのランダム値
- ネットワーク: localhost → **公開IP＋TURN、Linux host networking、TLS(wss)**
- 待ち行列・オペレータ管理・履歴・録画保存/リテンション: 本キットは通話疎通のみ。別途実装。