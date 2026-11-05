'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import type { PageNote, Plan, PlanQuestion, Sentence, SentenceState } from '@/lib/types'
import type { VerificationReport } from '@/verify/verify'
import { getReaderId, readerHeaders } from '@/lib/reader-id'
import { voicedSectionIds } from '@/narrate/range'
import { wordAtTime, wordsOf } from '@/narrate/timeline'
import { strings } from '@/ui/strings'
import { ArrowLeftIcon, ArrowRightIcon, MicIcon, NextIcon, OriginalIcon, PauseIcon, PlayIcon, PrevIcon, QaIcon, StandardIcon } from '@/ui/icons'
import { PdfView, type FigureOverlay, type ReaderPageMeta, type ScrollTarget } from './PdfView'
import { StandardView, type StandardData } from './StandardView'
import { GEOMETRY } from './geometry'
import { recordingToWav } from '@/qa/wav'
import { placeNote, placeQuestion, type PlaceContext, type ViewRect } from './placement'
import { canAnswer, clampPlace as clampPlacePure, isLastPointOfSection, modeForPoint, nextPoint, nextSectionPlace, onEnterPoint, previousTarget, questionAfter, type Place, type SectionLike } from './playback'
import { applyMarkResult, effectiveStates, flattenPoints, litSentenceIds, markBatch, parsePlace, placeStorageKey, serializePlace, statesAfterArrival } from './state'

export interface ReaderProps { fingerprint: string; kind: string; filename: string; sentences: Sentence[]; pages: ReaderPageMeta[] }

interface ReadingReply { generated: boolean; isCurrent?: boolean; plan?: Plan; report?: VerificationReport; message?: string }
interface SpeechReply { pointId: string; text: string; sentenceIds: string[]; audioBase64: string; alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }; durationSec: number; cached: boolean }

