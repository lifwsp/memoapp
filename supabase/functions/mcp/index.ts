// POST /functions/v1/mcp  — Muse など AI から使う MCP サーバー（Streamable HTTP・ステートレス）
// 認証: Authorization: Bearer <MCP_TOKEN>
// できること: メモ・タスク（繰り返し含む）の検索・読み取り・追加・編集・完了・アーカイブ、タグ一覧、
//   今日・今後の予定表（タスク＋Google カレンダー）、カレンダーへの予定追加。削除はできない。
import {
  admin,
  cors,
  googleConnected,
  json,
  listCalendarEvents,
  OWNER_USER_ID,
  sendNote,
  timingSafeEqual,
} from "../_shared/integrations.ts";
import { asRule, describeRepeat, firstOccurrence, jstToday, parseRepeat, type RepeatRule } from "../_shared/repeat.ts";

// 時刻のないタスクを知らせる時刻（日本時間）
const DEFAULT_REMIND_TIME = "09:00";

const MCP_TOKEN = Deno.env.get("MCP_TOKEN") ?? "";
const PROTOCOL = "2025-06-18";

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

const PRIORITY = { type: "number", description: "優先度 0=なし 1=低 2=中 3=高" };
const TASK_FIELDS = {
  tags: { type: "array", items: { type: "string" }, description: "タグ（例: 買い物, 仕事）。# は付けない" },
  is_task: { type: "boolean", description: "true にするとタスクとして扱う（完了チェックが付く）" },
  due_date: { type: "string", description: "締め切り日 YYYY-MM-DD（日本時間）。空文字で消す" },
  due_time: { type: "string", description: "締め切り時刻 HH:MM（日本時間）。空文字で消す" },
  scheduled_date: { type: "string", description: "取り組む予定の日 YYYY-MM-DD。締め切りとは別。空文字で消す" },
  priority: PRIORITY,
  repeat: {
    type: "string",
    description:
      "繰り返し（日本語）。例: 毎日 / 平日 / 毎週火曜 / 月水金 / 隔週日曜 / 3週間ごと / 4日ごと / 毎月1日 / 毎月末 / 6ヶ月ごと / 毎年11月30日。空文字で繰り返しをやめる。繰り返しタスクには due_date が要る（省くと規則に合う最初の日になる）",
  },
  repeat_from: {
    type: "string",
    enum: ["due", "done"],
    description: "繰り返しの次の回をどこから数えるか。due=元の期日から（毎月1日の支払いなど）/ done=完了した日から（3週間ごとの布団カバー交換など）。既定 due",
  },
};

