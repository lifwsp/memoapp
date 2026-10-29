import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Hash,
  Inbox,
  Layers,
  GripVertical,
  ListChecks,
  LogOut,
  PanelLeft,
  Pin,
  MapPin,
  PinOff,
  Plus,
  Repeat,
  Settings2,
  Trash2,
  Watch,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import {
  DndContext,
  MouseSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { supabase, type ExternalLink, type Note } from "./lib/supabase";
import { api, type CalendarEvent, type Parsed, type Status } from "./lib/integrations";
import { asRule, describeRepeat, parseRepeat, taskFromText } from "./lib/repeat";
import {
  countTags,
  extractTags,
  filterNotes,
  formatDay,
  headline,
  isOverdue,
  jstDate,
  dayOf,
  daysLeft,
  DEADLINE,
  groupKey,
  isDeadlineSoon,
  orderForMove,
  isDueNow,
  childrenOf,
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
    const { error } = await supabase.auth.signInWithPassword({
      email: OWNER_EMAIL,
      password,
    });
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
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [calError, setCalError] = useState("");
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

  // 合流ビュー: 「今日」「今後の予定」では Google カレンダーの予定も読んで並べる（予定の本体はカレンダー）
  const wantsCalendar = view.kind === "today";
  async function loadEvents() {
    try {
      const r = await api.events(jstDate(), jstDate(30));
      setEvents(r.events);
      setCalError(r.error ?? "");
    } catch (e) {
      setCalError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    if (!wantsCalendar) return;
    loadEvents();
    const onVisible = () => document.visibilityState === "visible" && loadEvents();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [wantsCalendar]);

  const shown = useMemo(
    () => (query.trim() ? searchNotes(notes, query) : filterNotes(notes, view, showDone)),
    [notes, view, query, showDone],
  );
  const tags = useMemo(() => countTags(notes), [notes]);
  const counts = useMemo(
    () => ({
      inbox: filterNotes(notes, { kind: "inbox" }, false).length,
      today: filterNotes(notes, { kind: "today" }, false).filter((n) => isDueNow(n)).length,
    }),
    [notes],
  );
  const selected = notes.find((n) => n.id === selectedId) ?? null;
  const kids = useMemo(() => childrenOf(notes), [notes]);

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
    if (view.kind === "today") {
      // 「毎月1日 カード支払い」「明日15時 電話」のような日時・繰り返しの言葉を読む
      const f = taskFromText(rest);
      Object.assign(row, { is_task: true, body: f.title, ...f });
      if (!f.due_date) row.scheduled_date = jstDate();
    }
    const { data, error } = await supabase.from("notes").insert(row).select().single();
    if (error) return flash({ text: `保存できませんでした: ${error.message}` });
    setNotes((ns) => [data as Note, ...ns.filter((n) => n.id !== (data as Note).id)]);
  }

  // 完了は DB の complete_task で行う（繰り返しタスクは期日が次の回へ進む）
  async function toggleDone(n: Note) {
    const done = !n.done_at;
    const before = { done_at: n.done_at, due_date: n.due_date, scheduled_date: n.scheduled_date, last_done_at: n.last_done_at, done_count: n.done_count };
    if (!n.is_task) await supabase.from("notes").update({ is_task: true }).eq("id", n.id);
    if (!n.repeat_rule)
      setNotes((ns) =>
        ns.map((x) =>
          x.id === n.id
            ? {
                ...x,
                is_task: true,
                done_at: done ? new Date().toISOString() : null,
              }
            : x,
        ),
      );
    const { data, error } = await supabase.rpc("complete_task", {
      p_id: n.id,
      p_done: done,
    });
    if (error) {
      flash({ text: `保存できませんでした: ${error.message}` });
      return load();
    }
    const after = data as Note;
    setNotes((ns) => ns.map((x) => (x.id === n.id ? after : x)));
    // 親子の連動（子もまとめて完了・親も未完了に戻る）は DB のトリガーが行うので読み直す
    if (kids.has(n.id) || n.parent_id) load();
    if (!done) return;
    if (n.repeat_rule) {
      const next = after.due_date ?? after.scheduled_date;
      flash({
        text: `完了: ${headline(n)} → 次は ${next ? formatDay(next) : "未定"}`,
        undo: () => patch(n.id, before),
      });
    } else
      flash({
        text: `完了: ${headline(n)}`,
        undo: () => patch(n.id, { done_at: null }),
      });
  }

  // サブタスクを足す（親の末尾に）。親がメモでも、子はチェックの付くタスクにする
  async function addSubtask(parent: Note, text: string) {
    const { title, ...f } = taskFromText(text.trim());
    if (!title) return;
    const last = kids.get(parent.id)?.at(-1);
    const row: Partial<Note> & { user_id: string } = {
      ...f,
      user_id: session.user.id,
      parent_id: parent.id,
      body: title,
      source: "web",
      is_task: true,
      tags: parent.tags, // MCP と同じく親のタグを引き継ぐ（タグの一覧・件数には数えない）
      sort_order: (last?.sort_order ?? 0) + 1,
    };
    const { data, error } = await supabase.from("notes").insert(row).select().single();
    if (error) return flash({ text: `保存できませんでした: ${error.message}` });
    setNotes((ns) => [data as Note, ...ns.filter((n) => n.id !== (data as Note).id)]);
  }

  // 締め切りタスクを今日やる: やる日を今日にする（締切はそのまま）
  function planToday(n: Note) {
    patch(n.id, { scheduled_date: jstDate() });
    flash({ text: `今日やる: ${headline(n)}`, undo: () => patch(n.id, { scheduled_date: null }) });
  }

  // 並べ替え（ドラッグ）: 動かした1件の sort_order を前後の間の値にする。ほかの端末には realtime で届く
  async function reorder(n: Note, sort_order: number) {
    if (sort_order === n.sort_order) return;
    setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, sort_order } : x)));
    const { error } = await supabase.from("notes").update({ sort_order }).eq("id", n.id);
    if (error) {
      flash({ text: `並べ替えを保存できませんでした: ${error.message}` });
      load();
    }
  }

  function trash(n: Note) {
    patch(n.id, { deleted_at: new Date().toISOString() });
    if (selectedId === n.id) setSelectedId(null);
    flash({
      text: "ゴミ箱に移しました",
      undo: () => patch(n.id, { deleted_at: null }),
    });
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
            <PanelLeft size={18} strokeWidth={1.75} />
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
                events={wantsCalendar && !query.trim() ? events : []}
                grouped={view.kind === "today" && !query.trim() && !showDone}
                links={links}
                kids={kids}
                parentOf={(n) => notes.find((x) => x.id === n.parent_id)}
                cursor={cursor}
                selectedId={selectedId}
                onOpen={(n, i) => {
                  setSelectedId(n.id);
                  setCursor(i);
                }}
                onToggle={toggleDone}
                onReorder={query.trim() || view.kind === "trash" || showDone ? undefined : reorder}
                onPlanToday={view.kind === "today" && !showDone ? planToday : undefined}
              />
            )}
            {wantsCalendar && calError && !query.trim() && <p className="error small">カレンダー: {calError}</p>}
            {shown.length === 0 && !(wantsCalendar && events.length) && (
              <p className="empty">{emptyText(view, !!query.trim())}</p>
            )}
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
          parent={notes.find((x) => x.id === selected.parent_id) ?? null}
          subtasks={kids.get(selected.id) ?? []}
          onOpen={(id) => setSelectedId(id)}
          onAddSubtask={(t) => addSubtask(selected, t)}
          onToggleSub={toggleDone}
          onReorder={reorder}
          onPatchSub={(id, f) => patch(id, f)}
          onPatch={(f) => patch(selected.id, f)}
          onClose={() => setSelectedId(null)}
          onTrash={() => trash(selected)}
          onPurge={() => purge(selected)}
          onToggleDone={() => toggleDone(selected)}
        />
      )}

      <nav className="tabbar">
        {(["inbox", "today", "all"] as const).map((k) => (
          <button key={k} className={view.kind === k && !query ? "active" : ""} onClick={() => go({ kind: k })}>
            <TabIcon k={k} />
            {VIEW_LABEL[k]}
            {k !== "all" && counts[k] > 0 && <span className="tab-count">{counts[k]}</span>}
          </button>
        ))}
        <button className={drawer ? "active" : ""} onClick={() => setDrawer(true)}>
          <Ellipsis className="tab-icon" size={22} strokeWidth={1.75} />
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

