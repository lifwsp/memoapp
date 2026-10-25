-- メモにタグと「タスク」の属性を足す。
-- 「今日」「今後」などのビューは保存場所ではなく、これらの属性から作る絞り込み結果。
alter table public.notes
  add column if not exists tags           text[]  not null default '{}',
  add column if not exists is_task        boolean not null default false,
  add column if not exists done_at        timestamptz,          -- 完了した日時（null = 未完了）
  add column if not exists due_date       date,                 -- 締め切り（日本時間の日付）
  add column if not exists due_time       time,                 -- 締め切りの時刻（任意）
  add column if not exists scheduled_date date,                 -- 取り組む予定の日（締め切りとは別）
  add column if not exists priority       smallint not null default 0 check (priority between 0 and 3); -- 0 なし / 1 低 / 2 中 / 3 高

create index if not exists notes_tags_idx on public.notes using gin (tags);
create index if not exists notes_open_tasks_idx on public.notes (user_id, due_date, scheduled_date)
  where is_task and done_at is null and deleted_at is null;
