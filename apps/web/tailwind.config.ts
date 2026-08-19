import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#FAF6EF',
        card: '#FFFFFF',
        ink: '#1C2434',
        inksoft: '#5C6572',
        line: '#E6DFD2',
        accent: '#2E4BE6',
        accentdeep: '#1F38B8',
        stamp: '#E4572E',
        leaf: '#20835C',
        cmyk: {
          c: '#00A7D4',
          m: '#E040A1',
          y: '#F2B705',
          k: '#1C2434',
        },
      },
      fontFamily: {
        display: ['var(--font-fraunces)', 'Georgia', 'serif'],
        body: ['var(--font-figtree)', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        sheet: '0 1px 2px rgba(28,36,52,0.06), 0 8px 24px -12px rgba(28,36,52,0.18)',
        press: '0 2px 0 rgba(28,36,52,0.9)',
      },
      keyframes: {
        rise: {
          from: { opacity: '0', transform: 'translateY(16px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        pop: {
          '0%': { opacity: '0', transform: 'scale(.6)' },
          '70%': { opacity: '1', transform: 'scale(1.06)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        stampIn: {
          '0%': { opacity: '0', transform: 'rotate(-14deg) scale(1.8)' },
          '60%': { opacity: '1', transform: 'rotate(-8deg) scale(.96)' },
          '100%': { opacity: '1', transform: 'rotate(-8deg) scale(1)' },
        },
        breathe: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '.55', transform: 'scale(1.04)' },
        },
        sheetOut: {
          '0%': { transform: 'translateY(-92%)' },
          '100%': { transform: 'translateY(0)' },
        },
        tumble: {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
      },
      animation: {
        rise: 'rise .55s cubic-bezier(.22,1,.36,1) both',
        pop: 'pop .45s cubic-bezier(.22,1,.36,1) both',
        'stamp-in': 'stampIn .5s cubic-bezier(.22,1,.36,1) both',
        breathe: 'breathe 1.6s ease-in-out infinite',
        'sheet-out': 'sheetOut 2.2s cubic-bezier(.65,0,.35,1) infinite',
        tumble: 'tumble 1s linear infinite',
      },
    },
  },
  plugins: [],
};
export default config;
