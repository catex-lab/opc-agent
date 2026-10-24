import { useRef, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Select, Tooltip } from 'tdesign-react';
import { ChatSender } from '@tdesign-react/chat';
import { ChevronDownIcon, LockOnIcon, LockOffIcon, EditIcon, TaskIcon } from 'tdesign-icons-react';
import {
  Paperclip,
  FileUp,
  FolderOpen,
  X,
  Image as ImageIcon,
  FileVideo,
  FileText,
  // A62：思考强度下拉的前缀图标。与附件菜单同一套图标体系（lucide），
  // 和权限模式的 tdesign 图标粗细才一致。
  Brain,
} from 'lucide-react';
import { Model, PermissionMode, RegisteredAgent } from '../types';
import { IMAGE_SIZES, IMAGE_SIZE_LABELS, IMAGE_MODELS } from '../imageOptions';
import { PermissionGapNotice } from './PermissionGapNotice';
import { ModelSelectPopup } from './ModelSelectPopup';
import { MENU_ITEM_SM_CLASS } from './menuItem';
// A93：输入框字号对齐正文。CSS 穿不过 TDesign 的两层 shadow，只能往那层
// shadow root 里注入样式表 —— 为什么以及踩过哪些坑，见该文件开头。
import { applySenderTypography } from '../senderTextarea';

interface ChatInputProps {
  inputValue: string;
  selectedModel: string;
  models: Model[];
  isLoading: boolean;
  permissionMode: PermissionMode;
  onSend: (message: string) => void;
  onStop: () => void;
  onChange: (value: string) => void;
  onModelChange: (modelId: string) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  /**
   * A62：当前模型的思考强度档位值。`''` = 用 CLI 自己的默认。
   *
   * 只在**当前选中的模型真的有档位表**时由调用方提供；没有档位表时
   * 传 undefined，本组件据此不渲染这颗下拉（见 reasoningOfSelectedModel）。
   */
  reasoningEffort?: string;
  /** A62：改档位。控件不渲染时不会被调用 */
  onReasoningEffortChange?: (value: string) => void;
  /**
   * 群聊成员。传了就在输入框上方渲染 `@` 成员条，并把模型选择器换成
   * 「模型由 Agent 决定」—— 群聊没有单一模型，每个成员各自解析。
   */
  mentionMembers?: RegisteredAgent[];
  /** 群聊的补充提示（如「指定模式下只会唤醒被 @ 的成员」） */
  mentionHint?: string;
  /**
   * P4-5：会话中的权限强制缺口提示（文案由 ChatPage 算好）。
   *
   * 与 NewChatView 那条同源：权限模式选择器就在本组件底部，
   * 提示跟它同屏，用户切换后立刻能看到承诺有没有落空。
   * 生图模式下权限选择器整个被换掉，这条也没有意义 —— 渲染时忽略。
   */
  permissionGap?: string | null;
  /**
   * P4-4：生图模式。
   *
   * 开启后输入区语义从「发消息」变成「描述 → 生成图像」：
   * 占位符改写，底部的模型/权限选择器换成生图模型与尺寸 ——
   * 权限模式对一次无状态 HTTP 调用毫无意义，留着只会让人以为它能控制什么。
   */
  imageMode?: boolean;
  imageSize?: string;
  imageModel?: string;
  onImageSizeChange?: (size: string) => void;
  onImageModelChange?: (model: string) => void;
  /**
   * A73：「添加模型」按钮。跳「设置 → 模型清单」去刷新枚举。
   *
   * 不传就不渲染底部那条通栏 —— 调用方（聊天里的输入框）拿不到路由，
   * 摆一个点了没反应的按钮比不摆更糟。
   */
  onAddModel?: () => void;
}

/* ── 附件（A35）─────────────────────────────────────────────────────
 *
 * 用户要求：输入框里加一个附件按钮，支持图片 / 文档 / 视频 / 文件夹。
 *
 * ## 为什么不做「上传」
 *
 * 这是一个**本地** Agent 应用：Agent 跑在这台机器上，本来就能直接读盘。
 * 把文件传一遍再让 Agent 去读一个临时副本，既慢又多一份可能过期的数据。
 * 所以这里的语义是「把本机路径告诉 Agent」—— 消息里附上绝对路径，
 * 由 Agent 自己决定怎么读（这正是它与云端聊天机器人的区别）。
 *
 * ## 路径从哪来
 *
 * Electron 32 起 `File.path` 被移除，唯一正路是 `webUtils.getPathForFile`，
 * 由 preload 暴露成 `window.opc.getFilePath`（见 electron/preload.cjs）。
 * 浏览器开发态没有这层桥，退化成文件名 —— 不伪造路径，宁可信息少一点。
 *
 * ## 文件夹为什么只出一颗 chip
 *
 * `<input webkitdirectory>` 会把目录下**所有文件**都列出来（可能上千个）。
 * 逐个列成 chip 会把输入区顶穿，而且用户要表达的就是「这个目录」。
 * 所以取第一个文件的完整路径、减去它的 `webkitRelativePath`，反推出目录
 * 绝对路径，只挂一颗 chip。
 */
