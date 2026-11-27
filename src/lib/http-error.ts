/**
 * HTTP 状态码 → 人话 + 恢复动作（L4 / 审计 P0-16）。
 *
 * 为什么需要这一层：全仓曾有 61 处 `HTTP ${status}` 拼进错误文案，其中
 * 19 处是**裸抛**（没有后端 error 兜底），用户看到的就是一个裸状态码，
 * 既不知道发生了什么，也不知道下一步该干什么。
 *
 * 设计边界：
 *   1. 只做「状态码 → 中文结论 + 恢复动作」，不解析响应体、不做网络请求。
 *      后端已经给了更精确的中文 `error` 时，调用方仍应优先展示它（B 类
 *      调用点的 `data?.error || ...` 语义保持不变）。
 *   2. 用 i18n 模块级 `t()` 取当前语言 —— 它不是 hook，非组件模块
 *      （hook / api.ts 之外的 ts）也能用，且语言切换立即生效。
 *   3. 状态码只作为兜底文案的补充信息，绝不作为唯一内容（审计要点）。
 *      项目既有先例：`chat.evidence.checkFailed` / `chat.verify.launchFailed`
 *      都是「中文结论（HTTP n）」的形态，这里是同一惯例的收口。
 */
import { t } from '../i18n';

/**
 * 状态码对应的人话。未知状态保留 HTTP n 作补充，但不裸出。
 *
 * `status === 0` 表示没有拿到响应（网络层失败）——fetch 自身抛的是
 * "Failed to fetch"，同样属于技术原文，这里给出可执行的说明。
 */
export function httpErrorText(status: number): string {
  if (status === 0) return t('http.networkError');
  switch (status) {
    case 400:
      return t('http.badRequest');
    case 401:
      return t('http.unauthorized');
    case 403:
      return t('http.forbidden');
    case 404:
      return t('http.notFound');
    case 409:
      return t('http.conflict');
    case 429:
      return t('http.rateLimited');
    default:
      return status >= 500 ? t('http.serverError') : t('http.unknown', { status });
  }
}
