/**
 * 技能的提示词注入（P3）。
 *
 * ## 为什么需要这一层
 *
 * P1 把技能正文里的写死路径换成了 `{{SKILL_DIR}}` / `{{SKILLS_ROOT}}`，
 * P2 只把 **MCP** 经启动参数递给了 qoder。技能本身还没送到任何 Agent 手上 ——
 * 而 `targets.ts` 里有 4 个 Agent 标着 `prompt` 态（`claude` / `workbuddy` /
 * `kimicode` / `doubao`），它们没有可用的挂载接口，**只能靠系统提示注入**。
 * 不注入的话，「一份技能 15 家可用」只完成了「只存一份」那半截。
 *
 * ## 硬约束：不在用户目录里落任何东西
 *
 * 注入分两条路，两条都不写用户目录：
 *
 * | 情形 | 做法 | 拷贝 |
 * |---|---|---|
 * | 目标 Agent **自己的**技能目录里就有这条 | 直接把那个绝对路径告诉它 | 0 |
 * | 目标 Agent 没有（从别人那儿共享来的） | 镜像到 `data/extensions/skills/<名>/` | 1 份（我们自己家） |
 * | 目标 Agent 连本地目录都没有（HTTP 型） | 正文内联进提示词 | 0 |
 *
 * 镜像落在 `dataDir` 下，是**派生物**（删了能重建），不是第二份事实来源。
 * 这也解释了为什么镜像要**整目录复制**而不是只写 `SKILL.md`：
 * 技能目录里常有 `scripts/`、`assets/`，正文里写着 `{{SKILL_DIR}}/scripts/x.py`。
 * 只拷 SKILL.md 会让那条命令指向不存在的文件 —— 那种错不会报「文件缺失」，
 * 而是模型说「我跑了一下，没有输出」。
 *
 * ## 为什么 blocked 的技能分两种待遇
 *
 * `blocked` 的含义是「正文里扫到了疑似密钥，所以**不落库**」（见 `safety.ts`）。
 * 它管的是**我们存不存**，不是「这个文件该不该存在」—— 那个文件本来就在用户
 * 自己的技能目录里，用户自己的 CLI 也一直在读它。
 * 所以：
 * - **native**：照常注入路径。我们只是告诉 Agent「去读你自己那个文件」，没有搬运。
 * - **mirror**：跳过。为了共享一份带密钥的正文而把它拷进我们的数据目录，
 *   等于用「共享」当理由做了一次密钥扩散。
 *
 * ## 与记忆层的关系
 *
 * 本模块**不 import `memory.ts`**，只接收「已经拼好记忆的提示词」再往上叠。
 * 反过来写（在这里调 `withMemoryContext`）会让 `memory → inject → store → db`
 * 与 `memory` 自身成环，而 `db.ts` 明确要求自己不被环回引用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataDirPath } from '../paths.js';
import { SKILL_DIR_TOKEN, SKILLS_ROOT_TOKEN } from './normalize.js';
import { listItems, listSources } from './store.js';
import { targetOf } from './targets.js';

/** 镜像根目录（`data/extensions/skills/`）。派生物，可随时删除重建。 */
export const MIRROR_ROOT = path.join(dataDirPath, 'extensions', 'skills');

/** 单条技能内联的上限（字符）。HTTP 型 Agent 没有工具，只能整段塞进提示词。 */
const MAX_INLINE_PER_SKILL = 3000;
/**
 * 所有内联**正文**加起来的上限。
 *
 * 为什么是 18000 而不是更大：这条路径只服务 HTTP 型 Agent（`kimicode` /
 * `doubao`），它们的上下文常见是 32k —— 18000 字符约 7k token，给对话留得住
 * 位置。再大就会变成「每问一句都先读一遍技能手册」，把用户的提问挤到远处。
 *
 * 真实库实测（23 条技能）：不设限时整块 28k 字符；收到 18000 之后整块 **22091** 字符
 * （预算只算正文，清单行与标题另计）。
 */
const MAX_INLINE_TOTAL = 18000;
/** 清单最多列多少条。超了明说「还有 N 条未列出」，不静默截断。 */
const MAX_LISTED = 60;
/** 递归复制的最深层数（防符号链接成环）。技能目录实测不超过 4 层。 */
const MAX_COPY_DEPTH = 8;

export interface InjectedSkill {
  name: string;
  title: string;
  /** 一行描述（frontmatter.description 的首行） */
  description: string;
  /** 目标 Agent 能读到的技能目录绝对路径（正斜杠） */
  dirPath: string;
  /** `native` = 目标 Agent 自己的目录；`mirror` = 我们镜像的一份；`inline` = 正文塞进提示词 */
  origin: 'native' | 'mirror' | 'inline';
  /** 内联正文；只有「目标 Agent 完全没有本地目录」时才非空 */
  inline: string | null;
}

/** 路径统一成正斜杠：注入的字符串里混用 `\` 与 `/` 时，很多工具链会解析失败。 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 目录名安全化。技能名来自 frontmatter，不能直接当路径用（`../` 会逃逸）。 */
function safeDirName(name: string): string | null {
  const s = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return s ? s : null;
}

