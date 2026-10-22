import { useCallback, useEffect, useState } from 'react';
import { Button, Textarea, MessagePlugin, Input } from 'tdesign-react';
import { HintTip } from './HintTip';

/**
 * 记忆（A38）—— Hermes 式四层记忆的设置面板。
 *
 * 三个可编辑/可检索的入口：核心记忆 MEMORY.md、用户画像 USER.md、技能 skills/。
 * 第四个入口 L4（FTS5 全文索引）不是给人编辑的，是给「检索框」用的。
 */

interface MemoryStats {
  coreTokens: number;
  coreBudget: number;
  userTokens: number;
  userBudget: number;
  skillCount: number;
  skillTokens: number;
  indexedDocs: number;
}

interface SkillBrief {
  name: string;
  title: string;
  tokens: number;
}

interface MemoryHit {
  key: string;
  kind: string;
  title: string;
  snippet: string;
}

const BUDGET_HINT =
  '这是「跨会话必须知道的事」，不是日记。超预算不会保存失败，但注入时会被截断 —— 越靠前的内容优先级越高。';

export function MemoryPanel() {
  const [core, setCore] = useState('');
  const [user, setUser] = useState('');
  const [skills, setSkills] = useState<SkillBrief[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<'core' | 'user' | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemoryHit[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/memory');
      const j = await r.json();
      setCore(j.core ?? '');
      setUser(j.user ?? '');
      setSkills(j.skills ?? []);
      setStats(j.stats ?? null);
    } catch {
      MessagePlugin.error('读取记忆失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (which: 'core' | 'user') => {
    setSaving(which);
    try {
      const r = await fetch('/api/memory', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(which === 'core' ? { core } : { user }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '保存失败');
      setStats(j.stats ?? null);
      const over =
        which === 'core' ? j.core?.overBudget : j.user?.overBudget;
      if (over) MessagePlugin.warning('已保存，但超出预算，注入时会被截断');
      else MessagePlugin.success('已保存');
    } catch (e) {
      MessagePlugin.error((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const search = async () => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    try {
      const r = await fetch('/api/memory/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, limit: 10 }),
      });
      const j = await r.json();
      setHits(j.hits ?? []);
      if (!(j.hits ?? []).length) MessagePlugin.info('没有命中');
    } catch {
      MessagePlugin.error('检索失败');
    }
  };

  const openSkill = async (name: string) => {
    try {
      const r = await fetch(`/api/memory/skills/${encodeURIComponent(name)}`);
      const j = await r.json();
      setDraft(j.body ?? '');
      setEditing(name);
    } catch {
      MessagePlugin.error('读取技能失败');
    }
  };

  const saveSkill = async () => {
    if (!editing) return;
    try {
      const r = await fetch(`/api/memory/skills/${encodeURIComponent(editing)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: draft }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '保存失败');
      MessagePlugin.success('技能已保存');
      setEditing(null);
      void refresh();
    } catch (e) {
      MessagePlugin.error((e as Error).message);
    }
  };

  const removeSkill = async (name: string) => {
    try {
      await fetch(`/api/memory/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      MessagePlugin.success('已删除');
      if (editing === name) setEditing(null);
      void refresh();
    } catch {
      MessagePlugin.error('删除失败');
    }
  };

  const counter = (tokens: number, budget: number) => (
    <span
      className="text-xs"
      style={{ color: tokens > budget ? 'var(--td-warning-color)' : 'var(--td-text-color-placeholder)' }}
    >
      {tokens} / {budget} token{tokens > budget ? ' · 已超预算' : ''}
    </span>
  );

  if (loading) return <div className="py-10 text-center text-body">加载中…</div>;

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <h2 className="text-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          记忆
        </h2>
        <HintTip
          warn
          label="记忆注入范围说明"
          text="只对「模型直连」与 WorkBuddy（SDK）两类注入 —— 它们的系统提示由我们装配。CLI / ACP 类 Agent（Claude Code、Hermes 等）的提示词在它们自己的 harness 里，我们塞不进去，也不该塞。"
        />
      </div>

      {/* 统计条 */}
      <div
        className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg px-3 py-2 text-xs"
        style={{ backgroundColor: 'var(--td-bg-color-container)', color: 'var(--td-text-color-secondary)' }}
      >
        <span>技能 {stats?.skillCount ?? 0} 个</span>
        <span>技能合计 {stats?.skillTokens ?? 0} token</span>
        <span>已索引 {stats?.indexedDocs ?? 0} 条</span>
        <span>核心记忆 {counter(stats?.coreTokens ?? 0, stats?.coreBudget ?? 800)}</span>
      </div>

      {/* L1 核心记忆 */}
      <section className="mb-6">
        <div className="mb-1 flex items-center gap-2">
          <h3 className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
            核心记忆
          </h3>
          <HintTip label="核心记忆说明" text={BUDGET_HINT} />
        </div>
        <Textarea
          value={core}
          onChange={v => setCore(String(v))}
          autosize={{ minRows: 6, maxRows: 16 }}
          placeholder="写跨会话必须知道的事实：项目规范、环境约定、长期任务…"
        />
        <div className="mt-1 flex items-center justify-between">
          {counter(estimate(core), stats?.coreBudget ?? 800)}
          <Button size="small" variant="outline" loading={saving === 'core'} onClick={() => void save('core')}>
            保存
          </Button>
        </div>
      </section>

      {/* L2 用户画像 */}
      <section className="mb-6">
        <div className="mb-1 flex items-center gap-2">
          <h3 className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
            用户画像
          </h3>
          <HintTip label="用户画像说明" text="你的技术栈偏好、沟通风格、长期目标。画像要短 —— 长了就等于没画像。约 500 token。" />
        </div>
        <Textarea
          value={user}
          onChange={v => setUser(String(v))}
          autosize={{ minRows: 4, maxRows: 12 }}
          placeholder="- 技术栈偏好：&#10;- 沟通风格：&#10;- 长期目标："
        />
        <div className="mt-1 flex items-center justify-between">
          {counter(estimate(user), stats?.userBudget ?? 500)}
          <Button size="small" variant="outline" loading={saving === 'user'} onClick={() => void save('user')}>
            保存
          </Button>
        </div>
      </section>

      {/* L4 检索 */}
      <section className="mb-6">
        <h3 className="mb-2 text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          检索长期记忆
        </h3>
        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={v => setQuery(String(v))}
            placeholder="关键词（支持全文检索，输入 - 也不会报错）"
            onEnter={() => void search()}
          />
          <Button size="small" variant="outline" onClick={() => void search()}>
            检索
          </Button>
        </div>
        {hits.length > 0 && (
          <ul className="mt-2 space-y-1">
            {hits.map(h => (
              <li
                key={h.key}
                className="rounded-md px-3 py-2 text-xs"
                style={{ backgroundColor: 'var(--td-bg-color-container)', color: 'var(--td-text-color-secondary)' }}
              >
                <div className="mb-0.5 font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                  {h.title} <span className="font-normal opacity-60">· {h.kind}</span>
                </div>
                <div className="whitespace-pre-wrap break-words">{h.snippet}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* L3 技能 */}
      <section>
        <h3 className="mb-2 text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          技能（{skills.length}）
        </h3>
        {skills.length === 0 ? (
          <p className="text-body" style={{ color: 'var(--td-text-color-placeholder)' }}>
            还没有沉淀下来的技能。任务跑完后会自动提炼（可复用步骤 + diff 统计）。
          </p>
        ) : (
          <ul className="space-y-1">
            {skills.map(s => (
              <li
                key={s.name}
                className="flex items-center justify-between rounded-md px-3 py-2"
                style={{ backgroundColor: 'var(--td-bg-color-container)' }}
              >
                <div className="min-w-0">
                  <div className="truncate text-body" style={{ color: 'var(--td-text-color-primary)' }}>
                    {s.title}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    {s.name} · {s.tokens} token
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="small" variant="text" onClick={() => void openSkill(s.name)}>
                    编辑
                  </Button>
                  <Button size="small" variant="text" onClick={() => void removeSkill(s.name)}>
                    删除
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {editing && (
          <div className="mt-2">
            <div className="mb-1 text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
              正在编辑：{editing}.md
            </div>
            <Textarea value={draft} onChange={v => setDraft(String(v))} autosize={{ minRows: 8, maxRows: 24 }} />
            <div className="mt-1 flex justify-end gap-2">
              <Button size="small" variant="text" onClick={() => setEditing(null)}>
                取消
              </Button>
              <Button size="small" variant="outline" onClick={() => void saveSkill()}>
                保存技能
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** 前端只做「刻度」用的粗估：CJK 一字≈1 token，其余 4 字符≈1 token。 */
function estimate(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\u3040-\u30ff]/g) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}
