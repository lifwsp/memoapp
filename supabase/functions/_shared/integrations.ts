// Todoist / Google カレンダーへ送る処理（watch-notes・integrations・mcp から共通で使う）
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { parseWhen } from "./jpdate.ts";

export const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? "";
const TODOIST_TOKEN = Deno.env.get("TODOIST_TOKEN") ?? "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const GOOGLE_CALENDAR_ID = Deno.env.get("GOOGLE_CALENDAR_ID") ?? "primary";
export const APP_URL = Deno.env.get("APP_URL") ?? "https://lifwsp.github.io/memoapp/";
export const FUNCTIONS_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
// Google の承認済みドメインに supabase.co は登録できないため、戻り先は PWA 自身にする
export const GOOGLE_REDIRECT_URI = APP_URL;

export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

export type Target = "todoist" | "calendar";
export type SendInput = {
  noteId: string;
  target: Target;
  text: string; // タイトルにする文（日時の言葉を含んでいてよい）
  date?: string | null; // YYYY-MM-DD。省略時は text から読み取る
  time?: string | null; // HH:MM。null なら終日
  durationMin?: number;
  description?: string;
  via: "web" | "watch" | "mcp";
};
export type SendResult = { ok: true; url: string | null; title: string; due: string | null } | { ok: false; error: string };

function resolve(input: SendInput) {
  if (input.date !== undefined) {
    return { title: input.text.trim(), date: input.date, time: input.time ?? null };
  }
  const p = parseWhen(input.text);
  return { title: (p?.rest || input.text).trim(), date: p?.date ?? null, time: p?.time ?? null };
}

/** JST の日付と時刻 → UTC の ISO 文字列 */
function jstToIso(date: string, time: string, addMin = 0) {
  const t = new Date(`${date}T${time}:00+09:00`).getTime() + addMin * 60_000;
  return new Date(t).toISOString();
}

async function sendTodoist(title: string, date: string | null, time: string | null, description: string) {
  if (!TODOIST_TOKEN) throw new Error("Todoist のトークンが未設定です");
  const body: Record<string, unknown> = { content: title, description };
  if (date && time) body.due_datetime = jstToIso(date, time);
  else if (date) body.due_date = date;
  const res = await fetch("https://api.todoist.com/api/v1/tasks", {
    method: "POST",
    headers: { Authorization: `Bearer ${TODOIST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Todoist ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const task = await res.json();
  return { id: String(task.id), url: `https://app.todoist.com/app/task/${task.id}` };
}

export async function googleAccessToken(sb: SupabaseClient): Promise<string> {
  const { data } = await sb.from("integration_tokens").select("*").eq("provider", "google").maybeSingle();
  if (!data?.refresh_token) throw new Error("Google カレンダーが未接続です");
  if (data.access_token && data.expires_at && new Date(data.expires_at).getTime() > Date.now() + 60_000) {
    return data.access_token;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: data.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const tok = await res.json();
  if (!res.ok) throw new Error(`Google トークン更新に失敗: ${tok.error ?? res.status}（接続し直してください）`);
  await sb
    .from("integration_tokens")
    .update({
      access_token: tok.access_token,
      expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("provider", "google");
  return tok.access_token;
}

async function sendCalendar(
  sb: SupabaseClient,
  title: string,
  date: string,
  time: string | null,
  durationMin: number,
  description: string,
) {
  const token = await googleAccessToken(sb);
  const event: Record<string, unknown> = { summary: title, description };
  if (time) {
    event.start = { dateTime: jstToIso(date, time), timeZone: "Asia/Tokyo" };
    event.end = { dateTime: jstToIso(date, time, durationMin), timeZone: "Asia/Tokyo" };
  } else {
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    event.start = { date };
    event.end = { date: next.toISOString().slice(0, 10) };
  }
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
    },
  );
  if (!res.ok) throw new Error(`Google カレンダー ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const ev = await res.json();
  return { id: String(ev.id), url: (ev.htmlLink as string) ?? null };
}

/** メモを外部サービスへ送り、結果を external_links に記録する */
export async function sendNote(sb: SupabaseClient, input: SendInput): Promise<SendResult> {
  const { title, date, time } = resolve(input);
  const due = date ? `${date}${time ? ` ${time}` : ""}` : null;
  const description = input.description ?? "WristMemo から送信";
  try {
    if (!title) throw new Error("タイトルが空です");
    let out: { id: string; url: string | null };
    if (input.target === "todoist") out = await sendTodoist(title, date, time, description);
    else {
      if (!date) throw new Error("日付が読み取れませんでした（例: 明日15時 歯医者）");
      out = await sendCalendar(sb, title, date, time, input.durationMin ?? 60, description);
    }
    await sb.from("external_links").insert({
      note_id: input.noteId,
      user_id: OWNER_USER_ID,
      type: input.target,
      status: "ok",
      external_id: out.id,
      url: out.url,
      title,
      due,
      via: input.via,
    });
    return { ok: true, url: out.url, title, due };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await sb.from("external_links").insert({
      note_id: input.noteId,
      user_id: OWNER_USER_ID,
      type: input.target,
      status: "error",
      title,
      due,
      error,
      via: input.via,
    });
    return { ok: false, error };
  }
}

export function googleConfigured() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}
export function todoistConfigured() {
  return !!TODOIST_TOKEN;
}
export function googleAuthUrl(state: string) {
  const q = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.events openid email",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}
export async function googleExchange(code: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const tok = await res.json();
  if (!res.ok) throw new Error(tok.error_description ?? tok.error ?? `status ${res.status}`);
  let account: string | null = null;
  if (tok.id_token) {
    try {
      const payload = JSON.parse(atob(tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      account = payload.email ?? null;
    } catch { /* 表示用なので失敗してもよい */ }
  }
  return { ...tok, account } as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    account: string | null;
  };
}

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, mcp-session-id, mcp-protocol-version",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};
export const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
