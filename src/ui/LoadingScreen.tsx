'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { strings } from './strings'

type Stage = 'idle' | 'reading' | 'numbering' | 'understanding' | 'researching' | 'outlining' | 'writing' | 'checking' | 'repairing' | 'done' | 'failed'

const STAGE_TEXT: Record<Stage, string> = {
  idle: strings.loading.gettingReady,
  reading: strings.loading.reading,
  numbering: strings.loading.numbering,
  understanding: strings.loading.understanding,
  researching: strings.loading.researching,
  outlining: strings.loading.outlining,
  writing: strings.loading.writing,
  checking: strings.loading.checking,
  repairing: strings.loading.repairing,
  done: strings.loading.gettingReady,
  failed: strings.loading.failed,
}

export function LoadingScreen({ fingerprint }: { fingerprint: string }) {
  const router = useRouter()
  const [stage, setStage] = useState<Stage>('idle')
  const [title, setTitle] = useState('')
  const started = useRef(false)

  const [detail, setDetail] = useState<string | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/documents', { cache: 'no-store' })
      .then((r) => r.json())
      .then((b: { documents?: { fingerprint: string; title: string }[] }) => {
        if (cancelled) return
        const doc = b.documents?.find((d) => d.fingerprint === fingerprint)
        if (doc) setTitle(doc.title)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [fingerprint])

  useEffect(() => {
    if (started.current) return
    started.current = true
    void fetch(`/api/documents/${encodeURIComponent(fingerprint)}/process`, { method: 'POST' }).catch(() => undefined)
  }, [fingerprint])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetch(`/api/documents/${encodeURIComponent(fingerprint)}/process`, { cache: 'no-store' })
        const body = (await res.json()) as { stage?: Stage; error?: string | null; remainingSeconds?: number | null }
        if (cancelled || !body.stage) return
        setStage(body.stage)
        setDetail(body.error ?? null)
        setRemaining(typeof body.remainingSeconds === 'number' ? body.remainingSeconds : null)
        if (body.stage === 'done') router.replace(`/read/${fingerprint}`)
      } catch { /* next tick retries */ }
    }
    void tick()
    const id = window.setInterval(tick, 1200)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [fingerprint, router])

  async function retry() {
    setStage('reading')
    setDetail(null)
    await fetch(`/api/documents/${encodeURIComponent(fingerprint)}/process`, { method: 'POST' }).catch(() => undefined)
  }

  return (
    <main style={{ minHeight: '100vh', padding: '0 20px' }}>
      <header style={{ height: 'var(--topbar)', display: 'flex', alignItems: 'center' }}>
        <Link href="/" style={{ fontSize: 'var(--fs-title)', fontWeight: 600, color: 'var(--moss)', textDecoration: 'none' }}>{strings.appName}</Link>
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: '16vh' }}>
        <div style={{ width: 'min(560px, 100%)', textAlign: 'center' }}>
          {title ? <p style={{ fontSize: 'var(--fs-title)', margin: '0 0 14px' }}>{title}</p> : null}
          <p role="status" style={{ margin: remaining !== null && stage !== 'failed' ? '0 0 6px' : '0 0 34px' }}>{stage === 'failed' && detail ? detail : STAGE_TEXT[stage]}</p>
          {remaining !== null && stage !== 'failed' ? <p style={{ margin: '0 0 34px', fontSize: 'var(--fs-small)', opacity: 0.7 }}>{strings.loading.left(Math.ceil(remaining / 60))}</p> : null}
          {stage === 'failed' ? (
            <button type="button" className="cut-btn" onClick={() => void retry()}>{strings.loading.tryAgain}</button>
          ) : (
            <div aria-hidden="true">
              <div className="stroke-track"><span className="stroke-bar" /></div>
              <div className="ruled" /><div className="ruled" /><div className="ruled" />
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
