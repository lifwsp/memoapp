# 自作メモアプリ MVP設計メモ（改訂版：自分専用＋Amazfit Bip 6 入力）

- 作成日：2026年10月24日（原版）／ 改訂：2026年10月24日
- 前提：**自分専用**（知人への配布はしない）。PC・iPhone の PWA に加え、**Amazfit Bip 6 からメモを入力できる**こと。
- 対象読者：開発を判断・依頼する本人

> **結論**：設計の要は3つ。
> 1. 同期エンジンは自作しない。Supabase の Realtime に任せる。
> 2. user_id と Row Level Security（RLS）は、自分専用でも残す。手間はほとんど増えず、トークンが漏れたときの被害を抑える保険になる。
> 3. ウォッチは「書くだけ」の入口にする。ウォッチ → iPhone の Zepp アプリ（Side Service）→ Supabase の受け口、という経路で送る。

## 0. 原版からの変更点

| 項目 | 原版 | 改訂版 |
|---|---|---|
| 利用者 | 本人 → 知人3〜5人 → 20人前後 | **本人のみ** |
| 招待制（invites テーブル・管理画面） | あり | **削除** |
| プライバシーポリシー・アカウント削除の画面 | 必須 | **削除**（エクスポートとバックアップは残す） |
| Phase 3〜4（知人での試験・拡大） | あり | **削除**。代わりにウォッチ入力の段階を入れる |
| Google OAuth | 本番公開して審査を受ける | 本番（Production）に切り替えるが、**審査は受けない**（未確認アプリの警告は出るが、自分だけなら困らない） |
| 入力端末 | PC・モバイル | PC・iPhone ＋ **Amazfit Bip 6** |

## 1. MVPの範囲

| MVPに入れる | MVPに入れない |
|---|---|
| テキストメモの作成・編集・削除 | 画像・音声メモ、手書き、OCR |
| チェックリスト | 共同編集・CRDT |
| タイトル、ラベル、ピン留め | ネイティブアプリ |
| アーカイブ、ゴミ箱（復元付き） | 課金、招待、複数ユーザーの運用 |
| 全文検索、ラベルでの絞り込み | ウォッチでのメモの閲覧・編集 |
| リアルタイム同期、オフライン時の下書き保持 | |
| 日時メモ（reminder_at） | |
| エクスポート（Markdown / JSON） | |
| **ウォッチからの音声／文字入力（新規メモの作成のみ）** | |

## 2. 全体構成

```
[PC / iPhone の PWA] ←Realtime→ [Supabase: Postgres + Auth + RLS]
                                      ↑ HTTPS（Edge Function: watch-notes）
[Amazfit Bip 6 ミニアプリ] →BLE→ [iPhone の Zepp アプリ内 Side Service]
                                      ↓
                    [MCP / API サーバー（Cloud Run など）] → Muse / Google カレンダー / Todoist
```

