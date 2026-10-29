// ウィジェット（文字盤から左スワイプで出る1画面）。
// 通信はできないので、アプリが最後に同期した内容（LocalStorage）を表示するだけ。
// 上の欄をタップ → 「今日」一覧、下のボタン → すぐメモ入力。
import * as hmUI from "@zos/ui";
import { push } from "@zos/router";
import { loadSync } from "../utils/queue";
import { PAD, W, GRAY, DARK, ROUND, TYPES } from "../utils/ui";
import { DEVICE_HEIGHT } from "../utils/device";

const MAX_ROWS = 3;

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function cut(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

SecondaryWidget({
  state: { widgets: [] },

  build() {
    this.render();
  },

  // 左右にスワイプして戻ってきたとき、アプリ側で同期された新しい内容を出し直す
  onResume() {
    this.render();
  },

  add(type, opts) {
    const w = hmUI.createWidget(type, opts);
    this.state.widgets.push(w);
    return w;
  },

  render() {
    try {
      this.state.widgets.forEach((w) => hmUI.deleteWidget(w));
      this.state.widgets = [];
      const s = loadSync();
      const stale = s.date && s.date !== todayStr();
      const tasks = stale ? [] : s.tasks || [];
      const events = stale ? [] : s.events || [];
      const openToday = () => push({ url: "page/today" });

      const top = ROUND ? 70 : 16;
      const btnH = 96;
      const btnY = DEVICE_HEIGHT - btnH - (ROUND ? 70 : 20);
      const cardH = btnY - top - 14;

      const card = this.add(hmUI.widget.FILL_RECT, { x: PAD, y: top, w: W, h: cardH, radius: 22, color: DARK });
      card.addEventListener(hmUI.event.CLICK_UP, openToday);

      let y = top + 14;
      const head = this.add(hmUI.widget.TEXT, {
        x: PAD + 18, y, w: W - 36, h: 44,
        text: !s.date ? "今日 --" : `今日  タスク ${tasks.length}` + (events.length ? ` · 予定 ${events.length}` : ""),
        text_size: 30, color: 0xffffff, align_v: hmUI.align.CENTER_V,
      });
      head.addEventListener(hmUI.event.CLICK_UP, openToday);
      y += 52;

      const lines = [];
      for (const e of events) lines.push({ text: `${e.time || "終日"} ${e.title}`, color: 0x81c784 });
      for (const t of tasks) {
        const sub = t.overdue ? "（期限切れ）" : t.left ? `（あと${t.left}日）` : t.time ? `（${t.time}）` : "";
        lines.push({ text: `・${t.title}${sub}`, color: t.overdue ? 0xef5350 : t.left ? 0xffa726 : 0xffffff });
      }
      const shown = lines.slice(0, MAX_ROWS);
      if (!shown.length) {
        shown.push({ text: stale ? "アプリを開くと更新します" : !s.date ? "アプリを開くと表示します" : "今日のタスクはありません", color: GRAY });
      }
      for (const l of shown) {
        const t = this.add(hmUI.widget.TEXT, {
          x: PAD + 18, y, w: W - 36, h: 40, text: cut(l.text, 16), text_size: 24, color: l.color,
          align_v: hmUI.align.CENTER_V, text_style: hmUI.text_style.ELLIPSIS,
        });
        t.addEventListener(hmUI.event.CLICK_UP, openToday);
        y += 42;
      }
      if (lines.length > MAX_ROWS) {
        const more = this.add(hmUI.widget.TEXT, {
          x: PAD + 18, y, w: W - 36, h: 32, text: `ほか ${lines.length - MAX_ROWS} 件`, text_size: 22, color: GRAY,
        });
        more.addEventListener(hmUI.event.CLICK_UP, openToday);
      }

      if (s.at) {
        const d = new Date(s.at);
        const stamp = this.add(hmUI.widget.TEXT, {
          x: PAD + 18, y: top + cardH - 40, w: W - 36, h: 32,
          text: `${stale ? `${d.getMonth() + 1}/${d.getDate()} ` : ""}${pad2(d.getHours())}:${pad2(d.getMinutes())} 更新`,
          text_size: 20, color: GRAY, align_h: hmUI.align.RIGHT,
        });
        stamp.addEventListener(hmUI.event.CLICK_UP, openToday);
      }

      const memo = TYPES.memo;
      this.add(hmUI.widget.BUTTON, {
        x: PAD, y: btnY, w: W, h: btnH, radius: 24,
        text: "メモする", text_size: 36, color: memo.text,
        normal_color: memo.color, press_color: memo.press,
        click_func: () => push({ url: "page/index", params: JSON.stringify({ quick: "memo" }) }),
      });
    } catch (e) {
      console.log("widget error", e);
    }
  },
});
