/**
 * 会话导出为 Markdown（P6）。
 *
 * ## 为什么导出要现拉接口，不用列表里那份 state
 *
 * 列表里的会话是按需加载的：打开过哪个会话，哪个才有 `messages`；
 * 没打开过的会话 `messages` 是空数组。直接拿 state 导出，导出一半是空的，
 * 而用户以为「导出坏了」。所以这里按 sessionId 现拉 `GET /api/sessions/:id`，
 * 拿全量再生成。
 *
 * ## 纯函数与副作用分离
 *
 * `buildSessionMarkdown(meta, messages)` 是纯的：吃接口原始行（snake_case），
 * 吐 Markdown 字符串。验证脚本可以拿造假数据逐条断言格式，不碰浏览器。
 * `exportSession()` 才负责 fetch 与触发下载。
 */

/** `GET /api/sessions/:id` 返回的 session 字段（这里只挑导出要用的） */
export interface SessionExportMeta {
  id: string;
  title: string;
  model: string;
  agent_id?: string | null;
  kind?: string | null;
  /** 库里是 TEXT（JSON 字符串）；宽容起见也允许已是数组 */
  agent_ids?: string | string[] | null;
  cwd?: string | null;
  scenario_id?: string | null;
  created_at: string;
}

/** 消息行：与 `GET /api/sessions/:id` 的 messages 元素同构 */
export interface ExportMessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string | null;
  author_agent_id?: string | null;
  created_at: string;
  tool_calls?: Array<{
    id?: string;
    name: string;
    input?: Record<string, unknown>;
    status?: string;
    result?: string;
    isError?: boolean;
  }> | null;
  images?: Array<{ url?: string; prompt?: string; alt?: string }> | null;
  duration_ms?: number | null;
  cost?: number | null;
  tokens?: number | null;
}

/** 把 Agent id 译成显示名；没命中就原样返回 id（群聊导出不能因此失败） */
export type AgentNameResolver = (id: string) => string;

const SCENARIO_LABELS: Record<string, string> = {
  chat: '问答',
  work: '工作',
  dev: '开发',
  code: '代码',
  write: '写作',
  image: '生图',
};

/**
 * `agent_ids` 在库里是 TEXT，API 原样返回 JSON **字符串**。
 *
 * 顺带容忍「已经是数组」的情况：这一趟调试就是为了它 —— 夹具里手写成数组
 * 时，JSON.parse 会把数组转成 "hermes,opencode" 再抛异常，被 catch 吞掉后
 * 返回空数组，群聊表现为「一个成员都没有」却不报任何错。
 * 边界上的解析不该把「形状不符」静默降级成「空」，所以两种形状都收。
 */
