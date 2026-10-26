// Side Service: iPhone / Android の Zepp アプリ内で動く。
// ウォッチからの依頼を、設定画面で入れた受け口 URL（watch-notes）へ HTTPS で中継する。
//   ADD_NOTE → action add（メモ・タスク・予定の登録）
//   PREVIEW  → action preview（送る前の読み取り結果）
//   SYNC     → action sync（よく使うタグと今日のタスク・予定）
//   COMPLETE / RESTORE → タスクの完了とその取り消し
import { BaseSideService } from "@zeppos/zml/base-side";
import { DEFAULT_ENDPOINT, DEFAULT_TOKEN } from "./config";

async function post(settings, payload) {
  const endpoint = settings.getItem("endpoint") || DEFAULT_ENDPOINT;
  const token = settings.getItem("token") || DEFAULT_TOKEN;
  if (!endpoint) return { ok: false, error: "endpoint未設定" };

  const res = await fetch({
    url: endpoint,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  let data = res.body;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (e) {
      data = {};
    }
  }
  const ok = res.status >= 200 && res.status < 300;
  return ok ? { ok: true, ...(data || {}) } : { ok: false, error: (data && data.error) || `HTTP ${res.status}` };
}

function payloadFor(req) {
  const p = req.params || {};
  switch (req.method) {
    case "ADD_NOTE":
      return {
        action: "add",
        client_id: p.id, // 冪等キー：同じIDは受け口で1回だけ登録する
        body: p.text,
        type: p.type, // memo | task | event（古いウォッチは無し）
        tags: p.tags || [],
        source: "watch",
        input_kind: p.kind,
        created_at: new Date(p.createdAt).toISOString(),
      };
    case "PREVIEW":
      return { action: "preview", body: p.text, type: p.type };
    case "SYNC":
      return { action: "sync" };
    case "COMPLETE":
      return { action: "complete", id: p.id };
    case "RESTORE":
      return { action: "restore", id: p.id, before: p.before };
  }
  return null;
}

AppSideService(
  BaseSideService({
    onInit() {},
    onRequest(req, res) {
      const payload = payloadFor(req);
      if (!payload) return res(null, { ok: false, error: "unknown method" });
      post(this.settings, payload)
        .then((r) => res(null, r))
        .catch((e) => res(null, { ok: false, error: (e && e.message) || "network" }));
    },
    onRun() {},
    onDestroy() {},
  })
);
