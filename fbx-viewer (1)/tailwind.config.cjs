/** A colour defined once in styles.css, with Tailwind's opacity modifiers still working on it. */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** The one accent. It takes over the `blue` scale too, so the editor's selection and focus colours all land on it. */
const accent = {
  50: '#fff4ea',
  100: '#ffe6d0',
  200: '#fdcba0',
  300: '#f9ad70',
  400: '#f59a52',
  500: '#f08a3c',
  600: '#e27a2b',
  700: '#b95f1e',
  800: '#8a4618',
  900: '#5a3015',
  950: '#2e1a0d',
};

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html', './App.tsx', './index.tsx',
    './components/**/*.{js,ts,jsx,tsx}', './context/**/*.{js,ts,jsx,tsx}',
    './hooks/**/*.{js,ts,jsx,tsx}', './services/**/*.{js,ts,jsx,tsx}',
    './utils/**/*.{js,ts,jsx,tsx}', './host/**/*.{js,ts,jsx,tsx}',
    './player.html', './player/**/*.{js,ts,jsx,tsx}', './runtime/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        // Bundled with the editor only: a built game falls through to the system font.
        sans: ['"Inter Variable"', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', 'ui-monospace', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', '16px'],
        xs: ['12px', '16px'],
        sm: ['13px', '18px'],
      },
      fontWeight: {
        bold: '600',
      },
      borderRadius: {
        sm: '2px',
        DEFAULT: '3px',
        md: '3px',
        lg: '4px',
        xl: '6px',
        '2xl': '8px',
      },
      colors: {
        ground: token('ground'),
        panel: token('panel'),
        raised: token('raised'),
        well: token('well'),
        line: token('line'),
        ink: { DEFAULT: token('ink'), 2: token('ink-2'), 3: token('ink-3') },
        accent: { DEFAULT: token('accent'), hover: token('accent-hover'), ink: token('accent-ink') },
        ok: token('ok'),
        warn: token('warn'),
        bad: token('bad'),
        gray: {
          50: '#f7f7f8',
          100: '#eeeef0',
          200: '#e2e3e5',
          300: '#c9cbcf',
          400: '#adb0b6',
          500: '#858890',
          600: '#5c5e65',
          700: '#3f4146',
          750: '#35363b',
          800: '#2a2b2f',
          850: '#232428',
          900: '#1e1f22',
          950: '#161719',
        },
        blue: accent,
      },
    },
  },
  plugins: [],
};
