import {
  Bell,
  Camera,
  Clipboard,
  ExternalLink,
  MapPin,
  Mic,
  Monitor,
  Moon,
  Music,
  ShieldAlert,
  Volume2,
  X,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { SITE_PERMISSIONS } from '@shared/constants'
import type { DeviceChoice, PermissionAnswer, PermissionPrompt as Prompt, SitePermission } from '@shared/types'

const ICONS: Record<SitePermission, LucideIcon> = {
  camera: Camera,
  microphone: Mic,
  'display-capture': Monitor,
  geolocation: MapPin,
  notifications: Bell,
  'clipboard-read': Clipboard,
  midi: Music,
  midiSysex: Music,
  'idle-detection': Moon,
  openExternal: ExternalLink
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** Tells the main process how tall the question is, so the overlay is just that (and the page stays clickable). */
function useReportedHeight(): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const report = (): void => window.browserr.overlay.promptHeight(el.getBoundingClientRect().height)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return ref
}

/** Your devices of one kind, by name. Names show once the browser's own pages may use devices, which they may. */
function useDevices(kind: MediaDeviceKind, wanted: boolean): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    if (!wanted) return
    const load = (): void =>
      void navigator.mediaDevices
        .enumerateDevices()
        .then((all) => setDevices(all.filter((d) => d.kind === kind && d.label && d.deviceId !== 'default' && d.deviceId !== 'communications')))
        .catch(() => setDevices([]))
    load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => navigator.mediaDevices.removeEventListener('devicechange', load)
  }, [kind, wanted])
  return devices
}

/** A live stream from the chosen device, for the preview; stopped when the question goes. */
function useStream(kind: 'video' | 'audio', deviceId: string | null, on: boolean): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null)
  useEffect(() => {
    if (!on) return
    let current: MediaStream | null = null
    let cancelled = false
    const constraint = deviceId ? { deviceId: { exact: deviceId } } : true
    navigator.mediaDevices
      .getUserMedia({ [kind]: constraint })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        current = s
        setStream(s)
      })
      .catch(() => setStream(null))
    return () => {
      cancelled = true
      current?.getTracks().forEach((t) => t.stop())
      setStream(null)
    }
  }, [kind, deviceId, on])
  return stream
}

function CameraPreview({ stream }: { stream: MediaStream | null }): ReactNode {
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (video.current) video.current.srcObject = stream
  }, [stream])
  return (
    <div className="prompt-preview">
      {stream ? <video ref={video} autoPlay muted playsInline /> : <span>Starting camera…</span>}
    </div>
  )
}

/** How loud the microphone is, as a bar that moves while you talk. */
function MicLevel({ stream }: { stream: MediaStream | null }): ReactNode {
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!stream) return
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    context.createMediaStreamSource(stream).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    let frame = 0
    const tick = (): void => {
      analyser.getFloatTimeDomainData(samples)
      let peak = 0
      for (const s of samples) peak = Math.max(peak, Math.abs(s))
      if (bar.current) bar.current.style.transform = `scaleX(${Math.min(1, peak * 2.5)})`
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      cancelAnimationFrame(frame)
      void context.close()
    }
  }, [stream])
  return (
    <div className="prompt-level" title="Microphone level">
      <div ref={bar} />
    </div>
  )
}

