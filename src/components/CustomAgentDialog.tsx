import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Eye, EyeOff, Loader2, X } from 'lucide-react';
import { Input } from 'tdesign-react';
import type { InputRef } from 'tdesign-react';

/**
 * 「自定义 Agent」创建弹窗（A114）。
 *
 * 用户原话：「增加用户自建联系人 agent，用户可以通过其他平台的 api 来实现」。
 * 这里收的口子是 **OpenAI 兼容的 HTTP 端点** —— 填地址、模型名、Key 三条，
 * 后端把它合成一条 `kind:'http'` 的 AgentDefinition，走的是豆包 / Kimi
 * 同一条适配器（`server/agents/adapters/http.ts`）。
 *
 * ## 为什么只做 OpenAI 兼容
 *
 * Anthropic 原生协议要 max_tokens、消息结构不通用；Gemini 要把模型名嵌进 URL。
 * 三种里只有 OpenAI 形态是事实标准 —— DeepSeek、智谱、SiliconFlow、
 * OpenRouter、公司内网网关、本地 Ollama/vLLM 全都提供 `/v1/chat/completions`。
 * 剩下两种留到真有需求时再加（后端 `customAgents.ts` 顶部有同样的说明）。
 *
 * ## 为什么地址要填到 `/v1` 这一层
 *
 * 拼最终 URL 时是 `${baseUrl}/chat/completions`。填到域名根
 * （`https://api.deepseek.com`）会打到不存在的路径，而各家版本前缀不统一
 * （`/v1`、`/v4`、`/api/paas/v4`），让用户填到「版本号那一层」是唯一通用的做法。
 */

interface CustomAgentDialogProps {
  open: boolean;
  onClose: () => void;
  /** 创建成功。上层据此重拉名册 */
  onCreated: () => void;
}

