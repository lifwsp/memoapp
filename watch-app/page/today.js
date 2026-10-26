// 今日: カレンダーの予定と、期限切れ・今日のタスク。タスクをタップで完了（もう一度タップで取り消し）
import * as hmUI from "@zos/ui";
import { showToast } from "@zos/interaction";
import { BasePage } from "@zeppos/zml/base-page";
import { loadSync } from "../utils/queue";
import { syncFromPhone } from "../utils/send";
import { PAD, W, GRAY, DARK, ROUND } from "../utils/ui";

const ROW_H = 84;

Page(
  BasePage({
    state: { widgets: [], done: {}, busy: {} },

    build() {
      this.render(loadSync(), "更新中…");
      syncFromPhone(this).then((s) => {
        if (s) this.render(s, "");
        else this.render(loadSync(), "スマホにつながりません（前回の内容）");
      });
    },

    add(type, opts) {
      const w = hmUI.createWidget(type, opts);
      this.state.widgets.push(w);
      return w;
    },

    render(s, note) {
      this.state.widgets.forEach((w) => hmUI.deleteWidget(w));
      this.state.widgets = [];
      let y = ROUND ? 50 : 8;
      this.add(hmUI.widget.TEXT, {
        x: PAD, y, w: W, h: 34, text: note || "今日", text_size: 24, color: GRAY,
        align_h: hmUI.align.CENTER_H,
      });
      y += 40;

      for (const e of s.events || []) {
        this.add(hmUI.widget.FILL_RECT, { x: PAD, y: y + 6, w: 6, h: 44, radius: 3, color: 0x43a047 });
        this.add(hmUI.widget.TEXT, {
          x: PAD + 16, y, w: W - 16, h: 56,
          text: `${e.time || "終日"}  ${e.title}`, text_size: 24, color: 0xffffff,
          align_v: hmUI.align.CENTER_V, text_style: hmUI.text_style.ELLIPSIS,
        });
        y += 60;
      }
      if ((s.events || []).length) y += 8;

      const tasks = s.tasks || [];
      if (!tasks.length) {
        this.add(hmUI.widget.TEXT, {
          x: PAD, y, w: W, h: 60, text: "今日のタスクはありません", text_size: 24, color: GRAY,
          align_h: hmUI.align.CENTER_H, align_v: hmUI.align.CENTER_V,
        });
        y += 60;
      }
      for (const t of tasks) {
        const rowY = y;
        this.add(hmUI.widget.FILL_RECT, { x: PAD, y: rowY, w: W, h: ROW_H - 8, radius: 16, color: DARK });
        const label = this.add(hmUI.widget.TEXT, {
          x: PAD + 14, y: rowY, w: W - 24, h: ROW_H - 8,
          text: this.rowText(t), text_size: 24, color: this.state.done[t.id] ? GRAY : 0xffffff,
          align_v: hmUI.align.CENTER_V, text_style: hmUI.text_style.WRAP,
        });
        label.addEventListener(hmUI.event.CLICK_UP, () => this.toggle(t, label));
        y += ROW_H;
      }
      this.add(hmUI.widget.TEXT, { x: 0, y, w: 10, h: ROUND ? 80 : 20, text: "" });
    },

    rowText(t) {
      const d = this.state.done[t.id];
      const title = t.title.length > 15 ? `${t.title.slice(0, 15)}…` : t.title;
      if (d) return `✓ ${title}\n   ${d.next ? `次は ${d.next}` : "完了"}（タップで戻す）`;
      const sub = [t.overdue ? `期限切れ ${t.due}` : t.time ? `${t.time}まで` : "", t.repeat || ""].filter(Boolean).join(" · ");
      return `○ ${title}${sub ? `\n   ${sub}` : ""}`;
    },

    async toggle(t, label) {
      if (this.state.busy[t.id]) return;
      this.state.busy[t.id] = true;
      const d = this.state.done[t.id];
      try {
        if (!d) {
          const r = await this.request({ method: "COMPLETE", params: { id: t.id } });
          if (!r || !r.ok) throw new Error((r && r.error) || "ng");
          this.state.done[t.id] = { next: r.next, before: r.before };
        } else {
          const r = await this.request({ method: "RESTORE", params: { id: t.id, before: d.before } });
          if (!r || !r.ok) throw new Error((r && r.error) || "ng");
          delete this.state.done[t.id];
        }
        label.setProperty(hmUI.prop.MORE, { text: this.rowText(t), color: this.state.done[t.id] ? GRAY : 0xffffff });
      } catch (e) {
        showToast({ content: "スマホにつながりません" });
      } finally {
        this.state.busy[t.id] = false;
      }
    },
  })
);
