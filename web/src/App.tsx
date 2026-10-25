import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, type ExternalLink, type Note } from "./lib/supabase";
import { api, type Parsed, type Status } from "./lib/integrations";
import {
  countTags,
  extractTags,
  filterNotes,
  formatDay,
  headline,
  isOverdue,
  jstDate,
  nextDate,
  searchNotes,
  VIEW_LABEL,
  viewKey,
  viewLabel,
  type View,
} from "./lib/views";


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
      {/* iPhone のパスワード管理（キーチェーン）が保存・自動入力できるように、ユーザー名も渡す */}
      <input type="text" name="username" autoComplete="username" value={OWNER_EMAIL} readOnly hidden />
      <input
        type="password"
        name="password"
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

type Toast = { text: string; undo?: () => void };

function Notes({ session }: { session: Session }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [links, setLinks] = useState<ExternalLink[]>([]);
  const [view, setView] = useState<View>(() =>
    /[?&](code|error)=/.test(location.search) ? { kind: "settings" } : { kind: "inbox" },
  );
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [showDone, setShowDone] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem("sidebar") !== "0");
  const [drawer, setDrawer] = useState(false); // スマホのメニュー
  const [toast, setToast] = useState<Toast | null>(null);
  const [loadError, setLoadError] = useState("");
  const addRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number>(0);

  async function load() {
    const { data, error } = await supabase.from("notes").select("*").order("created_at", { ascending: false });
    if (error) setLoadError(error.message);
    else {
      setLoadError("");
      setNotes(data as Note[]);
    }
  }
  async function loadLinks() {
    const { data } = await supabase.from("external_links").select("*").order("created_at");
    if (data) setLinks(data as ExternalLink[]);
  }

  useEffect(() => {
    load();
    loadLinks();
    const ch = supabase
      .channel("notes")
      .on("postgres_changes", { event: "*", schema: "public", table: "notes" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "external_links" }, () => loadLinks())
      .subscribe();
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

  useEffect(() => localStorage.setItem("sidebar", sidebarOpen ? "1" : "0"), [sidebarOpen]);

  const shown = useMemo(
    () => (query.trim() ? searchNotes(notes, query) : filterNotes(notes, view, showDone)),
    [notes, view, query, showDone],
  );
  const tags = useMemo(() => countTags(notes), [notes]);
  const counts = useMemo(
    () => ({
      inbox: filterNotes(notes, { kind: "inbox" }, false).length,
      today: filterNotes(notes, { kind: "today" }, false).length,
    }),
    [notes],
  );
  const selected = notes.find((n) => n.id === selectedId) ?? null;

  function flash(t: Toast) {
    window.clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = window.setTimeout(() => setToast(null), 5000);
  }

  async function patch(id: string, fields: Partial<Note>) {
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, ...fields } : n)));
    const { error } = await supabase
      .from("notes")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      flash({ text: `保存できませんでした: ${error.message}` });
      load();
    }
  }

  async function create(text: string) {
    const { tags: t, rest } = extractTags(text);
    if (!rest) return;
    // 追加した画面の文脈を引き継ぐ（今日 → 今日やるタスク、タグ → そのタグ）
    const row: Partial<Note> & { user_id: string } = {
      user_id: session.user.id,
      body: rest,
      source: "web",
      tags: view.kind === "tag" ? [...new Set([view.tag, ...t])] : t,
    };
    if (view.kind === "today") Object.assign(row, { is_task: true, scheduled_date: jstDate() });
    if (view.kind === "upcoming") Object.assign(row, { is_task: true, scheduled_date: jstDate(1) });
    const { data, error } = await supabase.from("notes").insert(row).select().single();
    if (error) return flash({ text: `保存できませんでした: ${error.message}` });
    setNotes((ns) => [data as Note, ...ns.filter((n) => n.id !== (data as Note).id)]);
  }

  function toggleDone(n: Note) {
    const done = !n.done_at;
    patch(n.id, { is_task: true, done_at: done ? new Date().toISOString() : null });
    if (done) flash({ text: `完了: ${headline(n)}`, undo: () => patch(n.id, { done_at: null }) });
  }

  function trash(n: Note) {
    patch(n.id, { deleted_at: new Date().toISOString() });
    if (selectedId === n.id) setSelectedId(null);
    flash({ text: "ゴミ箱に移しました", undo: () => patch(n.id, { deleted_at: null }) });
  }

  async function purge(n: Note) {
    if (!confirm("完全に削除しますか？元に戻せません。")) return;
    setNotes((ns) => ns.filter((x) => x.id !== n.id));
    setSelectedId(null);
    await supabase.from("notes").delete().eq("id", n.id);
  }

  function go(v: View) {
    setView(v);
    setQuery("");
    setSelectedId(null);
    setCursor(0);
    setShowDone(false);
    setDrawer(false);
  }

  // キーボード操作: n 追加 / 検索 j k 移動 Enter 開く x 完了 Esc 閉じる [ サイドバー
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      const typing = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
      if (e.key === "Escape") {
        if (typing) el.blur();
        else if (selectedId) setSelectedId(null);
        else if (query) setQuery("");
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const cur = shown[Math.min(cursor, shown.length - 1)];
      if (e.key === "n" || e.key === "c") {
        e.preventDefault();
        addRef.current?.focus();
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, shown.length - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === "Enter" && cur) setSelectedId(cur.id);
      else if (e.key === "x" && cur && cur.is_task) toggleDone(cur);
      else if (e.key === "[") setSidebarOpen((o) => !o);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const isList = view.kind !== "settings" || !!query.trim();
  const title = query.trim() ? `「${query.trim()}」の検索結果` : viewLabel(view);
  const canAdd = !query.trim() && !["archive", "trash", "settings"].includes(view.kind);
  const canShowDone = !query.trim() && ["today", "all", "tag"].includes(view.kind);

  const nav = (
    <Sidebar view={view} counts={counts} tags={tags} onGo={go} onLogout={() => supabase.auth.signOut()} />
  );

  return (
    <div className={`shell ${sidebarOpen ? "" : "no-sidebar"} ${selected ? "has-detail" : ""}`}>
      <aside className="sidebar">{nav}</aside>
      {drawer && (
        <div className="drawer-backdrop" onClick={() => setDrawer(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            {nav}
          </aside>
        </div>
      )}

      <main className="main">
        <header className="topbar">
          <button className="icon desktop-only" title="サイドバー（[）" onClick={() => setSidebarOpen((o) => !o)}>
            ☰
          </button>
          <h1>{title}</h1>
          <input
            ref={searchRef}
            className="search"
            type="search"
            placeholder="検索（/）"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
          />
        </header>

        {loadError && <p className="error">読み込めませんでした: {loadError}</p>}

        {view.kind === "settings" && !query.trim() ? (
          <Settings />
        ) : (
          <>
            {canAdd && <QuickAdd inputRef={addRef} view={view} onAdd={create} />}
            {isList && (
              <NoteList
                notes={shown}
                grouped={view.kind === "upcoming" && !query.trim()}
                links={links}
                cursor={cursor}
                selectedId={selectedId}
                onOpen={(n, i) => {
                  setSelectedId(n.id);
                  setCursor(i);
                }}
                onToggle={toggleDone}
              />
            )}
            {shown.length === 0 && <p className="empty">{emptyText(view, !!query.trim())}</p>}
            {canShowDone && (
              <button className="link-button" onClick={() => setShowDone((s) => !s)}>
                {showDone ? "未完了を表示" : "完了したものを表示"}
              </button>
            )}
          </>
        )}
      </main>

      {selected && (
        <Detail
          key={selected.id}
          note={selected}
          allTags={tags.map(([t]) => t)}
          links={links.filter((l) => l.note_id === selected.id)}
          onPatch={(f) => patch(selected.id, f)}
          onClose={() => setSelectedId(null)}
          onTrash={() => trash(selected)}
          onPurge={() => purge(selected)}
          onToggleDone={() => toggleDone(selected)}
        />
      )}

      <nav className="tabbar">
        {(["inbox", "today", "upcoming", "all"] as const).map((k) => (
          <button key={k} className={view.kind === k && !query ? "active" : ""} onClick={() => go({ kind: k })}>
            <span className="tab-icon">{TAB_ICON[k]}</span>
            {VIEW_LABEL[k]}
            {k !== "all" && k !== "upcoming" && counts[k] > 0 && <span className="tab-count">{counts[k]}</span>}
          </button>
        ))}
        <button className={drawer ? "active" : ""} onClick={() => setDrawer(true)}>
          <span className="tab-icon">≡</span>
          その他
        </button>
      </nav>

      {toast && (
        <div className="toast">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              onClick={() => {
                toast.undo!();
                setToast(null);
              }}
            >
              元に戻す
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const TAB_ICON = { inbox: "📥", today: "☀︎", upcoming: "📅", all: "🗂" } as const;

function emptyText(view: View, searching: boolean) {
  if (searching) return "見つかりません";
  switch (view.kind) {
    case "inbox":
      return "受信箱は空です。タグを付けたメモはここから消えます。";
    case "today":
      return "今日やることはありません";
    case "upcoming":
      return "予定の入ったタスクはありません";
    case "trash":
      return "ゴミ箱は空です";
    default:
      return "メモはありません";
  }
}

function Sidebar({
  view,
  counts,
  tags,
  onGo,
  onLogout,
}: {
  view: View;
  counts: { inbox: number; today: number };
  tags: [string, number][];
  onGo: (v: View) => void;
  onLogout: () => void;
}) {
  const item = (v: View, count?: number) => (
    <button key={viewKey(v)} className={viewKey(v) === viewKey(view) ? "active" : ""} onClick={() => onGo(v)}>
      <span>{viewLabel(v)}</span>
      {!!count && <span className="count">{count}</span>}
    </button>
  );
  return (
    <div className="nav">
      <div className="brand">WristMemo</div>
      {item({ kind: "inbox" }, counts.inbox)}
      {item({ kind: "today" }, counts.today)}
      {item({ kind: "upcoming" })}
      {item({ kind: "all" })}
      {tags.length > 0 && <div className="nav-head">タグ</div>}
      {tags.map(([t, n]) => item({ kind: "tag", tag: t }, n))}
      <div className="nav-head" />
      {item({ kind: "archive" })}
      {item({ kind: "trash" })}
      {item({ kind: "settings" })}
      <button className="muted" onClick={onLogout}>
        ログアウト
      </button>
    </div>
  );
}

function QuickAdd({
  inputRef,
  view,
  onAdd,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  view: View;
  onAdd: (text: string) => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const placeholder =
    view.kind === "today"
      ? "今日やることを追加（Enter）"
      : view.kind === "upcoming"
        ? "明日以降のタスクを追加（Enter）"
        : view.kind === "tag"
          ? `#${view.tag} にメモを追加（Enter）`
          : "メモを追加（Enter・#タグ も書けます）";
  return (
    <form
      className="quick-add"
      onSubmit={async (e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t) return;
        setText("");
        await onAdd(t);
      }}
    >
      <span className="plus">＋</span>
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        enterKeyHint="done"
      />
    </form>
  );
}

function NoteList({
  notes,
  grouped,
  links,
  cursor,
  selectedId,
  onOpen,
  onToggle,
}: {
  notes: Note[];
  grouped: boolean;
  links: ExternalLink[];
  cursor: number;
  selectedId: string | null;
  onOpen: (n: Note, index: number) => void;
  onToggle: (n: Note) => void;
}) {
  const today = jstDate();
  let lastGroup = "";
  return (
    <ul className="list">
      {notes.map((n, i) => {
        const group = grouped ? (nextDate(n) ?? "") : "";
        const head = grouped && group !== lastGroup ? ((lastGroup = group), formatDay(group)) : null;
        const sent = links.filter((l) => l.note_id === n.id);
        return (
          <Fragment key={n.id}>
            {head && <li className="group-head">{head}</li>}
            <li
              className={`row ${i === cursor ? "cursor" : ""} ${selectedId === n.id ? "selected" : ""} ${n.done_at ? "done" : ""}`}
              onClick={() => onOpen(n, i)}
            >
              {n.is_task ? (
                <button
                  className={`check p${n.priority}`}
                  aria-label={n.done_at ? "未完了に戻す" : "完了にする"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(n);
                  }}
                >
                  {n.done_at ? "✓" : ""}
                </button>
              ) : (
                <span className="dot">{n.pinned ? "📌" : n.source === "watch" ? "⌚" : "・"}</span>
              )}
              <div className="row-main">
                <div className="row-title">{headline(n)}</div>
                <div className="row-meta">
                  {n.due_date && (
                    <span className={isOverdue(n, today) ? "overdue" : n.due_date === today ? "due-today" : ""}>
                      締切 {formatDay(n.due_date, today)}
                      {n.due_time && ` ${n.due_time.slice(0, 5)}`}
                    </span>
                  )}
                  {n.scheduled_date && !grouped && n.scheduled_date !== n.due_date && (
                    <span>予定 {formatDay(n.scheduled_date, today)}</span>
                  )}
                  {n.tags.map((t) => (
                    <span key={t} className="tag">
                      #{t}
                    </span>
                  ))}
                  {sent.some((l) => l.status === "error") && <span className="overdue">送信失敗</span>}
                  {sent.some((l) => l.status === "ok" && l.type === "todoist") && <span>→Todoist</span>}
                  {sent.some((l) => l.status === "ok" && l.type === "calendar") && <span>→カレンダー</span>}
                  {!n.is_task && <span className="time">{formatDate(n.created_at)}</span>}
                </div>
              </div>
            </li>
          </Fragment>
        );
      })}
    </ul>
  );
}

function Detail({
  note,
  allTags,
  links,
  onPatch,
  onClose,
  onTrash,
  onPurge,
  onToggleDone,
}: {
  note: Note;
  allTags: string[];
  links: ExternalLink[];
  onPatch: (f: Partial<Note>) => void;
  onClose: () => void;
  onTrash: () => void;
  onPurge: () => void;
  onToggleDone: () => void;
}) {
  const [title, setTitle] = useState(note.title ?? "");
  const [body, setBody] = useState(note.body);
  const trashed = !!note.deleted_at;

  // 文字の編集は入力が止まってから保存（閉じたときにも保存）
  const pending = useRef<Partial<Note> | null>(null);
  const timer = useRef<number>(0);
  function queueText(f: Partial<Note>) {
    pending.current = { ...pending.current, ...f };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 800);
  }
  function flush() {
    window.clearTimeout(timer.current);
    if (pending.current) onPatch(pending.current);
    pending.current = null;
  }
  useEffect(() => flush, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="detail">
      <div className="detail-bar">
        <button
          className="icon"
          onClick={() => {
            flush();
            onClose();
          }}
        >
          ✕
        </button>
        <span className="spacer" />
        {!trashed && (
          <>
            <button className="icon" title={note.pinned ? "ピンを外す" : "ピン留め"} onClick={() => onPatch({ pinned: !note.pinned })}>
              {note.pinned ? "📌" : "📍"}
            </button>
            <button
              className="icon"
              title={note.archived ? "アーカイブ解除" : "アーカイブ"}
              onClick={() => onPatch({ archived: !note.archived, pinned: false })}
            >
              {note.archived ? "↩︎" : "🗄"}
            </button>
            <button className="icon" title="ゴミ箱へ" onClick={onTrash}>
              🗑
            </button>
          </>
        )}
      </div>

      {trashed && (
        <div className="trash-bar">
          ゴミ箱にあります
          <button onClick={() => onPatch({ deleted_at: null })}>元に戻す</button>
          <button className="danger" onClick={onPurge}>
            完全に削除
          </button>
        </div>
      )}

      <div className="detail-title">
        {note.is_task && (
          <button className={`check big p${note.priority} ${note.done_at ? "is-done" : ""}`} onClick={onToggleDone} disabled={trashed}>
            {note.done_at ? "✓" : ""}
          </button>
        )}
        <input
          placeholder="タイトル"
          value={title}
          disabled={trashed}
          onChange={(e) => {
            setTitle(e.target.value);
            queueText({ title: e.target.value || null });
          }}
          onBlur={flush}
        />
      </div>
      <AutoTextarea
        className="detail-body"
        placeholder="メモ"
        value={body}
        disabled={trashed}
        onChange={(v) => {
          setBody(v);
          queueText({ body: v });
        }}
        onBlur={flush}
      />

      <TagEditor tags={note.tags} allTags={allTags} disabled={trashed} onChange={(tags) => onPatch({ tags })} />

      <section className="props">
        <label className="prop">
          <span>タスク</span>
          <input
            type="checkbox"
            checked={note.is_task}
            disabled={trashed}
            onChange={(e) => onPatch(e.target.checked ? { is_task: true } : { is_task: false, done_at: null })}
          />
        </label>
        {note.is_task && (
          <>
            <label className="prop">
              <span>締め切り</span>
              <input
                type="date"
                value={note.due_date ?? ""}
                disabled={trashed}
                onChange={(e) => onPatch({ due_date: e.target.value || null, ...(e.target.value ? {} : { due_time: null }) })}
              />
              {note.due_date && (
                <input
                  type="time"
                  value={note.due_time?.slice(0, 5) ?? ""}
                  disabled={trashed}
                  onChange={(e) => onPatch({ due_time: e.target.value || null })}
                />
              )}
            </label>
            <label className="prop">
              <span>やる日</span>
              <input
                type="date"
                value={note.scheduled_date ?? ""}
                disabled={trashed}
                onChange={(e) => onPatch({ scheduled_date: e.target.value || null })}
              />
              <button className="mini" disabled={trashed} onClick={() => onPatch({ scheduled_date: jstDate() })}>
                今日
              </button>
              <button className="mini" disabled={trashed} onClick={() => onPatch({ scheduled_date: jstDate(1) })}>
                明日
              </button>
            </label>
            <div className="prop">
              <span>優先度</span>
              <div className="seg">
                {["なし", "低", "中", "高"].map((l, p) => (
                  <button
                    key={l}
                    className={note.priority === p ? "active" : ""}
                    disabled={trashed}
                    onClick={() => onPatch({ priority: p })}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </section>

      {!trashed && <SendPanel note={note} text={title || body} />}
      {links.length > 0 && <LinkList links={links} />}

      <p className="meta">
        {note.source === "watch"
          ? `ウォッチ（${note.input_kind === "voice" ? "音声" : "文字"}）から`
          : note.source === "mcp"
            ? "Muse から"
            : "作成"}{" "}
        {formatDate(note.created_at)}
        {note.done_at && ` ・ 完了 ${formatDate(note.done_at)}`}
      </p>
    </aside>
  );
}

function TagEditor({
  tags,
  allTags,
  disabled,
  onChange,
}: {
  tags: string[];
  allTags: string[];
  disabled: boolean;
  onChange: (tags: string[]) => void;
}) {
  const [text, setText] = useState("");
  const suggestions = allTags.filter((t) => !tags.includes(t) && (!text || t.includes(text))).slice(0, 6);
  function add(t: string) {
    const v = t.replace(/^[#＃]/, "").trim();
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setText("");
  }
  return (
    <div className="tags-edit">
      {tags.map((t) => (
        <span key={t} className="tag chip">
          #{t}
          {!disabled && <button onClick={() => onChange(tags.filter((x) => x !== t))}>×</button>}
        </span>
      ))}
      {!disabled && (
        <input
          value={text}
          placeholder={tags.length ? "＋タグ" : "＋タグを付ける"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add(text);
            }
          }}
          onBlur={() => text && add(text)}
        />
      )}
      {!disabled && text !== "" && suggestions.length > 0 && (
        <div className="suggest">
          {suggestions.map((t) => (
            <button key={t} onMouseDown={(e) => e.preventDefault()} onClick={() => add(t)}>
              #{t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const TARGET_LABEL = { todoist: "Todoist", calendar: "カレンダー" } as const;

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
        <span className="send-label">送る</span>
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
  const [result, setResult] = useState("");

  // Google の同意画面から ?code=…&state=… 付きで戻ってきたら、サーバーに渡して接続を終える
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const code = q.get("code");
    const state = q.get("state");
    const err = q.get("error");
    if (!code && !err) return;
    history.replaceState(null, "", location.pathname);
    if (err || !code || !state) {
      setResult(`error:${err ?? "no_code"}`);
      return;
    }
    api
      .googleExchange(code, state)
      .then(() => setResult("ok"))
      .catch((e) => setResult(`error:${e instanceof Error ? e.message : e}`))
      .finally(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          メモの最初に「タスク」と言うとタスクになり（日時を言えば締め切り）、「予定」と言うとカレンダーへ自動で送ります。
          <br />
          例:「タスク、明日 牛乳を買う」「予定、明日15時 歯医者」
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
