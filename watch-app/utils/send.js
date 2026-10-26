// 未送信メモを1件ずつ Side Service（スマホの Zepp アプリ内）へ送る。page は BasePage（this.request を持つ）
import { log as Logger } from "@zos/utils";
import { loadQueue, saveQueue, saveSync } from "./queue";

const logger = Logger.getLogger("wristmemo");

export async function flushQueue(page, onChange) {
  let queue = loadQueue();
  const tried = {};
  // 送信中に新しいメモが追加されても取りこぼさないよう、未試行がなくなるまで回す
  let memo;
  while ((memo = queue.find((m) => m.status !== "sent" && !tried[m.id]))) {
    tried[memo.id] = true;
    try {
      const res = await page.request({
        method: "ADD_NOTE",
        params: { id: memo.id, text: memo.text, kind: memo.kind, type: memo.type, tags: memo.tags, createdAt: memo.createdAt },
      });
      memo.status = res && res.ok ? "sent" : "error";
      memo.error = res && !res.ok ? String(res.error || "") : undefined;
    } catch (e) {
      // BLE 切断・Side Service 未起動など。次回起動時に再送する
      logger.log("send failed", e && (e.message || e.reason));
      memo.status = "error";
      memo.error = "phone";
      queue.forEach((m) => { tried[m.id] = true; });
    } finally {
      queue = saveQueue(queue);
      onChange && onChange(queue);
    }
  }
  return queue.filter((m) => m.status !== "sent").length;
}

/** よく使うタグと今日のタスク・予定を取ってきて保存する。失敗したら null */
export async function syncFromPhone(page) {
  try {
    const res = await page.request({ method: "SYNC", params: {} });
    if (!res || !res.ok) return null;
    const data = { date: res.date, tags: res.tags || [], tasks: res.tasks || [], events: res.events || [] };
    saveSync(data);
    return data;
  } catch (e) {
    return null;
  }
}
