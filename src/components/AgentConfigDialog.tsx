import { useState } from 'react';
import { 
  Dialog, 
  Form, 
  Input, 
  Textarea, 
  Button, 
  Card,
  Tooltip,
  Popconfirm,
  MessagePlugin
} from 'tdesign-react';
import { CustomAgent } from '../types';
import { useTranslation, type MessageKey } from '../i18n';
import { Bot, Sparkles, Code, FileText, Globe, Lightbulb, Plus, PencilLine, Trash2, Check } from 'lucide-react';

interface AgentConfigProps {
  visible: boolean;
  onClose: () => void;
  agents: CustomAgent[];
  onAdd: (agent: Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'>) => CustomAgent;
  onUpdate: (id: string, updates: Partial<Omit<CustomAgent, 'id' | 'createdAt'>>) => void;
  onDelete: (id: string) => void;
}

const PRESET_ICONS = [
  { name: 'Bot', icon: Bot },
  { name: 'Sparkles', icon: Sparkles },
  { name: 'Code', icon: Code },
  { name: 'FileText', icon: FileText },
  { name: 'Globe', icon: Globe },
  { name: 'Lightbulb', icon: Lightbulb },
];

// 预设色板 —— 与 SettingsPage 保持完全一致（腾讯调色板）
const PRESET_COLORS = [
  '#1f1f1f', '#5f5e5a', '#00a870', '#ed7b2f',
  '#e34d59', '#834ec2', '#b0479e', '#0e7a8c',
];

/* name/description/systemPrompt 是**写进会话的数据**（Agent 名与发给模型的提示词），
   不随界面语言翻译；卡片上显示的名称与说明才走 i18n 的 nameKey / descKey。
   systemPrompt 的语言应跟随「回答语言」设置，与界面语言无关，故保持中文原文。 */
type PresetTemplate = {
  name: string;
  nameKey: MessageKey;
  description: string;
  descKey: MessageKey;
  systemPrompt: string;
  icon: string;
  color: string;
};

const PRESET_TEMPLATES: PresetTemplate[] = [
  {
    name: '代码助手',
    nameKey: 'settings.agents.template.codeName',
    description: '专注于编程和代码相关任务',
    descKey: 'settings.agents.template.codeDesc',
    systemPrompt: '你是一个专业的编程助手。你擅长编写、审查和解释代码。请提供清晰、高效且符合最佳实践的代码解决方案。在解释时，请考虑代码的可读性、性能和可维护性。',
    icon: 'Code',
    color: '#0e7a8c',
  },
  {
    name: '写作助手',
    nameKey: 'settings.agents.template.writeName',
    description: '帮助撰写和优化各类文档',
    descKey: 'settings.agents.template.writeDesc',
    systemPrompt: '你是一个专业的写作助手。你擅长撰写、编辑和优化各类文档，包括文章、报告、邮件等。请帮助用户提升文字表达的清晰度、逻辑性和吸引力。',
    icon: 'FileText',
    color: '#00a870',
  },
  {
    name: '翻译助手',
    nameKey: 'settings.agents.template.translateName',
    description: '提供高质量的多语言翻译',
    descKey: 'settings.agents.template.translateDesc',
    systemPrompt: '你是一个专业的翻译助手。你精通多种语言，能够提供准确、自然、符合语境的翻译。请在翻译时保持原文的语气和风格，同时确保目标语言的地道表达。',
    icon: 'Globe',
    color: '#ed7b2f',
  },
  {
    name: '创意助手',
    nameKey: 'settings.agents.template.creativeName',
    description: '激发灵感，提供创意建议',
    descKey: 'settings.agents.template.creativeDesc',
    systemPrompt: '你是一个富有创意的助手。你善于头脑风暴、提供创新想法和独特视角。请帮助用户突破思维定式，探索新的可能性，激发创造力。',
    icon: 'Lightbulb',
    color: '#834ec2',
  },
];

export function AgentConfigDialog({ 
  visible, 
  onClose, 
  agents, 
  onAdd, 
  onUpdate, 
  onDelete 
}: AgentConfigProps) {
  const { t } = useTranslation();
  const [editingAgent, setEditingAgent] = useState<CustomAgent | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    systemPrompt: '',
    icon: 'Bot',
    color: '#1f1f1f',
  });

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      systemPrompt: '',
      icon: 'Bot',
      color: '#1f1f1f',
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
    });
    setIsCreating(true);
  };

  const handleSave = () => {
    if (!formData.name.trim() || !formData.systemPrompt.trim()) {
      MessagePlugin.warning(t('settings.agents.nameRequired'));
      return;
    }

    if (editingAgent) {
      onUpdate(editingAgent.id, formData);
      MessagePlugin.success(t('settings.agents.updated'));
    } else {
      onAdd(formData);
      MessagePlugin.success(t('settings.agents.created'));
    }
    resetForm();
  };

  const handleUseTemplate = (template: PresetTemplate) => {
    // 只取数据字段，别把 nameKey / descKey 一起塞进表单状态
    setFormData({
      name: template.name,
      description: template.description,
      systemPrompt: template.systemPrompt,
      icon: template.icon,
      color: template.color,
    });
    setIsCreating(true);
  };

  const handleDelete = (id: string) => {
    onDelete(id);
    MessagePlugin.success(t('settings.agents.deleted'));
  };

  const getIconComponent = (iconName: string) => {
    const preset = PRESET_ICONS.find(p => p.name === iconName);
    return preset ? preset.icon : Bot;
  };

  const customAgents = agents.filter(a => a.id !== 'default');

  return (
    <Dialog
      visible={visible}
      onClose={() => { resetForm(); onClose(); }}
      header={t('settings.agents.dialogTitle')}
      width={700}
      footer={null}
      closeOnOverlayClick={false}
    >
      <div className="space-y-6">
        {/* 创建/编辑表单 */}
        {isCreating ? (
          <Card bordered className="p-4">
            <div className="space-y-4">
              <div className="flex justify-between items-center mb-4">
                <h4 className="text-base font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                  {editingAgent ? t('settings.agents.editTitle') : t('settings.agents.createTitle')}
                </h4>
                <Button variant="text" onClick={resetForm}>{t('settings.common.cancel')}</Button>
              </div>
              
              <Form labelAlign="top">
                <Form.FormItem label={t('settings.agents.nameLabel')} requiredMark>
                  <Input 
                    value={formData.name}
                    onChange={(v) => setFormData(prev => ({ ...prev, name: v as string }))}
                    placeholder={t('settings.agents.namePlaceholder')}
                  />
                </Form.FormItem>
                
                <Form.FormItem label={t('settings.agents.descLabel')}>
                  <Input 
                    value={formData.description}
                    onChange={(v) => setFormData(prev => ({ ...prev, description: v as string }))}
                    placeholder={t('settings.agents.descPlaceholder')}
                  />
                </Form.FormItem>
                
                <Form.FormItem label={t('settings.agents.iconColorLabel')}>
                  <div className="flex gap-4">
                    <div className="flex gap-2">
                      {PRESET_ICONS.map(({ name, icon: Icon }) => (
                        <button
                          key={name}
                          type="button"
                          className="w-9 h-9 rounded-lg flex items-center justify-center transition-all"
                          style={{
                            backgroundColor: formData.icon === name ? formData.color : 'var(--td-bg-color-component)',
                            color: formData.icon === name ? 'white' : 'var(--td-text-color-secondary)',
                          }}
                          onClick={() => setFormData(prev => ({ ...prev, icon: name }))}
                        >
                          <Icon size={18} />
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-1">
                      {PRESET_COLORS.map(color => (
                        <button
                          key={color}
                          type="button"
                          className="w-6 h-6 rounded-full flex items-center justify-center"
                          style={{ backgroundColor: color }}
                          onClick={() => setFormData(prev => ({ ...prev, color }))}
                        >
                          {formData.color === color && <Check style={{ color: 'white' }} size={14} />}
                        </button>
                      ))}
                    </div>
                  </div>
                </Form.FormItem>
                
                <Form.FormItem label={t('settings.agents.systemPromptLabel')} requiredMark>
                  <Textarea 
                    value={formData.systemPrompt}
                    onChange={(v) => setFormData(prev => ({ ...prev, systemPrompt: v as string }))}
                    placeholder={t('settings.agents.systemPromptPlaceholder')}
                    autosize={{ minRows: 4, maxRows: 8 }}
                  />
                </Form.FormItem>
              </Form>
              
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={resetForm}>{t('settings.common.cancel')}</Button>
                <Button theme="primary" onClick={handleSave}>
                  {editingAgent ? t('settings.agents.saveChanges') : t('settings.agents.create')}
                </Button>
              </div>
            </div>
          </Card>
        ) : (
          <>
            {/* 快速模板 */}
            <div>
              <h4 className="text-sm font-medium mb-3" style={{ color: 'var(--td-text-color-secondary)' }}>
                {t('settings.agents.quickCreate')}
              </h4>
              <div className="grid grid-cols-2 gap-3">
                {PRESET_TEMPLATES.map(template => {
                  const Icon = getIconComponent(template.icon);
                  return (
                    // TDesign 的 Card 不转发 onClick（CardProps 里没有这个属性），
                    // 所以点击与键盘事件挂在外面这层 div 上，Card 只负责样式。
                    <div
                      key={template.name}
                      role="button"
                      tabIndex={0}
                      className="cursor-pointer rounded-lg"
                      onClick={() => handleUseTemplate(template)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleUseTemplate(template);
                        }
                      }}
                    >
                      <Card bordered hoverShadow className="transition-all">
                        <div className="flex items-center gap-3 p-2">
                          <div
                            className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                            style={{ backgroundColor: template.color }}
                          >
                            <Icon size={20} color="white" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate" style={{ color: 'var(--td-text-color-primary)' }}>
                              {t(template.nameKey)}
                            </div>
                            <div className="text-xs truncate" style={{ color: 'var(--td-text-color-placeholder)' }}>
                              {t(template.descKey)}
                            </div>
                          </div>
                        </div>
                      </Card>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 自定义创建按钮 */}
            <Button 
              icon={<Plus size={14} />}
              variant="dashed" 
              block 
              onClick={() => setIsCreating(true)}
            >
              {t('settings.agents.createFromScratch')}
            </Button>

            {/* 已有的自定义 Agent */}
            {customAgents.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-3" style={{ color: 'var(--td-text-color-secondary)' }}>
                  {t('settings.agents.myAgents', { n: customAgents.length })}
                </h4>
                <div className="space-y-2">
                  {customAgents.map(agent => {
                    const Icon = getIconComponent(agent.icon || 'Bot');
                    return (
                      <Card key={agent.id} bordered className="p-3">
                        <div className="flex items-center gap-3">
                          <div 
                            className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                            style={{ backgroundColor: agent.color || '#1f1f1f' }}
                          >
                            <Icon size={20} color="white" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                              {agent.name}
                            </div>
                            <div className="text-xs truncate" style={{ color: 'var(--td-text-color-placeholder)' }}>
                              {agent.description || agent.systemPrompt.slice(0, 50) + '...'}
                            </div>
                          </div>
                          <div className="flex gap-1">
                            <Tooltip content={t('settings.agents.editTooltip')}>
                              {/* A137：这里的 24 指**按钮**的 size="small"，不是 lucide 图标。
                                  图标按 A141 定档给 14：按钮本身 24，图标别再占满整行。
                                  别因为"看着小"就把按钮升 32：行内动作比行高还高会撑开每一行。 */}
                              <Button 
                                variant="text" 
                                shape="circle" 
                                size="small"
                                icon={<PencilLine size={14} />}
                                onClick={() => handleEdit(agent)}
                              />
                            </Tooltip>
                            <Popconfirm
                              content={t('settings.agents.deleteConfirm')}
                              onConfirm={() => handleDelete(agent.id)}
                            >
                              <Tooltip content={t('settings.agents.deleteTooltip')}>
                                <Button 
                                  variant="text" 
                                  shape="circle" 
                                  size="small"
                                  icon={<Trash2 size={14} />}
                                />
                              </Tooltip>
                            </Popconfirm>
                          </div>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
