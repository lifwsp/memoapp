import { createClient } from "@supabase/supabase-js";
import { authStorage, requestPersistentStorage } from "./authStorage";
import type { RepeatFrom, RepeatRule } from "./repeat";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, storage: authStorage },
});
requestPersistentStorage();

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
  tags: string[];
  is_task: boolean;
  done_at: string | null;
  due_date: string | null; // YYYY-MM-DD
  due_time: string | null; // HH:MM:SS
  scheduled_date: string | null;
  priority: number; // 0 なし / 1 低 / 2 中 / 3 高
  repeat_rule: RepeatRule | null; // 繰り返し（null = 1回きり）
  repeat_from: RepeatFrom; // 次の回を期日から数えるか、完了日から数えるか
  last_done_at: string | null;
  done_count: number;
  created_at: string;
  updated_at: string;
};

export type ExternalLink = {
  id: string;
  note_id: string;
  type: "todoist" | "calendar"; // todoist は以前の送信記録だけ
  status: "ok" | "error";
  url: string | null;
  title: string | null;
  due: string | null;
  error: string | null;
  via: "web" | "watch" | "mcp";
  created_at: string;
};
