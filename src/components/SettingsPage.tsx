import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import { 
  Form, 
  Input, 
  Textarea, 
  Button, 
  Tooltip,
  Popconfirm,
  MessagePlugin,
  Loading,
  Link,
  Tag,
  Select,
  Switch
} from 'tdesign-react';
import { 
  AddIcon, 
  EditIcon, 
  DeleteIcon,
  CheckIcon,
  CheckCircleFilledIcon,
  CloseCircleFilledIcon,
  RefreshIcon
} from 'tdesign-icons-react';
import { Bot, Sparkles, Code, FileText, Globe, Lightbulb, Monitor, Sun, Moon, KeyRound, X, Brain, ShieldAlert, Layers } from 'lucide-react';
import { PanelHeader } from './PanelHeader';
import { HintTip } from './HintTip';
import { AgentCredentialSettings } from './AgentCredentialSettings';
import { ModelCatalogSettings } from './ModelCatalogSettings';
import { MemoryPanel } from './MemoryPanel';
import { PermissionRulesPanel } from './PermissionRulesPanel';
import { CustomAgent, PermissionMode, ThemePreference } from '../types';
import {
  TRANSPARENCY_DEFAULT,
  TRANSPARENCY_MAX,
  TRANSPARENCY_MIN,
  readTransparency,
  saveTransparency,
  GLOW_SIZE_MIN,
  GLOW_SIZE_MAX,
  GLOW_BRIGHT_MIN,
  GLOW_BRIGHT_MAX,
  GLOW_BRIGHT_DEFAULT,
  readGlow,
  saveGlow,
  currentGlowSize,
  themeGlowSize,
  type GlowPrefs,
} from '../uiPrefs';

interface SettingsPageProps {
  agents: CustomAgent[];
  onAdd: (agent: Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'>) => CustomAgent;
  onUpdate: (id: string, updates: Partial<Omit<CustomAgent, 'id' | 'createdAt'>>) => void;
  onDelete: (id: string) => void;
  /** 当前主题偏好（跟随系统 / 浅色 / 深色） */
  themePreference: ThemePreference;
  onThemePreferenceChange: (next: ThemePreference) => void;
  /**
   * Agent 凭据保存/清除后触发。
   *
   * 后端在保存时会立刻重探该 Agent，但名册数据在前端是**另一份**状态，
   * 不重新拉一次的话，通讯录里那个 Agent 还挂着「未登录」——用户会以为
   * 保存没生效。由 App 传 `registry.load` 进来。
   */
  onCredentialsSaved?: () => void;
  /**
   * 模型清单刷新成功后触发。
   *
   * 与 `onCredentialsSaved` 是两回事：那边刷的是「名册/登录态」，这边刷的是
   * 「模型菜单」。模型列表在 App 里是独立的一份 state（按 currentAgentId 拉），
   * 不通知它重取的话，用户点完刷新、关掉设置，菜单还是旧的 —— 那这个按钮
   * 就只是个安慰剂。
   */
  onModelsRefreshed?: () => void;
  /** 单栏（窄屏）模式下返回列表；宽屏不传 */
  onBack?: () => void;
  /**
   * A37：关闭设置弹窗。
   *
   * 设置页从「整页路由」改成「覆盖在会话之上的弹窗」之后，出口就从
   * PanelHeader 的返回键换成了右上角的关闭键 —— 弹窗必须有一个明确的
   * 「我完事了」的按钮，不能只靠点遮罩（那是次要出口）。
   */
  onClose?: () => void;
}

/** 主题偏好的三选一。文案要说清「跟随系统」和「固定」的区别，否则用户
 *  分不清前两栏到底会不会随系统变。 */
const THEME_OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  hint: string;
  Icon: typeof Monitor;
}> = [
  { value: 'system', label: '跟随系统', hint: '跟着 Windows 的深浅色设置走', Icon: Monitor },
  { value: 'light', label: '浅色', hint: '固定浅色', Icon: Sun },
  { value: 'dark', label: '深色', hint: '固定深色', Icon: Moon },
];

type LoginMethod = 'env' | 'cli' | 'none';

/**
 * A28：设置页从「一长条」改成「分区」。
 *
 * 之前三个分区（外观 / 登录配置 / Agent 配置）首尾相连堆在同一页里，
 * 加起来近 600 行高，找一个设置要从头滚到尾。现在左侧一条分区导航 +
 * 右侧只渲染当前分区 —— 一次只面对一组设置。
 *
 * ⚠️ 三个 key 是硬编码的三块内容，不是从数据生成的：它们各自依赖不同的
 * 后端数据（登录状态 / agents 列表），抽成数据驱动只会把条件渲染藏得更深。
 */
type SettingsSectionKey = 'memory' | 'permission' | 'appearance' | 'login' | 'models' | 'agents';

const SETTINGS_SECTIONS: Array<{
  key: SettingsSectionKey;
  label: string;
  hint: string;
  Icon: typeof Monitor;
}> = [
  { key: 'memory', label: '记忆', hint: '跨会话记忆、用户画像与沉淀的技能', Icon: Brain },
  { key: 'permission', label: '权限门禁', hint: '危险命令分类与自定义规则', Icon: ShieldAlert },
  { key: 'appearance', label: '外观', hint: '主题、界面透明度、鼠标光斑', Icon: Monitor },
  { key: 'login', label: '登录配置', hint: 'API Key 或命令行登录', Icon: KeyRound },
  { key: 'models', label: '模型清单', hint: '枚举来源与手动刷新', Icon: Layers },
  { key: 'agents', label: '自定义 Agent', hint: '本地提示词与工具权限', Icon: Bot },
];

interface LoginStatus {
  isLoggedIn: boolean;
  checking: boolean;
  method?: LoginMethod;
  envConfigured?: boolean;
  cliConfigured?: boolean;
  error?: string;
  apiKey?: string;
  envVars?: {
    apiKey?: string;
    authToken?: string;
    internetEnv?: string;
    baseUrl?: string;
  };
}

const PRESET_ICONS = [
  { name: 'Bot', icon: Bot },
  { name: 'Sparkles', icon: Sparkles },
  { name: 'Code', icon: Code },
  { name: 'FileText', icon: FileText },
  { name: 'Globe', icon: Globe },
  { name: 'Lightbulb', icon: Lightbulb },
];

// 预设色板 —— 全部取自腾讯调色板。
// 原先混入了 Material Design 的 #a25eb5 / #5c6bc0 / #26a69a，
// 与相邻的腾讯蓝/绿放在一排时明显是两个体系，故统一替换为
// 腾讯紫 #834EC2、腾讯靛 #4B5EAA、腾讯青 #0E7A5F（与"擅长领域"标签同源）。
const PRESET_COLORS = [
  '#1f1f1f', '#5f5e5a', '#00a870', '#ed7b2f',
  '#e34d59', '#834ec2', '#b0479e', '#0e7a8c',
];

