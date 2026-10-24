-- 自分専用だが user_id + RLS は残す（トークン漏えい時の保険・将来の拡張用）
create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text,
  body        text not null default '',
  kind        text not null default 'text' check (kind in ('text','checklist')),
  pinned      boolean not null default false,
  archived    boolean not null default false,
  deleted_at  timestamptz,
  reminder_at timestamptz,
  source      text not null default 'web' check (source in ('web','watch','mcp')),
  input_kind  text,            -- watch: 'voice' | 'text'
  client_id   text,            -- ウォッチ側で振ったID（二重登録防止）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, client_id)
);

alter table public.notes enable row level security;

create policy "own notes" on public.notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter publication supabase_realtime add table public.notes;
