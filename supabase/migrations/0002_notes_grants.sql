-- 新しい Supabase プロジェクトは public のテーブルに自動で権限を付けないため、明示する。
-- anon（未ログイン）には何も渡さない。authenticated は RLS で自分の行だけに絞られる。
grant select, insert, update, delete on public.notes to authenticated;
grant all on public.notes to service_role;