const PERMISSION_MODES: { value: PermissionMode; label: string; description: string }[] = [
  { value: 'default', label: 'default', description: '默认模式，所有操作需确认' },
  { value: 'acceptEdits', label: 'acceptEdits', description: '自动批准文件编辑，Bash 仍需确认' },
  { value: 'plan', label: 'plan', description: '规划模式，仅允许读取操作' },
  { value: 'bypassPermissions', label: 'bypassPermissions', description: '跳过所有权限检查（谨慎使用）' },
];

const PRESET_TEMPLATES = [
  {
    name: '代码助手',
    description: '专注于编程和代码相关任务',
    systemPrompt: '你是一个专业的编程助手。你擅长编写、审查和解释代码。请提供清晰、高效且符合最佳实践的代码解决方案。在解释时，请考虑代码的可读性、性能和可维护性。',
    icon: 'Code',
    color: '#0e7a8c',
  },
  {
    name: '写作助手',
    description: '帮助撰写和优化各类文档',
    systemPrompt: '你是一个专业的写作助手。你擅长撰写、编辑和优化各类文档，包括文章、报告、邮件等。请帮助用户提升文字表达的清晰度、逻辑性和吸引力。',
    icon: 'FileText',
    color: '#00a870',
  },
  {
    name: '翻译助手',
    description: '提供高质量的多语言翻译',
    systemPrompt: '你是一个专业的翻译助手。你精通多种语言，能够提供准确、自然、符合语境的翻译。请在翻译时保持原文的语气和风格，同时确保目标语言的地道表达。',
    icon: 'Globe',
    color: '#ed7b2f',
  },
  {
    name: '创意助手',
    description: '激发灵感，提供创意建议',
    systemPrompt: '你是一个富有创意的助手。你善于头脑风暴、提供创新想法和独特视角。请帮助用户突破思维定式，探索新的可能性，激发创造力。',
    icon: 'Lightbulb',
    color: '#834ec2',
  },
];

