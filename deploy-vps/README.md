# 通訳コールセンター PoC — VPS 公開デプロイ手順（GIP直打ち版）

現行のPoC（言語別ルーティング / パターンA・B / 案内人 / 録画）を、クラウドVPSに
**グローバルIP直打ち（**`https://103.96.112.21`**）** で公開する手順。全サービスを Docker 一括・
host networking で動かす。ドメインで運用する場合は末尾「付録A」を参照。

> **なぜHTTPSか**: ブラウザはカメラ/マイクを**セキュアコンテキスト(HTTPS)でのみ許可**する。
> 平文 `http://<IP>` だと通話のカメラが使えないため、Caddyの自己署名HTTPS(`tls internal`)で配信する。
> 起動後、ブラウザに証明書警告が出るが「続行」すればカメラも通話も動く（検証用途向け）。

## 構成

```
                 [インターネット]
                       │  443/tcp (HTTPS/WSS)
                       ▼
                    ┌──────┐  自己署名HTTPS(Caddy内部CA) / パスで振り分け
                    │ Caddy│─ /rtc*,/twirp* → 127.0.0.1:7880 (LiveKit signaling)
                    └──────┘─ それ以外       → 127.0.0.1:3001 (token-server: Web/API)
   媒体(UDP 50000-60000, TURN 3478/udp, TCP 7881) は firewall で直接開放
                       │
   [Redis(127.0.0.1)] [LiveKit(SFU+TURN)] [Egress(録画→./recordings)] [token-server]
```

同梱ファイルの `Caddyfile` と `.env` は既に **103.96.112.21** で設定済み。

---

## 1. 前提

- Ubuntu 24.04 のVPS（2vCPU/2–4GB〜。同時数に応じてCPU増）
- **グローバルIP** `103.96.112.21` **がVPSに直接付与**されていること（CGNAT不可）
- SSHのroot/sudo

## 2. VPS準備（Docker導入・ファイル配置）

OSを確認（`cat /etc/os-release`）してからパッケージ更新:
```
# Ubuntu/Debian:
sudo apt update && sudo apt upgrade -y
# RHEL系(Rocky/Alma/CentOS/Fedora):
sudo dnf -y update            # 古い環境は sudo yum -y update
```
Docker導入（Ubuntu/Debian・多くのディストロ）:
```
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
```
**Rocky/Alma/CentOS(EL8/EL9)** は get.docker.com が失敗することがある（`Unable to find a match: docker-ce`）。
その場合は CentOS用の公式リポジトリで導入する:
```
sudo rm -f /etc/yum.repos.d/docker-ce*.repo
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf makecache
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
docker --version && docker compose version
```
> **podman衝突エラー**（`containerd.io conflicts with runc` / `podman requires runc`）が出たら、
> RHEL8標準のpodmanが使うruncと競合している。Dockerに寄せるなら先にpodmanを外す:
> ```
> sudo dnf -y remove podman buildah runc
> sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
> ```
> （podmanを残す必要がなければこれが最善。`--allowerasing` を付けて一発で置換してもよい）

このリポジトリの `04_開発PoC/`（`livekit-poc` と `deploy-vps` を含む）をVPSへ転送し、

```
cd 04_開発PoC/deploy-vps
```

## 3. APIキーを生成

```
docker run --rm livekit/livekit-server generate-keys
```

出力の **API Key** と **API Secret** を控える。

## 4. キーを3ファイルに反映（値をそろえる）

- `livekit.yaml` … `keys:` を `APIキー: "シークレット"` に置換
- `egress.yaml` … `api_key` / `api_secret`
- `.env` … `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` （`LIVEKIT_URL=wss://103.96.112.21` と `Caddyfile` のIPは設定済み。書き換え不要）
- `.env` の **`ADMIN_PASSWORD`** を任意の強固な値に変更（管理画面ログイン用。初期 `admin1234`）

## 5. ファイアウォール

**RHEL系（firewalld）**:
```
sudo firewall-cmd --permanent --add-port=443/tcp
sudo firewall-cmd --permanent --add-port=7881/tcp
sudo firewall-cmd --permanent --add-port=7881/udp
sudo firewall-cmd --permanent --add-port=3478/udp
sudo firewall-cmd --permanent --add-port=50000-60000/udp
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```
**Ubuntu/Debian（ufw）**:
```
sudo ufw allow 22/tcp
sudo ufw allow 443/tcp                # HTTPS / WSS
sudo ufw allow 7881/tcp
sudo ufw allow 7881/udp
sudo ufw allow 3478/udp               # TURN(UDP)
sudo ufw allow 50000:60000/udp        # メディア(RTP)
sudo ufw enable
sudo ufw status
```

- **80は不要**（ドメインのACMEを使わないため）
- **6379(Redis) と 7880(signaling) は開けない**（Redisは127.0.0.1限定、7880はCaddy経由のみ）
- クラウド側のセキュリティグループにも同じ穴あけを反映（特にUDPレンジ）

## 6. 起動

```
mkdir -p data recordings                # SQLite永続化/録画の出力先を先に作成
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs -f livekit
```
> token-server は better-sqlite3 を含むため初回ビルドに数分かかることがある。

## 7. 動作確認

ブラウザで `https://103.96.112.21` を開く → 証明書警告で「詳細設定 → このサイトにアクセスする（続行）」。

**ログインは1つ**（`https://103.96.112.21/`）。ユーザー名/パスワードでログインすると、ロールに応じて自動で画面が切り替わる（管理者→管理画面、利用者→言語選択、通訳者/案内人→スタッフ画面）。