const VIEW_ICON: Record<string, LucideIcon> = {
  inbox: Inbox,
  today: CalendarDays,
  all: Layers,
  tag: Hash,
  archive: Archive,
  trash: Trash2,
  settings: Settings2,
};

function TabIcon({ k }: { k: string }) {
  const I = VIEW_ICON[k];
  return <I className="tab-icon" size={22} strokeWidth={1.75} />;
}

function emptyText(view: View, searching: boolean) {
  if (searching) return "見つかりません";
  switch (view.kind) {
    case "inbox":
      return "受信箱は空です。タグを付けたメモはここから消えます。";
    case "today":
      return "日付の入ったタスクも予定もありません";
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
      <span className="nav-label">
        {(() => {
          const I = VIEW_ICON[v.kind];
          return <I size={16} strokeWidth={1.75} />;
        })()}
        {v.kind === "tag" ? v.tag : viewLabel(v)}
      </span>
      {!!count && <span className="count">{count}</span>}
    </button>
  );
  return (
    <div className="nav">
      <div className="brand">WristMemo</div>
      {item({ kind: "inbox" }, counts.inbox)}
      {item({ kind: "today" }, counts.today)}
      {item({ kind: "all" })}
      {tags.length > 0 && <div className="nav-head">タグ</div>}
      {tags.map(([t, n]) => item({ kind: "tag", tag: t }, n))}
      <div className="nav-head" />
      {item({ kind: "archive" })}
      {item({ kind: "trash" })}
      {item({ kind: "settings" })}
      <button className="muted" onClick={onLogout}>
        <span className="nav-label">
          <LogOut size={16} strokeWidth={1.75} />
          ログアウト
        </span>
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
      ? "タスクを追加（「明日15時 歯医者」「毎月10日 積立」も可・日付なしは今日）"
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
      <Plus className="plus" size={18} strokeWidth={2.25} />
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
  events,
  grouped,
  links,
  kids,
  parentOf,
  cursor,
  selectedId,
  onOpen,
  onToggle,
  onReorder,
  onPlanToday,
}: {
  notes: Note[];
  events: CalendarEvent[];
  grouped: boolean;
  links: ExternalLink[];
  kids: Map<string, Note[]>;
  parentOf: (n: Note) => Note | undefined;
  cursor: number;
  selectedId: string | null;
  onOpen: (n: Note, index: number) => void;
  onToggle: (n: Note) => void;
  /** 渡したときだけドラッグで並べ替えられる（検索・ゴミ箱・完了の表示では渡さない） */
  onReorder?: (n: Note, sort_order: number) => void;
  /** 締切が先のタスクに「今日やる」（やる日を今日に）を出す */
  onPlanToday?: (n: Note) => void;
}) {
  const today = jstDate();
  // マウスは 6px 動かしたら、タッチは長押し（0.25 秒）でつかむ。ふつうのタップ・クリック・スクロールはそのまま
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
  );
  // 「予定」は日ごとのかたまりの中だけで動かせる（日をまたぐと日付が変わってしまうため）
  const groupOf = (n: Note) => (grouped ? (dayOf(n, today) ?? "") : "");
  function onDragEnd({ active, over }: DragEndEvent) {
    if (!onReorder || !over || active.id === over.id) return;
    const a = notes.find((n) => n.id === active.id);
    const o = notes.find((n) => n.id === over.id);
    if (a && groupOf(a) === DEADLINE) return; // 締め切りタスクは締切の近い順で固定
    if (!a || !o || groupOf(a) !== groupOf(o) || a.pinned !== o.pinned) return; // ピン留めの境目もまたがない
    const list = notes.filter((n) => groupOf(n) === groupOf(a));
    const from = list.indexOf(a);
    const to = list.indexOf(o);
    onReorder(
      a,
      orderForMove(list, from, to, (x, y) => x.pinned === y.pinned),
    );
  }
  const wrap = (ids: string[], children: React.ReactNode) => (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={!onReorder}>
        {children}
      </SortableContext>
    </DndContext>
  );
  const row = (n: Note, i: number) => {
    const sent = links.filter((l) => l.note_id === n.id);
    const left = n.due_date && !n.done_at ? daysLeft(n.due_date, today) : null;
    const soon = isDeadlineSoon(n, today);
    const rule = asRule(n.repeat_rule);
    const subs = (kids.get(n.id) ?? []).filter((c) => c.is_task);
    const parent = n.parent_id ? parentOf(n) : undefined;
    return (
      <SortableRow
        key={n.id}
        id={n.id}
        disabled={!onReorder}
        className={`row ${i === cursor ? "cursor" : ""} ${selectedId === n.id ? "selected" : ""} ${n.done_at ? "done" : ""} ${soon ? "soon" : ""}`}
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
            {n.done_at && <Check size={13} strokeWidth={3} />}
          </button>
        ) : (
          <span className="dot">
            {n.pinned ? (
              <Pin size={14} strokeWidth={2} />
            ) : n.source === "watch" ? (
              <Watch size={14} strokeWidth={2} />
            ) : (
              <span className="bullet" />
            )}
          </span>
        )}
        <div className="row-main">
          <div className="row-title">{headline(n)}</div>
          <div className="row-meta">
            {parent && <span className="parent-ref">↳ {headline(parent)}</span>}
            {n.due_date && (
              <span className={isOverdue(n, today) ? "overdue" : n.due_date === today ? "due-today" : ""}>
                締切 {formatDay(n.due_date, today)}
                {n.due_time && ` ${n.due_time.slice(0, 5)}`}
              </span>
            )}
            {left !== null && left > 1 && left <= 30 && <span className={soon ? "soon-left" : ""}>あと{left}日</span>}
            {n.scheduled_date && !grouped && n.scheduled_date !== n.due_date && (
              <span>予定 {formatDay(n.scheduled_date, today)}</span>
            )}
            {rule && (
              <span className="repeat">
                <Repeat size={11} strokeWidth={2.25} />
                {describeRepeat(rule, n.repeat_from)}
              </span>
            )}
            {subs.length > 0 && (
              <span className="subcount">
                <ListChecks size={11} strokeWidth={2.25} />
                {subs.filter((c) => c.done_at).length}/{subs.length}
              </span>
            )}
            {n.tags.map((t) => (
              <span key={t} className="tag">
                #{t}
              </span>
            ))}
            {sent.some((l) => l.status === "error") && <span className="overdue">送信失敗</span>}
            {sent.some((l) => l.status === "ok" && l.type === "calendar") && <span>→カレンダー</span>}
            {onPlanToday && n.is_task && !n.done_at && !n.scheduled_date && (n.due_date ?? "") > today && (
              <button
                className="plan-today"
                onClick={(e) => {
                  e.stopPropagation();
                  onPlanToday(n);
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                今日やる
              </button>
            )}
            {!n.is_task && <span className="time">{formatDate(n.created_at)}</span>}
          </div>
        </div>
      </SortableRow>
    );
  };

  if (!grouped)
    return wrap(
      notes.map((n) => n.id),
      <ul className="list">{notes.map((n, i) => row(n, i))}</ul>,
    );

  // 期限切れ → 今日 → 明日以降を日付ごとに。各日はカレンダーの予定が先、タスクが後
  const evDay = (e: CalendarEvent) => (e.date > today ? e.date : today); // 複数日の予定は今日以降の最初の日にだけ出す
  const days = new Set<string>([today]);
  notes.forEach((n) => days.add(dayOf(n, today) ?? ""));
  events.forEach((e) => e.end_date >= today && days.add(evDay(e)));
  const order = [...days].sort((x, y) => groupKey(x, today).localeCompare(groupKey(y, today)));
  // 日ごとに別の DndContext にする（ほかの日へは動かせない。動かすと日付が変わってしまうため）
  return (
    <ul className="list">
      {order.map((d) => {
        const evs = events.filter((e) => e.end_date >= today && evDay(e) === d);
        const ts = notes.map((n, i) => ((dayOf(n, today) ?? "") === d ? row(n, i) : null)).filter(Boolean);
        if (d === today && !evs.length && !ts.length) {
          return (
            <Fragment key={d}>
              <li className="group-head">今日</li>
              <li className="row empty-day">今日の予定・タスクはありません</li>
            </Fragment>
          );
        }
        return (
          <Fragment key={d || "none"}>
            <li className={`group-head ${d === "overdue" ? "overdue" : ""} ${d === DEADLINE ? "deadline" : ""}`}>
              {d === "overdue" ? "期限切れ" : d === DEADLINE ? "締め切りタスク（30日以内・いつでも着手できる）" : d ? formatDay(d) : "日付なし"}
            </li>
            {evs.map((e) => (
              <EventRow key={`${e.calendar}:${e.id}`} e={e} />
            ))}
            {wrap(
              notes.filter((n) => groupOf(n) === d).map((n) => n.id),
              ts,
            )}
          </Fragment>
        );
      })}
    </ul>
  );
}