function toViewRect(r: DOMRect): ViewRect {
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

function placeContext(y: number, drawerOpen: boolean): PlaceContext {
  const sheets = [...document.querySelectorAll('.doc-sheet')].map((el) => toViewRect(el.getBoundingClientRect()))
  const sheet = sheets.find((r) => y >= r.top && y <= r.top + r.height) ?? sheets[0] ?? null
  const width = document.documentElement.clientWidth
  return { sheet, viewport: { width, height: window.innerHeight }, topBar: GEOMETRY.topBarHeight, drawer: drawerOpen ? Math.min(GEOMETRY.drawerWidth, width * 0.92) : 0 }
}

export function Reader({ fingerprint, kind, sentences, pages }: ReaderProps) {
  const [reading, setReading] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'noplan' } | { status: 'ready'; plan: Plan; report: VerificationReport }>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [serverStates, setServerStates] = useState<Record<string, SentenceState>>({})
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set())
  const [passed, setPassed] = useState<ReadonlySet<string>>(new Set())
  const [place, setPlace] = useState<Place>({ section: 0, point: 0 })
  const [restored, setRestored] = useState(false)
  const [view, setView] = useState<'original' | 'standard'>('original')
  const [standard, setStandard] = useState<StandardData | null>(null)
  const [playing, setPlaying] = useState(false)
  const [atSectionEnd, setAtSectionEnd] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [speech, setSpeech] = useState<SpeechReply | null>(null)
  const [wordIndex, setWordIndex] = useState(-1)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [qaOn, setQaOn] = useState(false)
  const [question, setQuestion] = useState<PlanQuestion | null>(null)
  const [answer, setAnswer] = useState('')
  const [qaResponse, setQaResponse] = useState<string | null>(null)
  const [qaBusy, setQaBusy] = useState(false)
  const [micError, setMicError] = useState(false)
  const [micOff, setMicOff] = useState(false)
  const [recording, setRecording] = useState(false)
  const [levels, setLevels] = useState<number[]>([])
  const [notePop, setNotePop] = useState<{ note: PageNote; anchor: ViewRect; scrollY: number } | null>(null)
  const [noteHeight, setNoteHeight] = useState(120)
  const [questionHeight, setQuestionHeight] = useState(280)
  const [, setLayoutTick] = useState(0)
  const notePopRef = useRef<HTMLDivElement | null>(null)
  const questionPopRef = useRef<HTMLDivElement | null>(null)
  const [figure, setFigure] = useState<FigureOverlay | null>(null)
  const [scrollTarget, setScrollTarget] = useState<ScrollTarget>(null)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const cacheRef = useRef(new Map<string, SpeechReply>())
  const loadedRef = useRef<string | null>(null)
  const statesRef = useRef(serverStates); statesRef.current = serverStates
  const gateDoneRef = useRef(new Set<string>())
  const gateTimerRef = useRef<number | null>(null)
  const durationsRef = useRef(new Map<string, number>())
  const elapsedBeforeRef = useRef(0)
  const [playNonce, setPlayNonce] = useState(0)
  const qaResumeRef = useRef(false)
  const mediaRef = useRef<{ rec: MediaRecorder; stream: MediaStream; ctx: AudioContext; raf: number } | null>(null)
  const scrollKeyRef = useRef(0)

  const plan = reading.status === 'ready' ? reading.plan : null
  const flat = useMemo(() => (plan ? flattenPoints(plan) : []), [plan])
  const sections: SectionLike[] = useMemo(() => (plan ? plan.steps.filter((s) => s.points.length > 0).map((s) => ({ id: s.id, title: s.title, pointIds: s.points.map((p) => p.id) })) : []), [plan])
  const cur = clampPlacePure(place, sections)
  const currentStep = plan ? plan.steps.filter((s) => s.points.length > 0)[cur.section] ?? null : null
  const currentPoint = currentStep ? currentStep.points[cur.point] ?? null : null
  const globalIdx = useMemo(() => flat.findIndex((f) => f.point.id === currentPoint?.id), [flat, currentPoint])
  const voicedIds = useMemo(() => {
    if (!plan) return new Set<string>()
    const vs = new Set(voicedSectionIds(fingerprint, plan.steps))
    return new Set(flat.filter((f) => vs.has(f.step.id)).map((f) => f.point.id))
  }, [plan, flat, fingerprint])
  const mode = currentPoint ? modeForPoint(currentPoint.id, voicedIds) : 'voiced'
  const readerId = useMemo(() => { try { return getReaderId() } catch { return '' } }, [])

  const displayStates = useMemo(() => (reading.status === 'ready' ? effectiveStates(reading.report.states, serverStates) : serverStates), [reading, serverStates])
  const litIds = useMemo(() => new Set(currentPoint ? litSentenceIds(flat, Math.max(globalIdx, 0)) : []), [flat, globalIdx, currentPoint])
  const seenIds = useMemo(() => {
    const s = new Set<string>()
    for (const [id, st] of Object.entries(displayStates)) if (st === 'explained' || st === 'understood') s.add(id)
    for (const id of litIds) s.delete(id)
    return s
  }, [displayStates, litIds])

  useEffect(() => {
    const c = new AbortController()
    fetch(`/api/documents/${encodeURIComponent(fingerprint)}/reading`, { cache: 'no-store', signal: c.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as (ReadingReply & { error?: string }) | null
        if (!res.ok || !body) throw new Error(body?.error ?? 'failed')
        if (!body.generated || !body.plan || !body.report) { setReading({ status: 'noplan' }); return }
        setReading({ status: 'ready', plan: body.plan, report: body.report })
      })
      .catch((e: unknown) => { if (!c.signal.aborted) setReading({ status: 'error', message: e instanceof Error ? e.message : 'failed' }) })
    return () => c.abort()
  }, [fingerprint, attempt])

  useEffect(() => {
    if (!readerId) return
    const c = new AbortController()
    fetch(`/api/documents/${encodeURIComponent(fingerprint)}/traces`, { headers: readerHeaders(), cache: 'no-store', signal: c.signal })
      .then(async (res) => {
        if (!res.ok) return
        const body = (await res.json()) as { states?: Record<string, SentenceState>; answers?: { questionId: string }[] }
        if (body.states) setServerStates((p) => ({ ...body.states, ...p }))
        if (Array.isArray(body.answers)) setAnswered(new Set(body.answers.map((a) => a.questionId)))
      })
      .catch(() => undefined)
    return () => c.abort()
  }, [fingerprint, readerId])

  useEffect(() => {
    if (reading.status !== 'ready') return
    fetch(`/api/documents/${encodeURIComponent(fingerprint)}/standard`, { cache: 'no-store' })
      .then(async (res) => { if (res.ok) setStandard((await res.json()) as StandardData) })
      .catch(() => undefined)
  }, [reading.status, fingerprint])

  useEffect(() => {
    try { setQaOn(window.localStorage.getItem('once-qa') === 'on') } catch { /* default off */ }
  }, [])

  useEffect(() => {
    if (reading.status !== 'ready' || restored || sections.length === 0) return
    let raw: string | null = null
    try { raw = window.localStorage.getItem(placeStorageKey(fingerprint)) } catch { raw = null }
    const saved = parsePlace(raw, flat.length)
    if (saved.section !== undefined && saved.point !== undefined) setPlace(clampPlacePure({ section: saved.section, point: saved.point }, sections))
    else if (flat.length > 0) {
      let rest = saved.index
      let done = false
      plan?.steps.filter((s) => s.points.length > 0).forEach((s, si) => {
        if (done) return
        if (rest < s.points.length) { setPlace({ section: si, point: rest }); done = true } else rest -= s.points.length
      })
      if (!done) setPlace({ section: 0, point: 0 })
    }
    setRestored(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading.status, restored, fingerprint, flat.length])

  useEffect(() => {
    if (!restored || reading.status !== 'ready') return
    try {
      window.localStorage.setItem(placeStorageKey(fingerprint), serializePlace({ index: Math.max(globalIdx, 0), section: cur.section, point: cur.point, dismissedGateIds: [] }))
    } catch { /* position is a convenience */ }
  }, [restored, reading.status, fingerprint, globalIdx, cur.section, cur.point])

  const scrollToLit = useCallback(() => {
    if (!currentPoint) return
    scrollKeyRef.current += 1
    setScrollTarget({ kind: 'sentences', ids: [...currentPoint.sentenceIds], key: scrollKeyRef.current })
  }, [currentPoint])

  useEffect(() => {
    if (reading.status !== 'ready' || !restored || !currentPoint) return
    scrollToLit()
    const batch = markBatch(statesRef.current, currentPoint.sentenceIds)
    if (batch.length > 0) {
      setServerStates((p) => statesAfterArrival(p, currentPoint.sentenceIds))
      if (readerId) {
        fetch(`/api/documents/${encodeURIComponent(fingerprint)}/traces/mark`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...readerHeaders() }, body: JSON.stringify({ sentenceIds: batch, state: 'explained' }) })
          .then(async (res) => { if (res.ok) { const b = (await res.json()) as { states?: Record<string, SentenceState> }; if (b.states) setServerStates((p) => applyMarkResult(p, b.states ?? {})) } })
          .catch(() => undefined)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading.status, restored, cur.section, cur.point, fingerprint])

  useEffect(() => {
    if (!currentPoint?.figurePart) { setFigure(null); return }
    let cancelled = false
    fetch(`/api/documents/${encodeURIComponent(fingerprint)}/figure?point=${encodeURIComponent(currentPoint.id)}`, { cache: 'no-store' })
      .then(async (res) => {
        const b = (await res.json().catch(() => null)) as { found?: boolean; page?: number; box?: FigureOverlay['box']; mask?: string | null; maskSize?: FigureOverlay['maskSize'] } | null
        if (cancelled) return
        if (b?.found && b.box && typeof b.page === 'number') {
          setFigure({ page: b.page, box: b.box, mask: b.mask ?? null, maskSize: b.maskSize ?? null })
          scrollKeyRef.current += 1
          setScrollTarget({ kind: 'figure', page: b.page, box: b.box, key: scrollKeyRef.current })
        } else setFigure(null)
      })
      .catch(() => { if (!cancelled) setFigure(null) })
    return () => { cancelled = true }
  }, [currentPoint, fingerprint])

  const fetchSpeech = useCallback(async (pointId: string): Promise<SpeechReply> => {
    const hit = cacheRef.current.get(pointId)
    if (hit) return hit
    const res = await fetch(`/api/documents/${encodeURIComponent(fingerprint)}/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pointId }) })
    const body = (await res.json().catch(() => null)) as (SpeechReply & { error?: string }) | null
    if (!res.ok || !body || typeof body.audioBase64 !== 'string') throw new Error(body?.error ?? 'speech')
    cacheRef.current.set(pointId, body)
    durationsRef.current.set(pointId, body.durationSec)
    return body
  }, [fingerprint])

  const playCurrent = useCallback(async () => {
    const audio = audioRef.current
    if (!audio || !currentPoint) return
    if (gateTimerRef.current) { window.clearTimeout(gateTimerRef.current); gateTimerRef.current = null }
    if (currentPoint.stickingPoints.length > 0 && !gateDoneRef.current.has(currentPoint.id)) {
      gateDoneRef.current.add(currentPoint.id)
      await new Promise<void>((resolve) => { gateTimerRef.current = window.setTimeout(resolve, GEOMETRY.stickingPauseMs) })
    }
    try {
      const reply = await fetchSpeech(currentPoint.id)
      setSpeech(reply)
      setVoiceError(null)
      if (loadedRef.current !== reply.pointId) {
        loadedRef.current = reply.pointId
        audio.src = `data:audio/mpeg;base64,${reply.audioBase64}`
        audio.currentTime = 0
      }
      elapsedBeforeRef.current = 0
      await audio.play()
      const step = plan?.steps.filter((s) => s.points.length > 0)[cur.section]
      const next = step?.points[cur.point + 1]
      if (next && voicedIds.has(next.id)) fetchSpeech(next.id).catch(() => undefined)
    } catch {
      setPlaying(false)
      setVoiceError(strings.reader.speechFailed)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPoint, fetchSpeech, cur.section, plan])

  useEffect(() => {
    if (!playing || !currentPoint || question) return
    if (mode === 'silent') { setDrawerOpen(true); setPlaying(false); return }
    void playCurrent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, cur.section, cur.point, playNonce])

  const goTo = useCallback((target: Place, keepPlaying: boolean) => {
    setAtSectionEnd(false)
    setNotePop(null)
    elapsedBeforeRef.current = 0
    setPlace(clampPlacePure(target, sections))
    if (keepPlaying) setPlayNonce((n) => n + 1)
  }, [sections])

  function afterPointFinished() {
    if (!currentPoint) return
    const askedLite = questionAfter(currentPoint.id, plan?.questions ?? [], new Set([...answered, ...passed]), qaOn)
    const asked = askedLite ? plan?.questions.find((q) => q.id === askedLite.id) ?? null : null
    if (asked) {
      qaResumeRef.current = true
      setPlaying(false)
      audioRef.current?.pause()
      setAnswer(''); setQaResponse(null); setQaBusy(false); setQuestion(asked)
      return
    }
    if (isLastPointOfSection(cur, sections)) { setPlaying(false); setAtSectionEnd(true); return }
    goTo(nextPoint(cur, sections), true)
  }

  const onEnded = useCallback(() => { setWordIndex(-1); loadedRef.current = null; afterPointFinished() }, [currentPoint, answered, passed, qaOn, cur, sections, plan]) // eslint-disable-line react-hooks/exhaustive-deps

  function togglePlay() {
    if (!currentPoint) return
    if (playing) { audioRef.current?.pause(); setPlaying(false); return }
    setVoiceError(null)
    if (mode === 'silent') { setDrawerOpen(true); return }
    setAtSectionEnd(false)
    setPlaying(true)
    setPlayNonce((n) => n + 1)
  }

  function onPrev() {
    const audio = audioRef.current
    const before = (currentStep?.points.slice(0, cur.point) ?? []).reduce((sum, p) => sum + (durationsRef.current.get(p.id) ?? 0), 0)
    const elapsed = before + (audio && !audio.paused ? audio.currentTime : 0)
    const target = previousTarget(cur, elapsed, sections)
    const same = target.section === cur.section && target.point === cur.point
    audio?.pause()
    if (mode === 'silent' && cur.point > 0 && elapsed < GEOMETRY.prevSectionWindowSec) { goTo({ section: cur.section, point: cur.point - 1 }, playing); return }
    goTo(target, playing)
    if (same) setPlayNonce((n) => n + 1)
    if (playing) setPlayNonce((n) => n + 1)
  }

  function onNext() {
    audioRef.current?.pause()
    if (mode === 'silent' && !isLastPointOfSection(cur, sections)) { goTo(nextPoint(cur, sections), false); setDrawerOpen(true); return }
    const target = nextSectionPlace(cur, sections)
    if (target.section === cur.section) return
    setDrawerOpen(false)
    goTo(target, true)
    setPlaying(true)
    setPlayNonce((n) => n + 1)
  }

  useEffect(() => {
    function onSpace(e: KeyboardEvent) {
      if (e.key !== ' ') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return
      e.preventDefault(); togglePlay()
    }
    window.addEventListener('keydown', onSpace)
    return () => window.removeEventListener('keydown', onSpace)
  })

  useLayoutEffect(() => {
    if (notePopRef.current) setNoteHeight(notePopRef.current.offsetHeight)
    if (questionPopRef.current) setQuestionHeight(questionPopRef.current.offsetHeight)
  })

  const popupOpen = notePop !== null || question !== null
  useEffect(() => {
    if (!popupOpen) return
    const reflow = () => setLayoutTick((n) => n + 1)
    window.addEventListener('scroll', reflow, { passive: true })
    window.addEventListener('resize', reflow)
    window.addEventListener('transitionend', reflow)
    return () => {
      window.removeEventListener('scroll', reflow)
      window.removeEventListener('resize', reflow)
      window.removeEventListener('transitionend', reflow)
    }
  }, [popupOpen])

  function onTimeUpdate() {
    const audio = audioRef.current
    if (!audio || !speech || !currentPoint || speech.pointId !== currentPoint.id) return
    const w = wordAtTime(currentPoint.spoken, speech.alignment, audio.currentTime)
    setWordIndex(w ? w.index : -1)
  }

  function onNote(note: PageNote, rect: DOMRect) {
    if (notePop?.note.id === note.id) { setNotePop(null); return }
    // A page note's anchor is a thin rule on the baseline; lift it to the top of its line.
    const lift = rect.height < 8 ? 16 : 0
    setNotePop({ note, anchor: { left: rect.left, top: rect.top - lift, width: rect.width, height: rect.height + lift }, scrollY: window.scrollY })
  }

  function toggleQa() {
    const next = !qaOn
    setQaOn(next)
    try { window.localStorage.setItem('once-qa', next ? 'on' : 'off') } catch { /* session only */ }
  }

  async function checkAnswer() {
    if (!question || !answer.trim() || qaBusy || !canAnswer(answered, question.id)) return
    setQaBusy(true)
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(fingerprint)}/qa`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...readerHeaders() }, body: JSON.stringify({ questionId: question.id, answer }) })
      const body = (await res.json().catch(() => null)) as { response?: string; error?: string } | null
      if (!res.ok || !body?.response) throw new Error('qa')
      setQaResponse(body.response)
      setAnswered((p) => new Set(p).add(question.id))
    } catch { setQaResponse(null) } finally { setQaBusy(false) }
  }

  function continueFromQuestion() {
    if (!question) return
    if (!qaResponse && !answer.trim()) setPassed((p) => new Set(p).add(question.id))
    const wasLast = isLastPointOfSection(cur, sections)
    setQuestion(null); setAnswer(''); setQaResponse(null)
    if (wasLast) { setAtSectionEnd(true); return }
    goTo(nextPoint(cur, sections), true)
    if (qaResumeRef.current) { setPlaying(true); setPlayNonce((n) => n + 1) }
    qaResumeRef.current = false
  }

  async function toggleMic() {
    if (micOff) return
    if (recording && mediaRef.current) {
      mediaRef.current.rec.stop()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser(); analyser.fftSize = 64
      source.connect(analyser)
      const rec = new MediaRecorder(stream)
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      rec.onstop = () => {
        cancelAnimationFrame(mediaRef.current?.raf ?? 0)
        stream.getTracks().forEach((t) => t.stop()); void ctx.close()
        setRecording(false); setLevels([])
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        setMicError(false); setQaBusy(true)
        recordingToWav(blob)
          .then((wav) => { const form = new FormData(); form.set('audio', wav, 'answer.wav'); return fetch(`/api/documents/${encodeURIComponent(fingerprint)}/transcribe`, { method: 'POST', body: form }) })
          .then(async (res) => {
            const b = (await res.json().catch(() => null)) as { text?: string } | null
            if (res.ok && b?.text) setAnswer((p) => (p ? `${p} ${b.text}` : b.text ?? ''))
            else setMicError(true)
          })
          .catch(() => setMicError(true))
          .finally(() => setQaBusy(false))
      }
      const data = new Uint8Array(analyser.frequencyBinCount)
      const loop = () => {
        analyser.getByteFrequencyData(data)
        const bars: number[] = []
        for (let i = 0; i < 12; i++) bars.push(Math.round((data[i * 2] / 255) * 100))
        setLevels(bars)
        mediaRef.current!.raf = requestAnimationFrame(loop)
      }
      mediaRef.current = { rec, stream, ctx, raf: 0 }
      rec.start(); setRecording(true); loop()
    } catch { setMicOff(true); setMicError(true); setRecording(false) }
  }

  const hasOriginal = standard ? standard.hasOriginal : kind === 'pdf' || kind === 'image'
  const showOriginal = view === 'original' && hasOriginal

  if (reading.status === 'loading') {
    return (<main style={{ minHeight: '100vh', padding: '0 20px' }}><header style={{ height: 'var(--topbar)', display: 'flex', alignItems: 'center' }}><Link href="/" style={{ fontSize: 'var(--fs-title)', fontWeight: 600, color: 'var(--moss)', textDecoration: 'none' }}>{strings.appName}</Link></header><div style={{ width: 'min(560px, 100%)', margin: '16vh auto 0' }}><div className="stroke-track"><span className="stroke-bar" /></div><div className="ruled" /><div className="ruled" /></div></main>)
  }
  if (reading.status !== 'ready' || !plan || !currentPoint || !currentStep) {
    return (<main style={{ minHeight: '100vh', padding: '0 20px' }}><header style={{ height: 'var(--topbar)', display: 'flex', alignItems: 'center' }}><Link href="/" style={{ fontSize: 'var(--fs-title)', fontWeight: 600, color: 'var(--moss)', textDecoration: 'none' }}>{strings.appName}</Link></header><div className="sheet sheet-settle" style={{ width: 'min(560px, 100%)', margin: '12vh auto 0', padding: '24px 26px' }}><p style={{ margin: '0 0 16px' }}>{reading.status === 'error' ? reading.message : 'This text has no explanation yet.'}</p>{reading.status === 'error' ? <button type="button" className="cut-btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button> : <Link className="cut-btn" href="/" style={{ textDecoration: 'none', display: 'inline-block' }}>{strings.appName}</Link>}</div></main>)
  }

  const qaPos = (() => {
    if (!question || typeof window === 'undefined') return null
    const litRects = [...document.querySelectorAll('[data-lit="1"], .std-lit')].flatMap((el) => [...el.getClientRects()].map(toViewRect))
    const anchor = litRects[0] ?? { left: window.innerWidth / 2 - 140, top: 140, width: 280, height: 20 }
    return placeQuestion(anchor, litRects, questionHeight, placeContext(anchor.top, drawerOpen))
  })()

  const notePos = (() => {
    if (!notePop || typeof window === 'undefined') return null
    const anchor = { ...notePop.anchor, top: notePop.anchor.top - (window.scrollY - notePop.scrollY) }
    return placeNote(anchor, noteHeight, placeContext(anchor.top, drawerOpen))
  })()

  return (
    <div onClick={() => setNotePop(null)}>
      <header style={{ height: 'var(--topbar)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 22px', flexWrap: 'nowrap', position: 'sticky', top: 0, zIndex: 30, background: 'var(--paper)' }}>
        <Link href="/" aria-label={strings.aria.home} style={{ fontSize: 'var(--fs-title)', fontWeight: 600, color: 'var(--moss)', textDecoration: 'none', whiteSpace: 'nowrap' }}>{strings.appName}</Link>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'nowrap' }}>
          <button type="button" className="icon-btn" aria-label={showOriginal ? strings.aria.viewStandard : strings.aria.viewOriginal} data-tip={showOriginal ? strings.aria.viewStandard : strings.aria.viewOriginal} disabled={!hasOriginal} onClick={() => setView(showOriginal ? 'standard' : 'original')}>{showOriginal ? <StandardIcon /> : <OriginalIcon />}</button>
          <button type="button" className={`icon-btn${qaOn ? ' qa-on' : ''}`} aria-label={qaOn ? strings.aria.qaOn : strings.aria.qaOff} data-tip={qaOn ? strings.aria.qaOn : strings.aria.qaOff} aria-pressed={qaOn} onClick={toggleQa}><QaIcon /></button>
          <button type="button" className="icon-btn" aria-label={strings.aria.previousSection} data-tip={strings.aria.previousSection} onClick={onPrev}><PrevIcon /></button>
          <button type="button" className="icon-btn main" aria-label={playing ? strings.aria.pause : strings.aria.play} data-tip={playing ? strings.aria.pause : strings.aria.play} onClick={togglePlay}>{playing ? <PauseIcon /> : <PlayIcon />}</button>
          <button type="button" className={`icon-btn${atSectionEnd ? ' draw-eye' : ''}`} aria-label={strings.aria.nextSection} data-tip={strings.aria.nextSection} onClick={onNext}><NextIcon /></button>
        </div>
      </header>

      <audio ref={audioRef} onTimeUpdate={onTimeUpdate} onEnded={onEnded} preload="auto" />
      {voiceError ? <p role="alert" style={{ textAlign: 'center', fontSize: 'var(--fs-small)', margin: '8px 20px 0' }}>{voiceError}</p> : null}

      <main style={{ padding: '18px 20px 60px', paddingRight: drawerOpen ? GEOMETRY.drawerWidth + 20 : 20, transition: 'padding 300ms ease-out' }}>
        {showOriginal ? (
          <PdfView fingerprint={fingerprint} kind={kind} pages={pages} sentences={sentences} litIds={litIds} seenIds={seenIds} notes={plan.pageNotes} figure={figure} scrollTarget={scrollTarget} onNote={onNote} />
        ) : standard ? (
          <StandardView data={standard} litIds={litIds} seenIds={seenIds} notes={plan.pageNotes} scrollTarget={scrollTarget} onNote={onNote} />
        ) : (
          <div style={{ width: 'min(560px, 100%)', margin: '10vh auto 0' }}><div className="stroke-track"><span className="stroke-bar" /></div></div>
        )}
      </main>

      <button type="button" aria-label={drawerOpen ? strings.aria.closeTranscript : strings.aria.transcript} title={drawerOpen ? strings.aria.closeTranscript : strings.aria.transcript} onClick={() => setDrawerOpen((v) => !v)}
        style={{ position: 'fixed', right: drawerOpen ? `min(${GEOMETRY.drawerWidth}px, 92vw)` : 0, top: '45vh', width: 30, height: 84, padding: 0, border: 0, cursor: 'pointer', zIndex: 41, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', transition: 'right 300ms ease-out' }}>
        <span className="cut-paper cut-paper-moss" style={{ position: 'absolute', inset: 0 }} />
        <span style={{ position: 'relative', color: 'var(--moss-ink)', display: 'flex' }}>{drawerOpen ? <ArrowRightIcon /> : <ArrowLeftIcon />}</span>
      </button>

      <aside aria-hidden={!drawerOpen} style={{ position: 'fixed', right: 0, top: 'var(--topbar)', bottom: 0, width: GEOMETRY.drawerWidth, maxWidth: '92vw', transform: drawerOpen ? 'none' : 'translateX(100%)', transition: 'transform 300ms ease-out', zIndex: 40 }} className="sheet">
        <div style={{ padding: '26px 28px', overflowY: 'auto', height: '100%', lineHeight: 1.55 }}>
          <p style={{ fontSize: 'var(--fs-title)', margin: '0 0 18px', lineHeight: 1.3 }}>{currentStep.title}</p>
          {currentStep.points.map((point) => {
            const isCurrent = point.id === currentPoint.id
            return (
              <p key={point.id} style={{ margin: '0 0 16px' }}>
                {isCurrent && speech && speech.pointId === point.id
                  ? wordsOf(point.spoken).map((w, i) => (<span key={w.start}>{i > 0 ? point.spoken.slice(wordsOf(point.spoken)[i - 1].end, w.start) : point.spoken.slice(0, w.start)}<span className={i === wordIndex ? 'tx-lit' : undefined}>{w.text}</span></span>))
                  : point.spoken}
                {point.source.kind === 'external' && point.source.url ? (<> <a href={point.source.url} target="_blank" rel="noreferrer" style={{ fontSize: 'var(--fs-small)' }}>{point.source.title ?? point.source.url}</a></>) : null}
              </p>
            )
          })}
        </div>
      </aside>

      {notePop && notePos ? (
        <div ref={notePopRef} className="sheet sheet-settle" role="dialog" style={{ position: 'fixed', left: notePos.left, top: notePos.top, width: notePos.width, maxHeight: 'calc(100vh - var(--topbar) - 22px)', overflowY: 'auto', padding: '16px 18px', zIndex: 50, lineHeight: 1.5 }} onClick={(e) => e.stopPropagation()}>
          {notePop.note.note}
        </div>
      ) : null}

      {question && qaPos ? (
        <div ref={questionPopRef} className="sheet sheet-settle" role="dialog" aria-label={question.question} style={{ position: 'fixed', left: qaPos.left, top: qaPos.top, width: qaPos.width, maxHeight: 'calc(100vh - var(--topbar) - 22px)', overflowY: 'auto', padding: '18px 20px', zIndex: 50, lineHeight: 1.45 }} onClick={(e) => e.stopPropagation()}>
          <p style={{ margin: '0 0 12px' }}>{question.question}</p>
          {qaResponse ? <p style={{ margin: '0 0 12px', whiteSpace: 'pre-wrap' }}>{answer}</p> : null}
          {!qaResponse ? (
            <textarea className="field" rows={3} value={answer} aria-label={question.question} onChange={(e) => setAnswer(e.target.value)} style={{ boxShadow: 'none', background: 'var(--paper)', color: 'var(--ink)', padding: '12px 14px' }} />
          ) : (
            <p style={{ margin: '0 0 12px', whiteSpace: 'pre-wrap' }}>{qaResponse}</p>
          )}
          {qaBusy ? <div className="stroke-track" style={{ margin: '12px 0' }}><span className="stroke-bar" /></div> : null}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
            <button type="button" className="icon-btn" aria-label={strings.aria.microphone} data-tip={strings.aria.microphone} disabled={micOff} onClick={() => void toggleMic()} style={recording ? { color: 'var(--clay)' } : undefined}><MicIcon /></button>
            {recording ? (<span aria-hidden="true" style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 22 }}>{levels.map((lv, i) => (<span key={i} style={{ width: 3, height: `${Math.max(3, (lv / 100) * 22)}px`, background: 'var(--moss)', display: 'inline-block' }} />))}</span>) : null}
            <button type="button" className="cut-btn" disabled={qaBusy} onClick={() => (qaResponse ? continueFromQuestion() : answer.trim() ? void checkAnswer() : continueFromQuestion())}>
              {qaResponse || !answer.trim() ? strings.reader.continue : strings.reader.check}
            </button>
          </div>
          {micError ? <p role="alert" style={{ fontSize: 'var(--fs-small)', margin: '12px 0 0' }}>{strings.reader.micRefused}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
