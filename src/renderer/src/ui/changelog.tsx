import type { ReactNode } from 'react'
import { boldRuns, parseChangelog } from '@shared/changelog'
import changelogText from '../../../../CHANGELOG.md?raw'
import { version } from '../../../../package.json'

/** The release notes, built into the app so each version knows its own. */
export const CHANGELOG = parseChangelog(changelogText)
export const APP_VERSION: string = version

/** A changelog item, with its **bold** parts in bold. */
export function ChangelogText({ text }: { text: string }): ReactNode {
  return boldRuns(text).map((run, i) => (run.bold ? <strong key={i}>{run.text}</strong> : run.text))
}
