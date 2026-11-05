'use client'

import { useEffect, useRef, useState } from 'react'
import type { PageNote, Sentence } from '@/lib/types'
import { GEOMETRY, strokesForSentences, underlineRectsForBoxes } from './geometry'

export interface ReaderPageMeta {
  page: number
  width: number
  height: number
  text: string
  isScan: boolean
}

export type ScrollTarget =
  | { kind: 'figure'; page: number; box: { x: number; y: number; w: number; h: number }; key: number }
  | { kind: 'sentences'; ids: string[]; key: number }
  | { kind: 'page'; page: number; key: number }
  | null

export interface FigureOverlay { page: number; box: { x: number; y: number; w: number; h: number }; mask: string | null; maskSize: { w: number; h: number } | null }

interface Props {
  fingerprint: string
  kind: string
  pages: ReaderPageMeta[]
  sentences: Sentence[]
  litIds: ReadonlySet<string>
  seenIds: ReadonlySet<string>
  notes: PageNote[]
  figure: FigureOverlay | null
  scrollTarget: ScrollTarget
  onNote: (note: PageNote, rect: DOMRect) => void
}

export function PdfView({ fingerprint, kind, pages, sentences, litIds, seenIds, notes, figure, scrollTarget, onNote }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const [ready, setReady] = useState(false)
  const isPdf = kind === 'pdf'

  useEffect(() => {
    if (!isPdf) { setReady(true); return }
    let cancelled = false
    let doc: { destroy?: () => Promise<void> } | null = null
    async function render() {
      try {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
        const response = await fetch(`/api/documents/${encodeURIComponent(fingerprint)}/original`)
        if (!response.ok) throw new Error(`original ${response.status}`)
        const data = await response.arrayBuffer()
        if (cancelled) return
        const loaded = await pdfjs.getDocument({ data }).promise
        doc = loaded as unknown as { destroy?: () => Promise<void> }
        const container = containerRef.current
        if (!container || cancelled) return
        for (const meta of pages) {
          if (cancelled) return
          const host = container.querySelector<HTMLElement>(`[data-page-host="${meta.page}"]`)
          const canvas = container.querySelector<HTMLCanvasElement>(`[data-page-canvas="${meta.page}"]`)
          if (!host || !canvas || meta.width <= 0) continue
          const page = await loaded.getPage(meta.page)
          const base = page.getViewport({ scale: 1 })
          const cssWidth = host.clientWidth || GEOMETRY.pageWidth
          const scale = cssWidth / base.width
          const viewport = page.getViewport({ scale })
          const dpr = Math.min(window.devicePixelRatio || 1, 2)
          canvas.width = Math.floor(viewport.width * dpr)
          canvas.height = Math.floor(viewport.height * dpr)
          canvas.style.width = `${viewport.width}px`
          canvas.style.height = `${viewport.height}px`
          host.style.width = `${viewport.width}px`
          host.style.height = `${viewport.height}px`
          if (!canvas.getContext('2d')) continue
          await page.render({ canvas, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] }).promise
          page.cleanup()
        }
        if (!cancelled) setReady(true)
      } catch { if (!cancelled) setFailed(true) }
    }
    void render()
    return () => { cancelled = true; void doc?.destroy?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, pages, isPdf])

  useEffect(() => {
    if (!ready || !scrollTarget) return
    const container = containerRef.current
    if (!container) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(() => {
      if (scrollTarget.kind === 'figure') {
        const host = container.querySelector(`[data-page-host="${scrollTarget.page}"]`)
        if (host) {
          const rect = host.getBoundingClientRect()
          const middle = rect.top + (rect.height * (scrollTarget.box.y + scrollTarget.box.h / 2)) / 1000
          window.scrollTo({ top: Math.max(0, window.scrollY + middle - window.innerHeight / 2), behavior: reduced ? 'auto' : 'smooth' })
        }
        return
      }
      if (scrollTarget.kind === 'page') {
        container.querySelector(`[data-page-host="${scrollTarget.page}"]`)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
        return
      }
      for (const id of scrollTarget.ids) {
        const el = container.querySelector(`[data-box~="${CSS.escape(id)}"]`)
        if (el) {
          const rect = el.getBoundingClientRect()
          const y = window.scrollY + rect.top - window.innerHeight * 0.32
          window.scrollTo({ top: Math.max(0, y), behavior: reduced ? 'auto' : 'smooth' })
          return
        }
      }
    }, 60)
    return () => window.clearTimeout(timer)
  }, [scrollTarget, ready])

  if (failed) return null

  const byPage = new Map<number, Sentence[]>()
  for (const s of sentences) { const l = byPage.get(s.page) ?? []; l.push(s); byPage.set(s.page, l) }
  const notesByPage = new Map<number, PageNote[]>()
  for (const n of notes) {
    const s = sentences.find((x) => x.id === n.sentenceId)
    const page = s?.page ?? 0
    const l = notesByPage.get(page) ?? []; l.push(n); notesByPage.set(page, l)
  }

  return (
    <div ref={containerRef} style={{ display: 'grid', gap: 26, justifyItems: 'center' }}>
      {pages.map((meta) => (
        <div key={meta.page} className="doc-sheet sheet-settle" data-page-host={meta.page}
          style={{ position: 'relative', width: 'min(700px, 100%)', aspectRatio: meta.width > 0 ? `${meta.width} / ${meta.height}` : undefined, overflow: 'hidden' }}>
          {isPdf
            ? <canvas data-page-canvas={meta.page} style={{ display: 'block', width: '100%', height: '100%', mixBlendMode: 'multiply' }} />
            : kind === 'image'
              ? <img src={`/api/documents/${encodeURIComponent(fingerprint)}/original`} alt="" style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain', mixBlendMode: 'multiply' }} />
              : null}
          <div style={{ position: 'absolute', inset: 0 }}>
            {(() => {
              const onPage = byPage.get(meta.page) ?? []
              const lit = onPage.filter((s) => litIds.has(s.id))
              const seen = onPage.filter((s) => !litIds.has(s.id) && seenIds.has(s.id))
              const paint = (group: Sentence[], other: Sentence[], isLit: boolean) =>
                strokesForSentences(group, meta, other.flatMap((s) => s.boxes)).map(({ ids, rect: r }, i) => (
                  <span key={`${isLit ? 'lit' : 'seen'}-${ids[0]}-${i}`} data-box={ids.join(' ')} data-lit={isLit ? '1' : undefined} className={isLit ? 'hl-lit' : 'hl-seen'} style={{ left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%` }} />
                ))
              return [...paint(seen, lit, false), ...paint(lit, seen, true)]
            })()}
            {(notesByPage.get(meta.page) ?? []).flatMap((note) => {
              const neighbours = (byPage.get(meta.page) ?? []).flatMap((s) => s.boxes)
              return underlineRectsForBoxes(note.boxes, meta, neighbours).map((r, i) => (
                <button key={`${note.id}-${i}`} type="button" className="note-anchor" aria-label={note.anchor}
                  style={{ left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%` }}
                  onClick={(e) => { e.stopPropagation(); onNote(note, e.currentTarget.getBoundingClientRect()) }} />
              ))
            })}
            {figure && figure.page === meta.page ? (
              <span aria-hidden="true" style={{ position: 'absolute', left: `${(figure.box.x / 1000) * 100}%`, top: `${(figure.box.y / 1000) * 100}%`, width: `${(figure.box.w / 1000) * 100}%`, height: `${(figure.box.h / 1000) * 100}%`, background: figure.mask && figure.maskSize ? undefined : 'var(--stroke)', mixBlendMode: 'multiply', opacity: figure.mask && figure.maskSize ? .8 : .65, filter: figure.mask && figure.maskSize ? undefined : 'url(#stroke)', pointerEvents: 'none' }}>
                {figure.mask && figure.maskSize ? (
                  <svg viewBox={`0 0 ${figure.maskSize.w} ${figure.maskSize.h}`} preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: '100%' }}>
                    <path d={figure.mask} fill="var(--stroke)" fillRule="evenodd" />
                  </svg>
                ) : null}
              </span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}
