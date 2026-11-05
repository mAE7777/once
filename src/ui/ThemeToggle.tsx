'use client'

import { useEffect, useState } from 'react'
import { strings } from './strings'
import { MoonIcon, SunIcon, SystemIcon } from './icons'

type Mode = 'light' | 'dark' | 'system'
const ORDER: Mode[] = ['light', 'dark', 'system']

function apply(mode: Mode) {
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.themeMode = mode
}

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>('system')
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('once-theme')
      if (saved === 'light' || saved === 'dark' || saved === 'system') setMode(saved)
    } catch { /* keep system */ }
  }, [])
  function cycle() {
    const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]
    setMode(next)
    try { window.localStorage.setItem('once-theme', next) } catch { /* session only */ }
    apply(next)
  }
  return (
    <button type="button" className="icon-btn" aria-label={strings.aria.theme} data-tip={strings.aria.theme} onClick={cycle}>
      {mode === 'light' ? <SunIcon /> : mode === 'dark' ? <MoonIcon /> : <SystemIcon />}
    </button>
  )
}
