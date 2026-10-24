# memo-app

自分専用のメモアプリ。設計は [docs/MVP設計メモ.md](docs/MVP設計メモ.md) を参照。

## Phase 0.5: Bip 6 ウォッチアプリ（watch-app/）

```sh
cd watch-app
npm install
zeus build          # dist/*.zab を生成
zeus dev            # シミュレーター（Zepp OS Simulator が別途必要）
zeus preview        # QRコードを表示 → Zeppアプリの開発者モードで読み取り、実機にインストール
```

- Zeppアプリ側の準備: プロフィール → 設定 → 「Zepp について」でロゴを7回タップ → 開発者モードを有効にし、Zepp アカウントで `zeus login`。
- インストール後、Zeppアプリ → デバイス → アプリ → WristMemo の設定で **受け口URL** と **トークン** を入れる。
- まず仮の受け口として https://webhook.site のURLを入れて、届いたJSONで「日本語音声の認識精度」と「iPhone経由の送信」を確認する。

## 本番の受け口（Supabase）

```sh
supabase db push                                   # migrations/0001_notes.sql
supabase secrets set WATCH_TOKEN=$(openssl rand -hex 32) OWNER_USER_ID=<自分のauth.users.id>
supabase functions deploy watch-notes --no-verify-jwt
# 受け口URL: https://<project>.supabase.co/functions/v1/watch-notes
```
