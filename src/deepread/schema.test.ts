import { describe, expect, it } from 'vitest'
import { fullRawPlan } from './fixtures'
import {
  PLAN_OUTPUT_SCHEMA,
  PLAN_REPAIR_SCHEMA,
  checkPlanOutput,
  validateAgainstSchema,
  type JsonSchema,
} from './schema'
import type { Sentence } from '@/lib/types'

function sentence(id: string, page: number): Sentence {
  return { id, page, start: 0, end: 1, text: `Text of ${id}.`, boxes: [] }
}

const sentences = [sentence('s1', 1), sentence('s2', 1), sentence('s3', 2)]

function depth(schema: JsonSchema): number {
  const children = [...Object.values(schema.properties ?? {}), ...(schema.items ? [schema.items] : [])]
  return 1 + Math.max(0, ...children.map(depth))
}

function eachObject(schema: JsonSchema, visit: (object: JsonSchema) => void): void {
  if (schema.type === 'object') visit(schema)
  for (const child of Object.values(schema.properties ?? {})) eachObject(child, visit)
  if (schema.items) eachObject(schema.items, visit)
}

describe('the schemas sent to the model', () => {
  for (const [name, schema] of [
    ['plan', PLAN_OUTPUT_SCHEMA],
    ['repair', PLAN_REPAIR_SCHEMA],
  ] as const) {
    it(`${name} schema stays inside the API's strict subset and depth limit`, () => {
      expect(schema.type).toBe('object')
      expect(depth(schema)).toBeLessThanOrEqual(10)
      eachObject(schema, (object) => {
        expect(object.additionalProperties).toBe(false)
        expect(object.required?.slice().sort()).toEqual(Object.keys(object.properties ?? {}).sort())
      })
      expect(JSON.stringify(schema)).not.toMatch(/allOf|oneOf|anyOf|\$ref/)
    })
  }
})

describe('checkPlanOutput', () => {
  it('accepts a full plan', () => {
    expect(checkPlanOutput(fullRawPlan(sentences))).toEqual([])
  })

  it('rejects a plan with no steps, a missing field, an extra field and a bad enum', () => {
    expect(checkPlanOutput({ ...fullRawPlan(sentences), steps: [] }).join()).toContain('$.steps')

    const missing: Record<string, unknown> = { ...fullRawPlan(sentences) }
    delete missing.skippable
    expect(checkPlanOutput(missing).join()).toContain('$.skippable is missing')

    expect(checkPlanOutput({ ...fullRawPlan(sentences), extra: 1 }).join()).toContain('$.extra is not allowed')

    const badKind = fullRawPlan(sentences)
    ;(badKind.steps[0] as { kind: string }).kind = 'summary'
    expect(checkPlanOutput(badKind).join()).toContain('$.steps[0].kind')
  })

  it('rejects a point that cites no sentence or says nothing', () => {
    const noQuotes = fullRawPlan(sentences)
    noQuotes.steps[0].points[0].quotes = []
    expect(checkPlanOutput(noQuotes).join()).toContain('quotes')

    const blank = fullRawPlan(sentences)
    blank.steps[0].points[0].spoken[0].text = '   '
    expect(checkPlanOutput(blank).join()).toContain('spoken[0].text')
  })

  it('rejects a skippable range with no reason', () => {
    const plan = fullRawPlan(sentences)
    plan.skippable[0].reason = ''
    expect(checkPlanOutput(plan).join()).toContain('skippable[0].reason')
  })

  it('rejects steps that are out of problem order but allows repeats and gaps', () => {
    const plan = fullRawPlan(sentences)
    plan.steps.reverse()
    expect(checkPlanOutput(plan).join()).toContain('problem order')

    const withRepeat = fullRawPlan(sentences)
    withRepeat.steps = [withRepeat.steps[0], withRepeat.steps[0], withRepeat.steps[3]]
    expect(checkPlanOutput(withRepeat)).toEqual([])
  })
})

describe('validateAgainstSchema', () => {
  it('checks integers and their minimum', () => {
    const schema: JsonSchema = { type: 'integer', minimum: 1 }
    expect(validateAgainstSchema(2, schema)).toEqual([])
    expect(validateAgainstSchema(0, schema)).toHaveLength(1)
    expect(validateAgainstSchema(1.5, schema)).toHaveLength(1)
    expect(validateAgainstSchema('2', schema)).toHaveLength(1)
  })
})
