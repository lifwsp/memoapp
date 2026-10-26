// Google カレンダーとの連携（watch-notes・integrations・mcp から共通で使う）
// 予定の本体はカレンダーに置く。WristMemo は予定を「書き込む」ことと「読んで並べる」ことだけをする。
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { parseWhen } from "./jpdate.ts";

export const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? "";
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

export type Target = "calendar";
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
    if (!date) throw new Error("日付が読み取れませんでした（例: 明日15時 歯医者）");
    out = await sendCalendar(sb, title, date, time, input.durationMin ?? 60, description);
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
export function googleAuthUrl(state: string) {
  const q = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    // 予定の書き込み（calendar.events）と、家族カレンダーなどを含む全カレンダーの読み取り（calendar.readonly）
    scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly openid email",
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

// ---------- カレンダーを読む（合流ビュー用） ----------

export type CalendarEvent = {
  id: string;
  calendar: string; // カレンダーの名前
  color: string | null;
  title: string;
  date: string; // 開始日 YYYY-MM-DD（日本時間）
  end_date: string; // 終了日（終日の予定は最終日。1日だけなら date と同じ）
  start_time: string | null; // HH:MM（終日なら null）
  end_time: string | null;
  all_day: boolean;
  location: string | null;
  url: string | null;
};

const jstDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const jstTime = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(11, 16);
const dayBefore = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
};

let calCache: { at: number; list: { id: string; name: string; color: string | null }[] } | null = null;


type Cal = { id: string; name: string; color: string | null };
async function calendars(token: string): Promise<Cal[]> {
  if (calCache && Date.now() - calCache.at < 10 * 60_000) return calCache.list;
  const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    if (res.status === 403) throw new Error("カレンダーを読む権限がありません（設定から Google を接続し直してください）");
    throw new Error(`Google カレンダー一覧 ${res.status}`);
  }
  const data = await res.json();
  const list = (data.items ?? [])
    // 表示をオフにしているカレンダーと、祝日などの購読カレンダーの一部はそのまま出す（selected で絞る）
    .filter((c: { selected?: boolean; hidden?: boolean }) => c.selected !== false && !c.hidden)
    .map((c: { id: string; summaryOverride?: string; summary?: string; backgroundColor?: string }) => ({
      id: c.id,
      name: c.summaryOverride ?? c.summary ?? c.id,
      color: c.backgroundColor ?? null,
    }));
  calCache = { at: Date.now(), list };
  return list;
}

/** from〜to（両端を含む、日本時間の日付）の予定をすべてのカレンダーから読む。繰り返し予定は1回ずつに展開される */
export async function listCalendarEvents(sb: SupabaseClient, from: string, to: string): Promise<CalendarEvent[]> {
  const token = await googleAccessToken(sb);
  const cals = await calendars(token);
  const timeMin = new Date(`${from}T00:00:00+09:00`).toISOString();
  const timeMax = new Date(new Date(`${to}T00:00:00+09:00`).getTime() + 86400_000).toISOString();
  const out: CalendarEvent[] = [];
  await Promise.all(
    cals.map(async (c) => {
      const q = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?${q}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return; // 読めないカレンダーは飛ばす
      const data = await res.json();
      for (const e of data.items ?? []) {
        if (e.status === "cancelled") continue;
        const allDay = !!e.start?.date;
        out.push({
          id: e.id,
          calendar: c.name,
          color: c.color,
          title: e.summary ?? "（タイトルなし）",
          date: allDay ? e.start.date : jstDate(e.start.dateTime),
          end_date: allDay ? dayBefore(e.end.date) : jstDate(e.end.dateTime),
          start_time: allDay ? null : jstTime(e.start.dateTime),
          end_time: allDay ? null : jstTime(e.end.dateTime),
          all_day: allDay,
          location: e.location ?? null,
          url: e.htmlLink ?? null,
        });
      }
    }),
  );
  return out.sort((a, b) => (a.date + (a.start_time ?? "")).localeCompare(b.date + (b.start_time ?? "")));
}

export async function googleConnected(sb: SupabaseClient) {
  const { data } = await sb.from("integration_tokens").select("provider").eq("provider", "google").maybeSingle();
  return !!data;
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
