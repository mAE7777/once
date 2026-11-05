import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'

export class UrlReadableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UrlReadableError'
  }
}

export const MIN_ARTICLE_CHARS = 800

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export function extractArticleText(html: string, url: string): string {
  const dom = new JSDOM(html, { url })
  try {
    const article = new Readability(dom.window.document).parse()
    if (!article) {
      throw new UrlReadableError('No article text could be read from this web page. It may require a login.')
    }
    const text = (article.textContent ?? '').trim()
    if (text.length < MIN_ARTICLE_CHARS) {
      throw new UrlReadableError(
        'Only a little text could be read from this web page. It may be a paywall preview or a login page, so the full text is not available.',
      )
    }
    return text
  } finally {
    dom.window.close()
  }
}

export async function fetchArticleText(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new UrlReadableError('The web page could not be opened. Check that the link works.')
  }

  if (!response.ok) {
    throw new UrlReadableError(`The web page could not be opened (status ${response.status}), so its text could not be read.`)
  }

  const html = await response.text()
  return extractArticleText(html, url)
}
