import { supabase } from "./supabase";

const base = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/integrations`;

export type Parsed = { date: string; time: string | null; rest: string } | null;
export type Status = { todoist: boolean; google: { configured: boolean; connected: boolean; account: string | null } };

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
  send: (p: { note_id: string; target: "todoist" | "calendar"; text: string; date: string | null; time: string | null }) =>
    call<{ ok: true; url: string | null }>("/send", p),
  googleStart: () => call<{ url: string }>("/google/start", {}),
  googleDisconnect: () => call<{ ok: true }>("/google/disconnect", {}),
};
