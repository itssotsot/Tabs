import { X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { SITE_PERMISSIONS } from '@shared/constants'
import type { DeviceChoice, PermissionDecision, Settings, SiteAccess as Site, SitePermission } from '@shared/types'

const PERMISSIONS = Object.keys(SITE_PERMISSIONS) as SitePermission[]

/** Your devices of one kind, by name. This page may see their names (it's one of Tabs' own). */
function useDevices(kind: MediaDeviceKind): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    const load = (): void =>
      void navigator.mediaDevices
        .enumerateDevices()
        .then((all) => setDevices(all.filter((d) => d.kind === kind && d.label && d.deviceId !== 'default' && d.deviceId !== 'communications')))
        .catch(() => setDevices([]))
    load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => navigator.mediaDevices.removeEventListener('devicechange', load)
  }, [kind])
  return devices
}

function DeviceSetting({ label, detail, kind, value, onChange }: { label: string; detail: string; kind: MediaDeviceKind; value: string | null; onChange: (name: string | null) => void }): ReactNode {
  const devices = useDevices(kind)
  const missing = value && !devices.some((d) => d.label === value)
  return (
    <label className="setting">
      <span className="setting-text">
        <strong>{label}</strong>
        <span>{detail}</span>
      </span>
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

function SiteRow({ site, onChange }: { site: Site; onChange: (sites: Site[]) => void }): ReactNode {
  const api = window.browserrInternal
  const host = site.origin.replace(/^https?:\/\//, '')
  const entries = Object.entries(site.permissions) as [SitePermission, PermissionDecision][]
  return (
    <div className="site-access">
      <div className="site-access-head">
        <img src={`${site.origin}/favicon.ico`} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
        <strong>{host}</strong>
        <button className="icon-link" title={`Forget ${host}'s choices: it's asked again`} onClick={async () => onChange(await api.forgetSite(site.origin))}>
          <X size={14} />
        </button>
      </div>
      <div className="site-access-choices">
        {entries.map(([permission, decision]) => (
          <label key={permission} className="site-access-choice">
            <span>{SITE_PERMISSIONS[permission]?.name ?? permission}</span>
            <select
              value={decision}
              onChange={async (e) => {
                const value = e.target.value
                onChange(await api.setSitePermission(site.origin, permission, value === 'ask' ? null : (value as PermissionDecision)))
              }}
            >
              <option value="allow">Allowed</option>
              <option value="deny">Blocked</option>
              <option value="ask">Ask next time</option>
            </select>
          </label>
        ))}
      </div>
    </div>
  )
}

/** Settings › Site access: what sites may ask for, the devices they use, and what each site was allowed. */
export function SiteAccess({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => Promise<void> }): ReactNode {
  const api = window.browserrInternal
  const [sites, setSites] = useState<Site[] | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void api.siteAccess().then(setSites)
    if (location.hash === '#site-access') requestAnimationFrame(() => document.getElementById('site-access')?.scrollIntoView())
  }, [])

  const setDevice = (patch: Partial<DeviceChoice>): Promise<void> => update({ devices: { ...settings.devices, ...patch } })
  const blocked = new Set(settings.blockedPermissions)
  const shown = (sites ?? []).filter((s) => s.origin.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <section className="card" id="site-access">
      <h2>Site access</h2>

      <h3 className="card-subhead">What sites may ask for</h3>
      {PERMISSIONS.map((permission) => (
        <label key={permission} className="setting">
          <span className="setting-text">
            <strong>{SITE_PERMISSIONS[permission].name}</strong>
            <span>{SITE_PERMISSIONS[permission].detail}</span>
          </span>
          <select
            value={blocked.has(permission) ? 'block' : 'ask'}
            onChange={(e) => {
              const next = new Set(blocked)
              if (e.target.value === 'block') next.add(permission)
              else next.delete(permission)
              void update({ blockedPermissions: [...next] })
            }}
          >
            <option value="ask">Sites can ask</option>
            <option value="block">Don't let sites ask</option>
          </select>
        </label>
      ))}

      <h3 className="card-subhead">Your devices</h3>
      <DeviceSetting
        label="Camera"
        detail="The camera sites use, unless you pick another in the site."
        kind="videoinput"
        value={settings.devices.camera}
        onChange={(camera) => void setDevice({ camera })}
      />
      <DeviceSetting
        label="Microphone"
        detail="The microphone sites use, unless you pick another in the site."
        kind="audioinput"
        value={settings.devices.microphone}
        onChange={(microphone) => void setDevice({ microphone })}
      />
      <DeviceSetting
        label="Speakers"
        detail="Where sites allowed your microphone play sound. Other sites use the system's speakers."
        kind="audiooutput"
        value={settings.devices.speaker}
        onChange={(speaker) => void setDevice({ speaker })}
      />

      <h3 className="card-subhead">Sites</h3>
      {sites && sites.length > 0 ? (
        <>
          {sites.length > 6 && <input className="site-access-search" placeholder="Find a site" value={query} onChange={(e) => setQuery(e.target.value)} />}
          {shown.map((site) => (
            <SiteRow key={site.origin} site={site} onChange={setSites} />
          ))}
        </>
      ) : (
        <p className="card-empty">When you allow or block something for a site, it shows up here.</p>
      )}
    </section>
  )
}
