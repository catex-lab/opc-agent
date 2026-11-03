/**
 * `kb.search` 的 stdio 入口（由各 Agent 的 MCP 配置拉起）。
 *
 * 单独成一个文件是为了让 esbuild 打出一份 `dist-electron/kb-mcp.cjs`，
 * 与主服务进程解耦：CLI / ACP / SDK 都按「起一个子进程」的方式消费它。
 */
import { runKbMcpStdioServer } from './tool.js';

runKbMcpStdioServer();
