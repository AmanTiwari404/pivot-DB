/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      fontFamily: {
        sans: ['IBM Plex Sans', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
      },
      colors: {
        // shadcn-compat HSL bindings (existing components keep working)
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent-color))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },

        // Console-theme direct tokens (use as `bg-canvas`, `text-text-1`, etc.)
        canvas:        'var(--canvas)',
        surface:       'var(--surface)',
        rail:          'var(--rail)',
        'rail-strong': 'var(--rail-strong)',
        'border-soft': 'var(--border-soft)',
        'border-strong':'var(--border-strong)',
        'text-1':      'var(--text-1)',
        'text-2':      'var(--text-2)',
        'text-3':      'var(--text-3)',
        'text-4':      'var(--text-4)',
        'accent-1':    'var(--accent)',
        'accent-hover':'var(--accent-hover)',
        'accent-soft': 'var(--accent-soft)',
        'accent-soft-2':'var(--accent-soft-2)',
        'accent-ink':  'var(--accent-ink)',
        success:       'var(--success)',
        'success-soft':'var(--success-soft)',
        warn:          'var(--warn)',
        'warn-soft':   'var(--warn-soft)',
        danger:        'var(--danger)',
        'danger-soft': 'var(--danger-soft)',
      },
      borderRadius: {
        lg: 'var(--radius-lg)',
        md: 'var(--radius)',
        sm: 'var(--radius-sm)',
      },
      boxShadow: {
        '1': 'var(--shadow-1)',
        '2': 'var(--shadow-2)',
        pop: 'var(--shadow-pop)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'pulse-soft': 'pulse-soft 2s infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}
