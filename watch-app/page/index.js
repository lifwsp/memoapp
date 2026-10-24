import * as hmUI from "@zos/ui";
import { createKeyboard, deleteKeyboard, inputType } from "@zos/ui";
import { showToast } from "@zos/interaction";
import { log as Logger } from "@zos/utils";
import { BasePage } from "@zeppos/zml/base-page";
import { DEVICE_WIDTH, DEVICE_HEIGHT } from "../utils/device";
import { loadQueue, saveQueue, newMemo } from "../utils/queue";

const logger = Logger.getLogger("wristmemo");
const ROUND = DEVICE_WIDTH === DEVICE_HEIGHT; // 丸型ウォッチ判定（Bip 6 は角型）
const PAD = ROUND ? 70 : 20;
const ROWS = 5;

Page(
  BasePage({
    state: { queue: [], rows: [], header: null, flushing: false },

    build() {
      const btnW = (DEVICE_WIDTH - PAD * 2 - 16) / 2;
      const btnY = ROUND ? 90 : 60;

      this.state.header = hmUI.createWidget(hmUI.widget.TEXT, {
        x: PAD, y: ROUND ? 40 : 12, w: DEVICE_WIDTH - PAD * 2, h: 40,
        text: "WristMemo", text_size: 28, color: 0xaaaaaa,
        align_h: hmUI.align.CENTER_H,
      });

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: PAD, y: btnY, w: btnW, h: 110, radius: 20,
        text: "音声", text_size: 36,
        normal_color: 0x1e88e5, press_color: 0x1565c0,
        click_func: () => this.openKeyboard(inputType.VOICE, "voice"),
      });
      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: PAD + btnW + 16, y: btnY, w: btnW, h: 110, radius: 20,
        text: "文字", text_size: 36,
        normal_color: 0x43a047, press_color: 0x2e7d32,
        click_func: () => this.openKeyboard(inputType.CHAR, "text"),
      });

      const listY = btnY + 130;
      const rowH = Math.floor((DEVICE_HEIGHT - listY - (ROUND ? 60 : 16)) / ROWS);
      for (let i = 0; i < ROWS; i++) {
        this.state.rows.push(
          hmUI.createWidget(hmUI.widget.TEXT, {
            x: PAD, y: listY + i * rowH, w: DEVICE_WIDTH - PAD * 2, h: rowH,
            text: "", text_size: 24, color: 0xffffff,
            align_v: hmUI.align.CENTER_V,
            text_style: hmUI.text_style.ELLIPSIS,
          })
        );
      }

      this.state.queue = loadQueue();
      this.render();
      this.flush();
    },

    openKeyboard(type, kind) {
      createKeyboard({
        inputType: type,
        text: "",
        onComplete: (_kb, result) => {
          const text = ((result && result.data) || "").trim();
          deleteKeyboard();
          if (!text) return;
          this.state.queue = saveQueue([...this.state.queue, newMemo(text, kind)]);
          this.render();
          this.flush();
        },
        onCancel: () => deleteKeyboard(),
      });
    },

    // 未送信メモを1件ずつ Side Service（スマホの Zepp アプリ内）へ送る
    async flush() {
      if (this.state.flushing) return;
      this.state.flushing = true;
      try {
        for (const memo of this.state.queue) {
          if (memo.status === "sent") continue;
          try {
            const res = await this.request({
              method: "ADD_NOTE",
              params: { id: memo.id, text: memo.text, kind: memo.kind, createdAt: memo.createdAt },
            });
            memo.status = res && res.ok ? "sent" : "error";
            memo.error = res && !res.ok ? String(res.error || "") : undefined;
          } catch (e) {
            // BLE 切断・Side Service 未起動など。次回起動時に再送する
            logger.log("send failed", e && (e.message || e.reason));
            memo.status = "error";
            memo.error = "phone";
            break;
          } finally {
            this.state.queue = saveQueue(this.state.queue);
            this.render();
          }
        }
      } finally {
        this.state.flushing = false;
      }
      const left = this.state.queue.filter((m) => m.status !== "sent").length;
      if (left) showToast({ content: `未送信 ${left} 件（次回再送）` });
    },

    render() {
      const recent = this.state.queue.slice(-ROWS).reverse();
      const pending = this.state.queue.filter((m) => m.status !== "sent").length;
      this.state.header.setProperty(
        hmUI.prop.TEXT,
        pending ? `WristMemo  未送信 ${pending}` : "WristMemo"
      );
      this.state.rows.forEach((w, i) => {
        const m = recent[i];
        const mark = !m ? "" : m.status === "sent" ? "✓ " : m.status === "error" ? "! " : "… ";
        w.setProperty(hmUI.prop.MORE, {
          text: m ? mark + m.text : "",
          color: !m ? 0xffffff : m.status === "sent" ? 0x9e9e9e : 0xffca28,
        });
      });
    },
  })
);
