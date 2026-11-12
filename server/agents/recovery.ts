/**
 * 失败原因 → 可执行建议。
 *
 * 为什么要这一层：名册上原来只能看到「401」「退出码 1」「429」这类原始信号。
 * 它们对排障的人是线索，对普通用户是一条**无法执行的信息** —— 不知道该去
 * 哪儿、做什么。这里把每种失败翻成一句「下一步做什么」，并要求**每个 Agent
 * 都有一句自己的恢复话术**（尤其是没有凭据编辑器的那些，用户只能去终端）。
 *
 * 两条边界：
 *   1. 这里**不判断凭据是否有效**，只根据错误文本给建议；判断在适配器/探测里。
 *   2. 不编造命令。没核实过的命令宁可写成「在该 Agent 里重新登录」，也不写一个
 *      跑不通的 `xxx login`。
 */
import { workbuddyKeyblobDisplay, workbuddyState } from './wbProductProfile.js';

/** 每个 Agent 的「怎么恢复」一句话。键与定义表 id 一致。 */
const RECOVERY_HINTS: Record<string, string> = {
  workbuddy:
    '在 WorkBuddy 桌面端重新登录，或让桌面端保持运行后再点「重新探测」；也可在「设置 → 登录配置 → Agent API Key」填 CODEBUDDY_API_KEY',
  codex: '在终端运行 `codex login`（登录态写入 ~/.codex/auth.json），或设置 OPENAI_API_KEY',
  gemini:
    '在终端运行 `gemini`，用 `/auth` 完成 Google 登录；也可在「设置 → 登录配置 → Agent API Key」填 GEMINI_API_KEY',
  opencode:
    '在终端运行 `opencode auth login`（凭据写入 ~/.local/share/opencode/auth.json）；免费模型额度用尽时等待重置或换模型',
  claude:
    '在终端运行 `claude`，用 `/login` 完成登录（写入 ~/.claude/.credentials.json）；也可设置 ANTHROPIC_API_KEY',
  hermes:
    '在终端运行 `hermes` 完成登录（凭据在 ~/.hermes/auth.json 或 %LOCALAPPDATA%/hermes/auth.json）',
  cursor: '在终端运行 `cursor-agent login`，或在「设置 → 登录配置 → Agent API Key」填 CURSOR_API_KEY',
  qoder:
    '在终端运行 `qodercli` 完成 Qoder 国际版登录（凭据在 ~/.qoder/.auth/user）',
  'qoder-cn':
    '在终端运行 `qodercli` 完成 Qoder 国内版登录（凭据在 ~/.qoder-cn/.auth/user）',
  doubao:
    '在「设置 → 登录配置 → Agent API Key」填 ARK_API_KEY（或 DOUBAO_API_KEY）',
  zcode: '打开 ZCode 桌面端重新登录（凭据在 ~/.zcode/cli/config.json），然后点「重新探测」',
  kimicode:
    '在「设置 → 登录配置 → Agent API Key」填 MOONSHOT_API_KEY（或 KIMI_API_KEY）；注意它和 Kimi Code 的登录态不通用',
  pi: '在终端运行 `pi`，用 `/login` 或在对应 provider 的 API Key（如 DEEPSEEK_API_KEY）完成登录',
  antigravity:
    '先在终端交互运行一次 `agy` 完成 Google 登录（登录态在系统钥匙串，磁盘上没有凭据文件）',
  kimicli:
    '在终端运行 `kimi login`（凭据写入 ~/.kimi-code/credentials/kimi-code.json）',
  trae: '在终端运行 `trae` 完成登录后重试',
};

/** 没有专门话术的自建 Agent 兜底；不假装知道它的登录方式 */
const FALLBACK_HINT =
  '在终端手动运行一次该 Agent 的命令查看它自己的报错；若是登录失效，请在该 Agent 内重新登录；然后点「重新探测」';

export function recoveryHintFor(id: string): string {
  if (id === 'workbuddy') return workbuddyRecoveryHint();
  return RECOVERY_HINTS[id] ?? FALLBACK_HINT;
}

