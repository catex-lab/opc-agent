import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Textarea, MessagePlugin, Input, Select } from 'tdesign-react';
import { InfoHint } from './InfoHint';
import { useTranslation } from '../i18n';

/**
 * 记忆（A38）—— Hermes 式四层记忆的设置面板。
 *
 * 三个可编辑/可检索的入口：核心记忆 MEMORY.md、用户画像 USER.md、技能 skills/。
 * 第四个入口 L4（FTS5 全文索引）不是给人编辑的，是给「检索框」用的。
 *
 * ## A98：作用域切换
 *
 * 面板顶部多了一个「作用域」选择器：全局（所有项目）或某个具体项目。
 * 选项目之后，核心记忆与技能编辑的是**那个项目自己的那份**，
 * 保存时带上 `scope=project`。
 *
 * 两条边界刻意保留：
 * - **用户画像始终是全局的**，选项目时不禁用但明确标注 —— 它描述「这个人」，
 *   给每个项目复制一份只会让用户维护几份互相矛盾的自我描述。
 * - **技能列表分开显示**，不做「全局 + 项目」的合并视图。合并之后「删除」
 *   到底删哪一份是说不清的（后端会先删项目层再回落到全局），
 *   用户点两次才删掉，还以为界面坏了。
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
  scope?: string;
}

/** A98：项目记忆的作用域统计 */
interface ProjectStats {
  key: string;
  exists: boolean;
  coreTokens: number;
  coreBudget: number;
  skillCount: number;
  skillTokens: number;
}

interface ProjectBrief {
  id: string;
  name: string;
  path: string;
  sessionCount: number;
}

const BUDGET_HINT_KEY = 'settings.memory.budgetHint';