function DevicePicker({
  label,
  icon: Icon,
  devices,
  value,
  onChange
}: {
  label: string
  icon: LucideIcon
  devices: MediaDeviceInfo[]
  value: string | null
  onChange: (name: string | null) => void
}): ReactNode {
  // A device you picked before that isn't plugged in stays in the list, so the choice doesn't silently change.
  const missing = value && !devices.some((d) => d.label === value)
  return (
    <label className="prompt-device" title={label}>
      <Icon size={13} />
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">System default</option>
        {missing && <option value={value}>{value} (not connected)</option>}
        {devices.map((d) => (
          <option key={d.deviceId} value={d.label}>
            {d.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function AskPrompt({ prompt }: { prompt: Extract<Prompt, { kind: 'ask' }> }): ReactNode {
  const ref = useReportedHeight()
  const [devices, setDevices] = useState<DeviceChoice>(prompt.devices)
  const wantsCamera = prompt.permissions.includes('camera')
  const wantsMic = prompt.permissions.includes('microphone')
  const cameras = useDevices('videoinput', wantsCamera)
  const mics = useDevices('audioinput', wantsMic)
  const speakers = useDevices('audiooutput', wantsMic)
  const idOf = (list: MediaDeviceInfo[], name: string | null): string | null => list.find((d) => d.label === name)?.deviceId ?? null
  const camera = useStream('video', idOf(cameras, devices.camera), prompt.preview.includes('camera'))
  const mic = useStream('audio', idOf(mics, devices.microphone), prompt.preview.includes('microphone'))

  const answer = (decision: Extract<PermissionAnswer, { devices?: DeviceChoice }>['decision']): void =>
    window.browserr.overlay.answerPermission({ id: prompt.id, decision, devices })

  // Once you've used one of its menus, the question has the keyboard: Escape closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.browserr.overlay.answerPermission({ id: prompt.id, decision: 'dismiss' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prompt.id])

  return (
    <div ref={ref} className="permission-prompt">
      <div className="prompt-head">
        <span className="prompt-title">
          <strong>{prompt.host}</strong> wants to
        </span>
        <button className="prompt-close" title="Not now" onClick={() => answer('dismiss')}>
          <X size={14} />
        </button>
      </div>
      <ul className="prompt-wants">
        {prompt.permissions.map((p) => {
          const Icon = ICONS[p]
          return (
            <li key={p}>
              <Icon size={15} />
              {capitalize(SITE_PERMISSIONS[p].wants)}
            </li>
          )
        })}
      </ul>
      {wantsCamera && (
        <div className="prompt-devices">
          {prompt.preview.includes('camera') && <CameraPreview stream={camera} />}
          <DevicePicker label="Camera" icon={Camera} devices={cameras} value={devices.camera} onChange={(camera) => setDevices({ ...devices, camera })} />
        </div>
      )}
      {wantsMic && (
        <div className="prompt-devices">
          <DevicePicker label="Microphone" icon={Mic} devices={mics} value={devices.microphone} onChange={(microphone) => setDevices({ ...devices, microphone })} />
          {prompt.preview.includes('microphone') && <MicLevel stream={mic} />}
          <DevicePicker label="Speakers" icon={Volume2} devices={speakers} value={devices.speaker} onChange={(speaker) => setDevices({ ...devices, speaker })} />
        </div>
      )}
      <div className="prompt-actions">
        <button className="prompt-btn primary" onClick={() => answer('always')}>
          Allow every visit
        </button>
        <button className="prompt-btn" onClick={() => answer('once')}>
          Allow this time
        </button>
        <button className="prompt-btn" onClick={() => answer('block')}>
          Don't allow
        </button>
      </div>
    </div>
  )
}

function SystemPrompt({ prompt }: { prompt: Extract<Prompt, { kind: 'system' }> }): ReactNode {
  const ref = useReportedHeight()
  const names = prompt.blocked.map((d) => SITE_PERMISSIONS[d].name)
  return (
    <div ref={ref} className="permission-prompt">
      <div className="prompt-head">
        <span className="prompt-title">
          <ShieldAlert size={15} /> macOS is blocking your {names.join(' and ').toLowerCase()}
        </span>
        <button className="prompt-close" title="Not now" onClick={() => window.browserr.overlay.answerPermission({ id: prompt.id, decision: 'dismiss' })}>
          <X size={14} />
        </button>
      </div>
      <p className="prompt-detail">
        <strong>{prompt.host}</strong> can't use it until you turn on Tabs in System Settings › Privacy & Security › {names.join(' and ')}. Then
        reload the page.
      </p>
      <div className="prompt-actions">
        <button className="prompt-btn primary" onClick={() => window.browserr.overlay.answerPermission({ id: prompt.id, decision: 'open-system-settings' })}>
          Open System Settings
        </button>
        <button className="prompt-btn" onClick={() => window.browserr.overlay.answerPermission({ id: prompt.id, decision: 'dismiss' })}>
          Not now
        </button>
      </div>
    </div>
  )
}

/** A site's question under the address bar: what it wants, and, for a camera or microphone, which one and how it looks. */
export function PermissionPrompt({ prompt }: { prompt: Prompt }): ReactNode {
  return prompt.kind === 'ask' ? <AskPrompt key={prompt.id} prompt={prompt} /> : <SystemPrompt key={prompt.id} prompt={prompt} />
}