/**
 * 把占位符换成真实路径。
 *
 * 用 `split/join` 而不是正则：占位符里带 `{{}}`，写正则要转义两层，
 * 而这里要的本来就是「字面量全局替换」，用正则反而更容易写错。
 */
export function resolvePlaceholders(text: string, skillDir: string, skillsRoot: string): string {
  return text
    .split(SKILL_DIR_TOKEN)
    .join(toPosix(skillDir))
    .split(SKILLS_ROOT_TOKEN)
    .join(toPosix(skillsRoot));
}

/**
 * 递归复制一个目录。
 *
 * ## 为什么不用 `fs.cpSync({ dereference: true })`
 *
 * 本机 `~/.claude/skills/agently-mail` **是一条符号链接**（`import.ts` 里
 * 早就记着这件事）。`cpSync` 在 Windows 上对「目标是目录的符号链接」会抛
 * `Cannot overwrite directory … with non-directory …` —— 因为它判类型用的是
 * `lstat`，而 `dereference` 只管复制内容、不管这一步判定。
 * 后果不是报错那么简单：`mirrorSkill` 返回 null ⇒ **这条技能从清单里消失**，
 * 用户看到的是「workbuddy 少一条技能」，没有任何提示。
 *
 * 所以这里自己走一遍：用 `statSync`（跟随链接）判类型，`depth` 封顶防成环。
 */
