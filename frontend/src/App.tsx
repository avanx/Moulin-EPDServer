import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, FileUp, Globe2, KeyRound, LayoutDashboard, LogOut, Monitor, Package, Pencil, Plus, RefreshCw, Save, Server, Settings2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, Redirect, Route, Switch, useLocation } from 'wouter'
import { api, login, logout, restoreSession } from './api'
import type { Screen, ScreenDocument } from './api'
import EditorPage from './components/editor/EditorPage'
import PluginMarketplacePage from './components/plugins/PluginMarketplacePage'
import { sha256Hex } from './sha256'
import './App.css'

const queryClient = new QueryClient()

/** Clipboard API needs a secure context; fall back for plain HTTP LAN access. */
async function copyText(value: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      // continue to legacy fallback
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!ok) throw new Error('Copy failed')
}

function Button({ children, variant = 'default', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'danger' }) {
  return <button className={`button ${variant}`} {...props}>{children}</button>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>
}

function LoginPage({ onLogin }: { onLogin: () => void }) {
  const { t } = useTranslation()
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    try {
      await login(String(form.get('username')), String(form.get('password')))
      onLogin()
    } catch (reason) { setError(String(reason)) }
  }
  return <main className="login-page"><form className="card login-card" onSubmit={submit}>
    <div className="brand-mark"><img src="/logo.png" alt="" /></div>
    <h1>{t('appName')}</h1><p className="muted">Fastify · ESP32 · E-Paper</p>
    <Field label={t('username')}><input name="username" defaultValue="admin" autoComplete="username" /></Field>
    <Field label={t('password')}><input name="password" type="password" autoComplete="current-password" /></Field>
    {error && <p className="error">{error}</p>}
    <Button type="submit">{t('login')}</Button>
  </form></main>
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useTranslation()
  const [, navigate] = useLocation()
  const links = [
    ['/system', t('systemInfo'), Server],
    ['/', t('screens'), LayoutDashboard],
    ['/plugins', t('pluginMarketplace'), Package],
    ['/simulator', t('simulator'), Monitor],
    ['/secrets', t('secrets'), KeyRound],
  ] as const
  return <div className="app-shell">
    <aside><div className="sidebar-brand"><span className="brand-mark"><img src="/logo.png" alt="" /></span><b>{t('appName')}</b></div>
      <nav>{links.map(([href, label, Icon]) => <Link key={href} href={href}><Icon size={17} />{label}</Link>)}</nav>
      <div className="sidebar-bottom">
        <label className="language-select">
          <Globe2 size={17} aria-hidden="true" />
          <span className="sr-only">{t('language')}</span>
          <select
            aria-label={t('language')}
            value={i18n.resolvedLanguage || i18n.language}
            onChange={event => {
              const language = event.target.value
              void i18n.changeLanguage(language)
              localStorage.setItem('epd-language', language)
            }}
          >
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <Button variant="outline" onClick={async () => { await logout(); navigate('/login'); location.reload() }}><LogOut size={16} />{t('logout')}</Button>
      </div>
    </aside><section className="content">{children}</section>
  </div>
}

