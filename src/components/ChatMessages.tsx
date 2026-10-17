import { useCallback } from 'react';
import { Loading } from 'tdesign-react';
import { ChatMarkdown } from '@tdesign-react/chat';
import { User, Image as ImageIcon } from 'lucide-react';
import { Message, Model, PermissionRequest, ContentBlock, RegisteredAgent, ToolCall } from '../types';
import { ToolCallsCollapse } from './ToolCallsCollapse';
import { InlinePermissionCard } from './InlinePermissionCard';
import { AgentAvatar } from './AgentAvatar';
import { ImageBubble } from './ImageBubble';

interface ChatMessagesProps {
  messages: Message[];
  models: Model[];
  messagesEndRef: React.RefObject<HTMLDivElement>;
  /**
   * 按 agentId 反查注册表条目。
   *
   * 一对一给 `id => agent`（会话只绑定一个 Agent）；群聊给
   * `registry.getAgent`，因为同一条消息流里会出现多个作者，
   * 每个气泡要用**它自己**的头像和名字，而不是会话头部那一个。
   */
  getAgent?: (id: string) => RegisteredAgent | undefined;
  /** 会话绑定的 Agent，作为反查不到时的兜底 */
  agent?: RegisteredAgent;
  /** 群聊模式：在气泡上方显示作者名，并渲染编排叙述行 */
  groupMode?: boolean;
  /**
   * 生图场景（P4-4）。开启后，assistant 的「等待中」提示改为「正在生成图像…」，
   * 并给生图消息一个专属头像 —— 图不是会话绑定的那个 Agent 画的，
   * 用它的头像会让人误以为「Hermes 会画图」。
   */
  imageMode?: boolean;
  // 内联权限确认相关
  permissionRequest?: PermissionRequest | null;
  onPermissionAllow?: () => void;
  onPermissionDeny?: () => void;
}