interface FormState {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

const EMPTY: FormState = { name: '', baseUrl: '', model: '', apiKey: '' };

/** 几个常见平台的填写示例，降低「我不知道该填什么」的门槛 */
const EXAMPLES = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6' },
  { label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5' },
];

export function CustomAgentDialog({ open, onClose, onCreated }: CustomAgentDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // TDesign 的 Input ref 是 InputRef（有 focus()/select()/blur()），
  // 不是裸 HTMLInputElement —— 直接按后者声明会编译不过。
  const nameRef = useRef<InputRef>(null);

  // 每次打开都是空表单：上一次填的一半不该留在里面
  useEffect(() => {
    if (open) {
      setForm(EMPTY);
      setError(null);
      setShowKey(false);
      setSubmitting(false);
      // 等一帧再聚焦，否则弹窗入场动画会把焦点抢回去
      const t = setTimeout(() => nameRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Esc 关闭。与设置弹窗、群聊弹窗同一套手感
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const set = (key: keyof FormState) => (v: string) => {
    setForm(f => ({ ...f, [key]: v }));
    setError(null);
  };

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/agents/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error || `创建失败（HTTP ${res.status}）`);
        return;
      }
      onCreated();
      onClose();
    } catch (err) {
      setError((err as Error).message || '创建失败，请检查网络后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const onFormKeyDown = (e: React.KeyboardEvent) => {
    // 回车提交，但不在多行/按钮里抢（这里全是单行 input，直接拦即可）
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.42)' }}
      onMouseDown={e => {
        // 只有点在遮罩本身才关闭：从面板里按下、拖到遮罩上松手不该关
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="自定义 Agent"
        data-custom-agent-dialog
        className="flex w-[min(460px,100%)] flex-col overflow-hidden rounded-2xl"
        style={{
          border: '1px solid var(--td-component-stroke)',
          boxShadow: 'var(--shadow-float)',
          backgroundColor: 'var(--tc-surface-content)',
        }}
      >
        {/* 头部：图标 + 标题 + 关闭。字号用 text-body 而不是 text-title-lg ——
            这是个 460px 的小弹窗，标题太大反而压住表单 */}
        <div className="flex shrink-0 items-center gap-2.5 px-5 pb-3 pt-5">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
            style={{ backgroundColor: 'var(--td-brand-color-light)', color: 'var(--td-brand-color)' }}
          >
            <Bot size={17} />
          </span>
          <h2 className="min-w-0 flex-1 truncate text-body font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>
            自定义 Agent
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--tc-hover-chrome)]"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-1">
          <p className="mb-4 text-caption leading-relaxed" style={{ color: 'var(--td-text-color-secondary)' }}>
            通过其他平台的 API 接一个模型进来。填下面三项即可，保存后它会出现在通讯录里，可以单独对话，也可以拉进群聊。
          </p>

          <div className="flex flex-col gap-3.5" onKeyDown={onFormKeyDown}>
            <Field label="名称" hint="通讯录里显示的名字">
              <Input
                ref={nameRef}
                value={form.name}
                onChange={set('name')}
                placeholder="例如：我的 DeepSeek"
                maxlength={20}
                size="small"
                data-custom-field="name"
              />
            </Field>

            <Field label="API 地址" hint="填到版本号那一层，不要带 /chat/completions">
              <Input
                value={form.baseUrl}
                onChange={set('baseUrl')}
                placeholder="https://api.deepseek.com/v1"
                size="small"
                data-custom-field="baseUrl"
              />
            </Field>

            <Field label="模型名" hint="平台文档里的模型 ID">
              <Input
                value={form.model}
                onChange={set('model')}
                placeholder="deepseek-chat"
                size="small"
                data-custom-field="model"
              />
            </Field>

            <Field label="API Key" hint="只存在本机，可稍后在「设置 → 登录配置」里更换">
              <Input
                value={form.apiKey}
                onChange={set('apiKey')}
                type={showKey ? 'text' : 'password'}
                placeholder="sk-..."
                autocomplete="off"
                size="small"
                data-custom-field="apiKey"
                suffix={
                  <button
                    type="button"
                    onClick={() => setShowKey(v => !v)}
                    aria-label={showKey ? '隐藏 Key' : '显示 Key'}
                    className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--tc-hover-chrome)]"
                    style={{ color: 'var(--td-text-color-placeholder)' }}
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                }
              />
            </Field>
          </div>

          {/* 示例：点一下把地址和模型名填进去，用户只差改 Key。
              给的是「最常见的几家」，不是全表 —— 全表会把弹窗撑成文档页 */}
          <div className="mt-4">
            <div className="mb-1.5 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
              常用平台（点按填充地址与模型名）
            </div>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map(ex => (
                <button
                  key={ex.label}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, baseUrl: ex.baseUrl, model: ex.model }))}
                  className="rounded-md px-2 py-1 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)]"
                  style={{
                    color: 'var(--td-text-color-secondary)',
                    border: '1px solid var(--tc-divider)',
                  }}
                >
                  {ex.label}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div
              className="mt-3 rounded-lg px-3 py-2 text-caption"
              style={{
                color: 'var(--td-error-color)',
                backgroundColor: 'var(--td-error-color-light)',
              }}
              role="alert"
              data-custom-agent-error
            >
              {error}
            </div>
          )}
        </div>

        {/* 底部操作。左「取消」右「创建」—— 与设置页保存按钮同一套主次关系 */}
        <div className="flex shrink-0 items-center justify-end gap-2 px-5 pb-5 pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3.5 py-1.5 text-body transition-colors hover:bg-[var(--tc-hover-chrome)]"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-body font-medium transition-colors disabled:opacity-60"
            style={{ backgroundColor: 'var(--td-brand-color)', color: '#fff' }}
            data-custom-agent-submit
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {submitting ? '创建中' : '创建'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** 表单行：标签 + 一行灰字说明 + 控件。说明放标签右边而不是控件下面，
 *  这样四个字段的行高一致，不会因为某行多一句话而参差不齐 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span className="mb-1 flex items-baseline gap-2">
        <span className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          {label}
        </span>
        {hint && (
          <span className="min-w-0 flex-1 truncate text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
            {hint}
          </span>
        )}
      </span>
      {children}
    </div>
  );
}
