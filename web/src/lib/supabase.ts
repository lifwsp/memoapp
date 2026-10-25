import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export type Note = {
  id: string;
  user_id: string;
  title: string | null;
  body: string;
  pinned: boolean;
  archived: boolean;
  deleted_at: string | null;
  source: "web" | "watch" | "mcp";
  input_kind: string | null;
  created_at: string;
  updated_at: string;
};
