/**
 * 极简 5 段 cron 解析器（A224 定时派活专用）。
 *
 * ## 为什么不引 node-cron
 *
 * 打包产物里 node_modules 是**白名单制**（electron-builder.yml 的 files 只收
 * express / agent-sdk / uuid 三个生产依赖，注释写明了是为了绕开
 * computeNodeModuleFileSets 爆体积）。为一个每 20 秒一次的本地调度器
 * 加一个运行时依赖，代价是把打包清单、闸门、升级链全部多牵一处。
 * 而「分 时 日 月 周」的匹配逻辑本来就只有百来行，还是纯函数——
 * 纯函数意味着闸门可以直接枚举边界用例，比依赖第三方更可控。
 *
 * ## 支持的语法（覆盖定时派活的全部真实需求）
 *
 *   `*`        任意值
 *   星号/n     步进（如 分钟位 "星号/15" = 每 15 分钟）
 *   `a-b`      区间
 *   `a-b/n`    区间步进
 *   `a,b,c`    列表（可与上面混用：`1,10-15/2`）
 *   时区       本地时区（用户在界面上看到几点就是几点跑，不做 UTC 换算）
 *
 * 星期字段 0 与 7 都指周日（cron 惯例）；月与日从 1 起。
 * 精度：**分钟级**。秒不做（派活不需要秒，秒级反而制造「错过一秒算不算漏」
 * 这种说不清的语义）。
 */

export interface CronFields {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
}

export type ParseCronResult =
  | { ok: true; fields: CronFields }
  | { ok: false; error: string };

/** 每个字段的合法范围。星期 0-7（0 与 7 都是周日），其余按公历惯例 */
const RANGES: Array<{ min: number; max: number; label: string }> = [
  { min: 0, max: 59, label: '分钟' },
  { min: 0, max: 23, label: '小时' },
  { min: 1, max: 31, label: '日' },
  { min: 1, max: 12, label: '月' },
  { min: 0, max: 7, label: '星期' },
];

/** 解析单个字段的取值集合。越界 / 非法直接报错，不猜 */
function parseField(raw: string, index: number): number[] | string {
  const { min, max, label } = RANGES[index];
  const values = new Set<number>();

  for (const part of raw.split(',')) {
    if (!part) return `${label}字段有空项（检查逗号）`;
    // 拆出步进：`a-b/n`、星号/n、单个值
    const [rangePart, stepPart] = part.split('/');
    if (stepPart !== undefined && !/^\d+$/.test(stepPart)) {
      return `${label}字段的步进不是数字：/${stepPart}`;
    }
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (step < 1) return `${label}字段的步进至少为 1`;

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      if (!/^\d+$/.test(a ?? '') || !/^\d+$/.test(b ?? '')) {
        return `${label}字段的区间不是数字：${rangePart}`;
      }
      lo = Number(a);
      hi = Number(b);
    } else if (/^\d+$/.test(rangePart)) {
      lo = Number(rangePart);
      hi = stepPart !== undefined ? max : lo; // `5/2` = 从 5 开始步进到上限
    } else {
      return `${label}字段无法识别：${rangePart}`;
    }

    if (lo < min || hi > max || lo > hi) {
      // 星期 7 归一到 0（cron 惯例），其余越界就是越界
      if (index === 4 && lo === 7 && hi === 7) {
        values.add(0);
        continue;
      }
      return `${label}字段超出范围（${min}-${max}）：${rangePart}`;
    }
    for (let v = lo; v <= hi; v += step) {
      // 星期 7 = 周日 = 0
      values.add(index === 4 && v === 7 ? 0 : v);
    }
  }

  if (values.size === 0) return `${label}字段没有有效取值`;
  return [...values].sort((a, b) => a - b);
}

/** 解析 5 段 cron 表达式。错误信息面向用户（会显示在输入框下面） */
export function parseCron(expr: string): ParseCronResult {
  const trimmed = expr.trim().replace(/\s+/g, ' ');
  if (!trimmed) return { ok: false, error: '表达式不能为空' };
  const parts = trimmed.split(' ');
  if (parts.length !== 5) {
    return { ok: false, error: `表达式应为 5 段（分 时 日 月 周），当前 ${parts.length} 段` };
  }
  const fields: CronFields = { minute: [], hour: [], dom: [], month: [], dow: [] };
  const keys = ['minute', 'hour', 'dom', 'month', 'dow'] as const;
  for (let i = 0; i < 5; i++) {
    const parsed = parseField(parts[i]!, i);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    fields[keys[i]] = parsed;
  }
  return { ok: true, fields };
}

/** 语义兜底：`* * * * *` 每分钟跑一次对派活来说几乎必然是误填，直接拒绝 */
export const MIN_CRON_INTERVAL_MINUTES = 10;

/**
 * 高频触发检查。**不做**语法层禁止（步进语法本身合法），只在创建时给出明确拒绝——
 * 定时任务是真实调用 Agent（每次都烧额度），每 10 分钟跑一轮不是排班是放血。
 * 上界 = 每天 触发次数（hour 档数 × minute 档数）。返回 null = 可以创建。
 */
export const MAX_FIRES_PER_DAY = 6;

export function cronIntervalWarning(expr: string): string | null {
  const parsed = parseCron(expr);
  if (!parsed.ok) return null;
  const { fields } = parsed;
  const firesPerDay = fields.hour.length * fields.minute.length;
  if (firesPerDay > MAX_FIRES_PER_DAY) {
    return (
      `这条表达式每天会触发约 ${firesPerDay} 次。定时任务每次都会真实调用 Agent（消耗额度），` +
      `每天最多 ${MAX_FIRES_PER_DAY} 次；确需更高频请改用工作流脚本`
    );
  }
  return null;
}

/**
 * 从 `from`（含）之后寻找下一次触发时刻。分钟对齐（秒清零）。
 *
 * 穷举接下来 366 天的每一天（先判月/日/周，再找当天最早的时:分）——
 * 最坏 366×24×60 次比较，微秒级，调度器每 20 秒才跑一次，不值得为它
 * 写更聪明的算法。
 *
 * @returns 下一次触发时刻；表达式永远不会再触发（如 2 月 30 日）返回 null
 */
export function cronNextRun(expr: string, from: Date = new Date()): Date | null {
  const parsed = parseCron(expr);
  if (!parsed.ok) return null;
  const { fields } = parsed;

  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  // 「从 from 之后」：同一分钟内不重复触发
  start.setMinutes(start.getMinutes() + 1);

  const cursor = new Date(start.getTime());
  cursor.setHours(0, 0, 0, 0);

  for (let day = 0; day < 366 * 2; day++) {
    if (
      fields.month.includes(cursor.getMonth() + 1) &&
      fields.dom.includes(cursor.getDate()) &&
      fields.dow.includes(cursor.getDay())
    ) {
      // 当天按 时:分 升序找第一个 >= start 的
      for (const h of fields.hour) {
        for (const m of fields.minute) {
          const candidate = new Date(cursor.getTime());
          candidate.setHours(h, m, 0, 0);
          if (candidate.getTime() >= start.getTime()) return candidate;
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.getFullYear() - start.getFullYear() > 2) break;
  }
  return null;
}

/** 之后 N 次触发（预览用）。N 次凑不齐就少给几个（表达式可能永远不再触发） */
export function cronPreview(expr: string, count: number, from: Date = new Date()): Date[] {
  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const next = cronNextRun(expr, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