export function ChatMessages({
  messages,
  models,
  messagesEndRef,
  getAgent,
  agent,
  groupMode = false,
  imageMode = false,
  permissionRequest,
  onPermissionAllow,
  onPermissionDeny
}: ChatMessagesProps) {
  const resolveAgent = useCallback(
    (id?: string): RegisteredAgent | undefined => {
      if (!id) return agent;
      return getAgent?.(id) ?? agent;
    },
    [getAgent, agent]
  );
  const formatModelName = (modelId: string) => {
    const model = models.find(m => m.modelId === modelId);
    const name = model?.name || modelId;
    return name
      .replace(/^(Claude|GPT|Gemini|Kimi|DeepSeek|Qwen|GLM)\s*/i, '')
      .replace(/-/g, ' ')
      .trim() || name;
  };

  // 渲染单个内容块
  const renderContentBlock = (block: ContentBlock, index: number, isStreaming?: boolean, isLast?: boolean) => {
    if (block.type === 'text') {
      return (
        <div 
          key={`text-${index}`}
          className="tc-bubble-assistant px-4 py-3 leading-relaxed break-words"
        >
          <div className="chat-markdown">
            <ChatMarkdown content={block.text} />
          </div>
          {isStreaming && isLast && (
            <span 
              className="animate-cursor-blink ml-0.5"
              style={{ color: 'var(--td-brand-color)' }}
            >
              |
            </span>
          )}
        </div>
      );
    } else if (block.type === 'tool_use') {
      return (
        <ToolCallsCollapse
          key={`tool-${block.toolCall.id}`}
          toolCalls={[block.toolCall]}
          isStreaming={isStreaming && block.toolCall.status === 'running'}
        />
      );
    } else if (block.type === 'image') {
      return <ImageBubble key={`image-${index}`} image={block.image} />;
    }
    return null;
  };

  // 渲染 assistant 消息内容
  const renderAssistantContent = (message: Message) => {
    // 思考过程：默认折叠。Hermes 这类 Agent 会流式返回思考内容，
    // 直接铺开会淹没正文，所以收进 details 里按需展开。
    const thinkingBlock = message.thinking ? (
      <details className="tc-thinking mb-2 px-3 py-2 text-secondary">
        <summary className="cursor-pointer select-none">
          思考过程（{message.thinking.length} 字）
        </summary>
        <div className="mt-2 whitespace-pre-wrap leading-relaxed">{message.thinking}</div>
      </details>
    ) : null;

    // 失败原因。后端会把真实错误（未登录 / 网络不可达 / 退出码）带上来，
    // 这里原样展示，不用「发生错误请重试」这种无信息量的文案盖掉它。
    const errorBlock = message.error ? (
      <div
        className="mt-2 whitespace-pre-wrap break-words rounded-xl px-3.5 py-2.5 text-secondary leading-relaxed"
        style={{
          backgroundColor: 'var(--td-error-color-1)',
          color: 'var(--td-error-color-6)',
        }}
      >
        <div className="mb-1 font-medium">调用失败</div>
        {message.error}
      </div>
    ) : null;

    let body: React.ReactNode;

    // 优先使用 contentBlocks（按顺序排列）
    if (message.contentBlocks && message.contentBlocks.length > 0) {
      const blocks = message.contentBlocks;

      /**
       * 把**连续**的 tool_use 块合并成一个折叠分组。
       *
       * 为什么必须合并：流式过程中每个工具各占一个 contentBlock，若逐个渲染
       * 就会出现「查看步骤」「查看步骤」「查看步骤」一长串横条；而同一条消息
       * 重新加载后走的是 message.toolCalls 分支，只渲染**一个**「查看步骤 (N)」。
       * 同一个回答在「刚发完」和「刷新后」长得不一样，是很明显的观感断层。
       * 这里按「连续」而非「全部」分组，是为了保留「工具 → 文本 → 工具」
       * 这种交错顺序（文本是模型对上一批工具结果的解释，位置有语义）。
       */
      const nodes: React.ReactNode[] = [];
      let i = 0;
      while (i < blocks.length) {
        const block = blocks[i];
        if (block.type === 'tool_use') {
          const group: ToolCall[] = [];
          let j = i;
          while (j < blocks.length && blocks[j].type === 'tool_use') {
            group.push((blocks[j] as { type: 'tool_use'; toolCall: ToolCall }).toolCall);
            j++;
          }
          nodes.push(
            <ToolCallsCollapse
              key={`tools-${group[0].id}`}
              toolCalls={group}
              isStreaming={message.isStreaming && group.some(t => t.status === 'running')}
            />
          );
          i = j;
        } else {
          nodes.push(renderContentBlock(block, i, message.isStreaming, i === blocks.length - 1));
          i++;
        }
      }
      body = nodes;
    } else {
      // 兼容旧数据 / 刷新后还原：先工具调用，再图像，最后文本
      body = (
        <>
          {message.toolCalls && message.toolCalls.length > 0 && (
            <ToolCallsCollapse
              toolCalls={message.toolCalls}
              isStreaming={message.isStreaming}
            />
          )}
          {/*
            生图消息刷新后走这里 —— DB 只存 content / tool_calls / images，
            不存 contentBlocks，所以「刚生成」与「刷新后」必须由两条分支
            渲染出**同一个样子**，否则一刷新图片就消失。
          */}
          {message.images && message.images.length > 0 &&
            message.images.map((img, i) => <ImageBubble key={`img-${i}`} image={img} />)}
          {message.content && (
            <div className="tc-bubble-assistant px-4 py-3 leading-relaxed break-words">
              <div className="chat-markdown">
                <ChatMarkdown content={message.content} />
              </div>
              {message.isStreaming && (
                <span
                  className="animate-cursor-blink ml-0.5"
                  style={{ color: 'var(--td-brand-color)' }}
                >
                  |
                </span>
              )}
            </div>
          )}
        </>
      );
    }

    return (
      <>
        {thinkingBlock}
        {body}
        {errorBlock}
      </>
    );
  };

  /**
   * 编排叙述行（group_note）。
   *
   * 渲染成居中的弱化文字而不是气泡：它是**过程说明**（「主控决定交给
   * OpenCode」「第 2/2 棒」），不是谁的发言。做成气泡会让用户误以为
   * 某个 Agent 说了这句话，也会把真正的发言挤出视觉焦点。
   */
  const renderNote = (message: Message) => (
    <div key={message.id} className="flex justify-center py-0.5">
      <span
        className="rounded-full px-3 py-1 text-caption"
        style={{
          backgroundColor: 'var(--td-bg-color-secondarycontainer)',
          color: 'var(--td-text-color-placeholder)',
        }}
      >
        {message.content}
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto">
      {messages.map(message => {
        // 编排叙述行：不套气泡外壳，直接居中一行
        if (message.note) return renderNote(message);

        const msgAgent = resolveAgent(message.agentId);
        // 这条消息是不是生图产物（流式走 contentBlocks，刷新后走 images）
        const msgIsImage = !!(
          (message.images && message.images.length > 0) ||
          message.contentBlocks?.some(b => b.type === 'image')
        );

        return (
        <div
          key={message.id}
          className={`tc-msg-enter flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}
        >
          {message.role === 'user' ? (
            // 用户侧：品牌色实心圆 + 人像图标。用户没有「官方 logo」，
            // 与 Agent 侧的品牌 logo 形成清晰的左右对照。
            <div
              className="w-9 h-9 flex items-center justify-center flex-shrink-0 rounded-full self-start"
              style={{
                backgroundColor: 'var(--td-brand-color)',
                color: '#fff',
              }}
            >
              <User size={18} />
            </div>
          ) : msgIsImage ? (
            // 生图产物用**专属**头像：图是生图 provider 画的，不是会话绑定的
            // 那个 Agent 画的。套用它的头像会让人以为「Hermes 会画图」。
            <div
              className="w-9 h-9 flex items-center justify-center flex-shrink-0 rounded-full self-start"
              style={{ backgroundColor: '#D54941', color: '#fff' }}
              title="图像生成"
            >
              <ImageIcon size={18} />
            </div>
          ) : (
            // Agent 侧：复用 AgentAvatar，消息流里也能看到 Agent 的品牌身份，
            // 而不是所有 Agent 共用一个通用机器人图标。
            // 群聊里每个气泡按自己的 agentId 取头像。
            <AgentAvatar
              id={message.agentId || msgAgent?.id || 'assistant'}
              name={msgAgent?.name || 'Agent'}
              icon={msgAgent?.icon}
              color={msgAgent?.color}
              size={36}
              showStatus={false}
            />
          )}
          <div
            className={`flex flex-col gap-2 max-w-[80%] ${message.role === 'user' ? 'items-end' : ''}`}
          >
            {message.role === 'assistant' && groupMode && msgAgent && (
              // 群聊的作者名：两个都用实心 logo 的 Agent 光凭头像不好认，
              // 而且 relay/debate 会出现同一个人的多个气泡，更需要标明归属
              <span
                className="text-caption font-medium"
                style={{ color: 'var(--td-text-color-secondary)' }}
              >
                {msgAgent.name}
              </span>
            )}

            {message.role === 'assistant' && !groupMode && message.model && !msgIsImage && (
              <span
                className="text-caption"
                style={{ color: 'var(--td-text-color-placeholder)' }}
              >
                {formatModelName(message.model)}
              </span>
            )}

            {/* 用户消息 */}
            {message.role === 'user' && (
              <div className="tc-bubble-user px-4 py-3 leading-relaxed break-words">
                {message.content}
              </div>
            )}

            {/* 助手消息 - 按顺序渲染内容块 */}
            {message.role === 'assistant' && renderAssistantContent(message)}

            {/* 思考中状态（没有任何内容时显示） */}
            {message.role === 'assistant' && message.isStreaming &&
             !message.content &&
             !message.error &&
             !message.thinking &&
             (!message.contentBlocks || message.contentBlocks.length === 0) &&
             (!message.toolCalls || message.toolCalls.length === 0) && (
              <div
                className="flex items-center gap-2 px-3 py-2 rounded-lg"
                style={{ backgroundColor: 'var(--td-bg-color-component)' }}
              >
                <Loading size="small" />
                <span
                  className="text-sm"
                  style={{ color: 'var(--td-text-color-secondary)' }}
                >
                  {imageMode ? '正在生成图像...' : '思考中...'}
                </span>
              </div>
            )}
          </div>
        </div>
        );
      })}
      
      {/* 内联权限确认 - 横向简洁展示 */}
      {permissionRequest && onPermissionAllow && onPermissionDeny && (
        <div className="flex gap-3 ml-12">
          <InlinePermissionCard
            request={permissionRequest}
            onAllow={onPermissionAllow}
            onDeny={onPermissionDeny}
          />
        </div>
      )}
      
      <div ref={messagesEndRef} />
    </div>
  );
}
