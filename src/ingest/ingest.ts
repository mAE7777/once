import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DocumentKind, StoredDocument } from '@/lib/types'
import { registerDocument } from '@/store/store'

export class IngestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IngestError'
  }
}

export interface IngestResult extends StoredDocument {
  alreadyStored: boolean
}

export type FileDocumentKind = Exclude<DocumentKind, 'url'>

const FILE_KINDS: readonly string[] = ['pdf', 'text', 'markdown', 'image']

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function originalsDir(): string {
  return path.join(process.cwd(), 'data', 'originals')
}

function linksDir(): string {
  return path.join(process.cwd(), 'data', 'links')
}

async function writeOnlyIfAbsent(filePath: string, data: Uint8Array | string): Promise<boolean> {
  await mkdir(path.dirname(filePath), { recursive: true })
  try {
    await writeFile(filePath, data, { flag: 'wx' })
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return true
    }
    throw error
  }
}

export async function ingestFile(
  bytes: Uint8Array,
  filename: string,
  kind: FileDocumentKind,
): Promise<IngestResult> {
  if (!bytes || bytes.byteLength === 0) {
    throw new IngestError('This file is empty. Choose a file that has content.')
  }
  if (!filename || filename.trim().length === 0) {
    throw new IngestError('The file name is missing.')
  }
  if (!FILE_KINDS.includes(kind)) {
    throw new IngestError('This file type is not supported. Upload a PDF, .txt, .md or image file.')
  }

  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const fingerprint = sha256Hex(buffer)
  const target = path.join(originalsDir(), fingerprint)
  const alreadyStored = await writeOnlyIfAbsent(target, buffer)
  registerDocument({ fingerprint, kind, filename, byteLength: buffer.byteLength })

  return {
    fingerprint,
    filename,
    kind,
    byteLength: buffer.byteLength,
    alreadyStored,
  }
}

export async function ingestUrl(rawUrl: string): Promise<IngestResult> {
  if (!rawUrl || rawUrl.trim().length === 0) {
    throw new IngestError('The link is empty. Paste a web page link.')
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new IngestError('This link is not valid. Paste the full web page link.')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new IngestError('Only http or https web page links are supported.')
  }
  if (!parsed.hostname) {
    throw new IngestError('This link has no web address. Paste the full web page link.')
  }

  const sourceUrl = parsed.href
  const fingerprint = sha256Hex(sourceUrl)
  const record = JSON.stringify({ url: sourceUrl })
  const target = path.join(linksDir(), `${fingerprint}.json`)
  const alreadyStored = await writeOnlyIfAbsent(target, record)
  registerDocument({
    fingerprint,
    kind: 'url',
    filename: sourceUrl,
    byteLength: Buffer.byteLength(record, 'utf8'),
    sourceUrl,
  })

  return {
    fingerprint,
    filename: sourceUrl,
    kind: 'url',
    byteLength: Buffer.byteLength(record, 'utf8'),
    sourceUrl,
    alreadyStored,
  }
}

function pastedTitle(text: string): string {
  const firstLine = text.trim().split(/\n/)[0].trim()
  if (firstLine.length <= 70) return firstLine
  const cut = firstLine.slice(0, 70)
  return `${cut.slice(0, cut.lastIndexOf(' ')).trimEnd()}…`
}

export function isOnlyUrl(text:string):boolean{ const s=text.trim(); if(!s||/\s/.test(s)) return false; try{const u=new URL(s); return u.protocol==='http:'||u.protocol==='https:'}catch{return false} }
export async function ingestText(text:string):Promise<IngestResult>{
  if(!text||!text.trim()) throw new IngestError('Paste some text first.')
  if(isOnlyUrl(text)) return ingestUrl(text.trim())
  const buf=Buffer.from(text,'utf8'); const fingerprint=sha256Hex(buf); const target=path.join(originalsDir(),fingerprint); const alreadyStored=await writeOnlyIfAbsent(target,buf); registerDocument({fingerprint,kind:'text',filename:pastedTitle(text),byteLength:buf.byteLength}); return {fingerprint,filename:'Pasted text',kind:'text',byteLength:buf.byteLength,alreadyStored}
}
export function titleForDocument(filename:string, fullText?:string|null, sourceUrl?:string|null):string{
  if(fullText){ const lines=fullText.split(/\n/).map(s=>s.replace(/^#+\s*/,'').trim()).filter(Boolean); const first=lines.find(l=>l.length>=8&&l.length<=120&&!l.endsWith('.')&&!/permission|copyright|reproduce|grants/i.test(l)); if(first) return first; const words=fullText.trim().split(/\s+/).slice(0,8).join(' '); if(words) return words }
  if(filename&&filename!==sourceUrl&&!filename.startsWith('http')) return filename
  return filename||'Untitled'
}
