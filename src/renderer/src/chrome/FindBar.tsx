import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { FindState } from '@shared/types'

interface Props {
  result: FindState
  onClose: () => void
  /** Bumped by the app to re-focus the field when Find is invoked again. */
  focusToken: number
  /** Set when "Find next/previous" comes from the menu. */
  nextRequest: { forward: boolean; token: number } | null
}

export function FindBar({ result, onClose, focusToken, nextRequest }: Props): ReactNode {
  const { find } = window.browserr
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken])

  useEffect(() => {
    if (nextRequest && text) find.start(text, nextRequest.forward, false)
  }, [nextRequest?.token])

  const close = (): void => {
    find.stop()
    onClose()
  }

  return (
    <div className="findbar">
      <input
        ref={inputRef}
        value={text}
        placeholder="Find in page"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          find.start(e.target.value, true, true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') find.start(text, !e.shiftKey, false)
          if (e.key === 'Escape') close()
        }}
      />
      <span className="find-count">{text ? `${result.activeMatch}/${result.matches}` : ''}</span>
      <button className="icon-btn small" title="Previous match" disabled={!text} onClick={() => find.start(text, false, false)}>
        <ChevronUp size={15} />
      </button>
      <button className="icon-btn small" title="Next match" disabled={!text} onClick={() => find.start(text, true, false)}>
        <ChevronDown size={15} />
      </button>
      <button className="icon-btn small" title="Close" onClick={close}>
        <X size={15} />
      </button>
    </div>
  )
}
