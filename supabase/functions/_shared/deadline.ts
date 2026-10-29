// 締め切りタスク: 締切だけ決まっていて、いつ手を付けてもよいタスク（2026-10-29）。PWA・ウォッチ・MCP で共通。
//   ・未完了で、締切が明日〜30日後。やる日（scheduled_date）・繰り返し・締切の時刻がないもの
//     （繰り返しはいつも窓の中に入ってしまう、時刻つきは「その時刻にやること」なので外す）
//   ・締切の 10 日前からは「間もなく」として目立たせ、今日の数・ウォッチの「今日」にも入れる
//   ・「今日やる」でやる日を今日にすると、締め切りタスクから外れて今日に移る
import { addDays } from "./repeat.ts";

export const DEADLINE_WINDOW_DAYS = 30;
export const DEADLINE_SOON_DAYS = 10;

type TaskLike = {
  is_task: boolean;
  done_at: string | null;
  due_date: string | null;
  due_time: string | null;
  scheduled_date: string | null;
  repeat_rule: unknown;
};

/** 締切までの日数（明日なら 1） */
export function daysLeft(due: string, today: string) {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400_000);
}

export function isDeadlineTask(n: TaskLike, today: string) {
  return (
    n.is_task &&
    !n.done_at &&
    !!n.due_date &&
    !n.due_time &&
    !n.scheduled_date &&
    !n.repeat_rule &&
    n.due_date > today &&
    n.due_date <= addDays(today, DEADLINE_WINDOW_DAYS)
  );
}

export const isDeadlineSoon = (n: TaskLike, today: string) =>
  isDeadlineTask(n, today) && daysLeft(n.due_date!, today) <= DEADLINE_SOON_DAYS;
