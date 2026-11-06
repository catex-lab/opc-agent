import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Check, ChevronDown, type LucideIcon } from 'lucide-react';

/**
 * 设置页的枚举型自绘下拉。
 *
 * 为什么不用原生 `<select>`：展开后的菜单由操作系统绘制，CSS 完全无法
 * 控制其边框/圆角/阴影 —— 用户反馈「弹层边线太硬」在原生控件下无解。
 * 换成自绘面板后，边线、阴影、圆角才能走既有设计令牌。
 *
 * 代价是键盘与朗读语义要自己补齐，本组件按 WAI-ARIA「select-only combobox」
 * 实现：
 *   · 触发器 role=combobox + aria-expanded / aria-haspopup / aria-controls
 *   · 面板 role=listbox，选项 role=option + aria-selected（禁用项 aria-disabled）
 *   · 打开后焦点进面板，用 aria-activedescendant 指向高亮项
 *   · Enter / Space / 方向键打开，上下移动，Home / End 跳首尾，
 *     Enter / Space 选择，Esc 关闭并回焦触发器，Tab 离开即关闭，
 *     可打印字符做简化 type-ahead
 *   · 点击外部关闭
 *   · 下方空间不足时向上展开（按最近滚动容器的可视区判断，不引入定位库）
 */

export interface EnumSelectOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  Icon?: LucideIcon;
  disabled?: boolean;
}

interface EnumSelectProps<T extends string> {
  /** 触发器 id（同时作为面板 id 的前缀） */
  id: string;
  /** 标题节点 id，用于 aria-labelledby */
  labelledBy: string;
  value: T;
  options: readonly EnumSelectOption<T>[];
  onChange: (next: T) => void;
  /**
   * 选项节点上的 data 锚点。
   * 闸门（a154 / a174）按这些锚点定位与断言，形态变了锚点必须留着。
   */
  optionAttrs?: (value: T) => Record<string, string>;
  /** 触发器上的 data 锚点 */
  triggerAttrs?: Record<string, string>;
}

const PANEL_MAX = 240;
const OPTION_HEIGHT = 32;

