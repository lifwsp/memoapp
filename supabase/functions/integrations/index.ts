// /functions/v1/integrations/...  PWA から呼ぶ連携 API
//   GET  /status                 接続状況
//   POST /send                   メモを Todoist / カレンダーへ送る {note_id, target, text?, date?, time?, duration_min?}
//   POST /preview                日時の読み取り結果だけ返す {text}
//   POST /google/start           Google の同意画面 URL を返す
//   POST /google/exchange        PWA に戻ってきた code を渡して接続を完了 {code, state}
//   POST /google/disconnect      Google の接続を解除
// 認証: すべて Supabase のログイン JWT（Authorization: Bearer）。デプロイは --no-verify-jwt で、ここで確かめる。
import {
  admin,
  cors,
  googleAuthUrl,
  googleConfigured,
  googleExchange,
  json,
  OWNER_USER_ID,
  sendNote,
  todoistConfigured,
} from "../_shared/integrations.ts";
import { parseWhen } from "../_shared/jpdate.ts";

async function requireOwner(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await admin().auth.getUser(jwt);
  return data.user && data.user.id === OWNER_USER_ID ? data.user : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/integrations/, "") || "/";
  const sb = admin();

  if (!(await requireOwner(req))) return json(401, { error: "unauthorized" });

  if (path === "/status" && req.method === "GET") {
    const { data } = await sb.from("integration_tokens").select("account").eq("provider", "google").maybeSingle();
    return json(200, {
      todoist: todoistConfigured(),
      google: { configured: googleConfigured(), connected: !!data, account: data?.account ?? null },
    });
  }

  let p: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      p = await req.json();
    } catch { /* 本文なしの POST もある */ }
  }

  if (path === "/preview" && req.method === "POST") {
    return json(200, { parsed: parseWhen(String(p.text ?? "")) });
  }

  if (path === "/send" && req.method === "POST") {
    const noteId = String(p.note_id ?? "");
    const target = p.target === "calendar" ? "calendar" : p.target === "todoist" ? "todoist" : null;
    if (!noteId || !target) return json(400, { error: "note_id と target が必要です" });
    const { data: note } = await sb.from("notes").select("id,title,body").eq("id", noteId).maybeSingle();
    if (!note) return json(404, { error: "メモが見つかりません" });
    const text = typeof p.text === "string" && p.text.trim() ? p.text : note.title || note.body;
    const result = await sendNote(sb, {
      noteId,
      target,
      text,
      // date を渡したときは、画面で確かめた日時をそのまま使う（null = 日付なし）
      ...("date" in p ? { date: (p.date as string | null) || null, time: (p.time as string | null) || null } : {}),
      durationMin: typeof p.duration_min === "number" ? p.duration_min : undefined,
      description: note.title ? `${note.title}\n${note.body}` : note.body,
      via: "web",
    });
    return json(result.ok ? 200 : 502, result);
  }

  if (path === "/google/start" && req.method === "POST") {
    if (!googleConfigured()) return json(400, { error: "GOOGLE_CLIENT_ID / SECRET が未設定です" });
    const state = crypto.randomUUID();
    await sb.from("oauth_states").insert({ state });
    return json(200, { url: googleAuthUrl(state) });
  }

  // Google の同意画面から PWA に戻ってきたあと、PWA が code と state を渡してくる
  if (path === "/google/exchange" && req.method === "POST") {
    const state = String(p.state ?? "");
    const code = String(p.code ?? "");
    const { data: st } = await sb.from("oauth_states").delete().eq("state", state).select().maybeSingle();
    if (!st || Date.now() - new Date(st.created_at).getTime() > 10 * 60_000) {
      return json(400, { error: "やり直してください（state が無効か期限切れ）" });
    }
    if (!code) return json(400, { error: "code がありません" });
    try {
      const tok = await googleExchange(code);
      if (!tok.refresh_token) return json(400, { error: "refresh token が返りませんでした" });
      await sb.from("integration_tokens").upsert({
        provider: "google",
        refresh_token: tok.refresh_token,
        access_token: tok.access_token,
        expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
        account: tok.account,
        updated_at: new Date().toISOString(),
      });
      return json(200, { ok: true, account: tok.account });
    } catch (e) {
      return json(400, { error: e instanceof Error ? e.message : "exchange failed" });
    }
  }

  if (path === "/google/disconnect" && req.method === "POST") {
    await sb.from("integration_tokens").delete().eq("provider", "google");
    return json(200, { ok: true });
  }

  return json(404, { error: "not found" });
});