function ScreenForm({ close }: { close: () => void }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const create = useMutation({
    mutationFn: (body: object) => api<Screen>('/api/v1/admin/screens', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { client.invalidateQueries({ queryKey: ['screens'] }); close() },
  })
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const f = new FormData(event.currentTarget)
    create.mutate({ name: f.get('name'), width: Number(f.get('width')), height: Number(f.get('height')), color_mode: f.get('color'), panel_layout: f.get('panel_layout'), refresh_seconds: Number(f.get('interval')), enabled: true })
  }
  return <div className="dialog-backdrop"><form className="card dialog" onSubmit={submit}><h2>{t('createScreen')}</h2>
    <Field label={t('name')}><input name="name" required defaultValue="EPD Display" /></Field>
    <div className="grid-2"><Field label="Width"><input name="width" type="number" min="16" max="4096" defaultValue="800" /></Field><Field label="Height"><input name="height" type="number" min="16" max="4096" defaultValue="480" /></Field></div>
    <Field label={t('color')}><select name="color"><option value="bw">Black / White</option><option value="bwry">Black / White / Red / Yellow</option></select></Field>
    <Field label={t('panelLayout')}><select name="panel_layout" required defaultValue=""><option value="" disabled>{t('selectPanelLayout')}</option><option value="linear">{t('panelLayoutLinear')}</option><option value="dual-panel-left-right">{t('panelLayoutDualLeftRight')}</option></select></Field>
    <Field label={t('interval')}><input name="interval" type="number" min="2" defaultValue="900" /></Field>
    {create.error && <p className="error">{String(create.error)}</p>}
    <div className="dialog-actions"><Button type="button" variant="outline" onClick={close}>{t('cancel')}</Button><Button type="submit">{t('save')}</Button></div>
  </form></div>
}

function ScreensPage() {
  const { t } = useTranslation()
  const [, navigate] = useLocation()
  const [open, setOpen] = useState(false)
  const [shownKey, setShownKey] = useState('')
  const [keyCopied, setKeyCopied] = useState(false)
  const [importError, setImportError] = useState('')
  const [copiedScreenId, setCopiedScreenId] = useState('')
  const importRef = useRef<HTMLInputElement>(null)
  const copyTimer = useRef<number>(undefined)
  const client = useQueryClient()
  const { data = [], isLoading } = useQuery({ queryKey: ['screens'], queryFn: () => api<Screen[]>('/api/v1/admin/screens') })
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])
  async function copyScreenId(id: string) {
    try {
      await copyText(id)
      setCopiedScreenId(id)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopiedScreenId(''), 2000)
    } catch {
      // keep silent if both clipboard paths fail
    }
  }
  async function generateKey(id: string) {
    const result = await api<{ api_key: string }>(`/api/v1/admin/screens/${id}/keys`, { method: 'POST' })
    setShownKey(result.api_key)
    try {
      await copyText(result.api_key)
      setKeyCopied(true)
    } catch {
      setKeyCopied(false)
    }
  }
  async function importScreen(file: File) {
    setImportError('')
    try {
      const document = JSON.parse(await file.text()) as ScreenDocument
      const created = await api<Screen>('/api/v1/admin/screens/import', {
        method: 'POST',
        body: JSON.stringify(document),
      })
      await client.invalidateQueries({ queryKey: ['screens'] })
      navigate(`/screens/${created.id}`)
    } catch (reason) {
      setImportError(String(reason))
    } finally {
      if (importRef.current) importRef.current.value = ''
    }
  }
  return <><header className="page-header"><div><h1>{t('screens')}</h1><p className="muted">Manage display profiles and immutable render snapshots.</p></div><div className="screen-actions"><input ref={importRef} className="sr-only" type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) void importScreen(file) }} /><Button variant="outline" onClick={() => importRef.current?.click()}><FileUp size={16} />{t('importScreen')}</Button><Button onClick={() => setOpen(true)}><Plus size={16} />{t('createScreen')}</Button></div></header>
    {importError && <p className="error">{importError}</p>}
    {shownKey && <div className="notice"><b>{t(keyCopied ? 'keyCopiedAutomatically' : 'copyKeyNow')}</b><code>{shownKey}</code><Button variant="outline" onClick={async () => { try { await copyText(shownKey); setKeyCopied(true) } catch { setKeyCopied(false) } }}><Copy size={16} />{t('copy')}</Button></div>}
    <div className="screen-grid">{!isLoading && !data.length && <div className="empty card">{t('noScreens')}</div>}{data.map(screen => <article className="card screen-card" key={screen.id}>
      <div className="screen-thumb"><Monitor size={32} /><span className={`badge ${screen.color_mode}`}>{screen.color_mode.toUpperCase()}</span></div>
      <div><h3>{screen.name}</h3><p className="muted">{screen.width} × {screen.height} · {screen.refresh_seconds}s</p><button className="screen-id-copy" type="button" onClick={() => void copyScreenId(screen.id)} title={t('copyScreenId')}><span>{t('screenId')}</span><code>{screen.id}</code><Copy size={13} /></button></div>
      <div className="screen-actions"><Link className="button default" href={`/screens/${screen.id}`}><Settings2 size={16} />{t('editor')}</Link><Button variant="outline" onClick={() => generateKey(screen.id)}><KeyRound size={16} />{t('createKey')}</Button></div>
    </article>)}</div>{copiedScreenId && <div className="toast">{t('screenIdCopied')}</div>}{open && <ScreenForm close={() => setOpen(false)} />}</>
}

