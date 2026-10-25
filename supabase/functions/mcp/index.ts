// POST /functions/v1/mcp  — Muse など AI から使う MCP サーバー（Streamable HTTP・ステートレス）
// 認証: Authorization: Bearer <MCP_TOKEN>
// できること: メモ・タスクの検索・読み取り・追加・編集・完了・アーカイブ、タグ一覧、Todoist / カレンダーへ送る。削除はできない。
import { admin, cors, json, OWNER_USER_ID, sendNote, timingSafeEqual } from "../_shared/integrations.ts";

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
};

const tools = [
  {
    name: "list_tasks",
    description:
      "WristMemo のタスク（is_task のメモ）を一覧する。view: today=今日やること（予定日か締め切りが今日以前の未完了）, overdue=締め切りを過ぎた未完了, upcoming=明日以降に予定・締め切りがある未完了, inbox=日付のない未完了, done=最近完了したもの, all=未完了すべて。日付はすべて日本時間。",
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
    description: "メモ1件を ID で読む。Todoist やカレンダーに送った記録も返す。",
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
    name: "send_to_todoist",
    description:
      "メモを Todoist にもタスクとして送る（片方向。Todoist 側で完了しても WristMemo には反映されない）。WristMemo のタスクで足りるなら使わなくてよい。",
    inputSchema: {
      type: "object",
      properties: {
        note_id: { type: "string" },
        text: { type: "string", description: "タスク名。省略時はメモのタイトルか本文" },
        date: { type: "string", description: "YYYY-MM-DD（日本時間）" },
        time: { type: "string", description: "HH:MM（日本時間）" },
      },
      required: ["note_id"],
    },
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
  "id,title,body,tags,is_task,done_at,due_date,due_time,scheduled_date,priority,pinned,archived,source,input_kind,created_at,updated_at";

function todayJst(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}
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
  // 日付を付けたらタスクとみなす
  if ((patch.due_date || patch.scheduled_date) && patch.is_task === undefined) patch.is_task = true;
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
      return { today, view, tasks: data };
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
      return data;
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
      return { ...data, sent_to: links ?? [] };
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
      const { data, error } = await sb.from("notes").insert(row).select(COLS).single();
      if (error) throw new Error(error.message);
      return data;
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
      const add = cleanTags(a.add_tags) ?? [];
      const remove = new Set(cleanTags(a.remove_tags) ?? []);
      if (add.length || remove.size) {
        const base = (patch.tags as string[] | undefined) ?? (cur.tags as string[]);
        patch.tags = [...new Set([...base, ...add])].filter((t) => !remove.has(t));
      }
      const { data, error } = await sb.from("notes").update(patch).eq("id", id).eq("user_id", OWNER_USER_ID).select(COLS).single();
      if (error) throw new Error(error.message);
      return data;
    }
    case "complete_task": {
      const id = str(a.id) ?? "";
      const done = a.done !== false;
      const { data, error } = await sb
        .from("notes")
        .update({ is_task: true, done_at: done ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("user_id", OWNER_USER_ID)
        .is("deleted_at", null)
        .select(COLS)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("メモが見つかりません");
      return data;
    }
    case "send_to_todoist":
    case "add_to_calendar": {
      const { data: note } = await mine().eq("id", str(a.note_id) ?? "").maybeSingle();
      if (!note) throw new Error("メモが見つかりません");
      const r = await sendNote(sb, {
        noteId: note.id,
        target: name === "send_to_todoist" ? "todoist" : "calendar",
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
        serverInfo: { name: "wristmemo", version: "0.3.0" },
        instructions: [
          "WristMemo は持ち主ひとり用のメモ帳兼タスク管理。ウォッチから音声で入れた短いメモが多く、誤変換を含むことがある。",
          "メモには tags（複数可）が付く。タグのないメモは「受信箱」＝未整理。整理を頼まれたら list_tags で既存タグを確かめてから edit_note の add_tags で付ける。",
          "タスクは is_task=true のメモ。due_date は締め切り、scheduled_date は取り組む予定の日で、別物として扱う。「今日やること」は list_tasks view=today。",
          "完了は complete_task。Todoist やカレンダーへの送信は頼まれたときだけ。メモの削除はできない。日付はすべて日本時間。",
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