/** 一覧の1行。行そのものをつかんで動かす（SortableContext が disabled なら普通の行） */
function SortableRow({
  id,
  disabled,
  className,
  onClick,
  children,
}: {
  id: string;
  disabled: boolean;
  className: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, disabled });
  return (
    <li
      ref={setNodeRef}
      className={`${className} ${disabled ? "" : "sortable"} ${isDragging ? "dragging" : ""}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onClick={onClick}
      {...listeners}
    >
      {children}
    </li>
  );
}

function EventRow({ e }: { e: CalendarEvent }) {
  const when = e.all_day
    ? e.end_date !== e.date
      ? `終日（〜${formatDay(e.end_date)}）`
      : "終日"
    : `${e.start_time}〜${e.end_time}`;
  return (
    <li className="row event" onClick={() => e.url && window.open(e.url, "_blank", "noreferrer")}>
      <span className="event-bar" style={{ background: e.color ?? "#8ab4f8" }} />
      <div className="row-main">
        <div className="row-title">{e.title}</div>
        <div className="row-meta">
          <span className="event-time">{when}</span>
          {e.location && (
            <span className="event-loc">
              <MapPin size={11} strokeWidth={2.25} />
              {e.location.split(/[\s,、]/)[0]}
            </span>
          )}
          <span>{e.calendar}</span>
        </div>
      </div>
    </li>
  );
}

function Detail({
  note,
  allTags,
  links,
  parent,
  subtasks,
  onOpen,
  onAddSubtask,
  onToggleSub,
  onReorder,
  onPatchSub,
  onPatch,
  onClose,
  onTrash,
  onPurge,
  onToggleDone,
}: {
  note: Note;
  allTags: string[];
  links: ExternalLink[];
  parent: Note | null;
  subtasks: Note[];
  onOpen: (id: string) => void;
  onAddSubtask: (text: string) => void;
  onToggleSub: (n: Note) => void;
  onReorder: (n: Note, sort_order: number) => void;
  onPatchSub: (id: string, f: Partial<Note>) => void;
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
          <X size={18} strokeWidth={1.75} />
        </button>
        <span className="spacer" />
        {!trashed && (
          <>
            <button className="icon" title={note.pinned ? "ピンを外す" : "ピン留め"} onClick={() => onPatch({ pinned: !note.pinned })}>
              {note.pinned ? <PinOff size={18} strokeWidth={1.75} /> : <Pin size={18} strokeWidth={1.75} />}
            </button>
            <button
              className="icon"
              title={note.archived ? "アーカイブ解除" : "アーカイブ"}
              onClick={() => onPatch({ archived: !note.archived, pinned: false })}
            >
              {note.archived ? <ArchiveRestore size={18} strokeWidth={1.75} /> : <Archive size={18} strokeWidth={1.75} />}
            </button>
            <button className="icon" title="ゴミ箱へ" onClick={onTrash}>
              <Trash2 size={18} strokeWidth={1.75} />
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

      {parent && (
        <button
          className="parent-link"
          onClick={() => {
            flush();
            onOpen(parent.id);
          }}
        >
          <ChevronLeft size={14} strokeWidth={2} />
          {headline(parent)}
        </button>
      )}

      <div className="detail-title">
        {note.is_task && (
          <button className={`check big p${note.priority} ${note.done_at ? "is-done" : ""}`} onClick={onToggleDone} disabled={trashed}>
            {note.done_at && <Check size={15} strokeWidth={3} />}
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

      {!note.parent_id && (
        <SubtaskList
          items={subtasks}
          disabled={trashed}
          onOpen={(id) => {
            flush();
            onOpen(id);
          }}
          onAdd={onAddSubtask}
          onToggle={onToggleSub}
          onReorder={onReorder}
          onPatch={onPatchSub}
        />
      )}

      <TagEditor tags={note.tags} allTags={allTags} disabled={trashed} onChange={(tags) => onPatch({ tags })} />

      <section className="props">
        <label className="prop">
          <span>タスク</span>
          <input
            type="checkbox"
            checked={note.is_task}
            disabled={trashed}
            onChange={(e) =>
              onPatch(e.target.checked ? { is_task: true } : { is_task: false, done_at: null, repeat_rule: null })
            }
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
                onChange={(e) =>
                  onPatch({
                    due_date: e.target.value || null,
                    ...(e.target.value ? {} : { due_time: null }),
                  })
                }
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
            <RepeatEditor note={note} disabled={trashed} onPatch={onPatch} />
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
        {note.repeat_rule && note.last_done_at && ` ・ 前回の完了 ${formatDate(note.last_done_at)}（${note.done_count}回目）`}
      </p>
    </aside>
  );
}

// サブタスクの一覧（詳細画面）。チェック・名前の編集・並べ替え・追加ができる。行の右の › で開くと日付なども付けられる
function SubtaskList({
  items,
  disabled,
  onOpen,
  onAdd,
  onToggle,
  onReorder,
  onPatch,
}: {
  items: Note[];
  disabled: boolean;
  onOpen: (id: string) => void;
  onAdd: (text: string) => void;
  onToggle: (n: Note) => void;
  onReorder: (n: Note, sort_order: number) => void;
  onPatch: (id: string, f: Partial<Note>) => void;
}) {
  const [text, setText] = useState("");
  // つまみ（⋮⋮）だけでつかむので、マウスもタッチもすぐに動かせる
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((c) => c.id === active.id);
    const to = items.findIndex((c) => c.id === over.id);
    if (from < 0 || to < 0) return;
    onReorder(items[from], orderForMove(items, from, to));
  }
  const today = jstDate();
  const tasks = items.filter((c) => c.is_task);
  const done = tasks.filter((c) => c.done_at).length;
  return (
    <section className="subtasks">
      <div className="subtasks-head">
        <ListChecks size={14} strokeWidth={2} />
        サブタスク
        {tasks.length > 0 && (
          <span className="subtasks-count">
            {done}/{tasks.length}
          </span>
        )}
      </div>
      {tasks.length > 0 && (
        <div className="subtasks-bar">
          <span style={{ width: `${(done / tasks.length) * 100}%` }} />
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((c) => c.id)} strategy={verticalListSortingStrategy} disabled={disabled}>
          <ul>
            {items.map((c) => (
              <SortableSubtask key={c.id} id={c.id} disabled={disabled} className={`subtask ${c.done_at ? "done" : ""}`}>
                {c.is_task ? (
                  <button
                    className={`check p${c.priority}`}
                    aria-label={c.done_at ? "未完了に戻す" : "完了にする"}
                    disabled={disabled}
                    onClick={() => onToggle(c)}
                  >
                    {c.done_at && <Check size={13} strokeWidth={3} />}
                  </button>
                ) : (
                  <span className="dot">
                    <span className="bullet" />
                  </span>
                )}
                <SubtaskTitle
                  key={`${c.id}:${headline(c)}`}
                  note={c}
                  disabled={disabled}
                  onSave={(v) => onPatch(c.id, c.title ? { title: v } : { body: v })}
                />
                {c.due_date && (
                  <span className={`subtask-due ${isOverdue(c, today) ? "overdue" : ""}`}>{formatDay(c.due_date, today)}</span>
                )}
                <button className="icon" title="開く" onClick={() => onOpen(c.id)}>
                  <ChevronRight size={16} strokeWidth={2} />
                </button>
              </SortableSubtask>
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {!disabled && (
        <form
          className="subtask-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            onAdd(text);
            setText("");
          }}
        >
          <Plus size={14} strokeWidth={2} />
          <input placeholder="サブタスクを追加（例: 明日 見積もりを送る）" value={text} onChange={(e) => setText(e.target.value)} />
        </form>
      )}
    </section>
  );
}

/** サブタスクの1行。左端のつまみをドラッグして並べ替える */
function SortableSubtask({
  id,
  disabled,
  className,
  children,
}: {
  id: string;
  disabled: boolean;
  className: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  return (
    <li
      ref={setNodeRef}
      className={`${className} ${isDragging ? "dragging" : ""}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      {!disabled && (
        <button
          type="button"
          className="icon grip"
          ref={setActivatorNodeRef}
          title="ドラッグで並べ替え"
          {...attributes}
          {...listeners}
        >
          <GripVertical size={14} strokeWidth={2} />
        </button>
      )}
      {children}
    </li>
  );
}