- Bip 6 は Zepp OS の **API_LEVEL 4.2** で、画面は 390×450 の角型（[公式の機種一覧](https://docs.zepp.com/docs/reference/related-resources/device-list/)）。
- ウォッチ単体ではインターネットにつながらない。HTTP の送信は、iPhone の Zepp アプリ内で動く **Side Service** が行う（[Side Service](https://docs.zepp.com/docs/guides/framework/side-service/intro/)）。

## 3. データモデル

| テーブル | 主な項目 |
|---|---|
| notes | id, user_id, title, body, kind（text / checklist）, pinned, archived, deleted_at, reminder_at, **source（web / watch / mcp）**, **input_kind（voice / text）**, **client_id**, created_at, updated_at |
| note_items | id, note_id, body, done, sort_order |
| labels / note_labels | id, user_id, name ／ note_id ↔ label_id |
| external_links | id, note_id, type（calendar / todoist）, external_id, direction, last_synced_at |
| ~~invites~~ | 削除 |

- `unique (user_id, client_id)` により、ウォッチからの再送で同じメモが2回登録されないようにする。
- 競合は MVP では「最後に保存した内容を優先」（Last Write Wins）。履歴を簡易的に持ち、事故があっても戻せるようにする。
- マイグレーション：[`supabase/migrations/0001_notes.sql`](../supabase/migrations/0001_notes.sql)

## 4. ウォッチ入力（Amazfit Bip 6）

### 4.1 画面と操作
- ボタンは「音声」と「文字」の2つ。システムキーボード `createKeyboard`（API 4.0 以降）を `inputType.VOICE` または `inputType.CHAR` で呼び出す（[SYSTEM_KEYBOARD](https://docs.zepp.com/docs/reference/device-app-api/newAPI/ui/widget/SYSTEM_KEYBOARD/)）。
- 下に直近5件と、それぞれの状態を表示する：✓ 送信済み ／ … 送信中 ／ ! 失敗（次回再送）。

### 4.2 送信と再送
1. 確定したメモは、まずウォッチ内の LocalStorage に保存する（`client_id` はここで振る）。
2. `this.request({method:"ADD_NOTE"})` で Side Service に渡す。
3. Side Service が受け口に `POST`（`Authorization: Bearer <WATCH_TOKEN>`）する。
4. 送れなかった分はキューに残す。次にアプリを開いたときに再送する。

### 4.3 受け口（Supabase Edge Function `watch-notes`）
- 自分専用の固定トークンで認証する（OAuth は使わない）。user_id はサーバー側の `OWNER_USER_ID` で固定する。
- 本文は5000字まで。`client_id` で upsert し、重複は無視する。
- 実装：[`supabase/functions/watch-notes/index.ts`](../supabase/functions/watch-notes/index.ts)

### 4.4 iPhone ならではのリスク
- **音声入力の日本語対応**：音声認識は iPhone との接続を前提にしている。日本語がどこまで認識されるかは実機で確かめる。だめな場合は、文字入力に頼るか、録音を Whisper（音声をテキストにする AI）に送る方式を検討する。
- **Side Service が止まる問題**：iOS が Zepp アプリをバックグラウンドで止めると、送信に失敗したり遅れたりする。ウォッチ側にキューを持って再送するので、メモは消えない。ただし、すぐには届かないことがある。
- **インストール**：ストアには公開しない。Zepp アプリの開発者モードから、`zeus preview` の QR コードを読み取って自分のウォッチに入れる。

## 5. 外部連携（原版から変更なし・自分専用に簡略化）
- **Muse（MCP）**：自分専用のトークンで認証する。まずは読み取りのみで始め、書き込みは後から許可する。
- **Google カレンダー**：メモからカレンダーへの片方向。OAuth は Production に切り替えて、7日でトークンが失効するのを避ける。審査は受けない。
- **Todoist**：やめた（2026-10-26）。iPhone に通知が届かないため。未完了の 249 件は `scripts/import-todoist.mts` で一度だけ取り込み済み（プロジェクト名→タグ、Inbox→受信箱、繰り返しは変換）。
  - 2026-10-29：Muse に繋いでいた Todoist 公式 MCP を外した。Muse が Todoist に残った取り込み済みタスク（WristMemo では完了済み）を未完了と誤認したため。書き戻し（双方向同期）は作らない。
  - Todoist アカウントは、もしものときのために休眠で残す（10/26 時点の控え。以後は更新しない）。タスクの正本は WristMemo だけ。
- **入力と通知**：Muse に任せる（WristMemo のウォッチ・PWA からの入力も併用）。MCP の `agenda` / `list_tasks` が返す `remind_at`（時刻なしのタスクは 9:00）に合わせて、Muse がリマインダーを入れる。

### 5.1 繰り返しタスク（2026-10-26）
- `repeat_rule`（毎日・毎週◯曜・毎月◯日・毎年◯月◯日・◯日/週/か月/年ごと）と `repeat_from`（期日から数える／完了日から数える）を持つ。
- 完了は DB の `complete_task()` で行う。繰り返しタスクは「完了」にならず、期日が次の回へ進む（`last_done_at` と `done_count` が残る）。
- 日本語の言い方は `supabase/functions/_shared/repeat.ts` が読む。PWA・ウォッチ・MCP で共通。

### 5.2 サブタスク（2026-10-29）
- `notes.parent_id`（1階層だけ）と `sort_order`。親はタスクでもメモでもよい。サブタスクは親のタグを引き継ぎ、受信箱・すべて・タグの一覧には出さず親の詳細に並べる（「予定」と検索には単独でも出る）。
- 動きは Todoist に合わせ、DB のトリガー（`0007_subtasks.sql`）で行う。PWA・ウォッチ・MCP のどこから変えても同じ。
  - 親を完了 → 未完了の子もまとめて完了。親を戻すと、一緒に完了した子だけ戻る。
  - 繰り返しの親を完了 → 期日が次の回へ進み、子のチェックが外れる。
  - 子を未完了に戻す → 完了していた親も戻る。
  - 親のアーカイブ・ゴミ箱は子にも及ぶ。完全削除は子も消える。
- 取り込み時に平たくした分は `scripts/link-todoist-subtasks.mts` で親子に戻す。

### 5.2 合流ビュー
- カレンダーの予定はメモに写さず、「今日」「今後の予定」で Google カレンダーから読んでタスクと並べる（予定の本体はカレンダー）。

## 6. 進め方

| 段階 | 内容と完了条件 |
|---|---|
| **Phase 0.5（先に小さく試す）** | 最小のウォッチアプリ（[`watch-app/`](../watch-app/)）で、音声入力から仮の受け口まで届くかを試す。**日本語の音声入力**と **iPhone 経由の送信**の2点を確かめる |
| Phase 1 | Supabase と、自分専用の PWA（一覧・編集・検索・ラベル・ピン・アーカイブ・同期）。日常使いで Keep を置き換えられるか確かめる |
| Phase 2 | ウォッチの送信先を本番の受け口に切り替える。続いて Muse、Todoist、カレンダーの連携を1つずつ足す |

## 7. 次に決めること
- [ ] 日本語の音声入力が実用になるか（Phase 0.5 の結果次第）
- [ ] チェックリストを独立した種別にするか、本文中のチェックボックスで足りるか
- [ ] リマインダーをカレンダー連携に一本化してよいか
- [ ] Muse 連携を読み取りのみで始めるか
- [ ] ウォッチから送ったメモに、自動でラベル（例：`watch`）を付けるか

> コスト目安：自分専用であれば、Supabase と Cloud Run は無料枠に収まる見込み（見積もりであり、プランの改定で変わる）。
