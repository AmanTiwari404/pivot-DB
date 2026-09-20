import { useEffect, useState, useCallback } from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'mv:theme'

/** Resolve initial theme from localStorage, falling back to system preference. */
function readInitial(): Theme {
  if (typeof window === 'undefined') return 'light'
  const saved = localStorage.getItem(STORAGE_KEY) as Theme | null
  if (saved === 'light' || saved === 'dark') return saved
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
  return prefersDark ? 'dark' : 'light'
}

/** Apply the `dark` class on <html> so CSS variables flip. */
function applyClass(theme: Theme) {
  const root = document.documentElement
  if (theme === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
}

export function useTheme(): [Theme, (next: Theme) => void, () => void] {
  const [theme, setThemeState] = useState<Theme>(() => readInitial())

  useEffect(() => {
    applyClass(theme)
    try { localStorage.setItem(STORAGE_KEY, theme) } catch { /* ignore quota */ }
  }, [theme])

  const setTheme = useCallback((next: Theme) => setThemeState(next), [])
  const toggle = useCallback(() => setThemeState(t => t === 'dark' ? 'light' : 'dark'), [])

  return [theme, setTheme, toggle]
}
