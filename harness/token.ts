/**
 * 本机 token 的生成与落盘（M01，设计 §7.5）。
 *
 * token 生命周期：
 *   1. main 每次拉起 harness 都**重新生成**（重启即换新，旧 token 自然作废）；
 *   2. 写 `OPC_DATA_DIR/harness-token.json`（0600），经 **env** 传给 harness
 *      —— 不走 argv（命令行会被进程表/日志看到，§7.5 红线）；
 *   3. 渲染端经 IPC（main 内存）拿 token，每请求带 `x-opc-token` 头；
 *   4. 优雅退出时 main 删掉文件。
 *
 * Windows 上 `mode: 0o600` 不产生 POSIX 语义（NTFS 用 ACL），写上无害：
 * 打包态该目录本来就是用户私有 profile（%APPDATA%），与 SQLite 同级信任。
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OPC_TOKEN_FILE } from '../shared/harness-protocol.js';

export interface HarnessTokenFile {
  /** 32 字节随机 hex */
  token: string;
  /** 持有它的 harness 进程 pid（审计用；崩溃后残留文件可看出是哪一代） */
  pid: number;
  startedAt: string;
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function tokenFilePath(dataDir: string): string {
  return path.join(dataDir, OPC_TOKEN_FILE);
}

export function writeTokenFile(dataDir: string, payload: HarnessTokenFile): void {
  writeFileSync(tokenFilePath(dataDir), JSON.stringify(payload, null, 2), { mode: 0o600 });
}

export function readTokenFile(dataDir: string): HarnessTokenFile | null {
  try {
    const raw = readFileSync(tokenFilePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as HarnessTokenFile;
    return typeof parsed?.token === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function removeTokenFile(dataDir: string): void {
  try {
    if (existsSync(tokenFilePath(dataDir))) rmSync(tokenFilePath(dataDir));
  } catch {
    // 删不掉只影响下一次启动前的一小段窗口（反正会被覆盖），不值得打断退出
  }
}
