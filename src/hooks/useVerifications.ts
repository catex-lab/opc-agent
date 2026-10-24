/**
 * 验证结果的数据层（A97）。
 *
 * 结果落库在 `verifications` 表，按会话取全部、前端按 `message_id` 分组。
 * 为什么不是「每条消息各拉一次」：一条会话里可能有几十条回答，
 * 那样就是几十个请求；而这张表本身很小（一次验证一行）。
 */

import { useCallback, useEffect, useState } from 'react';

export type VerifyStatus = 'pass' | 'fail' | 'timeout' | 'error';

export interface VerificationRow {
  id: string;
  session_id: string;
  message_id: string | null;
  command_id: string;
  command: string;
  kind: string;
  label: string | null;
  status: VerifyStatus;
  exit_code: number | null;
  duration_ms: number | null;
  output: string | null;
  output_truncated: number;
  created_at: string;
}

export function useVerifications(sessionId: string | null | undefined) {
  const [rows, setRows] = useState<VerificationRow[]>([]);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setRows([]);
      return;
    }
    try {
      const res = await fetch(`/api/verify/results?sessionId=${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { verifications?: VerificationRow[] };
      setRows(Array.isArray(data.verifications) ? data.verifications : []);
    } catch {
      // 拿不到就保持现状：验证结果不是主链路，不该因为它让聊天页报错
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { rows, refresh };
}
