// POST /functions/v1/watch-notes
// ウォッチ（Zepp Side Service）からの受け口。
// 認証: Authorization: Bearer <WATCH_TOKEN>（自分専用の長いランダム文字列）
// 環境変数: WATCH_TOKEN, OWNER_USER_ID（+ Supabase が自動で入れる URL / SERVICE_ROLE_KEY）
//
// action（省略時 "add"）:
//   add      {client_id, body, type?: memo|task|event, tags?, input_kind, created_at}
//            type=task → タスク（日時は締め切り、「毎月1日」などは繰り返し）、type=event → Google カレンダーへ。
//            type がない古いウォッチは先頭の言葉（「タスク、」「予定、」）で振り分ける。メモ自体は必ず残す。
//   preview  {body, type} → 送る前に読み取り結果を見せる
//   sync     → {tags: よく使うタグ, today: {tasks, events}}
//   complete {id} → タスクを完了（繰り返しは次の回へ）。戻すための before を返す
//   restore  {id, before} → complete の取り消し
// デプロイ: supabase functions deploy watch-notes --no-verify-jwt
import { admin, googleConnected, json, listCalendarEvents, OWNER_USER_ID, sendNote, timingSafeEqual } from "../_shared/integrations.ts";
import { parseWhen, routeByPrefix } from "../_shared/jpdate.ts";
import { asRule, describeRepeat, jstToday, taskFromText } from "../_shared/repeat.ts";

const WATCH_TOKEN = Deno.env.get("WATCH_TOKEN") ?? "";
type Sb = ReturnType<typeof admin>;
type Body = Record<string, unknown>;