/**
 * A211：WorkBuddy 的恢复指引必须是**运行时**生成的。
 *
 * 旧话术固定让用户「在 WorkBuddy 桌面端重新登录」，但官方把活跃数据目录
 * 切到另一份之后，桌面端重登只刷新新目录，我们读的旧 keyblob 纹丝不动 ——
 * 用户照做多少次都是无效循环。现在把当前真正生效的版本、它的数据根、
 * 是否检测到多个版本、内置值是否已漂移全部说清楚，让指引可执行。
 */
function workbuddyRecoveryHint(): string {
  let state: ReturnType<typeof workbuddyState>;
  try {
    state = workbuddyState();
  } catch {
    return RECOVERY_HINTS.workbuddy;
  }
  const active = state.profiles.find(p => p.id === state.activeId);
  const parts: string[] = [
    `当前接入 ${active?.productName ?? 'WorkBuddy'}（${active?.dataFolderName ?? '内置默认值'}）`,
  ];
  if (state.drift.length > 0) {
    parts.push('检测到官方活跃配置与内置默认值不同，应用已自动跟随官方；若仍失败，请到「设置 → 登录配置 → WorkBuddy 产品版本」确认选中的是正在使用的那个版本');
  }
  if (state.profiles.length > 1) {
    parts.push(`本机检测到 ${state.profiles.length} 个版本，可在「设置 → 登录配置 → WorkBuddy 产品版本」一键切换`);
  }
  parts.push(
    `在该版本的桌面端重新登录（登录态写入 ${workbuddyKeyblobDisplay()}），或让桌面端保持运行后点「重新探测」；也可在「设置 → 登录配置 → Agent API Key」填 CODEBUDDY_API_KEY`
  );
  return parts.join('；');
}

export type FailureKind = 'auth' | 'quota' | 'not-installed' | 'network' | 'unknown';

const QUOTA_RE =
  /(429|too many requests|rate.?limit|usage limit|quota|insufficient_quota|free usage limit|额度|限流|余额不足|配额)/i;
const AUTH_RE =
  /(401|403|unauthorized|unauthenticated|not logged in|please log ?in|login required|authentication required|invalid api key|invalid api key|missing api key|no api key|token (?:expired|invalid)|credential|未登录|凭据(?:无效|失效)|认证失败|需要先登录)/i;
const MISSING_RE =
  /(ENOENT|not found|未找到|未安装|CLI not found|找不到指定的文件|不在 PATH|command not found|is not recognized)/i;
const NETWORK_RE =
  /(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|502|503|504|network|proxy|代理|网络不可达|连接超时|tunnel)/i;

/**
 * 把错误文本归类。顺序是**刻意**的：
 * 429 先于「登录」—— 限流时部分 CLI 也会打印 401/unauthorized，
 * 先判登录会把用户引去重登一个额度用尽的账号。
 */
export function classifyFailure(message: string): FailureKind {
  const text = message ?? '';
  if (QUOTA_RE.test(text)) return 'quota';
  if (AUTH_RE.test(text)) return 'auth';
  if (MISSING_RE.test(text)) return 'not-installed';
  if (NETWORK_RE.test(text)) return 'network';
  return 'unknown';
}

export function failureAdvice(id: string, message: string): string | undefined {
  const kind = classifyFailure(message);
  const hint = recoveryHintFor(id);
  switch (kind) {
    case 'quota':
      return `额度/限流（不是登录失效）：等待额度重置、切换模型或补充额度后重试。${hint}`;
    case 'auth':
      return `重新登录：${hint}`;
    case 'not-installed':
      return `未安装或不在 PATH：${hint}`;
    case 'network':
      return `先检查网络/代理（凭据本身可能没问题）。${hint}`;
    default:
      return `在终端复现一次看完整报错，并点「重新探测」。${hint}`;
  }
}

/**
 * 给一段失败文案补上「怎么恢复」。
 *
 * 幂等：已经带「怎么恢复」就不再叠加 —— 运行期错误可能被包多层，
 * 叠加两次会让同一条建议在界面上重复。
 */
export function appendFailureAdvice(id: string, message: string): string {
  const text = message ?? '';
  if (text.includes('怎么恢复')) return text;
  const advice = failureAdvice(id, text);
  return advice ? `${text}\n怎么恢复：${advice}` : text;
}
