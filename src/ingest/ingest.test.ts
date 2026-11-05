import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IngestError, ingestFile, ingestText, ingestUrl, isOnlyUrl } from './ingest'

let workDir: string
let previousCwd: string

beforeEach(async () => {
  previousCwd = process.cwd()
  workDir = await mkdtemp(path.join(tmpdir(), 'once-ingest-'))
  process.chdir(workDir)
})

afterEach(async () => {
  process.chdir(previousCwd)
  await rm(workDir, { recursive: true, force: true })
})

describe('ingestFile', () => {
  it('stores the same bytes under two names as one document with one fingerprint', async () => {
    const bytes = new TextEncoder().encode('hello once')

    const first = await ingestFile(bytes, 'paper.txt', 'text')
    const second = await ingestFile(bytes, 'renamed-copy.txt', 'text')

    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(first.alreadyStored).toBe(false)
    expect(second.alreadyStored).toBe(true)
    expect(second.filename).toBe('renamed-copy.txt')
    expect(first.kind).toBe('text')
    expect(first.byteLength).toBe(bytes.byteLength)

    const stored = await readdir(path.join(workDir, 'data', 'originals'))
    expect(stored).toEqual([first.fingerprint])
    const onDisk = await readFile(path.join(workDir, 'data', 'originals', first.fingerprint))
    expect(onDisk).toEqual(Buffer.from(bytes))
  })

  it('gives different bytes a different fingerprint', async () => {
    const first = await ingestFile(new TextEncoder().encode('one'), 'a.txt', 'text')
    const second = await ingestFile(new TextEncoder().encode('two'), 'a.txt', 'text')

    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(second.alreadyStored).toBe(false)

    const stored = await readdir(path.join(workDir, 'data', 'originals'))
    expect(stored.sort()).toEqual([first.fingerprint, second.fingerprint].sort())
  })

  it('rejects an empty file', async () => {
    await expect(ingestFile(new Uint8Array(0), 'empty.txt', 'text')).rejects.toBeInstanceOf(
      IngestError,
    )
    await expect(ingestFile(new Uint8Array(0), 'empty.txt', 'text')).rejects.toThrow(
      'This file is empty. Choose a file that has content.',
    )
  })
})

describe('ingestUrl', () => {
  it('stores a link record and reports a duplicate link as already stored', async () => {
    const first = await ingestUrl('https://example.com/article')
    const second = await ingestUrl('https://example.com/article')

    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(first.alreadyStored).toBe(false)
    expect(second.alreadyStored).toBe(true)
    expect(first.kind).toBe('url')
    expect(first.sourceUrl).toBe('https://example.com/article')

    const stored = await readdir(path.join(workDir, 'data', 'links'))
    expect(stored).toEqual([`${first.fingerprint}.json`])
    const record = await readFile(
      path.join(workDir, 'data', 'links', `${first.fingerprint}.json`),
      'utf8',
    )
    expect(JSON.parse(record)).toEqual({ url: 'https://example.com/article' })
  })

  it('rejects a non-http link', async () => {
    await expect(ingestUrl('ftp://example.com/article')).rejects.toBeInstanceOf(IngestError)
    await expect(ingestUrl('ftp://example.com/article')).rejects.toThrow(
      'Only http or https web page links are supported.',
    )
  })

  it('rejects a malformed link', async () => {
    await expect(ingestUrl('not a link')).rejects.toBeInstanceOf(IngestError)
  })
})

describe('ingestText', () => {
  it('treats pasted text that is only a URL as a link', async () => { expect(isOnlyUrl('https://example.com/a')).toBe(true); const r = await ingestText('https://example.com/a'); expect(r.kind).toBe('url') })
  it('stores pasted text as text', async () => { const r = await ingestText('Some pasted words here.'); expect(r.kind).toBe('text') })
  it('accepts an image file kind', async () => { const r = await ingestFile(new Uint8Array([1,2,3]), 'page.png', 'image'); expect(r.kind).toBe('image') })
})
