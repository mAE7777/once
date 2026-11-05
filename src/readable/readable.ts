import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DocumentKind, ReadableDocument, ReadablePage } from '@/lib/types'
import { MetaApiError } from '@/lib/meta'
import { extractPdfPages, PdfReadableError } from './pdf'
import { blocksToItems, readPageBlocks } from './ocr'
import { fetchArticleText, UrlReadableError } from './url'

export class ReadableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReadableError'
  }
}

export class DocumentNotFoundError extends ReadableError {
  constructor(message = 'This document was not found.') {
    super(message)
    this.name = 'DocumentNotFoundError'
  }
}

export interface MakeReadableOptions {
  fetchImpl?: typeof fetch
  metaFetchImpl?: typeof fetch
}

function originalPath(fingerprint: string): string {
  return path.join(process.cwd(), 'data', 'originals', fingerprint)
}

function linkPath(fingerprint: string): string {
  return path.join(process.cwd(), 'data', 'links', `${fingerprint}.json`)
}

function readablePath(fingerprint: string): string {
  return path.join(process.cwd(), 'data', 'readable', `${fingerprint}.json`)
}

function assertFingerprint(fingerprint: string): void {
  if (!/^[0-9a-f]{64}$/i.test(fingerprint)) {
    throw new DocumentNotFoundError()
  }
}

function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  )
}

async function readCached(fingerprint: string): Promise<ReadableDocument | null> {
  try {
    const raw = await readFile(readablePath(fingerprint), 'utf8')
    return JSON.parse(raw) as ReadableDocument
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function saveReadable(document: ReadableDocument): Promise<void> {
  const target = readablePath(document.fingerprint)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(document), 'utf8')
}

function singleTextPage(text: string): ReadablePage[] {
  return [{ page: 1, width: 0, height: 0, text, items: [], isScan: false }]
}

function buildDocument(
  fingerprint: string,
  kind: DocumentKind,
  pages: ReadablePage[],
): ReadableDocument {
  return {
    fingerprint,
    kind,
    pageCount: pages.length,
    fullText: pages.map((page) => page.text).join('\n'),
    pages,
  }
}

async function readableFromUrl(
  fingerprint: string,
  options: MakeReadableOptions,
): Promise<ReadableDocument> {
  const raw = await readFile(linkPath(fingerprint), 'utf8')
  let url = ''
  try {
    const record = JSON.parse(raw) as { url?: unknown }
    if (typeof record.url === 'string') url = record.url
  } catch {
    url = ''
  }
  if (!url) {
    throw new ReadableError('This link record is incomplete, so the web page cannot be opened.')
  }
  const text = await fetchArticleText(url, options.fetchImpl ?? fetch)
  return buildDocument(fingerprint, 'url', singleTextPage(text))
}

async function readableFromOriginal(
  fingerprint: string,
  options: MakeReadableOptions,
): Promise<ReadableDocument> {
  const bytes = await readFile(originalPath(fingerprint))
  if (isPdf(bytes)) {
    const pages = await extractPdfPages(bytes, fingerprint, {
      metaFetchImpl: options.metaFetchImpl ?? options.fetchImpl,
    })
    return buildDocument(fingerprint, 'pdf', pages)
  }
  if (bytes[0]===0xff&&bytes[1]===0xd8||bytes.slice(0,4).toString('latin1')==='\x89PNG'||bytes.slice(0,4).toString('latin1')==='RIFF') {
    const blocks = await readPageBlocks(bytes, options.metaFetchImpl ?? options.fetchImpl ?? fetch)
    const width=1000, height=1000; const items=blocksToItems(blocks,width,height)
    return buildDocument(fingerprint, 'image', [{ page:1, width, height, text: blocks.map(b=>b.text).join('\n'), items, isScan:true, blocks }])
  }
  const text = new TextDecoder('utf-8').decode(bytes)
  return buildDocument(fingerprint, 'text', singleTextPage(text))
}

export async function makeReadable(
  fingerprint: string,
  options: MakeReadableOptions = {},
): Promise<ReadableDocument> {
  assertFingerprint(fingerprint)

  const cached = await readCached(fingerprint)
  if (cached) return cached

  let document: ReadableDocument
  try {
    try {
      await readFile(linkPath(fingerprint))
      document = await readableFromUrl(fingerprint, options)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        document = await readableFromOriginal(fingerprint, options)
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new DocumentNotFoundError()
        }
        throw inner
      }
    }
  } catch (error) {
    if (
      error instanceof DocumentNotFoundError ||
      error instanceof ReadableError ||
      error instanceof PdfReadableError ||
      error instanceof UrlReadableError ||
      error instanceof MetaApiError
    ) {
      throw error
    }
    throw error
  }

  await saveReadable(document)
  return document
}

export { PdfReadableError, UrlReadableError, MetaApiError }
