// Zepp アプリ（スマホ）上の設定画面。受け口 URL とトークンを保存する。
AppSettingsPage({
  build(props) {
    const s = props.settingsStorage;
    const field = (label, key, placeholder) =>
      Section({}, [
        Text({ paragraph: true, style: { fontSize: "13px", color: "#666" } }, label),
        TextInput({
          label: s.getItem(key) ? (key === "token" ? "••••（設定済み）" : s.getItem(key)) : placeholder,
          value: s.getItem(key) || "",
          onChange: (val) => s.setItem(key, (val || "").trim()),
        }),
      ]);
    return View({ style: { padding: "12px 20px" } }, [
      field("受け口URL（HTTPS）", "endpoint", "https://…/watch-notes"),
      field("トークン", "token", "未設定"),
      Text({ paragraph: true, style: { fontSize: "12px", color: "#999", marginTop: "16px" } },
        "メモはウォッチ → このZeppアプリ → 受け口URL の順に送られます。"),
    ]);
  },
});
