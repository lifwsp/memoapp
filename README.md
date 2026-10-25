# memo-app (WristMemo)

自分専用のメモアプリ。Amazfit Bip 6 から音声・文字でメモし、iPhone の PWA で読み書きする。
設計は [docs/MVP設計メモ.md](docs/MVP設計メモ.md) を参照。

```
Bip 6 (watch-app) ──BLE──> iPhone Zepp アプリ (Side Service) ──HTTPS──> Supabase Edge Function (watch-notes) ──> notes 表
                                                                                      PWA (web/) <──realtime──┘
```

- PWA: https://lifwsp.github.io/memoapp/ （`main` に push すると GitHub Actions で自動デプロイ）
- 秘密の値はすべて git 管理外: `.env.local`（Supabase のトークン・DB パスワード・WATCH_TOKEN・OWNER_USER_ID・OWNER_PASSWORD）、`web/.env.local`、`watch-app/app-side/config.js`

## watch-app/（Zepp OS 4.2）

```sh
cd watch-app && npm install
zeus bridge         # Zepp アプリ（開発者モード）で Bridge をオン → `connect` → `install` → Amazfit Bip 6 を選ぶ
```

- QR コード（`zeus preview`）からのインストールは iPhone で「Unknown error」になり使えなかった。Bridge を使う。
- インストール中は iPhone の Zepp アプリを前面に出しておく（裏に回ると「getting package...」で止まる）。
- 送り先: `app-side/config.example.js` を `config.js` にコピーして URL とトークンを書く（Zepp アプリの設定画面で入れた値が優先）。
- 送れなかったメモはウォッチに残り、次にアプリを開いたときに再送。`client_id` で重複は1件にまとまる。

## supabase/

```sh
set -a; . ./.env.local; set +a
npx supabase@2.122.0 db push --linked -p "$SUPABASE_DB_PASSWORD"
npx supabase@2.122.0 functions deploy watch-notes --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt --use-api
```

- 新しいプロジェクトは表に権限が自動で付かないため、`0002_notes_grants.sql` で authenticated / service_role に付与（anon には付けない）。
- 新規登録は無効化済み（`disable_signup`）。ログインは `owner@wristmemo.local` のみ。

## web/（Vite + React + PWA）

```sh
cd web && pnpm install && pnpm dev     # web/.env.local に VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
```
