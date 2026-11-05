const STORAGE_KEY = 'once-reader-id'
export const READER_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

let cached: string | null = null

export function getReaderId(): string {
  if (cached && READER_ID_PATTERN.test(cached)) return cached
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored && READER_ID_PATTERN.test(stored)) {
      cached = stored
      return stored
    }
  } catch {
    // Storage can be unavailable; fall through and mint a fresh id for this session.
  }
  const id = crypto.randomUUID()
  cached = id
  try {
    window.localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Keep the in-memory id so requests in this session still carry one reader.
  }
  return id
}

export function readerHeaders(): Record<string, string> {
  return { 'x-reader-id': getReaderId() }
}
