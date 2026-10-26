// Todoist の未完了タスクを WristMemo に一回だけ取り込む。
// 使い方: node --experimental-strip-types scripts/import-todoist.mts [--dry]
//   環境変数: TODOIST_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OWNER_USER_ID
// プロジェクト名はタグに（Inbox はタグなし＝受信箱）。繰り返しは repeat_rule に変換。
// client_id = "todoist:<id>" なので、何度流しても二重にはならない。
import { parseRepeat } from "../supabase/functions/_shared/repeat.ts";

const env = process.env;
const dry = process.argv.includes("--dry");
const td = async (path: string) => {
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
};

const [tasks, projects] = await Promise.all([td("tasks"), td("projects")]);
const pname = new Map(projects.map((p) => [p.id, p.name as string]));
const byId = new Map(tasks.map((t) => [t.id, t]));
const plain = (s: string) => s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1").trim();

const rows = tasks.map((t) => {
  const project = pname.get(t.project_id) ?? "";
  const tags = [project !== "Inbox" ? project : "", ...t.labels.filter((l: string) => l !== "GCal")].filter(Boolean);
  const parent = t.parent_id ? byId.get(t.parent_id) : null;
  const body = [t.content, t.description, parent ? `（「${plain(parent.content)}」の一部）` : ""].filter(Boolean).join("\n\n");
  let due_date: string | null = null, due_time: string | null = null, repeat_rule = null;
  if (t.due) {
    const d: string = t.due.date;
    if (d.includes("T")) {
      // 末尾 Z は UTC → 日本時間へ。Z なしは現地時刻そのまま
      const dt = d.endsWith("Z") ? new Date(new Date(d).getTime() + 9 * 3600e3) : new Date(d + "Z");
      due_date = dt.toISOString().slice(0, 10);
      due_time = dt.toISOString().slice(11, 16);
    } else due_date = d;
    if (t.due.is_recurring) {
      const p = parseRepeat(t.due.string);
      if (!p) console.warn("繰り返しを読めません:", t.content, t.due.string);
      repeat_rule = p?.rule ?? null;
      // 「1ヶ月ごと」「1年毎」は日にちを今の期日に固定する（31日→30日のようにずれていかないように）
      if (repeat_rule && due_date) {
        const [, m, day] = due_date.split("-").map(Number);
        if (repeat_rule.freq === "month" && repeat_rule.monthday === undefined) repeat_rule.monthday = day;
        if (repeat_rule.freq === "year" && repeat_rule.month === undefined) Object.assign(repeat_rule, { month: m, monthday: day });
      }
    }
  }
  return {
    user_id: env.OWNER_USER_ID,
    client_id: `todoist:${t.id}`,
    source: "import",
    title: plain(t.content).slice(0, 200),
    body,
    tags,
    // 受信箱のものと期日つきはタスク、それ以外のプロジェクト（ほん・物欲など）はリストなのでメモにする
    is_task: project === "Inbox" || !!t.due,
    due_date,
    due_time,
    repeat_rule,
    repeat_from: "due",
    priority: Math.max(0, (t.priority ?? 1) - 1),
    created_at: t.added_at,
  };
});

console.log(`${rows.length} 件（期日あり ${rows.filter((r) => r.due_date).length}、繰り返し ${rows.filter((r) => r.repeat_rule).length}）`);
if (dry) {
  console.log(JSON.stringify(rows.filter((r) => r.due_date), null, 1));
  process.exit(0);
}
const r = await fetch(`${env.SUPABASE_URL}/rest/v1/notes?on_conflict=user_id,client_id`, {
  method: "POST",
  headers: {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "resolution=ignore-duplicates,return=minimal",
  },
  body: JSON.stringify(rows),
});
console.log(r.status, await r.text());
