-- 他サービスからの一回限りの取り込み（Todoist など）を source='import' として区別する
alter table public.notes drop constraint if exists notes_source_check;
alter table public.notes add constraint notes_source_check check (source in ('web','watch','mcp','import'));
