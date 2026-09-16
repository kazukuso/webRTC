# Stripe PPV課金 セットアップ手順（フェーズ2）

課金は各「利用者(受付端末)アカウント」の**課金要否ON**の通話にのみ適用されます。
料金は管理画面「課金・売上」で変更可能（初期: 基本100円/5分、延長100円/5分）。
**Stripeキー未設定時は「金額の記録のみ」**で、実決済は行いません（既存動作を壊しません）。

## 1. テストキーの取得
Stripeダッシュボード（テストモード）→ 開発者 → APIキー。
- 公開可能キー `pk_test_...`
- シークレットキー `sk_test_...`

## 2. Webhook署名シークレット
開発者 → Webhooks → エンドポイントを追加。
- 宛先URL: `https://<あなたのドメイン(app.*)>/api/stripe/webhook`
- 受信イベント: `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`
- 作成後の「署名シークレット」`whsec_...` を控える。
- ローカル検証: `stripe listen --forward-to localhost:3001/api/stripe/webhook`

## 3. .env に設定（秘密鍵はGit管理しない）
```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
PUBLIC_BASE_URL=https://app.example.com   # Checkout戻り先/Webhookの公開URL基底
```
その後 `npm install`（stripe SDK追加済み）→ サーバ再起動。

## 4. 動作フロー（会員B=保存カード）
1. 受付端末画面の「カード登録」→ StripeのCheckout(setup)でカード保存（番号はStripe側で入力・保管）。
2. 通話開始（接続）時に基本料を保存カードへ off-session 課金。失敗時は接続せず「決済に失敗」を表示。
3. 通話中「延長」ボタンで延長料を off-session 課金。成功時のみ延長。
4. Webhookでカード保存確定・決済結果を反映。売上は管理画面「課金・売上」で確認。

## 5. テストカード（テストモード）
- 成功: `4242 4242 4242 4242`（任意の将来の有効期限・任意のCVC・任意の郵便番号）
- 認証要求(3DS): `4000 0025 0000 3155`
- 残高不足で失敗: `4000 0000 0000 9995`

## 注意
- カード番号・秘密鍵はサーバ/チャットで直接扱わない（入力はStripeのCheckout画面）。
- まずテストモードで検証し、本番キーへ切替える前に一連の流れ（登録→基本→延長→失敗時）を確認すること。
- ゲスト（都度Checkout）とメール+Stripe Link対応は次フェーズ。
