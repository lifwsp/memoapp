// 確認: 読み取った文・日時を見せ、タグをタップで選んでから「送る」
import * as hmUI from "@zos/ui";
import { createKeyboard, deleteKeyboard, inputType } from "@zos/ui";
import { replace } from "@zos/router";
import { BasePage } from "@zeppos/zml/base-page";
import { loadQueue, saveQueue, newMemo, loadSync } from "../utils/queue";
import { PAD, W, TYPES, GRAY, DARK, ROUND } from "../utils/ui";

const MAX_TAGS = 6;

Page(
  BasePage({
    state: { text: "", kind: "voice", type: "memo", tags: {}, chips: [], body: null, info: null, seq: 0 },

    onInit(params) {
      try {
        const p = JSON.parse(params || "{}");
        this.state.text = p.text || "";
        this.state.kind = p.kind || "voice";
        this.state.type = TYPES[p.type] ? p.type : "memo";
      } catch (e) {}
    },

    build() {
      const t = TYPES[this.state.type];
      let y = ROUND ? 50 : 8;
      hmUI.createWidget(hmUI.widget.TEXT, {
        x: PAD, y, w: W, h: 30, text: t.label, text_size: 22, color: t.color,
      });
      y += 30;
      this.state.body = hmUI.createWidget(hmUI.widget.TEXT, {
        x: PAD, y, w: W, h: 92, text: this.state.text, text_size: 28, color: 0xffffff,
        text_style: hmUI.text_style.WRAP,
      });
      y += 94;
      this.state.info = hmUI.createWidget(hmUI.widget.TEXT, {
        x: PAD, y, w: W, h: 32, text: this.state.type === "memo" ? "受信箱へ" : "読み取り中…", text_size: 22, color: GRAY,
        text_style: hmUI.text_style.ELLIPSIS,
      });
      y += 38;

      // タグ（スマホから取ってきた「よく使うタグ」。何も選ばなければタグなし）
      const tags = (loadSync().tags || []).slice(0, MAX_TAGS);
      const cw = (W - 10) / 2;
      tags.forEach((tag, i) => {
        const cx = PAD + (i % 2) * (cw + 10);
        const cy = y + Math.floor(i / 2) * 62;
        const chip = hmUI.createWidget(hmUI.widget.BUTTON, {
          x: cx, y: cy, w: cw, h: 54, radius: 27,
          text: `#${tag}`, text_size: 24, color: 0xdddddd,
          normal_color: DARK, press_color: 0x3a3a3a,
          click_func: () => this.toggleTag(tag, chip, cx, cy, cw),
        });
      });
      y += Math.ceil(tags.length / 2) * 62 + (tags.length ? 4 : 0);

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: PAD, y, w: W, h: 72, radius: 20,
        text: "送る", text_size: 34, color: t.text,
        normal_color: t.color, press_color: t.press,
        click_func: () => this.send(),
      });
      y += 82;
      const hw = (W - 10) / 2;
      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: PAD, y, w: hw, h: 60, radius: 18,
        text: "言い直す", text_size: 26, color: 0xffffff,
        normal_color: DARK, press_color: 0x3a3a3a,
        click_func: () => this.redo(),
      });
      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: PAD + hw + 10, y, w: hw, h: 60, radius: 18,
        text: "やめる", text_size: 26, color: 0xff8a80,
        normal_color: DARK, press_color: 0x3a3a3a,
        click_func: () => replace({ url: "page/index" }),
      });
      // 角型でも最後のボタンがスクロールで押せるよう余白を置く
      hmUI.createWidget(hmUI.widget.TEXT, { x: 0, y: y + 60, w: 10, h: ROUND ? 80 : 20, text: "" });

      this.preview();
    },

    toggleTag(tag, chip, x, y, w) {
      const on = !this.state.tags[tag];
      this.state.tags[tag] = on;
      chip.setProperty(hmUI.prop.MORE, {
        x, y, w, h: 54, radius: 27,
        text: on ? `✓ #${tag}` : `#${tag}`, text_size: 24,
        color: on ? 0x111111 : 0xdddddd,
        normal_color: on ? 0xffffff : DARK, press_color: 0x3a3a3a,
      });
    },

    // 締め切り・予定の日時はスマホ（サーバー）で読み取り、送る前に見せる。届かなければ黙ってそのまま
    async preview() {
      if (this.state.type === "memo") return;
      const seq = ++this.state.seq;
      try {
        const r = await this.request({ method: "PREVIEW", params: { text: this.state.text, type: this.state.type } });
        if (seq !== this.state.seq || !r || !r.ok) throw new Error("ng");
        this.state.info.setProperty(hmUI.prop.MORE, {
          text: `${r.title} · ${r.info}`,
          color: r.warn ? 0xff8a80 : 0x80cbc4,
        });
      } catch (e) {
        if (seq === this.state.seq) this.state.info.setProperty(hmUI.prop.TEXT, "（スマホ未接続・送ってから読み取ります）");
      }
    },

    redo() {
      createKeyboard({
        inputType: this.state.kind === "voice" ? inputType.VOICE : inputType.CHAR,
        text: this.state.kind === "voice" ? "" : this.state.text,
        onComplete: (_kb, result) => {
          const text = ((result && result.data) || "").trim();
          deleteKeyboard();
          if (!text) return;
          this.state.text = text;
          this.state.body.setProperty(hmUI.prop.TEXT, text);
          if (this.state.type !== "memo") this.state.info.setProperty(hmUI.prop.TEXT, "読み取り中…");
          this.preview();
        },
        onCancel: () => deleteKeyboard(),
      });
    },

    send() {
      const tags = Object.keys(this.state.tags).filter((k) => this.state.tags[k]);
      saveQueue([...loadQueue(), newMemo(this.state.text, this.state.kind, this.state.type, tags)]);
      // ホームに戻ると送信が始まる
      replace({ url: "page/index" });
    },
  })
);
