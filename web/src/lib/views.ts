import type { Note } from "./supabase";

// 「受信箱」「今日」などは保存場所ではなく、メモの属性から作る絞り込み結果（MCP の list_tasks と同じ定義）
export type View =
  | { kind: "inbox" }
  | { kind: "today" } // 「予定」: 期限切れ・今日・明日以降のタスクとカレンダーの予定を日付順に1本で見る
  | { kind: "all" }
  | { kind: "tag"; tag: string }
  | { kind: "archive" }
  | { kind: "trash" }
  | { kind: "settings" };

export const VIEW_LABEL: Record<Exclude<View["kind"], "tag">, string> = {
  inbox: "受信箱",
  today: "予定",
  all: "すべて",
  archive: "アーカイブ",
  trash: "ゴミ箱",
  settings: "連携",
};

export const viewKey = (v: View) => (v.kind === "tag" ? `tag:${v.tag}` : v.kind);
export const viewLabel = (v: View) => (v.kind === "tag" ? `#${v.tag}` : VIEW_LABEL[v.kind]);

/** 日本時間の今日（+n 日）を YYYY-MM-DD で */
export function jstDate(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

const live = (n: Note) => !n.deleted_at && !n.archived;
// サブタスクは親の中に並べる。一覧に単独で出すのは「予定」で日付があるときだけ
const top = (n: Note) => !n.parent_id;
const open = (n: Note) => !(n.is_task && n.done_at);
export const isOverdue = (n: Note, today = jstDate()) => n.is_task && !n.done_at && !!n.due_date && n.due_date < today;

export function filterNotes(notes: Note[], view: View, showDone: boolean): Note[] {
  const today = jstDate();
  switch (view.kind) {
    case "inbox":
      return pinnedFirst(notes.filter((n) => live(n) && open(n) && top(n) && n.tags.length === 0));
    case "today":
      return notes
        .filter(
          (n) =>
            live(n) &&
            n.is_task &&
            (showDone ? n.done_at && n.done_at.slice(0, 10) >= jstDate(-1) : open(n) && (n.scheduled_date || n.due_date)),
        )
        .sort((a, b) => (dayOf(a, today) ?? "").localeCompare(dayOf(b, today) ?? "") || byTask(a, b));
    case "all":
      return pinnedFirst(notes.filter((n) => live(n) && top(n) && (showDone || open(n))));
    case "tag":
      return pinnedFirst(notes.filter((n) => live(n) && top(n) && (showDone || open(n)) && n.tags.includes(view.tag)));
    case "archive":
      return notes.filter((n) => !n.deleted_at && top(n) && n.archived);
    case "trash":
      return notes.filter((n) => n.deleted_at);
    case "settings":
      return [];
  }
}

// notes は新しい順で届くので、安定ソートでピン留めだけ前に出す
const pinnedFirst = (ns: Note[]) => [...ns].sort((a, b) => Number(b.pinned) - Number(a.pinned));

/**
 * 「予定」で見出しに使う日。期限切れは "overdue"、やる日か締め切りが今日までなら今日、
 * それ以外は早いほうの日付。日付がなければ null。
 */
export function dayOf(n: Note, today = jstDate()): string | null {
  if (n.due_date && n.due_date < today) return "overdue";
  const ds = [n.scheduled_date, n.due_date].filter((d): d is string => !!d).sort();
  if (!ds.length) return null;
  return ds[0] < today ? today : ds[0];
}

/** 今日のバッジに出す数（期限切れ＋今日） */
export const isDueNow = (n: Note, today = jstDate()) => {
  const d = dayOf(n, today);
  return d === "overdue" || d === today;
};

function byTask(a: Note, b: Note) {
  // 締め切りが近い順 → 優先度が高い順 → 古い順
  const da = a.due_date ?? "9999";
  const db = b.due_date ?? "9999";
  return da.localeCompare(db) || b.priority - a.priority || a.created_at.localeCompare(b.created_at);
}

export function searchNotes(notes: Note[], q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return notes.filter((n) => {
    if (n.deleted_at) return false;
    const hay = `${n.title ?? ""}\n${n.body}\n${n.tags.map((t) => `#${t}`).join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function countTags(notes: Note[]) {
  const c = new Map<string, number>();
  for (const n of notes) if (live(n) && top(n) && open(n)) for (const t of n.tags) c.set(t, (c.get(t) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"));
}

const WD = "日月火水木金土";
/** 2026-10-27 → 「今日」「明日」「10/27(火)」 */
export function formatDay(d: string, today = jstDate()) {
  if (d === today) return "今日";
  if (d === jstDate(1)) return "明日";
  if (d === jstDate(-1)) return "昨日";
  const t = new Date(`${d}T00:00:00Z`);
  const md = `${t.getUTCMonth() + 1}/${t.getUTCDate()}(${WD[t.getUTCDay()]})`;
  return d.slice(0, 4) === today.slice(0, 4) ? md : `${d.slice(0, 4)}/${md}`;
}

/** 一覧で見せる1行目（タイトルか本文の最初の行） */
export const headline = (n: Note) => (n.title?.trim() || n.body.split("\n")[0] || "（空のメモ）").slice(0, 200);

/** クイック追加の文から「#タグ」を取り出す */
export function extractTags(text: string) {
  const tags: string[] = [];
  const rest = text
    .replace(/(^|\s)[#＃]([^\s#＃]+)/g, (_, sp, t) => {
      tags.push(t);
      return sp;
    })
    .replace(/\s{2,}/g, " ")
    .trim();
  return { tags: [...new Set(tags)], rest };
}

/** 親 id → サブタスク（並び順）。ゴミ箱のものは除く */
export function childrenOf(notes: Note[]) {
  const m = new Map<string, Note[]>();
  for (const n of notes) {
    if (!n.parent_id || n.deleted_at) continue;
    const list = m.get(n.parent_id) ?? [];
    list.push(n);
    m.set(n.parent_id, list);
  }
  for (const list of m.values()) list.sort(bySortOrder);
  return m;
}
export const bySortOrder = (a: Note, b: Note) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at);
