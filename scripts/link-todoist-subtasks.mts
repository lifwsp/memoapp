// 10/26 の Todoist 取り込みで平たくしたサブタスクを、WristMemo の親子（parent_id）に戻す。一度だけ流す。
// 使い方: node --experimental-strip-types scripts/link-todoist-subtasks.mts [--dry]
//   環境変数: TODOIST_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OWNER_USER_ID
// Todoist は読むだけ（何も書き換えない）。親子は client_id = "todoist:<id>" で突き合わせるので推測はしない。
// 本文の末尾に付けた「（「親」の一部）」は消す。親が取り込まれていない・孫（2階層目）のものは飛ばして一覧に出す。
// 何度流しても同じ結果になる（parent_id がすでに入っているものは触らない）。
const env = process.env;
const dry = process.argv.includes("--dry");
for (const k of ["TODOIST_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OWNER_USER_ID"])
  if (!env[k]) throw new Error(`環境変数 ${k} がありません`);

async function td(path: string) {
  const out: any[] = [];
  let cursor = "";
  do {
    const r = await fetch(`https://api.todoist.com/api/v1/${path}?limit=200${cursor ? `&cursor=${cursor}` : ""}`, {
      headers: { Authorization: `Bearer ${env.TODOIST_TOKEN}` },
    });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    out.push(...j.results);
    cursor = j.next_cursor ?? "";
  } while (cursor);
  return out;
}

const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

type Row = { id: string; client_id: string; body: string; parent_id: string | null };
const r = await rest(
  `notes?select=id,client_id,body,parent_id&user_id=eq.${env.OWNER_USER_ID}&client_id=like.todoist:*`,
);
if (!r.ok) throw new Error(`notes: ${r.status} ${await r.text()}`);
const notes: Row[] = await r.json();
const byTodoist = new Map(notes.map((n) => [n.client_id.slice("todoist:".length), n]));

const tasks = await td("tasks");
const tById = new Map(tasks.map((t) => [String(t.id), t]));
const plain = (s: string) => s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1").trim();

const plan: { child: Row; parent: Row; body: string; order: number; label: string }[] = [];
const skipped: string[] = [];
for (const t of tasks) {
  if (!t.parent_id) continue;
  const child = byTodoist.get(String(t.id));
  const parentTask = tById.get(String(t.parent_id));
  const parent = byTodoist.get(String(t.parent_id));
  const label = `${plain(t.content)} ← ${parentTask ? plain(parentTask.content) : `(Todoist ${t.parent_id})`}`;
  if (!child) {
    skipped.push(`未取り込み: ${label}`);
    continue;
  }
  if (child.parent_id) continue; // もう繋いである
  if (!parent) {
    skipped.push(`親が未取り込み（Todoist で完了済みなど）: ${label}`);
    continue;
  }
  if (parentTask?.parent_id) {
    skipped.push(`孫（WristMemo は1階層まで）: ${label}`);
    continue;
  }
  const suffix = parentTask ? `\n\n（「${plain(parentTask.content)}」の一部）` : "";
  const body = suffix && child.body.endsWith(suffix) ? child.body.slice(0, -suffix.length) : child.body;
  plan.push({ child, parent, body, order: Number(t.child_order ?? 0), label });
}

console.log(`繋ぐ: ${plan.length} 件 / 飛ばす: ${skipped.length} 件`);
for (const p of plan) console.log(`  ${p.label}`);
for (const s of skipped) console.log(`  [飛ばす] ${s}`);
if (dry) process.exit(0);

// 1階層まで・持ち主が同じかは DB のトリガー（0007_subtasks.sql）でも確かめる
let failed = 0;
for (const p of plan) {
  const u = await rest(`notes?id=eq.${p.child.id}&parent_id=is.null`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ parent_id: p.parent.id, body: p.body, sort_order: p.order, updated_at: new Date().toISOString() }),
  });
  if (!u.ok) {
    failed++;
    console.error(`失敗: ${p.label}: ${u.status} ${await u.text()}`);
  }
}
console.log(failed ? `${failed} 件失敗しました` : "完了");
