import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type {
  ArtifactLookup,
  ArtifactRecord,
  DocumentKind,
  DocumentRecord,
  GetArtifactOptions,
  PutArtifactInput,
  PutArtifactResult,
  RegisterDocumentInput,
  RegisterDocumentResult,
  SentenceState,
} from '@/lib/types'

const SENTENCE_STATES: readonly SentenceState[] = [
  'understood',
  'explained',
  'skippable',
  'uncovered',
]

const DOCUMENT_KINDS: readonly string[] = ['pdf', 'text', 'markdown', 'url']

let db: Database.Database | null = null
let dbFile: string | null = null

function dataDir(): string {
  return path.join(process.cwd(), 'data')
}

function dbPath(): string {
  return path.join(dataDir(), 'once.db')
}

function nowIso(): string {
  return new Date().toISOString()
}

function createTables(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      fingerprint TEXT PRIMARY KEY,
      kind TEXT,
      filename TEXT,
      byte_length INTEGER,
      source_url TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY,
      fingerprint TEXT,
      kind TEXT,
      key TEXT,
      path TEXT,
      model TEXT,
      prompt_version TEXT,
      created_at TEXT,
      UNIQUE(fingerprint, kind, key, model, prompt_version)
    );
    CREATE TABLE IF NOT EXISTS readers (
      id TEXT PRIMARY KEY,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sentence_states (
      reader_id TEXT,
      fingerprint TEXT,
      sentence_id TEXT,
      state TEXT CHECK(state IN ('understood', 'explained', 'skippable', 'uncovered')),
      PRIMARY KEY(reader_id, fingerprint, sentence_id)
    );
  `)
}

export function getDb(): Database.Database {
  const file = dbPath()
  if (db && dbFile === file) {
    return db
  }
  if (db) {
    db.close()
    db = null
    dbFile = null
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const conn = new Database(file)
  conn.pragma('journal_mode = WAL')
  createTables(conn)
  db = conn
  dbFile = file
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
    dbFile = null
  }
}

export function resetStoreForTests(): void {
  closeDb()
}

interface DocumentRow {
  fingerprint: string
  kind: string
  filename: string
  byte_length: number
  source_url: string | null
  created_at: string
}

interface ArtifactRow {
  fingerprint: string
  kind: string
  key: string
  path: string
  model: string
  prompt_version: string
  created_at: string
}

function toDocumentRecord(row: DocumentRow): DocumentRecord {
  return {
    fingerprint: row.fingerprint,
    kind: row.kind as DocumentKind,
    filename: row.filename,
    byteLength: row.byte_length,
    sourceUrl: row.source_url,
    createdAt: row.created_at,
  }
}

function toArtifactRecord(row: ArtifactRow): ArtifactRecord {
  return {
    fingerprint: row.fingerprint,
    kind: row.kind,
    key: row.key,
    path: row.path,
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  }
}

export function registerDocument(input: RegisterDocumentInput): RegisterDocumentResult {
  const conn = getDb()
  const existing = conn
    .prepare('SELECT fingerprint, filename, source_url FROM documents WHERE fingerprint = ?')
    .get(input.fingerprint) as
    | { fingerprint: string; filename: string; source_url: string | null }
    | undefined

  if (existing) {
    const filename =
      existing.filename === '' && input.filename ? input.filename : existing.filename
    const sourceUrl = existing.source_url ?? input.sourceUrl ?? null
    if (filename !== existing.filename || sourceUrl !== existing.source_url) {
      conn
        .prepare('UPDATE documents SET filename = ?, source_url = ? WHERE fingerprint = ?')
        .run(filename, sourceUrl, input.fingerprint)
    }
    return { alreadyKnown: true }
  }

  conn
    .prepare(
      'INSERT INTO documents (fingerprint, kind, filename, byte_length, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      input.fingerprint,
      input.kind,
      input.filename,
      input.byteLength,
      input.sourceUrl ?? null,
      nowIso(),
    )
  return { alreadyKnown: false }
}

export function getDocument(fingerprint: string): DocumentRecord | null {
  const row = getDb()
    .prepare(
      'SELECT fingerprint, kind, filename, byte_length, source_url, created_at FROM documents WHERE fingerprint = ?',
    )
    .get(fingerprint) as DocumentRow | undefined
  return row ? toDocumentRecord(row) : null
}

export function listDocuments(): DocumentRecord[] {
  const rows = getDb()
    .prepare(
      'SELECT fingerprint, kind, filename, byte_length, source_url, created_at FROM documents ORDER BY created_at DESC, rowid DESC',
    )
    .all() as DocumentRow[]
  return rows.map(toDocumentRecord)
}

function artifactFilename(kind: string, key: string, model: string, promptVersion: string): string {
  const suffix = createHash('sha256')
    .update(key + model + promptVersion)
    .digest('hex')
    .slice(0, 16)
  return `${kind}-${suffix}.bin`
}

export function putArtifact(input: PutArtifactInput): PutArtifactResult {
  const conn = getDb()
  const existing = conn
    .prepare(
      'SELECT path FROM artifacts WHERE fingerprint = ? AND kind = ? AND key = ? AND model = ? AND prompt_version = ?',
    )
    .get(input.fingerprint, input.kind, input.key, input.model, input.promptVersion) as
    | { path: string }
    | undefined

  if (existing) {
    return { path: existing.path, reused: true }
  }

  const filename = artifactFilename(input.kind, input.key, input.model, input.promptVersion)
  const relative = path.posix.join('data', 'artifacts', input.fingerprint, filename)
  const absolute = path.join(process.cwd(), 'data', 'artifacts', input.fingerprint, filename)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, input.data)

  try {
    conn
      .prepare(
        'INSERT INTO artifacts (fingerprint, kind, key, path, model, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.fingerprint,
        input.kind,
        input.key,
        relative,
        input.model,
        input.promptVersion,
        nowIso(),
      )
  } catch (error) {
    const raced = conn
      .prepare(
        'SELECT path FROM artifacts WHERE fingerprint = ? AND kind = ? AND key = ? AND model = ? AND prompt_version = ?',
      )
      .get(input.fingerprint, input.kind, input.key, input.model, input.promptVersion) as
      | { path: string }
      | undefined
    if (raced) {
      return { path: raced.path, reused: true }
    }
    throw error
  }

  return { path: relative, reused: false }
}

export function getArtifact(
  fingerprint: string,
  kind: string,
  key: string,
  options: GetArtifactOptions = {},
): ArtifactLookup | null {
  const row = getDb()
    .prepare(
      'SELECT fingerprint, kind, key, path, model, prompt_version, created_at FROM artifacts WHERE fingerprint = ? AND kind = ? AND key = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    )
    .get(fingerprint, kind, key) as ArtifactRow | undefined

  if (!row) return null

  const modelMatches = options.model === undefined || options.model === row.model
  const promptMatches =
    options.promptVersion === undefined || options.promptVersion === row.prompt_version

  return {
    path: row.path,
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
    isCurrent: modelMatches && promptMatches,
  }
}

export function readArtifact(artifactPath: string): Buffer {
  return readFileSync(path.join(/*turbopackIgnore: true*/ process.cwd(), artifactPath))
}

export function listArtifacts(fingerprint: string, kind?: string): ArtifactRecord[] {
  const conn = getDb()
  const rows = (
    kind === undefined
      ? conn
          .prepare(
            'SELECT fingerprint, kind, key, path, model, prompt_version, created_at FROM artifacts WHERE fingerprint = ? ORDER BY created_at DESC, id DESC',
          )
          .all(fingerprint)
      : conn
          .prepare(
            'SELECT fingerprint, kind, key, path, model, prompt_version, created_at FROM artifacts WHERE fingerprint = ? AND kind = ? ORDER BY created_at DESC, id DESC',
          )
          .all(fingerprint, kind)
  ) as ArtifactRow[]
  return rows.map(toArtifactRecord)
}

export function ensureReader(id: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO readers (id, created_at) VALUES (?, ?)')
    .run(id, nowIso())
}

export function setSentenceState(
  readerId: string,
  fingerprint: string,
  sentenceId: string,
  state: SentenceState,
): void {
  ensureReader(readerId)
  getDb()
    .prepare(
      'INSERT INTO sentence_states (reader_id, fingerprint, sentence_id, state) VALUES (?, ?, ?, ?) ON CONFLICT(reader_id, fingerprint, sentence_id) DO UPDATE SET state = excluded.state',
    )
    .run(readerId, fingerprint, sentenceId, state)
}

export function getSentenceStates(
  readerId: string,
  fingerprint: string,
): Record<string, SentenceState> {
  const rows = getDb()
    .prepare(
      'SELECT sentence_id, state FROM sentence_states WHERE reader_id = ? AND fingerprint = ?',
    )
    .all(readerId, fingerprint) as { sentence_id: string; state: SentenceState }[]
  const result: Record<string, SentenceState> = {}
  for (const row of rows) {
    result[row.sentence_id] = row.state
  }
  return result
}

export function countByState(
  readerId: string,
  fingerprint: string,
): Record<SentenceState, number> {
  const counts: Record<SentenceState, number> = {
    understood: 0,
    explained: 0,
    skippable: 0,
    uncovered: 0,
  }
  const rows = getDb()
    .prepare(
      'SELECT state, COUNT(*) AS n FROM sentence_states WHERE reader_id = ? AND fingerprint = ? GROUP BY state',
    )
    .all(readerId, fingerprint) as { state: SentenceState; n: number }[]
  for (const row of rows) {
    if (SENTENCE_STATES.includes(row.state)) {
      counts[row.state] = row.n
    }
  }
  return counts
}

function listDirFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => {
    if (name.startsWith('.')) return false
    try {
      return statSync(path.join(dir, name)).isFile()
    } catch {
      return false
    }
  })
}

function readableKind(fingerprint: string): DocumentKind | null {
  const file = path.join(dataDir(), 'readable', `${fingerprint}.json`)
  if (!existsSync(file)) return null
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as { kind?: unknown }
    if (typeof record.kind === 'string' && DOCUMENT_KINDS.includes(record.kind)) {
      return record.kind as DocumentKind
    }
  } catch {
    return null
  }
  return null
}

function kindFromOriginal(absolute: string, fingerprint: string): DocumentKind {
  const fromReadable = readableKind(fingerprint)
  if (fromReadable) return fromReadable
  try {
    const head = readFileSync(absolute).subarray(0, 4)
    if (head.length >= 4 && head.toString('latin1') === '%PDF') {
      return 'pdf'
    }
  } catch {
    return 'text'
  }
  return 'text'
}

export function backfillDocuments(): number {
  let registered = 0

  const linksDir = path.join(dataDir(), 'links')
  for (const name of listDirFiles(linksDir)) {
    if (!name.endsWith('.json')) continue
    const fingerprint = name.slice(0, -'.json'.length)
    if (!fingerprint) continue
    if (getDocument(fingerprint)) continue
    const absolute = path.join(linksDir, name)
    let sourceUrl: string | undefined
    try {
      const record = JSON.parse(readFileSync(absolute, 'utf8')) as { url?: unknown }
      if (typeof record.url === 'string' && record.url) sourceUrl = record.url
    } catch {
      sourceUrl = undefined
    }
    let byteLength = 0
    try {
      byteLength = statSync(absolute).size
    } catch {
      byteLength = 0
    }
    const result = registerDocument({
      fingerprint,
      kind: 'url',
      filename: sourceUrl ?? '',
      byteLength,
      sourceUrl,
    })
    if (!result.alreadyKnown) registered += 1
  }

  const originalsDir = path.join(dataDir(), 'originals')
  for (const name of listDirFiles(originalsDir)) {
    const fingerprint = name
    if (getDocument(fingerprint)) continue
    const absolute = path.join(originalsDir, name)
    let byteLength = 0
    try {
      byteLength = statSync(absolute).size
    } catch {
      byteLength = 0
    }
    const result = registerDocument({
      fingerprint,
      kind: kindFromOriginal(absolute, fingerprint),
      filename: '',
      byteLength,
    })
    if (!result.alreadyKnown) registered += 1
  }

  return registered
}