function SubtaskTitle({ note, disabled, onSave }: { note: Note; disabled: boolean; onSave: (v: string) => void }) {
  const cur = headline(note);
  const [v, setV] = useState(cur); // 保存された名前が変わると key で作り直される
  return (
    <input
      className="subtask-title"
      value={v}
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      onBlur={() => v.trim() && v !== cur && onSave(v.trim())}
    />
  );
}

const REPEAT_PRESETS = ["毎日", "平日", "毎週", "毎月", "毎年"];

function RepeatEditor({
  note,
  disabled,
  onPatch,
}: {
  note: Note;
  disabled: boolean;
  onPatch: (f: Partial<Note>) => void;
}) {
  const rule = asRule(note.repeat_rule);
  const [text, setText] = useState(rule ? describeRepeat(rule) : "");
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(false);

  // 「毎週」「毎月」だけなら、いまの期日の曜日・日にちに合わせる
  function fit(r: NonNullable<ReturnType<typeof asRule>>) {
    const base = note.due_date ?? note.scheduled_date ?? jstDate();
    const d = new Date(`${base}T00:00:00Z`);
    if (r.freq === "week" && !r.weekdays && r.interval === 1) r.weekdays = [d.getUTCDay()];
    if (r.freq === "month" && r.monthday === undefined) r.monthday = d.getUTCDate();
    if (r.freq === "year" && r.month === undefined)
      Object.assign(r, {
        month: d.getUTCMonth() + 1,
        monthday: d.getUTCDate(),
      });
    return r;
  }
  function apply(v: string) {
    setErr("");
    if (!v.trim()) {
      setText("");
      return onPatch({ repeat_rule: null });
    }
    const p = parseRepeat(v);
    if (!p || p.rest) {
      setErr("読み取れませんでした（例: 毎月1日 / 3週間ごと / 毎週火・金 / 42日ごと）");
      return;
    }
    const r = fit(p.rule);
    setText(describeRepeat(r));
    const f: Partial<Note> = {
      repeat_rule: r,
      ...(p.from ? { repeat_from: p.from } : {}),
    };
    // 繰り返しには期日が要る。なければ今日にする
    if (!note.due_date && !note.scheduled_date) f.due_date = jstDate();
    onPatch(f);
    setEditing(false);
  }

  return (
    <>
      <div className="prop repeat-prop">
        <span>繰り返し</span>
        <div className="repeat-edit">
          {!editing && !rule ? (
            <div className="chips">
              {REPEAT_PRESETS.map((p) => (
                <button key={p} className="mini" disabled={disabled} onClick={() => apply(p)}>
                  {p}
                </button>
              ))}
              <button className="mini" disabled={disabled} onClick={() => setEditing(true)}>
                その他…
              </button>
            </div>
          ) : (
            <input
              value={text}
              disabled={disabled}
              placeholder="例: 3週間ごと / 毎月10日 / 毎週火・金"
              autoFocus={editing}
              onFocus={() => setEditing(true)}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  apply(text);
                }
              }}
              onBlur={() => (text !== (rule ? describeRepeat(rule) : "") ? apply(text) : setEditing(false))}
            />
          )}
          {rule && !editing && (
            <button className="mini" disabled={disabled} onClick={() => apply("")}>
              やめる
            </button>
          )}
        </div>
      </div>
      {err && <p className="error small prop-error">{err}</p>}
      {rule && (
        <div className="prop">
          <span>次の回は</span>
          <div className="seg">
            {(
              [
                ["due", "期日から数える"],
                ["done", "完了日から数える"],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                className={note.repeat_from === k ? "active" : ""}
                disabled={disabled}
                onClick={() => onPatch({ repeat_from: k })}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
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
          {!disabled && <button aria-label="タグを外す" onClick={() => onChange(tags.filter((x) => x !== t))}>
              <X size={12} strokeWidth={2.25} />
            </button>}
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
  const [target, setTarget] = useState<"calendar" | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function open(t: "calendar") {
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
      await api.send({
        note_id: note.id,
        target,
        text: title,
        date: date || null,
        time: time || null,
      });
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
        {time ? "1時間の予定として入れます" : "時刻が空なら終日の予定です"}
      </p>
      {msg && <p className="error small">{msg}</p>}
      <div className="actions">
        <button onClick={() => setTarget(null)}>やめる</button>
        <button className="primary" disabled={busy || !title.trim() || !date} onClick={send}>
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
        <h3>Google カレンダー</h3>
        {!status ? (
          <p>…</p>
        ) : !status.google.configured ? (
          <p>未設定（サーバーに OAuth クライアントを入れてください）。つなぐと「今日」「今後の予定」にカレンダーの予定も並びます。</p>
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
          メモの最初に「タスク」と言うとタスクになり（日時を言えば締め切り、「毎月1日」などを言えば繰り返し）、「予定」と言うとカレンダーへ自動で送ります。
          <br />
          例:「タスク、明日 牛乳を買う」「タスク、毎月10日 積立の確認」「予定、明日15時 歯医者」
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
  const hm = d.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (d.toDateString() === now.toDateString()) return hm;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}/${md}`;
}
