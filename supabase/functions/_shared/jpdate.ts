// 日本語の文から日時を読み取る小さなパーサー（Edge Function と PWA の両方で使う）。
// 例:「明日15時 歯医者」「来週の火曜 午後3時半 打ち合わせ」「10月30日 締め切り」
// 依存なし・時刻はすべて日本時間で扱う。

export type ParsedWhen = {
  date: string; // YYYY-MM-DD（日本時間）
  time: string | null; // HH:MM、なければ終日
  rest: string; // 日時の言葉を取り除いた残り（予定のタイトル向け）
};

const JST = 9 * 60 * 60 * 1000;
const WEEK = "日月火水木金土";

function jstParts(now: Date) {
  const d = new Date(now.getTime() + JST);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes() };
}

function ymd(y: number, m: number, d: number) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

function kanjiToNum(s: string): number {
  const digits: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch === "十") {
      total += (cur || 1) * 10;
      cur = 0;
    } else cur = cur * 10 + (digits[ch] ?? 0);
  }
  return total + cur;
}

/** 全角数字と漢数字（「十五日」「三時」など）を半角数字にそろえる */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ":")
    .replace(/[〇零一二三四五六七八九十]+(?=[月日時分])/g, (k) => String(kanjiToNum(k)));
}

export function parseWhen(input: string, now: Date = new Date()): ParsedWhen | null {
  let text = normalizeDigits(input);
  const today = jstParts(now);
  let date: { y: number; m: number; d: number } | null = null;
  let time: { h: number; min: number } | null = null;

  const take = (re: RegExp) => {
    const m = text.match(re);
    if (m) text = text.replace(m[0], " ");
    return m;
  };
  const addDays = (n: number) => ({ y: today.y, m: today.m, d: today.d + n });

  // --- 日付 ---
  let m: RegExpMatchArray | null;
  if ((m = take(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/))) date = { y: +m[1], m: +m[2], d: +m[3] };
  else if ((m = take(/(\d{1,2})月(\d{1,2})日/) ?? take(/(?<![\d:])(\d{1,2})\/(\d{1,2})(?![\d:])/))) {
    const mo = +m[1];
    const da = +m[2];
    // 過ぎた日付なら来年
    const past = mo < today.m || (mo === today.m && da < today.d);
    date = { y: today.y + (past ? 1 : 0), m: mo, d: da };
  } else if ((m = take(/明後日|あさって/))) date = addDays(2);
  else if ((m = take(/明日|あした|あす/))) date = addDays(1);
  else if ((m = take(/今日|きょう|本日/))) date = addDays(0);
  else if ((m = take(/(再来週|来週|今週)?の?([日月火水木金土])曜日?/))) {
    const target = WEEK.indexOf(m[2]);
    if (m[1]) {
      // 週は月曜はじまり
      const mondayOffset = -((today.wd + 6) % 7);
      const weeks = m[1] === "再来週" ? 2 : m[1] === "来週" ? 1 : 0;
      date = addDays(mondayOffset + weeks * 7 + ((target + 6) % 7));
    } else {
      date = addDays((target - today.wd + 7) % 7);
    }
  } else if ((m = take(/(?<!\d)(\d{1,2})日(?!間)/))) {
    const da = +m[1];
    date = da >= today.d ? { y: today.y, m: today.m, d: da } : { y: today.y, m: today.m + 1, d: da };
  }

  // --- 時刻 ---
  if ((m = take(/(午前|午後|朝|夜|夕方)?\s*(\d{1,2}):(\d{2})/) ?? take(/(午前|午後|朝|夜|夕方)?\s*(\d{1,2})時(?:(半)|(\d{1,2})分)?/))) {
    let h = +m[2];
    const min = m[3] === "半" ? 30 : m[4] !== undefined ? +m[4] : m[3] && /^\d+$/.test(m[3]) ? +m[3] : 0;
    if ((m[1] === "午後" || m[1] === "夜" || m[1] === "夕方") && h < 12) h += 12;
    // 「3時に電話」のように午前・午後がなく 1〜6 時なら、午後とみなす（未明の予定は「午前3時」と言う）
    else if (!m[1] && h >= 1 && h <= 6) h += 12;
    if (h <= 24 && min < 60) time = { h: h % 24, min };
  }

  if (!date && !time) return null;
  if (!date) {
    // 時刻だけなら、今日のその時刻が過ぎていれば明日
    const passed = time!.h < today.h || (time!.h === today.h && time!.min <= today.min);
    date = addDays(passed ? 1 : 0);
  }

  const rest = text
    .replace(/^[\s、。,.にのでから]+/, "")
    .replace(/[\s、。,.]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return {
    date: ymd(date.y, date.m, date.d),
    time: time ? `${String(time.h).padStart(2, "0")}:${String(time.min).padStart(2, "0")}` : null,
    rest,
  };
}

export type Route = { target: "todoist" | "calendar"; text: string };

/** ウォッチのメモ先頭の言葉で送り先を決める（「タスク、牛乳を買う」「予定 明日15時 歯医者」） */
export function routeByPrefix(body: string): Route | null {
  const m = body.trim().match(/^(タスク|やること|todo|to do|トゥードゥー|予定|カレンダー)[\s、。,.:：]+/i);
  if (!m) return null;
  const text = body.trim().slice(m[0].length).trim();
  if (!text) return null;
  return { target: /予定|カレンダー/.test(m[1]) ? "calendar" : "todoist", text };
}
