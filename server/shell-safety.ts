/**
 * 验证命令的 shell 安全边界（A97 / P2 加固）。
 *
 * `verify-runner.ts` 必须开 `shell:true`：`npm run test` 在 Windows 上要靠 shell
 * 找到 npm.cmd，`make test` 也依赖 shell 解析。关掉 shell 不是可选项，那就得把
 * 「命令字符串」这道口子守死。
 *
 * 命令不是用户手敲的，而是 `verify-commands.ts` 从**目标项目**的 `package.json`
 * 或 `Makefile` 里探测出来的 —— 那些文件位于用户工作区，可能来自克隆的第三方
 * 仓库，也可能被 Agent 改过。如果原样把 script 名拼进 `npm run <name>`，
 * 一个叫 `test:foo; curl … | sh` 的 script 就会变成 shell 里的第二条命令。
 *
 * 两道防线，任何一道都足以挡住拼接，两道都留着是因为它们防的是不同来源：
 *   1. `isSafeScriptName` —— 探测时按字符白名单过滤来自外部文件的名字；
 *   2. `isShellSafeCommand` —— 执行前对整条命令兜底（也覆盖 make / python /
 *      cargo 这些不走 script 名的分支，以及未来新增的探测来源）。
 *
 * 设计取向：宁可少列一条「可自动跑的检查」，也不能让任意字符串进 shell。
 */

/**
 * npm / pnpm / yarn / bun 的 script 名：字母或数字开头，之后只允许
 * 字母数字与 `: _ . -`。这是本项目所有探测规则实际会用到的全部字符集。
 * 长度也限一下，避免异常长的名字把命令撑爆。
 */
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;

/**
 * 整条命令允许的字符。现有探测结果形如 `npm run test:unit` / `pnpm test` /
 * `make test` / `python -m pytest -q` / `ruff check .` / `cargo test` /
 * `go test ./...`，一律不含 shell 元字符。
 *
 * 故意**不**允许：引号、反斜杠、反引号、`$()`、`;`、`&`、`|`、`<`、`>`、
 * 换行、`*`、`?`、`!`、`~`、`(`、`)`。少一个字符都不行，因为 shell:true
 * 下这些字符都会改变命令的语义，而不只是变成参数。
 */
const SAFE_COMMAND = /^[A-Za-z0-9_.:/@=+\-, ]+$/;

/** 探测层：这个名字能不能拼进 `npm run <name>`。 */
export function isSafeScriptName(name: unknown): boolean {
  return typeof name === 'string' && SAFE_SCRIPT_NAME.test(name);
}

/** 执行层：整条命令能不能交给 `spawn(..., { shell: true })`。 */
export function isShellSafeCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  // 换行 / 回车 / 制表符都不在字符类里；空串与超长串另挡一道
  return trimmed.length > 0 && trimmed.length <= 1024 && SAFE_COMMAND.test(trimmed);
}

/** 一眼能看懂的拒绝理由，给 runner 的 hint 和探测层的 note 用。 */
export function unsafeReason(what: 'script' | 'command', value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  // 别把可疑字符串原样回显进日志/报告：只给个长度和指纹式的位置提示
  return what === 'script'
    ? `script 名含 shell 元字符或非法字符（长度 ${text.length}），已拒绝拼进命令`
    : `命令含 shell 元字符（长度 ${text.length}），已拒绝执行`;
}
