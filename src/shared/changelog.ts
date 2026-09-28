/** One release's notes from CHANGELOG.md. */
export interface ChangelogEntry {
  version: string
  /** Its "- " items, with **bold** kept as written. */
  items: string[]
}

/** Reads CHANGELOG.md: a "## <version>" heading per release, then its "- " items. HTML comments are skipped. */
export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  for (const line of markdown.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const heading = /^##\s+(\S+)/.exec(line)
    if (heading) entries.push({ version: heading[1], items: [] })
    else if (/^\s*-\s+/.test(line) && entries.length) entries[entries.length - 1].items.push(line.replace(/^\s*-\s+/, '').trim())
  }
  return entries
}

/** Splits an item into plain and **bold** runs. */
export function boldRuns(text: string): { text: string; bold: boolean }[] {
  return text
    .split(/(\*\*.+?\*\*)/)
    .filter(Boolean)
    .map((part) => (part.startsWith('**') && part.endsWith('**') ? { text: part.slice(2, -2), bold: true } : { text: part, bold: false }))
}
