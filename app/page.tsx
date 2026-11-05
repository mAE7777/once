'use client'

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useRouter } from 'next/navigation'
import { strings } from '@/ui/strings'
import { PlayIcon } from '@/ui/icons'
import { ThemeToggle } from '@/ui/ThemeToggle'

interface DocumentItem {
  fingerprint: string
  title: string
  kind: string
  processed: boolean
}

export default function HomePage() {
  const router = useRouter()
  const [documents, setDocuments] = useState<DocumentItem[]>([])
  const [text, setText] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/documents', { cache: 'no-store' })
      if (!res.ok) return
      const body = (await res.json()) as { documents?: DocumentItem[] }
      if (Array.isArray(body.documents)) setDocuments(body.documents)
    } catch { /* library stays as it is */ }
  }, [])

  useEffect(() => { void load() }, [load])

  async function addText() {
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const form = new FormData()
      if (/^https?:\/\/\S+$/i.test(value)) form.set('url', value)
      else form.set('text', text)
      const res = await fetch('/api/documents', { method: 'POST', body: form })
      const body = (await res.json().catch(() => null)) as { fingerprint?: string; error?: string } | null
      if (!res.ok || !body?.fingerprint) throw new Error(body?.error ?? '')
      setText('')
      await load()
    } catch {
      setFailure(strings.home.addFailed)
    } finally { setBusy(false) }
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const form = new FormData()
      form.set('file', file)
      const res = await fetch('/api/documents', { method: 'POST', body: form })
      const body = (await res.json().catch(() => null)) as { fingerprint?: string; error?: string } | null
      if (!res.ok || !body?.fingerprint) throw new Error(body?.error ?? '')
      await load()
    } catch {
      setFailure(strings.home.addFailed)
    } finally { setBusy(false) }
  }

  function primary() {
    if (text.trim()) void addText()
    else fileRef.current?.click()
  }

  function open(doc: DocumentItem) {
    if (doc.processed) router.push(`/read/${doc.fingerprint}`)
    else router.push(`/loading/${doc.fingerprint}`)
  }

  return (
    <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '120px 20px 80px', position: 'relative', minHeight: '100vh' }}>
      <div style={{ position: 'absolute', top: 18, right: 22 }}><ThemeToggle /></div>
      <h1 style={{ fontSize: 'var(--fs-display)', fontWeight: 600, margin: 0, letterSpacing: '-.02em', color: 'var(--moss)', lineHeight: 1 }}>{strings.appName}</h1>
      <p style={{ fontSize: 'var(--fs-title)', margin: '14px 0 54px', textAlign: 'center' }}>{strings.tagline}</p>
      <div style={{ width: 'min(680px, 100%)' }}>
        <textarea
          className="field sheet-settle"
          rows={5}
          value={text}
          placeholder={strings.home.paste}
          aria-label={strings.home.paste}
          onChange={(e) => setText(e.target.value)}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, gap: 16 }}>
          <span style={{ fontSize: 'var(--fs-small)', opacity: .75 }}>{strings.home.formats}</span>
          <button type="button" className="cut-btn" disabled={busy} onClick={primary}>
            {text.trim() ? strings.home.add : strings.home.upload}
          </button>
        </div>
        <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.jpg,.jpeg,.png,.webp" onChange={onFile} style={{ display: 'none' }} aria-label={strings.aria.uploadFile} />
        {failure ? <p role="alert" style={{ fontSize: 'var(--fs-small)', marginTop: 18 }}>{failure}</p> : null}
        <div style={{ marginTop: 56 }}>
          {documents.map((doc) => (
            <div key={doc.fingerprint} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 0', borderTop: '1.5px solid var(--line)', gap: 12 }}>
              <span style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                {doc.processed ? <i className="dot" aria-hidden="true" /> : <i className="dot" style={{ visibility: 'hidden' }} aria-hidden="true" />}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title}</span>
              </span>
              <button type="button" className="icon-btn" aria-label={strings.aria.startReading} data-tip={strings.aria.startReading} onClick={() => open(doc)}><PlayIcon /></button>
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}
