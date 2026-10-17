/**
 * 占位适配器。
 *
 * 用于两类「明确无法无头调用」的 Agent：
 *   1. 仅 GUI 的 IDE（Cursor / Qoder）—— 装了也没法从命令行驱动
 *   2. 本机未安装的 Agent（豆包 / ZCode / KimiCode）
 *
 * 它的价值不在于能干活，而在于**诚实地把自己标出来**：
 * 前端仍然把它渲染成通讯录里的一个联系人，但状态是灰的，
 * 点开会告诉你为什么用不了、以及要装什么。这比让用户在名册里
 * 根本看不到它要好 —— 用户能看清「我的 Agent 团队还缺谁」。
 */

import { existsSync } from 'fs';
import { findExecutable, expandPath } from '../probe.js';
import type { AgentDefinition } from '../definitions.js';
import type {
  AgentDescriptor,
  AgentEvent,
  AgentProvider,
  AgentStatus,
  SendContext,
} from '../types.js';

export class MockAdapter implements AgentProvider {
  readonly descriptor: AgentDescriptor;
  private readonly def: AgentDefinition;
  private status: AgentStatus | null = null;

  constructor(def: AgentDefinition) {
    this.def = def;
    this.descriptor = def.descriptor;
  }

  async probe(): Promise<AgentStatus> {
    const now = new Date().toISOString();
    const cmd = this.def.descriptor.command;
    const extra = (this.def.extraPaths ?? []).map(expandPath);

    // 有明确的不支持原因 → 先看装没装，好让用户区分「装了但用不了」和「没装」
    const binPath = cmd ? findExecutable(cmd, extra) : null;
    const installed =
      Boolean(binPath) ||
      (this.def.authFiles ?? []).some(rel => {
        try {
          return existsSync(expandPath(rel));
        } catch {
          return false;
        }
      });

    const reason = this.def.unsupportedReason;
    const isGuiOnly = reason?.includes('GUI') ?? false;

    this.status = {
      availability: installed ? 'unsupported' : 'not-installed',
      installed,
      binaryPath: binPath ?? undefined,
      message:
        reason ??
        (installed ? '已安装，但暂不支持无头调用' : '本机未安装'),
      probedAt: now,
    };

    // GUI-only 的 Agent 装了就一定 unsupported，与探测顺序无关
    if (isGuiOnly && !installed) {
      this.status.availability = 'unsupported';
      this.status.message = reason;
    }

    return this.status;
  }

  async *send(ctx: SendContext): AsyncIterable<AgentEvent> {
    if (!this.status) await this.probe();
    const hint = this.descriptor.installHint
      ? `\n接入方式：${this.descriptor.installHint}`
      : '';
    yield {
      type: 'error',
      message: `${this.descriptor.name} 当前不可用：${this.status?.message ?? '未知原因'}${hint}`,
    };
    yield { type: 'done', durationMs: 0 };
  }

  abort(): void {
    /* 无进行中的任务 */
  }
}