デモ用アカウント（初回起動時に自動作成。**本番では管理画面で変更/削除**）:
- 管理者: `admin` / `<ADMIN_PASSWORD>`（.env、初期 admin1234）
- 利用者(受付端末・モードB): `reception1` / `reception1`
- 通訳者(英語): `int_en` / `int_en`
- 案内人: `guide1` / `guide1`

利用者はログイン後に**言語を選ぶだけ**（モードA/Bはアカウント設定）。別端末・別回線でログインして3者通話・言語ルーティング・録画を確認する。録画は `deploy-vps/recordings/` に出力。

> wss は同一オリジン(443)。最初にページの自己署名証明書を受け入れれば通話(wss)も通る。

## 7.5 管理コンソール（/admin.html）

- 管理者アカウントでログイン後に表示（`admin` / `.env` の **ADMIN_PASSWORD**、初期 `admin1234`。必ず変更）
- タブ: リアルタイム監視 / 通話履歴（CSV出力）/ 稼働レポート / マスタ管理（言語・端末）/ **ユーザー管理** / ログ（監査）
- **ユーザー管理**: 管理者/利用者/通訳者/案内人のアカウントを作成・編集・削除。利用者にモードA/B、通訳者に対応言語を設定。
- **永続化**: 通話履歴・イベント・マスタは SQLite に保存され、`deploy-vps/data/app.db` に残る（コンテナ再起動でも保持）。
- マスタ管理で言語を追加すると、利用者・スタッフ画面の言語選択に即反映される。端末を登録すると `/user.html` で端末を選択できる。
- **地域（ざっくり地名）**: 既定は接続元IPからオフラインDB(geoip-lite)で推定（日本は「都道府県 市区町村(英字)」表示）。Caddy経由の `X-Forwarded-For` から実IPを取得。**モバイル回線は国レベル（「日本」）止まりになりやすい**（IP測位の限界）。
- **GPS任意取得（パターンB）**: 利用者端末画面(/user.html)でモードBのとき「現在地を送信する（任意）」に同意すると、ブラウザのGPS→クライアント側でBigDataCloud(無料/キー不要)で逆ジオコーディングし、**市区町村名（日本語）**を履歴に記録（IP推定より優先）。GPSはHTTPS(セキュアコンテキスト)必須＝本番の自己署名HTTPSで動作。**座標はBigDataCloud(第三者)に送られ、保存するのは市区町村レベルの地名のみ（生座標は保持しない）。IP・位置は個人情報に準じるため、同意・プライバシーポリシーで扱いを明記すること。**

## 8. よくある不具合

| 症状               | 原因/対処                                                                              |
|------------------|------------------------------------------------------------------------------------|
| カメラが起動しない/権限が出ない | `http://` で開いている。必ず `https://103.96.112.21` で開く                                        |
| 繋がるが映像が流れない      | UDP(50000-60000, 3478)がfirewall/セキュリティグループで塞がれている（最頻）                              |
| 映像だけ出ない・遠隔だけ不可   | `use_external_ip: true` で自動広告。NAT内なら `livekit.yaml` に `rtc.node_ip: "103.96.112.21"` を明示 |
| ページに繋がらない        | Caddy未起動 or 443塞がり。`docker compose logs caddy` を確認                                   |
| 録画が始まらない         | Egress未起動 or キー不一致。`docker compose logs egress` を確認                                  |
| (RHEL系)設定読めない/permission denied | SELinuxが原因の可能性。切り分けは `sudo setenforce 0`（一時）。恒久はvolumeに `:z` を付与 |

## 9. セキュリティ・運用の注意

- **API Secret は非公開**。クライアントに埋め込まない（トークンはサーバ発行）。
- **端末コード(1234)は仮**。本番は端末アカウント認証・DB照合へ（設計確定書参照）。
- Redisは 127.0.0.1 限定＋firewallで遮断。7880を公開しない。
- 録画は個人情報。保存先の暗号化・保存期間(リテンション)・アクセス制御を本番で整備。
- **自己署名HTTPSは検証用**。全利用者が毎回警告を越える必要があるため、恒常運用はドメイン＋正式証明書（付録A）を推奨。
- Egressはヘッドレスブラウザで重い。同時録画数に応じてCPU/インスタンスを増やす。

---

## 付録A. ドメイン運用へ切り替える（恒常運用向け・推奨）

正式証明書(Let's Encrypt)で警告を無くし、TURN/TLSまで強化できる。

1. DNSのAレコードを設定: `livekit.<domain>` と `app.<domain>` → `103.96.112.21`
2. `Caddyfile` をドメイン版に差し替え（`Caddyfile` 内のIPブロックを次に置換）:

   ```
   livekit.<domain> { reverse_proxy 127.0.0.1:7880 }
   app.<domain>     { reverse_proxy 127.0.0.1:3001 }
   ```
3. `.env` の `LIVEKIT_URL=wss://livekit.<domain>` に変更
4. ファイアウォールに **80/tcp** を追加（ACME用）
5. `sudo docker compose up -d`（Caddyが自動で証明書取得）

## 付録B. TURN/TLS の強化（UDP遮断ネットワーク対策）

UDPを塞ぐ厳しい回線の利用者向けに、TURNをTLS(443)でも受けたい場合は、LiveKit公式の生成ツールが確実:

```
docker run --rm -it -v $PWD/gen:/output livekit/generate
```

生成される `caddy.yaml`/`livekit.yaml`（`turn.external_tls: true`）を取り込み、`turn.<domain>` を使う。
（ドメイン運用が前提。まずは本手順のTURN(UDP)で公開し、必要になったら追加）

## 付録C. 本番化の残作業（PoCの割り切り）

- 端末アカウント認証・言語マスタ/端末/要員の管理画面・履歴・レポート
- 録画の外部ストレージ(S3互換)＋暗号化＋リテンション
- 冗長化・監視・スケール（規模確定後にサイジング）