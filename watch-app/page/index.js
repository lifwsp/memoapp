// ホーム: 「メモ・タスク・予定」を選ぶとすぐ入力（既定は音声）→ 確認画面へ
import * as hmUI from "@zos/ui";
import { createKeyboard, deleteKeyboard, inputType } from "@zos/ui";
import { push } from "@zos/router";
import { showToast } from "@zos/interaction";
import { LocalStorage } from "@zos/storage";
import { BasePage } from "@zeppos/zml/base-page";
import { loadQueue, loadSync } from "../utils/queue";
import { flushQueue, syncFromPhone } from "../utils/send";
import { PAD, W, TYPES, GRAY, DARK, ROUND } from "../utils/ui";

const storage = new LocalStorage();

Page(
  BasePage({
    state: { header: null, today: null, mode: null, kind: "voice" },

    build() {
      this.state.kind = storage.getItem("input_kind", "voice") === "text" ? "text" : "voice";
      const top = ROUND ? 50 : 8;

      this.state.header = hmUI.createWidget(hmUI.widget.TEXT, {
        x: PAD, y: top, w: W, h: 38,
        text: "WristMemo", text_size: 24, color: GRAY,
        align_h: hmUI.align.CENTER_H, align_v: hmUI.align.CENTER_V,
      });

      let y = top + 44;
      for (const type of ["memo", "task", "event"]) {
        const t = TYPES[type];
        hmUI.createWidget(hmUI.widget.BUTTON, {
          x: PAD, y, w: W, h: 84, radius: 22,
          text: t.label, text_size: 38, color: t.text,
          normal_color: t.color, press_color: t.press,
          click_func: () => this.openKeyboard(type),
        });
        y += 94;
      }

      this.state.today = hmUI.createWidget(hmUI.widget.BUTTON, {
        x: PAD, y, w: W, h: 58, radius: 16,
        text: this.todayText(loadSync()), text_size: 26, color: 0xffffff,
        normal_color: DARK, press_color: 0x3a3a3a,
        click_func: () => push({ url: "page/today" }),
      });
      y += 66;

      this.state.mode = hmUI.createWidget(hmUI.widget.BUTTON, {
        x: PAD, y, w: W, h: 40, radius: 12,
        text: this.modeText(), text_size: 22, color: GRAY,
        normal_color: 0x000000, press_color: DARK,
        click_func: () => {
          this.state.kind = this.state.kind === "voice" ? "text" : "voice";
          storage.setItem("input_kind", this.state.kind);
          this.state.mode.setProperty(hmUI.prop.TEXT, this.modeText());
        },
      });

      this.renderHeader(loadQueue());
      this.refresh();
    },

    async refresh() {
      const left = await flushQueue(this, (q) => this.renderHeader(q));
      if (left) showToast({ content: `未送信 ${left} 件（次回再送）` });
      const s = await syncFromPhone(this);
      if (s) this.state.today.setProperty(hmUI.prop.TEXT, this.todayText(s));
    },

    modeText() {
      return this.state.kind === "voice" ? "入力: 音声（タップで文字に）" : "入力: 文字（タップで音声に）";
    },

    todayText(s) {
      const tasks = (s.tasks || []).length;
      const events = (s.events || []).length;
      return `今日  タスク ${tasks} · 予定 ${events}`;
    },

    renderHeader(queue) {
      const pending = queue.filter((m) => m.status !== "sent").length;
      const last = queue[queue.length - 1];
      let text = "WristMemo";
      if (pending) text = `未送信 ${pending} 件`;
      else if (last) text = `✓ ${last.text}`;
      this.state.header.setProperty(hmUI.prop.MORE, { text, color: pending ? 0xffca28 : GRAY });
    },

    openKeyboard(type) {
      const kind = this.state.kind;
      createKeyboard({
        inputType: kind === "voice" ? inputType.VOICE : inputType.CHAR,
        text: "",
        onComplete: (_kb, result) => {
          const text = ((result && result.data) || "").trim();
          deleteKeyboard();
          if (!text) return;
          push({ url: "page/confirm", params: JSON.stringify({ text, kind, type }) });
        },
        onCancel: () => deleteKeyboard(),
      });
    },
  })
);