type StoredSecret = { id: string; name: string; purpose: string; updated_at: string }

function extractCursorSessionToken(input: string) {
  const match = input.match(/\bWorkosCursorSessionToken\s*=\s*([^;\s'"\\]+)/i)
  if (!match?.[1]) return ''
  return match[1].replace(/\^%\^/g, '%').replace(/\^%/g, '%')
}

function CurlTokenImport({ onToken }: { onToken: (token: string) => void }) {
  const { t } = useTranslation()
  const [curl, setCurl] = useState('')
  const [found, setFound] = useState(false)

  function parse(value: string) {
    setCurl(value)
    const token = extractCursorSessionToken(value)
    setFound(Boolean(token))
    if (token) onToken(token)
  }

  return <div className="curl-import">
    <Field label={t('curlImportLabel')}>
      <textarea
        rows={5}
        value={curl}
        onChange={event => parse(event.target.value)}
        placeholder={t('curlImportPlaceholder')}
        spellCheck={false}
      />
    </Field>
    {curl && <small className={found ? 'success' : 'error'}>
      {t(found ? 'curlTokenFound' : 'curlTokenNotFound')}
    </small>}
  </div>
}

function SecretUpdateDialog({ secret, close }: { secret: StoredSecret; close: () => void }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [value, setValue] = useState('')
  const update = useMutation({
    mutationFn: (value: string) => api('/api/v1/admin/secrets', {
      method: 'POST',
      body: JSON.stringify({ name: secret.name, purpose: secret.purpose, value }),
    }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['secrets'] })
      client.invalidateQueries({ queryKey: ['provider-status'] })
      close()
    },
  })
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    update.mutate(value)
  }
  return <div className="dialog-backdrop"><form className="card dialog" onSubmit={submit}>
    <h2>{t('updateSecret')}</h2>
    <p className="muted">{secret.name}</p>
    {secret.purpose === 'cursor_session' && <CurlTokenImport onToken={setValue} />}
    <Field label={t('newSecretValue')}><textarea name="value" rows={7} autoFocus required value={value} onChange={event => setValue(event.target.value)} placeholder={t('pasteNewSecret')} /></Field>
    {update.error && <p className="error">{String(update.error)}</p>}
    <div className="dialog-actions"><Button type="button" variant="outline" onClick={close}>{t('cancel')}</Button><Button type="submit" disabled={update.isPending}><Save size={16} />{update.isPending ? t('updating') : t('update')}</Button></div>
  </form></div>
}

