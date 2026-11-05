import type { ReactNode } from 'react'
import { Newsreader } from 'next/font/google'
import './globals.css'

const once = Newsreader({ subsets: ['latin'], display: 'swap', variable: '--font-once' })

export const metadata = {
  title: 'Once',
  description: 'Make anyone an expert in anything, in one read.',
}

const themeScript = `(function(){try{var m=localStorage.getItem('once-theme')||'system';var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';document.documentElement.dataset.themeMode=m;}catch(e){document.documentElement.dataset.theme='light';}})();`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={once.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <svg width={0} height={0} style={{ position: 'absolute' }} aria-hidden="true">
          <filter id="rough"><feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves={3} seed={4} /><feDisplacementMap in="SourceGraphic" scale={5} /></filter>
          <filter id="stroke" x="-3%" y="-30%" width="106%" height="160%"><feTurbulence type="fractalNoise" baseFrequency=".06 .3" numOctaves={2} seed={7} /><feDisplacementMap in="SourceGraphic" scale={3.5} /></filter>
          <filter id="g"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves={3} /><feColorMatrix values="0 0 0 0 .55 0 0 0 0 .5 0 0 0 0 .4 0 0 0 .22 0" /></filter>
        </svg>
        <svg className="grain" width="100%" height="100%" aria-hidden="true"><rect width="100%" height="100%" filter="url(#g)" /></svg>
        {children}
      </body>
    </html>
  )
}
