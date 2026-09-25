import { ArrowDownToLine, FolderOpen, Pause, Play, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DownloadState } from '@shared/types'
import { formatBytes } from '../../ui/util'

export function DownloadsPanel({ downloads }: { downloads: DownloadState[] }): ReactNode {
  const { action } = window.browserr.downloads

  if (!downloads.length) {
    return (
      <div className="panel-empty">
        <ArrowDownToLine size={28} strokeWidth={1.5} />
        <h3>No downloads</h3>
        <p>Files you download go to your Downloads folder.</p>
      </div>
    )
  }

  return (
    <div className="downloads">
      <div className="list-actions">
        <span>{downloads.length} files</span>
        <button className="link-btn" onClick={() => action('clear')}>
          Clear finished
        </button>
      </div>
      {downloads.map((d) => {
        const progress = d.totalBytes ? d.receivedBytes / d.totalBytes : 0
        const running = d.state === 'progressing'
        return (
          <div key={d.id} className="download">
            <button
              className="download-main"
              disabled={d.state !== 'completed'}
              onClick={() => action('open', d.id)}
              title={d.state === 'completed' ? 'Open' : undefined}
            >
              <strong>{d.filename}</strong>
              <span className="muted">
                {running
                  ? `${formatBytes(d.receivedBytes)}${d.totalBytes ? ` of ${formatBytes(d.totalBytes)}` : ''}${d.paused ? ' · Paused' : ''}`
                  : d.state === 'completed'
                    ? formatBytes(d.totalBytes || d.receivedBytes)
                    : d.state === 'cancelled'
                      ? 'Cancelled'
                      : 'Failed'}
              </span>
              {running && (
                <span className="progress">
                  <span style={{ width: `${Math.round(progress * 100)}%` }} />
                </span>
              )}
            </button>
            <div className="download-actions">
              {running && (
                <button
                  className="icon-btn small"
                  title={d.paused ? 'Resume' : 'Pause'}
                  onClick={() => action(d.paused ? 'resume' : 'pause', d.id)}
                >
                  {d.paused ? <Play size={14} /> : <Pause size={14} />}
                </button>
              )}
              {d.state === 'completed' && (
                <button className="icon-btn small" title="Show in folder" onClick={() => action('show', d.id)}>
                  <FolderOpen size={14} />
                </button>
              )}
              <button
                className="icon-btn small"
                title={running ? 'Cancel' : 'Remove from list'}
                onClick={() => action(running ? 'cancel' : 'remove', d.id)}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
