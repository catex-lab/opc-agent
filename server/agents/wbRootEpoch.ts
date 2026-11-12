/**
 * A212：WorkBuddy 续接令牌纪元对账（水位线 reconcile）。
 *
 * ## 为什么单独一层
 *
 * 事故复盘（2026-11-12 晚，chat.db + CLI 会话注册表 + uuidv7 时间戳三源互证）：
 * A211 换根后，旧根时代发的 `sessions.sdk_session_id` 指向新根下不存在的
 * CLI 会话，续接 0.6s 报 `No conversation found with session ID: …` ——
 * 用户视角是「换根后第一句必炸，换模型也一样」。令牌没有纪元信息，无法
 * 自证出自哪个根，所以由服务端记一份「令牌纪元」水位线：生效数据根变了
 * ⇒ 旧纪元令牌全部作废（方案 A，用户拍板）。
 *
 * 不放进 `index.ts`：那里 import 即 `app.listen`，闸门没法直接驱动这段
 * 逻辑；也不放进 `wbProductProfile.ts`：它是纯发现层，不该沾数据库。
 * 本模块 = 发现层（wbProductProfile）+ 存储层（db）的组合点。
 *
 * 代价（已拍板）：换根后 AI 不再续接上一条的话题，从全新 CLI 会话开始 ——
 * 聊天记录完整可读，丢的只是 CLI 上下文衔接。
 *
 * 对账规则（按可信度递减）：
 *   1. 水位线存在且 ≠ 当前根 → 换柜实锤，批量作废；
 *   2. 水位线缺失（首次）+ 旧根目录还在 + 生效根 ≠ 旧根 → 这台机器真从
 *      旧柜搬过家（A211 上线当晚的存量形态），一并作废。旧根不存在 /
 *      生效根就是旧根 ⇒ 令牌与根同代，只记录不清，不给没换过柜的用户
 *      白白丢一次上下文；
 *   3. 水位线与当前根一致 → no-op。
 *
 * 调用点：服务启动一次（index.ts boot）、`rebindWorkbuddyRuntime`
 * （切版本/重扫立即生效）、发送路径（`agentId === 'workbuddy'` 时，
 * 覆盖运行期间官方自动换根）。memo 短路保证根不变时热路径零额外开销。
 */
import {
  effectiveWorkbuddyConfigRoot,
  legacyWorkbuddyRoot,
  legacyWorkbuddyRootExists,
  readWorkbuddyRootWatermark,
  writeWorkbuddyRootWatermark,
} from './wbProductProfile.js';
import { invalidateAgentResumeTokens } from '../db.js';

/** 这次对账判定令牌纪元已换代（根变化，或首次建水位线且推断换过柜） */
export interface WbRootReconcile {
  rootChanged: boolean;
  /** 本次作废的会话行数 */
  invalidated: number;
}

/** 进程内 memo：null = 本进程还没对过账（首次调用必走磁盘水位线） */
let rootMemo: string | null = null;

/** 仅供闸门夹具在跨场景间重置 memo；产品代码不该调 */
export function resetWorkbuddyRootMemoForTest(): void {
  rootMemo = null;
}

export function reconcileWorkbuddyResumeTokens(): WbRootReconcile {
  const root = effectiveWorkbuddyConfigRoot();
  if (rootMemo === root) return { rootChanged: false, invalidated: 0 };
  const last = readWorkbuddyRootWatermark();
  let invalidated = 0;
  let rootChanged = false;
  if (last !== null && last !== root) {
    rootChanged = true;
    invalidated = invalidateAgentResumeTokens('workbuddy');
  } else if (last === null && legacyWorkbuddyRootExists() && root !== legacyWorkbuddyRoot()) {
    rootChanged = true;
    invalidated = invalidateAgentResumeTokens('workbuddy');
  }
  writeWorkbuddyRootWatermark(root);
  rootMemo = root;
  if (invalidated > 0) {
    console.log(
      `[WB] 数据根纪元变化（${last ?? '未记录'} → ${root}）：作废 ${invalidated} 个会话的续接令牌，` +
        `下轮起自动新建 CLI 会话（聊天记录不受影响）`
    );
  }
  return { rootChanged, invalidated };
}
