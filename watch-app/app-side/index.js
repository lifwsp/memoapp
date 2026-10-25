// Side Service: iPhone / Android の Zepp アプリ内で動く。
// ウォッチから受け取ったメモを、設定画面で入れた受け口 URL に HTTPS で POST する。
import { BaseSideService } from "@zeppos/zml/base-side";
import { DEFAULT_ENDPOINT, DEFAULT_TOKEN } from "./config";

async function postNote(settings, params) {
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
    body: JSON.stringify({
      client_id: params.id, // 冪等キー：同じIDは受け口で1回だけ登録する
      body: params.text,
      source: "watch",
      input_kind: params.kind,
      created_at: new Date(params.createdAt).toISOString(),
    }),
  });
  const ok = res.status >= 200 && res.status < 300;
  return ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
}

AppSideService(
  BaseSideService({
    onInit() {},
    onRequest(req, res) {
      if (req.method !== "ADD_NOTE") return res(null, { ok: false, error: "unknown method" });
      postNote(this.settings, req.params)
        .then((r) => res(null, r))
        .catch((e) => res(null, { ok: false, error: (e && e.message) || "network" }));
    },
    onRun() {},
    onDestroy() {},
  })
);