function copyTree(src: string, dest: string, depth = 0): void {
  if (depth > MAX_COPY_DEPTH) return;
  const st = fs.statSync(src); // 跟随符号链接
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      /* 跳过 node_modules 与 .git：有些技能的 scripts 目录带自己的依赖，
         拷进来既慢又没意义。 */
      if (name === 'node_modules' || name === '.git') continue;
      copyTree(path.join(src, name), path.join(dest, name), depth + 1);
    }
    return;
  }
  if (st.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

interface MirrorInput {
  name: string;
  body: string;
  /** 源目录；null = 源文件已经没了，只能拿库里的正文写一份只有 SKILL.md 的镜像 */
  srcDir: string | null;
  /** 内容指纹，用来判断「要不要重新拷」 */
  signature: string;
}

/**
 * 把一条技能镜像到 `data/extensions/skills/<名>/`。
 *
 * 返回目录路径；镜像不了（名字非法 / 写失败）时返回 `null`。
 * **不抛异常**：一条技能镜像失败不该让整轮对话发不出去。
 */
export function mirrorSkill(input: MirrorInput): string | null {
  const dirName = safeDirName(input.name);
  if (!dirName) return null;
  const dest = path.join(MIRROR_ROOT, dirName);
  const marker = path.join(dest, '.opc-mirror.json');

  // 已经镜过同一版本：直接复用，不做任何 IO 写
  try {
    const prev = JSON.parse(fs.readFileSync(marker, 'utf8')) as { signature?: string };
    if (prev.signature === input.signature && fs.existsSync(path.join(dest, 'SKILL.md'))) {
      return dest;
    }
  } catch {
    /* 没有 marker / 不是 JSON / 目录不在：都当作「需要重建」 */
  }

  try {
    fs.mkdirSync(dest, { recursive: true });
    if (input.srcDir && fs.existsSync(input.srcDir)) {
      /* 整目录复制（含 scripts/ assets/）。为什么必须整目录而不是只写 SKILL.md：
         正文里常写着 `{{SKILL_DIR}}/scripts/x.py`，只拷 SKILL.md 会让那条命令
         指向不存在的文件 —— 那种错不会报「文件缺失」，而是模型说「我跑了一下，
         没有输出」。 */
      copyTree(input.srcDir, dest);
    }
    /* 正文以**库里的**为准（可能是归一化后的），覆盖掉源文件里的原文。
       这样占位符才能真正解析到镜像目录上。 */
    fs.writeFileSync(
      path.join(dest, 'SKILL.md'),
      resolvePlaceholders(input.body, dest, MIRROR_ROOT),
      'utf8'
    );
    fs.writeFileSync(marker, JSON.stringify({ signature: input.signature, at: Date.now() }), 'utf8');
    return dest;
  } catch (e) {
    console.error('[extensions] 镜像技能失败（跳过）:', input.name, (e as Error).message);
    return null;
  }
}

/**
 * 某个 Agent 能用上的技能清单。
 *
 * 只对 `prompt` 态的 Agent 返回内容 —— `native` 的 Agent 自己就读自己的目录，
 * 再列一遍是噪音；`flag` 的走启动参数（P2 已接 MCP，技能等 P5）；
 * `unsupported` 的注入了也没人执行。
 */
export function skillsForAgent(agentId: string | null | undefined): InjectedSkill[] {
  if (!agentId) return [];
  const target = targetOf(agentId);
  if (!target || target.mode !== 'prompt') return [];

  const out: InjectedSkill[] = [];
  for (const item of listItems('skill')) {
    if (!item.enabled) continue;

    const sources = listSources(item.id);
    // ① 目标 Agent 自己的目录里就有 → 零拷贝，直接指过去
    const own = sources.find(s => {
      if (s.agentId !== agentId) return false;
      try {
        return fs.existsSync(path.join(s.path, 'SKILL.md'));
      } catch {
        return false;
      }
    });
    if (own) {
      out.push({
        name: item.name,
        title: item.title || item.name,
        description: firstLine(item.description),
        dirPath: toPosix(own.path),
        origin: 'native',
        inline: null,
      });
      continue;
    }

    // ② 没有自己的副本 → 走镜像 / 内联。blocked 的不往外搬（见文件头）
    if (item.blocked) continue;

    const srcDir = sources.map(s => s.path).find(p => fs.existsSync(path.join(p, 'SKILL.md'))) ?? null;

    if (!target.skillsDir) {
      /* 连本地技能目录都没有的（HTTP 型开放平台）：它读不到任何文件，
         只能把正文塞进提示词。库里有正文就用库里的，没有就现读源文件。 */
      const body = item.body ?? readBody(srcDir);
      if (!body) continue;
      out.push({
        name: item.name,
        title: item.title || item.name,
        description: firstLine(item.description),
        dirPath: '',
        origin: 'inline',
        inline: resolvePlaceholders(body, srcDir ?? '', MIRROR_ROOT),
      });
      continue;
    }

    /* 有目录但这条不在里面：镜像一份到我们自己家。库里没正文（比如 blocked 之外的
       极端情况）时从源文件现读一份，避免「库里没存 = 这条永远用不上」。 */
    const body = item.body ?? readBody(srcDir);
    if (!body) continue;
    const dir = mirrorSkill({
      name: item.name,
      body,
      srcDir,
      signature: [item.contentHash, item.bodyHash, item.revision].join('|'),
    });
    if (!dir) continue;
    out.push({
      name: item.name,
      title: item.title || item.name,
      description: firstLine(item.description),
      dirPath: toPosix(dir),
      origin: 'mirror',
      inline: null,
    });
  }
  return out;
}

function readBody(srcDir: string | null): string | null {
  if (!srcDir) return null;
  try {
    return fs.readFileSync(path.join(srcDir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
}

function firstLine(s: string | null | undefined): string {
  const t = (s ?? '').trim();
  if (!t) return '';
  const line = t.split(/\r?\n/)[0].trim();
  return line.length > 160 ? line.slice(0, 157) + '…' : line;
}

/**
 * 拼成一段可以直接接在系统提示词后面的文本。
 *
 * 没有可用技能时返回 **空串**（调用方据此不加任何东西）—— 返回一句
 * 「暂无可用技能」会给每个会话都塞一段废话，还让「提示词变长了」变成
 * 无法归因的现象。
 */
export function buildSkillsBlock(agentId: string | null | undefined): string {
  const skills = skillsForAgent(agentId);
  if (skills.length === 0) return '';

  const listed = skills.slice(0, MAX_LISTED);
  const rest = skills.length - listed.length;

  const lines: string[] = [
    '## 技能库（OPC 扩展）',
    '',
    '下列技能已安装。需要用到某个技能时，**先读它的 `SKILL.md` 再按其中步骤执行**；',
    '正文里出现 `{{SKILL_DIR}}` 的位置指的就是该技能自己的目录。',
    '',
  ];

  let inlineBudget = MAX_INLINE_TOTAL;
  let truncatedInline = 0;

  for (const s of listed) {
    const desc = s.description ? ` — ${s.description}` : '';
    if (s.inline === null) {
      lines.push(`- \`${s.name}\`${desc}（目录：\`${s.dirPath}\`）`);
      continue;
    }
    if (inlineBudget <= 0) {
      truncatedInline += 1;
      lines.push(`- \`${s.name}\`${desc}（正文过长，未内联）`);
      continue;
    }
    const cap = Math.min(MAX_INLINE_PER_SKILL, inlineBudget);
    const body = s.inline.length > cap ? s.inline.slice(0, cap) + '\n…（正文过长，已截断）' : s.inline;
    inlineBudget -= body.length;
    lines.push(`- \`${s.name}\`${desc}`, '', body.trim(), '');
  }

  if (rest > 0) lines.push(`（另有 ${rest} 条技能未列出，可在「扩展」里查看全部）`);
  if (truncatedInline > 0) lines.push(`（其中 ${truncatedInline} 条因提示词长度上限未内联正文）`);

  return lines.join('\n').trimEnd();
}

/**
 * 在**已经拼好记忆**的提示词上再叠技能清单。
 *
 * 顺序是刻意的：人设 → 记忆 → 技能。技能放最后，因为它是「怎么做某件事」的
 * 操作手册 —— 只有真的用到时才需要，而它可能很长（内联模式能到两万多字符）。
 * 摆在记忆前面会把「这个项目是什么」的短背景挤到远端，模型更容易忽略。
 */
export function withExtensionsContext(prompt: string | undefined, agentId: string | null | undefined): string {
  const base = (prompt ?? '').trimEnd();
  const block = buildSkillsBlock(agentId);
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}
