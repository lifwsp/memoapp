// POST /functions/v1/watch-notes
// ウォッチ（Zepp Side Service）からのメモ受け口。
// 認証: Authorization: Bearer <WATCH_TOKEN>（自分専用の長いランダム文字列）
// 環境変数: WATCH_TOKEN, OWNER_USER_ID（+ Supabase が自動で入れる URL / SERVICE_ROLE_KEY）
// 先頭の言葉で振り分け: 「タスク、…」→ Todoist、「予定、明日15時 …」→ Google カレンダー。メモ自体は必ず残す。
// デプロイ: supabase functions deploy watch-notes --no-verify-jwt
import { admin, json, OWNER_USER_ID, sendNote, timingSafeEqual } from "../_shared/integrations.ts";
import { routeByPrefix } from "../_shared/jpdate.ts";

const WATCH_TOKEN = Deno.env.get("WATCH_TOKEN") ?? "";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!WATCH_TOKEN || !timingSafeEqual(token, WATCH_TOKEN)) return json(401, { error: "unauthorized" });

  let p: Record<string, unknown>;
  try {
    p = await req.json();
  } catch {
    return json(400, { error: "invalid json" });
  }
  const body = typeof p.body === "string" ? p.body.trim() : "";
  const clientId = typeof p.client_id === "string" ? p.client_id.slice(0, 64) : null;
  if (!body || body.length > 5000) return json(400, { error: "body required (<=5000 chars)" });

  // service role で書き込むので、user_id は必ずサーバー側で固定する（RLS をバイパスするため）
  const sb = admin();
  const { data: inserted, error } = await sb
    .from("notes")
    .upsert(
      {
        user_id: OWNER_USER_ID,
        body,
        source: "watch",
        input_kind: p.input_kind === "voice" ? "voice" : "text",
        client_id: clientId,
        created_at: typeof p.created_at === "string" ? p.created_at : new Date().toISOString(),
      },
      { onConflict: "user_id,client_id", ignoreDuplicates: true },
    )
    .select("id");
  if (error) return json(500, { error: error.message });

  // 再送（重複）のときは inserted が空になるので、二重に送らない
  const noteId = inserted?.[0]?.id as string | undefined;
  const route = routeByPrefix(body);
  if (noteId && route) {
    const r = await sendNote(sb, { noteId, target: route.target, text: route.text, via: "watch" });
    // 送れなくてもメモは保存済み。ウォッチには成功を返し、失敗は PWA に表示する
    return json(200, { ok: true, routed: route.target, sent: r.ok });
  }
  return json(200, { ok: true });
});
