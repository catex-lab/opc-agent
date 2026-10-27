/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: 'var(--td-bg-color-page)',
        foreground: 'var(--td-text-color-primary)',
        muted: {
          DEFAULT: 'var(--td-bg-color-component)',
          foreground: 'var(--td-text-color-secondary)',
        },
        border: 'var(--td-component-stroke)',
        input: 'var(--td-bg-color-component)',
        card: {
          DEFAULT: 'var(--td-bg-color-container)',
          foreground: 'var(--td-text-color-primary)',
        },
        accent: {
          DEFAULT: 'var(--td-brand-color)',
          foreground: 'var(--td-text-color-anti)',
          light: 'var(--td-brand-color-light)',
        },
        primary: {
          DEFAULT: 'var(--td-text-color-primary)',
          foreground: 'var(--td-bg-color-page)',
        }
      },
      /**
       * 字号 —— 语义化命名，值指向 index.css 里的 --text-* 令牌。
       *
       * 为什么要覆盖 Tailwind 默认的 text-xs/sm/base/lg：
       *   Tailwind 默认档位是 12/14/16px，与腾讯设计体系的 11/12/13/14/15/16/17
       *   对不齐，导致业务里不断手写 text-[12.5px] / text-[11.5px] 这类
       *   「差半像素」的补丁值（实测有 20+ 处）。覆盖成令牌后：
       *     text-caption 11px  text-secondary 12px  text-body 13px
       *     text-body-lg 14px  text-title 15px      text-title-lg 16px
       *     text-page 17px
       *   档位连续、无小数，随手写 text-[12.5px] 的动机就消失了。
       */
      fontSize: {
        'caption': ['var(--text-caption)', { lineHeight: 'var(--leading-normal)' }],
        'secondary': ['var(--text-secondary)', { lineHeight: 'var(--leading-normal)' }],
        'body': ['var(--text-body)', { lineHeight: 'var(--leading-normal)' }],
        'body-lg': ['var(--text-body-lg)', { lineHeight: 'var(--leading-normal)' }],
        'title': ['var(--text-title)', { lineHeight: 'var(--leading-tight)' }],
        'title-lg': ['var(--text-title-lg)', { lineHeight: 'var(--leading-tight)' }],
        'page': ['var(--text-page)', { lineHeight: 'var(--leading-tight)' }],
        /* A133：空态大标题（新对话页欢迎语）。8 档里的最高一档，
           只服务「一屏只有一句话」的场景，不要当通用标题用。 */
        'display': ['var(--text-display)', { lineHeight: 'var(--leading-tight)' }],
        /* 保留 Tailwind 原名但重新绑定到腾讯档位，避免老代码掉回 Tailwind 默认值 */
        'xs': ['var(--text-secondary)', { lineHeight: 'var(--leading-normal)' }],
        'sm': ['var(--text-body)', { lineHeight: 'var(--leading-normal)' }],
        'base': ['var(--text-body-lg)', { lineHeight: 'var(--leading-normal)' }],
        'lg': ['var(--text-title)', { lineHeight: 'var(--leading-tight)' }],
      },
      spacing: {
        /* 8pt 网格：在 Tailwind 默认间距之外补上 4/12/20 这几个
           「半步」档位（默认只有 1=4px、2=8px、3=12px、4=16px、5=20px，
           数值是对的，但语义名字缺失，业务里就会写 px-2.5 这类小数） */
        'space-1': 'var(--space-1)',
        'space-2': 'var(--space-2)',
        'space-3': 'var(--space-3)',
        'space-4': 'var(--space-4)',
        'space-5': 'var(--space-5)',
        'space-6': 'var(--space-6)',
      },
      /**
       * 圆角 —— 原先把 xl 覆盖成 16px、2xl 覆盖成 20px，
       * 但 TDesign 的圆角令牌是 small 4 / default 6 / medium 8 / large 12 / extraLarge 16。
       * 这里改成直接映射到 TDesign 令牌，保证「组件库内部」与「自研组件」
       * 的圆角完全同源；需要大圆角时用 rounded-2xl（16px）。
       */
      borderRadius: {
        'sm': 'var(--td-radius-small)',
        'DEFAULT': 'var(--td-radius-default)',
        'md': 'var(--td-radius-default)',
        'lg': 'var(--td-radius-medium)',
        'xl': 'var(--td-radius-large)',
        '2xl': 'var(--td-radius-extraLarge)',
        '3xl': '20px',
      },
      boxShadow: {
        /* 阴影令牌化：业务里直接 shadow-card / shadow-popup，
           不再写 shadow-lg 这类拿不到主题适配的 Tailwind 内置值 */
        'subtle': 'var(--shadow-subtle)',
        'card': 'var(--shadow-card)',
        'popup': 'var(--shadow-popup)',
        'float': 'var(--shadow-float)',
      },
      transitionTimingFunction: {
        'tencent': 'var(--ease-tencent)',
        /* A84：这里原来还有一条 `spring: 'var(--ease-spring)'`。
           A83 已经把 `--ease-spring` 令牌删掉了（拖拽不允许回弹，全站
           也没有任何一处该用过冲曲线），但 Tailwind 这一行还留着 ——
           于是 `ease-spring` 变成一个**指向不存在变量**的类：谁哪天写了它，
           编译不报错、运行时静默回退到默认曲线，A83 那条
           「全站没有过冲缓动」的断言也就形同虚设。死别名一并删掉。 */
      },
      transitionDuration: {
        'fast': 'var(--duration-fast)',
        'base': 'var(--duration-base)',
        'slow': 'var(--duration-slow)',
      },
      animation: {
        'cursor-blink': 'blink 1s infinite',
      },
      keyframes: {
        blink: {
          '0%, 50%': { opacity: '1' },
          '51%, 100%': { opacity: '0' },
        },
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  }
}
