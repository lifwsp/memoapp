import { supabase } from "./supabase";

const base = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/integrations`;

export type Parsed = { date: string; time: string | null; rest: string } | null;
export type Status = { google: { configured: boolean; connected: boolean; account: string | null } };
export type CalendarEvent = {
  id: string;
  calendar: string;
  color: string | null;
  title: string;
  date: string; // 開始日（日本時間）
  end_date: string; // 最終日
  start_time: string | null;
  end_time: string | null;
  all_day: boolean;
  location: string | null;
  url: string | null;
};
export type EventsResult = { connected: boolean; events: CalendarEvent[]; error?: string };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${data.session?.access_token ?? ""}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `エラー ${res.status}`);
  return json as T;
}

export const api = {
  status: () => call<Status>("/status"),
  preview: (text: string) => call<{ parsed: Parsed }>("/preview", { text }).then((r) => r.parsed),
  events: (from: string, to: string) => call<EventsResult>(`/events?from=${from}&to=${to}`),
  send: (p: { note_id: string; target: "calendar"; text: string; date: string | null; time: string | null }) =>
    call<{ ok: true; url: string | null }>("/send", p),
  googleStart: () => call<{ url: string }>("/google/start", {}),
  googleExchange: (code: string, state: string) =>
    call<{ ok: true; account: string | null }>("/google/exchange", { code, state }),
  googleDisconnect: () => call<{ ok: true }>("/google/disconnect", {}),
};
