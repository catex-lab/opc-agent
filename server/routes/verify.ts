/**
 * 验证闭环（A97）。
 *
 * F0-02②：从 server/index.ts 原样迁出，行为零改动。
 *
 * 三个端点分工：
 *   GET  /api/verify/commands  这个项目能跑哪些检查（只读文件，不执行）
 *   POST /api/verify/run       跑选中的那些（SSE 流式，边跑边出）
 *   GET  /api/verify/results   历史结果（刷新后还在）
 *
 * ## 为什么执行的是 commandId 而不是命令字符串
 *
 * 前端只传 id，后端**重新探测**一遍再按 id 匹配。这样即使请求被篡改，
 * 能执行的也只可能是「探测逻辑认可的那几条命令」，而不是任意 shell。
 * 要跑自定义命令有终端面板 —— 那是明确面向人的入口。
 */

import type { Express } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../db.js';
import { startSseHeartbeat } from '../sse-heartbeat.js';
import { detectVerifyCommands } from '../verify-commands.js';
import { runVerifyCommand } from '../verify-runner.js';
import { summarizeEvidence, verifyFileChanges } from '../file-evidence.js';
import { legacyToBlocks } from '../../shared/blocks.js';

export function registerVerifyRoutes(app: Express): void {
  app.get("/api/verify/commands", (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    if (!cwd) {
      res.status(400).json({ error: "缺少 cwd 参数" });
      return;
    }
    res.json(detectVerifyCommands(cwd));
  });

  app.get("/api/verify/results", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    if (!sessionId) {
      res.status(400).json({ error: "缺少 sessionId 参数" });
      return;
    }
    res.json({ verifications: db.getVerificationsBySession(sessionId) });
  });

  /**
   * 文件变更核对（A99）。
   *
   * ## 为什么是 GET 而不是 POST
   *
   * 它只读：读一遍消息的 blocks、读一遍磁盘，不写任何东西。A97 的 /api/verify/run
   * 是 POST，因为它真的**执行命令**；这里没有执行，别让语义跟着抄。
   *
   * ## 为什么只认 messageId，不认前端传来的路径
   *
   * 与 /api/verify/run 只接受 commandId 是同一条理由：核对的对象必须是
   * **落库的那份记录**。前端手里的 blocks 可能还在流式、也可能被本地状态
   * 改过；拿它去核对，等于用被核对方的说法去证明它自己。
   *
   * ## 为什么把 cwd 也返回
   *
   * 相对路径是按会话 cwd 解析的。前端要显示「相对哪个目录」，而会话的 cwd
   * 允许为空（纯问答会话），那时所有相对路径都判 skipped —— 这个事实必须
   * 让用户看见，而不是静默给个空列表。
   */
  app.get("/api/files/evidence", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    const messageId = typeof req.query.messageId === "string" ? req.query.messageId : "";
    if (!messageId) {
      res.status(400).json({ error: "缺少 messageId 参数" });
      return;
    }

    const message = db.getMessage(messageId);
    if (!message) {
      res.status(404).json({ error: "消息不存在" });
      return;
    }
    // 带上 sessionId 时校验归属：否则任意 messageId 都能被枚举出文件路径
    if (sessionId && message.session_id !== sessionId) {
      res.status(403).json({ error: "消息不属于该会话" });
      return;
    }

    const session = db.getSession(message.session_id);
    const cwd = session?.cwd ?? null;

    let blocks = legacyToBlocks({
      content: message.content,
      toolCalls: message.tool_calls ? JSON.parse(message.tool_calls) : undefined,
      images: message.images ? JSON.parse(message.images) : undefined,
    });
    if (message.blocks) {
      try {
        const parsed = JSON.parse(message.blocks);
        if (Array.isArray(parsed) && parsed.length > 0) blocks = parsed;
      } catch {
        // 半截 JSON：退回 legacy 还原，不因为解析失败就整条拒掉
      }
    }

    const createdAt = Date.parse(message.created_at);
    const items = verifyFileChanges(
      blocks,
      cwd,
      Number.isFinite(createdAt) ? createdAt : undefined
    );

    res.json({ cwd, items, summary: summarizeEvidence(items) });
  });

  app.post("/api/verify/run", async (req, res) => {
    const body = (req.body ?? {}) as {
      sessionId?: string;
      messageId?: string | null;
      cwd?: string;
      commandIds?: string[];
    };
    const sessionId = body.sessionId ?? "";
    const cwd = body.cwd ?? "";
    const ids = Array.isArray(body.commandIds) ? body.commandIds : [];

    if (!sessionId || !cwd || ids.length === 0) {
      res.status(400).json({ error: "缺少 sessionId / cwd / commandIds" });
      return;
    }

    // 重新探测并按 id 取命令 —— 不接受前端传命令字符串（见上面的说明）
    const detected = detectVerifyCommands(cwd);
    const wanted = detected.commands.filter(c => ids.includes(c.id));
    if (wanted.length === 0) {
      res.status(400).json({
        error: "没有匹配到可执行的命令",
        available: detected.commands.map(c => c.id),
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    startSseHeartbeat(res);
    const send = (payload: unknown) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const abort = new AbortController();
    // ⚠️ 必须挂 res 的 close，不能挂 req 的。
    // `express.json()` 把请求体读完时，IncomingMessage 这个可读流会走到 end，
    // 而流默认 autoDestroy → 立刻 emit 'close'。于是 `req.on('close')` 在**请求
    // 刚开始**就触发了，把 abort 打开，每一次验证都在 0.8 秒内被自己取消
    // （实测：status=error / hint=用户已取消）。res 的 close 才代表连接真的没了。
    // writableEnded 用来区分「客户端断开」和「我们正常 res.end() 之后的那次 close」。
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    send({
      type: "start",
      total: wanted.length,
      commands: wanted.map(c => ({ id: c.id, label: c.label, command: c.command })),
    });

    try {
      for (const cmd of wanted) {
        if (abort.signal.aborted) break;
        send({ type: "command_start", commandId: cmd.id, command: cmd.command });

        const result = await runVerifyCommand({
          commandId: cmd.id,
          command: cmd.command,
          cwd,
          signal: abort.signal,
          onChunk: text => send({ type: "chunk", commandId: cmd.id, text }),
        });

        // 落库失败**不能**吃掉本次结论。命令已经跑完了，退出码和输出都在手上；
        // 这时候因为写库出错就只发 error，等于让用户白等一次构建还看不到结果。
        // 实测踩过：session 行不存在时 FOREIGN KEY 报错，整条流断在这里。
        let rowId: string | null = null;
        try {
          const row = db.createVerification({
            id: uuidv4(),
            session_id: sessionId,
            message_id: body.messageId ?? null,
            command_id: cmd.id,
            command: cmd.command,
            kind: cmd.kind,
            label: cmd.label,
            status: result.status,
            exit_code: result.exitCode,
            duration_ms: result.durationMs,
            output: result.output,
            output_truncated: result.truncated ? 1 : 0,
            created_at: new Date().toISOString(),
          });
          rowId = row.id;
        } catch (err) {
          console.warn("[verify] 结果落库失败（本次结论照常返回）:", (err as Error).message);
        }

        send({ type: "result", commandId: cmd.id, id: rowId, persisted: rowId != null, result });
      }
      send({ type: "done" });
    } catch (err) {
      send({ type: "error", message: (err as Error).message });
    }
    res.end();
  });
}