function SecretsPage() {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [editingSecret, setEditingSecret] = useState<StoredSecret>()
  const [copyNotice, setCopyNotice] = useState('')
  const copyNoticeTimer = useRef<number | undefined>(undefined)
  const [purpose, setPurpose] = useState('general_key')
  const [secretValue, setSecretValue] = useState('')
  const [importReset, setImportReset] = useState(0)
  const { data = [] } = useQuery({ queryKey: ['secrets'], queryFn: () => api<StoredSecret[]>('/api/v1/admin/secrets') })
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/secrets/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['secrets'] })
      client.invalidateQueries({ queryKey: ['provider-status'] })
    },
  })
  useEffect(() => () => window.clearTimeout(copyNoticeTimer.current), [])
  async function copySecret(value: string, message: string) {
    try {
      await copyText(value)
      setCopyNotice(message)
      window.clearTimeout(copyNoticeTimer.current)
      copyNoticeTimer.current = window.setTimeout(() => setCopyNotice(''), 2000)
    } catch {
      // keep silent if both clipboard paths fail
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    await api('/api/v1/admin/secrets', { method: 'POST', body: JSON.stringify({ name: form.get('name'), purpose, value: secretValue }) })
    formElement.reset()
    setPurpose('general_key')
    setSecretValue('')
    setImportReset(value => value + 1)
    await client.invalidateQueries({ queryKey: ['secrets'] })
  }
  return <><header className="page-header"><div><h1>{t('secrets')}</h1><p className="muted">{t('tokenHint')}</p></div></header><div className="two-column"><form className="card form-card" onSubmit={submit}><Field label={t('name')}><input name="name" defaultValue="general-key" required /></Field><Field label="Purpose"><select name="purpose" value={purpose} onChange={event => setPurpose(event.target.value)}><option value="general_key">General Key</option><option value="cursor_session">Cursor Session</option></select></Field>{purpose === 'cursor_session' && <CurlTokenImport key={importReset} onToken={setSecretValue} />}<Field label="Secret value"><textarea name="value" rows={5} required value={secretValue} onChange={event => setSecretValue(event.target.value)} /></Field><Button type="submit"><Save size={16} />{t('save')}</Button></form><div className="card"><h3>{t('storedSecrets')}</h3>{data.map(secret => <div className="secret-row stored-secret-row" key={secret.id}><KeyRound size={16} /><div className="secret-details"><button type="button" className="secret-copy" title={t('copySecretName')} onClick={() => void copySecret(secret.name, t('secretNameCopied'))}><b>{secret.name}</b></button><p>{secret.purpose} · ID: <button type="button" className="secret-copy secret-id" title={t('copySecretId')} onClick={() => void copySecret(secret.id, t('secretIdCopied'))}>{secret.id}</button> · {new Date(secret.updated_at).toLocaleString()}</p></div><div className="secret-actions"><Button type="button" variant="outline" onClick={() => setEditingSecret(secret)}><Pencil size={15} />{t('update')}</Button><Button type="button" variant="danger" disabled={remove.isPending} onClick={() => { if (window.confirm(t('deleteSecretConfirm', { name: secret.name }))) remove.mutate(secret.id) }}><Trash2 size={15} />{t('delete')}</Button></div></div>)}{remove.error && <p className="error">{String(remove.error)}</p>}</div></div>{copyNotice && <div className="toast" role="status">{copyNotice}</div>}{editingSecret && <SecretUpdateDialog secret={editingSecret} close={() => setEditingSecret(undefined)} />}</>
}

type ProviderState = { cacheKey: string; lastSuccessAt?: string; lastError?: string }
type SystemHealth = { status: string; database: string; scheduler: boolean; version: string; gitSha?: string; buildTime?: string }
type SecurityInfo = { adminUsername: string; masterKeyConfigured: boolean }

function formatBuildVersion(health: SystemHealth): string {
  const parts = [health.version]
  if (health.gitSha) parts.push(health.gitSha)
  if (health.buildTime) parts.push(health.buildTime)
  return parts.join(' · ')
}