function parseAgentIds(raw: string | string[] | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(x => typeof x === 'string');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatUsage(row: ExportMessageRow): string | null {
  const parts: string[] = [];
  if (typeof row.duration_ms === 'number' && row.duration_ms > 0) {
    parts.push(
      row.duration_ms >= 1000
        ? `${(row.duration_ms / 1000).toFixed(1)}s`
        : `${row.duration_ms}ms`
    );
  }
  if (typeof row.cost === 'number' && row.cost > 0) {
    parts.push(row.cost < 0.01 ? '<$0.01' : `$${row.cost.toFixed(2)}`);
  }
  if (typeof row.tokens === 'number' && row.tokens > 0) {
    parts.push(
      row.tokens >= 1000
        ? `${(row.tokens / 1000).toFixed(1)}k tokens`
        : `${row.tokens} tokens`
    );
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * 文件名清洗（导出用）。
 *
 * 标题原样留在 Markdown 正文里没问题，但**下载文件名**过不了 Windows：
 * `\ / : * ? " < > |` 全是保留字符，带上就存盘失败。超长也截断 ——
 * 40 个字足够辨认，又不至于让路径超过 MAX_PATH。
 *
 * 导出纯函数，方便验证脚本直接打靶。
 */
export function safeFileName(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40) || '会话导出'
  );
}

/**
 * 生成 Markdown 正文（纯函数）。
 *
 * 格式要点：
 *   - 头部元信息用列表，Agent 名走 resolver（群聊是多个成员）
 *   - 每条消息一个 `##` 小节：角色 emoji + 作者 + 时间
 *   - 工具调用折叠成一行摘要（名字 + 输入里的文件名/命令 + 成败），
 *     完整 input/result 不导出 —— 那会把导出文件变成调试转储
 *   - 图片有 url 就 `![](...)`，没有就留一句说明（本地哈希路径在别的
 *     机器上打不开，但不加链接用户不知道这里曾经有图）
 *   - 编排过程说明（note）本来就不落库，也不会出现在 messages 里
 */
export function buildSessionMarkdown(
  meta: SessionExportMeta,
  messages: ExportMessageRow[],
  resolveName: AgentNameResolver = id => id
): string {
  const lines: string[] = [];

  lines.push(`# ${meta.title || '未命名会话'}`);
  lines.push('');
  lines.push(`- 导出时间：${formatTime(new Date().toISOString())}`);
  lines.push(`- 创建时间：${formatTime(meta.created_at)}`);

  const members = parseAgentIds(meta.agent_ids);
  const isGroup = meta.kind === 'group' || members.length > 1;
  if (isGroup) {
    lines.push(`- 类型：群聊（${members.length} 人）`);
    lines.push(`- 成员：${members.map(resolveName).join('、') || '（无）'}`);
  } else if (meta.agent_id) {
    lines.push(`- Agent：${resolveName(meta.agent_id)}`);
  }
  if (meta.model) lines.push(`- 模型：${meta.model}`);
  if (meta.scenario_id) {
    lines.push(`- 场景：${SCENARIO_LABELS[meta.scenario_id] ?? meta.scenario_id}`);
  }
  if (meta.cwd) lines.push(`- 工作目录：${meta.cwd}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (messages.length === 0) {
    lines.push('（这个会话没有消息）');
    return lines.join('\n');
  }

  for (const m of messages) {
    const who =
      m.role === 'user'
        ? '🧑 我'
        : `🤖 ${m.author_agent_id ? resolveName(m.author_agent_id) : 'Agent'}`;
    const usage = formatUsage(m);
    lines.push(`## ${who} · ${formatTime(m.created_at)}${usage ? `（${usage}）` : ''}`);
    lines.push('');

    const body = (m.content ?? '').trim();
    lines.push(body || '（无文本内容）');

    // 图片：本地路径在别的机器上打不开，但仍然写出来，保留「这里有过图」的事实
    if (m.images && m.images.length > 0) {
      lines.push('');
      for (const img of m.images) {
        const alt = img.alt || img.prompt || '生成的图片';
        if (img.url) lines.push(`![${alt}](${img.url})`);
        else lines.push(`> 🖼 ${alt}`);
      }
    }

    // 工具调用摘要
    if (m.tool_calls && m.tool_calls.length > 0) {
      lines.push('');
      for (const t of m.tool_calls) {
        const input = t.input ?? {};
        const target =
          (typeof input.file_path === 'string' && input.file_path) ||
          (typeof input.path === 'string' && input.path) ||
          (typeof input.command === 'string' && input.command) ||
          (typeof input.pattern === 'string' && input.pattern) ||
          (typeof input.url === 'string' && input.url) ||
          '';
        const mark = t.isError ? '❌' : t.status === 'completed' ? '✅' : '•';
        const clipped = target.length > 80 ? `${target.slice(0, 77)}...` : target;
        lines.push(`> ${mark} \`${t.name}\`${clipped ? ` ${clipped}` : ''}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * 拉全量会话并触发下载。
 *
 * 失败不静默：Toast 报错由调用方决定怎么呈现，这里 throw，
 * 让「以为导出成功、其实文件夹里什么都没有」不发生。
 */
export async function exportSessionToMarkdown(
  sessionId: string,
  resolveName: AgentNameResolver = id => id
): Promise<{ fileName: string; chars: number }> {
  const res = await fetch(`/api/sessions/${sessionId}`);
  if (!res.ok) {
    throw new Error(`导出自会话失败（HTTP ${res.status}）`);
  }
  const data = await res.json();
  const meta: SessionExportMeta = {
    id: data.session?.id ?? sessionId,
    title: data.session?.title ?? '未命名会话',
    model: data.session?.model ?? '',
    agent_id: data.session?.agent_id ?? null,
    kind: data.session?.kind ?? null,
    agent_ids: data.session?.agent_ids ?? null,
    cwd: data.session?.cwd ?? null,
    scenario_id: data.session?.scenario_id ?? null,
    created_at: data.session?.created_at ?? new Date().toISOString(),
  };
  const rows: ExportMessageRow[] = Array.isArray(data.messages) ? data.messages : [];

  const markdown = buildSessionMarkdown(meta, rows, resolveName);
  const fileName = `${safeFileName(meta.title)}.md`;

  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 不立刻 revoke：某些浏览器点击后还没开始下载，URL 就失效了
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  return { fileName, chars: markdown.length };
}
