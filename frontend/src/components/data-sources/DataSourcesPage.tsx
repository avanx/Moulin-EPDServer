import { useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Database, Pencil, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api, filterMetaFields } from '../../api'
import type { PluginMeta, SharedDataSource, WidgetMeta } from '../../api'
import PluginSettingsForm from '../editor/PluginSettingsForm'

function Button({ children, variant = 'default', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'danger' }) {
  return <button className={`button ${variant}`} {...props}>{children}</button>
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small className="field-hint">{hint}</small>}</label>
}

function localized(value: Record<string, string> | undefined, language: string, fallback: string) {
  if (!value) return fallback
  return value[language] || value.en || Object.values(value)[0] || fallback
}

/** Editable copy of a data source: id is absent while creating. */
type Draft = { id?: string; widget_type: string; name: string; config: Record<string, unknown> }

function sharedFieldsOf(meta: WidgetMeta | undefined): string[] {
  return meta?.sharedFields || []
}

/** Initial data-source config: schema defaults, then mock values, with secret references left blank. */
function initialConfig(meta: WidgetMeta): Record<string, unknown> {
  const fields = sharedFieldsOf(meta)
  const properties = meta.configSchema.properties || {}
  const config: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.endsWith('secret_id')) {
      config[field] = ''
      continue
    }
    const value = meta.mockConfig?.[field] ?? properties[field]?.default
    if (value !== undefined) config[field] = value
  }
  return config
}

function newDraft(meta: WidgetMeta | undefined): Draft | undefined {
  if (!meta) return undefined
  return { widget_type: meta.type, name: '', config: initialConfig(meta) }
}

export default function DataSourcesPage() {
  const { t, i18n } = useTranslation()
  const client = useQueryClient()
  const pluginsQuery = useQuery({ queryKey: ['plugins'], queryFn: () => api<PluginMeta[]>('/api/v1/admin/plugins') })
  const sourcesQuery = useQuery({ queryKey: ['data-sources'], queryFn: () => api<SharedDataSource[]>('/api/v1/admin/data-sources') })
  const shareable = (pluginsQuery.data || []).filter(plugin => plugin.status === 'available' && sharedFieldsOf(plugin).length > 0)
  const metaByType = new Map(shareable.map(plugin => [plugin.type, plugin]))
  const [draft, setDraft] = useState<Draft>()
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState<Record<string, string>>({})
  const current = draft ?? newDraft(shareable[0])
  const currentMeta = current ? metaByType.get(current.widget_type) : undefined

  const invalidate = () => client.invalidateQueries({ queryKey: ['data-sources'] })
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/data-sources/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })
  const refresh = useMutation({
    mutationFn: (id: string) => api<{ data: Record<string, unknown> }>(`/api/v1/admin/data-sources/${id}/refresh`, { method: 'POST' }),
    onSuccess: (result, id) => {
      setNotice(value => ({ ...value, [id]: result.data?._stale ? t('dataSourceRefreshStale') : t('dataSourceRefreshed') }))
      void invalidate()
    },
    onError: (error, id) => {
      setNotice(value => ({ ...value, [id]: String(error) }))
      void invalidate()
    },
  })

  function widgetTitle(type: string) {
    const meta = metaByType.get(type) || pluginsQuery.data?.find(plugin => plugin.type === type)
    return localized(meta?.title, i18n.language, type)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!current) return
    try {
      const body = JSON.stringify({ name: current.name, widget_type: current.widget_type, config: current.config })
      if (current.id) await api(`/api/v1/admin/data-sources/${current.id}`, { method: 'PUT', body })
      else await api('/api/v1/admin/data-sources', { method: 'POST', body })
      setDraft(undefined)
      setFormError('')
      await invalidate()
    } catch (error) {
      setFormError(String(error))
    }
  }

  function edit(source: SharedDataSource) {
    setDraft({ id: source.id, widget_type: source.widget_type, name: source.name, config: { ...source.config } })
    setFormError('')
  }

  const sources = sourcesQuery.data || []
  return <>
    <header className="page-header"><div><h1>{t('dataSources')}</h1><p className="muted">{t('dataSourcesHint')}</p></div></header>
    <div className="two-column">
      <form className="card form-card" onSubmit={submit}>
        <h3>{current?.id ? t('dataSourceEdit') : t('dataSourceCreate')}</h3>
        {!shareable.length && <p className="muted">{t('dataSourceNoWidgets')}</p>}
        {current && <>
          <Field label={t('dataSourceWidgetType')}>
            <select
              value={current.widget_type}
              disabled={Boolean(current.id)}
              onChange={event => setDraft({ ...newDraft(metaByType.get(event.target.value))!, name: current.name })}
            >
              {shareable.map(plugin => <option key={plugin.type} value={plugin.type}>{localized(plugin.title, i18n.language, plugin.type)}</option>)}
            </select>
          </Field>
          <Field label={t('name')}><input value={current.name} required maxLength={120} onChange={event => setDraft({ ...current, name: event.target.value })} /></Field>
          {currentMeta && <PluginSettingsForm
            meta={filterMetaFields(currentMeta, field => sharedFieldsOf(currentMeta).includes(field))}
            value={current.config}
            language={i18n.language}
            onChange={config => setDraft({ ...current, config })}
          />}
          {formError && <p className="error">{formError}</p>}
          <div className="dialog-actions">
            {current.id && <Button type="button" variant="outline" onClick={() => { setDraft(undefined); setFormError('') }}><Plus size={16} />{t('dataSourceCreate')}</Button>}
            <Button type="submit"><Save size={16} />{current.id ? t('update') : t('save')}</Button>
          </div>
        </>}
      </form>
      <div className="card">
        <h3>{t('dataSourceList')}</h3>
        {sourcesQuery.error && <p className="error">{String(sourcesQuery.error)}</p>}
        {!sources.length && <p className="muted">{t('dataSourceEmpty')}</p>}
        {sources.map(source => <div className="secret-row stored-secret-row" key={source.id}>
          <Database size={16} />
          <div className="secret-details">
            <b>{source.name}</b>
            <p>
              {widgetTitle(source.widget_type)}
              {source.refresh_seconds != null && <> · {t('dataSourceRefreshInterval', { minutes: Math.round(source.refresh_seconds / 60) })}</>}
              {' · '}{t('dataSourceUsage', { count: source.usage_count })}
            </p>
            <p>
              {t('lastSuccess')}: {source.last_success_at ? new Date(source.last_success_at).toLocaleString() : t('never')}
              {source.expires_at && <> · {t('dataSourceExpires')}: {new Date(source.expires_at).toLocaleString()}</>}
            </p>
            {source.last_error && <p className="error">{t('providerError')}: {source.last_error}</p>}
            {notice[source.id] && <p className="muted">{notice[source.id]}</p>}
          </div>
          <div className="secret-actions">
            <Button type="button" variant="outline" disabled={refresh.isPending && refresh.variables === source.id} onClick={() => refresh.mutate(source.id)}><RefreshCw size={15} />{t('dataSourceRefreshNow')}</Button>
            <Button type="button" variant="outline" onClick={() => edit(source)}><Pencil size={15} />{t('update')}</Button>
            <Button type="button" variant="danger" disabled={remove.isPending} onClick={() => { if (window.confirm(t('dataSourceDeleteConfirm', { name: source.name }))) remove.mutate(source.id) }}><Trash2 size={15} />{t('delete')}</Button>
          </div>
        </div>)}
        {remove.error && <p className="error">{String(remove.error)}</p>}
      </div>
    </div>
  </>
}
