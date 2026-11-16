/**
 * 生图 API（P4-4）。
 *
 * F0-02②：从 server/index.ts 原样迁出，行为零改动。
 *
 * 生图**不走** /api/chat：那个端点的语义是「把 prompt 交给某个 Agent 的
 * 会话上下文」，而生图是一次无状态 HTTP 调用、产出的是图像而不是文本。
 * 硬塞进去要么污染 AgentEvent，要么得给 /api/chat 加一堆只有生图才用的分支。
 * 这里单开一个端点，但**复用同一套 SSE 契约**（init / done / error），
 * 前端因此能沿用已有的读流循环，只多认一个 `image` 事件。
 */

import type { Express } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../db.js';
import { cacheImage, imageFilePath } from '../image-store.js';
import { startSseHeartbeat } from '../sse-heartbeat.js';
import {
  getImageProvider,
  imageProvidersStatus,
  ImageGenerationError,
  DEFAULT_IMAGE_SIZE,
  IMAGE_SIZES,
  type ImageSize,
} from '../agents/adapters/image.js';

export function registerImageRoutes(app: Express): void {
  /** 生图 provider 的可用性（前端据此在生图场景显示修复指引） */
  app.get("/api/image/providers", (req, res) => {
    try {
      res.json({
        providers: imageProvidersStatus(),
        sizes: IMAGE_SIZES,
        defaultSize: DEFAULT_IMAGE_SIZE,
      });
    } catch (error: any) {
      console.error("[Image] Providers error:", error);
      res.status(500).json({ error: error?.message || "获取生图服务列表失败" });
    }
  });

  /**
   * 本地缓存的生成图片。
   *
   * 必须由服务端托管而不是直接暴露远端 URL：CogView 给的是带签名的临时地址
   * （约 7 天过期），直接把远端 URL 存进消息表，一周后历史图全部裂开。
   * 生成时已抓回本地，这里只做「安全取名 → 发文件」。
   */
  app.get("/api/images/:file", (req, res) => {
    let filePath: string;
    try {
      // 白名单 + 目录穿越校验都在这里，非法名字直接抛
      filePath = imageFilePath(db.imagesDir, req.params.file);
    } catch {
      return res.status(404).json({ error: "图片不存在" });
    }
    // 内容哈希命名 → 内容永不变，可以放心长缓存
    res.sendFile(filePath, { headers: { "Cache-Control": "public, max-age=31536000, immutable" } }, err => {
      if (err && !res.headersSent) res.status(404).json({ error: "图片不存在" });
    });
  });

  /**
   * 生成图像。
   *
   * 与 /api/chat 的差异：
   *   - 不是流式产出，而是一次调用得到一张图；SSE 只用来承载
   *     init（挂载气泡）→ image（出图）→ done 三个节点
   *   - 失败时**不落库助手消息**：失败没有图，落一条空气泡只会让人困惑
   */
  app.post("/api/image", async (req, res) => {
    const {
      sessionId,
      prompt,
      size,
      imageModel,
      providerId,
      // 会话归属（用于头像/身份）；生图本身与这个 Agent 无关
      agentId = 'workbuddy',
      cwd,
      scenarioId,
      systemPrompt,
      // A33 重新生成（与 /api/chat 同一套语义）
      regenerate = false,
      replaceMessageId,
    } = req.body;

    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (!text) {
      return res.status(400).json({ error: "生图提示词不能为空" });
    }

    const provider = getImageProvider(providerId);
    if (!provider) {
      return res.status(404).json({ error: `未知的生图服务: ${providerId}` });
    }

    // 缺密钥时**不进入 SSE**：直接 400 带修复指引，前端能立刻给出可操作提示，
    // 而不是先挂一个气泡再在里面显示错误。
    const status = provider.status();
    if (status.availability !== 'ready') {
      return res.status(400).json({
        error: status.message || "生图服务不可用",
        availability: status.availability,
        provider: provider.id,
      });
    }

    const normalizedSize: ImageSize = (IMAGE_SIZES as readonly string[]).includes(size)
      ? (size as ImageSize)
      : DEFAULT_IMAGE_SIZE;
    const model =
      typeof imageModel === 'string' && imageModel.trim() ? imageModel.trim() : provider.defaultModel;

    const now = new Date().toISOString();

    // 会话：与 /api/chat 同一套「首条消息落库时建会话」的语义
    let session = sessionId ? db.getSession(sessionId) : null;
    if (!session) {
      console.log(`[Image] 创建生图会话，provider=${provider.id} model=${model} size=${normalizedSize}`);
      session = db.createSession({
        id: sessionId || uuidv4(),
        title: `生图：${text.slice(0, 24)}${text.length > 24 ? '...' : ''}`,
        // 生图会话的「模型」就是生图模型（与文本会话同一列，语义自洽）
        model,
        agent_id: agentId,
        sdk_session_id: null,
        kind: 'direct',
        agent_ids: null,
        orchestration: null,
        cwd: cwd || null,
        // A62：生图 provider 不是 CLI，没有推理档位这个东西 ——
        // 存 null 而不是存一个「看起来设过」的值
        reasoning_effort: null,
        scenario_id: scenarioId || null,
        system_prompt: systemPrompt || null,
        created_at: now,
        updated_at: now,
      });
    } else {
      // 老会话/从文本场景切过来的会话：缺什么补什么（与 /api/chat 一致）
      const patch: Parameters<typeof db.updateSession>[1] = {};
      if (!session.agent_id && agentId) patch.agent_id = agentId;
      if (!session.cwd && cwd) patch.cwd = cwd;
      if (!session.scenario_id && scenarioId) patch.scenario_id = scenarioId;
      if (!session.system_prompt && systemPrompt) patch.system_prompt = systemPrompt;
      if (Object.keys(patch).length > 0) {
        db.updateSession(session.id, patch);
        session = { ...session, ...patch };
      }
    }

    const userMessageId = uuidv4();
    const assistantMessageId = uuidv4();

    try {
      // 重新生成（A33）与 /api/chat 同一套口径：不重复落 user 消息，
      // 并把被顶掉的那条旧图删掉
      if (!regenerate) {
        db.createMessage({
          id: userMessageId,
          session_id: session.id,
          role: 'user',
          content: text,
          model: null,
          author_agent_id: null,
          created_at: now,
          tool_calls: null,
        });
      } else if (replaceMessageId) {
        db.deleteMessage(replaceMessageId);
      }
    } catch (dbError: any) {
      console.error(`[Image] 保存用户消息失败:`, dbError);
      return res.status(500).json({ error: "保存消息失败", detail: dbError?.message });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    startSseHeartbeat(res);

    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        console.log(`[Image] 客户端断开，中止生图`);
        ac.abort();
      }
    });

    const sse = (payload: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    sse({
      type: "init",
      sessionId: session.id,
      userMessageId,
      assistantMessageId,
      model,
      agentId,
      provider: provider.id,
    });

    const startedAt = Date.now();
    try {
      const img = await provider.generate({
        prompt: text,
        model,
        size: normalizedSize,
        signal: ac.signal,
      });

      // 立刻把字节抓回本地 —— 远端 URL 约 7 天后失效
      const cached = await cacheImage(img.url, db.imagesDir);
      if (!cached) {
        console.warn(`[Image] 本地缓存失败，将保留远端 URL（会过期）`);
      }

      const block = {
        // 缓存成功 → 指向本地（永久有效）；失败 → 退回远端 URL
        url: cached ? `/api/images/${cached.file}` : img.url,
        sourceUrl: img.url,
        prompt: img.prompt,
        size: img.size,
        model: img.model,
        provider: img.provider,
        alt: img.prompt.slice(0, 80),
      };

      try {
        db.createMessage({
          id: assistantMessageId,
          session_id: session.id,
          role: 'assistant',
          // 正文留空：图像本身就是内容，再写一遍提示词会在气泡里重复
          content: '',
          model: img.model,
          author_agent_id: agentId,
          created_at: new Date().toISOString(),
          tool_calls: null,
          images: JSON.stringify([block]),
        });
      } catch (dbError: any) {
        console.error(`[Image] 保存图片消息失败:`, dbError);
      }

      sse({ type: "image", images: [block], cached: !!cached });
      sse({ type: "done", duration: Date.now() - startedAt });
      console.log(`[Image] 生成成功 ✓ ${img.size} ${img.model}（缓存${cached ? '成功' : '失败'}）`);
    } catch (error: any) {
      const message =
        error instanceof ImageGenerationError
          ? error.message
          : error?.message || "生图失败";
      console.error(`[Image] 生成失败:`, message);
      sse({ type: "error", message });
    }

    res.end();
  });
}
