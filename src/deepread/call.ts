import { MetaApiError, NO_UPSTREAM_STATUS, metaResponsesStream } from '@/lib/meta'
import type { PlanUsage } from '@/lib/types'
import { collectCitations, type Citation, type PlanAudit } from './normalize'

export const MAX_PLAN_ATTEMPTS = 3
export const MAX_REPAIR_ATTEMPTS = 2
const RETRY_DELAYS_MS = [2_000, 6_000]

export class PlanInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanInputError'
  }
}

export class PlanModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanModelError'
  }
}

export class PlanCoverageError extends Error {
  readonly audit: PlanAudit

  constructor(audit: PlanAudit) {
    const shown = audit.uncovered.slice(0, 10).join(', ')
    const more = audit.uncovered.length > 10 ? ', and more' : ''
    const parts = [
      audit.uncovered.length > 0
        ? `${audit.uncovered.length} sentence(s) are neither explained nor marked skippable (${shown}${more})`
        : null,
      audit.unknownCitations.length > 0
        ? `${audit.unknownCitations.length} citation(s) point to sentences that do not exist`
        : null,
      audit.unprovenQuotes.length > 0
        ? `${audit.unprovenQuotes.length} quote(s) do not match the text`
        : null,
      audit.unsourcedPoints.length > 0
        ? `${audit.unsourcedPoints.length} point(s) cite no sentence`
        : null,
    ].filter(Boolean)
    super(
      `The explanation plan is still incomplete after a repair: ${parts.join('; ')}. No plan was saved. Try again.`,
    )
    this.name = 'PlanCoverageError'
    this.audit = audit
  }
}

export class PlanStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanStoreError'
  }
}

/** Text the model returned as its answer, leaving out the commentary it writes between searches. */
export function finalOutputText(response: Record<string, unknown>): string {
  const output = Array.isArray(response.output) ? (response.output as Record<string, unknown>[]) : []
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const item = output[index]
    if (item?.type !== 'message' || item.phase === 'commentary') continue
    const content = Array.isArray(item.content) ? (item.content as Record<string, unknown>[]) : []
    return content
      .map((part) => (part?.type === 'output_text' && typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  return ''
}

export function emptyUsage(): PlanUsage {
  return {
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    webSearches: 0,
  }
}

export function sumUsage(total: PlanUsage, more: PlanUsage): void {
  total.calls += more.calls
  total.inputTokens += more.inputTokens
  total.cachedInputTokens += more.cachedInputTokens
  total.outputTokens += more.outputTokens
  total.reasoningTokens += more.reasoningTokens
  total.webSearches += more.webSearches
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function addUsage(total: PlanUsage, response: Record<string, unknown>): void {
  const usage = (response.usage ?? {}) as Record<string, unknown>
  const inputDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>
  const outputDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>
  total.calls += 1
  total.inputTokens += count(usage.input_tokens)
  total.cachedInputTokens += count(inputDetails.cached_tokens)
  total.outputTokens += count(usage.output_tokens)
  total.reasoningTokens += count(outputDetails.reasoning_tokens)
  const output = Array.isArray(response.output) ? (response.output as Record<string, unknown>[]) : []
  total.webSearches += output.filter(
    (item) =>
      item?.type === 'web_search_call' &&
      (item.action as Record<string, unknown> | undefined)?.type === 'search',
  ).length
}

/** Standard-mode prices for muse-spark-1.3, in dollars. */
export function costOf(usage: PlanUsage): number {
  const freshInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens)
  const dollars =
    (freshInput * 1.25 + usage.cachedInputTokens * 0.15 + usage.outputTokens * 4.25) / 1_000_000 +
    (usage.webSearches * 2.5) / 1_000
  return Math.round(dollars * 10_000) / 10_000
}

function isRetryableStatus(status: number): boolean {
  return status === NO_UPSTREAM_STATUS || status === 408 || status === 429 || status >= 500
}

export interface ModelCall {
  body: Record<string, unknown>
  check: (value: unknown) => string[]
  maxAttempts: number
  what: string
  usage: PlanUsage
  fetchImpl: typeof fetch
  sleep: (ms: number) => Promise<void>
}

export async function callModel<T>(call: ModelCall): Promise<{ value: T; citations: Citation[] }> {
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= call.maxAttempts; attempt += 1) {
    if (attempt > 1) {
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 2, RETRY_DELAYS_MS.length - 1)]
      await call.sleep(delay)
    }
    let response: Record<string, unknown>
    try {
      ;({ response } = await metaResponsesStream(call.body, call.fetchImpl))
    } catch (error) {
      if (error instanceof MetaApiError && isRetryableStatus(error.status)) {
        lastError = error
        continue
      }
      throw error
    }
    addUsage(call.usage, response)

    if (response.status !== 'completed') {
      const details = response.incomplete_details as Record<string, unknown> | null | undefined
      const reason = typeof details?.reason === 'string' ? details.reason : String(response.status)
      lastError = new PlanModelError(
        `The model stopped before finishing the ${call.what} (${reason}) on all ${call.maxAttempts} attempts. A partial plan is never kept. Try again.`,
      )
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(finalOutputText(response))
    } catch {
      lastError = new PlanModelError(
        `The model's ${call.what} was not valid JSON on all ${call.maxAttempts} attempts. No plan was saved. Try again.`,
      )
      continue
    }
    const errors = call.check(parsed)
    if (errors.length > 0) {
      lastError = new PlanModelError(
        `The model's ${call.what} did not match the required format on all ${call.maxAttempts} attempts (${errors[0]}). No plan was saved. Try again.`,
      )
      continue
    }
    return { value: parsed as T, citations: collectCitations(response) }
  }
  throw lastError as Error
}
