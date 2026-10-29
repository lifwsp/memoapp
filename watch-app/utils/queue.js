// 送信待ちメモのキューと、スマホから取ってきた情報のキャッシュ。
// ウォッチ内の LocalStorage に保存し、アプリを閉じても未送信分が消えないようにする。
import { LocalStorage } from "@zos/storage";

const KEY = "memo_queue_v1";
const SYNC_KEY = "sync_v1";
const MAX_SENT_KEPT = 5; // 送信済みは直近5件だけ残す（表示用）
const storage = new LocalStorage();

function read(key, fallback) {
  try {
    const v = JSON.parse(storage.getItem(key, "") || "null");
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

export function loadQueue() {
  const list = read(KEY, []);
  return Array.isArray(list) ? list : [];
}

export function saveQueue(list) {
  const pending = list.filter((m) => m.status !== "sent");
  const sent = list.filter((m) => m.status === "sent").slice(-MAX_SENT_KEPT);
  const merged = [...pending, ...sent].sort((a, b) => a.createdAt - b.createdAt);
  storage.setItem(KEY, JSON.stringify(merged));
  return merged;
}

/** type: "memo" | "task" | "event"、kind: "voice" | "text" */
export function newMemo(text, kind, type, tags) {
  const now = Date.now();
  return {
    // 受け口側で二重登録を防ぐためのID（クライアント生成）
    id: `w${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    text,
    kind,
    type: type || "memo",
    tags: tags || [],
    createdAt: now,
    status: "pending", // "pending" | "sent" | "error"
  };
}

// { date, at, tags: [], tasks: [{id,title,overdue,time,due,repeat,left}], events: [{title,time}] }
// at: 同期した時刻（ms）。ウィジェットの「◯時◯分 更新」に使う
export function loadSync() {
  return read(SYNC_KEY, { date: "", tags: [], tasks: [], events: [] });
}
export function saveSync(data) {
  storage.setItem(SYNC_KEY, JSON.stringify(data));
}