export function EnumSelect<T extends string>({
  id,
  labelledBy,
  value,
  options,
  onChange,
  optionAttrs,
  triggerAttrs,
}: EnumSelectProps<T>) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState<'below' | 'above'>('below');
  const [maxHeight, setMaxHeight] = useState(PANEL_MAX);

  const panelId = `${id}-panel`;
  const selectedIndex = options.findIndex(option => option.value === value);
  const current = options[selectedIndex] ?? options[0];

  /** 面板几何：按最近的滚动容器可视区决定向上/向下与最大高度。 */
  const measure = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const clipEl = triggerRef.current?.closest('.tc-scroll-fade');
    const clip = clipEl?.getBoundingClientRect();
    const bottom = clip ? clip.bottom : window.innerHeight;
    const top = clip ? clip.top : 0;
    const desired = Math.min(options.length * OPTION_HEIGHT + 8, PANEL_MAX);
    const spaceBelow = bottom - rect.bottom - 8;
    const spaceAbove = rect.top - top - 8;
    const up = spaceBelow < desired && spaceAbove > spaceBelow;
    setPlacement(up ? 'above' : 'below');
    setMaxHeight(Math.max(96, Math.min(PANEL_MAX, (up ? spaceAbove : spaceBelow) - 4)));
  }, [options.length]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openPanel = useCallback(
    (index: number) => {
      measure();
      setActiveIndex(index);
      setOpen(true);
    },
    [measure]
  );

  const choose = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      if (option.value !== value) onChange(option.value);
      close(true);
    },
    [close, onChange, options, value]
  );

  const move = useCallback(
    (delta: 1 | -1) => {
      setActiveIndex(prev => {
        const usable = options.map((option, index) => (option.disabled ? -1 : index)).filter(i => i >= 0);
        if (!usable.length) return prev;
        const currentPos = usable.indexOf(prev);
        const nextPos =
          currentPos < 0
            ? 0
            : Math.min(usable.length - 1, Math.max(0, currentPos + delta));
        return usable[nextPos];
      });
    },
    [options]
  );

  // 打开后焦点进面板，并让高亮项滚进可视区
  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  // 点击外部关闭；关闭时不抢焦点（用户点的是别处）
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const wrapper = triggerRef.current?.parentElement;
      if (wrapper && event.target instanceof Node && wrapper.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // 窗口尺寸变化时重新量一次，避免展开后被裁切
  useEffect(() => {
    if (!open) return;
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open, measure]);

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (open) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      openPanel(selectedIndex >= 0 ? selectedIndex : 0);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      openPanel(selectedIndex >= 0 ? selectedIndex : 0);
    }
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        // 阻止冒泡：设置弹窗自己也监听 Esc 关闭，按键不能被它抢走
        event.stopPropagation();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        // 阻止冒泡：设置弹窗自己也监听 Esc 关闭，按键不能被它抢走
        event.stopPropagation();
        move(-1);
        return;
      case 'Home':
        event.preventDefault();
        // 阻止冒泡：设置弹窗自己也监听 Esc 关闭，按键不能被它抢走
        event.stopPropagation();
        setActiveIndex(options.findIndex(option => !option.disabled));
        return;
      case 'End': {
        event.preventDefault();
        // 阻止冒泡：设置弹窗自己也监听 Esc 关闭，按键不能被它抢走
        event.stopPropagation();
        for (let i = options.length - 1; i >= 0; i -= 1) {
          if (!options[i].disabled) {
            setActiveIndex(i);
            break;
          }
        }
        return;
      }
      case 'Enter':
      case ' ':
        event.preventDefault();
        // 阻止冒泡：设置弹窗自己也监听 Esc 关闭，按键不能被它抢走
        event.stopPropagation();
        choose(activeIndex);
        return;
      case 'Escape':
        event.preventDefault();
        // 阻止冒泡：设置弹窗自己也监听 Esc 关闭，按键不能被它抢走
        event.stopPropagation();
        close(true);
        return;
      case 'Tab':
        // 焦点按默认顺序离开；只把面板关掉，不拦默认行为
        close(false);
        return;
      default:
        break;
    }
    // 简化 type-ahead：单字符跳到下一个以该字符开头的选项
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const char = event.key.toLowerCase();
      for (let step = 1; step <= options.length; step += 1) {
        const index = (activeIndex + step) % options.length;
        if (!options[index].disabled && options[index].label.toLowerCase().startsWith(char)) {
          event.preventDefault();
          event.stopPropagation();
          setActiveIndex(index);
          return;
        }
      }
    }
  };

  const activeOption = options[activeIndex];
  const CurrentIcon = current?.Icon;

  return (
    <div className="opc-select">
      <div
        ref={triggerRef}
        id={id}
        role="combobox"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={panelId}
        aria-labelledby={labelledBy}
        className="opc-select__trigger"
        onClick={() => (open ? close(true) : openPanel(selectedIndex >= 0 ? selectedIndex : 0))}
        onKeyDown={onTriggerKeyDown}
        {...triggerAttrs}
      >
        {CurrentIcon && <CurrentIcon className="opc-select__leading" size={15} aria-hidden="true" />}
        <span className="opc-select__value">{current?.label}</span>
        <ChevronDown className="opc-select__chevron" size={15} aria-hidden="true" />
      </div>

      <div
        ref={listRef}
        id={panelId}
        role="listbox"
        tabIndex={-1}
        aria-labelledby={labelledBy}
        aria-activedescendant={
          open && activeOption ? `${panelId}-${activeOption.value}` : undefined
        }
        className={`opc-select__panel opc-select__panel--${placement}`}
        style={{ maxHeight }}
        hidden={!open}
        onKeyDown={onListKeyDown}
      >
        {options.map((option, index) => {
          const { value: optionValue, label, hint, Icon } = option;
          const isSelected = optionValue === value;
          return (
            <div
              key={optionValue}
              id={`${panelId}-${optionValue}`}
              role="option"
              aria-selected={isSelected}
              aria-disabled={option.disabled || undefined}
              data-active={open && index === activeIndex ? 'true' : 'false'}
              className="opc-select__option"
              title={hint}
              onClick={() => choose(index)}
              onMouseEnter={() => !option.disabled && setActiveIndex(index)}
              {...(optionAttrs ? optionAttrs(optionValue) : {})}
            >
              {Icon && <Icon className="opc-select__option-icon" size={14} aria-hidden="true" />}
              <span className="opc-select__option-label">{label}</span>
              {isSelected && <Check className="opc-select__option-check" size={14} aria-hidden="true" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