function SystemInfoPage() {
  const { t } = useTranslation()
  const [, navigate] = useLocation()
  const health = useQuery({ queryKey: ['system-health'], queryFn: () => api<SystemHealth>('/health') })
  const providers = useQuery({ queryKey: ['provider-status'], queryFn: () => api<ProviderState[]>('/api/v1/admin/providers/status') })

  return <><header className="page-header"><div><h1>{t('systemInfo')}</h1><p className="muted">{t('systemInfoHint')}</p></div><Button variant="outline" onClick={() => { void health.refetch(); void providers.refetch() }}><RefreshCw size={16} />{t('refresh')}</Button></header>
    <div className="two-column">
      <section className="card"><h3>{t('serviceStatus')}</h3>{health.error && <p className="error">{String(health.error)}</p>}{health.data && <>
        <div className="secret-row"><Server size={16} /><div><b>{t('buildVersion')}</b><p>{formatBuildVersion(health.data)}</p></div></div>
        <div className="secret-row"><Server size={16} /><div><b>{t('server')}</b><p>{health.data.status}</p></div></div>
        <div className="secret-row"><Server size={16} /><div><b>{t('database')}</b><p>{health.data.database}</p></div></div>
        <div className="secret-row"><RefreshCw size={16} /><div><b>{t('scheduler')}</b><p>{health.data.scheduler ? t('running') : t('stopped')}</p></div></div>
      </>}</section>
      <section className="card"><h3>{t('providerStatus')}</h3>{providers.error && <p className="error">{String(providers.error)}</p>}{providers.data?.map(state => <div className="secret-row" key={state.cacheKey}><RefreshCw size={16} /><div><b>{state.cacheKey}</b><p>{state.lastError ? `${t('providerError')}: ${state.lastError}` : `${t('lastSuccess')}: ${state.lastSuccessAt ? new Date(state.lastSuccessAt).toLocaleString() : t('never')}`}</p></div></div>)}</section>
    </div>
    <section className="card" style={{ marginTop: 16 }}>
      <h3>{t('accountSecurity')}</h3>
      <p className="muted">{t('accountSecurityHint')}</p>
      <Button variant="outline" onClick={() => navigate('/system/account')}><Settings2 size={16} />{t('editAccount')}</Button>
    </section>
  </>
}

function AccountSecurityPage() {
  const { t } = useTranslation()
  const [, navigate] = useLocation()
  const queryClient = useQueryClient()
  const security = useQuery({ queryKey: ['security'], queryFn: () => api<SecurityInfo>('/api/v1/admin/security') })
  const [currentPassword, setCurrentPassword] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [securityMessage, setSecurityMessage] = useState('')
  const [securityError, setSecurityError] = useState('')

  useEffect(() => {
    if (security.data?.adminUsername) setNewUsername(security.data.adminUsername)
  }, [security.data?.adminUsername])

  const saveAccount = useMutation({
    mutationFn: () => api<SecurityInfo>('/api/v1/admin/security', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword,
        adminUsername: newUsername,
        ...(newPassword ? { newPassword, confirmPassword } : {}),
      }),
    }),
    onSuccess: (data) => {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setSecurityError('')
      setSecurityMessage(t('accountUpdated'))
      setNewUsername(data.adminUsername)
      void queryClient.invalidateQueries({ queryKey: ['security'] })
    },
    onError: (reason) => {
      setSecurityMessage('')
      setSecurityError(String(reason))
    },
  })

  return <>
    <header className="page-header">
      <div>
        <h1>{t('accountSecurity')}</h1>
        <p className="muted">{t('accountSecurityHint')}</p>
      </div>
      <Button variant="outline" onClick={() => navigate('/system')}>{t('backToSystem')}</Button>
    </header>
    <section className="card form-card">
      {security.error && <p className="error">{String(security.error)}</p>}
      <form onSubmit={event => { event.preventDefault(); setSecurityMessage(''); setSecurityError(''); saveAccount.mutate() }}>
        <Field label={t('currentPassword')}><input type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required /></Field>
        <Field label={t('newUsername')}><input autoComplete="username" value={newUsername} onChange={e => setNewUsername(e.target.value)} required /></Field>
        <Field label={t('newPassword')}><input type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder={t('passwordOptionalHint')} /></Field>
        <Field label={t('confirmPassword')}><input type="password" autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} /></Field>
        {securityMessage && <p className="muted">{securityMessage}</p>}
        {securityError && <p className="error">{securityError}</p>}
        <Button type="submit" disabled={saveAccount.isPending}><Save size={16} />{t('saveAccount')}</Button>
      </form>
    </section>
  </>
}

