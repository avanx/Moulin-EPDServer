import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Code2, CopyPlus, GitBranch, Monitor, Package, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api, compatibleStyles, missingStyleColors } from '../../api'
import type { PluginMeta, Screen, Widget } from '../../api'
import PluginSettingsForm from '../editor/PluginSettingsForm'
import WidgetCodeEditor from '../editor/WidgetCodeEditor'

type PluginInventory = Omit<PluginMeta, 'enabled'>

function localized(values: Record<string, string> | undefined, language: string, fallback: string) {
  return values?.[language] || values?.en || fallback
}

export default function PluginMarketplacePage() {
  const { t, i18n } = useTranslation()
  const client = useQueryClient()
  const [screenId, setScreenId] = useState('')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<{ type: string; styleId: string }>()
  const [editingConfig, setEditingConfig] = useState<Record<string, unknown>>({})
  const [editorDirty, setEditorDirty] = useState(false)
  const [editError, setEditError] = useState('')
  const screensQuery = useQuery({ queryKey: ['screens'], queryFn: () => api<Screen[]>('/api/v1/admin/screens') })
  const inventoryQuery = useQuery({ queryKey: ['plugins'], queryFn: () => api<PluginInventory[]>('/api/v1/admin/plugins') })
  const screenPluginsQuery = useQuery({
    queryKey: ['screen-plugins', screenId],
    queryFn: () => api<PluginMeta[]>(`/api/v1/admin/screens/${screenId}/plugins`),
    enabled: Boolean(screenId),
  })
  const screens = screensQuery.data || []
  const selectedScreen = screens.find(screen => screen.id === screenId)
  const plugins: PluginMeta[] = screenId
    ? screenPluginsQuery.data || []
    : (inventoryQuery.data || []).map(plugin => ({ ...plugin, enabled: false }))

  useEffect(() => {
    const firstScreen = screensQuery.data?.[0]
    if (!screenId && firstScreen) setScreenId(firstScreen.id)
  }, [screenId, screensQuery.data])

  async function togglePlugin(plugin: PluginMeta) {
    if (!screenId || (
      !plugin.enabled
      && selectedScreen
      && !compatibleStyles(plugin, selectedScreen.available_colors).length
    )) return
    const updated = await api<PluginMeta>(`/api/v1/admin/screens/${screenId}/plugins/${plugin.type}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: !plugin.enabled }),
    })
    client.setQueryData<PluginMeta[]>(['screen-plugins', screenId], current => current?.map(item => item.type === updated.type ? updated : item))
  }

  function canLeaveEditor() {
    return !editorDirty || window.confirm('当前组件有未保存的代码，确定放弃并离开吗？')
  }

  function switchStyle(styleId: string) {
    if (!editing || styleId === editing.styleId || !canLeaveEditor()) return
    setEditorDirty(false)
    setEditError('')
    setEditingConfig(current => ({ ...current, style_id: styleId }))
    setEditing({ ...editing, styleId })
  }

  function startEditing(plugin: PluginMeta, styleId: string) {
    const defaults = Object.fromEntries(Object.entries(plugin.configSchema.properties || {})
      .filter(([, property]) => property.default !== undefined)
      .map(([key, property]) => [key, property.default]))
    setEditingConfig({ ...defaults, ...plugin.mockConfig, style_id: styleId })
    setEditing({ type: plugin.type, styleId })
  }

  async function cloneStyle() {
    if (!editing || !canLeaveEditor()) return
    const id = window.prompt('新样式 ID（字母、数字、下划线或连字符）')
    if (!id) return
    const title = window.prompt('新样式名称', `${id} 副本`)
    if (!title) return
    setEditError('')
    try {
      await api(`/api/v1/admin/plugins/${encodeURIComponent(editing.type)}/styles/${encodeURIComponent(editing.styleId)}/clone`, {
        method: 'POST',
        body: JSON.stringify({ id, title }),
      })
      await Promise.all([
        client.invalidateQueries({ queryKey: ['plugins'] }),
        client.invalidateQueries({ queryKey: ['screen-plugins', screenId] }),
      ])
      setEditorDirty(false)
      setEditingConfig(current => ({ ...current, style_id: id }))
      setEditing({ type: editing.type, styleId: id })
    } catch (reason) {
      setEditError(String(reason))
    }
  }

  const normalized = search.trim().toLowerCase()
  const visible = plugins.filter(plugin => {
    const title = localized(plugin.title, i18n.language, plugin.type)
    return !normalized || `${title} ${plugin.type} ${plugin.packageName}`.toLowerCase().includes(normalized)
  })
  const editingPlugin = plugins.find(plugin => plugin.type === editing?.type)
  const editingStyle = editingPlugin?.styles.find(style => style.id === editing?.styleId)
  const editingWidget: Widget | undefined = editingPlugin && editingStyle
    ? {
        id: `plugin:${editingPlugin.type}:${editingStyle.id}`,
        screen_id: selectedScreen?.id || '',
        widget_type: editingPlugin.type,
        x: 0,
        y: 0,
        width: editingStyle.defaultSize.width,
        height: editingStyle.defaultSize.height,
        z_index: 0,
        alignment_margin: { top: 0, right: 0, bottom: 0, left: 0 },
        config: editingConfig,
        config_version: 0,
      }
    : undefined

  if (editingPlugin && editingStyle && editingWidget) {
    return <section className="plugin-edit-mode">
      <header className="page-header plugin-edit-header">
        <div>
          <button className="plugin-edit-back" onClick={() => {
            if (canLeaveEditor()) {
              setEditorDirty(false)
              setEditing(undefined)
            }
          }}><ArrowLeft size={16} />返回插件管理</button>
          <h1>{localized(editingPlugin.title, i18n.language, editingPlugin.type)}</h1>
          <p className="muted">{t('editWidgetCodeHint')} · 保存样式后立即应用到屏幕预览和渲染 · Data TypeScript 由所有样式共享</p>
        </div>
        <label className="marketplace-screen-select"><Monitor size={16} /><span>{t('targetScreen')}</span><select value={screenId} onChange={event => setScreenId(event.target.value)}><option value="">{t('selectScreen')}</option>{screens.map(screen => <option value={screen.id} key={screen.id}>{screen.name}</option>)}</select></label>
      </header>
      <section className="card plugin-code-workspace">
        <header className="plugin-style-toolbar">
          <div>
            <label>
              <span>{t('widgetStyle')}</span>
              <select value={editingStyle.id} onChange={event => switchStyle(event.target.value)}>
                {editingPlugin.styles.map(style => <option value={style.id} key={style.id}>{localized(style.title, i18n.language, style.id)}</option>)}
              </select>
            </label>
            <button onClick={() => void cloneStyle()}><CopyPlus size={14} />另存为用户样式</button>
          </div>
          <small>{editingStyle.id} · {editingStyle.defaultSize.width} × {editingStyle.defaultSize.height}</small>
        </header>
        {editError && <p className="error">{editError}</p>}
        <details className="plugin-edit-variables" open>
          <summary>预览变量</summary>
          <p>修改后会同步到即时沙箱、数据源测试和墨水屏预览。</p>
          <PluginSettingsForm
            meta={editingPlugin}
            value={editingConfig}
            language={i18n.language}
            onChange={setEditingConfig}
          />
        </details>
        <WidgetCodeEditor
          screen={selectedScreen}
          widget={editingWidget}
          styleId={editingStyle.id}
          onDirtyChange={setEditorDirty}
          onPublished={() => {
            void Promise.all([
              client.invalidateQueries({ queryKey: ['widgets'] }),
              client.invalidateQueries({ queryKey: ['plugins'] }),
              client.invalidateQueries({ queryKey: ['screen-plugins', screenId] }),
            ])
          }}
          onRepositoryStyleSaved={async styleId => {
            await Promise.all([
              client.invalidateQueries({ queryKey: ['widgets'] }),
              client.invalidateQueries({ queryKey: ['plugins'] }),
              client.invalidateQueries({ queryKey: ['screen-plugins', screenId] }),
            ])
            setEditorDirty(false)
            setEditingConfig(current => ({ ...current, style_id: styleId }))
            setEditing({ type: editingPlugin.type, styleId })
          }}
        />
      </section>
    </section>
  }

  return <><header className="page-header"><div><h1>{t('pluginMarketplace')}</h1><p className="muted">{t('pluginMarketplaceHint')}</p></div>
    <label className="marketplace-screen-select"><Monitor size={16} /><span>{t('targetScreen')}</span><select value={screenId} onChange={event => setScreenId(event.target.value)}><option value="">{t('selectScreen')}</option>{screens.map(screen => <option value={screen.id} key={screen.id}>{screen.name}</option>)}</select></label>
  </header>
    <section className="plugin-page">
      <div className="card marketplace-toolbar"><label className="plugin-search"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={t('searchPlugins')} /></label><div className="git-plugin-hint"><GitBranch size={15} /><span>{t('gitPluginFuture')}</span></div></div>
      {!screens.length && <div className="notice">{t('createScreenForPlugins')}</div>}
      <div className="plugin-market-grid">{visible.map(plugin => {
        const available = plugin.status === 'available'
        const compatible = !selectedScreen || compatibleStyles(plugin, selectedScreen.available_colors).length > 0
        const styles = plugin.styles || []
        const defaultStyle = plugin.defaultStyle || styles[0]?.id || ''
        const requiredColors = [...new Set(styles.flatMap(style => style.requiredColors || []))]
        const closestMissingColors = selectedScreen
          ? styles.map(style => missingStyleColors(style, selectedScreen.available_colors))
            .sort((left, right) => left.length - right.length)[0] || []
          : []
        const toggleTitle = !available
          ? plugin.loadError || plugin.status
          : plugin.enabled
            ? t('disableForScreen')
            : !compatible
              ? t('pluginMissingColors', { colors: closestMissingColors.join(', ') })
              : t('enableForScreen')
        return <article className={`card plugin-market-card ${plugin.enabled ? 'enabled' : ''} ${compatible ? '' : 'incompatible'}`} key={plugin.type}>
          <div className="plugin-card-title"><div className="plugin-icon"><Package size={18} /></div><div><b>{localized(plugin.title, i18n.language, plugin.type)}</b><small>{plugin.packageName} · {plugin.version}</small></div>
            <label className="plugin-toggle" title={toggleTitle}>
              <input type="checkbox" checked={plugin.enabled && available} disabled={!screenId || !available || (!compatible && !plugin.enabled)} onChange={() => void togglePlugin(plugin)} /><span />
            </label>
          </div>
          <p>{available ? localized(plugin.description, i18n.language, plugin.type) : plugin.loadError || t('pluginUnavailable')}</p>
          <div className="plugin-color-support"><span>{t('colorsUsed')}</span>{requiredColors.map(color =>
            <span className={`color-badge ${selectedScreen ? selectedScreen.available_colors.includes(color) ? 'supported' : 'unsupported' : ''}`} key={color}>{color}</span>,
          )}</div>
          {selectedScreen && !compatible && <div className="plugin-compatibility incompatible">{t('pluginMissingColors', { colors: closestMissingColors.join(', ') })}</div>}
          {available && <div className="plugin-code-actions">
            <button disabled={!defaultStyle} onClick={() => startEditing(plugin, defaultStyle)}><Code2 size={14} />{t('editWidgetCode')}</button>
          </div>}
        </article>
      })}</div>
    </section>
  </>
}