const tools = [
  {
    name: "list_tasks",
    description:
      "WristMemo のタスク（is_task のメモ）を一覧する。view: today=今日やること（予定日か締め切りが今日以前の未完了）, overdue=締め切りを過ぎた未完了, upcoming=明日以降に予定・締め切りがある未完了, inbox=日付のない未完了, done=最近完了したもの, all=未完了すべて。日付はすべて日本時間。各タスクの remind_at は知らせるべき日時（due_time がなければ 9:00）、repeat_text は繰り返しの説明。",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["today", "overdue", "upcoming", "inbox", "done", "all"] },
        tag: { type: "string", description: "このタグが付いたものだけ" },
        days: { type: "number", description: "upcoming の範囲（日数、既定 14）" },
      },
      required: ["view"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_notes",
    description:
      "WristMemo のメモを検索する。query を省くと新しい順。source=watch はウォッチから音声などで入れたもの。tags が空で未アーカイブのメモは「受信箱」（未整理）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "本文・タイトルに含まれる語（日本語可）" },
        tag: { type: "string", description: "このタグが付いたものだけ" },
        inbox: { type: "boolean", description: "true なら受信箱（タグなし・未アーカイブ・完了していない）だけ" },
        tasks_only: { type: "boolean" },
        include_archived: { type: "boolean" },
        include_done: { type: "boolean", description: "完了したタスクも含める（既定 false）" },
        since: { type: "string", description: "この日時以降に作られたものだけ（ISO 8601）" },
        limit: { type: "number", description: "最大件数（既定 20、最大 100）" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_tags",
    description: "使われているタグと件数の一覧。新しいタグを作る前に、既存のタグに合うものがないか確かめるのに使う。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_note",
    description: "メモ1件を ID で読む。カレンダーに送った記録も返す。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_note",
    description: "メモかタスクを新しく作る。タスクにするなら is_task=true と、分かれば due_date / scheduled_date を入れる。",
    inputSchema: {
      type: "object",
      properties: { body: { type: "string" }, title: { type: "string" }, pinned: { type: "boolean" }, ...TASK_FIELDS },
      required: ["body"],
    },
  },
  {
    name: "edit_note",
    description:
      "既存メモを編集する。渡した項目だけ変わる。append は本文末尾への追記（全置き換えより安全）。add_tags / remove_tags でタグを足し引きできる。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string", description: "本文を全部置き換える" },
        append: { type: "string", description: "本文の末尾に改行して追記する" },
        pinned: { type: "boolean" },
        archived: { type: "boolean" },
        add_tags: { type: "array", items: { type: "string" } },
        remove_tags: { type: "array", items: { type: "string" } },
        ...TASK_FIELDS,
      },
      required: ["id"],
    },
  },
  {
    name: "complete_task",
    description: "タスクを完了にする（done=false で未完了に戻す）。タスクでないメモに使うと、タスクにしてから完了にする。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, done: { type: "boolean", description: "既定 true" } },
      required: ["id"],
    },
  },
  {
    name: "agenda",
    description:
      "今日から days 日分の予定表。WristMemo のタスク（締め切り・やる日がその日のもの）と Google カレンダーの予定を日付ごとに並べて返す。今日の分には期限切れのタスクも入る。朝の確認や「今週の予定は？」に使う。カレンダーが未接続ならタスクだけ返す。",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", description: "何日分か（既定 1 = 今日だけ、最大 31）" } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_to_calendar",
    description: "メモを Google カレンダーの予定にする。日付は必須（text から読むか date で渡す）。time がなければ終日。",
    inputSchema: {
      type: "object",
      properties: {
        note_id: { type: "string" },
        text: { type: "string", description: "予定名（日時の言葉を含めてよい）。省略時はメモのタイトルか本文" },
        date: { type: "string", description: "YYYY-MM-DD（日本時間）" },
        time: { type: "string", description: "HH:MM（日本時間）" },
        duration_min: { type: "number", description: "長さ（分）。既定 60" },
      },
      required: ["note_id"],
    },
  },
];

const COLS =
  "id,title,body,tags,is_task,done_at,due_date,due_time,scheduled_date,priority,repeat_rule,repeat_from,last_done_at,pinned,archived,source,input_kind,created_at,updated_at";

