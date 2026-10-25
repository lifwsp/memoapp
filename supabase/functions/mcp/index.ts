// POST /functions/v1/mcp  — Muse など AI から使う MCP サーバー（Streamable HTTP・ステートレス）
// 認証: Authorization: Bearer <MCP_TOKEN>
// できること: メモの検索・読み取り・追加・編集・アーカイブ、Todoist / カレンダーへ送る。削除はできない。
import { admin, cors, json, OWNER_USER_ID, sendNote, timingSafeEqual } from "../_shared/integrations.ts";

const MCP_TOKEN = Deno.env.get("MCP_TOKEN") ?? "";
const PROTOCOL = "2025-06-18";

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

const tools = [
  {
    name: "search_notes",
    description:
      "WristMemo のメモを検索する。query を省くと新しい順に返す。ウォッチから音声で入れたメモは source=watch。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "本文・タイトルに含まれる語（日本語可）" },
        limit: { type: "number", description: "最大件数（既定 20、最大 100）" },
        include_archived: { type: "boolean", description: "アーカイブ済みも含める" },
        since: { type: "string", description: "この日時以降に作られたメモだけ（ISO 8601）" },
      },
    },
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
    description: "メモを新しく作る。",
    inputSchema: {
      type: "object",
      properties: { body: { type: "string" }, title: { type: "string" }, pinned: { type: "boolean" } },
      required: ["body"],
    },
  },
  {
    name: "edit_note",
    description:
      "既存メモを編集する。渡した項目だけ変わる。append を使うと本文の末尾に追記する（本文の全置き換えより安全）。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string", description: "本文を全部置き換える" },
        append: { type: "string", description: "本文の末尾に改行して追記する" },
        pinned: { type: "boolean" },
        archived: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "send_to_todoist",
    description:
      "メモを Todoist のタスクにする。text に「明日15時」のような日時が入っていれば期限になる。date/time を渡すとそちらを優先。",
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
    description:
      "メモを Google カレンダーの予定にする。日付は必須（text から読むか date で渡す）。time がなければ終日。",
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

const COLS = "id,title,body,pinned,archived,source,input_kind,created_at,updated_at";

async function callTool(name: string, a: Args) {
  const sb = admin();
  // service role で動くので、必ず持ち主のメモ・削除されていないメモに絞る
  const mine = () => sb.from("notes").select(COLS).eq("user_id", OWNER_USER_ID).is("deleted_at", null);

  switch (name) {
    case "search_notes": {
      let q = mine().order("created_at", { ascending: false }).limit(Math.min(Number(a.limit) || 20, 100));
      if (!a.include_archived) q = q.eq("archived", false);
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
      const { data, error } = await sb
        .from("notes")
        .insert({ user_id: OWNER_USER_ID, body, title: str(a.title) || null, pinned: !!a.pinned, source: "mcp" })
        .select(COLS)
        .single();
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
      const { data, error } = await sb.from("notes").update(patch).eq("id", id).eq("user_id", OWNER_USER_ID).select(COLS).single();
      if (error) throw new Error(error.message);
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
        serverInfo: { name: "wristmemo", version: "0.2.0" },
        instructions:
          "自分専用のメモ帳 WristMemo。ウォッチから音声で入れた短いメモが多い。予定やタスクにしたいメモは add_to_calendar / send_to_todoist を使う。メモの削除はできない。",
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
