-- サブタスク（1階層だけ）。親はタスクでもメモでもよい（メモの下に並べるとチェックリストになる）。
-- 動きは Todoist に合わせる:
--   ・親を完了 → 未完了の子もまとめて完了（同じ時刻が入るので、親を戻すとその子だけ一緒に戻る）
--   ・繰り返しの親を完了（期日が次の回へ進む）→ 子のチェックを外して次の回に備える
--   ・子を未完了に戻す → 完了していた親も未完了に戻る
--   ・親をアーカイブ／ゴミ箱 → 子も一緒に（親と同じ状態だった子だけ）。完全削除は on delete cascade
-- どの経路（PWA の rpc・直接の update、ウォッチ、MCP）から変えても同じになるよう、トリガーで行う。
alter table public.notes
  add column if not exists parent_id  uuid references public.notes(id) on delete cascade,
  add column if not exists sort_order integer not null default 0;  -- 親の中での並び（小さい順、同じなら作った順）

create index if not exists notes_parent_idx on public.notes(parent_id) where parent_id is not null;

-- 親子のつなぎ方を確かめる（自分自身・他人のメモ・孫は不可）
create or replace function public.notes_check_parent() returns trigger
language plpgsql as $$
declare
  p public.notes;
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then raise exception 'サブタスクの親に自分自身は選べません'; end if;
  select * into p from public.notes where id = new.parent_id;
  if not found or p.user_id <> new.user_id then raise exception '親のメモが見つかりません'; end if;
  if p.parent_id is not null then raise exception 'サブタスクの下にはサブタスクを作れません（1階層まで）'; end if;
  if exists (select 1 from public.notes c where c.parent_id = new.id) then
    raise exception 'サブタスクを持つメモは、ほかのメモのサブタスクにできません';
  end if;
  return new;
end
$$;

drop trigger if exists notes_check_parent on public.notes;
create trigger notes_check_parent before insert or update of parent_id on public.notes
  for each row execute function public.notes_check_parent();

-- 親子の状態を連動させる。トリガーから起きた更新（深さ 2 以上）では連鎖させない
create or replace function public.notes_cascade() returns trigger
language plpgsql as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;

  if new.parent_id is null then
    -- 親を完了 → 未完了の子も同じ時刻で完了
    if old.done_at is null and new.done_at is not null then
      update public.notes set done_at = new.done_at, updated_at = now()
        where parent_id = new.id and is_task and done_at is null;
    -- 親を未完了に戻す → 親と一緒に完了した子だけ戻す
    elsif old.done_at is not null and new.done_at is null then
      update public.notes set done_at = null, updated_at = now()
        where parent_id = new.id and done_at = old.done_at;
    end if;
    -- 繰り返しの親を完了（last_done_at が進む）→ 子のチェックを外す
    if new.last_done_at is not null and new.last_done_at > coalesce(old.last_done_at, '-infinity'::timestamptz) then
      update public.notes set done_at = null, updated_at = now()
        where parent_id = new.id and done_at is not null;
    end if;
    if new.archived is distinct from old.archived then
      update public.notes set archived = new.archived, updated_at = now()
        where parent_id = new.id and archived = old.archived;
    end if;
    if new.deleted_at is distinct from old.deleted_at then
      update public.notes set deleted_at = new.deleted_at, updated_at = now()
        where parent_id = new.id and deleted_at is not distinct from old.deleted_at;
    end if;
  elsif old.done_at is not null and new.done_at is null then
    -- 子を未完了に戻す → 完了していた親も戻す（ほかの子はそのまま）
    update public.notes set done_at = null, updated_at = now()
      where id = new.parent_id and done_at is not null;
  end if;
  return null;
end
$$;

drop trigger if exists notes_cascade on public.notes;
create trigger notes_cascade after update of done_at, last_done_at, archived, deleted_at on public.notes
  for each row execute function public.notes_cascade();
