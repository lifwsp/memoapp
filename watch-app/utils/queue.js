// 送信待ちメモのキュー。ウォッチ内の LocalStorage に保存し、
// アプリを閉じても未送信分が消えないようにする。
import { LocalStorage } from "@zos/storage";

const KEY = "memo_queue_v1";
const MAX_SENT_KEPT = 5; // 送信済みは直近5件だけ残す（表示用）
const storage = new LocalStorage();

export function loadQueue() {
  try {
    const raw = storage.getItem(KEY, "[]");
    const list = JSON.parse(raw || "[]");
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

export function saveQueue(list) {
  const pending = list.filter((m) => m.status !== "sent");
  const sent = list.filter((m) => m.status === "sent").slice(-MAX_SENT_KEPT);
  const merged = [...pending, ...sent].sort((a, b) => a.createdAt - b.createdAt);
  storage.setItem(KEY, JSON.stringify(merged));
  return merged;
}

export function newMemo(text, kind) {
  const now = Date.now();
  return {
    // 受け口側で二重登録を防ぐためのID（クライアント生成）
    id: `w${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    text,
    kind, // "voice" | "text"
    createdAt: now,
    status: "pending", // "pending" | "sent" | "error"
  };
}