export function MemoryPanel() {
  const { t, locale } = useTranslation();
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
  /**
   * A137：编辑器挂在技能列表**下方**，点行尾那颗 24 的「编辑」时，
   * 它落进折叠线以下 —— 用户看到的唯一反应是底边多出一行渐隐的小字
   * （截图实证：`正在编辑：demo-skill.md` 正好压在渐隐带上）。
   * 点一下像没反应，这比尺寸不一致更糟。
   *
   * 不加 `smooth`：滚动动画与渐隐遮罩同时动会闪一下。
   * 对齐方式用 `center` 而不是 `nearest` —— 原因见下面 effect 里的实测。
   */
  const editorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    /**
     * ⚠️ 两个坑，都是实测踩出来的：
     *
     * 1. **必须等一帧**。`autosize` 的 Textarea 在自己的 effect 里才把高度撑到
     *    最终值，我们在同一个提交里调 `scrollIntoView`，量到的是撑开前的位置
     *    —— 实测滚到 `scrollTop 236`，而最大可滚是 368，提交键仍留在
     *    面板底下方 106px。
     * 2. **对齐用 `center`，不能用 `nearest`**。`nearest` 认为「顶边已经露出
     *    18px = 已经可见」，只滚 96px 就停。
     */
    if (!editing) return;
    const id = requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(id);
  }, [editing]);
  // A98：作用域。'' = 全局；否则是项目的原始路径
  const [projects, setProjects] = useState<ProjectBrief[]>([]);
  const [projectPath, setProjectPath] = useState('');
  const [projectStats, setProjectStats] = useState<ProjectStats | null>(null);
  const [globalSkillCount, setGlobalSkillCount] = useState(0);

  const isProject = !!projectPath;

  const refresh = useCallback(async () => {
    try {
      const qs = projectPath ? `?cwd=${encodeURIComponent(projectPath)}` : '';
      const r = await fetch(`/api/memory${qs}`);
      const j = await r.json();
      setUser(j.user ?? '');
      setGlobalSkillCount((j.skills ?? []).length);
      if (projectPath) {
        // 项目作用域：核心记忆与技能都取项目那一份
        setCore(j.project?.core ?? '');
        setProjectStats(j.project?.stats ?? null);
        setSkills(j.project?.skills ?? []);
        setStats(j.project?.stats ?? null);
      } else {
        setCore(j.core ?? '');
        setSkills(j.skills ?? []);
        setStats(j.stats ?? null);
        setProjectStats(null);
      }
    } catch {
      MessagePlugin.error(t('settings.memory.readFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectPath, t]);

  // 项目列表只在挂载时拉一次：项目是「用过的目录」，不需要跟着记忆刷新
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/projects');
        const j = await r.json();
        setProjects(j.projects ?? []);
      } catch {
        /* 拉不到就只剩「全局」一项，不影响其它功能 */
      }
    })();
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (which: 'core' | 'user') => {
    setSaving(which);
    try {
      // 画像永远写全局；核心记忆跟随当前作用域
      const body =
        which === 'core'
          ? { core, scope: isProject ? 'project' : 'global', cwd: isProject ? projectPath : undefined }
          : { user };
      const r = await fetch('/api/memory', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || t('settings.memory.saveFailedShort'));
      if (isProject) setProjectStats(j.projectStats ?? null);
      else setStats(j.stats ?? null);
      const over = which === 'core' ? j.core?.overBudget : j.user?.overBudget;
      if (over) {
        MessagePlugin.warning(
          isProject && which === 'core'
            ? t('settings.memory.projectSavedOverBudget')
            : t('settings.memory.savedOverBudget')
        );
      } else {
        MessagePlugin.success(
          isProject && which === 'core'
            ? t('settings.memory.projectSaved')
            : t('settings.memory.saved')
        );
      }
      if (isProject) void refresh();
    } catch (e) {
      MessagePlugin.error((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const scopeQs = projectPath ? `?cwd=${encodeURIComponent(projectPath)}` : '';

  const search = async () => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    try {
      const r = await fetch('/api/memory/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query,
          limit: 10,
          // 选项目时搜「全局 + 该项目」；不选只搜全局（后端口径）
          cwd: projectPath || undefined,
        }),
      });
      const j = await r.json();
      setHits(j.hits ?? []);
      if (!(j.hits ?? []).length) MessagePlugin.info(t('settings.memory.noHits'));
    } catch {
      MessagePlugin.error(t('settings.memory.searchFailed'));
    }
  };

  const openSkill = async (name: string) => {
    try {
      const r = await fetch(`/api/memory/skills/${encodeURIComponent(name)}${scopeQs}`);
      const j = await r.json();
      setDraft(j.body ?? '');
      setEditing(name);
    } catch {
      MessagePlugin.error(t('settings.memory.skillReadFailed'));
    }
  };

  const saveSkill = async () => {
    if (!editing) return;
    try {
      const r = await fetch(`/api/memory/skills/${encodeURIComponent(editing)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: draft, cwd: projectPath || undefined }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || t('settings.memory.saveFailedShort'));
      MessagePlugin.success(t('settings.memory.skillSaved'));
      setEditing(null);
      void refresh();
    } catch (e) {
      MessagePlugin.error((e as Error).message);
    }
  };

  const removeSkill = async (name: string) => {
    try {
      await fetch(`/api/memory/skills/${encodeURIComponent(name)}${scopeQs}`, { method: 'DELETE' });
      MessagePlugin.success(t('settings.memory.deleted'));
      if (editing === name) setEditing(null);
      void refresh();
    } catch {
      MessagePlugin.error(t('settings.memory.deleteFailed'));
    }
  };

  const counter = (tokens: number, budget: number) => (
    <span
      className="text-xs"
      style={{ color: tokens > budget ? 'var(--td-warning-color)' : 'var(--td-text-color-placeholder)' }}
    >
      {tokens} / {budget} token{tokens > budget ? t('settings.memory.overBudget') : ''}
    </span>
  );

  if (loading) return <div className="py-10 text-center text-body">{t('settings.memory.loading')}</div>;

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <h2 className="text-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          {t('settings.memory.title')}
        </h2>
        <InfoHint
          warn
          label={t('settings.memory.injectionHintLabel')}
          text={t('settings.memory.injectionHint')}
        />
      </div>

      {/* A98：作用域切换 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
          {t('settings.memory.scope')}
        </span>
        {/* 英文的「Global (shared by all projects)」比中文长一半：给下拉多留 40px，
            中文仍是 260px，不改变既有布局 */}
        <div style={{ width: locale === 'en' ? 300 : 260 }}>
          <Select
            value={projectPath}
            onChange={v => {
              setProjectPath(String(v ?? ''));
              setEditing(null);
              setHits([]);
            }}
            options={[
              { label: t('settings.memory.scopeGlobal'), value: '' },
              ...projects.map(p => ({
                label: t('settings.memory.scopeProject', { name: p.name, n: p.sessionCount }),
                value: p.path,
              })),
            ]}
            placeholder={t('settings.memory.scopePlaceholder')}
          />
        </div>
        <InfoHint
          label={t('settings.memory.scopeHintLabel')}
          text={t('settings.memory.scopeHint')}
        />
        {isProject && (
          <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
            {projectStats?.exists
              ? t('settings.memory.projectHasMemory')
              : t('settings.memory.projectNoMemory')}
          </span>
        )}
      </div>

      {/* 统计条 */}
      <div
        className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg px-3 py-2 text-xs"
        style={{ backgroundColor: 'var(--td-bg-color-container)', color: 'var(--td-text-color-secondary)' }}
      >
        {isProject ? (
          <>
            <span>{t('settings.memory.projectSkillsCount', { n: projectStats?.skillCount ?? 0 })}</span>
            <span>{t('settings.memory.projectSkillTokens', { n: projectStats?.skillTokens ?? 0 })}</span>
            <span>
              {t('settings.memory.coreMemory')} {counter(projectStats?.coreTokens ?? 0, projectStats?.coreBudget ?? 800)}
            </span>
            <span>{t('settings.memory.globalSkillsEffective', { n: globalSkillCount })}</span>
          </>
        ) : (
          <>
            <span>{t('settings.memory.skillsCount', { n: stats?.skillCount ?? 0 })}</span>
            <span>{t('settings.memory.skillTokens', { n: stats?.skillTokens ?? 0 })}</span>
            <span>{t('settings.memory.indexedCount', { n: stats?.indexedDocs ?? 0 })}</span>
            <span>
              {t('settings.memory.coreMemory')} {counter(stats?.coreTokens ?? 0, stats?.coreBudget ?? 800)}
            </span>
          </>
        )}
      </div>

      {/* L1 核心记忆 */}
      <section className="mb-6">
        <div className="mb-1 flex items-center gap-2">
          <h3 className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
            {isProject ? t('settings.memory.coreTitleProject') : t('settings.memory.coreTitleGlobal')}
          </h3>
          <InfoHint label={t('settings.memory.budgetHintLabel')} text={t(BUDGET_HINT_KEY)} />
        </div>
        <Textarea
          value={core}
          onChange={v => setCore(String(v))}
          autosize={{ minRows: 6, maxRows: 16 }}
          placeholder={
            isProject
              ? t('settings.memory.corePlaceholderProject')
              : t('settings.memory.corePlaceholderGlobal')
          }
        />
        <div className="mt-1 flex items-center justify-between">
          {counter(estimate(core), isProject ? (projectStats?.coreBudget ?? 800) : (stats?.coreBudget ?? 800))}
          <Button variant="outline" loading={saving === 'core'} onClick={() => void save('core')}>
            {t('settings.memory.save')}
          </Button>
        </div>
      </section>

      {/* L2 用户画像 */}
      <section className="mb-6">
        <div className="mb-1 flex items-center gap-2">
          <h3 className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
            {t('settings.memory.userTitle')}
          </h3>
          <InfoHint
            label={t('settings.memory.userHintLabel')}
            text={t('settings.memory.userHint')}
          />
        </div>
        <Textarea
          value={user}
          onChange={v => setUser(String(v))}
          autosize={{ minRows: 4, maxRows: 12 }}
          placeholder={t('settings.memory.userPlaceholder')}
        />
        <div className="mt-1 flex items-center justify-between">
          {counter(estimate(user), stats?.userBudget ?? 500)}
          <Button variant="outline" loading={saving === 'user'} onClick={() => void save('user')}>
            {t('settings.memory.save')}
          </Button>
        </div>
      </section>

      {/* L4 检索 */}
      <section className="mb-6">
        <h3 className="mb-2 text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          {t('settings.memory.searchTitle')}
        </h3>
        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={v => setQuery(String(v))}
            placeholder={t('settings.memory.searchPlaceholder')}
            onEnter={() => void search()}
          />
          <Button variant="outline" onClick={() => void search()}>
            {t('settings.memory.search')}
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
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
            {isProject
              ? t('settings.memory.skillsTitleProject', { n: skills.length })
              : t('settings.memory.skillsTitleGlobal', { n: skills.length })}
          </h3>
          {isProject && globalSkillCount > 0 && (
            <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {t('settings.memory.globalSkillsNote', { n: globalSkillCount })}
            </span>
          )}
        </div>
        {skills.length === 0 ? (
          <p className="text-body" style={{ color: 'var(--td-text-color-placeholder)' }}>
            {isProject
              ? t('settings.memory.noProjectSkills')
              : t('settings.memory.noSkills')}
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
                  {/* A137：技能列表**行内**动作，留 24。下面的「取消/保存技能」
                      是编辑器提交档，走 32 —— 同一个文件里两档是故意的。 */}
                  <Button size="small" variant="text" onClick={() => void openSkill(s.name)}>
                    {t('settings.memory.edit')}
                  </Button>
                  <Button size="small" variant="text" onClick={() => void removeSkill(s.name)}>
                    {t('settings.memory.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {editing && (
          <div className="mt-2" ref={editorRef} data-memory-editor>
            <div className="mb-1 text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {t('settings.memory.editing', { name: editing })}
            </div>
            <Textarea value={draft} onChange={v => setDraft(String(v))} autosize={{ minRows: 8, maxRows: 24 }} />
            <div className="mt-1 flex justify-end gap-2">
              {/* A137：这是编辑器**提交**那一档，跟上面 32 的 Textarea 走；
                  列表行里那两颗「编辑/删除」（text 按钮、缩在行尾）才留 24。
                  两者的区别是「跟输入框」还是「跟列表行」，不是按钮大小偏好。 */}
              <Button variant="text" onClick={() => setEditing(null)}>
                {t('settings.common.cancel')}
              </Button>
              <Button variant="outline" onClick={() => void saveSkill()}>
                {t('settings.memory.saveSkill')}
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
