import type { CSSProperties } from 'react'
import type {
  LocalizedValue,
  WidgetMeta,
  WidgetSettingsField,
} from '../../api'

type Props = {
  meta: WidgetMeta
  value: Record<string, unknown>
  language: string
  onChange: (next: Record<string, unknown>) => void
}

function localized(
  value: LocalizedValue | undefined,
  language: string,
  fallback = '',
) {
  if (!value) return fallback
  if (typeof value === 'string') return value
  return value[language] || value.en || Object.values(value)[0] || fallback
}

export default function PluginSettingsForm({
  meta,
  value,
  language,
  onChange,
}: Props) {
  const properties = meta.configSchema.properties || {}
  const ui = meta.settingsUi || {}
  const assigned = new Set(
    (ui.sections || []).flatMap(section => section.fields),
  )
  const unassigned = Object.keys(properties).filter(
    key => key !== 'style_id' && !assigned.has(key),
  )
  const sections = [
    ...(ui.sections || []),
    ...(unassigned.length ? [{ fields: unassigned }] : []),
  ]
  const style = {
    '--widget-settings-accent': ui.style?.accent || '#18181b',
    '--widget-settings-surface': ui.style?.surface || '#fafafa',
    '--widget-settings-border': ui.style?.border || '#e4e4e7',
    '--widget-settings-label': ui.style?.label || '#27272a',
    '--widget-settings-radius': `${ui.style?.radius ?? 9}px`,
  } as CSSProperties

  function update(key: string, nextValue: unknown) {
    onChange({ ...value, [key]: nextValue })
  }

  function renderField(key: string) {
    const property = properties[key]
    if (!property) return null
    const field: WidgetSettingsField = ui.fields?.[key] || {}
    const current = value[key] ?? property.default ?? ''
    const label = localized(field.label, language, property.title || key)
    const help = localized(field.help, language, property.description || '')
    const placeholder = localized(field.placeholder, language)
    const suffix = localized(field.suffix, language)
    const options = field.options || property.enum?.map(option => ({
      value: option as string | number | boolean,
      label: String(option),
    }))
    const control = field.control
      || (options ? 'select' : property.type === 'boolean' ? 'toggle'
        : property.type === 'integer' || property.type === 'number' ? 'number'
          : 'text')
    const min = field.min ?? property.minimum
    const max = field.max ?? property.maximum

    if (control === 'toggle') {
      return <label className="plugin-settings-toggle" key={key}>
        <span><b>{label}</b>{help && <small>{help}</small>}</span>
        <input
          type="checkbox"
          checked={Boolean(current)}
          onChange={event => update(key, event.target.checked)}
        />
        <i aria-hidden="true" />
      </label>
    }

    if (control === 'segmented' && options) {
      return <div className="plugin-settings-field" key={key}>
        <span>{label}</span>
        <div className="plugin-settings-segmented">
          {options.map(option => <button
            type="button"
            className={String(current) === String(option.value) ? 'active' : ''}
            key={String(option.value)}
            onClick={() => update(key, option.value)}
          >
            {localized(option.label, language, String(option.value))}
          </button>)}
        </div>
        {help && <small>{help}</small>}
      </div>
    }

    if (control === 'range') {
      return <label className="plugin-settings-field" key={key}>
        <span>{label}<output>{String(current)}{suffix}</output></span>
        <input
          type="range"
          value={Number(current)}
          min={min}
          max={max}
          step={field.step}
          onChange={event => update(key, Number(event.target.value))}
        />
        {help && <small>{help}</small>}
      </label>
    }

    if (control === 'select' && options) {
      return <label className="plugin-settings-field" key={key}>
        <span>{label}</span>
        <select
          value={String(current)}
          onChange={event => {
            const selected = options.find(
              option => String(option.value) === event.target.value,
            )
            update(key, selected?.value ?? event.target.value)
          }}
        >
          {options.map(option => <option
            value={String(option.value)}
            key={String(option.value)}
          >
            {localized(option.label, language, String(option.value))}
          </option>)}
        </select>
        {help && <small>{help}</small>}
      </label>
    }

    if (control === 'textarea') {
      return <label className="plugin-settings-field" key={key}>
        <span>{label}</span>
        <textarea
          value={String(current)}
          rows={field.rows || 3}
          placeholder={placeholder}
          onChange={event => update(key, event.target.value)}
        />
        {help && <small>{help}</small>}
      </label>
    }

    const numeric = control === 'number'
    return <label className="plugin-settings-field" key={key}>
      <span>{label}</span>
      <input
        type={control === 'password' ? 'password' : numeric ? 'number' : 'text'}
        value={String(current)}
        min={min}
        max={max}
        step={field.step}
        placeholder={placeholder}
        onChange={event => update(
          key,
          numeric && event.target.value !== ''
            ? Number(event.target.value)
            : event.target.value,
        )}
      />
      {help && <small>{help}</small>}
    </label>
  }

  return <div className="plugin-settings-form" style={style}>
    {sections.map((section, index) => <section
      className="plugin-settings-section"
      key={`${index}:${section.fields.join(',')}`}
    >
      {(section.title || section.description) && <header>
        {section.title && <h4>{localized(section.title, language)}</h4>}
        {section.description && <p>
          {localized(section.description, language)}
        </p>}
      </header>}
      <div>{section.fields.map(renderField)}</div>
    </section>)}
  </div>
}
