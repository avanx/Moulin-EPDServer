import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, ChevronDown, ChevronRight, Download, FileUp, Package, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-react'
import { Rnd } from 'react-rnd'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useRoute } from 'wouter'
import { api, apiBlob, compatibleStyles, isStyleCompatible } from '../../api'
import type { AlignmentMargin, PluginMeta, Screen, ScreenDocument, Widget, WidgetMeta } from '../../api'
import { randomUUID } from '../../uuid'
import PluginSettingsForm from './PluginSettingsForm'

function Button({ children, variant = 'default', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'danger' }) {
  return <button className={`button ${variant}`} {...props}>{children}</button>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>
}

function localized(values: Record<string, string> | undefined, language: string, fallback: string) {
  return values?.[language] || values?.en || fallback
}

function downloadJson(document: ScreenDocument, filename: string) {
  const blob = new Blob([JSON.stringify(document, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function WidgetStylePicker({
  meta,
  value,
  language,
  availableColors,
  onChange,
}: {
  meta: WidgetMeta
  value: string
  language: string
  availableColors: string[]
  onChange: (styleId: string) => void
}) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const styles = compatibleStyles(meta, availableColors)
  const selected = styles.find(style => style.id === value)
  const selectedLabel = selected
    ? localized(selected.title, language, selected.id)
    : value
  const normalizedQuery = query.trim().toLocaleLowerCase(language)
  const filtered = styles.filter(style => {
    const label = localized(style.title, language, style.id)
    return !normalizedQuery
      || label.toLocaleLowerCase(language).includes(normalizedQuery)
      || style.id.toLocaleLowerCase().includes(normalizedQuery)
  })

  useEffect(() => {
    if (!open) return
    function close(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  if (!styles.length) return null
  return <section className="widget-style-picker">
    <h4>{t('widgetStyle')}</h4>
    <div className="style-combobox" ref={rootRef}>
      <Search size={14} aria-hidden="true" />
      <input
        role="combobox"
        aria-expanded={open}
        aria-controls="widget-style-options"
        aria-label={t('searchStyles')}
        placeholder={selectedLabel || t('searchStyles')}
        value={open ? query : selectedLabel}
        onFocus={() => {
          setQuery('')
          setOpen(true)
        }}
        onChange={event => {
          setQuery(event.target.value)
          setOpen(true)
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            setOpen(false)
            setQuery('')
            event.currentTarget.blur()
          }
        }}
      />
      <button
        type="button"
        className="style-combobox-toggle"
        aria-label={t('widgetStyle')}
        onClick={() => {
          setQuery('')
          setOpen(current => !current)
        }}
      >
        <ChevronDown size={14} />
      </button>
      {open && <div className="style-combobox-options" id="widget-style-options" role="listbox">
        {filtered.map(style => <button
          type="button"
          role="option"
          aria-selected={value === style.id}
          className={value === style.id ? 'active' : ''}
          key={style.id}
          onClick={() => {
            onChange(style.id)
            setOpen(false)
            setQuery('')
          }}
        >
          <span>{localized(style.title, language, style.id)}<small>{style.id}</small></span>
          {value === style.id && <Check size={14} />}
        </button>)}
        {!filtered.length && <p>{t('noStylesFound')}</p>}
      </div>}
    </div>
  </section>
}

function ScreenSettings({ screen }: { screen: Screen }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    await api(`/api/v1/admin/screens/${screen.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: form.get('name'),
        width: Number(form.get('width')),
        height: Number(form.get('height')),
        color_mode: form.get('color_mode'),
        panel_layout: form.get('panel_layout'),
        refresh_seconds: Number(form.get('refresh_seconds')),
        enabled: form.get('enabled') === 'on',
      }),
    })
    client.invalidateQueries({ queryKey: ['screen', screen.id] })
    client.invalidateQueries({ queryKey: ['screens'] })
  }
  return <form className="schema-form" onSubmit={submit}>
    <Field label={t('name')}><input name="name" defaultValue={screen.name} /></Field>
    <div className="grid-2"><Field label="Width"><input name="width" type="number" defaultValue={screen.width} /></Field><Field label="Height"><input name="height" type="number" defaultValue={screen.height} /></Field></div>
    <Field label={t('color')}><select name="color_mode" defaultValue={screen.color_mode}><option value="bw">BW</option><option value="bwry">BWRY</option></select></Field>
    <Field label={t('panelLayout')}><select name="panel_layout" required defaultValue={screen.panel_layout}><option value="linear">{t('panelLayoutLinear')}</option><option value="dual-panel-left-right">{t('panelLayoutDualLeftRight')}</option></select></Field>
    <Field label={t('interval')}><input name="refresh_seconds" type="number" min="2" defaultValue={screen.refresh_seconds} /></Field>
    <label className="checkbox"><input name="enabled" type="checkbox" defaultChecked={screen.enabled} /> Enabled</label>
    <Button type="submit"><Save size={15} />{t('save')}</Button>
  </form>
}

function PluginPalette({
  plugins,
  language,
  availableColors,
  onAdd,
}: {
  plugins: PluginMeta[]
  language: string
  availableColors: string[]
  onAdd: (plugin: PluginMeta) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const enabled = plugins.filter(plugin =>
    plugin.enabled
    && plugin.status === 'available'
    && compatibleStyles(plugin, availableColors).length > 0)
  const normalizedQuery = query.trim().toLocaleLowerCase(language)
  const filtered = enabled.filter(plugin => {
    if (!normalizedQuery) return true
    const searchable = [
      localized(plugin.title, language, plugin.type),
      localized(plugin.description, language, ''),
      plugin.type,
    ].join(' ').toLocaleLowerCase(language)
    return searchable.includes(normalizedQuery)
  })
  return <section className="card editor-plugin-palette">
    <div className="marketplace-title"><Package size={17} /><h3>{t('addWidget')}</h3></div>
    <label className="plugin-search"><Search size={14} /><span className="sr-only">{t('searchWidgets')}</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('searchWidgets')} /></label>
    <div className="palette-list">{filtered.map(plugin =>
      <button key={plugin.type} onClick={() => onAdd(plugin)}><Plus size={14} /><span><b>{localized(plugin.title, language, plugin.type)}</b><small>{localized(plugin.description, language, plugin.type)}</small></span></button>,
    )}</div>
    {!enabled.length && <p className="muted">{t('noEnabledPlugins')}</p>}
    {Boolean(enabled.length && !filtered.length) && <p className="muted">{t('noWidgetsFound')}</p>}
    <Link className="manage-plugins-link" href="/plugins">{t('managePlugins')}</Link>
  </section>
}

type EditorWidget = Widget & { previewKey: string }

const emptyAlignmentMargin = (): AlignmentMargin => ({ top: 0, right: 0, bottom: 0, left: 0 })

function withAlignmentMargin(widget: Widget): Widget {
  return { ...widget, alignment_margin: widget.alignment_margin ?? emptyAlignmentMargin() }
}

function toDraft(widget: EditorWidget) {
  const { id, screen_id: _screenId, config_version: _version, previewKey: _previewKey, ...draft } = widget
  return { ...draft, id: id.startsWith('draft:') ? null : id }
}

type WidgetPreview = {
  url?: string
  loading?: boolean
  error?: string
}

function useInitialDraftPreview(id: string, widgets: Widget[], enabled = true) {
  const [preview, setPreview] = useState<WidgetPreview>({})

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let url = ''
    setPreview({ loading: true })
    void apiBlob(`/api/v1/admin/screens/${id}/draft-preview`, {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({
        widgets: widgets.map(widget => toDraft({ ...widget, previewKey: widget.id })),
        mode: 'device',
        data_source: 'mock',
      }),
    })
      .then(result => {
        url = URL.createObjectURL(result.blob)
        setPreview({ url })
      })
      .catch(reason => {
        if (!controller.signal.aborted) setPreview({ error: String(reason) })
      })
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [enabled, id, widgets])

  return preview
}

function useWidgetPreviews(id: string, widgets: EditorWidget[], enabled = true) {
  const [previews, setPreviews] = useState<Record<string, WidgetPreview>>({})
  const knownKeys = useRef(new Set<string>())
  const requests = useRef(new Map<string, AbortController>())
  const urls = useRef(new Map<string, string>())
  const previewKeys = widgets.map(widget => widget.previewKey).join('\u0000')

  useEffect(() => {
    for (const controller of requests.current.values()) controller.abort()
    for (const url of urls.current.values()) URL.revokeObjectURL(url)
    requests.current.clear()
    urls.current.clear()
    knownKeys.current.clear()
    setPreviews({})
  }, [id])

  useEffect(() => {
    if (!enabled) return
    const needsPreview = (widget: EditorWidget) =>
      widget.id.startsWith('draft:') || widget.previewKey !== widget.id
    const activeKeys = new Set(widgets.filter(needsPreview).map(widget => widget.previewKey))
    for (const [key, controller] of requests.current) {
      if (!activeKeys.has(key)) {
        controller.abort()
        requests.current.delete(key)
        knownKeys.current.delete(key)
      }
    }
    for (const [key, url] of urls.current) {
      if (!activeKeys.has(key)) {
        URL.revokeObjectURL(url)
        urls.current.delete(key)
        knownKeys.current.delete(key)
      }
    }
    setPreviews(current => Object.fromEntries(
      Object.entries(current).filter(([key]) => activeKeys.has(key)),
    ))

    for (const widget of widgets) {
      if (!needsPreview(widget)) continue
      const key = widget.previewKey
      if (knownKeys.current.has(key)) continue
      knownKeys.current.add(key)
      const controller = new AbortController()
      requests.current.set(key, controller)
      setPreviews(current => ({ ...current, [key]: { loading: true } }))
      void apiBlob(`/api/v1/admin/screens/${id}/widget-preview`, {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify(toDraft(widget)),
        })
        .then(result => {
          const url = URL.createObjectURL(result.blob)
          if (!knownKeys.current.has(key)) {
            URL.revokeObjectURL(url)
            return
          }
          urls.current.set(key, url)
          setPreviews(current => ({ ...current, [key]: { url } }))
        })
        .catch(reason => {
          if (!controller.signal.aborted) {
            setPreviews(current => ({ ...current, [key]: { error: String(reason) } }))
          }
        })
        .finally(() => requests.current.delete(key))
    }
  }, [enabled, id, previewKeys, widgets])

  useEffect(() => () => {
    for (const controller of requests.current.values()) controller.abort()
    for (const url of urls.current.values()) URL.revokeObjectURL(url)
  }, [])

  return previews
}

function useCanvasScale(width: number) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const update = () => setScale(Math.max(0.01, frame.clientWidth / width))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [width])

  return { frameRef, scale }
}

export default function EditorPage() {
  const [, params] = useRoute('/screens/:id')
  const [, navigate] = useLocation()
  const id = params?.id || ''
  const { t, i18n } = useTranslation()
  const client = useQueryClient()
  const [selected, setSelected] = useState<string>()
  const [displayMode, setDisplayMode] = useState<'source' | 'device'>('device')
  const [useMockData, setUseMockData] = useState(true)
  const [widgets, setWidgets] = useState<EditorWidget[]>([])
  const [dirty, setDirty] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [publishedError, setPublishedError] = useState('')
  const [publishedPreviews, setPublishedPreviews] = useState({ source: '', device: '' })
  const importRef = useRef<HTMLInputElement>(null)
  const screenQuery = useQuery({ queryKey: ['screen', id], queryFn: () => api<Screen>(`/api/v1/admin/screens/${id}`) })
  const widgetsQuery = useQuery({ queryKey: ['widgets', id], queryFn: () => api<Widget[]>(`/api/v1/admin/screens/${id}/widgets`) })
  const pluginsQuery = useQuery({ queryKey: ['screen-plugins', id], queryFn: () => api<PluginMeta[]>(`/api/v1/admin/screens/${id}/plugins`) })
  const screen = screenQuery.data
  const plugins = pluginsQuery.data || []
  const persistedWidgets = widgetsQuery.data || []
  const active = widgets.find(widget => widget.id === selected)
  const activeMeta = plugins.find(plugin => plugin.type === active?.widget_type)
  const { frameRef, scale } = useCanvasScale(screen?.width || 1)
  const initialDraftPreview = useInitialDraftPreview(id, persistedWidgets, Boolean(screen && widgetsQuery.data))
  const widgetPreviews = useWidgetPreviews(id, widgets, Boolean(screen))
  const persistedWidgetsById = new Map(persistedWidgets.map(widget => [widget.id, widget]))

  useEffect(() => {
    if (!dirty && widgetsQuery.data) {
      setWidgets(widgetsQuery.data.map(widget => ({ ...withAlignmentMargin(widget), previewKey: widget.id })))
    }
  }, [widgetsQuery.data, dirty])

  useEffect(() => () => {
    if (publishedPreviews.source) URL.revokeObjectURL(publishedPreviews.source)
    if (publishedPreviews.device) URL.revokeObjectURL(publishedPreviews.device)
  }, [publishedPreviews])

  const deleteWidget = useCallback((widgetId: string) => {
    setWidgets(current => current.filter(item => item.id !== widgetId))
    setSelected(undefined)
    setDirty(true)
    setSaveError('')
  }, [])

  useEffect(() => {
    function handleDelete(event: KeyboardEvent) {
      if (event.key !== 'Delete' || !selected) return
      const target = event.target
      if (target instanceof HTMLElement && (
        target.isContentEditable
        || target.closest('input, textarea, select, [contenteditable="true"]')
      )) return
      event.preventDefault()
      deleteWidget(selected)
    }
    window.addEventListener('keydown', handleDelete)
    return () => window.removeEventListener('keydown', handleDelete)
  }, [deleteWidget, selected])

  function updateWidget(widget: EditorWidget, patch: Partial<EditorWidget>) {
    setWidgets(current => current.map(item => item.id === widget.id
      ? { ...item, ...patch, previewKey: `${item.id}:${randomUUID()}` }
      : item))
    setDirty(true)
    setSaveError('')
  }

  function updateGeometry(key: 'x' | 'y' | 'width' | 'height', rawValue: number) {
    if (!active || !screen || !Number.isFinite(rawValue)) return
    if (key === 'x') updateWidget(active, { x: Math.max(0, Math.min(Math.round(rawValue), screen.width - active.width)) })
    if (key === 'y') updateWidget(active, { y: Math.max(0, Math.min(Math.round(rawValue), screen.height - active.height)) })
    if (key === 'width') {
      const width = Math.max(1, Math.min(Math.round(rawValue), screen.width))
      updateWidget(active, { width, x: Math.min(active.x, screen.width - width) })
    }
    if (key === 'height') {
      const height = Math.max(1, Math.min(Math.round(rawValue), screen.height))
      updateWidget(active, { height, y: Math.min(active.y, screen.height - height) })
    }
  }

  function updateAlignmentMargin(key: keyof AlignmentMargin, rawValue: number) {
    if (!active || !screen || !Number.isFinite(rawValue)) return
    const available = key === 'left' || key === 'right'
      ? screen.width - active.width
      : screen.height - active.height
    updateWidget(active, {
      alignment_margin: {
        ...active.alignment_margin,
        [key]: Math.max(0, Math.min(Math.round(rawValue), available)),
      },
    })
  }

  function alignActive(horizontal?: 'left' | 'center' | 'right', vertical?: 'top' | 'middle' | 'bottom') {
    if (!active || !screen) return
    const margin = active.alignment_margin
    const maxX = screen.width - active.width
    const maxY = screen.height - active.height
    const left = Math.min(margin.left, maxX)
    const right = Math.min(margin.right, maxX)
    const top = Math.min(margin.top, maxY)
    const bottom = Math.min(margin.bottom, maxY)
    const patch: Partial<Widget> = {}
    if (horizontal === 'left') patch.x = left
    if (horizontal === 'center') patch.x = Math.round((maxX + left - right) / 2)
    if (horizontal === 'right') patch.x = maxX - right
    if (vertical === 'top') patch.y = top
    if (vertical === 'middle') patch.y = Math.round((maxY + top - bottom) / 2)
    if (vertical === 'bottom') patch.y = maxY - bottom
    updateWidget(active, patch)
  }

  function addWidget(meta: WidgetMeta) {
    if (!screen) return
    const config = Object.fromEntries(Object.entries(meta.configSchema.properties || {}).filter(([, property]) => property.default !== undefined).map(([key, property]) => [key, property.default]))
    const availableStyles = compatibleStyles(meta, screen.available_colors)
    const preferredStyleId = String(config.style_id || meta.defaultStyle || 'default')
    const style = availableStyles.find(item => item.id === preferredStyleId) || availableStyles[0]
    if (!style) {
      setSaveError(t('noCompatibleStyles', { widget: meta.type }))
      return
    }
    const styleId = style.id
    const x = Math.min(10, Math.max(0, screen.width - 1))
    const y = Math.min(10, Math.max(0, screen.height - 1))
    const draftId = `draft:${randomUUID()}`
    const created: EditorWidget = {
      id: draftId,
      previewKey: draftId,
      screen_id: id,
      widget_type: meta.type,
      x,
      y,
      width: Math.min(style.defaultSize.width, screen.width - x),
      height: Math.min(style.defaultSize.height, screen.height - y),
      z_index: widgets.length,
      alignment_margin: emptyAlignmentMargin(),
      config: { ...config, style_id: styleId },
      config_version: 0,
    }
    setWidgets(current => [...current, created])
    setSelected(created.id)
    setDirty(true)
    setSaveError('')
  }

  function changeWidgetStyle(widget: EditorWidget, meta: WidgetMeta, styleId: string) {
    if (!screen) return
    const style = meta.styles.find(item => item.id === styleId)
    if (!style) {
      setSaveError(`Widget ${meta.type} has no style ${styleId}`)
      return
    }
    if (!isStyleCompatible(style, screen.available_colors)) {
      setSaveError(t('styleMissingColors', {
        colors: style.requiredColors.filter(color => !screen.available_colors.includes(color)).join(', '),
      }))
      return
    }
    const width = Math.min(style.defaultSize.width, screen.width)
    const height = Math.min(style.defaultSize.height, screen.height)
    updateWidget(widget, {
      width,
      height,
      x: Math.min(widget.x, screen.width - width),
      y: Math.min(widget.y, screen.height - height),
      config: { ...widget.config, style_id: styleId },
    })
  }

  async function saveLayout() {
    const selectedIndex = widgets.findIndex(widget => widget.id === selected)
    try {
      const saved = await api<Widget[]>(`/api/v1/admin/screens/${id}/widgets`, { method: 'PUT', body: JSON.stringify(widgets.map(toDraft)) })
      const savedWidgets = saved.map((widget, index) => ({
        ...withAlignmentMargin(widget),
        previewKey: widgets[index]?.previewKey || widget.id,
      }))
      setWidgets(savedWidgets)
      client.setQueryData(['widgets', id], saved)
      setSelected(selectedIndex >= 0 ? saved[selectedIndex]?.id : undefined)
      setDirty(false)
      setSaveError('')
    } catch (reason) {
      setSaveError(String(reason))
    }
  }

  async function render() {
    if (!screen) return
    setRendering(true)
    setPublishedError('')
    try {
      const result = await api<{ queued?: boolean; warnings?: string[]; snapshot_id?: string | null }>(
        `/api/v1/admin/screens/${id}/render`,
        {
          method: 'POST',
          body: JSON.stringify({ data_source: useMockData ? 'mock' : 'real' }),
        },
      )
      if (result.warnings?.length) {
        setPublishedError(`真实数据加载失败，错误组件已显示在预览中：${result.warnings.join('；')}`)
      }
      let updated = await api<Screen>(`/api/v1/admin/screens/${id}`)
      if (!result.snapshot_id && !updated.current_snapshot_id) {
        throw new Error('渲染完成但未生成设备快照')
      }
      if (result.snapshot_id && updated.current_snapshot_id !== result.snapshot_id) {
        updated = { ...updated, current_snapshot_id: result.snapshot_id }
      }
      const [source, device] = await Promise.all([
        apiBlob(`/api/v1/admin/screens/${id}/preview?mode=source`),
        apiBlob(`/api/v1/admin/screens/${id}/preview?mode=device`),
      ])
      setPublishedPreviews({
        source: URL.createObjectURL(source.blob),
        device: URL.createObjectURL(device.blob),
      })
      client.setQueryData(['screen', id], updated)
    } catch (reason) {
      setPublishedError(String(reason))
    } finally {
      setRendering(false)
    }
  }

  async function exportScreen() {
    if (!screen) return
    try {
      const document = await api<ScreenDocument>(
        `/api/v1/admin/screens/${id}/export`,
      )
      const safeName = screen.name.replace(/[\\/:*?"<>|]+/g, '-')
      downloadJson(document, `${safeName || 'screen'}.json`)
    } catch (reason) {
      setSaveError(String(reason))
    }
  }

  async function deleteScreen() {
    if (!screen || !window.confirm(t('deleteScreenConfirm', { name: screen.name }))) return
    setDeleting(true)
    setSaveError('')
    try {
      await api(`/api/v1/admin/screens/${id}`, { method: 'DELETE' })
      await client.invalidateQueries({ queryKey: ['screens'] })
      client.removeQueries({ queryKey: ['screen', id] })
      client.removeQueries({ queryKey: ['widgets', id] })
      client.removeQueries({ queryKey: ['screen-plugins', id] })
      navigate('/')
    } catch (reason) {
      setSaveError(String(reason))
      setDeleting(false)
    }
  }

  async function importScreen(file: File) {
    if (!window.confirm(t('overwriteImportConfirm'))) {
      if (importRef.current) importRef.current.value = ''
      return
    }
    setSaveError('')
    try {
      const document = JSON.parse(await file.text()) as ScreenDocument
      const updated = await api<Screen>(
        `/api/v1/admin/screens/${id}/import`,
        { method: 'PUT', body: JSON.stringify(document) },
      )
      setSelected(undefined)
      setDirty(false)
      setWidgets([])
      setPublishedPreviews({ source: '', device: '' })
      client.setQueryData(['screen', id], updated)
      await Promise.all([
        client.invalidateQueries({ queryKey: ['screens'] }),
        client.invalidateQueries({ queryKey: ['widgets', id] }),
        client.invalidateQueries({ queryKey: ['screen-plugins', id] }),
      ])
    } catch (reason) {
      setSaveError(String(reason))
    } finally {
      if (importRef.current) importRef.current.value = ''
    }
  }

  if (!screen) return <p>Loading…</p>
  return <><header className="page-header"><div><Link className="breadcrumb" href="/">Screens <ChevronRight size={14} /></Link><h1>{screen.name}</h1><p className="muted">{screen.width} × {screen.height} · {screen.color_mode.toUpperCase()}{dirty ? ` · ${t('unsaved')}` : ''}</p></div><div className="screen-actions"><input ref={importRef} className="sr-only" type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) void importScreen(file) }} /><Button variant="danger" onClick={() => void deleteScreen()} disabled={deleting}><Trash2 size={16} />{deleting ? t('deleting') : t('delete')}</Button><Button variant="outline" onClick={() => void exportScreen()}><Download size={16} />{t('exportScreen')}</Button><Button variant="outline" onClick={() => importRef.current?.click()}><FileUp size={16} />{t('importOverwrite')}</Button><Button onClick={saveLayout} disabled={!dirty}><Save size={16} />{t('saveLayout')}</Button><Button variant="outline" onClick={render} disabled={dirty || rendering} title={dirty ? t('saveBeforeRender') : ''}><RefreshCw size={16} />{rendering ? t('updating') : t('render')}</Button></div></header>
    {saveError && <p className="error">{saveError}</p>}
    <div className="editor-layout">
      <PluginPalette plugins={plugins} language={i18n.language} availableColors={screen.available_colors} onAdd={addWidget} />
      <section className="workspace">
        <section className="card display-section">
          <div className="display-section-header"><div><h3>{t('canvas')}</h3><p>{t('canvasHint')}</p></div><span className="data-mode mock">{t('dataMode.mock')}</span></div>
          <div className="layout-toolbar">
            <span>{active ? t('alignSelected') : t('selectWidgetToAlign')}</span>
            <div className="alignment-actions">
              <Button variant="outline" disabled={!active} onClick={() => alignActive('left')}>{t('alignLeft')}</Button>
              <Button variant="outline" disabled={!active} onClick={() => alignActive('center')}>{t('alignCenter')}</Button>
              <Button variant="outline" disabled={!active} onClick={() => alignActive('right')}>{t('alignRight')}</Button>
              <Button variant="outline" disabled={!active} onClick={() => alignActive(undefined, 'top')}>{t('alignTop')}</Button>
              <Button variant="outline" disabled={!active} onClick={() => alignActive(undefined, 'middle')}>{t('alignMiddle')}</Button>
              <Button variant="outline" disabled={!active} onClick={() => alignActive(undefined, 'bottom')}>{t('alignBottom')}</Button>
            </div>
          </div>
          {(initialDraftPreview.error || Object.values(widgetPreviews).some(item => item.error)) && <div className="preview-error"><AlertCircle size={15} />{initialDraftPreview.error || Object.values(widgetPreviews).find(item => item.error)?.error}</div>}
          <div ref={frameRef} className="canvas-frame" style={{ aspectRatio: `${screen.width} / ${screen.height}` }} onMouseDown={() => setSelected(undefined)}>
            <div className="epd-canvas" style={{ width: screen.width, height: screen.height, transform: `scale(${scale})` }}>
              {widgets.map(widget => {
                const widgetPreview = widgetPreviews[widget.previewKey]
                const persistedWidget = persistedWidgetsById.get(widget.id)
                return <Rnd key={widget.id} bounds="parent" scale={scale} minWidth={1} minHeight={1} size={{ width: widget.width, height: widget.height }} position={{ x: widget.x, y: widget.y }} onDragStop={(_, data) => updateWidget(widget, { x: Math.round(data.x), y: Math.round(data.y) })} onResizeStop={(_, __, ref, ___, position) => updateWidget(widget, { width: ref.offsetWidth, height: ref.offsetHeight, x: Math.round(position.x), y: Math.round(position.y) })} onMouseDown={event => { event.stopPropagation(); setSelected(widget.id) }} className={selected === widget.id ? 'widget-box selected' : 'widget-box'}>
                  {widgetPreview?.url && <img className="widget-preview-image" src={widgetPreview.url} alt="" />}
                  {!widgetPreview?.url && initialDraftPreview.url && persistedWidget && <img className="widget-preview-crop" src={initialDraftPreview.url} alt="" style={{ width: screen.width, height: screen.height, left: -persistedWidget.x, top: -persistedWidget.y }} />}
                  {(widgetPreview?.loading || (initialDraftPreview.loading && persistedWidget)) && <span className="widget-preview-loading">{t('updating')}</span>}
                  <span>{localized(plugins.find(plugin => plugin.type === widget.widget_type)?.title, i18n.language, widget.widget_type)}</span>
                </Rnd>
              })}
            </div>
          </div>
        </section>
        <section className="card display-section">
          <div className="display-section-header"><div><h3>{t('publishedPreview')}</h3><p>{t('renderForPublishedPreview')}</p></div><div className="preview-controls">
            <label className="data-source-switch"><input type="checkbox" checked={useMockData} onChange={event => setUseMockData(event.target.checked)} /><span aria-hidden="true" /><b>{t('useMockData')}</b></label>
            <select value={displayMode} onChange={event => setDisplayMode(event.target.value as typeof displayMode)}><option value="source">Source</option><option value="device">Device color</option></select>
          </div></div>
          {publishedError && <div className="preview-error"><AlertCircle size={15} />{publishedError}</div>}
          <div className="preview-frame" style={{ aspectRatio: `${screen.width} / ${screen.height}` }}>
            {publishedPreviews[displayMode] && <img src={publishedPreviews[displayMode]} alt={t('publishedPreview')} />}
            {!publishedPreviews[displayMode] && <span className="published-preview-empty">{t('renderForPublishedPreview')}</span>}
            {rendering && <span className="display-loading">{t('updating')}</span>}
          </div>
        </section>
      </section>
      <aside className="card inspector"><h3>{activeMeta ? localized(activeMeta.title, i18n.language, activeMeta.type) : t('editor')}</h3>{active && activeMeta ? <><div className="geometry-editor"><h4>{t('positionAndSize')}</h4><div className="geometry-grid"><Field label="X"><input type="number" value={active.x} onChange={event => updateGeometry('x', Number(event.target.value))} /></Field><Field label="Y"><input type="number" value={active.y} onChange={event => updateGeometry('y', Number(event.target.value))} /></Field><Field label={t('width')}><input type="number" min="1" value={active.width} onChange={event => updateGeometry('width', Number(event.target.value))} /></Field><Field label={t('height')}><input type="number" min="1" value={active.height} onChange={event => updateGeometry('height', Number(event.target.value))} /></Field></div><details className="alignment-margin" key={active.id}><summary><ChevronRight size={14} />{t('alignmentMargin')}</summary><div className="geometry-grid"><Field label={t('top')}><input type="number" min="0" max={screen.height - active.height} value={active.alignment_margin.top} onChange={event => updateAlignmentMargin('top', Number(event.target.value))} /></Field><Field label={t('bottom')}><input type="number" min="0" max={screen.height - active.height} value={active.alignment_margin.bottom} onChange={event => updateAlignmentMargin('bottom', Number(event.target.value))} /></Field><Field label={t('left')}><input type="number" min="0" max={screen.width - active.width} value={active.alignment_margin.left} onChange={event => updateAlignmentMargin('left', Number(event.target.value))} /></Field><Field label={t('right')}><input type="number" min="0" max={screen.width - active.width} value={active.alignment_margin.right} onChange={event => updateAlignmentMargin('right', Number(event.target.value))} /></Field></div></details></div><WidgetStylePicker meta={activeMeta} value={String(active.config.style_id || activeMeta.defaultStyle || 'default')} language={i18n.language} availableColors={screen.available_colors} onChange={styleId => changeWidgetStyle(active, activeMeta, styleId)} /><PluginSettingsForm meta={activeMeta} value={active.config} language={i18n.language} onChange={config => updateWidget(active, { config })} /><Button variant="danger" onClick={() => deleteWidget(active.id)}>{t('delete')}</Button></> : <ScreenSettings screen={screen} />}</aside>
    </div></>
}
