export type DocumentKind = 'pdf' | 'text' | 'markdown' | 'url' | 'image'

export interface StoredDocument {
  fingerprint: string
  filename: string
  kind: DocumentKind
  byteLength: number
  sourceUrl?: string
}

export interface ReadableTextItem {
  str: string
  x: number
  y: number
  w: number
  h: number
  /** The measured right edge of each UTF-16 unit of str, in points from x. Absent when unmeasured. */
  charEnds?: number[]
}

export interface ReadableBlock { text: string; x: number; y: number; w: number; h: number; lines?: number }
export interface ReadablePage {
  page: number
  width: number
  height: number
  text: string
  items: ReadableTextItem[]
  isScan: boolean
  image?: string
  blocks?: ReadableBlock[]
}

export interface ReadableDocument {
  fingerprint: string
  kind: DocumentKind
  pageCount: number
  fullText: string
  pages: ReadablePage[]
}

export interface SentenceBox {
  x: number
  y: number
  w: number
  h: number
  /** Where this box's characters begin in the sentence's text. Present together with charEnds. */
  start?: number
  /** The measured right edge of each character in this box, in points from x. */
  charEnds?: number[]
}

export interface Sentence {
  id: string
  page: number
  start: number
  end: number
  text: string
  boxes: SentenceBox[]
}

export interface SentenceDocument {
  fingerprint: string
  sentences: Sentence[]
}

export interface DocumentRecord {
  fingerprint: string
  kind: DocumentKind
  filename: string
  byteLength: number
  sourceUrl: string | null
  createdAt: string
}

export interface RegisterDocumentInput {
  fingerprint: string
  kind: DocumentKind
  filename: string
  byteLength: number
  sourceUrl?: string
}

export interface RegisterDocumentResult {
  alreadyKnown: boolean
}

export interface PutArtifactInput {
  fingerprint: string
  kind: string
  key: string
  model: string
  promptVersion: string
  data: Buffer
}

export interface PutArtifactResult {
  path: string
  reused: boolean
}

export interface ArtifactRecord {
  fingerprint: string
  kind: string
  key: string
  path: string
  model: string
  promptVersion: string
  createdAt: string
}

export interface GetArtifactOptions {
  model?: string
  promptVersion?: string
}

export interface ArtifactLookup {
  path: string
  model: string
  promptVersion: string
  createdAt: string
  isCurrent: boolean
}

export type SentenceState = 'understood' | 'explained' | 'skippable' | 'uncovered'

export type TextLanguage = 'en' | 'other'

export type PlanStepKind = 'context' | 'problem' | 'attempts' | 'answer' | 'applications'

export type PlanSourceKind = 'original' | 'external' | 'inference'

export interface PlanSource {
  kind: PlanSourceKind
  url: string | null
  title: string | null
}

export interface PlanQuote {
  sentenceId: string
  quote: string
}

export interface PlanStickingPoint {
  /** Position in the point's spoken text, in JS string units, where playback pauses. */
  offset: number
  reason: string
}

export interface FigurePart { page: number; region: { x: number; y: number; w: number; h: number } | null; concept: string }
export interface PlanPoint {
  id: string
  stepId: string
  spoken: string
  stickingPoints: PlanStickingPoint[]
  sentenceIds: string[]
  quotes: PlanQuote[]
  source: PlanSource
  figurePages: number[]
  figurePart: FigurePart | null
}
export interface PageNote { id: string; sentenceId: string; anchor: string; note: string; start: number; end: number; boxes: SentenceBox[] }

export interface PlanStep {
  id: string
  kind: PlanStepKind
  title: string
  points: PlanPoint[]
}

export interface PlanSkippable {
  sentenceId: string
  reason: string
}

export interface PlanQuestion {
  id: string
  afterPointId: string
  question: string
  guidance: string
  earnsSentenceIds: string[]
}

export interface PlanFigure {
  id: string
  page: number
  label: string
  description: string
}

export interface PlanPart {
  fromPage: number
  toPage: number
  imagePages: number[]
}

export interface PlanVolume {
  split: boolean
  reason: 'image-limit' | 'context-limit' | null
  note: string | null
  parts: PlanPart[]
  imagePages: number[]
  missingImagePages: number[]
}

export interface PlanLink {
  url: string
  title: string | null
}

export interface PlanSourcing {
  externalKept: number
  downgradedToInference: number
  links: PlanLink[]
}

export interface PlanCoverage {
  total: number
  covered: number
  skippable: number
  uncovered: string[]
}

export interface PlanUsage {
  calls: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  webSearches: number
}

export interface PlanCheckFinding {
  pointId: string
  kind: string
  detail: string
}

export interface PlanCheckCounts {
  lint: number
  listener: number
  /** Sections where the cold listener met a word or idea it was never taught. */
  sectionsWithUntaught: number
  sections: number
}

export interface PlanStageRecord {
  name: string
  ms: number
  calls: number
}

/** What the engine did to reach this plan, and what it could not settle. */
export interface PlanEngineReport {
  stages: PlanStageRecord[]
  repairRounds: number
  before: PlanCheckCounts
  after: PlanCheckCounts
  remaining: PlanCheckFinding[]
  retell: string
  newCase: string
  listenerFollowed: boolean | null
  costUsd: number
  /** Stages that could not run, in plain words. The plan was kept without them. */
  notes: string[]
}

export interface Plan {
  report?: PlanEngineReport
  fingerprint: string
  model: string
  promptVersion: string
  createdAt: string
  title: string
  steps: PlanStep[]
  skippable: PlanSkippable[]
  pageNotes: PageNote[]
  droppedPageNotes: number
  questions: PlanQuestion[]
  figures: PlanFigure[]
  volume: PlanVolume
  sourcing: PlanSourcing
  coverage: PlanCoverage
  usage: PlanUsage
  repaired: boolean
  /** Quotes removed because they still did not match their sentence after the repair. */
  droppedQuotes: number
}

export interface PlanResult {
  plan: Plan
  isCurrent: boolean
  reused: boolean
}
