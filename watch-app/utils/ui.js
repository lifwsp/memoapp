import { DEVICE_WIDTH, DEVICE_HEIGHT } from "./device";

export const ROUND = DEVICE_WIDTH === DEVICE_HEIGHT; // 丸型ウォッチ判定（Bip 6 は角型 390x450）
export const PAD = ROUND ? 60 : 20;
export const W = DEVICE_WIDTH - PAD * 2;

export const TYPES = {
  memo: { label: "メモ", color: 0xf5c518, press: 0xc9a10f, text: 0x111111 },
  task: { label: "タスク", color: 0x1e88e5, press: 0x1565c0, text: 0xffffff },
  event: { label: "予定", color: 0x43a047, press: 0x2e7d32, text: 0xffffff },
};

export const GRAY = 0x9e9e9e;
export const DARK = 0x262626;
