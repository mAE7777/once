'use client'

import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PageNote } from '@/lib/types'
import type { ScrollTarget } from './PdfView'

export interface StandardRun { id?: string; text: string }

export interface StandardBlockData {
  type: 'heading' | 'paragraph' | 'caption' | 'folio'
  level: number
  centered?: boolean
  sentenceIds: string[]
  text: string
  runs: StandardRun[]
}

export interface StandardData {
  fingerprint: string
  hasOriginal: boolean
  blocks: StandardBlockData[]
  sentences: { id: string; start: number; end: number; text: string; page: number }[]
}

interface Props {
  data: StandardData
  litIds: ReadonlySet<string>
  seenIds: ReadonlySet<string>
  notes: PageNote[]
  scrollTarget: ScrollTarget
  onNote: (note: PageNote, rect: DOMRect) => void
}

export interface Piece { text: string; id?: string; note?: PageNote }

export type StrokeState = 'lit' | 'seen' | null

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Finds a note's anchor in display text, where line breaks are spaces and a broken word may be joined. */
export function findAnchor(text: string, anchor: string): { at: number; length: number } | null {
  const trimmed = anchor.trim()
  if (!trimmed) return null
  const pattern = escapeRegExp(trimmed).replace(/\\?-\s+/g, '-?\\s*').replace(/\s+/g, '\\s+')
  const match = new RegExp(pattern).exec(text)
  return match ? { at: match.index, length: match[0].length } : null
}

/** Breaks a block's runs into pieces, with each note's anchor as its own piece. */
export function piecesFor(runs: readonly StandardRun[], notes: readonly PageNote[]): Piece[] {
  const placed = new Set<string>()
  const pieces: Piece[] = []
  for (const run of runs) {
    const marks = notes
      .filter((note) => note.sentenceId === run.id && !placed.has(note.id))
      .flatMap((note) => {
        const found = findAnchor(run.text, note.anchor)
        return found ? [{ note, ...found }] : []
      })
      .sort((a, b) => a.at - b.at)
    let cursor = 0
    for (const mark of marks) {
      if (mark.at < cursor) continue
      if (mark.at > cursor) pieces.push({ text: run.text.slice(cursor, mark.at), ...(run.id ? { id: run.id } : {}) })
      pieces.push({ text: run.text.slice(mark.at, mark.at + mark.length), ...(run.id ? { id: run.id } : {}), note: mark.note })
      placed.add(mark.note.id)
      cursor = mark.at + mark.length
    }
    if (cursor < run.text.length) pieces.push({ text: run.text.slice(cursor), ...(run.id ? { id: run.id } : {}) })
  }
  return pieces
}

export function slicePieces(pieces: readonly Piece[], from: number, to: number): Piece[] {
  const out: Piece[] = []
  let at = 0
  for (const piece of pieces) {
    const start = Math.max(from, at)
    const end = Math.min(to, at + piece.text.length)
    if (end > start) out.push({ ...piece, text: piece.text.slice(start - at, end - at) })
    at += piece.text.length
  }
  return out
}

/**
 * Groups pieces that share a stroke, so one painted span runs across sentences, anchors and the spaces between them.
 */
export function strokeGroups(pieces: readonly Piece[], stateOf: (id: string) => StrokeState): { state: StrokeState; pieces: Piece[] }[] {
  const groups: { state: StrokeState; pieces: Piece[] }[] = []
  let pendingSpace: Piece[] = []
  const flushSpace = () => {
    if (pendingSpace.length) groups.push({ state: null, pieces: pendingSpace })
    pendingSpace = []
  }
  for (const piece of pieces) {
    if (!piece.id) {
      pendingSpace.push(piece)
      continue
    }
    const state = stateOf(piece.id)
    const last = groups[groups.length - 1]
    if (last && last.state === state && (state !== null || pendingSpace.length === 0)) {
      last.pieces.push(...pendingSpace, piece)
      pendingSpace = []
    } else {
      flushSpace()
      groups.push({ state, pieces: [piece] })
    }
  }
  flushSpace()
  return groups
}

const STROKE_CLASS = { lit: 'std-lit', seen: 'std-seen' } as const

