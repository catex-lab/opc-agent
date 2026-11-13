/**
 * A220：会话的项目归属 —— 唯一推导入口。
 *
 * ## 为什么单独一个文件
 *
 * 项目入口「新建会话」（`ProjectDetail.tsx` → `App.tsx`）建的是前端本地空壳，
 * 首条消息才由 `POST /api/chat` 落库。以前这个分支没写 `project_id`，而项目
 * 视图按 `s.projectId === selectedProject.id` 过滤，于是刚建的会话要等下次
 * 启动 `backfillSessionProjects()` 才出现在项目里 —— 用户看到的是「发了消息，
 * 会话却不在项目里」。
 *
 * `POST /api/sessions`、`PATCH /api/sessions/:id`、`POST /api/chat` 三条路都
 * 需要同一把尺子。抄三份表达式迟早漂移（A220 就是 drift 的结果），所以收敛成
 * 一个函数，并且**让验证脚本能直接调用生产函数**对着真实临时 SQLite 验，
 * 而不是只在源码里找一行字面量。
 *
 * 与回填共用 `getOrCreateProject()`：`projects.path` 有唯一约束，路径归一化
 * 规则也来自同一处（`normalizeProjectPath`），因此「新建时算出的 id」与
 * 「重启后回填算出的 id」必然一致。
 *
 * 两个刻意保留的语义：
 * - `cwd` 为空 / 非字符串 → NULL，纯问答不属于任何项目；
 * - **存在性不在这里判**：`getOrCreateProject` 只做路径归一化 + upsert。
 *   三条调用路由（POST /api/sessions、PATCH、POST /api/chat）都在推导前
 *   用 `validateDirectory(cwd) === 'not-found'` 挡成 400；启动回填则自己
 *   `fs.existsSync`。把存在性塞进本函数，反而会让「已删除目录」在 PATCH
 *   与回填之间给出两种答案。闸门同时断言这个前置校验，不是漏了。
 */
import { getOrCreateProject } from './db.js';

/**
 * 由工作目录推导 `sessions.project_id`。
 *
 * 不抛异常：落库主链路上任何「算不出归属」的情况都降级为 NULL，
 * 由 `backfillSessionProjects()` 在以后补；不能因为一个项目归属把消息发不出去。
 */
export function projectIdForCwd(cwd: unknown): string | null {
  return typeof cwd === 'string' && cwd ? (getOrCreateProject(cwd)?.id ?? null) : null;
}
