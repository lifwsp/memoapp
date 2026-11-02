-- 全メモ（完了・アーカイブ・ゴミ箱・サブタスクを含む）のタグを一括変更する。
-- invoker + RLS により呼び出しユーザーの行だけが対象。既存名への変更は重複を除いて統合。
create or replace function public.rename_tag(p_old text, p_new text)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  changed integer;
begin
  p_new := btrim(p_new);
  if p_old is null or p_old = '' or p_new is null or p_new = '' then
    raise exception 'タグ名を入力してください';
  end if;
  if p_old = p_new then
    return 0;
  end if;

  update public.notes n
  set tags = (
    select array_agg(t.tag order by t.first_position)
    from (
      select case when tag = p_old then p_new else tag end as tag, min(position) as first_position
      from unnest(n.tags) with ordinality as u(tag, position)
      group by case when tag = p_old then p_new else tag end
    ) t
  ), updated_at = now()
  where n.user_id = auth.uid() and n.tags @> array[p_old];
  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke all on function public.rename_tag(text, text) from public, anon;
grant execute on function public.rename_tag(text, text) to authenticated;
