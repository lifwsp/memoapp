import type { RepeatRule } from "./repeat.ts";

/** Empty strings remain supported for older MCP clients; null explicitly clears a field. */
export function nullableDate(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === "0000" ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
    throw new Error(`${field}: YYYY-MM-DD の有効な日付を指定してください`);
  return value;
}

export function nullableTime(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw new Error("due_time: HH:MM の有効な時刻を指定してください");
  return value;
}

export function nullableReminder(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error("remind_at: タイムゾーン付き ISO 8601 日時を指定してください");
  nullableDate(value.slice(0, 10), "remind_at");
  return new Date(value).toISOString();
}

export function validateRule(value: unknown): RepeatRule | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("repeat_rule: 規則オブジェクトが必要です");
  const r = value as Record<string, unknown>;
  const integer = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
  if (!["day", "week", "month", "year"].includes(String(r.freq)) || !integer(r.interval, 1, 1000) ||
      (r.weekdays !== undefined && (r.freq !== "week" || !Array.isArray(r.weekdays) || !r.weekdays.every(v => integer(v, 0, 6)))) ||
      (r.monthday !== undefined && (!["month", "year"].includes(String(r.freq)) || !(r.monthday === -1 || integer(r.monthday, 1, 31)))) ||
      (r.month !== undefined && (r.freq !== "year" || !integer(r.month, 1, 12))))
    throw new Error("repeat_rule: 繰り返し規則が不正です");
  return r as RepeatRule;
}

export function taskPage(a: Record<string, unknown>) {
  const limit = a.limit ?? 100;
  const offset = a.offset ?? 0;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100 || !Number.isSafeInteger(offset) || Number(offset) < 0)
    throw new Error("limit は1〜100、offset は0以上の整数を指定してください");
  return { limit: Number(limit), offset: Number(offset) };
}
