// 繰り返しタスクの規則（Edge Function と PWA の両方で使う）。
// DB の public.next_occurrence() と同じ計算をする。変えるときは両方そろえる。

import { normalizeDigits, parseWhen } from "./jpdate.ts";

export type RepeatFreq = "day" | "week" | "month" | "year";
export type RepeatRule = {
  freq: RepeatFreq;
  interval: number;
  weekdays?: number[]; // freq=week のとき。0=日曜
  monthday?: number; // freq=month/year のとき。-1 = 月末
  month?: number; // freq=year のとき
};
export type RepeatFrom = "due" | "done";

const WEEK = "日月火水木金土";

// ---------- 日付の計算（YYYY-MM-DD の文字列で扱う） ----------

function toUtc(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmt(t: Date) {
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}
export function addDays(s: string, n: number) {
  const t = toUtc(s);
  t.setUTCDate(t.getUTCDate() + n);
  return fmt(t);
}
function dow(s: string) {
  return toUtc(s).getUTCDay();
}
function monthDay(y: number, m: number, d: number) {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(y, m - 1, d === -1 || d >= last ? last : d)));
}

export function nextOccurrence(rule: RepeatRule, base: string): string {
  const n = Math.max(rule.interval || 1, 1);
  const [y, m, d] = base.split("-").map(Number);
  if (rule.freq === "day") return addDays(base, n);
  if (rule.freq === "week") {
    const wds = [...(rule.weekdays ?? [])].sort();
    if (!wds.length) return addDays(base, 7 * n);
    for (let i = 1; i <= 6; i++) {
      const c = addDays(base, i);
      if (dow(c) === 1) break; // 月曜をまたいだら次の週
      if (wds.includes(dow(c))) return c;
    }
    const monday = addDays(base, -((dow(base) + 6) % 7) + 7 * n);
    for (let i = 0; i < 7; i++) if (wds.includes(dow(addDays(monday, i)))) return addDays(monday, i);
    return addDays(base, 7 * n);
  }
  if (rule.freq === "month") {
    const md = rule.monthday ?? d;
    const same = monthDay(y, m, md);
    if (same > base) return same;
    const ym = y * 12 + m - 1 + n;
    return monthDay(Math.floor(ym / 12), (ym % 12) + 1, md);
  }
  const mo = rule.month ?? m;
  const md = rule.monthday ?? d;
  const same = monthDay(y, mo, md);
  if (same > base) return same;
  return monthDay(y + n, mo, md);
}

/** 規則に合う、today 以降で最初の日 */
export function firstOccurrence(rule: RepeatRule, today: string): string {
  // 規則が日付を決めない（○日ごと、曜日なしの○週ごと）なら今日から
  if (rule.freq === "day" || (rule.freq === "week" && !rule.weekdays?.length)) return today;
  if (rule.freq === "week" && rule.weekdays!.includes(dow(today))) return today;
  if (rule.freq === "month" && rule.monthday === undefined) return today;
  if (rule.freq === "year" && rule.month === undefined) return today;
  const step: RepeatRule = { ...rule, interval: 1 };
  return nextOccurrence(step, addDays(today, -1));
}

// ---------- 表示 ----------

export function describeRepeat(rule: RepeatRule | null | undefined, from?: RepeatFrom): string {
  if (!rule) return "";
  const n = Math.max(rule.interval || 1, 1);
  const wd = (rule.weekdays ?? []).slice().sort().map((i) => WEEK[i]);
  const md = rule.monthday === -1 ? "末日" : rule.monthday ? `${rule.monthday}日` : "";
  let s: string;
  if (rule.freq === "day") s = n === 1 ? "毎日" : `${n}日ごと`;
  else if (rule.freq === "week") {
    const days = wd.join("・");
    const weekdaysOnly = wd.join("") === "月火水木金";
    if (n === 1) s = weekdaysOnly ? "平日" : days ? `毎週${days}曜` : "毎週";
    else if (n === 2) s = days ? `隔週${days}曜` : "隔週";
    else s = days ? `${n}週ごと ${days}曜` : `${n}週間ごと`;
  } else if (rule.freq === "month") s = n === 1 ? (md ? `毎月${md}` : "毎月") : `${n}か月ごと${md ? ` ${md}` : ""}`;
  else {
    const date = rule.month ? `${rule.month}月${md}` : "";
    s = n === 1 ? (date ? `毎年${date}` : "毎年") : `${n}年ごと${date ? ` ${date}` : ""}`;
  }
  return from === "done" ? `${s}（完了日から）` : s;
}

// ---------- 日本語の言い方から規則を読む ----------

export type ParsedRepeat = {
  rule: RepeatRule;
  from: RepeatFrom | null; // 「完了から」「終わってから」などがあれば done
  rest: string; // 繰り返しの言葉を取り除いた残り
};

const UNIT = String.raw`(日|週間?|ヶ月|か月|カ月|ヵ月|ケ月|箇月|月|年)`;
const EVERY = String.raw`(?:毎|ごと|おき|置き|に1回|に一回)`;

function weekdaysIn(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const i = WEEK.indexOf(ch);
    if (i >= 0 && !out.includes(i)) out.push(i);
  }
  return out.sort();
}