const str = (v: unknown, max = 5000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const WD = "日月火水木金土";
const md = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}(${WD[new Date(`${d}T00:00:00Z`).getUTCDay()]})`;
const when = (d: string | null, t: string | null) => (d ? `${md(d)}${t ? ` ${t.slice(0, 5)}` : ""}` : "");

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((t) => str(t, 40).replace(/^#/, "")).filter(Boolean))].slice(0, 10);
}

/** 種類を決める。type がなければ先頭の言葉で */
function route(body: string, type: unknown): { type: "memo" | "task" | "event"; text: string } {
  if (type === "task" || type === "event") return { type, text: body };
  const r = routeByPrefix(body);
  if (r) return { type: r.target === "task" ? "task" : "event", text: r.text };
  return { type: "memo", text: body };
}

async function add(sb: Sb, p: Body) {
  const body = str(p.body);
  const clientId = str(p.client_id, 64) || null;
  if (!body) return json(400, { error: "body required (<=5000 chars)" });
  const r = route(body, p.type);
  // service role で書き込むので、user_id は必ずサーバー側で固定する（RLS をバイパスするため）
  const { data: inserted, error } = await sb
    .from("notes")
    .upsert(
      {
        user_id: OWNER_USER_ID,
        body,
        tags: cleanTags(p.tags),
        source: "watch",
        input_kind: p.input_kind === "voice" ? "voice" : "text",
        client_id: clientId,
        created_at: typeof p.created_at === "string" ? p.created_at : new Date().toISOString(),
      },
      { onConflict: "user_id,client_id", ignoreDuplicates: true },
    )
    .select("id");
  if (error) return json(500, { error: error.message });

  // 再送（重複）のときは inserted が空になるので、二重に処理しない
  const noteId = inserted?.[0]?.id as string | undefined;
  if (noteId && r.type === "task") {
    await sb.from("notes").update({ is_task: true, ...taskFromText(r.text) }).eq("id", noteId);
    return json(200, { ok: true, routed: "task" });
  }
  if (noteId && r.type === "event") {
    const s = await sendNote(sb, { noteId, target: "calendar", text: r.text, via: "watch" });
    // 送れなくてもメモは保存済み。ウォッチには成功を返し、失敗は PWA に表示する
    return json(200, { ok: true, routed: "calendar", sent: s.ok, ...(s.ok ? {} : { warn: s.error }) });
  }
  return json(200, { ok: true });
}

function preview(p: Body) {
  const body = str(p.body);
  const r = route(body, p.type);
  if (r.type === "task") {
    const f = taskFromText(r.text);
    const rule = asRule(f.repeat_rule);
    const parts = [f.due_date ? `締切 ${when(f.due_date, f.due_time)}` : "日付なし", rule ? describeRepeat(rule, f.repeat_from) : ""];
    return json(200, { ok: true, type: "task", title: f.title, info: parts.filter(Boolean).join(" · ") });
  }
  if (r.type === "event") {
    const w = parseWhen(r.text);
    if (!w) return json(200, { ok: true, type: "event", title: r.text, info: "日時が読み取れません", warn: true });
    return json(200, { ok: true, type: "event", title: w.rest || r.text, info: `${when(w.date, w.time)}${w.time ? "〜1時間" : " 終日"}` });
  }
  return json(200, { ok: true, type: "memo", title: body, info: "受信箱へ" });
}

async function sync(sb: Sb) {
  const today = jstToday();
  const [{ data: notes, error }, cal] = await Promise.all([
    sb
      .from("notes")
      .select("id,title,body,tags,is_task,done_at,due_date,due_time,scheduled_date,repeat_rule,repeat_from,priority,pinned,sort_order,created_at")
      .eq("user_id", OWNER_USER_ID)
      .is("deleted_at", null)
      .eq("archived", false),
    (async () => {
      try {
        if (!(await googleConnected(sb))) return { events: [] };
        return { events: await listCalendarEvents(sb, today, today) };
      } catch (e) {
        return { events: [], error: e instanceof Error ? e.message : String(e) };
      }
    })(),
  ]);
  if (error) return json(500, { error: error.message });

  const count = new Map<string, number>();
  for (const n of notes ?? []) for (const t of n.tags ?? []) count.set(t, (count.get(t) ?? 0) + 1);
  const tags = [...count].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);

  const tasks = (notes ?? [])
    .filter((n) => n.is_task && !n.done_at)
    .map((n) => {
      const overdue = !!n.due_date && n.due_date < today;
      const d = [n.scheduled_date, n.due_date].filter(Boolean).sort()[0] as string | undefined;
      return { n, overdue, due: overdue || (!!d && d <= today) };
    })
    .filter((x) => x.due)
    // PWA の「予定」と同じ並び: 期限切れが先、その中は手で並べた順（sort_order が小さいほど上）
    .sort(
      (a, b) =>
        Number(b.overdue) - Number(a.overdue) ||
        a.n.sort_order - b.n.sort_order ||
        String(b.n.created_at).localeCompare(String(a.n.created_at)),
    )
    .slice(0, 30)
    .map(({ n, overdue }) => ({
      id: n.id,
      title: (n.title || n.body.split("\n")[0] || "").slice(0, 60),
      overdue,
      time: n.due_time ? String(n.due_time).slice(0, 5) : null,
      due: overdue ? md(n.due_date!) : null,
      repeat: n.repeat_rule ? describeRepeat(asRule(n.repeat_rule)) : null,
    }));
  const events = cal.events
    .filter((e) => e.date <= today && today <= e.end_date)
    .map((e) => ({ title: e.title.slice(0, 60), time: e.all_day ? null : e.start_time }));
  return json(200, { ok: true, date: today, tags, tasks, events, ...(cal.error ? { calendar_error: cal.error } : {}) });
}

async function complete(sb: Sb, p: Body) {
  const id = str(p.id, 64);
  const { data: before } = await sb
    .from("notes")
    .select("done_at,due_date,scheduled_date,last_done_at,done_count")
    .eq("id", id)
    .eq("user_id", OWNER_USER_ID)
    .single();
  if (!before) return json(404, { error: "not found" });
  const { data, error } = await sb.rpc("complete_task", { p_id: id, p_done: true });
  if (error) return json(500, { error: error.message });
  const n = data as { done_at: string | null; due_date: string | null; scheduled_date: string | null };
  const next = n.done_at ? null : (n.due_date ?? n.scheduled_date);
  return json(200, { ok: true, next: next ? md(next) : null, before });
}

async function restore(sb: Sb, p: Body) {
  const id = str(p.id, 64);
  const b = (p.before ?? {}) as Body;
  const pick = (k: string) => (b[k] === null || typeof b[k] === "string" || typeof b[k] === "number" ? b[k] : undefined);
  const fields: Body = { updated_at: new Date().toISOString() };
  for (const k of ["done_at", "due_date", "scheduled_date", "last_done_at", "done_count"]) if (pick(k) !== undefined) fields[k] = pick(k);
  const { error } = await sb.from("notes").update(fields).eq("id", id).eq("user_id", OWNER_USER_ID);
  return error ? json(500, { error: error.message }) : json(200, { ok: true });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!WATCH_TOKEN || !timingSafeEqual(token, WATCH_TOKEN)) return json(401, { error: "unauthorized" });

  let p: Body;
  try {
    p = await req.json();
  } catch {
    return json(400, { error: "invalid json" });
  }
  const sb = admin();
  switch (p.action ?? "add") {
    case "add":
      return add(sb, p);
    case "preview":
      return preview(p);
    case "sync":
      return sync(sb);
    case "complete":
      return complete(sb, p);
    case "restore":
      return restore(sb, p);
    default:
      return json(400, { error: "unknown action" });
  }
});
