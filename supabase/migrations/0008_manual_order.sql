-- 手で並べ替えられる順番。どの一覧（受信箱・すべて・タグ・予定の各日）でも同じ1本の並びを使う（小さいほど上）。
-- ドラッグで動かしたときは、前後の値の間（中点）を入れるだけなので、書き換えるのは動かした1件だけ。
-- 新しいメモは「今」の時刻から作る負の値になり、いちばん上に来る（今までの「新しい順」と同じ）。
-- サブタスクは親の中で小さい順（末尾に足すときはアプリ側で 最大+1 を入れる）。
alter table public.notes alter column sort_order type double precision;
alter table public.notes alter column sort_order set default (-extract(epoch from now()))::double precision;

-- 今あるメモ（サブタスク以外）は作った順の並びにしておく
update public.notes set sort_order = -extract(epoch from created_at)::double precision where parent_id is null;