export function StandardInline({ pieces, stateOf, onNote }: { pieces: readonly Piece[]; stateOf: (id: string) => StrokeState; onNote: (note: PageNote, rect: DOMRect) => void }): ReactNode {
  return strokeGroups(pieces, stateOf).map((group, g) => {
    const inner = group.pieces.map((piece, i) => {
      const key = `${g}-${i}`
      if (!piece.id) return <span key={key}>{piece.text}</span>
      const note = piece.note
      if (note) {
        return (
          <span key={key} data-std={piece.id} className="std-note" role="button" tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onNote(note, (e.currentTarget as HTMLElement).getBoundingClientRect()) }}>
            {piece.text}
          </span>
        )
      }
      return <span key={key} data-std={piece.id}>{piece.text}</span>
    })
    return group.state ? <span key={g} className={STROKE_CLASS[group.state]}>{inner}</span> : <span key={g}>{inner}</span>
  })
}

export interface BlockMetric {
  kind: 'heading' | 'text'
  height: number
  marginTop: number
  marginBottom: number
  lineHeight: number
  /** Character offset where each rendered line begins. */
  lineStarts: number[]
  length: number
}

export interface SheetFragment { block: number; from: number; to: number; continues: boolean; continued: boolean }

/**
 * Fits blocks onto sheets of a fixed text height. Paragraphs split between lines, keeping at least two lines on each
 * side, and a heading never ends a sheet without the start of what it heads.
 */
export function paginate(metrics: readonly BlockMetric[], pageHeight: number): SheetFragment[][] {
  const sheets: SheetFragment[][] = []
  let sheet: SheetFragment[] = []
  let y = 0
  let previousBottom = 0
  const newSheet = () => {
    sheets.push(sheet)
    sheet = []
    y = 0
    previousBottom = 0
  }
  metrics.forEach((m, index) => {
    const lines = m.lineStarts.length
    let line = 0
    for (;;) {
      const top = sheet.length ? Math.max(previousBottom, m.marginTop) : 0
      const remaining = lines - line
      const height = line === 0 ? m.height : remaining * m.lineHeight
      const room = pageHeight - y - top
      const next = metrics[index + 1]
      const needsNext = m.kind === 'heading' && next
        ? height + Math.max(m.marginBottom, next.marginTop) + Math.min(2, next.lineStarts.length) * next.lineHeight
        : height
      const from = line === 0 ? 0 : m.lineStarts[line]
      const fits = needsNext <= room + 0.5
      if (fits) {
        sheet.push({ block: index, from, to: m.length, continues: false, continued: line > 0 })
        y += top + height
        previousBottom = m.marginBottom
        return
      }
      if (m.kind === 'text' && remaining > 1) {
        let count = Math.min(Math.floor((room + 0.5) / m.lineHeight), remaining)
        if (remaining - count === 1) count -= 1
        if (count < 2 && sheet.length) count = 0
        if (!sheet.length) count = Math.max(1, Math.min(count, remaining - 1))
        if (count > 0) {
          const to = m.lineStarts[line + count]
          sheet.push({ block: index, from, to, continues: true, continued: line > 0 })
          line += count
          newSheet()
          continue
        }
      }
      if (sheet.length) {
        newSheet()
        continue
      }
      sheet.push({ block: index, from, to: m.length, continues: false, continued: line > 0 })
      y += height
      previousBottom = m.marginBottom
      return
    }
  })
  if (sheet.length) sheets.push(sheet)
  return sheets
}

function measureBlock(el: HTMLElement, type: StandardBlockData['type']): BlockMetric {
  const style = window.getComputedStyle(el)
  const node = el.firstChild
  const text = node?.textContent ?? ''
  const fontSize = parseFloat(style.fontSize) || 16
  const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.5
  const lineStarts: number[] = []
  if (node) {
    const range = document.createRange()
    let lastTop = -Infinity
    const wordStart = /\S+/g
    for (let match = wordStart.exec(text); match; match = wordStart.exec(text)) {
      range.setStart(node, match.index)
      range.setEnd(node, match.index + 1)
      const top = range.getBoundingClientRect().top
      if (top - lastTop > lineHeight / 2) {
        lineStarts.push(match.index)
        lastTop = top
      }
    }
  }
  return {
    kind: type === 'heading' ? 'heading' : 'text',
    height: el.getBoundingClientRect().height,
    marginTop: parseFloat(style.marginTop) || 0,
    marginBottom: parseFloat(style.marginBottom) || 0,
    lineHeight,
    lineStarts: lineStarts.length ? lineStarts : [0],
    length: text.length,
  }
}