type AttachmentKind = 'image' | 'video' | 'file' | 'folder';

interface Attachment {
  /** 绝对路径（浏览器开发态退化为文件名）—— 同时用作去重键 */
  path: string;
  name: string;
  size: number;
  kind: AttachmentKind;
}

const MAX_ATTACHMENTS = 10;

/**
 * 输入区里五个可选弹层的名字。
 *
 * 它们共用一个 `openSelect` —— 同一时刻只允许一个展开（用户反馈：
 * 「点另一个时前一个没有自动关闭」）。
 *
 * 为什么不能指望组件库自己关：这几个 Select 挂在 `ChatSender` 的
 * shadow DOM 插槽里，宿主会吃掉 slotted 节点的 pointerdown / 兼容性 mouse
 * 事件（附件菜单那段注释里已实测过）。TDesign 的 outside-click 挂在
 * document 上，根本收不到「用户点了另一个 Select」这个事件，
 * 于是第一个弹层就永远不知道自己该关。
 *
 * 所以改成受控：谁被打开就把名字写进 state，其余的一律 `popupVisible=false`。
 * 这样「互斥」由我们保证，不依赖事件是否能穿透 shadow 边界。
 */
type OpenSelect = 'model' | 'permission' | 'reasoning' | 'imageModel' | 'imageSize';

function kindOf(file: File): AttachmentKind {
  const t = file.type || '';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  return 'file';
}

function formatSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** File → 磁盘绝对路径（拿不到就用文件名，绝不编造路径） */
function filePathOf(file: File): string {
  const bridge = (window as unknown as { opc?: { getFilePath?: (f: File) => string } }).opc;
  const p = bridge?.getFilePath?.(file);
  return p || file.name;
}

function iconOf(kind: AttachmentKind) {
  if (kind === 'image') return ImageIcon;
  if (kind === 'video') return FileVideo;
  if (kind === 'folder') return FolderOpen;
  return FileText;
}

// 权限模式配置
const PERMISSION_MODE_CONFIG: Record<PermissionMode, { 
  label: string; 
  shortLabel: string;
  icon: React.ReactNode; 
  color: string;
  description: string;
}> = {
  'default': { 
    label: '默认模式', 
    shortLabel: '默认',
    icon: <LockOnIcon />, 
    color: '#1f1f1f',
    description: '每次操作都需要确认'
  },
  'acceptEdits': { 
    label: '自动编辑', 
    shortLabel: '自动编辑',
    icon: <EditIcon />, 
    color: '#2ba471',
    description: '自动允许文件编辑操作'
  },
  'plan': {
    // 文案与 shared/scenarios.ts 的 PERMISSION_MODE_LABEL 保持一致：
    // 权限缺口提示会引用这个词（「当前权限模式『只读』…」），两边措辞不同会让用户
    // 在提示里看到一个选择器里找不到的名字。verify:permission 有断言守着。
    label: '只读',
    shortLabel: '只读',
    icon: <TaskIcon />,
    color: '#ed7b2f',
    description: '只生成计划，不执行操作'
  },
  'bypassPermissions': {
    // 同上：与 PERMISSION_MODE_LABEL 对齐（「全放行」）
    label: '全放行',
    shortLabel: '全放行',
    icon: <LockOffIcon />,
    color: '#e34d59',
    description: '跳过所有权限确认（危险）'
  },
};

