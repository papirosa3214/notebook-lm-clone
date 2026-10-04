/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // NotebookLM surface palette
        canvas: 'rgb(var(--nb-canvas) / <alpha-value>)',
        surface: 'rgb(var(--nb-surface) / <alpha-value>)',
        'surface-tint': 'rgb(var(--nb-surface-tint) / <alpha-value>)',
        border: 'rgb(var(--nb-border) / <alpha-value>)',
        ink: 'rgb(var(--nb-ink) / <alpha-value>)',
        muted: 'rgb(var(--nb-muted) / <alpha-value>)',
        subtle: 'rgb(var(--nb-subtle) / <alpha-value>)',
        // Accent — terracotta clay
        accent: 'rgb(var(--nb-accent) / <alpha-value>)',
        'accent-hover': 'rgb(var(--nb-accent-hover) / <alpha-value>)',
        'accent-soft': 'rgb(var(--nb-accent-soft) / <alpha-value>)',
        'accent-ink': 'rgb(var(--nb-accent-ink) / <alpha-value>)',
        // AI Studio gradient — deep indigo
        ai: 'rgb(var(--nb-ai) / <alpha-value>)',
        'ai-ink': 'rgb(var(--nb-ai-ink) / <alpha-value>)',
        'ai-glow': 'rgb(var(--nb-ai-glow) / <alpha-value>)',
        // Status — green check
        success: 'rgb(var(--nb-success) / <alpha-value>)',
      },
      fontFamily: {
        sans: [
          'Google Sans',
          'Google Sans Text',
          '-apple-system',
          'BlinkMacSystemFont',
          'Inter',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      boxShadow: {
        soft: '0 1px 2px rgb(0 0 0 / 0.04), 0 1px 3px rgb(0 0 0 / 0.06)',
        pop: '0 4px 12px rgb(0 0 0 / 0.08), 0 1px 3px rgb(0 0 0 / 0.04)',
        'pop-lg': '0 12px 32px rgb(0 0 0 / 0.12), 0 2px 6px rgb(0 0 0 / 0.06)',
        ai: '0 8px 24px rgb(58 47 138 / 0.18), 0 2px 6px rgb(58 47 138 / 0.10)',
        ring: '0 0 0 1px rgb(var(--nb-border) / 0.6), 0 1px 2px rgb(0 0 0 / 0.04)',
      },
      borderRadius: {
        '4xl': '2rem',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        sparkle: {
          '0%, 100%': { transform: 'rotate(0deg) scale(1)', opacity: '0.9' },
          '50%': { transform: 'rotate(15deg) scale(1.15)', opacity: '1' },
        },
      },
      animation: {
        'fade-up': 'fade-up 240ms ease-out',
        shimmer: 'shimmer 1.6s linear infinite',
        sparkle: 'sparkle 2.4s ease-in-out infinite',
        'pulse-once': 'pulse-once 2400ms ease-out',
      },
    },
  },
  plugins: [],
};