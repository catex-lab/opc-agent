/**
 * 权限门禁前两层（A40）—— 规则匹配 + Bash 危险命令分类器。
 *
 * ## 为什么只做前两层
 *
 * 完整的权限管道一般是**四层**：
 *   ① 规则匹配 → ② Bash 分类器（22+ 类危险操作）→ ③ transcript 分类器 → ④ 独立模型判定
 * 这里做 ①②③ —— ③ 是「路径是否越出工作区」，纯几何判断，不需要模型。
 * 唯独 ④（再调一次模型做裁决）没做：它要多花一次 token 与一次延迟，
 * 而前两层已经能挡住绝大多数事故。**没做的就是没做**，这一点在 UI 上如实标注，
 * 不要让人以为有四层。
 *
 * ## 三条口径
 *
 * 1. **deny 优先于 allow**：用户规则里同时命中「允许 Bash」和「禁止 rm -rf」时，
 *    以后者为准。安全配置里「例外」不该靠规则顺序猜。
 * 2. **默认放行未知项**：这与 toolPolicy 的白名单（fail-closed）不冲突 ——
 *    白名单回答的是「这个场景允不允许用工具」，本模块回答的是「这次调用危不危险」。
 *    把这里也改成 fail-closed 会让没配规则的用户一步都跑不动。
 * 3. **分级而不是二值**：`risky` 仍然要人审批（照常弹窗），`dangerous` 直接拒。
 *    全变成「直接拒」会把 `git push` 这种日常操作也堵死。
 */

/** 风险分级。safe = 不用管；risky = 照常找人确认；dangerous = 直接拒。 */
export type RiskLevel = 'safe' | 'risky' | 'dangerous';

export interface BashVerdict {
  risk: RiskLevel;
  /** 命中的规则名（人话，会显示在审批弹窗里） */
  rule?: string;
  reason?: string;
}