export function ChatInput({
  inputValue,
  selectedModel,
  models,
  isLoading,
  permissionMode,
  reasoningEffort = '',
  onReasoningEffortChange,
  onSend,
  onStop,
  onChange,
  onModelChange,
  onPermissionModeChange,
  mentionMembers,
  mentionHint,
  permissionGap,
  imageMode = false,
  imageSize,
  imageModel,
  onImageSizeChange,
  onImageModelChange,
  onAddModel,
}: ChatInputProps) {
  const chatSenderRef = useRef<any>(null);

  const isGroup = !!mentionMembers;

  /**
   * A62：当前选中模型的思考强度档位表。
   *
   * 三条派生规则，全都是为了「不摆假控件」：
   * 1. 只认**当前选中的那个模型**（切模型就得重新判，不能拿上一个模型的档位表
   *    给新模型用 —— 跨模型的档位值不通用）；
   * 2. `models` 为空（模型由 Agent 决定）或群聊（没有单一模型）时一律 undefined；
   * 3. 档位表为空数组也算没有。
   *
   * 返回 undefined 时下面那颗下拉整个不渲染 —— 没有档位信息的模型
   * 不给用户一个选了也没用的选择器。
   */
  const reasoningOfSelectedModel =
    !isGroup && selectedModel
      ? models.find(m => m.modelId === selectedModel)?.reasoning
      : undefined;
  const reasoningLevels =
    reasoningOfSelectedModel && reasoningOfSelectedModel.levels.length > 0
      ? reasoningOfSelectedModel.levels
      : null;
  /**
   * 下拉的展示值。档位表里没有的值一律显示成「默认」——
   * 宁可显示成未设置，也不显示一个其实不在表里的档位（那是谎报）。
   */
  const reasoningActiveLabel = reasoningEffort
    ? (reasoningLevels?.find(l => l.value === reasoningEffort)?.label ?? null)
    : null;

  /** 当前展开的下拉（见 OpenSelect 注释：五个弹层互斥） */
  const [openSelect, setOpenSelect] = useState<OpenSelect | null>(null);

  /**
   * A73：模型选择浮层的触发器几何（视口坐标）。
   *
   * 之所以也存坐标而不只存布尔值：浮层要 portal 到 body 并贴在触发器上方，
   * 而触发器的位置只有点下去那一刻的 `getBoundingClientRect()` 知道 ——
   * 窗口缩放、输入区长高之后布尔值就指向了错的地方。
   */
  const [modelAnchor, setModelAnchor] = useState<{ left: number; top: number; width: number } | null>(
    null
  );

  /* ── 附件（A35）── */
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /**
   * 附件菜单。存的是**视口坐标**而不是布尔值 —— 菜单要 portal 到 body，
   * 原因见下面 attachMenu 的渲染处（ChatSender 里点不动）。
   */
  const [attachMenu, setAttachMenu] = useState<{ left: number; bottom: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const attachBoxRef = useRef<HTMLDivElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);

  // 点外面收起附件菜单（与 GroupMemberPanel 的邀请面板同一手法）。
  // 菜单已 portal 到 body，不在 attachBoxRef 里，所以要单独判一次。
  useEffect(() => {
    if (!attachMenu) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (attachBoxRef.current?.contains(t)) return;
      if (attachMenuRef.current?.contains(t)) return;
      setAttachMenu(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [attachMenu]);

  const addAttachments = useCallback((files: FileList | null, fromDir = false) => {
    if (!files || files.length === 0) return;
    const picked: Attachment[] = [];

    if (fromDir) {
      const first = files[0] as File & { webkitRelativePath?: string };
      const full = filePathOf(first);
      const rel = first.webkitRelativePath || '';
      // 相对路径有几段，目录就在完整路径上往前退几段
      const relDepth = rel ? rel.split('/').length : 1;
      const sep = full.includes('\\') ? '\\' : '/';
      const parts = full.split(/[\\/]/);
      const folderPath =
        parts.length > relDepth ? parts.slice(0, parts.length - relDepth).join(sep) : full;
      const name = rel ? rel.split('/')[0] : parts[parts.length - 1] || '文件夹';
      let total = 0;
      for (let i = 0; i < files.length; i++) total += files[i].size;
      picked.push({ path: folderPath, name, size: total, kind: 'folder' });
    } else {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        picked.push({ path: filePathOf(f), name: f.name, size: f.size, kind: kindOf(f) });
      }
    }

    setAttachments(prev => {
      const seen = new Set(prev.map(a => a.path));
      const merged = [...prev];
      for (const a of picked) {
        if (merged.length >= MAX_ATTACHMENTS) break;
        if (seen.has(a.path)) continue;
        seen.add(a.path);
        merged.push(a);
      }
      return merged;
    });
  }, []);

  /* ── A93：粘贴剪贴板里的图片 ──
   *
   * 附件链路传的是**路径**（见 withAttachments：消息正文里拼 `- <绝对路径>`），
   * 而剪贴板图片只有一个 Blob、没有路径 —— 所以先交给主进程落成临时文件，
   * 再当普通附件挂上（`opc:save-pasted-image`，见 electron/main.ts）。
   *
   * 三件必须做对的事：
   *  1. **只在真有图片时才 preventDefault**。纯文字粘贴必须保持浏览器默认行为，
   *     否则用户在输入框里粘贴一段文字会没反应。
   *  2. 监听挂在 `t-chat-sender` 宿主上而不是 React 的 onPaste —— 输入框在
   *     两层 shadow 里，paste 是 composed 事件，冒泡到宿主最稳（与附件菜单
   *     绕开宿主拦截的思路一致）。
   *  3. 失败要说话。落盘失败（非桌面端 / 超限 / 写盘失败）时给一行提示，
   *     否则用户会以为「粘贴没反应」，然后反复粘同一张图。 */
  const [pasteNote, setPasteNote] = useState<string | null>(null);

  useEffect(() => {
    if (!pasteNote) return;
    const t = window.setTimeout(() => setPasteNote(null), 4000);
    return () => window.clearTimeout(t);
  }, [pasteNote]);

  const pasteImages = useCallback(async (files: File[]) => {
    const bridge = (
      window as unknown as {
        opc?: { savePastedImage?: (bytes: Uint8Array, ext: string) => Promise<string | null> };
      }
    ).opc;
    if (!bridge?.savePastedImage) {
      setPasteNote('当前环境不支持粘贴图片，请用左侧附件按钮选择文件');
      return;
    }

    const picked: Attachment[] = [];
    for (const f of files) {
      if (picked.length >= MAX_ATTACHMENTS) break;
      // image/jpeg → jpg；其余按子类型直接当扩展名，主进程另有白名单
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      let path: string | null = null;
      try {
        path = await bridge.savePastedImage(new Uint8Array(await f.arrayBuffer()), ext);
      } catch {
        path = null;
      }
      if (!path) {
        setPasteNote('这张图片没能保存，请改用附件按钮');
        continue;
      }
      picked.push({
        path,
        name: f.name && f.name !== 'image.png' ? f.name : `粘贴图片.${ext}`,
        size: f.size,
        kind: 'image',
      });
    }
    if (picked.length === 0) return;

    setAttachments(prev => {
      const seen = new Set(prev.map(a => a.path));
      const merged = [...prev];
      for (const a of picked) {
        if (merged.length >= MAX_ATTACHMENTS) break;
        if (seen.has(a.path)) continue;
        seen.add(a.path);
        merged.push(a);
      }
      return merged;
    });
  }, []);

  useEffect(() => {
    const el = chatSenderRef.current as HTMLElement | null;
    if (!el?.addEventListener) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const it of Array.from(items)) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      // 没有图片 → 不拦，纯文字粘贴走默认行为
      if (files.length === 0) return;
      e.preventDefault();
      void pasteImages(files);
    };
    el.addEventListener('paste', onPaste);
    return () => el.removeEventListener('paste', onPaste);
  }, [pasteImages]);

  // A93：输入框字号 16px → 15px（与正文 md_p 一致）。
  // 为什么只能这么做、为什么 CSS 的三条路都不通，见 src/senderTextarea.ts。
  useEffect(() => applySenderTypography(), []);

  /** 把附件路径拼进消息正文：Agent 拿到的是可直接读的绝对路径 */
  const withAttachments = useCallback(
    (text: string) => {
      if (attachments.length === 0) return text;
      const lines = attachments.map(a => `- ${a.path}`).join('\n');
      return `${text || '请查看以下附件'}\n\n[附件]\n${lines}`;
    },
    [attachments]
  );

  /**
   * 是否必须选中模型才能发送。
   * 只有当该 Agent 确实提供模型列表时才成立；自管模型的 Agent（models 为空）
   * 不应因为没有 selectedModel 就被禁言。群聊同理：没有单一模型可选。
   * 生图模式也不适用 —— 它压根不用文本模型。
   */
  const modelRequired = !isGroup && !imageMode && models.length > 0;

  /**
   * 匹配「@某个成员」的正则工厂。
   *
   * 名字和 id 都认 —— 后端 `extractMentioned` 两者都认，前端的高亮/取消
   * 也必须一致，否则「用 id @ 过一次」的文本点不掉。
   */
  const mentionRe = (member: { id: string; name: string }, flags = 'i') => {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 名字与 id 相同时只留一个分支，避免 `(?:a|a)` 这种无意义的分组
    const alts = member.id === member.name ? [member.name] : [member.name, member.id];
    return new RegExp(`@\\s*(?:${alts.map(esc).join('|')})(?![\\w-])`, flags);
  };

  /**
   * 点成员 chip：**已 @ 就取消，没 @ 就插入**。
   *
   * ## 为什么必须能取消
   *
   * 早先只能插入，点错了只能回到输入框里手动删那几个字符 —— 而 chip 本身
   * 是高亮的，看起来就像个开关（按下去了要能弹起来）。用户点第二下没有
   * 任何反应，只会以为按钮坏了。
   *
   * ## 插入为什么追加到末尾
   *
   * ChatSender 的 textarea 在 shadow DOM 里，拿不到可靠的光标位置，硬插会
   * 把文字打到用户预料之外的地方。追加是可预期的，且后端只做正则匹配、
   * 不关心位置。
   *
   * ## 删除时的空白处理
   *
   * 只删 `@名字` 会在中间留下两个连续空格（`甲 @乙 丙` → `甲  丙`）。
   * 顺手把 `@名字` 后面那个空格一起吃掉，再把连续空格并成一个。
   */
  const toggleMention = useCallback(
    (member: { id: string; name: string }) => {
      if (mentionRe(member).test(inputValue)) {
        const stripped = inputValue
          .replace(mentionRe(member, 'gi'), ' ')
          .replace(/[ \t]{2,}/g, ' ')
          .trim();
        onChange(stripped);
        return;
      }
      const at = `@${member.name} `;
      const base = inputValue.length && !inputValue.endsWith(' ') ? `${inputValue} ` : inputValue;
      onChange(`${base}${at}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inputValue, onChange]
  );

  const handleSend = useCallback((e: any) => {
    const content = e?.detail?.message || e?.detail || e?.message || inputValue;
    const text = (typeof content === 'string' && content.trim()) || inputValue.trim();
    // A35：只挂了附件、没写正文时也要能发出去
    const hasSomething = !!text || attachments.length > 0;
    if (hasSomething && (!modelRequired || selectedModel)) {
      onSend(withAttachments(text));
      setAttachments([]);
    }
  }, [inputValue, selectedModel, modelRequired, onSend, attachments, withAttachments]);

  const handleChange = useCallback((e: any) => {
    const value = e?.detail ?? e ?? '';
    onChange(typeof value === 'string' ? value : '');
  }, [onChange]);

  const currentModeConfig = PERMISSION_MODE_CONFIG[permissionMode];

  const selectedModelName = models.find(m => m.modelId === selectedModel)?.name || '选择模型';

  return (
    <div
      className="px-4 pb-6 pt-4"
      style={{
        backgroundColor: 'var(--tc-surface-content)'
      }}
    >
      <div className="max-w-3xl mx-auto">
        {/*
          群聊成员条。
          放在发送器**上方**而不是塞进 footer-prefix：成员是「这次要 @ 谁」，
          属于内容前置信息，和「权限模式」这种会话级设置不是一层。
          成员多时允许换行，不滚动 —— 换行是可预期的，横向滚动会藏人。
        */}
        {isGroup && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
              @ 成员
            </span>
            {mentionMembers!.map(m => {
              // 已提过的成员高亮：告诉用户「这个人已经被叫上了」。
              // 后端 extractMentioned 同时认 id 和展示名，这里也必须都认，
              // 否则用户 @hermes 之后 chips 不高亮，会以为没生效。
              const used = mentionRe(m).test(inputValue);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggleMention(m)}
                  // title 随状态变：点下去会发生什么，直接写在提示里。
                  // （打靶脚本改用 data-mention-name 定位，不依赖这句文案。）
                  title={used ? `取消 @ ${m.name}` : `在输入框中 @ ${m.name}`}
                  aria-pressed={used}
                  data-mention-name={m.name}
                  className="flex items-center gap-1 rounded-full px-2 py-[3px] text-caption transition-opacity hover:opacity-80"
                  style={{
                    backgroundColor: used ? 'var(--td-brand-color-light)' : 'var(--td-bg-color-secondarycontainer)',
                    color: used ? 'var(--td-brand-color)' : 'var(--td-text-color-secondary)',
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: used ? 'var(--td-brand-color)' : 'var(--td-text-color-placeholder)' }}
                  />
                  {m.name}
                </button>
              );
            })}
          </div>
        )}

        {/* 权限强制缺口：与底部的权限模式选择器同屏（生图模式没有权限选择器，不显示） */}
        {!imageMode && (
          <PermissionGapNotice message={permissionGap} testId="live-permission-gap" />
        )}

        {isGroup && mentionHint && (
          <div
            className="mb-2 rounded-lg px-2.5 py-1.5 text-caption"
            style={{
              backgroundColor: 'var(--td-bg-color-secondarycontainer)',
              color: 'var(--td-text-color-secondary)',
            }}
          >
            {mentionHint}
          </div>
        )}

        {/* 粘贴失败提示（A93）：只在落盘失败时出现，4 秒后自己消失 */}
        {pasteNote && (
          <div
            className="mb-2 rounded-lg px-2.5 py-1.5 text-caption"
            style={{
              backgroundColor: 'var(--td-bg-color-secondarycontainer)',
              color: 'var(--td-text-color-secondary)',
            }}
            data-paste-note
          >
            {pasteNote}
          </div>
        )}

        {/* 附件条（A35）：与 @ 成员条同一层 —— 都是「这次发什么」的前置信息 */}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5" data-attachments>
            {attachments.map(a => {
              const Icon = iconOf(a.kind);
              return (
                <span
                  key={a.path}
                  title={a.path}
                  data-attachment={a.path}
                  data-attachment-kind={a.kind}
                  className="flex max-w-[260px] items-center gap-1.5 rounded-lg px-2 py-1 text-caption"
                  style={{
                    backgroundColor: 'var(--td-bg-color-secondarycontainer)',
                    color: 'var(--td-text-color-secondary)',
                  }}
                >
                  <Icon size={12} className="shrink-0" />
                  <span className="min-w-0 truncate">{a.name}</span>
                  {a.size > 0 && (
                    <span className="shrink-0 tabular-nums opacity-60">{formatSize(a.size)}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setAttachments(prev => prev.filter(x => x.path !== a.path))}
                    title="移除附件"
                    aria-label={`移除附件 ${a.name}`}
                    className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--tc-hover-chrome)]"
                  >
                    <X size={10} />
                  </button>
                </span>
              );
            })}
            <button
              type="button"
              onClick={() => setAttachments([])}
              className="text-caption underline-offset-2 hover:underline"
              style={{ color: 'var(--td-text-color-placeholder)' }}
              data-attach-clear
            >
              清空
            </button>
          </div>
        )}

        <ChatSender
          ref={chatSenderRef}
          value={inputValue}
          placeholder={imageMode ? '描述你想生成的图像...' : '输入消息...'}
          disabled={modelRequired && !selectedModel}
          loading={isLoading}
          autosize={{ minRows: 1, maxRows: 6 }}
          actions={['send']}
          onSend={handleSend}
          onStop={onStop}
          onChange={handleChange}
        >
          {/* 模型选择器和权限模式选择器放在 footer-prefix 插槽 */}
          <div slot="footer-prefix" className="flex flex-wrap items-center gap-2">
            {/* 附件（A35）：放在最左 —— 与 IM 里「+」的位置一致，先选东西再打字 */}
            <div ref={attachBoxRef} className="relative">
              <button
                type="button"
                /* 用 pointerdown 而不是 click 打开菜单：ChatSender 的宿主会在
                   pointerdown 上做处理（实测兼容性 mouse 事件被拦掉，slotted
                   按钮收不到 click）。pointerdown 一定先到，用它最稳。 */
                onPointerDown={e => {
                  // 别把焦点从输入框抢走 —— 用户接着还要打字
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  setAttachMenu(prev =>
                    prev ? null : { left: r.left, bottom: window.innerHeight - r.top + 6 }
                  );
                }}
                onKeyDown={e => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  setAttachMenu(prev =>
                    prev ? null : { left: r.left, bottom: window.innerHeight - r.top + 6 }
                  );
                }}
                title="添加附件"
                aria-label="添加附件"
                aria-expanded={!!attachMenu}
                aria-haspopup="menu"
                data-attach-toggle
                data-has-attachment={attachments.length ? '1' : '0'}
                /* A75：底色不再写内联 —— 内联 backgroundColor 的优先级高于
                   Tailwind 的 hover:bg-[...]，会把悬停反馈整个压死（这颗按钮
                   实测 hover 完全没有变化）。两态都交给 index.css 里
                   [data-attach-toggle] 那组规则，组件只负责打标记。 */
                className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
                style={{
                  color: attachments.length
                    ? 'var(--td-brand-color)'
                    : 'var(--td-text-color-secondary)',
                }}
              >
                <Paperclip size={15} />
              </button>

              {/* 菜单 portal 到 body：留在 ChatSender 的 slot 里点不动
                  （同上，宿主把兼容性 mouse 事件吃掉了），而且浮层本来也
                  不该被输入区的圆角裁切。 */}
              {attachMenu &&
                createPortal(
                  <div
                    ref={attachMenuRef}
                    role="menu"
                    className="tc-glass fixed z-[60] w-[184px] overflow-hidden rounded-lg py-1 shadow-popup"
                    style={{
                      left: attachMenu.left,
                      bottom: attachMenu.bottom,
                      border: '1px solid var(--td-component-stroke)',
                    }}
                    data-attach-menu
                  >
                    <button
                      type="button"
                      role="menuitem"
                      data-attach-kind="file"
                      onClick={() => {
                        setAttachMenu(null);
                        fileInputRef.current?.click();
                      }}
                      className={MENU_ITEM_SM_CLASS}
                      style={{ color: 'var(--td-text-color-primary)' }}
                    >
                      <FileUp size={14} style={{ color: 'var(--td-text-color-secondary)' }} />
                      图片 / 文档 / 视频
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-attach-kind="folder"
                      onClick={() => {
                        setAttachMenu(null);
                        dirInputRef.current?.click();
                      }}
                      className={MENU_ITEM_SM_CLASS}
                      style={{ color: 'var(--td-text-color-primary)' }}
                    >
                      <FolderOpen size={14} style={{ color: 'var(--td-text-color-secondary)' }} />
                      文件夹
                    </button>
                  </div>,
                  document.body
                )}

              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.json,.csv,.log,.zip"
                onChange={e => {
                  addAttachments(e.target.files);
                  e.target.value = '';
                }}
                data-attach-input="file"
              />
              <input
                ref={dirInputRef}
                type="file"
                multiple
                hidden
                // webkitdirectory 不在 React 的 input 类型里，只能绕过类型检查；
                // 它是 Chromium 的标准属性，Electron 里可用。
                {...({ webkitdirectory: '' } as Record<string, string>)}
                onChange={e => {
                  addAttachments(e.target.files, true);
                  e.target.value = '';
                }}
                data-attach-input="folder"
              />
            </div>

            <div
              className="h-5 w-px rounded-full"
              style={{ backgroundColor: 'var(--td-component-stroke)' }}
            />

            {imageMode ? (
              <>
                {/* 生图模型：默认 CogView-3-Flash（本机实测唯一免费可用） */}
                <Select
                  value={imageModel}
                  onChange={(value) => onImageModelChange?.(value as string)}
                  placeholder="生图模型"
                  size="medium"
                  style={{ width: 190 }}
                  suffixIcon={<ChevronDownIcon />}
                  popupVisible={openSelect === 'imageModel'}
                  onPopupVisibleChange={v => setOpenSelect(v ? 'imageModel' : null)}
                  popupProps={{
                    overlayClassName: 'image-model-select-popup',
                    overlayInnerStyle: { width: 250, padding: '6px 4px' },
                  }}
                >
                  {IMAGE_MODELS.map(m => (
                    <Select.Option key={m.id} value={m.id} label={m.name}>
                      <div className="flex flex-col py-0.5">
                        <span className="text-body font-medium leading-5">{m.name}</span>
                        {m.note && (
                          <span
                            className="text-caption leading-4 truncate"
                            style={{ color: 'var(--td-text-color-secondary)' }}
                          >
                            {m.note}
                          </span>
                        )}
                      </div>
                    </Select.Option>
                  ))}
                </Select>

                {/* 分隔线 */}
                <div
                  className="h-5 w-px rounded-full"
                  style={{ backgroundColor: 'var(--td-component-stroke)' }}
                />

                {/* 尺寸：方形 / 横版 / 竖版对成图构图影响很大，必须可选 */}
                <Select
                  value={imageSize}
                  onChange={(value) => onImageSizeChange?.(value as string)}
                  placeholder="尺寸"
                  size="medium"
                  style={{ width: 170 }}
                  suffixIcon={<ChevronDownIcon />}
                  popupVisible={openSelect === 'imageSize'}
                  onPopupVisibleChange={v => setOpenSelect(v ? 'imageSize' : null)}
                  popupProps={{
                    overlayClassName: 'image-size-select-popup',
                    overlayInnerStyle: { width: 200, padding: '6px 4px' },
                  }}
                >
                  {IMAGE_SIZES.map(s => (
                    <Select.Option key={s} value={s} label={IMAGE_SIZE_LABELS[s] || s} />
                  ))}
                </Select>
              </>
            ) : (
              <>
            {/*
              模型选择器。
              注意：models 为空表示「该 Agent 自己管模型」——hermes 用自己
              配置里的默认模型，opencode 之外有些 ACP Agent 也不上报列表。
              这时不能把发送键也禁掉（否则 agent 明明在线却发不出消息），
              改成显示一个不可点的说明徽标，诚实地告诉用户模型由 Agent 决定。
            */}
            {models.length > 0 ? (
              /* A73：换成自绘触发器 + ModelSelectPopup。
                 原来是 TDesign <Select>，做不出截图里的标题栏、底部通栏和行内 ✓，
                 详见 ModelSelectPopup 文件头。 */
              <>
                <button
                  type="button"
                  data-model-trigger
                  aria-haspopup="dialog"
                  aria-expanded={openSelect === 'model'}
                  title={selectedModelName}
                  onPointerDown={e => {
                    // 别抢输入框焦点 —— 用户接着还要打字
                    e.preventDefault();
                    if (openSelect === 'model') {
                      setOpenSelect(null);
                      setModelAnchor(null);
                      return;
                    }
                    const r = e.currentTarget.getBoundingClientRect();
                    setOpenSelect('model');
                    setModelAnchor({ left: r.left, top: r.top, width: r.width });
                  }}
                  onKeyDown={e => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    setOpenSelect('model');
                    setModelAnchor({ left: r.left, top: r.top, width: r.width });
                  }}
                  /* A74：字号从 text-caption(11px) 提到 text-body(13px)，与
                     右侧两颗 Select 触发器、以及各自浮层里的选项行统一。
                     三颗芯片同高 32 / 同圆角 8 / 同字号，差别只在内容。
                     A75：底色交给 `.opc-chip`（见 index.css）—— 原来写的是
                     Tailwind 的 hover:bg-[...]，非 important，被 TDesign 的
                     `.t-select .t-input--medium` 一族压过去，于是三颗芯片里
                     只有这颗 hover 不亮、展开后也不亮，并排一眼能看出来。 */
                  className="opc-chip flex h-8 w-[140px] items-center justify-between gap-1 rounded-lg px-2 text-body"
                  style={{
                    color: selectedModel
                      ? 'var(--td-text-color-primary)'
                      : 'var(--td-text-color-placeholder)',
                  }}
                >
                  <span className="truncate">{selectedModelName}</span>
                  {/* A74：箭头用二级色，与右侧两颗 Select 的箭头同色
                      （原来继承正文色，比它们黑一档，并排时一眼看出是两套） */}
                  <ChevronDownIcon style={{ color: 'var(--td-text-color-secondary)' }} />
                </button>
                {openSelect === 'model' && modelAnchor && (
                  <ModelSelectPopup
                    models={models}
                    value={selectedModel}
                    onChange={v => {
                      onModelChange(v);
                      setOpenSelect(null);
                      setModelAnchor(null);
                    }}
                    onClose={() => {
                      setOpenSelect(null);
                      setModelAnchor(null);
                    }}
                    onAddModel={() => {
                      setOpenSelect(null);
                      setModelAnchor(null);
                      onAddModel?.();
                    }}
                    anchor={modelAnchor}
                  />
                )}
              </>
            ) : (
              <span
                className="flex items-center rounded-lg px-2.5 py-1.5 text-caption"
                style={{
                  backgroundColor: 'var(--td-bg-color-secondarycontainer)',
                  color: 'var(--td-text-color-placeholder)',
                }}
                title="该 Agent 自行决定使用哪个模型"
              >
                模型由 Agent 决定
              </span>
            )}
            
            {/* 分隔线 */}
            <div
              className="h-5 w-px rounded-full"
              style={{ backgroundColor: 'var(--td-component-stroke)' }}
            />

            {/*
              A62：思考强度选择器。**只在当前模型真有档位表时出现**。

              放在模型选择器与权限模式之间：它跟模型是 1:1 的关系
              （换模型就得重新判），跟权限模式是同一类「这一轮怎么跑」的开关。

              第一项「默认」= 不显式传参、用 CLI 自己的默认（等价 config.toml
              里那一行）。它不是"第 0 档"，而是一个独立的语义 —— 所以单独列出来，
              不把 defaultLevel 塞进档位列表里（那会让用户以为它和一档一样可选、
              一样会被显式传给 CLI）。
            */}
            {reasoningLevels && (
              <div data-reasoning-select>
                <Tooltip
                  content={
                    reasoningOfSelectedModel?.defaultLevel
                      ? `该模型默认：${reasoningLevels.find(l => l.value === reasoningOfSelectedModel.defaultLevel)?.label ?? reasoningOfSelectedModel.defaultLevel}`
                      : '默认 = 用 CLI 自己的默认档位'
                  }
                  placement="top"
                >
                  <Select
                    borderless
                    className="opc-chip-select"
                    value={reasoningEffort}
                    onChange={(value) => onReasoningEffortChange?.(value as string)}
                    size="medium"
                    style={{ width: 100 }}
                    suffixIcon={<ChevronDownIcon />}
                    popupVisible={openSelect === 'reasoning'}
                    onPopupVisibleChange={v => setOpenSelect(v ? 'reasoning' : null)}
                    prefixIcon={<Brain size={16} />}
                    popupProps={{
                      overlayClassName: 'opc-choice-popup reasoning-select-popup',
                      overlayInnerStyle: { width: 180, padding: '6px 4px' }
                    }}
                  >
                    <Select.Option value="" label="默认">
                      <div className="flex items-center gap-2 py-0.5">
                        <span className="text-body leading-5">默认</span>
                        <span
                          className="text-caption leading-4"
                          style={{ color: 'var(--td-text-color-placeholder)' }}
                        >
                          用 CLI 自己的档位
                        </span>
                      </div>
                    </Select.Option>
                    {reasoningLevels.map(level => (
                      <Select.Option
                        key={level.value}
                        value={level.value}
                        label={level.label}
                      >
                        <div className="flex w-full min-w-0 flex-col py-0.5">
                          <span className="text-body leading-5">{level.label}</span>
                          {level.description && (
                            <span
                              className="text-caption leading-4 truncate"
                              style={{ color: 'var(--td-text-color-secondary)' }}
                            >
                              {level.description}
                            </span>
                          )}
                        </div>
                      </Select.Option>
                    ))}
                  </Select>
                </Tooltip>
              </div>
            )}

            {/* 权限模式选择器（外层壳带 data 属性，供 UI 测试定位；布局不变 —— 壳就是这一行的 flex 子项） */}
            <div data-permission-mode-select>
              <Tooltip content={currentModeConfig.description} placement="top">
                <Select
                  borderless
                  className="opc-chip-select"
                  value={permissionMode}
                  onChange={(value) => onPermissionModeChange(value as PermissionMode)}
                  size="medium"
                  style={{ width: 112 }}
                  suffixIcon={<ChevronDownIcon />}
                  popupVisible={openSelect === 'permission'}
                  onPopupVisibleChange={v => setOpenSelect(v ? 'permission' : null)}
                  prefixIcon={
                    /* A84（用户要求）：图标外不要再套一块 `${color}15` 的浅色圆角方块。
                       那块底本来是想「给图标一个容器」，实际效果是图标本体（同色、
                       14px、细描边）和同色低透明度的底糊在一起，越看越脏。
                       去掉底以后彩色图标直接压在输入框底色上，颜色饱和度反而
                       把「默认 / 自动编辑 / 只读 / 全放行」四档区分得更清楚。 */
                    <span
                      className="flex items-center justify-center w-5 h-5"
                      style={{ color: currentModeConfig.color }}
                    >
                      {currentModeConfig.icon}
                    </span>
                  }
                  popupProps={{
                    overlayClassName: 'opc-choice-popup permission-select-popup',
                    overlayInnerStyle: { width: 160, padding: '6px 4px' }
                  }}
                >
                  {(Object.keys(PERMISSION_MODE_CONFIG) as PermissionMode[]).map(mode => {
                    const config = PERMISSION_MODE_CONFIG[mode];
                    return (
                      <Select.Option 
                        key={mode} 
                        value={mode} 
                        label={config.shortLabel}
                      >
                        <div className="flex items-center gap-2 py-0.5">
                          {/* A84：同 prefixIcon，去掉 `${color}15` 方块，只留彩色图标 */}
                          <span
                            className="flex items-center justify-center w-5 h-5 shrink-0"
                            style={{ color: config.color }}
                          >
                            {config.icon}
                          </span>
                          <span className="text-body leading-5">{config.shortLabel}</span>
                        </div>
                      </Select.Option>
                    );
                  })}
                </Select>
              </Tooltip>
            </div>
              </>
            )}
          </div>
        </ChatSender>
      </div>
    </div>
  );
}
