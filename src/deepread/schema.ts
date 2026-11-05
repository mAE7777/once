import type { PlanSourceKind, PlanStepKind } from '@/lib/types'

export const PLAN_STEP_KINDS: readonly PlanStepKind[] = [
  'context',
  'problem',
  'attempts',
  'answer',
  'applications',
]

export const PLAN_SOURCE_KINDS: readonly PlanSourceKind[] = ['original', 'external', 'inference']

export type JsonSchema = {
  type: 'object' | 'array' | 'string' | 'integer' | 'boolean'
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
  enum?: readonly string[]
  minItems?: number
  minLength?: number
  minimum?: number
}

function object(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }
}

function list(items: JsonSchema, minItems?: number): JsonSchema {
  return minItems === undefined ? { type: 'array', items } : { type: 'array', items, minItems }
}

const text: JsonSchema = { type: 'string' }
const filled: JsonSchema = { type: 'string', minLength: 1 }
const sentenceIds = list(filled)

const sourceSchema = object({
  kind: { type: 'string', enum: PLAN_SOURCE_KINDS },
  url: text,
  title: text,
})

const skipRangeSchema = object({
  fromSentenceId: filled,
  toSentenceId: filled,
  reason: filled,
})

const boxSchema = object({ x: {type:'integer'}, y: {type:'integer'}, w: {type:'integer'}, h: {type:'integer'} })
export const pointSchema = object({
  spoken: list(object({ text: filled, pauseBefore: { type: 'boolean' }, stuckReason: text }), 1),
  quotes: list(object({ sentenceId: filled, quote: filled }), 1),
  source: sourceSchema,
  figurePages: list({ type: 'integer', minimum: 1 }),
  figurePart: object({ page: {type:'integer'}, hasRegion: {type:'boolean'}, region: boxSchema, concept: text }),
})

/** The shape the model must return for a deep read; `Plan` is what gets stored from it. */
export const PLAN_OUTPUT_SCHEMA: JsonSchema = object({
  title: filled,
  steps: list(object({ kind: { type: 'string', enum: PLAN_STEP_KINDS }, title: filled, points: list(pointSchema, 1) }), 1),
  questions: list(object({ afterPointIndex: {type:'integer', minimum:1}, question: filled, guidance: filled, earnsSentenceIds: list(filled, 1) })),
  pageNotes: list(object({ sentenceId: filled, anchor: filled, note: filled })),
  skippable: list(skipRangeSchema),
  figures: list(
    object({
      page: { type: 'integer', minimum: 1 },
      label: filled,
      description: filled,
    }),
  ),
})

export const PLAN_REPAIR_SCHEMA: JsonSchema = object({
  corrections: list(
    object({
      location: filled,
      wrongId: filled,
      rightId: text,
      quote: text,
    }),
  ),
  addedQuotes: list(object({ location: filled, sentenceId: filled, quote: filled })),
  addedPoints: list(object({ stepId: filled, point: pointSchema })),
  addedSkippable: list(skipRangeSchema),
})

export interface RawSource {
  kind: PlanSourceKind
  url: string
  title: string
}

export interface RawSkipRange {
  fromSentenceId: string
  toSentenceId: string
  reason: string
}

export interface RawPoint {
  spoken: { text: string; pauseBefore: boolean; stuckReason: string }[]
  quotes: { sentenceId: string; quote: string }[]
  source: RawSource
  figurePages: number[]
  figurePart: { page: number; hasRegion: boolean; region: {x:number;y:number;w:number;h:number}; concept: string }
}
export interface RawQuestion { afterPointIndex: number; question: string; guidance: string; earnsSentenceIds: string[] }
export interface RawStep { kind: PlanStepKind; title: string; points: RawPoint[] }
export interface RawPageNote { sentenceId: string; anchor: string; note: string }

export interface RawFigure {
  page: number
  label: string
  description: string
}

export interface RawPlan { title: string; steps: RawStep[]; questions: RawQuestion[]; pageNotes: RawPageNote[]; skippable: RawSkipRange[]; figures: RawFigure[] }

export interface RawRepair {
  corrections: { location: string; wrongId: string; rightId: string; quote: string }[]
  addedQuotes: { location: string; sentenceId: string; quote: string }[]
  addedPoints: { stepId: string; point: RawPoint }[]
  addedSkippable: RawSkipRange[]
}

/**
 * Checks a value against the subset of JSON Schema used above. The API constrains its
 * decoding to the schema, but structured output has been seen to fail in practice, and a
 * plan must never be stored on trust.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  at: string = '$',
): string[] {
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return [`${at} should be a string`]
      if (schema.minLength !== undefined && value.trim().length < schema.minLength) {
        return [`${at} should not be empty`]
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return [`${at} should be one of ${schema.enum.join(', ')}`]
      }
      return []
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at} should be a boolean`]
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return [`${at} should be an integer`]
      if (schema.minimum !== undefined && value < schema.minimum) {
        return [`${at} should be at least ${schema.minimum}`]
      }
      return []
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${at} should be an array`]
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return [`${at} should have at least ${schema.minItems} item(s)`]
      }
      return value.flatMap((item, index) =>
        validateAgainstSchema(item, schema.items as JsonSchema, `${at}[${index}]`),
      )
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return [`${at} should be an object`]
      }
      const record = value as Record<string, unknown>
      const properties = schema.properties ?? {}
      const errors: string[] = []
      for (const name of schema.required ?? []) {
        if (!(name in record)) errors.push(`${at}.${name} is missing`)
      }
      for (const name of Object.keys(record)) {
        const property = properties[name]
        if (!property) {
          errors.push(`${at}.${name} is not allowed`)
          continue
        }
        errors.push(...validateAgainstSchema(record[name], property, `${at}.${name}`))
      }
      return errors
    }
  }
}

export function checkPlanOutput(value: unknown): string[] {
  const errors = validateAgainstSchema(value, PLAN_OUTPUT_SCHEMA)
  if (errors.length > 0) return errors
  const steps = (value as RawPlan).steps
  let highest = 0
  for (const [index, step] of steps.entries()) {
    const rank = PLAN_STEP_KINDS.indexOf(step.kind)
    if (rank < highest) {
      errors.push(`$.steps[${index}] (${step.kind}) comes after a later stage of the problem order`)
    }
    highest = Math.max(highest, rank)
  }
  return errors
}
