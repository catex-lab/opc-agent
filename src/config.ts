/**
 * 应用配置文件
 * 统一管理应用名称和其他全局配置
 *
 * 注意：这里的 name 是**唯一权威来源**。
 * Electron 窗口标题、文档标题、新会话页标题都必须读这里，不要再各自硬编码 ——
 * 此前 NavRail 写死 "OPC Agent"/"OP" 而 config 是 "Web Agent"/"W"，
 * 导致同一屏里出现两个不同的产品名。
 */

export const APP_CONFIG = {
  /** 应用名称 */
  name: 'OPC Agent',

  /** 应用描述 */
  description: '选择一个 Agent，开始对话',

  /** 版本号 */
  version: '1.0.0',
};

export default APP_CONFIG;
