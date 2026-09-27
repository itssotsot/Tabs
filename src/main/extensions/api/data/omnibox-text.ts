/** chrome.omnibox descriptions: Chrome's little XML (<match>, <dim>, <url>) as text and styled runs. No Electron here. */

/** A styled run of a suggestion's description (Chrome's XML: <match>, <dim>, <url>). */
export interface OmniboxSegment {
  text: string
  styles: ('match' | 'dim' | 'url')[]
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

/** Splits Chrome's description markup into styled runs. Unknown tags are ignored. */
export function omniboxSegments(description: string): OmniboxSegment[] {
  const segments: OmniboxSegment[] = []
  const stack: ('match' | 'dim' | 'url')[] = []
  const re = /<\s*(\/?)\s*(match|dim|url)\s*>|<[^>]*>|([^<]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(description))) {
    if (m[3] !== undefined) {
      const text = decodeEntities(m[3])
      if (text) segments.push({ text, styles: [...new Set(stack)] })
    } else if (m[2]) {
      const tag = m[2].toLowerCase() as 'match' | 'dim' | 'url'
      if (m[1]) {
        const i = stack.lastIndexOf(tag)
        if (i !== -1) stack.splice(i, 1)
      } else stack.push(tag)
    }
  }
  return segments
}

/** A description as plain text. */
export function omniboxDescriptionText(description: string): string {
  return omniboxSegments(description)
    .map((s) => s.text)
    .join('')
}