function unitFreq(u: string): RepeatFreq {
  if (u === "日") return "day";
  if (u.startsWith("週")) return "week";
  if (u === "年") return "year";
  return "month";
}

/**
 * 「毎日」「毎週月曜」「月水金」「平日」「隔週日曜」「毎月10日」「毎月末」「毎年11月30日」
 * 「3週間ごと」「4日毎」「42日おき」「1ヶ月ごと」「年ごと11/30」などを読む。
 */
export function parseRepeat(input: string): ParsedRepeat | null {
  let text = normalizeDigits(input);
  let from: RepeatFrom | null = null;
  const take = (re: RegExp) => {
    const m = text.match(re);
    if (m) text = text.replace(m[0], " ");
    return m;
  };
  if (take(/[（(]?(完了|終わって|やって|済んで)(日|して|から|後)[^\s、。)）]*[)）]?/)) from = "done";

  let rule: RepeatRule | null = null;
  let m: RegExpMatchArray | null;
  const wdPart = String.raw`((?:[日月火水木金土][・,、と]?)+)(?:曜日?|(?=$|[\s、。]))`;

  if ((m = take(/毎日/))) rule = { freq: "day", interval: 1 };
  else if ((m = take(/平日(毎日)?/))) rule = { freq: "week", interval: 1, weekdays: [1, 2, 3, 4, 5] };
  else if ((m = take(new RegExp(`隔週の?\\s*(?:${wdPart})?`)))) rule = { freq: "week", interval: 2, ...(m[1] ? { weekdays: weekdaysIn(m[1]) } : {}) };
  else if ((m = take(new RegExp(`毎週の?\\s*(?:${wdPart})?`)))) rule = { freq: "week", interval: 1, ...(m[1] ? { weekdays: weekdaysIn(m[1]) } : {}) };
  else if ((m = take(/毎月の?\s*(末日?|月末|(\d{1,2})日)?/))) {
    rule = { freq: "month", interval: 1, ...(m[1] ? { monthday: m[2] ? +m[2] : -1 } : {}) };
  } else if ((m = take(/(?:毎年|年ごと|1年ごと|1年毎)の?\s*((\d{1,2})[月/](\d{1,2})日?)?/))) {
    rule = { freq: "year", interval: 1, ...(m[1] ? { month: +m[2], monthday: +m[3] } : {}) };
  } else if ((m = take(new RegExp(String.raw`(\d{1,3})\s*${UNIT}\s*${EVERY}`)))) {
    const freq = unitFreq(m[2]);
    rule = { freq, interval: +m[1] };
    // 「42日おき」は「42日ごと」と同じ扱い（厳密には43日ごとだが、言葉としてはこちらが多い）
  } else if ((m = take(/(?<=^|[\s、。])([日月火水木金土](?:[・,、]?[日月火水木金土])+)(?:曜日?)?(?:毎週)?(?=$|[\s、。])/))) {
    // 「月水金」のように曜日を並べただけ
    rule = { freq: "week", interval: 1, weekdays: weekdaysIn(m[1]) };
  } else if ((m = take(new RegExp(`毎${wdPart}`)))) {
    rule = { freq: "week", interval: 1, weekdays: weekdaysIn(m[1]) };
  }

  if (!rule) return null;
  const rest = text
    .replace(/^[\s、。,.にのでから]+/, "")
    .replace(/[\s、。,.]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { rule, from, rest };
}

/** DB から読んだ値を RepeatRule として安全に読む */
export function asRule(v: unknown): RepeatRule | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (!["day", "week", "month", "year"].includes(r.freq as string)) return null;
  const out: RepeatRule = { freq: r.freq as RepeatFreq, interval: Math.max(1, Math.floor(Number(r.interval) || 1)) };
  if (Array.isArray(r.weekdays)) {
    const w = r.weekdays.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
    if (w.length) out.weekdays = [...new Set(w)].sort();
  }
  const md = Number(r.monthday);
  if (Number.isInteger(md) && (md === -1 || (md >= 1 && md <= 31))) out.monthday = md;
  const mo = Number(r.month);
  if (Number.isInteger(mo) && mo >= 1 && mo <= 12) out.month = mo;
  return out;
}

/** 日本時間の今日 YYYY-MM-DD */
export function jstToday(now: Date = new Date()) {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

export type TaskFields = {
  title: string;
  due_date: string | null;
  due_time: string | null;
  repeat_rule: RepeatRule | null;
  repeat_from: RepeatFrom;
};

/**
 * 「毎月1日 カード支払い」「明日15時 歯医者に電話」「布団カバー 3週間ごと 完了日から」
 * のような一文から、タスクのタイトル・期日・繰り返しを読む。
 */
export function taskFromText(text: string, now: Date = new Date()): TaskFields {
  const rep = parseRepeat(text);
  const when = parseWhen(rep ? rep.rest : text, now);
  const title = ((when?.rest ?? rep?.rest ?? text) || text).trim().slice(0, 200);
  let due = when?.date ?? null;
  if (rep && !due) due = firstOccurrence(rep.rule, jstToday(now));
  return {
    title,
    due_date: due,
    due_time: when?.time ?? null,
    repeat_rule: rep?.rule ?? null,
    repeat_from: rep?.from ?? "due",
  };
}
