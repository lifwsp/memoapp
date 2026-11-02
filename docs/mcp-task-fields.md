# MCP タスク編集と期限なしタスク

## 設計

既存の `create_note` / `edit_note` を拡張する。タスクは `notes` の同じ行であり、変換に新規行は作らない。編集時に指定しない本文・作成日時・source はそのまま保持する。タグの追加は集合として扱い、同一 ID への同じタスク属性の再設定では二重登録しない（本文の `append` と新規作成自体は冪等操作ではない）。

### 期限なしタスクへ変換

```json
{
  "name": "edit_note",
  "arguments": {
    "id": "aabf9561-6121-4e4d-b402-67d0832519f7",
    "is_task": true,
    "due_date": null,
    "add_tags": ["買い物", "ワークマン"]
  }
}
```

本文・source・created_at を送らず、元のメモを保持する。通常メモに戻すには同じ ID で `is_task: false` を指定する。削除・複製はしない。

### 日時・繰り返し

- `due_date` / `scheduled_date`: 実在する YYYY-MM-DD、日本時間の日付。
- `due_time`: HH:MM、00:00〜23:59。
- `remind_at`: タイムゾーン付き ISO 8601。既存 DB 列 `reminder_at` に保存し、応答では `remind_at` として返す。明示値がなければ従来どおり期日（なければ予定日）と時刻（なければ日本時間09:00）から算出する。
- 上記は `null` または既存互換の空文字で解除する。`remind_at` 解除は既定の算出動作へ戻すことであり、通知の全面無効化ではない。
- `repeat`（既存の日本語入力）、`repeat_text`（別名）、`repeat_rule`（既存 JSON 規則）のいずれか1つを指定する。例: `{"freq":"week","interval":1,"weekdays":[1,3,5]}`。解除は `repeat_rule: null` または空の日本語入力。
- `repeat_from` は `due` または `done`。応答の `repeat_text` は規則から生成する。
- 日付省略時には従来の繰り返し初回日補完を維持するが、明示的な `due_date: null` は尊重する。
- `parent_id: null` または空文字で親を解除。親子は既存 DB トリガーで1階層・同一所有者に制限する。
- 作成も編集もタスク全体を返す。既存の戻り値フィールドは保持する。

## 期限なし一覧

MCP `list_tasks(view="inbox")` は、未削除・未アーカイブ・未完了・`is_task=true`・`due_date=null`。予定日が設定されていても期限がなければ含む。UI の既存「受信箱」（未整理メモ）とは別の定義。

```json
{"name":"list_tasks","arguments":{"view":"inbox","tag":"買い物","limit":100,"offset":0}}
```

`view=all` と `tag` の組み合わせも可能。応答の従来の `today` / `view` / `tasks` に加え、`limit` / `offset` / `has_more` / `next_offset` を返す。`has_more=true` の間、`next_offset` を次の `offset` として取得する。既定100件（doneは30）、最大100件。IDを最終ソートキーにするため同じソート値でも順序が安定する。ただし offset ページ間で追加・削除・編集が発生した場合のスナップショット保証はない。

## アプリ UI

サイドバー（モバイルはドロワー）の「期限なしタスク」で未完了・期限なしのタスクを一覧できる。上部の「タグで絞り込み」で「買い物」を選択すると対象だけを表示する。サブタスクだけに付いたタグも選べる。予定日がある期限なしタスクやサブタスクも表示する。ここでクイック追加すると期限なしタスクになり、選択中のタグを引き継ぐ。従来の「受信箱」やタグ別メモ一覧の定義は変更しない。

メモ読込は created_at と id で順序を固定して全ページ取得する。サーバー側の行数制限が要求件数より小さくても、実際の取得件数で次の位置を決め、空ページまで読む。

## 検証・反映

```sh
node --test scripts/test-mcp.mjs
npx --yes deno check supabase/functions/mcp/index.ts
cd web && pnpm build && pnpm lint
```

オフライン MCP テストは実ハンドラーとインメモリ DB アダプターで検証する。本番接続・本番メモの変更は行わない。実環境では Edge Function のデプロイと Web のビルド成果物の反映後、Muse のツール定義を再取得する。既存 `reminder_at` 列を利用するため新規マイグレーションは不要。

実環境での受け入れ確認では、対象メモをまず read_note で読み取り、上記変換後の同一 ID・本文・source・created_at を比較する。期日と通知日時のあるタスクについて upcoming と agenda も確認する。認証情報は既存の Edge Functions / Secrets 方針を変更しない。
