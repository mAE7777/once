import type Database from 'better-sqlite3'
import { OnceError } from '@/errors/errors'
import type { SentenceState } from '@/lib/types'
import { ensureReader, getDb, getSentenceStates, setSentenceState } from '@/store/store'

export const MAX_TEXT_LENGTH = 20_000

const READER_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

/** A later mark only takes effect when it ranks above the state already stored. */
const STATE_RANK: Record<SentenceState, number> = {
  uncovered: 0,
  skippable: 1,
  explained: 2,
  understood: 3,
}

export class TraceInputError extends OnceError {
  constructor(message: string) {
    super(400, message)
  }
}

export interface AnswerAttempt { id: number; fingerprint: string; questionId: string; answer: string; correct: boolean; correction: string | null; sentenceIds: string[]; createdAt: string }
export interface ReadingState { states: Record<string, import('@/lib/types').SentenceState>; answers: AnswerAttempt[] }
export interface RecordAnswerInput {
  readerId: string
  fingerprint: string
  questionId: string
  answer: string
  correct: boolean
  correction?: string | null
  sentenceIds: string[]
}




export function isReaderId(value: unknown): value is string {
  return typeof value === 'string' && READER_ID_PATTERN.test(value)
}

const preparedConnections = new WeakSet<Database.Database>()

function database(): Database.Database {
  const conn = getDb()
  if (!preparedConnections.has(conn)) {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS reader_answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reader_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        question_id TEXT NOT NULL,
        answer TEXT NOT NULL,
        correct INTEGER NOT NULL CHECK(correct IN (0, 1)),
        correction TEXT,
        sentence_ids TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reader_answers_by_reading
        ON reader_answers (reader_id, fingerprint);
      CREATE TABLE IF NOT EXISTS reader_notes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        reader_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        sentence_ids TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reader_notes_by_reading
        ON reader_notes (reader_id, fingerprint);
    `)
    preparedConnections.add(conn)
  }
  return conn
}

function requireKey(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new TraceInputError(`A ${name} is required.`)
  }
  return value
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TraceInputError(`The ${name} cannot be empty.`)
  }
  if (value.length > MAX_TEXT_LENGTH) {
    throw new TraceInputError(`The ${name} is longer than ${MAX_TEXT_LENGTH} characters.`)
  }
  return value
}

export function parseSentenceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)) {
    throw new TraceInputError('Sentence ids must be a list of non-empty strings.')
  }
  return [...new Set(value as string[])]
}

function parseLinkedSentenceIds(value: unknown): string[] {
  const ids = parseSentenceIds(value)
  if (ids.length === 0) {
    throw new TraceInputError('Link this to at least one sentence.')
  }
  return ids
}

function applyMarks(
  readerId: string,
  fingerprint: string,
  sentenceIds: readonly string[],
  state: SentenceState,
): Record<string, SentenceState> {
  const stored = getSentenceStates(readerId, fingerprint)
  const result: Record<string, SentenceState> = {}
  for (const id of sentenceIds) {
    const current = stored[id]
    if (current !== undefined && STATE_RANK[current] >= STATE_RANK[state]) {
      result[id] = current
      continue
    }
    setSentenceState(readerId, fingerprint, id, state)
    result[id] = state
  }
  return result
}

export function isSentenceState(value: unknown): value is SentenceState {
  return typeof value === 'string' && Object.hasOwn(STATE_RANK, value)
}

/** Marks sentences and returns the state each one now holds, which a higher mark may have kept. */
export function markSentences(
  readerId: string,
  fingerprint: string,
  sentenceIds: readonly string[],
  state: SentenceState,
): Record<string, SentenceState> {
  requireKey(readerId, 'reader id')
  requireKey(fingerprint, 'fingerprint')
  if (!isSentenceState(state)) {
    throw new TraceInputError('That is not a sentence state.')
  }
  const ids = parseSentenceIds(sentenceIds)
  return database()
    .transaction(() => applyMarks(readerId, fingerprint, ids, state))
    .immediate()
}

interface AnswerRow {
  id: number
  fingerprint: string
  question_id: string
  answer: string
  correct: number
  correction: string | null
  sentence_ids: string
  created_at: string
}

function toAnswer(row: AnswerRow): AnswerAttempt {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    questionId: row.question_id,
    answer: row.answer,
    correct: row.correct === 1,
    correction: row.correction,
    sentenceIds: JSON.parse(row.sentence_ids) as string[],
    createdAt: row.created_at,
  }
}

export function getStoredAnswer(readerId:string, fingerprint:string, questionId:string): {response:string; understood:boolean; sentenceIds:string[]}|null {
  const row = database().prepare('SELECT correct, correction, sentence_ids FROM reader_answers WHERE reader_id=? AND fingerprint=? AND question_id=? ORDER BY id LIMIT 1').get(readerId,fingerprint,questionId) as {correct:number;correction:string|null;sentence_ids:string}|undefined
  if(!row||!row.correction) return null
  return { response: row.correction, understood: row.correct===1, sentenceIds: JSON.parse(row.sentence_ids) as string[] }
}
export function recordAnswer(input: RecordAnswerInput): AnswerAttempt {
  const readerId = requireKey(input.readerId, 'reader id')
  const fingerprint = requireKey(input.fingerprint, 'fingerprint')
  const questionId = requireKey(input.questionId, 'question id')
  const answer = requireText(input.answer, 'answer')
  if (typeof input.correct !== 'boolean') {
    throw new TraceInputError('An answer must be recorded as correct or not.')
  }
  const correct = input.correct
  const correction = input.correction ?? null
  if (correction !== null && typeof correction !== 'string') {
    throw new TraceInputError('A correction must be text.')
  }
  const sentenceIds = parseSentenceIds(input.sentenceIds)

  const conn = database()
  return conn
    .transaction(() => {
      ensureReader(readerId)
      const createdAt = new Date().toISOString()
      const { lastInsertRowid } = conn
        .prepare(
          'INSERT INTO reader_answers (reader_id, fingerprint, question_id, answer, correct, correction, sentence_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          readerId,
          fingerprint,
          questionId,
          answer,
          correct ? 1 : 0,
          correction,
          JSON.stringify(sentenceIds),
          createdAt,
        )
      if (correct) applyMarks(readerId, fingerprint, sentenceIds, 'understood')
      return {
        id: Number(lastInsertRowid),
        fingerprint,
        questionId,
        answer,
        correct,
        correction,
        sentenceIds,
        createdAt,
      }
    })
    .immediate()
}

function listAnswers(readerId: string, fingerprint: string): AnswerAttempt[] {
  const rows = database()
    .prepare(
      'SELECT id, fingerprint, question_id, answer, correct, correction, sentence_ids, created_at FROM reader_answers WHERE reader_id = ? AND fingerprint = ? ORDER BY id',
    )
    .all(readerId, fingerprint) as AnswerRow[]
  return rows.map(toAnswer)
}

export function readingState(readerId: string, fingerprint: string): ReadingState {
  requireKey(readerId, 'reader id'); requireKey(fingerprint, 'fingerprint'); ensureReader(readerId)
  return { states: getSentenceStates(readerId, fingerprint), answers: listAnswers(readerId, fingerprint) }
}