function todayJst(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

type Row = Record<string, unknown>;
/** Muse が読みやすいよう、繰り返しの説明と知らせる日時を足す */
function present(r: Row | null): Row | null {
  if (!r) return r;
  const out: Row = { ...r };
  const rule = asRule(r.repeat_rule);
  if (rule) out.repeat_text = describeRepeat(rule, r.repeat_from as "due" | "done");
  const day = (r.due_date ?? r.scheduled_date) as string | null;
  if (r.is_task && !r.done_at && day) {
    const t = ((r.due_time as string | null) ?? DEFAULT_REMIND_TIME).slice(0, 5);
    out.remind_at = `${day}T${t}:00+09:00`;
  }
  return out;
}
const presentAll = (rows: Row[] | null) => (rows ?? []).map((r) => present(r)!);
const cleanTags = (v: unknown) =>
  Array.isArray(v)
    ? [...new Set(v.filter((t): t is string => typeof t === "string").map((t) => t.replace(/^#/, "").trim()).filter(Boolean))]
    : undefined;
const dateOrNull = (v: unknown) => (typeof v === "string" ? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null) : undefined);
const timeOrNull = (v: unknown) => (typeof v === "string" ? (/^\d{1,2}:\d{2}$/.test(v) ? v : null) : undefined);

/** create / edit で共通のタスク属性を patch に入れる */
function taskFields(a: Args, patch: Record<string, unknown>) {
  const tags = cleanTags(a.tags);
  if (tags) patch.tags = tags;
  if (typeof a.is_task === "boolean") patch.is_task = a.is_task;
  for (const k of ["due_date", "scheduled_date"]) if (dateOrNull(a[k]) !== undefined) patch[k] = dateOrNull(a[k]);
  if (timeOrNull(a.due_time) !== undefined) patch.due_time = timeOrNull(a.due_time);
  if (typeof a.priority === "number") patch.priority = Math.max(0, Math.min(3, Math.round(a.priority)));
  if (typeof a.repeat === "string") {
    if (!a.repeat.trim()) patch.repeat_rule = null;
    else {
      const p = parseRepeat(a.repeat);
      if (!p) throw new Error(`繰り返しを読み取れませんでした: ${a.repeat}（例: 毎月1日 / 3週間ごと / 毎週火曜）`);
      patch.repeat_rule = p.rule;
      if (p.from && a.repeat_from === undefined) patch.repeat_from = p.from;
      patch.is_task = true;
    }
  }
  if (a.repeat_from === "due" || a.repeat_from === "done") patch.repeat_from = a.repeat_from;
  // 日付を付けたらタスクとみなす
  if ((patch.due_date || patch.scheduled_date) && patch.is_task === undefined) patch.is_task = true;
}

/** 繰り返しなのに日付がないときは、規則に合う最初の日を期日にする */
function fillFirstDue(patch: Row, cur?: Row) {
  const rule = (patch.repeat_rule ?? (patch.repeat_rule === undefined ? cur?.repeat_rule : null)) as RepeatRule | null;
  if (!rule) return;
  const due = patch.due_date !== undefined ? patch.due_date : cur?.due_date;
  const sch = patch.scheduled_date !== undefined ? patch.scheduled_date : cur?.scheduled_date;
  if (!due && !sch) patch.due_date = firstOccurrence(rule, jstToday());
}

async function callTool(name: string, a: Args) {
  const sb = admin();
  // service role で動くので、必ず持ち主のメモ・削除されていないメモに絞る
  const mine = () => sb.from("notes").select(COLS).eq("user_id", OWNER_USER_ID).is("deleted_at", null);

  switch (name) {
    case "list_tasks": {
      const today = todayJst();
      let q = mine().eq("is_task", true).eq("archived", false);
      const view = str(a.view) ?? "today";
      if (view === "done") {
        q = q.not("done_at", "is", null).order("done_at", { ascending: false }).limit(30);
      } else {
        q = q.is("done_at", null);
        if (view === "today") q = q.or(`scheduled_date.lte.${today},due_date.lte.${today}`);
        else if (view === "overdue") q = q.lt("due_date", today);
        else if (view === "upcoming") {
          const until = todayJst(Number(a.days) || 14);
          q = q.or(
            `and(scheduled_date.gt.${today},scheduled_date.lte.${until}),and(due_date.gt.${today},due_date.lte.${until})`,
          );
        } else if (view === "inbox") q = q.is("due_date", null).is("scheduled_date", null);
        q = q
          .order("due_date", { ascending: true, nullsFirst: false })
          .order("priority", { ascending: false })
          .order("created_at", { ascending: true })
          .limit(100);
      }
      if (str(a.tag)) q = q.contains("tags", [str(a.tag)!.replace(/^#/, "")]);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return { today, view, tasks: presentAll(data) };
    }
    case "search_notes": {
      let q = mine().order("created_at", { ascending: false }).limit(Math.min(Number(a.limit) || 20, 100));
      if (!a.include_archived) q = q.eq("archived", false);
      if (!a.include_done) q = q.is("done_at", null);
      if (a.tasks_only) q = q.eq("is_task", true);
      if (a.inbox) q = q.eq("tags", "{}");
      if (str(a.tag)) q = q.contains("tags", [str(a.tag)!.replace(/^#/, "")]);
      if (str(a.since)) q = q.gte("created_at", str(a.since)!);
      const query = str(a.query)?.trim();
      if (query) {
        const like = `%${query.replace(/[%_,()]/g, " ")}%`;
        q = q.or(`body.ilike.${like},title.ilike.${like}`);
      }
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return presentAll(data);
    }
    case "list_tags": {
      const { data, error } = await sb.from("notes").select("tags").eq("user_id", OWNER_USER_ID).is("deleted_at", null);
      if (error) throw new Error(error.message);
      const count: Record<string, number> = {};
      for (const r of data ?? []) for (const t of r.tags ?? []) count[t] = (count[t] ?? 0) + 1;
      return Object.entries(count)
        .sort((x, y) => y[1] - x[1])
        .map(([tag, n]) => ({ tag, count: n }));
    }
    case "read_note": {
      const { data, error } = await mine().eq("id", str(a.id) ?? "").maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("メモが見つかりません");
      const { data: links } = await sb
        .from("external_links")
        .select("type,status,title,due,url,error,created_at")
        .eq("note_id", data.id)
        .order("created_at");
      return { ...present(data), sent_to: links ?? [] };
    }
    case "create_note": {
      const body = str(a.body)?.trim();
      if (!body) throw new Error("body が空です");
      const row: Record<string, unknown> = {
        user_id: OWNER_USER_ID,
        body,
        title: str(a.title) || null,
        pinned: !!a.pinned,
        source: "mcp",
      };
      taskFields(a, row);
      fillFirstDue(row);
      const { data, error } = await sb.from("notes").insert(row).select(COLS).single();
      if (error) throw new Error(error.message);
      return present(data);
    }
    case "edit_note": {
      const id = str(a.id) ?? "";
      const { data: cur } = await mine().eq("id", id).maybeSingle();
      if (!cur) throw new Error("メモが見つかりません");
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (str(a.title) !== undefined) patch.title = str(a.title) || null;
      if (str(a.body) !== undefined) patch.body = str(a.body);
      if (str(a.append)) patch.body = `${(patch.body as string | undefined) ?? cur.body}\n${str(a.append)}`;
      if (typeof a.pinned === "boolean") patch.pinned = a.pinned;
      if (typeof a.archived === "boolean") patch.archived = a.archived;
      taskFields(a, patch);
      fillFirstDue(patch, cur);
      const add = cleanTags(a.add_tags) ?? [];
      const remove = new Set(cleanTags(a.remove_tags) ?? []);
      if (add.length || remove.size) {
        const base = (patch.tags as string[] | undefined) ?? (cur.tags as string[]);
        patch.tags = [...new Set([...base, ...add])].filter((t) => !remove.has(t));
      }
      const { data, error } = await sb.from("notes").update(patch).eq("id", id).eq("user_id", OWNER_USER_ID).select(COLS).single();
      if (error) throw new Error(error.message);
      return present(data);
    }
    case "complete_task": {
      const id = str(a.id) ?? "";
      const done = a.done !== false;
      const { data: cur } = await mine().eq("id", id).maybeSingle();
      if (!cur) throw new Error("メモが見つかりません");
      if (!cur.is_task) await sb.from("notes").update({ is_task: true }).eq("id", id);
      // 繰り返しタスクは完了にすると期日が次の回へ進む（DB の complete_task が計算する）
      const { error } = await sb.rpc("complete_task", { p_id: id, p_done: done });
      if (error) throw new Error(error.message);
      const { data } = await mine().eq("id", id).single();
      const r = present(data)!;
      if (cur.repeat_rule && done) return { ...r, message: `繰り返しタスクなので、次の回（${r.due_date ?? r.scheduled_date}）に進めました` };
      return r;
    }
    case "agenda": {
      const days = Math.max(1, Math.min(31, Math.round(Number(a.days) || 1)));
      const today = todayJst();
      const until = todayJst(days - 1);
      const { data: tasks, error } = await mine()
        .eq("is_task", true)
        .eq("archived", false)
        .is("done_at", null)
        .or(`due_date.lte.${until},scheduled_date.lte.${until}`)
        .order("due_time", { ascending: true, nullsFirst: true })
        .limit(300);
      if (error) throw new Error(error.message);
      const connected = await googleConnected(sb);
      let events: Awaited<ReturnType<typeof listCalendarEvents>> = [];
      let calendar_error: string | undefined;
      if (connected) {
        try {
          events = await listCalendarEvents(sb, today, until);
        } catch (e) {
          calendar_error = e instanceof Error ? e.message : String(e);
        }
      }
      const byDay: Record<string, { date: string; events: unknown[]; tasks: unknown[] }> = {};
      for (let i = 0; i < days; i++) {
        const d = todayJst(i);
        byDay[d] = { date: d, events: [], tasks: [] };
      }
      for (const e of events) {
        for (const d of Object.keys(byDay)) if (e.date <= d && d <= e.end_date) byDay[d].events.push(e);
      }
      const overdue: unknown[] = [];
      for (const t of tasks ?? []) {
        const day = ([t.scheduled_date, t.due_date].filter(Boolean) as string[]).sort()[0];
        const r = present(t)!;
        if (day < today) {
          overdue.push(r);
          byDay[today].tasks.push({ ...r, overdue: true });
        } else if (byDay[day]) byDay[day].tasks.push(r);
      }
      return {
        today,
        calendar: connected ? (calendar_error ? `error: ${calendar_error}` : "ok") : "not_connected",
        overdue_count: overdue.length,
        days: Object.values(byDay),
      };
    }
    case "add_to_calendar": {
      const { data: note } = await mine().eq("id", str(a.note_id) ?? "").maybeSingle();
      if (!note) throw new Error("メモが見つかりません");
      const r = await sendNote(sb, {
        noteId: note.id,
        target: "calendar",
        text: str(a.text) || note.title || note.body,
        ...(str(a.date) !== undefined ? { date: str(a.date)!, time: str(a.time) ?? null } : {}),
        durationMin: typeof a.duration_min === "number" ? a.duration_min : undefined,
        description: note.title ? `${note.title}\n${note.body}` : note.body,
        via: "mcp",
      });
      if (!r.ok) throw new Error(r.error);
      return r;
    }
  }
  throw new Error(`unknown tool: ${name}`);
}

type RpcReq = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

async function handle(msg: RpcReq) {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: (msg.params?.protocolVersion as string) ?? PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "wristmemo", version: "0.4.0" },
        instructions: [
          "WristMemo は持ち主ひとり用のメモ帳兼タスク管理。ウォッチから音声で入れた短いメモが多く、誤変換を含むことがある。",
          "メモには tags（複数可）が付く。タグのないメモは「受信箱」＝未整理。整理を頼まれたら list_tags で既存タグを確かめてから edit_note の add_tags で付ける。",
          "タスクは is_task=true のメモ。due_date は締め切り、scheduled_date は取り組む予定の日で、別物として扱う。「今日やること」は list_tasks view=today。",
          "繰り返しタスクは repeat（「毎月1日」「3週間ごと」など）と repeat_from（due=期日から / done=完了日から）を持つ。complete_task すると完了扱いにはならず、期日が次の回へ進む。",
          "完了は complete_task。タスクの置き場は WristMemo だけ（Todoist は使わない）。",
          "予定（日時の決まった出来事）は Google カレンダーが本体。WristMemo に予定をメモとしてコピーしない。予定を作るなら add_to_calendar、見るなら agenda。",
          "通知: 持ち主への通知は Muse の役目。各タスクの remind_at（時刻のないタスクは 9:00）に知らせる。毎朝 agenda で今日の予定と期限切れを確かめ、その日の remind_at にリマインダーを設定するとよい。",
          "メモの削除はできない。日付はすべて日本時間。",
        ].join("\n"),
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      try {
        const data = await callTool(name, (msg.params?.arguments as Args) ?? {});
        return ok({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: { result: data } });
      } catch (e) {
        return ok({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!MCP_TOKEN || !timingSafeEqual(token, MCP_TOKEN)) return json(401, { error: "unauthorized" });
  // ステートレスなので、サーバーから送る SSE ストリームやセッション終了は持たない
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...cors, Allow: "POST" } });

  let payload: RpcReq | RpcReq[];
  try {
    payload = await req.json();
  } catch {
    return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  const list = Array.isArray(payload) ? payload : [payload];
  const responses = [];
  for (const m of list) {
    if (m.id === undefined || m.id === null) continue; // 通知（notifications/initialized など）には返事しない
    responses.push(await handle(m));
  }
  if (responses.length === 0) return new Response(null, { status: 202, headers: cors });
  return json(200, Array.isArray(payload) ? responses : responses[0]);
});