type Manifest = { snapshot_id: string; update_type: 'full' | 'partial'; width: number; height: number; color_mode: 'bw' | 'bwry'; panel_layout: Screen['panel_layout']; encoding: string; frame_url: string; sha256: string; regions: Array<{ x: number; y: number; width: number; height: number; stride?: number; plane_byte_size?: number; url: string; sha256: string }> }

function SimulatorPage() {
  const { t } = useTranslation(); const canvasRef = useRef<HTMLCanvasElement>(null)
  const { data: screens = [] } = useQuery({ queryKey: ['screens'], queryFn: () => api<Screen[]>('/api/v1/admin/screens') })
  const [screenId, setScreenId] = useState(''); const [key, setKey] = useState(''); const [base, setBase] = useState(''); const [log, setLog] = useState<string[]>([])
  const [lastManifest, setLastManifest] = useState<Manifest>(); const [lastFrame, setLastFrame] = useState<Blob>()
  useEffect(() => { if (!screenId && screens[0]) setScreenId(screens[0].id) }, [screens, screenId])
  function decode(data: Uint8Array, manifest: Manifest, region?: Manifest['regions'][number]) {
    const canvas = canvasRef.current!; if (!region) { canvas.width = manifest.width; canvas.height = manifest.height }
    const context = canvas.getContext('2d')!; const image = region ? context.getImageData(0, 0, canvas.width, canvas.height) : context.createImageData(canvas.width, canvas.height)
    const colors = [[255,255,255], [255,220,0], [220,0,0], [0,0,0]]
    const target = region || { x: 0, y: 0, width: manifest.width, height: manifest.height }
    for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
      let value: number
      if (manifest.color_mode === 'bw') value = (data[y * Math.ceil(target.width / 8) + Math.floor(x / 8)] >> (7 - x % 8)) & 1
      else {
        const panelWidth = manifest.width / 2
        const dualPanel = manifest.panel_layout === 'dual-panel-left-right'
        const panel = dualPanel && x >= panelWidth ? 1 : 0
        const streamIndex = dualPanel
          ? y * panelWidth + x - panel * panelWidth
          : y * manifest.width + x
        const byteOffset = dualPanel ? panel * Math.ceil(panelWidth * manifest.height / 4) : 0
        value = (data[byteOffset + Math.floor(streamIndex / 4)] >> (6 - 2 * (streamIndex % 4))) & 3
      }
      const color = manifest.color_mode === 'bw' ? (value ? [0,0,0] : [255,255,255]) : colors[value]
      const offset = ((target.y + y) * manifest.width + target.x + x) * 4
      image.data.set([...color, 255], offset)
    }
    context.putImageData(image, 0, 0)
  }
  async function pull() {
    try {
      const started = performance.now()
      // Avoid browser HTTP cache injecting If-None-Match; only 304 via base_snapshot_id is intentional.
      const deviceFetch = (url: string) => fetch(url, { headers: { 'X-API-Key': key }, cache: 'no-store' })
      const response = await deviceFetch(`/api/v1/device/screens/${screenId}/manifest${base ? `?base_snapshot_id=${base}` : ''}`)
      if (response.status === 304) { setLog(v => [`304 unchanged · ${new Date().toLocaleTimeString()}`, ...v]); return }
      if (!response.ok) throw new Error(await response.text())
      const manifest = await response.json() as Manifest
      setLastManifest(manifest)
      if (manifest.update_type === 'full') {
        const frameResponse = await deviceFetch(manifest.frame_url)
        if (!frameResponse.ok) throw new Error(await frameResponse.text())
        const bin = new Uint8Array(await frameResponse.arrayBuffer())
        if (await sha256Hex(bin) !== manifest.sha256) throw new Error('Frame SHA-256 mismatch')
        setLastFrame(new Blob([bin.buffer as ArrayBuffer], { type: 'application/octet-stream' }))
        decode(bin, manifest)
      } else {
        setLastFrame(undefined)
        for (const region of manifest.regions) {
          const regionResponse = await deviceFetch(region.url)
          if (!regionResponse.ok) throw new Error(await regionResponse.text())
          const bin = new Uint8Array(await regionResponse.arrayBuffer())
          if (await sha256Hex(bin) !== region.sha256) throw new Error(`Region ${region.x},${region.y} SHA-256 mismatch`)
          const plane = region.plane_byte_size ?? Math.ceil(region.width / 8) * region.height
          decode(bin.subarray(plane, plane * 2), manifest, region)
        }
      }
      const elapsed = Math.round(performance.now() - started)
      setBase(manifest.snapshot_id); setLog(v => [`${manifest.update_type} · ${manifest.regions.length} regions · ${elapsed}ms · ${manifest.snapshot_id} · ${manifest.encoding}`, ...v])
    } catch (reason) { setLog(v => [`ERROR · ${String(reason)}`, ...v]) }
  }
  function download(content: Blob, name: string) { const url = URL.createObjectURL(content); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url) }
  return <><header className="page-header"><div><h1>{t('simulator')}</h1><p className="muted">Exercise the exact ESP32 manifest and binary pull flow without hardware.</p></div><Button onClick={pull}><RefreshCw size={16} />{t('pull')}</Button></header><div className="sim-grid"><aside className="card form-card"><Field label={t('screens')}><select value={screenId} onChange={e => { setScreenId(e.target.value); setBase('') }}>{screens.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select></Field><Field label={t('apiKey')}><textarea value={key} rows={4} onChange={e => setKey(e.target.value)} /></Field><p className="muted">Base snapshot: {base || 'none'}</p>{lastManifest && <Button variant="outline" onClick={() => download(new Blob([JSON.stringify(lastManifest, null, 2)], { type: 'application/json' }), `${lastManifest.snapshot_id}.json`)}>Download manifest</Button>}{lastFrame && lastManifest && <Button variant="outline" onClick={() => download(lastFrame, `${lastManifest.snapshot_id}.bin`)}>Download frame</Button>}</aside><section><div className="card simulator-canvas"><canvas ref={canvasRef} /></div><div className="card log">{log.map((line, index) => <code key={index}>{line}</code>)}</div></section></div></>
}

function AuthenticatedApp() {
  return <Shell><Switch><Route path="/"><ScreensPage /></Route><Route path="/system/account"><AccountSecurityPage /></Route><Route path="/system"><SystemInfoPage /></Route><Route path="/screens/:id"><EditorPage /></Route><Route path="/plugins"><PluginMarketplacePage /></Route><Route path="/secrets"><SecretsPage /></Route><Route path="/simulator"><SimulatorPage /></Route><Route><Redirect to="/" /></Route></Switch></Shell>
}

function App() {
  const [auth, setAuth] = useState<'loading' | 'yes' | 'no'>('loading')
  useEffect(() => { restoreSession().then(() => setAuth('yes')).catch(() => setAuth('no')) }, [])
  if (auth === 'loading') return <div className="loading">Loading…</div>
  return <QueryClientProvider client={queryClient}><Switch><Route path="/login">{auth === 'yes' ? <Redirect to="/" /> : <LoginPage onLogin={() => setAuth('yes')} />}</Route><Route>{auth === 'yes' ? <AuthenticatedApp /> : <Redirect to="/login" />}</Route></Switch></QueryClientProvider>
}

export default App
