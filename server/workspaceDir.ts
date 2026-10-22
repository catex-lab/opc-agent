/**
 * A63：工作目录（cwd）的存在性校验。
 *
 * ## 为什么需要
 *
 * 工作目录此前的链路是「前端一个无校验文本框 → 直接落库 → 等 Agent spawn
 * 时 ENOENT」——用户打完一整段话、等到流式开始才看到失败，且报错是裸的
 * ENOENT，指不回「哦是工作目录填错了」。在**写入前**拦下来，把错误说成
 * 「目录不存在：xxx」。
 *
 * ## 三种结局，故意不混
 *
 *   - `ok`        目录存在
 *   - `not-found` 明确不存在（ENOENT），或路径指向一个**文件**
 *   - `unknown`   stat 抛了别的错（权限 / 路径格式 / 网络盘瞬断）→ 放行
 *
 * 最后一个分支是刻意的：EACCES 只说明「这个进程看不了它」，不说明 Agent
 * 进不去（Agent 可能以别的身份跑）；为一个查不明白的错误硬拦，会把本来
 * 能用的会话打死。宁放过，不误杀 —— 与「假控件」纪律是同一边：只对
 * **确定坏**的值说不。
 *
 * ## 为什么独立成文件
 *
 * 它同时服务三个端点（POST /api/sessions、PATCH /api/sessions/:id、
 * POST /api/chat）。放在 index.ts 里就是个 import 不动的局部函数 ——
 * 而 index.ts 在 import 时就会 `app.listen` 并跑一遍 Agent 探测，
 * 验证脚本碰它等于启动一整个服务。拆出来，单测才跑得动。
 */

import fs from 'fs';

export type DirCheck = 'ok' | 'not-found' | 'unknown';

export function validateDirectory(dir: string): DirCheck {
  try {
    const st = fs.statSync(dir);
    // 存在但是个文件：对工作目录而言就是坏的，与 not-found 同等处理
    return st.isDirectory() ? 'ok' : 'not-found';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return 'not-found';
    return 'unknown';
  }
}
