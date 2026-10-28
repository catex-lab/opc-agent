import { useEffect, useState } from 'react';
import { Dialog, Textarea, Button, MessagePlugin } from 'tdesign-react';
import { Play, FileCode } from 'lucide-react';

/**
 * 动态工作流入口（A41）。
 *
 * 为什么是弹窗而不是输入框里的一种消息：脚本动辄十几行、有语法（缩进、
 * await、类型注解），塞进聊天输入框既不好写也不好读。放进弹窗还有一层
 * 好处：**发送按钮就是「运行」**，用户不会误把一段脚本当成普通消息发出去。
 *
 * 运行结果不在这里渲染：脚本里每一次 assign/broadcast 都会以正常气泡
 * 出现在会话里（走的是同一套 SSE 事件），这里只负责「写脚本 + 发起」，
 * 以及把错误原样摆出来。
 */

interface WorkflowDialogProps {
  open: boolean;
  onClose: () => void;
  /** 群会话 id：工作流必须挂在既有会话上 */
  sessionId: string | null;
  /** 可用成员 id（脚本里 assign 的第一个参数只能从这里选） */
  memberIds: string[];
  memberNames: string[];
  /** 是否正在跑（发送中就不能再发起） */
  running: boolean;
  onRun: (source: string) => void;
}

const FALLBACK_TEMPLATE = `export default async function run(ctx) {
  const first = await ctx.assign(ctx.members()[0], '把这个需求拆成两个子任务');
  ctx.log('第一棒完成', first.text.length);
  return { chars: first.text.length };
}
`;

export function WorkflowDialog({
  open,
  onClose,
  sessionId,
  memberIds,
  memberNames,
  running,
  onRun,
}: WorkflowDialogProps) {
  const [source, setSource] = useState('');
  const [templateLoaded, setTemplateLoaded] = useState(false);

  // 打开时取服务端示例：示例要和原语签名一起演进，写死在前端会烂掉
  useEffect(() => {
    if (!open || templateLoaded) return;
    let alive = true;
    fetch('/api/workflow/template')
      .then(r => r.json())
      .then(j => {
        if (!alive) return;
        if (j?.template) setSource(j.template);
        setTemplateLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        setSource(FALLBACK_TEMPLATE);
        setTemplateLoaded(true);
        MessagePlugin.warning('示例拉取失败，已用本地简版示例');
      });
    return () => {
      alive = false;
    };
  }, [open, templateLoaded]);

  const run = () => {
    if (!source.trim()) {
      MessagePlugin.warning('脚本不能为空');
      return;
    }
    onRun(source);
  };

  return (
    <Dialog
      header="动态工作流"
      visible={open}
      onClose={onClose}
      width={620}
      className="workflow-dialog"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
            可用成员：{memberNames.length ? memberNames.join('、') : '（无）'}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              关闭
            </Button>
            <Button
              theme="primary"
              loading={running}
              disabled={!sessionId || memberIds.length === 0}
              onClick={run}
            >
              <Play className="mr-1" />
              运行
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div
          className="rounded-lg p-3 text-sm"
          style={{
            backgroundColor: 'var(--td-bg-color-container)',
            color: 'var(--td-text-color-secondary)',
          }}
        >
          <p>
            写一段 TypeScript 脚本，自己决定怎么组合成员。<code>ctx.assign(id, 任务)</code> 派给某个人、
            <code>ctx.broadcast(任务)</code> 全员并行、<code>ctx.relay(任务)</code> 依次传递、
            <code>ctx.debate(议题)</code> 辩论，还有 <code>ctx.memorySearch()</code> /
            <code>ctx.log()</code> / <code>ctx.note()</code>。
          </p>
          <p className="mt-1">
            每一次调用都会以正常气泡出现在这个会话里，慢或失败都能在会话里看到过程。
            沙箱里没有 <code>process</code> / <code>require</code> / <code>Buffer</code>。
          </p>
        </div>

        <Textarea
          value={source}
          onChange={v => setSource(v)}
          autosize={{ minRows: 12, maxRows: 24 }}
          className="font-mono text-sm"
          placeholder="export default async function run(ctx) { … }"
          tips="入口：export default async function run(ctx)"
        />

        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          <FileCode size={13} />
          <span>跑飞了也不怕：每次调用有独立超时，整体的看门狗会兜底。</span>
        </div>
      </div>
    </Dialog>
  );
}
