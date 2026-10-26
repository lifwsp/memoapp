-- 繰り返しタスク。
-- repeat_rule の形: {"freq":"day|week|month|year", "interval":1, "weekdays":[0..6], "monthday":1..31 | -1(月末), "month":1..12}
--   weekdays は freq=week のときだけ（0=日曜）。monthday は month/year、month は year のときだけ使う。
-- repeat_from: 'due' = 元の期日から次の回を数える / 'done' = 完了した日から数える。
alter table public.notes
  add column if not exists repeat_rule  jsonb,
  add column if not exists repeat_from  text not null default 'due' check (repeat_from in ('due','done')),
  add column if not exists last_done_at timestamptz,          -- 繰り返しタスクを最後に完了した日時
  add column if not exists done_count   integer not null default 0;

-- 日本時間の今日
create or replace function public.jst_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Tokyo')::date $$;

-- 月の d 日（d=-1 は月末。存在しない日は月末に丸める）
create or replace function public.month_day(y int, m int, d int) returns date
language sql immutable as $$
  select case
    when d = -1 or d >= extract(day from (make_date(y, m, 1) + interval '1 month - 1 day'))::int
      then (make_date(y, m, 1) + interval '1 month - 1 day')::date
    else make_date(y, m, d)
  end
$$;

-- 規則に従って base の「次の回」を返す（base より後の日付）
create or replace function public.next_occurrence(rule jsonb, base date) returns date
language plpgsql immutable as $$
declare
  freq text := coalesce(rule->>'freq', 'day');
  n int := greatest(coalesce((rule->>'interval')::int, 1), 1);
  wds int[];
  md int;
  mo int;
  d date;
  i int;
  ym int;
begin
  if freq = 'day' then
    return base + n;
  elsif freq = 'week' then
    select coalesce(array_agg(x::int order by x::int), '{}') into wds from jsonb_array_elements_text(coalesce(rule->'weekdays', '[]'::jsonb)) x;
    if array_length(wds, 1) is null then
      return base + 7 * n;
    end if;
    -- 同じ週（月曜はじまり）の残りの曜日を探す
    for i in 1..6 loop
      d := base + i;
      exit when extract(isodow from d) = 1;  -- 月曜をまたいだら次の週
      if extract(dow from d)::int = any(wds) then return d; end if;
    end loop;
    -- n 週後の週の最初の該当曜日
    d := base - (extract(isodow from base)::int - 1) + 7 * n;  -- n 週後の月曜
    for i in 0..6 loop
      if extract(dow from d + i)::int = any(wds) then return d + i; end if;
    end loop;
    return base + 7 * n;
  elsif freq = 'month' then
    md := coalesce((rule->>'monthday')::int, extract(day from base)::int);
    ym := extract(year from base)::int * 12 + extract(month from base)::int - 1;
    -- 同じ月でまだ来ていない日なら今月（「毎月10日」で base が 5日のとき）
    d := public.month_day(ym / 12, ym % 12 + 1, md);
    if d > base then return d; end if;
    ym := ym + n;
    return public.month_day(ym / 12, ym % 12 + 1, md);
  elsif freq = 'year' then
    mo := coalesce((rule->>'month')::int, extract(month from base)::int);
    md := coalesce((rule->>'monthday')::int, extract(day from base)::int);
    d := public.month_day(extract(year from base)::int, mo, md);
    if d > base then return d; end if;
    return public.month_day(extract(year from base)::int + n, mo, md);
  end if;
  return base + n;
end
$$;

-- タスクを完了にする／戻す。
-- 繰り返しタスクを完了にしたときは done_at を付けず、期日（とやる日）を次の回へ進める。
--  'due'  : 元の期日から数えて、今日より後になるまで進める（溜まった回は飛ばす）
--  'done' : 今日から数える
create or replace function public.complete_task(p_id uuid, p_done boolean default true)
returns public.notes
language plpgsql security invoker as $$
declare
  n public.notes;
  today date := public.jst_today();
  base date;
  nxt date;
  shift int;
  guard int := 0;
begin
  select * into n from public.notes where id = p_id for update;
  if not found then raise exception 'note not found'; end if;

  if not p_done then
    update public.notes set done_at = null, updated_at = now() where id = p_id returning * into n;
    return n;
  end if;

  if n.repeat_rule is null then
    update public.notes set done_at = now(), updated_at = now() where id = p_id returning * into n;
    return n;
  end if;

  base := coalesce(n.due_date, n.scheduled_date);
  if n.repeat_from = 'done' or base is null then
    nxt := public.next_occurrence(n.repeat_rule, today);
  else
    nxt := public.next_occurrence(n.repeat_rule, base);
    while nxt <= today and guard < 1000 loop
      nxt := public.next_occurrence(n.repeat_rule, nxt);
      guard := guard + 1;
    end loop;
  end if;

  -- やる日は期日との差を保ったまま動かす
  shift := case when n.scheduled_date is not null and n.due_date is not null then n.due_date - n.scheduled_date end;
  update public.notes set
    due_date       = case when n.due_date is not null or n.scheduled_date is null then nxt else null end,
    scheduled_date = case when n.scheduled_date is null then null
                          when n.due_date is null then nxt
                          else nxt - shift end,
    done_at        = null,
    last_done_at   = now(),
    done_count     = n.done_count + 1,
    updated_at     = now()
  where id = p_id returning * into n;
  return n;
end
$$;

grant execute on function public.complete_task(uuid, boolean) to authenticated, service_role;
grant execute on function public.next_occurrence(jsonb, date) to authenticated, service_role;
grant execute on function public.jst_today() to authenticated, service_role;
