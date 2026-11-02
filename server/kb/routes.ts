/**
 * 知识库后端接口（P1，不含界面）。
 *
 * 所有范围参数只接受四档枚举；工作区/项目由 `sessionId` 在服务端解析，
 * 不接受客户端传路径 —— 这样调用方无法把检索范围“指”到别的目录。
 */

import type { Express } from 'express';
import { KbSearchError, KbScopeDeniedError, searchKnowledge, type KbScope } from './search.js';
import {
  backfillAll,
  backfillRecent,
  bootKnowledgeBase,
  knowledgeBaseStatus,
  rebuildKnowledgeBase,
  setSessionIndexed,
} from './indexer.js';
import { setScopePolicy, getScopePolicy, getSessionState } from './store.js';

const SCOPES: KbScope[] = ['session', 'workspace', 'project', 'all'];

function asScope(value: unknown): KbScope | undefined {
  return typeof value === 'string' && (SCOPES as string[]).includes(value)
    ? (value as KbScope)
    : undefined;
}

export function registerKbRoutes(app: Express): void {
  app.get('/api/kb/status', (_req, res) => {
    try {
      res.json(knowledgeBaseStatus());
    } catch (err) {
      res.status(500).json({ error: '知识库不可用', detail: String(err) });
    }
  });

  app.post('/api/kb/search', (req, res) => {
    const query = req.body?.query;
    const sessionId = req.body?.sessionId;
    const scope = req.body?.scope === undefined ? undefined : asScope(req.body.scope);

    if (typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: 'query 不能为空', code: 'empty_query' });
      return;
    }
    if (typeof sessionId !== 'string' || !sessionId) {
      res.status(400).json({ error: 'sessionId 必填', code: 'missing_session' });
      return;
    }
    if (req.body?.scope !== undefined && scope === undefined) {
      res.status(400).json({ error: 'scope 必须是 session/workspace/project/all' });
      return;
    }

    try {
      const result = searchKnowledge({
        query,
        sessionId,
        scope,
        topK: typeof req.body?.topK === 'number' ? req.body.topK : undefined,
        maxTokens: typeof req.body?.maxTokens === 'number' ? req.body.maxTokens : undefined,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof KbScopeDeniedError) {
        res.status(403).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof KbSearchError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: '检索失败', detail: String(err) });
    }
  });

  app.post('/api/kb/backfill', (req, res) => {
    const mode = req.body?.mode === 'full' ? 'full' : 'recent';
    const days = typeof req.body?.days === 'number' ? req.body.days : 90;
    try {
      const result = mode === 'full' ? backfillAll() : backfillRecent(days);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: '回填失败', detail: String(err) });
    }
  });

  /**
   * 整库重建：清空索引 schema 后全量回填。同时是「连续失败自动停索引」的
   * 粗暴恢复入口 —— 重建会清掉所有会话的停索引标记（`kb-optout.json`
   * 里的用户「不索引」选择仍然生效）。
   */
  app.post('/api/kb/rebuild', (_req, res) => {
    try {
      res.json(rebuildKnowledgeBase());
    } catch (err) {
      res.status(500).json({ error: '重建失败', detail: String(err) });
    }
  });

  /**
   * 会话索引开关。
   *
   * `indexed: false` → `disabled_reason='user'`（界面提示「你已关闭该会话的索引」）。
   * `indexed: true` 是「连续失败自动停索引」（`disabled_reason='auto_failure'`）
   * 的精确恢复入口：清零 `consecutive_failures`、清除 `last_error` 与停用原因，
   * 并强制重建该会话切片。返回体里附带 `state`（含 `disabled_reason`）。
   */
  app.patch('/api/kb/sessions/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const indexed = req.body?.indexed;
    if (typeof indexed !== 'boolean') {
      res.status(400).json({ error: 'indexed 必须是布尔值' });
      return;
    }
    try {
      const result = setSessionIndexed(sessionId, indexed);
      res.json({ ...result, state: getSessionState(sessionId) ?? null });
    } catch (err) {
      res.status(500).json({ error: '更新索引开关失败', detail: String(err) });
    }
  });

  app.get('/api/kb/policy', (_req, res) => {
    res.json(getScopePolicy());
  });

  app.patch('/api/kb/policy', (req, res) => {
    const patch: { allowProject?: boolean; allowAll?: boolean } = {};
    if (typeof req.body?.allowProject === 'boolean') patch.allowProject = req.body.allowProject;
    if (typeof req.body?.allowAll === 'boolean') patch.allowAll = req.body.allowAll;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: '至少提供 allowProject 或 allowAll' });
      return;
    }
    res.json(setScopePolicy(patch));
  });

  // 兼容启动路径：允许外部显式触发一次初始化（默认后台回填 90 天）
  app.post('/api/kb/init', (req, res) => {
    const backfill = req.body?.backfill === false ? false : true;
    res.json(bootKnowledgeBase({ backfill }));
  });
}
