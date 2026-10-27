/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        // 变量存 RGB 三元组，配合 <alpha-value> 才能支持 text-ink/90 这类透明度写法
        app: 'rgb(var(--bg-app) / <alpha-value>)',
        sidebar: 'rgb(var(--bg-sidebar) / <alpha-value>)',
        elevated: 'rgb(var(--bg-elevated) / <alpha-value>)',
        card: 'rgb(var(--bg-card) / <alpha-value>)',
        hover: 'rgb(var(--bg-hover) / <alpha-value>)',
        active: 'rgb(var(--bg-active) / <alpha-value>)',
        line: 'rgb(var(--border) / <alpha-value>)',
        'line-strong': 'rgb(var(--border-strong) / <alpha-value>)',
        ink: 'rgb(var(--text) / <alpha-value>)',
        dim: 'rgb(var(--text-dim) / <alpha-value>)',
        faint: 'rgb(var(--text-faint) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)'
      },
      fontFamily: {
        ui: ['"Segoe UI"', '"Microsoft YaHei UI"', '"Microsoft YaHei"', 'system-ui', 'sans-serif']
      },
      fontSize: {
        '2xs': ['11px', '16px']
      },
      transitionDuration: {
        120: '120ms'
      }
    }
  },
  plugins: []
}
