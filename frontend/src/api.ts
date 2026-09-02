export type PanelLayout = 'linear' | 'dual-panel-left-right'

export type UserRole = 'admin' | 'user'

export type AuthUser = {
  username: string
  role: UserRole
}

export type ManagedUser = {
  id: string
  username: string
  role: UserRole
  screen_count: number
  created_at: string
}

export type Screen = {
  id: string
  name: string
  width: number
  height: number
  color_mode: 'bw' | 'bwry'
  panel_layout: PanelLayout
  available_colors: string[]
  refresh_seconds: number
  enabled: boolean
  owner_id: string
  owner_username: string | null
  current_snapshot_id: string | null
}

export type ScreenDocument = {
  format: 'epdserver-screen'
  version: 1
  exported_at: string | null
  screen: Omit<Screen, 'id' | 'owner_id' | 'owner_username' | 'current_snapshot_id' | 'available_colors'>
  plugins: Record<string, boolean>
  widgets: Array<Omit<Widget, 'id' | 'screen_id' | 'config_version'>>
}

export type AlignmentMargin = {
  top: number
  right: number
  bottom: number
  left: number
}

export type Widget = {
  id: string
  screen_id: string
  widget_type: string
  x: number
  y: number
  width: number
  height: number
  z_index: number
  alignment_margin: AlignmentMargin
  config: Record<string, unknown>
  config_version: number
}

export type LocalizedValue = string | Record<string, string>

export type WidgetSettingsField = {
  control?: 'text' | 'password' | 'textarea' | 'number' | 'range' | 'select' | 'segmented' | 'toggle'
  label?: LocalizedValue
  help?: LocalizedValue
  placeholder?: LocalizedValue
  min?: number
  max?: number
  step?: number
  rows?: number
  suffix?: LocalizedValue
  options?: Array<{ value: string | number | boolean; label: LocalizedValue }>
}

export type WidgetSettingsUi = {
  sections?: Array<{
    title?: LocalizedValue
    description?: LocalizedValue
    fields: string[]
  }>
  fields?: Record<string, WidgetSettingsField>
  style?: {
    accent?: string
    surface?: string
    border?: string
    label?: string
    radius?: number
  }
}

export type WidgetMeta = {
  type: string
  title: Record<string, string>
  description?: Record<string, string>
  version?: string
  supportsMock?: boolean
  mockConfig?: Record<string, unknown>
  configSchema: {
    properties?: Record<string, {
      title?: string
      type?: string
      default?: unknown
      enum?: unknown[]
      description?: string
      minimum?: number
      maximum?: number
    }>
    required?: string[]
  }
  settingsUi?: WidgetSettingsUi
  styles: Array<{
    id: string
    title: Record<string, string>
    defaultSize: { width: number; height: number }
    requiredColors: string[]
  }>
  defaultStyle?: string
}

export type PluginMeta = WidgetMeta & {
  packageName: string
  sourceType: 'builtin' | 'directory' | 'entry_point' | 'git'
  sourceUrl: string | null
  sourceRef: string | null
  status: 'available' | 'load_error' | 'missing'
  loadError: string | null
  enabled: boolean
}

export type WidgetStyleMeta = WidgetMeta['styles'][number]

export type WidgetSource = {
  type: string
  styleId: string
  builtin: boolean
  template: string
  style: string
  manifest: WidgetStyleMeta
  mockData: Record<string, unknown>
  draft: boolean
  published: boolean
}

export type WidgetDataSource = {
  type: string
  source: string
  draft: boolean
  published: boolean
}

export function missingStyleColors(style: WidgetStyleMeta, availableColors: string[]) {
  const available = new Set(availableColors)
  return (style.requiredColors || []).filter(color => !available.has(color))
}

export function isStyleCompatible(style: WidgetStyleMeta, availableColors: string[]) {
  return missingStyleColors(style, availableColors).length === 0
}

export function compatibleStyles(meta: WidgetMeta, availableColors: string[]) {
  return (meta.styles || []).filter(style => isStyleCompatible(style, availableColors))
}

let csrfToken = sessionStorage.getItem('epd-csrf') || ''

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (!['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase()) && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken)
  }
  const response = await fetch(path, { ...init, headers, credentials: 'include' })
  if (!response.ok) {
    const body = await response.text()
    let message = body
    try {
      const payload = JSON.parse(body) as { detail?: string }
      if (typeof payload.detail === 'string') message = payload.detail
    } catch {
      // Keep non-JSON response bodies as-is.
    }
    throw new Error(message || `${response.status} ${response.statusText}`)
  }
  return response
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(path, init)
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export async function apiBlob(path: string, init: RequestInit = {}) {
  const response = await request(path, init)
  return { blob: await response.blob(), headers: response.headers }
}

type SessionResponse = AuthUser & { csrfToken: string }

export async function login(username: string, password: string): Promise<AuthUser> {
  const result = await api<SessionResponse>('/api/v1/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  csrfToken = result.csrfToken
  sessionStorage.setItem('epd-csrf', csrfToken)
  return { username: result.username, role: result.role }
}

export async function restoreSession(): Promise<AuthUser> {
  const result = await api<SessionResponse>('/api/v1/admin/auth/me')
  csrfToken = result.csrfToken
  sessionStorage.setItem('epd-csrf', csrfToken)
  return { username: result.username, role: result.role }
}

export async function logout() {
  await api('/api/v1/admin/auth/logout', { method: 'POST' })
  csrfToken = ''
  sessionStorage.removeItem('epd-csrf')
}
