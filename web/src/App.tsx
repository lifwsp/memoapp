import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, type ExternalLink, type Note } from "./lib/supabase";
import { api, type Parsed, type Status } from "./lib/integrations";

type View = "notes" | "archive" | "trash" | "settings";

const OWNER_EMAIL = "owner@wristmemo.local";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!ready) return null;
  return session ? <Notes session={session} /> : <Login />;
}

function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await supabase.auth.signInWithPassword({ email: OWNER_EMAIL, password });
    if (error) setError("パスワードが違います");
    setBusy(false);
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>WristMemo</h1>
      <input
        type="password"
        placeholder="パスワード"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />
      <button disabled={busy || !password}>ログイン</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Notes({ session }: { session: Session }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [view, setView] = useState<View>(() => (location.hash.includes("google=") ? "settings" : "notes"));
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Note | null>(null);
  const [loadError, setLoadError] = useState("");
  const [links, setLinks] = useState<ExternalLink[]>([]);

  async function loadLinks() {
    const { data } = await supabase.from("external_links").select("*").order("created_at");
    if (data) setLinks(data as ExternalLink[]);
  }

  async function load() {
    const { data, error } = await supabase
      .from("notes")
      .select("*")
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) setLoadError(error.message);
    else {
      setLoadError("");
      setNotes(data as Note[]);
    }
  }

  useEffect(() => {
    load();
    const ch = supabase
      .channel("notes")
      .on("postgres_changes", { event: "*", schema: "public", table: "notes" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "external_links" }, () => loadLinks())
      .subscribe();
    loadLinks();
    // iPhone ではアプリが裏から戻ったときに接続が切れていることがあるので、表に出たら読み直す
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      load();
      loadLinks();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      supabase.removeChannel(ch);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notes
      .filter((n) =>
        view === "trash" ? n.deleted_at : !n.deleted_at && (view === "archive" ? n.archived : !n.archived),
      )
      .filter((n) => !q || `${n.title ?? ""}\n${n.body}`.toLowerCase().includes(q));
  }, [notes, view, query]);

  async function patch(id: string, fields: Partial<Note>) {
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, ...fields } : n)));
    const { error } = await supabase
      .from("notes")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      alert(`保存できませんでした: ${error.message}`);
      load();
    }
  }

  async function create(title: string, body: string) {
    const { data, error } = await supabase
      .from("notes")
      .insert({ user_id: session.user.id, title: title || null, body, source: "web" })
      .select()
      .single();
    if (error) return alert(`保存できませんでした: ${error.message}`);
    setNotes((ns) => [data as Note, ...ns.filter((n) => n.id !== (data as Note).id)]);
  }

  async function purge(id: string) {
    if (!confirm("完全に削除しますか？")) return;
    setNotes((ns) => ns.filter((n) => n.id !== id));
    await supabase.from("notes").delete().eq("id", id);
  }

  const pinned = view === "notes" ? shown.filter((n) => n.pinned) : [];
  const others = view === "notes" ? shown.filter((n) => !n.pinned) : shown;

  return (
    <div className="app">
      <header>
        <input
          className="search"
          type="search"
          placeholder="検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <nav>
          {(["notes", "archive", "trash", "settings"] as View[]).map((v) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
              {{ notes: "メモ", archive: "アーカイブ", trash: "ゴミ箱", settings: "連携" }[v]}
            </button>
          ))}
          <button className="logout" onClick={() => supabase.auth.signOut()}>
            ログアウト
          </button>
        </nav>
      </header>

      {loadError && <p className="error">読み込めませんでした: {loadError}</p>}
      {view === "settings" && <Settings />}
      {view === "notes" && !query && <Composer onCreate={create} />}

      {pinned.length > 0 && <h2>ピン留め</h2>}
      <NoteGrid notes={view === "settings" ? [] : pinned} links={links} onOpen={setEditing} />
      {pinned.length > 0 && others.length > 0 && <h2>その他</h2>}
      <NoteGrid notes={view === "settings" ? [] : others} links={links} onOpen={setEditing} />
      {view !== "settings" && shown.length === 0 && <p className="empty">{query ? "見つかりません" : "メモはありません"}</p>}

      {editing && (
        <Editor
          note={editing}
          links={links.filter((l) => l.note_id === editing.id)}
          onClose={() => setEditing(null)}
          onSave={(f) => patch(editing.id, f)}
          onPurge={() => {
            purge(editing.id);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function Composer({ onCreate }: { onCreate: (title: string, body: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  async function close() {
    if (title.trim() || body.trim()) await onCreate(title.trim(), body.trim());
    setTitle("");
    setBody("");
    setOpen(false);
  }

  if (!open)
    return (
      <div className="composer closed" onClick={() => setOpen(true)}>
        メモを入力…
      </div>
    );
  return (
    <div className="composer">
      <input placeholder="タイトル" value={title} onChange={(e) => setTitle(e.target.value)} />
      <AutoTextarea autoFocus placeholder="メモを入力…" value={body} onChange={setBody} />
      <div className="actions">
        <button onClick={close}>閉じる</button>
      </div>
    </div>
  );
}

function NoteGrid({ notes, links, onOpen }: { notes: Note[]; links: ExternalLink[]; onOpen: (n: Note) => void }) {
  if (notes.length === 0) return null;
  return (
    <div className="grid">
      {notes.map((n) => (
        <article key={n.id} className="card" onClick={() => onOpen(n)}>
          {n.title && <h3>{n.title}</h3>}
          <p>{n.body}</p>
          <footer>
            <span className="badges">
              {n.source === "watch" && <span className="badge">⌚ {n.input_kind === "voice" ? "音声" : "文字"}</span>}
              {n.source === "mcp" && <span className="badge">Muse</span>}
              {linkBadges(links.filter((l) => l.note_id === n.id))}
            </span>
            <time>{formatDate(n.created_at)}</time>
          </footer>
        </article>
      ))}
    </div>
  );
}

function Editor({
  note,
  links,
  onClose,
  onSave,
  onPurge,
}: {
  note: Note;
  links: ExternalLink[];
  onClose: () => void;
  onSave: (f: Partial<Note>) => void;
  onPurge: () => void;
}) {
  const [title, setTitle] = useState(note.title ?? "");
  const [body, setBody] = useState(note.body);

  function close(extra: Partial<Note> = {}) {
    const changed = title !== (note.title ?? "") || body !== note.body;
    if (changed || Object.keys(extra).length) onSave({ ...(changed ? { title: title || null, body } : {}), ...extra });
    onClose();
  }

  const trashed = !!note.deleted_at;
  return (
    <div className="overlay" onClick={() => close()}>
      <div className="editor" onClick={(e) => e.stopPropagation()}>
        <input placeholder="タイトル" value={title} onChange={(e) => setTitle(e.target.value)} disabled={trashed} />
        <AutoTextarea value={body} onChange={setBody} disabled={trashed} />
        <p className="meta">
          {note.source === "watch" ? `ウォッチ（${note.input_kind === "voice" ? "音声" : "文字"}）から` : "作成"}{" "}
          {formatDate(note.created_at)}
        </p>
        {links.length > 0 && <LinkList links={links} />}
        {!trashed && <SendPanel note={note} text={title || body} />}
        <div className="actions">
          {trashed ? (
            <>
              <button onClick={() => close({ deleted_at: null })}>元に戻す</button>
              <button className="danger" onClick={onPurge}>
                完全に削除
              </button>
            </>
          ) : (
            <>
              <button onClick={() => close({ pinned: !note.pinned })}>{note.pinned ? "ピンを外す" : "ピン留め"}</button>
              <button onClick={() => close({ archived: !note.archived, pinned: false })}>
                {note.archived ? "アーカイブ解除" : "アーカイブ"}
              </button>
              <button onClick={() => close({ deleted_at: new Date().toISOString() })}>削除</button>
            </>
          )}
          <span className="spacer" />
          <button className="primary" onClick={() => close()}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

const TARGET_LABEL = { todoist: "Todoist", calendar: "カレンダー" } as const;

function linkBadges(links: ExternalLink[]) {
  const seen = new Set<string>();
  return links
    .filter((l) => !seen.has(l.type + l.status) && seen.add(l.type + l.status))
    .map((l) => (
      <span key={l.id} className={`badge ${l.status === "error" ? "bad" : "sent"}`}>
        {l.status === "error" ? "!" : "→"} {TARGET_LABEL[l.type]}
      </span>
    ));
}

function LinkList({ links }: { links: ExternalLink[] }) {
  return (
    <ul className="links">
      {links.map((l) => (
        <li key={l.id} className={l.status === "error" ? "bad" : ""}>
          {l.status === "ok" ? "送信済み" : "送れませんでした"}: {TARGET_LABEL[l.type]}
          {l.due && `（${l.due}）`}
          {l.via !== "web" && ` ・${l.via === "watch" ? "ウォッチから自動" : "Muse から"}`}
          {l.url && (
            <>
              {" "}
              <a href={l.url} target="_blank" rel="noreferrer">
                開く
              </a>
            </>
          )}
          {l.error && <div className="link-error">{l.error}</div>}
        </li>
      ))}
    </ul>
  );
}

function SendPanel({ note, text }: { note: Note; text: string }) {
  const [target, setTarget] = useState<"todoist" | "calendar" | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function open(t: "todoist" | "calendar") {
    setTarget(t);
    setMsg("");
    const firstLine = text.split("\n")[0].slice(0, 200);
    let parsed: Parsed = null;
    try {
      parsed = await api.preview(firstLine);
    } catch {
      /* 読み取れなくても手で入れられる */
    }
    setTitle(parsed?.rest || firstLine);
    setDate(parsed?.date ?? "");
    setTime(parsed?.time ?? "");
  }

  async function send() {
    if (!target) return;
    setBusy(true);
    setMsg("");
    try {
      await api.send({ note_id: note.id, target, text: title, date: date || null, time: time || null });
      setTarget(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  if (!target)
    return (
      <div className="actions send">
        <button onClick={() => open("todoist")}>Todoist へ</button>
        <button onClick={() => open("calendar")}>カレンダーへ</button>
      </div>
    );
  return (
    <div className="send-panel">
      <div className="send-title">{TARGET_LABEL[target]}へ送る</div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="タイトル" />
      <div className="send-when">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      </div>
      <p className="hint">
        {target === "calendar"
          ? time
            ? "1時間の予定として入れます"
            : "時刻が空なら終日の予定です"
          : date
            ? "期限付きのタスクにします"
            : "期限なしのタスクにします"}
      </p>
      {msg && <p className="error small">{msg}</p>}
      <div className="actions">
        <button onClick={() => setTarget(null)}>やめる</button>
        <button className="primary" disabled={busy || !title.trim() || (target === "calendar" && !date)} onClick={send}>
          {busy ? "送信中…" : "送る"}
        </button>
      </div>
    </div>
  );
}

function Settings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [result] = useState(() => {
    const m = location.hash.match(/google=([^&]+)/);
    if (m) history.replaceState(null, "", location.pathname + location.search);
    return m ? decodeURIComponent(m[1]) : "";
  });

  async function refresh() {
    try {
      setStatus(await api.status());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function connect() {
    try {
      location.href = (await api.googleStart()).url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function disconnect() {
    if (!confirm("Google カレンダーとの接続を解除しますか？")) return;
    await api.googleDisconnect();
    refresh();
  }

  return (
    <div className="settings">
      {result && (
        <p className={result === "ok" ? "notice" : "error small"}>
          {result === "ok" ? "Google カレンダーにつながりました" : `Google の接続に失敗しました（${result}）`}
        </p>
      )}
      {error && <p className="error small">{error}</p>}
      <section>
        <h3>Todoist</h3>
        <p>{status ? (status.todoist ? "✓ 使えます" : "未設定（サーバーにトークンを入れてください）") : "…"}</p>
      </section>
      <section>
        <h3>Google カレンダー</h3>
        {!status ? (
          <p>…</p>
        ) : !status.google.configured ? (
          <p>未設定（サーバーに OAuth クライアントを入れてください）</p>
        ) : status.google.connected ? (
          <>
            <p>✓ {status.google.account ?? "接続済み"}</p>
            <div className="actions">
              <button onClick={connect}>つなぎ直す</button>
              <button onClick={disconnect}>解除</button>
            </div>
          </>
        ) : (
          <div className="actions">
            <button className="primary" onClick={connect}>
              Google でログインしてつなぐ
            </button>
          </div>
        )}
      </section>
      <section>
        <h3>ウォッチから送る</h3>
        <p>
          メモの最初に「タスク」と言うと Todoist へ、「予定」と言うとカレンダーへ自動で送ります。
          <br />
          例:「タスク、牛乳を買う」「予定、明日15時 歯医者」
        </p>
      </section>
    </div>
  );
}

function AutoTextarea({
  value,
  onChange,
  ...rest
}: { value: string; onChange: (v: string) => void } & Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange"
>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return <textarea ref={ref} rows={3} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

function formatDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return hm;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}/${md}`;
}
