-- Phase 2: Todoist / Google カレンダーへ送った記録と、外部サービスの認証情報

-- メモ → 外部サービスへ送った記録（片方向）。PWA はこれを読んでメモに「送信済み」を出す
create table if not exists public.external_links (
  id            uuid primary key default gen_random_uuid(),
  note_id       uuid not null references public.notes(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  type          text not null check (type in ('todoist','calendar')),
  status        text not null default 'ok' check (status in ('ok','error')),
  external_id   text,
  url           text,
  title         text,
  due           text,          -- 送った日時（表示用。例: 2026-10-26 15:00）
  error         text,
  via           text not null default 'web' check (via in ('web','watch','mcp')),
  created_at    timestamptz not null default now()
);
create index if not exists external_links_note_idx on public.external_links(note_id);

alter table public.external_links enable row level security;
create policy "own links" on public.external_links
  for select using (auth.uid() = user_id);
grant select on public.external_links to authenticated;
grant all on public.external_links to service_role;
alter publication supabase_realtime add table public.external_links;

-- 外部サービスの認証情報（Google の refresh token など）。サーバー（service_role）だけが触る
create table if not exists public.integration_tokens (
  provider      text primary key,             -- 'google'
  refresh_token text,
  access_token  text,
  expires_at    timestamptz,
  account       text,                         -- 表示用（メールアドレスなど）
  updated_at    timestamptz not null default now()
);
alter table public.integration_tokens enable row level security;
-- ポリシーなし + authenticated / anon に権限なし = ブラウザからは一切読めない
grant all on public.integration_tokens to service_role;

-- OAuth の state（CSRF 対策）を短時間だけ置く
create table if not exists public.oauth_states (
  state       text primary key,
  created_at  timestamptz not null default now()
);
alter table public.oauth_states enable row level security;
grant all on public.oauth_states to service_role;