/** 危险模式表。`pattern` 是按子串/正则匹配的小写化命令。 */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; rule: string; reason: string }> = [
  // `-r` 单独出现也拦：`rm -r node_modules` 不带 -f 一样整棵树没了。
  // （第一版只认 -f，于是这条最常见的写法落到了 risky 档。）
  { re: /\brm\s+(-[a-z]*\s+)*-?[a-z]*r[a-z]*f|\brm\s+(-[a-z]+\s+)*(?:-[a-z]*r|--recursive)\b/, rule: 'rm 强制递归删除', reason: 'rm -rf 一类会整棵删掉目录' },
  { re: /\brm\s+(-[a-z]+\s+)*\/(\s|$)|~\/(\s|$)|\$HOME(\s|$)/, rule: '删除用户主目录', reason: '目标是家目录时一次误操作就没了' },
  { re: /\bmkfs(\.\w+)?\b/, rule: '格式化文件系统', reason: '会重建整个分区的文件系统' },
  { re: /\bdd\b[^|]*\bof=\/dev\//, rule: 'dd 写块设备', reason: '直接写磁盘设备' },
  { re: />\s*\/dev\/(sd|nvme|hd|vd)/, rule: '重定向写块设备', reason: '把输出直接写进磁盘设备' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, rule: 'fork 炸弹', reason: '无限 fork 会拖垮整机' },
  { re: /\bchmod\s+(-[a-z]+\s+)*777\s+\/(\s|$)/, rule: '放开根目录权限', reason: '把根目录设成 777' },
  { re: /\b(shutdown|poweroff|reboot|halt)\b/, rule: '关机/重启', reason: '会影响这台机器上的其他工作' },
  { re: /\bkill\s+-9\s+1\b|\bkillall\s+-9\b/, rule: '强杀进程', reason: '一次强杀可能带崩整个会话' },
  { re: /\b(sudo|doas)\s+rm\b/, rule: '提权删除', reason: '提权后的删除没有挽回余地' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/, rule: '远程脚本直接执行', reason: '下载到的内容未经审阅就执行' },
  { re: /\bgit\s+push\b[^|]*(-f\b|--force\b|--force-with-lease\b)/, rule: '强制推送', reason: '会覆盖远端历史，别人拉的代码会错位' },
  { re: /\bgit\s+reset\s+--hard\b/, rule: '硬重置工作区', reason: '未提交的改动会全部丢失' },
  { re: /\bgit\s+clean\s+-[a-z]*d/, rule: '清理未跟踪文件', reason: '会删掉未纳入 git 的文件' },
  { re: /\bgit\s+push\b[^|]*\b(main|master)\b/, rule: '直推主分支', reason: '多数团队约定主分支要走评审' },
  { re: /\bformat\b|\bdel\s+\/[fs]\b|\brmdir\s+\/s\b/, rule: 'Windows 磁盘/目录清除', reason: '整盘或整树删除' },
  // ⚠️ 模式里**不许出现大写**：classifyBashCommand 先把整条命令 toLowerCase()
  // 再逐条匹配。第一版把 HKLM / -F 按原样写进来，三条 Windows 高危规则
  // 实际从未命中过 —— 这类「写了但没生效」的规则比不写更危险。
  { re: /\breg\s+(delete|add)\s+hklm\b/, rule: '改系统注册表', reason: '影响整台机器的系统设置' },
  { re: /\bdiskpart\b|\bparted\b|\bfdisk\b/, rule: '分区操作', reason: '改分区表风险不可逆' },
  { re: /\biptables\s+(-f|--flush)\b|\bnft\s+flush\b/, rule: '清空防火墙', reason: '会关掉本机网络防护' },
  { re: /\bcrontab\s+-r\b/, rule: '清空定时任务', reason: '别人的定时任务会一起消失' },
  { re: /\b(npm|pnpm|yarn)\s+(publish|unpublish)\b/, rule: '发布/撤销发布包', reason: '会影响公开仓库' },
  { re: /\bdocker\s+(system\s+prune|rm\s+-f\s+\$\(docker\s+ps)/, rule: '批量清理容器', reason: '可能连带删掉在跑的容器' },
  // 首词也要 \b：第一版写成 `\b shred\b`（前面带空格），句首的 `shred x`
  // 匹配不上 —— 危险规则漏掉开头的情形最致命。
  { re: /\bshred\b|\bwipefs\b/, rule: '不可逆擦除', reason: '擦除后无法恢复' },
];

const RISKY_PATTERNS: Array<{ re: RegExp; rule: string }> = [
  { re: /\bgit\s+push\b/, rule: '推送到远端' },
  { re: /\bgit\s+(reset|rebase|cherry-pick)\b/, rule: '改写历史' },
  { re: /\bsudo\b/, rule: '提权执行' },
  { re: /\b(npm|pnpm|yarn)\s+(i|install|add|up|update)\b/, rule: '安装/升级依赖' },
  { re: /\bcurl\b|\bwget\b/, rule: '联网下载' },
  { re: /\bchmod\b|\bchown\b/, rule: '改权限/属主' },
  { re: /\bmv\b/, rule: '移动文件' },
  { re: /\b(rm|unlink)\b/, rule: '删除文件' },
  { re: /\bpkill\b|\bkill\b/, rule: '结束进程' },
  { re: /\bdocker\b/, rule: '容器操作' },
  { re: /\bssh\b|\bscp\b|\brsync\b/, rule: '远程传输' },
  { re: />\s*\S/, rule: '输出重定向（可能覆盖文件）' },
  { re: /\bexport\b\s+\w+=/, rule: '设置环境变量' },
  { re: /\bsystemctl\b|\bservice\b/, rule: '操作系统服务' },
];

/**
 * 判断一条 shell 命令的危险等级。
 *
 * 先查 dangerous 再查 risky：`rm -rf /` 同时命中「删除文件」和「rm 强制递归」，
 * 顺序反了会把它降级成 risky（照常弹窗）而不是直接拒绝。
 */
export function classifyBashCommand(command: string): BashVerdict {
  const cmd = String(command ?? '').toLowerCase();
  if (!cmd.trim()) return { risk: 'safe' };

  for (const p of DANGEROUS_PATTERNS) {
    if (p.re.test(cmd)) {
      return { risk: 'dangerous', rule: p.rule, reason: `${p.rule}：${p.reason}` };
    }
  }
  for (const p of RISKY_PATTERNS) {
    if (p.re.test(cmd)) return { risk: 'risky', rule: p.rule };
  }
  return { risk: 'safe' };
}

/** 用户自定义规则：命中工具名 + （可选）命令/路径里的关键词。 */
export interface PermissionRule {
  /** 工具名，支持 `*` 结尾的通配（如 `Bash`、`*`） */
  tool: string;
  /** 命中后要包含的关键词（大小写不敏感）；缺省表示该工具的每次调用都命中 */
  match?: string;
  decision: 'allow' | 'deny';
  /** 给人看的理由 */
  note?: string;
}

export interface ToolVerdict {
  decision: 'allow' | 'deny';
  risk: RiskLevel;
  rule?: string;
  reason?: string;
  /**
   * 被用户规则**明示允许**：调用方可以据此跳过弹窗。
   *
   * 单独一个字段而不用「rule 存在即跳过」来判断：内置分类器也会填 rule
   * （它是用来在弹窗上解释「凭什么问这一句」的），两者语义不同。
   */
  auto?: boolean;
}

export interface ToolCallContext {
  toolName: string;
  input?: Record<string, unknown>;
  /** 当前工作目录，用于判断路径是否越界 */
  cwd?: string;
  rules?: readonly PermissionRule[];
}

function toolMatches(pattern: string, toolName: string): boolean {
  if (pattern === '*' || pattern === toolName) return true;
  if (pattern.endsWith('*')) return toolName.startsWith(pattern.slice(0, -1));
  return false;
}

/** 从工具入参里取出「这次到底动了哪个路径」（只取我们认识的键）。 */
function pathsOf(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const keys = ['file_path', 'path', 'notebook_path', 'cwd', 'command'];
  const out: string[] = [];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string') out.push(v);
  }
  return out;
}

/**
 * 路径是否越出工作区。
 *
 * 判据是**归一化后的绝对路径**不以 cwd 开头 —— 这样 `../../etc/passwd`、
 * `$HOME/x`、绝对路径 `/c/Windows/...` 都会被抓住，而 `./src/a.ts` 与
 * `src/../src/a.ts` 这类等价写法不会误报。
 *
 * 两个细节（都来自实测漏判）：
 *   1. **必须解析 `..` 段**：只折叠 `/./` 的话，`C:/work/opc/../../etc`
 *      字符串上仍以 `C:/work/opc` 开头，字符串前缀判断会放行它。
 *   2. **边界要按目录比**：`p === base` 才算「就在工作区里」，
 *      `p.startsWith(base)` 不够 —— `C:/work/opcfoo` 会被当成子目录。
 */
export function escapesCwd(paths: readonly string[], cwd: string | undefined): string | null {
  if (!cwd) return null;
  const base = normalize(cwd);
  if (!base) return null;
  const isInside = (p: string) => p === base || p.startsWith(base.endsWith('/') ? base : `${base}/`);
  for (const raw of paths) {
    const p = normalize(raw);
    if (!p) continue;
    // 相对路径：解析成绝对再比
    if (!/^[a-z]:[\\/]|^\//i.test(p)) {
      const abs = normalize(base.replace(/\/+$/, '') + '/' + raw.replace(/^\.\//, ''));
      if (isInside(abs)) continue;
      return raw;
    }
    if (!isInside(p)) return raw;
  }
  return null;
}

function normalize(p: string): string {
  const raw = p
    .replace(/\$HOME|~/g, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .toLowerCase()
    .trim();
  if (!raw) return '';
  const segs = raw.split('/');
  const isAbs = segs[0] === ''; // Unix 绝对路径：开头的空段必须留住
  const out: string[] = isAbs ? [''] : [];
  for (const seg of segs) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/**
 * 三层门禁（规则 → 分类器 → 路径越界）合成一次工具调用的裁决。
 *
 * ## 顺序为什么是这样（这坑值一条注释）
 *
 * 第一版把 allow 规则放在分类器**前面**直接返回，于是用户加一条
 * 「允许 Bash」就把 `rm -rf /` 一起放行了 —— 便利规则变成了后门。
 * 现在的顺序：
 *   ① 用户 deny 规则 → 命中即拒（deny 优先于 allow）
 *   ② 内置分类器 dangerous 一档 → 命中即拒，**用户 allow 规则也压不动**
 *   ③ 路径越界 → 同上，dangerous 一视同仁
 *   ④ 用户 allow 规则 → 到这一步已经没有高危嫌疑了，可以跳过弹窗
 *   ⑤ 分类器 risky 一档 → 放行，但要人确认
 *
 * 返回值里的 `risk` 与 `rule` 会一路带到前端的审批弹窗上 ——
 * 「为什么拦你」必须和「拦不拦」同时到达用户，否则弹窗只是一堵墙。
 */
export function evaluateToolCall(ctx: ToolCallContext): ToolVerdict {
  const input = ctx.input ?? {};

  // ---- ① 用户规则：deny 优先 ----
  let allowHit: PermissionRule | undefined;
  if (ctx.rules?.length) {
    for (const rule of ctx.rules) {
      if (!toolMatches(rule.tool, ctx.toolName)) continue;
      const hay = [String(input.command ?? ''), ...pathsOf(input)].join(' ').toLowerCase();
      if (rule.match && !hay.includes(rule.match.toLowerCase())) continue;
      if (rule.decision === 'deny') {
        return {
          decision: 'deny',
          risk: 'dangerous',
          rule: rule.note ?? `规则禁止 ${rule.tool}`,
          reason: rule.note ?? `被自定义规则拦截：${rule.tool}${rule.match ? ` 含「${rule.match}」` : ''}`,
        };
      }
      allowHit ??= rule;
    }
  }

  // ---- ② Bash 分类器 ----
  let riskyVerdict: BashVerdict | undefined;
  if (ctx.toolName === 'Bash' || ctx.toolName === 'Terminal') {
    const v = classifyBashCommand(String(input.command ?? ''));
    if (v.risk === 'dangerous') {
      return { decision: 'deny', risk: 'dangerous', rule: v.rule, reason: v.reason };
    }
    // 分类器没有权限模式的概念：「全放行跳过弹窗」由调用方实现，
    // dangerous 在这里已经拦掉了，risky 只是「要人确认」。
    if (v.risk === 'risky') riskyVerdict = v;
  }

  // ---- ③ 路径越界 ----
  const escaped = escapesCwd(pathsOf(input), ctx.cwd);
  if (escaped) {
    return {
      decision: 'deny',
      risk: 'dangerous',
      rule: '路径越出工作区',
      reason: `目标「${escaped}」不在当前工作目录内，已拦截。`,
    };
  }

  // ---- ④ 用户 allow 规则：到这里已无高危嫌疑，可以免弹窗 ----
  // risk 仍如实带分类器的结论：免弹窗不等于「这事不危险」，
  // 日志和后续统计要能看出它本来是需确认级。
  if (allowHit) {
    return {
      decision: 'allow',
      risk: riskyVerdict?.risk ?? 'safe',
      rule: allowHit.note ?? `规则允许 ${allowHit.tool}`,
      auto: true,
    };
  }

  // ---- ⑤ risky：放行但要人确认 ----
  if (riskyVerdict) return { decision: 'allow', risk: 'risky', rule: riskyVerdict.rule };

  return { decision: 'allow', risk: 'safe' };
}

/** 供 UI 展示的分级说明（固定文案，别处不要重复发明）。 */
export const RISK_LABEL: Record<RiskLevel, string> = {
  safe: '常规',
  risky: '需确认',
  dangerous: '高危',
};