const SHEET_RATIO = 792 / 612

function blockClass(block: StandardBlockData): string {
  const names = [`std-${block.type}`]
  if (block.type === 'heading') names.push(`std-h${Math.min(Math.max(block.level, 1), 3)}`)
  if (block.centered) names.push('std-centered')
  return names.join(' ')
}

function Block({ block, className, children }: { block: StandardBlockData; className?: string; children: ReactNode }) {
  const name = className ? `${blockClass(block)} ${className}` : blockClass(block)
  if (block.type === 'heading') return createElement(`h${Math.min(Math.max(block.level, 1) + 1, 4)}`, { className: name }, children)
  return <p className={name}>{children}</p>
}

export function StandardView({ data, litIds, seenIds, notes, scrollTarget, onNote }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [sheets, setSheets] = useState<SheetFragment[][]>([])

  const pieces = useMemo(() => data.blocks.map((block) => piecesFor(block.runs, notes)), [data.blocks, notes])
  const stateOf = (id: string): StrokeState => (litIds.has(id) ? 'lit' : seenIds.has(id) ? 'seen' : null)

  useLayoutEffect(() => {
    const sheet = measureRef.current
    if (!sheet) return
    const measure = () => {
      const style = window.getComputedStyle(sheet)
      const width = sheet.getBoundingClientRect().width
      const pageHeight = width * SHEET_RATIO - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0)
      const metrics = [...sheet.children].map((el, i) => measureBlock(el as HTMLElement, data.blocks[i].type))
      setSheets(paginate(metrics, pageHeight))
    }
    measure()
    let width = sheet.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const nextWidth = sheet.getBoundingClientRect().width
      if (Math.abs(nextWidth - width) < 0.5) return
      width = nextWidth
      measure()
    })
    observer.observe(sheet)
    let live = true
    void document.fonts?.ready.then(() => { if (live) measure() })
    return () => { live = false; observer.disconnect() }
  }, [data.blocks])

  useEffect(() => {
    if (!scrollTarget || scrollTarget.kind !== 'sentences') return
    const container = ref.current
    if (!container) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(() => {
      for (const id of scrollTarget.ids) {
        const el = container.querySelector(`.std-sheets [data-std="${CSS.escape(id)}"]`)
        if (el) {
          const rect = (el as HTMLElement).getBoundingClientRect()
          window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - window.innerHeight * 0.32), behavior: reduced ? 'auto' : 'smooth' })
          return
        }
      }
    }, 60)
    return () => window.clearTimeout(timer)
  }, [scrollTarget])

  return (
    <div ref={ref} className="std-stage">
      <div className="std-measure" aria-hidden="true">
        <div ref={measureRef} className="std-sheet">
          {data.blocks.map((block, i) => <Block key={i} block={block}>{block.text}</Block>)}
        </div>
      </div>
      <div className="std-sheets sheet-settle">
        {sheets.map((fragments, s) => (
          <article key={s} className="doc-sheet std-sheet">
            {fragments.map((f) => {
              const block = data.blocks[f.block]
              const part = slicePieces(pieces[f.block], f.from, f.to)
              if (part.length && f.continues) part[part.length - 1] = { ...part[part.length - 1], text: part[part.length - 1].text.trimEnd() }
              const names = [f.continues ? 'std-runs-on' : '', f.continued ? 'std-carried' : ''].filter(Boolean).join(' ')
              return (
                <Block key={`${f.block}-${f.from}`} block={block} className={names || undefined}>
                  <StandardInline pieces={part} stateOf={stateOf} onNote={onNote} />
                </Block>
              )
            })}
          </article>
        ))}
      </div>
    </div>
  )
}