export function SettingsPage({ 
  agents, 
  onAdd, 
  onUpdate, 
  onDelete,
  themePreference,
  onThemePreferenceChange,
  onCredentialsSaved,
  onModelsRefreshed,
  onBack,
  onClose
}: SettingsPageProps) {
  const [editingAgent, setEditingAgent] = useState<CustomAgent | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    systemPrompt: '',
    icon: 'Bot',
    color: '#1f1f1f',
    permissionMode: 'default' as PermissionMode,
  });
  
  // 登录状态
  const [loginStatus, setLoginStatus] = useState<LoginStatus>({
    isLoggedIn: false,
    checking: true,
  });
  
  // 环境变量配置
  const [showEnvConfig, setShowEnvConfig] = useState(false);
  const [envConfig, setEnvConfig] = useState({
    apiKey: '',
    authToken: '',
    internetEnv: '' as '' | 'internal' | 'iOA',
    baseUrl: '',
  });
  const [savingEnv, setSavingEnv] = useState(false);

  // 检查登录状态
  const checkLoginStatus = useCallback(async () => {
    setLoginStatus(prev => ({ ...prev, checking: true, error: undefined }));
    
    try {
      const response = await fetch('/api/check-login');
      const data = await response.json();
      
      setLoginStatus({
        isLoggedIn: data.isLoggedIn,
        checking: false,
        method: data.method,
        envConfigured: data.envConfigured,
        cliConfigured: data.cliConfigured,
        error: data.error,
        apiKey: data.apiKey,
        envVars: data.envVars,
      });
    } catch (error: any) {
      setLoginStatus({
        isLoggedIn: false,
        checking: false,
        error: error?.message || '检查登录状态失败',
      });
    }
  }, []);
  
  // 保存环境变量配置
  const saveEnvConfig = async () => {
    // 至少需要配置一个有效的值
    const hasAnyConfig = envConfig.apiKey.trim() || envConfig.authToken.trim();
    if (!hasAnyConfig) {
      MessagePlugin.warning('请至少配置 API Key 或 Auth Token');
      return;
    }
    
    setSavingEnv(true);
    try {
      const response = await fetch('/api/save-env-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: envConfig.apiKey.trim() || undefined,
          authToken: envConfig.authToken.trim() || undefined,
          internetEnv: envConfig.internetEnv || undefined,
          baseUrl: envConfig.baseUrl.trim() || undefined,
        }),
      });
      
      const data = await response.json();
      
      if (data.success) {
        MessagePlugin.success(data.message);
        setShowEnvConfig(false);
        setEnvConfig({ apiKey: '', authToken: '', internetEnv: '', baseUrl: '' });
        // 重新检查登录状态
        checkLoginStatus();
      } else {
        MessagePlugin.error(data.error || '保存失败');
      }
    } catch (error: any) {
      MessagePlugin.error(error?.message || '保存失败');
    } finally {
      setSavingEnv(false);
    }
  };

  // 初始化时检查登录状态
  useEffect(() => {
    checkLoginStatus();
  }, [checkLoginStatus]);

  /**
   * 从「获取」卡片跳过来时定位到那条凭据行（A71）。
   *
   * 入口是 `/settings?agent=doubao`。凭据列表是异步拉的，所以这里轮询找元素
   * （最多 2 秒），找到就滚到中间并展开那一行 —— 只把用户送到设置页、
   * 让他自己在几行里找，等于把「快捷」丢掉一半。
   *
   * 找不到就什么都不做：**不弹「找不到」的提示**。用户看到的仍是一个正常的
   * 设置页，而不是一条莫名其妙报错。
   */
  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get('agent');
    if (!target) return;
    let tries = 0;
    let timer: number | undefined;
    const tryFind = () => {
      const row = document.querySelector<HTMLElement>(`[data-credential-row="${target}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const toggle = row.querySelector<HTMLElement>(`[data-credential-toggle="${target}"]`);
        if (toggle && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
        return;
      }
      if (tries++ < 20) timer = window.setTimeout(tryFind, 100);
    };
    timer = window.setTimeout(tryFind, 120);
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  /**
   * A73：从模型选择浮层的「添加模型」跳过来时，直接落到「模型清单」这一节。
   *
   * 入口是 `/settings?section=models`。设置页默认停在「外观」，
   * 用户得自己在左侧六节里找 —— 那一下就把「快捷」丢光了。
   *
   * 与上面的 `?agent=` 是两件独立的事：一个切节，一个在节内定位某一行。
   * 同时带两个参数时两条都会跑，互不干扰。
   */
  useEffect(() => {
    const sec = new URLSearchParams(window.location.search).get('section');
    if (sec !== 'models') return;
    setSection('models');
  }, []);

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      systemPrompt: '',
      icon: 'Bot',
      color: '#1f1f1f',
      permissionMode: 'default',
    });
    setEditingAgent(null);
    setIsCreating(false);
  };

  const handleEdit = (agent: CustomAgent) => {
    if (agent.id === 'default') return;
    setEditingAgent(agent);
    setFormData({
      name: agent.name,
      description: agent.description || '',
      systemPrompt: agent.systemPrompt,
      icon: agent.icon || 'Bot',
      color: agent.color || '#1f1f1f',
      permissionMode: agent.permissionMode || 'default',
    });
    setIsCreating(true);
  };

  const handleSave = () => {
    if (!formData.name.trim() || !formData.systemPrompt.trim()) {
      MessagePlugin.warning('请填写名称和系统提示词');
      return;
    }

    if (editingAgent) {
      onUpdate(editingAgent.id, formData);
      MessagePlugin.success('Agent 已更新');
    } else {
      onAdd(formData);
      MessagePlugin.success('Agent 已创建');
    }
    resetForm();
  };

  const handleUseTemplate = (template: typeof PRESET_TEMPLATES[0]) => {
    setFormData({
      ...template,
      description: template.description,
      // 模板里没有权限模式，沿用用户当前的选择，别把他刚改过的值重置掉
      permissionMode: formData.permissionMode,
    });
    setIsCreating(true);
  };

  const handleDelete = (id: string) => {
    onDelete(id);
    MessagePlugin.success('Agent 已删除');
  };

  const getIconComponent = (iconName: string) => {
    const preset = PRESET_ICONS.find(p => p.name === iconName);
    return preset ? preset.icon : Bot;
  };

  const customAgents = agents.filter(a => a.id !== 'default');

  // A28：当前所在分区。默认外观 —— 它是唯一「一进来就该看到」的一组，
  // 且不依赖任何后端数据（登录检查还在转圈时主题已经能改）。
  const [section, setSection] = useState<SettingsSectionKey>('appearance');

  return (
    <div
      className="flex min-w-0 flex-1 flex-col"
      style={{ backgroundColor: 'var(--tc-surface-content)' }}
    >
      {/* 标题栏统一由 PanelHeader 提供，与通讯录、会话头部同一套规范。
          此前这里是自己写的 h1 + text-2xl（24px），比别处大 50%，
          且没有 header 容器与底边线，是全应用最显眼的标题栏不一致。 */}
      <PanelHeader
        title="设置"
        // A37：**不再传副标题**。用户要求「取消组件内的小字」——
        // 分区副标题（「主题、界面透明度、鼠标光斑」）与左侧导航里那行小字
        // 是同一句话说了两遍，而且它描述的正是下面三个分区按钮的内容，
        // 属于「导航能自解释」的重复信息。
        onBack={onBack}
        backLabel="返回"
        // 双行标题栏：操作区跟标题行对齐，不跟着整条 84px 居中
        // （否则 × 会落在「设置」下方约 10px，看着像没对齐）。
        actionsAlign="title"
        actions={
          onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-[var(--tc-hover-chrome)]"
              style={{ color: 'var(--td-text-color-secondary)' }}
              aria-label="关闭设置"
              data-settings-close
            >
              <X size={16} />
            </button>
          ) : undefined
        }
      />

      <div className="flex min-h-0 flex-1">
        {/* 左侧分区导航。宽屏才占位，窄屏换成下面那条横向滚动条 ——
            mp 宽度下再切一条竖栏会把内容挤成一拃宽。 */}
        <nav
          className="hidden w-[168px] shrink-0 flex-col gap-1 overflow-y-auto border-r py-4 pl-4 pr-2 sm:flex"
          style={{ borderColor: 'var(--tc-divider)' }}
          aria-label="设置分区"
        >
          {SETTINGS_SECTIONS.map(({ key, label, hint, Icon }) => {
            const active = section === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSection(key)}
                aria-current={active ? 'page' : undefined}
                // A37：每一项下面那行灰色小字去掉了（用户要求「取消组件内的小字」）。
                // 信息没有丢 —— 挂到 title 上，悬停仍能看到这一区管什么；
                // 常驻显示时它只是把三个按钮各撑高一行，读起来像目录。
                title={hint}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors"
                style={{
                  backgroundColor: active ? 'var(--td-brand-color-light)' : 'transparent',
                  color: active ? 'var(--td-brand-color)' : 'var(--td-text-color-secondary)',
                }}
                data-settings-section={key}
              >
                <Icon size={16} className="shrink-0" />
                <span className="text-sm font-medium">{label}</span>
              </button>
            );
          })}
        </nav>

        {/* 窄屏：分区变成横向滚动的药丸。只显示标签不显示 hint ——
            一屏要放三个，hint 会把每个药丸撑到两行。 */}
        <div
          className="scrollbar-none flex shrink-0 gap-2 overflow-x-auto border-b px-4 py-2 sm:hidden"
          style={{ borderColor: 'var(--tc-divider)' }}
        >
          {SETTINGS_SECTIONS.map(({ key, label, Icon }) => {
            const active = section === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSection(key)}
                aria-current={active ? 'page' : undefined}
                className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-caption transition-colors"
                style={{
                  backgroundColor: active ? 'var(--td-brand-color-light)' : 'var(--td-bg-color-component)',
                  color: active ? 'var(--td-brand-color)' : 'var(--td-text-color-secondary)',
                }}
              >
                <Icon size={14} />
                {label}
              </button>
            );
          })}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto max-w-3xl space-y-8" data-settings-panel={section}>

        {/* ── 记忆（A38）────────────────────────────────────────
            导航里排第一，但**默认落点仍是外观**：一是指定默认分区会让
            一批按「进来就该看到主题卡」断言的探针失效；二是「外观」确实是
            用户调得最频繁的那一项。要改默认只需要动上面的 useState。 */}
        {section === 'memory' && <MemoryPanel />}

        {/* ── 权限门禁（A40）────────────────────────────────────
            紧挨着「记忆」：两者都是「跨会话的行为配置」，区别是
            记忆喂给模型，门禁管着模型**能不能动手**。 */}
        {section === 'permission' && <PermissionRulesPanel />}

        {/* ── 外观 ────────────────────────────────────────────────
            放在最前面：它是唯一一个「一进来就该看到」的设置，
            而且不依赖任何后端数据 —— 就算登录检查还在转圈，
            用户也已经能把界面调成自己喜欢的深浅色。 */}
        {section === 'appearance' && (
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
              外观
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {THEME_OPTIONS.map(({ value, label, hint, Icon }) => {
              const selected = themePreference === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => onThemePreferenceChange(value)}
                  aria-pressed={selected}
                  // A37：给探针一个稳定锚点。原先脚本按「固定浅色」这句说明文字
                  // 定位按钮，而那行字本轮被删掉了 —— 用 data 属性定位不再受文案影响。
                  data-theme-option={value}
                  // A37：按钮里的灰色小字（「跟着 Windows 的深浅色设置走」等）
                  // 去掉 —— 三个按钮的标签本身已经说清了全部意思，
                  // 那行字只是把「跟随系统」四个字又解释了一遍。
                  // 需要时悬停仍能看到（title）。
                  title={hint}
                  className="flex items-center gap-3 rounded-lg p-3 text-left transition-all"
                  style={{
                    // 选中态用品牌色描边 + 淡底，不用实心填充：
                    // 三张卡片并排，填实心会让视觉重心全压在被选中的那张上。
                    backgroundColor: selected ? 'var(--td-brand-color-light)' : 'var(--td-bg-color-component)',
                    // A37：描边 1.5px → 1px（用户要求「选中按钮后的描边调整细一些」）。
                    // 1.5px 在 100% 不透明时像一圈实线，1px 才是「选中提示」的分量。
                    border: `1px solid ${selected ? 'var(--td-brand-color)' : 'transparent'}`,
                  }}
                >
                  {/* A26：选中态的小图标块不再用品牌色实心。
                      36×36 的纯色块在 100% 透明度下就是玻璃上的一颗黑点 ——
                      面积不大，但因为是整张卡片里唯一的高对比色，比大块的白卡还跳。
                      改成按 --opc-t 从「实心 + 反色图标」插值到「淡底 + 品牌色图标」，
                      t=0 时与原来完全一致。逻辑见 index.css 的 .tc-chip-brand。 */}
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${selected ? 'tc-chip-brand' : ''}`}
                    style={
                      selected
                        ? undefined
                        : {
                            backgroundColor: 'var(--td-bg-color-container)',
                            color: 'var(--td-text-color-secondary)',
                          }
                    }
                  >
                    <Icon size={18} />
                  </span>
                  <span
                    className="min-w-0 text-body-lg font-medium"
                    style={{ color: 'var(--td-text-color-primary)' }}
                  >
                    {label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* A35：三个滑杆 + 一个统一的「恢复默认」。
              原来这里是 <TransparencySlider /> 与 <GlowSettings /> 各写一行，
              两个组件各自管自己的复位入口（透明度靠双击、光斑靠一颗小链接），
              用户找不到「一起还原」的办法。 */}
          <AppearanceSliders />
        </div>
        )}

        {/* ── 登录配置 ──────────────────────────────────────────── */}
        {section === 'login' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 
                className="text-lg font-medium"
                style={{ color: 'var(--td-text-color-primary)' }}
              >
                登录配置
              </h2>
            </div>
            <Button 
              variant="text" 
              icon={<RefreshIcon />}
              onClick={checkLoginStatus}
              loading={loginStatus.checking}
            >
              刷新
            </Button>
          </div>
          
          {/* 当前状态 */}
          <div className="flex items-center gap-3 mb-6">
            {loginStatus.checking ? (
              <>
                <Loading size="small" />
                <span style={{ color: 'var(--td-text-color-secondary)' }}>
                  正在检查登录状态...
                </span>
              </>
            ) : loginStatus.isLoggedIn ? (
              <>
                <CheckCircleFilledIcon 
                  size="20px" 
                  style={{ color: 'var(--td-success-color)' }} 
                />
                <span style={{ color: 'var(--td-text-color-primary)' }}>
                  已登录
                </span>
                <Tag size="small" variant="outline">
                  {loginStatus.method === 'env' ? '环境变量' : 'CLI'}
                </Tag>
                {loginStatus.method === 'env' && loginStatus.apiKey && (
                  <span 
                    className="text-sm font-mono"
                    style={{ color: 'var(--td-text-color-secondary)' }}
                  >
                    {loginStatus.apiKey}
                  </span>
                )}
              </>
            ) : (
              <>
                <CloseCircleFilledIcon 
                  size="20px" 
                  style={{ color: 'var(--td-text-color-placeholder)' }} 
                />
                <span style={{ color: 'var(--td-text-color-secondary)' }}>
                  未登录
                </span>
              </>
            )}
          </div>
          
          {/* 环境变量配置 */}
          <div className="mb-6">
            <h3 
              className="text-sm font-medium mb-3"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              方式一：环境变量
            </h3>
            
            {showEnvConfig ? (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label 
                      className="text-xs block mb-1"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                    >
                      CODEBUDDY_API_KEY
                    </label>
                    <Input
                      type="password"
                      size="small"
                      value={envConfig.apiKey}
                      onChange={(v) => setEnvConfig(prev => ({ ...prev, apiKey: v as string }))}
                      placeholder="API 密钥（推荐）"
                    />
                  </div>
                  <div>
                    <label 
                      className="text-xs block mb-1"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                    >
                      CODEBUDDY_AUTH_TOKEN
                    </label>
                    <Input
                      type="password"
                      size="small"
                      value={envConfig.authToken}
                      onChange={(v) => setEnvConfig(prev => ({ ...prev, authToken: v as string }))}
                      placeholder="认证令牌"
                    />
                  </div>
                  <div>
                    <label 
                      className="text-xs block mb-1"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                    >
                      CODEBUDDY_INTERNET_ENVIRONMENT
                    </label>
                    <Select
                      size="small"
                      value={envConfig.internetEnv}
                      onChange={(v) => setEnvConfig(prev => ({ ...prev, internetEnv: v as any }))}
                      placeholder="网络环境（可选）"
                      clearable
                      options={[
                        { label: 'internal', value: 'internal' },
                        { label: 'iOA', value: 'iOA' },
                      ]}
                    />
                  </div>
                  <div>
                    <label 
                      className="text-xs block mb-1"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                    >
                      CODEBUDDY_BASE_URL
                    </label>
                    <Input
                      size="small"
                      value={envConfig.baseUrl}
                      onChange={(v) => setEnvConfig(prev => ({ ...prev, baseUrl: v as string }))}
                      placeholder="自定义 URL（可选）"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button 
                    size="small"
                    theme="primary" 
                    onClick={saveEnvConfig}
                    loading={savingEnv}
                  >
                    保存
                  </Button>
                  <Button 
                    size="small"
                    variant="text" 
                    onClick={() => {
                      setShowEnvConfig(false);
                      setEnvConfig({ apiKey: '', authToken: '', internetEnv: '', baseUrl: '' });
                    }}
                  >
                    取消
                  </Button>
                  <span 
                    className="text-xs"
                    style={{ color: 'var(--td-text-color-placeholder)' }}
                  >
                    仅当前进程有效
                  </span>
                </div>
              </div>
            ) : (
              <Button 
                variant="outline" 
                size="small"
                onClick={() => setShowEnvConfig(true)}
              >
                配置环境变量
              </Button>
            )}
          </div>
          
          {/* CLI 登录 */}
          <div>
            <h3 
              className="text-sm font-medium mb-3"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              方式二：CodeBuddy CLI
            </h3>
            <div className="flex items-center gap-3">
              <code 
                className="px-3 py-1.5 rounded text-sm"
                style={{ 
                  backgroundColor: 'var(--td-bg-color-component)',
                  color: 'var(--td-text-color-primary)'
                }}
              >
                codebuddy
              </code>
              <Link 
                href="https://www.codebuddy.ai/docs/zh/cli/settings" 
                target="_blank"
                theme="primary"
                size="small"
              >
                查看文档
              </Link>
            </div>
          </div>
          
          {loginStatus.error && !loginStatus.isLoggedIn && (
            <div 
              className="text-xs mt-4"
              style={{ color: 'var(--td-text-color-placeholder)' }}
            >
              {loginStatus.error}
            </div>
          )}

          {/* ── Agent API Key（A30）─────────────────────────────────
              上面两节管的是 WorkBuddy（CodeBuddy SDK）。豆包 / Gemini / Kimi
              走的是各自的 Key，之前**只能靠进程环境变量** —— 打包版用户
              根本没有「设置环境变量」这个动作，于是名册上永远是「未登录」。
              这一节把那条路补上：填完即落盘、即重探。 */}
          <div className="mt-8" data-agent-credentials-section>
            <h3
              className="mb-3 flex items-center gap-1.5 text-sm font-medium"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              方式三：Agent API Key
              <HintTip
                label="Agent API Key 说明"
                text="豆包 / Gemini / Kimi 等按 Key 计费的 Agent 在这里填写，保存后立即生效。"
              />
            </h3>
            <AgentCredentialSettings onSaved={onCredentialsSaved} />
          </div>
        </div>
        )}

        {/* ── 模型清单 ────────────────────────────────────────────
            模型菜单是运行时枚举出来的（CLI / SDK），缓存 24 小时。这一节把
            「枚举到几条、上次什么时候、从哪来」摆出来，并给一个手动刷新 ——
            否则用户碰到「官方上新了但菜单里没有」时完全没有抓手。 */}
        {section === 'models' && (
        <div>
          <div className="mb-4">
            <h2
              className="text-lg font-medium"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              模型清单
            </h2>
          </div>
          <ModelCatalogSettings onRefreshed={onModelsRefreshed} />
        </div>
        )}

        {/* ── 自定义 Agent ──────────────────────────────────────── */}
        {section === 'agents' && (
        <div>
          <div className="mb-4">
            <h2
              className="text-lg font-medium"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              Agent 配置
            </h2>
          </div>

          <div className="space-y-6">
              {/* 创建/编辑表单 */}
              {isCreating ? (
                <div 
                  className="p-5 rounded-xl border"
                  style={{ 
                    backgroundColor: 'var(--td-bg-color-container)',
                    borderColor: 'var(--td-component-border)'
                  }}
                >
                  <div className="space-y-4">
                    <div className="flex justify-between items-center mb-2">
                      <h4 className="text-base font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                        {editingAgent ? '编辑 Agent' : '创建新 Agent'}
                      </h4>
                      <Button variant="text" onClick={resetForm}>取消</Button>
                    </div>
                    
                    <Form labelAlign="top">
                      <Form.FormItem label="名称" requiredMark>
                        <Input 
                          value={formData.name}
                          onChange={(v) => setFormData(prev => ({ ...prev, name: v as string }))}
                          placeholder="例如：代码助手"
                        />
                      </Form.FormItem>
                      
                      <Form.FormItem label="描述">
                        <Input 
                          value={formData.description}
                          onChange={(v) => setFormData(prev => ({ ...prev, description: v as string }))}
                          placeholder="简短描述这个 Agent 的用途"
                        />
                      </Form.FormItem>
                      
                      <Form.FormItem label="图标和颜色">
                        <div className="flex gap-4">
                          <div className="flex gap-2">
                            {PRESET_ICONS.map(({ name, icon: Icon }) => (
                              <button
                                key={name}
                                type="button"
                                className="w-9 h-9 rounded-lg flex items-center justify-center transition-all border-2"
                                style={{
                                  backgroundColor: formData.icon === name ? formData.color : 'transparent',
                                  color: formData.icon === name ? 'white' : 'var(--td-text-color-secondary)',
                                  borderColor: formData.icon === name ? formData.color : 'var(--td-component-border)',
                                }}
                                onClick={() => setFormData(prev => ({ ...prev, icon: name }))}
                              >
                                <Icon size={18} />
                              </button>
                            ))}
                          </div>
                          <div className="flex gap-1.5 items-center">
                            {PRESET_COLORS.map(color => (
                              <button
                                key={color}
                                type="button"
                                className="w-7 h-7 rounded-full flex items-center justify-center transition-transform hover:scale-110"
                                style={{ backgroundColor: color }}
                                onClick={() => setFormData(prev => ({ ...prev, color }))}
                              >
                                {formData.color === color && <CheckIcon style={{ color: 'white' }} size="14px" />}
                              </button>
                            ))}
                          </div>
                        </div>
                      </Form.FormItem>
                      
                      <Form.FormItem label="权限模式">
                        <Select
                          value={formData.permissionMode}
                          onChange={(v) => setFormData(prev => ({ ...prev, permissionMode: v as PermissionMode }))}
                          style={{ width: '100%' }}
                        >
                          {PERMISSION_MODES.map(mode => (
                            <Select.Option key={mode.value} value={mode.value} label={mode.label}>
                              <div className="flex flex-col py-1">
                                <span className="font-mono text-sm" style={{ color: 'var(--td-success-color)' }}>
                                  {mode.label}
                                </span>
                                <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                                  {mode.description}
                                </span>
                              </div>
                            </Select.Option>
                          ))}
                        </Select>
                      </Form.FormItem>
                      
                      <Form.FormItem label="系统提示词" requiredMark>
                        <Textarea 
                          value={formData.systemPrompt}
                          onChange={(v) => setFormData(prev => ({ ...prev, systemPrompt: v as string }))}
                          placeholder="定义 Agent 的行为和能力..."
                          autosize={{ minRows: 4, maxRows: 8 }}
                        />
                      </Form.FormItem>
                    </Form>
                    
                    <div className="flex justify-end gap-2 pt-2">
                      <Button variant="outline" onClick={resetForm}>取消</Button>
                      <Button theme="primary" onClick={handleSave}>
                        {editingAgent ? '保存修改' : '创建 Agent'}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* 快速模板 */}
                  <div>
                    <h4 className="text-sm font-medium mb-3" style={{ color: 'var(--td-text-color-secondary)' }}>
                      快速创建
                    </h4>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {PRESET_TEMPLATES.map(template => {
                        const Icon = getIconComponent(template.icon);
                        return (
                          <div 
                            key={template.name} 
                            // A37：内置助手不再用彩色块（用户要求「不要彩色填充」）。
                            // 四个模板各一个高饱和色块，一屏看下来像四条色带，
                            // 而它们只是「快捷入口」—— 真正的身份色属于用户自己
                            // 创建的 Agent（下面「我的 Agent」里仍保留）。
                            title={template.description}
                            className="flex cursor-pointer items-center gap-3 rounded-lg p-3 transition-all hover:shadow-card"
                            style={{ backgroundColor: 'var(--td-bg-color-component)' }}
                            onClick={() => handleUseTemplate(template)}
                          >
                            <div
                              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                              style={{
                                backgroundColor: 'var(--td-bg-color-container)',
                                color: 'var(--td-text-color-secondary)',
                              }}
                            >
                              <Icon size={18} />
                            </div>
                            <span
                              className="min-w-0 flex-1 truncate font-medium"
                              style={{ color: 'var(--td-text-color-primary)' }}
                            >
                              {template.name}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* 自定义创建按钮。
                      A37：① 文案「从头创建 Agent」→「创建 Agent」；
                      ② `variant="dashed" + block` 是一条横贯整栏的虚线大框，
                      比上面的模板卡片还显眼 —— 它只是一个入口，不该抢主位；
                      改成和「配置环境变量」同规格的 outline 小按钮，左对齐。 */}
                  <div>
                    <Button
                      icon={<AddIcon />}
                      variant="outline"
                      size="small"
                      onClick={() => setIsCreating(true)}
                      data-create-agent
                    >
                      创建 Agent
                    </Button>
                  </div>

                  {/* 已有的自定义 Agent */}
                  {customAgents.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium mb-3" style={{ color: 'var(--td-text-color-secondary)' }}>
                        我的 Agent ({customAgents.length})
                      </h4>
                      <div className="space-y-2">
                        {customAgents.map(agent => {
                          const Icon = getIconComponent(agent.icon || 'Bot');
                          return (
                            <div 
                              key={agent.id} 
                              className="p-3 rounded-lg"
                              style={{ backgroundColor: 'var(--td-bg-color-component)' }}
                            >
                              <div className="flex items-center gap-3">
                                <div 
                                  className="tc-tile w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                                  style={{ '--tile': agent.color || '#1f1f1f' } as CSSProperties}
                                >
                                  <Icon size={20} />
                                </div>
                                {/* A37：名称下那行描述去掉了（用户要求「取消 agent 下方的小字」）。
                                    描述仍在 title 里，悬停可见 —— 列表要的是「一眼扫完」，
                                    每行多一行小字会把行高翻倍、扫读反而更慢。 */}
                                <div
                                  className="min-w-0 flex-1 truncate font-medium"
                                  style={{ color: 'var(--td-text-color-primary)' }}
                                  title={agent.description || agent.systemPrompt.slice(0, 50) + '...'}
                                >
                                  {agent.name}
                                </div>
                                <div className="flex gap-1">
                                  <Tooltip content="编辑">
                                    <Button 
                                      variant="text" 
                                      shape="circle" 
                                      size="small"
                                      icon={<EditIcon />}
                                      onClick={() => handleEdit(agent)}
                                    />
                                  </Tooltip>
                                  <Popconfirm
                                    content="确定删除这个 Agent 吗？"
                                    onConfirm={() => handleDelete(agent.id)}
                                  >
                                    <Tooltip content="删除">
                                      <Button 
                                        variant="text" 
                                        shape="circle" 
                                        size="small"
                                        icon={<DeleteIcon />}
                                      />
                                    </Tooltip>
                                  </Popconfirm>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 界面透明度滑动条。
 *
 * ## 一个数字，管整块界面
 *
 * 用户的原话是「要将标题栏和主内容纳入统一管理，不能只单独控制标题栏的
 * 透明度」。所以这里只暴露**一个**值：拖动它，标题条（含三个窗口按钮）、
 * 导航条、列表栏、内容区、各种浮层一起变（三个 CSS 变量由
 * `applyTransparency` 一次写入，见 `src/uiPrefs.ts`）。
 *
 * A23 时标题条还被排除在外（必须实色，否则和系统画的三个按钮差一块补丁）；
 * A24 把按钮改成自绘之后，这条例外没有了，滑动条的范围也从 0–45 放到
 * 0–100 —— 拉到底是一块纯毛玻璃（系统 acrylic），不是「窗口消失」。
 *
 * ## 为什么不用 TDesign 的 Slider
 *
 * 需要两个原生 range 给不了、TDesign 也不好摆的东西：
 *   1. **默认刻度**。轨道上要有一个钉在默认值处的短竖线，让用户知道
 *      「原来是多少」——这是用户明确提的要求（「滑动条上有默认节点」）。
 *   2. **自绘轨道**。原生 range 的 track 没法按当前值分段填色，只能
 *      在底下垫一层自己画的轨道，把 input 做成「只有滑块可见」。
 * 自己画 12 行 CSS 比给组件库打补丁更可控。
 *
 * ## A44（用户反馈）：不画圆形滑块
 *
 * 轨道上那颗圆点去掉了（`.tc-range--flat`，见 index.css）—— 现在靠
 * 「已选段到哪儿结束」读数。input 本身和 14px 的滑块都还在，只是透明，
 * 拖动命中区与两端 7px 的几何一律不变。
 *
 * 默认刻度下方原本写的是「默认 28%」，现在只写「默认」：刻度已经钉在
 * 那个位置上了，数字既多余又容易和右上角的实时值混淆。
 */
function TransparencySlider({ resetToken = 0 }: { resetToken?: number }) {
  const [value, setValue] = useState(readTransparency);
  /**
   * 拖动中：在滑块正上方浮出**精确数值**气泡（A35 用户反馈）。
   *
   * 标题行右侧本来就有 `{value}%`，但那是视线之外的一行小字 —— 手指按在
   * 滑块上拖动时，眼睛盯着的是滑块，不会抬头去读右上角。气泡跟着滑块走，
   * 拖到哪读到哪。
   */
  const [dragging, setDragging] = useState(false);

  /** A35：统一「恢复默认」—— 由 AppearanceSliders 发令牌，三个滑杆各自归位 */
  useEffect(() => {
    if (!resetToken) return;
    setValue(saveTransparency(TRANSPARENCY_DEFAULT));
  }, [resetToken]);

  // 玻璃不可用（浏览器开发态 / Win10 / Win11 21H2）时这条滑动条没有作用对象：
  // 表面色根本不会变半透明。与其让它看起来能用，不如禁用并说明原因。
  const glassOn = document.documentElement.dataset.opcGlass === '1';

  // 滑块中心在轨道上的位置：两端各留半个滑块（14px / 2 = 7px）
  const posOf = (v: number) =>
    `calc(7px + (100% - 14px) * ${(v - TRANSPARENCY_MIN) / (TRANSPARENCY_MAX - TRANSPARENCY_MIN)})`;

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="flex items-center gap-1.5">
          <span className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
            界面透明度
          </span>
          {/* A37：原来这里是三行说明文字，现在收进一个 i 图标。
              玻璃不可用时图标转警示色 —— 那时滑杆是禁用的，
              用户需要一个「为什么不能拖」的入口。 */}
          <HintTip
            label="界面透明度说明"
            warn={!glassOn}
            text={
              glassOn
                ? '数值越大，桌面透出来越明显。标题条、导航条、列表栏、内容区、消息气泡、输入框、卡片和弹窗一起生效；拉到 100% 只剩一层磨砂玻璃，文字仍然清晰。'
                : '当前系统不支持窗口玻璃（需要 Windows 11 22H2 及以上），此项暂不生效。'
            }
          />
        </span>
        <span className="text-sm tabular-nums" style={{ color: 'var(--td-text-color-secondary)' }}>
          {value}%
        </span>
      </div>

      {/* 几何：容器 22px 高；轨道压在 7~11px；滑块 14px 居中于 18px 的
          input（2~16px）；默认刻度在 18~22px —— 正好落在滑块下沿之外，
          所以默认值处也看得见。改任何一处尺寸都要重算这条链。 */}
      <div className="relative h-[22px]">
        {/* 轨道：底色 + 已选段 */}
        <div
          className="absolute inset-x-0 top-[7px] h-1 rounded-full"
          style={{ backgroundColor: 'var(--tc-hover-chrome)' }}
        />
        <div
          className="absolute left-0 top-[7px] h-1 rounded-full"
          style={{ width: posOf(value), backgroundColor: 'var(--td-brand-color)' }}
        />
        {/* 默认节点：钉在 28% 处的一小段竖线。
            放在**轨道下方**而不是轨道上 —— 默认值正好是滑块所在的位置，
            刻度画在轨道上会被滑块整个盖住，等于没有（第一版就是这么错的）。
            放在下面，任何取值下都看得见「原来在哪儿」。 */}
        <div
          className="pointer-events-none absolute bottom-0 w-0.5 -translate-x-1/2 rounded-full"
          style={{
            left: posOf(TRANSPARENCY_DEFAULT),
            height: 4,
            backgroundColor: 'var(--td-text-color-placeholder)',
          }}
          data-transparency-default
          aria-hidden
        />
        <input
          type="range"
          className="tc-range tc-range--flat absolute inset-x-0 top-0"
          min={TRANSPARENCY_MIN}
          max={TRANSPARENCY_MAX}
          step={1}
          value={value}
          disabled={!glassOn}
          aria-label="界面透明度"
          aria-valuetext={`${value}%`}
          onChange={e => {
            const next = saveTransparency(Number(e.target.value));
            setValue(next);
          }}
          // A35：拖动 / 键盘调值时浮出数值气泡
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onFocus={() => setDragging(true)}
          onBlur={() => setDragging(false)}
          // 双击复位到默认节点：拖到一个别扭的值之后有个「回去」的快捷方式
          onDoubleClick={() => setValue(saveTransparency(TRANSPARENCY_DEFAULT))}
        />
        {dragging && (
          <div className="tc-range-bubble" style={{ left: posOf(value) }} data-range-bubble="transparency">
            {value}%
          </div>
        )}
      </div>
      {/* 三个标签：两端钉在轨道两端，「默认」钉在**刻度**上。
          不能用 justify-between 摆三个 —— 它会把中间项放到整行正中（50%），
          而默认刻度在 28%，两者必然对不上（用户报的「28% 的文案位置在中间，
          不匹配」）。所以第三个标签用绝对定位 + 负半宽居中，left 复用
          轨道那套 posOf()，刻度挪了文案就跟着挪，不会各写一份公式。 */}
      <div className="relative mt-1 flex justify-between text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
        <span>不透明</span>
        <span>纯磨砂</span>
        <span
          className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
          style={{ left: posOf(TRANSPARENCY_DEFAULT) }}
          data-transparency-default-label
        >
          默认
        </span>
      </div>
    </div>
  );
}

/* ── 鼠标光斑（A28）────────────────────────────────────────────────
 *
 * 光斑本身是 A25 做的（`.tc-cursor-glow`，跟着鼠标走的一块玻璃反光）。
 * 这里补的是**用户控制**：开关 + 大小 + 亮度。三者都直接落到 CSS 变量
 * （见 uiPrefs.applyGlow），不经过 React 重渲染 —— 拖动时跟手，而且
 * 光斑这层不该被组件的渲染周期牵着走。
 *
 * ## 为什么关掉开关后连滑动条一起藏
 *
 * 亮度 0 与「关闭」在视觉上不是一回事：brightness 的倍率
 * 乘的是 backdrop-filter，倍率给到 0 时那层 backdrop 仍在，
 * 只是不再提亮 —— 元素还挂着、还在吃一次合成。关闭是 `display:none`，
 * 整层不参与渲染。所以开关优先，关了就不要再让用户调一个无效的参数。
 */
function GlowSettings({ resetToken = 0 }: { resetToken?: number }) {
  const [prefs, setPrefs] = useState<GlowPrefs>(readGlow);
  // size 为 null 表示「没动过，跟随主题」—— 这时显示的是主题自己的设计值
  // （浅色 440 / 深色 380），从计算样式读，避免在 JS 里再抄一份主题常量。
  const [sizeValue, setSizeValue] = useState(() => prefs.size ?? currentGlowSize());
  const [brightValue, setBrightValue] = useState(() => prefs.brightness ?? GLOW_BRIGHT_DEFAULT);

  const patch = (next: Partial<GlowPrefs>) => setPrefs(saveGlow({ ...prefs, ...next }));

  /**
   * A35：统一「恢复默认」。
   *
   * 令牌来自 AppearanceSliders（那个按钮现在同时管界面透明度与两个光斑参数）。
   * 这里只做自己那一份：把两个值清成 null，让 CSS 的主题设计值重新生效。
   * **开关不动** —— 用户关掉光斑是「我不想看见它」，不是一个需要被复位的参数。
   *
   * 用 `readGlow()` 而不是闭包里的 `prefs`：effect 只依赖 resetToken，
   * 闭包里的 prefs 可能是上一轮的（开关刚被切过就会读到旧值）。
   */
  useEffect(() => {
    if (!resetToken) return;
    setPrefs(saveGlow({ ...readGlow(), size: null, brightness: null }));
    setSizeValue(currentGlowSize());
    setBrightValue(GLOW_BRIGHT_DEFAULT);
  }, [resetToken]);

  /** 滑杆上的「默认刻度」位置：主题设计值，不随当前值移动 */
  const sizeDefault = themeGlowSize();

  return (
    <div className="mt-5 space-y-4">
      {/* 开关 */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
            鼠标光斑
          </span>
          <HintTip
            label="鼠标光斑说明"
            text="跟随光标移动的玻璃反光。默认关闭，想要玻璃质感时打开；录屏、演示或觉得晃眼就保持关闭。"
          />
        </div>
        <Switch
          value={prefs.enabled}
          onChange={v => patch({ enabled: !!v })}
          aria-label="鼠标光斑开关"
        />
      </div>

      {prefs.enabled && (
        <>
          <GlowRange
            label="光斑大小"
            value={sizeValue}
            min={GLOW_SIZE_MIN}
            max={GLOW_SIZE_MAX}
            unit="px"
            defaultValue={sizeDefault}
            hint={`「默认」刻度处是当前主题的设计值（${sizeDefault}px）；不调它就一直跟随主题`}
            onChange={n => {
              setSizeValue(n);
              patch({ size: n });
            }}
          />
          <GlowRange
            label="光斑亮度"
            value={brightValue}
            min={GLOW_BRIGHT_MIN}
            max={GLOW_BRIGHT_MAX}
            unit="%"
            defaultValue={GLOW_BRIGHT_DEFAULT}
            hint="「默认」刻度 100% 为设计值（深色主题的基准比浅色更亮）"
            onChange={n => {
              setBrightValue(n);
              patch({ brightness: n });
            }}
          />
        </>
      )}
    </div>
  );
}

/**
 * 外观区的三个滑杆 + 一个**统一**的「恢复默认」（A35）。
 *
 * 用户原话：「恢复默认按钮的控制要将界面透明度也纳入统一恢复默认管理」。
 *
 * 改前：透明度只能靠双击滑杆复位，而光斑那颗「恢复默认」只清光斑两个参数，
 * 还藏在 `prefs.enabled` 里面 —— 关掉光斑之后连按钮都看不见，用户没有任何
 * 入口把透明度调回去。
 *
 * 改后：按钮提到这一层，恒定可见；点击时把 `resetToken` 加一，两个子组件
 * 各自监听这个令牌并复位自己那份状态。为什么用令牌而不是把三个值提到父级：
 * 每个滑杆的状态都是「输入 + 立即落盘 + 写 CSS 变量」的闭环，提到父级会把
 * 三套互不相干的逻辑搅在一起，而令牌只是「现在该复位了」这一个信号。
 */
function AppearanceSliders() {
  const [resetToken, setResetToken] = useState(0);

  return (
    <>
      <TransparencySlider resetToken={resetToken} />
      <GlowSettings resetToken={resetToken} />

      <div className="mt-6 flex items-center justify-end gap-4">
        {/* A37：原来按钮左边还有一行「恢复默认会同时还原…」的说明。
            它是这一区最后一句常驻小字，去掉后整列只剩「标签 + 控件」；
            说明挂到按钮的 title 上，需要时悬停即见。 */}
        <button
          type="button"
          onClick={() => setResetToken(t => t + 1)}
          // data-glow-reset 保留：verify-a28 用它定位这颗按钮，断言的仍是
          // 「两个光斑内联值被清掉」。语义从「只重置光斑」扩成「统一重置」，
          // 那条断言依旧成立。
          data-glow-reset
          data-ui-prefs-reset
          title="同时还原界面透明度、光斑大小、光斑亮度（光斑开关保持不变）"
          className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)]"
          style={{
            color: 'var(--td-text-color-secondary)',
            border: '1px solid var(--td-component-stroke)',
          }}
        >
          <RefreshIcon size={13} />
          恢复默认
        </button>
      </div>
    </>
  );
}

/** 光斑的两档滑杆。与透明度滑杆同一条几何链（见 TransparencySlider 的注释）。 */
function GlowRange({
  label,
  value,
  min,
  max,
  unit,
  hint,
  defaultValue,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  hint?: string;
  /** 默认刻度落在哪个值上（A35）。不传就不画刻度 */
  defaultValue?: number;
  onChange: (n: number) => void;
}) {
  /** 与透明度滑杆同一套「滑块中心」几何：两端各留半个滑块（7px） */
  const posOf = (v: number) => `calc(7px + (100% - 14px) * ${(v - min) / (max - min)})`;
  /** 刻度容器本身已经 inset 7px，所以刻度用裸百分比就落在滑块中心 */
  const pctOf = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  /** 拖动中浮出的精确数值气泡（A35） */
  const [dragging, setDragging] = useState(false);

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="flex items-center gap-1.5">
          <span className="text-sm" style={{ color: 'var(--td-text-color-primary)' }}>
            {label}
          </span>
          {/* A37：`hint` 不再渲染成标签下方的小字，收进 i 图标 */}
          {hint && <HintTip label={`${label}说明`} text={hint} />}
        </span>
        <span className="text-caption tabular-nums" style={{ color: 'var(--td-text-color-secondary)' }}>
          {value}
          {unit}
        </span>
      </div>
      <div className="relative h-[16px]">
        <div
          className="absolute inset-x-0 top-[6px] h-1 rounded-full"
          style={{ backgroundColor: 'var(--tc-hover-chrome)' }}
        />
        <div
          className="absolute left-0 top-[6px] h-1 rounded-full"
          style={{ width: posOf(value), backgroundColor: 'var(--td-brand-color)' }}
        />
        {/* 默认刻度：钉在主题设计值处的一小段竖线，落在轨道下方。
            画在轨道上会被已选段吃掉 —— 取值正好等于默认值时，品牌色一直
            盖到刻度位置，那根线就看不见了（透明度滑杆第一版就是这么错的）。 */}
        {defaultValue !== undefined && (
          <div className="tc-range-ticks" style={{ height: 3 }}>
            <span
              className="tc-range-tick"
              style={{ left: pctOf(defaultValue), height: 3 }}
              title={`默认 ${defaultValue}${unit}`}
              data-range-tick={label}
            />
          </div>
        )}
        <input
          type="range"
          className="tc-range tc-range--flat absolute inset-x-0 top-0"
          min={min}
          max={max}
          step={1}
          value={value}
          aria-label={label}
          aria-valuetext={`${value}${unit}`}
          onChange={e => onChange(Number(e.target.value))}
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onFocus={() => setDragging(true)}
          onBlur={() => setDragging(false)}
        />
        {dragging && (
          <div
            className="tc-range-bubble"
            style={{ left: posOf(value) }}
            data-range-bubble={label}
          >
            {value}
            {unit}
          </div>
        )}
      </div>
      {/* A44（用户反馈）：默认刻度下方补一个「默认」字样。
          原先只有一根 3px 的短竖线，不解释就只是轨道上的一个杂点 ——
          用户看不出那是「默认值在这儿」。位置复用 posOf()，与刻度同源，
          刻度挪了文案跟着挪，不会各写一份公式。

          第一行那个 `invisible` 的占位是为了撑出行高：定位元素不占流，
          只留绝对定位的话这一行高度为 0，下一个滑杆会直接压上来。 */}
      {defaultValue !== undefined && (
        <div
          className="relative mt-1 text-caption"
          style={{ color: 'var(--td-text-color-placeholder)' }}
        >
          <span className="invisible" aria-hidden>
            默认
          </span>
          <span
            className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
            style={{ left: posOf(defaultValue) }}
            data-range-default-label={label}
          >
            默认
          </span>
        </div>
      )}
    </div>
  );
}
