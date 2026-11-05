import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  backfillDocuments,
  closeDb,
  countByState,
  ensureReader,
  getArtifact,
  getDocument,
  getSentenceStates,
  listArtifacts,
  listDocuments,
  putArtifact,
  readArtifact,
  registerDocument,
  resetStoreForTests,
  setSentenceState,
} from './store'
import { ingestFile } from '@/ingest/ingest'
import { GET } from '../../app/api/documents/route'

let workDir: string
let previousCwd: string

function fp(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

beforeEach(async () => {
  previousCwd = process.cwd()
  workDir = await mkdtemp(path.join(tmpdir(), 'once-store-'))
  process.chdir(workDir)
  resetStoreForTests()
})

afterEach(async () => {
  closeDb()
  process.chdir(previousCwd)
  await rm(workDir, { recursive: true, force: true })
})

describe('registerDocument', () => {
  it('is idempotent: the second call reports alreadyKnown and keeps one row', () => {
    const fingerprint = fp('hello once')
    const first = registerDocument({
      fingerprint,
      kind: 'text',
      filename: 'paper.txt',
      byteLength: 10,
    })
    const second = registerDocument({
      fingerprint,
      kind: 'text',
      filename: 'paper.txt',
      byteLength: 10,
    })

    expect(first).toEqual({ alreadyKnown: false })
    expect(second).toEqual({ alreadyKnown: true })
    expect(listDocuments()).toHaveLength(1)
    expect(getDocument(fingerprint)).toMatchObject({
      fingerprint,
      kind: 'text',
      filename: 'paper.txt',
      byteLength: 10,
      sourceUrl: null,
    })
  })

  it('treats a changed byte (different fingerprint) as a second document', () => {
    const first = fp('hello once')
    const second = fp('hello oncf')

    registerDocument({ fingerprint: first, kind: 'text', filename: 'a.txt', byteLength: 10 })
    const result = registerDocument({
      fingerprint: second,
      kind: 'text',
      filename: 'a.txt',
      byteLength: 10,
    })

    expect(result).toEqual({ alreadyKnown: false })
    expect(listDocuments().map((doc) => doc.fingerprint)).toEqual([second, first])
  })

  it('returns null for an unknown fingerprint', () => {
    expect(getDocument(fp('nope'))).toBeNull()
  })
})

describe('putArtifact / getArtifact', () => {
  it('reuses an identical version without rewriting the file', async () => {
    const fingerprint = fp('artifact doc')
    registerDocument({ fingerprint, kind: 'text', filename: 'a.txt', byteLength: 12 })

    const first = putArtifact({
      fingerprint,
      kind: 'plan',
      key: 'main',
      model: 'model-a',
      promptVersion: 'v1',
      data: Buffer.from('plan v1', 'utf8'),
    })
    expect(first.reused).toBe(false)

    const absolute = path.join(workDir, first.path)
    expect(await readFile(absolute, 'utf8')).toBe('plan v1')
    const past = new Date('2001-01-01T00:00:00.000Z')
    utimesSync(absolute, past, past)
    const before = await stat(absolute)

    const second = putArtifact({
      fingerprint,
      kind: 'plan',
      key: 'main',
      model: 'model-a',
      promptVersion: 'v1',
      data: Buffer.from('different bytes that must not be written', 'utf8'),
    })
    const after = await stat(absolute)

    expect(second).toEqual({ path: first.path, reused: true })
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(await readFile(absolute, 'utf8')).toBe('plan v1')
    expect(listArtifacts(fingerprint, 'plan')).toHaveLength(1)
  })

  it('stores a new row for a new promptVersion and flags the old version as not current', () => {
    const fingerprint = fp('versioned doc')
    registerDocument({ fingerprint, kind: 'text', filename: 'a.txt', byteLength: 13 })

    const v1 = putArtifact({
      fingerprint,
      kind: 'plan',
      key: 'main',
      model: 'model-a',
      promptVersion: 'v1',
      data: Buffer.from('plan v1', 'utf8'),
    })

    const wantedV2 = getArtifact(fingerprint, 'plan', 'main', { promptVersion: 'v2' })
    expect(wantedV2).not.toBeNull()
    expect(wantedV2?.path).toBe(v1.path)
    expect(wantedV2?.promptVersion).toBe('v1')
    expect(wantedV2?.isCurrent).toBe(false)

    const wantedV1 = getArtifact(fingerprint, 'plan', 'main', {
      model: 'model-a',
      promptVersion: 'v1',
    })
    expect(wantedV1?.isCurrent).toBe(true)

    const v2 = putArtifact({
      fingerprint,
      kind: 'plan',
      key: 'main',
      model: 'model-a',
      promptVersion: 'v2',
      data: Buffer.from('plan v2', 'utf8'),
    })
    expect(v2.reused).toBe(false)
    expect(v2.path).not.toBe(v1.path)

    const newest = getArtifact(fingerprint, 'plan', 'main', { promptVersion: 'v2' })
    expect(newest?.path).toBe(v2.path)
    expect(newest?.isCurrent).toBe(true)

    expect(listArtifacts(fingerprint, 'plan').map((row) => row.promptVersion)).toEqual([
      'v2',
      'v1',
    ])
    expect(getArtifact(fingerprint, 'plan', 'missing')).toBeNull()
  })
})

describe('a second upload of identical content', () => {
  it('lands on the same document and finds the stored plan without any network call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const bytes = Buffer.from('the same text under two names', 'utf8')
      const first = await ingestFile(bytes, 'first.txt', 'text')
      const stored = putArtifact({
        fingerprint: first.fingerprint,
        kind: 'plan',
        key: 'main',
        model: 'model-a',
        promptVersion: 'v1',
        data: Buffer.from('{"steps":[]}', 'utf8'),
      })

      const second = await ingestFile(bytes, 'renamed.txt', 'text')
      const found = getArtifact(second.fingerprint, 'plan', 'main', {
        model: 'model-a',
        promptVersion: 'v1',
      })

      expect(second.fingerprint).toBe(first.fingerprint)
      expect(second.alreadyStored).toBe(true)
      expect(listDocuments()).toHaveLength(1)
      expect(found?.isCurrent).toBe(true)
      expect(readArtifact(found?.path ?? '').toString('utf8')).toBe('{"steps":[]}')
      expect(found?.path).toBe(stored.path)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('sentence states', () => {
  it('keeps two readers fully independent and counts by state', () => {
    const fingerprint = fp('shared doc')
    ensureReader('reader-1')
    ensureReader('reader-2')

    setSentenceState('reader-1', fingerprint, 's1', 'understood')
    setSentenceState('reader-1', fingerprint, 's2', 'explained')
    setSentenceState('reader-2', fingerprint, 's1', 'skippable')

    expect(getSentenceStates('reader-1', fingerprint)).toEqual({
      s1: 'understood',
      s2: 'explained',
    })
    expect(getSentenceStates('reader-2', fingerprint)).toEqual({ s1: 'skippable' })
    expect(getSentenceStates('reader-1', fingerprint)).not.toHaveProperty('s3')

    expect(countByState('reader-1', fingerprint)).toEqual({
      understood: 1,
      explained: 1,
      skippable: 0,
      uncovered: 0,
    })
    expect(countByState('reader-2', fingerprint)).toEqual({
      understood: 0,
      explained: 0,
      skippable: 1,
      uncovered: 0,
    })
  })

  it('updates an existing sentence state instead of duplicating it', () => {
    const fingerprint = fp('shared doc')
    setSentenceState('reader-1', fingerprint, 's1', 'uncovered')
    setSentenceState('reader-1', fingerprint, 's1', 'understood')

    expect(getSentenceStates('reader-1', fingerprint)).toEqual({ s1: 'understood' })
    expect(countByState('reader-1', fingerprint)).toEqual({
      understood: 1,
      explained: 0,
      skippable: 0,
      uncovered: 0,
    })
  })
})

describe('persistence', () => {
  it('survives close and reopen in the same cwd', async () => {
    const fingerprint = fp('persistent doc')
    registerDocument({ fingerprint, kind: 'text', filename: 'keep.txt', byteLength: 14 })
    putArtifact({
      fingerprint,
      kind: 'plan',
      key: 'main',
      model: 'model-a',
      promptVersion: 'v1',
      data: Buffer.from('kept', 'utf8'),
    })
    setSentenceState('reader-1', fingerprint, 's1', 'explained')

    closeDb()

    expect(getDocument(fingerprint)?.filename).toBe('keep.txt')
    expect(getArtifact(fingerprint, 'plan', 'main')?.isCurrent).toBe(true)
    expect(getSentenceStates('reader-1', fingerprint)).toEqual({ s1: 'explained' })
    await expect(stat(path.join(workDir, 'data', 'once.db'))).resolves.toBeTruthy()
  })
})

describe('backfillDocuments', () => {
  it('registers originals and links that have no document row yet', async () => {
    const textFingerprint = fp('plain text body')
    await mkdir(path.join(workDir, 'data', 'originals'), { recursive: true })
    await writeFile(
      path.join(workDir, 'data', 'originals', textFingerprint),
      'plain text body',
      'utf8',
    )

    const pdfBytes = Buffer.from('%PDF-1.4 fake pdf body', 'latin1')
    const pdfFingerprint = createHash('sha256').update(pdfBytes).digest('hex')
    await writeFile(path.join(workDir, 'data', 'originals', pdfFingerprint), pdfBytes)

    const url = 'https://example.com/article'
    const linkFingerprint = fp(url)
    await mkdir(path.join(workDir, 'data', 'links'), { recursive: true })
    await writeFile(
      path.join(workDir, 'data', 'links', `${linkFingerprint}.json`),
      JSON.stringify({ url }),
      'utf8',
    )

    expect(listDocuments()).toEqual([])

    const registered = backfillDocuments()

    expect(registered).toBe(3)
    const byFingerprint = new Map(listDocuments().map((doc) => [doc.fingerprint, doc]))
    expect(byFingerprint.get(textFingerprint)).toMatchObject({
      kind: 'text',
      filename: '',
      byteLength: Buffer.byteLength('plain text body', 'utf8'),
    })
    expect(byFingerprint.get(pdfFingerprint)).toMatchObject({ kind: 'pdf', filename: '' })
    expect(byFingerprint.get(linkFingerprint)).toMatchObject({
      kind: 'url',
      sourceUrl: url,
    })

    expect(backfillDocuments()).toBe(0)
    expect(listDocuments()).toHaveLength(3)
  })
})

describe('GET /api/documents', () => {
  it('backfills unregistered originals and lists them', async () => {
    const fingerprint = fp('route body')
    await mkdir(path.join(workDir, 'data', 'originals'), { recursive: true })
    await writeFile(path.join(workDir, 'data', 'originals', fingerprint), 'route body', 'utf8')

    const response = await GET()

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      documents: { fingerprint: string; kind: string; filename: string }[]
    }
    expect(body.documents).toEqual([
      expect.objectContaining({ fingerprint, kind: 'text', filename: '' }),
    ])
  })
})
