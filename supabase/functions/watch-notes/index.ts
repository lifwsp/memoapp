// POST /functions/v1/watch-notes
// ウォッチ（Zepp Side Service）からのメモ受け口。
// 認証: Authorization: Bearer <WATCH_TOKEN>（自分専用の長いランダム文字列）
// 環境変数: WATCH_TOKEN, OWNER_USER_ID（+ Supabase が自動で入れる URL / SERVICE_ROLE_KEY）
// デプロイ: supabase functions deploy watch-notes --no-verify-jwt
import { createClient } from "jsr:@supabase/supabase-js@2";

const WATCH_TOKEN = Deno.env.get("WATCH_TOKEN") ?? "";
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? "";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

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
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await sb.from("notes").upsert(
    {
      user_id: OWNER_USER_ID,
      body,
      source: "watch",
      input_kind: p.input_kind === "voice" ? "voice" : "text",
      client_id: clientId,
      created_at: typeof p.created_at === "string" ? p.created_at : new Date().toISOString(),
    },
    { onConflict: "user_id,client_id", ignoreDuplicates: true },
  );
  if (error) return json(500, { error: error.message });
  return json(200, { ok: true });
});
