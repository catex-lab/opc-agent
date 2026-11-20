/**
 * 闸门用的 Chromium 系浏览器路径解析（2026-11-21）。
 *
 * 背景：83 个闸门硬编码 `C:\Program Files\Google\Chrome\Application\chrome.exe`，
 * 本机 Chrome 一旦卸载/挪位，这些闸门会集体在 `launch()` 上崩掉且报错只有
 * 一行「executable doesn't exist」。这里的解析顺序：
 *
 *   1. `OPC_CHROME` 环境变量（显式指定，与 make-icons.mjs 的既有约定一致）
 *   2. Google Chrome 标准路径（历史默认）
 *   3. Microsoft Edge（Windows 机器上几乎必有，playwright-core 可直接驱动）
 *
 * 都没有就抛出带指引的错误 —— 显式失败好过八十一处各自崩。
 * 纯 JS（.mjs）：被 node 直跑的闸门引用，不能带 TS 标注。
 */
import { existsSync } from 'node:fs';

const CANDIDATES = [
  process.env.OPC_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA
    ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
    : null,
].filter(Boolean);

let cached = null;

export function resolveChromePath() {
  if (cached) return cached;
  for (const p of CANDIDATES) {
    if (p && existsSync(p)) {
      cached = p;
      return p;
    }
  }
  throw new Error(
    '找不到可用的浏览器（Chrome / Edge 都不在标准路径）。' +
      '请安装 Chrome/Edge，或用环境变量 OPC_CHROME 指向浏览器可执行文件。'
  );
}
