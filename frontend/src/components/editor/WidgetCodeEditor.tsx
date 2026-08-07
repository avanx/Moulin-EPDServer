import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, Code2, Crosshair, PanelRightClose, Play, RotateCcw, Save, Sparkles, Upload } from 'lucide-react'
import { api, apiBlob } from '../../api'
import type { Screen, Widget, WidgetDataSource, WidgetSource, WidgetStyleMeta } from '../../api'
import { randomUUID } from '../../uuid'
import CodeMirrorEditor from './CodeMirrorEditor'
import type { CodeReveal } from './CodeMirrorEditor'

type EditableSource = Pick<WidgetSource, 'template' | 'style'>
type Tab = 'template' | 'style' | 'manifest' | 'data'

const EMPTY_SOURCE: EditableSource = { template: '', style: '' }

function openingTagEnd(html: string, start: number) {
  let quote: string | null = null
  for (let index = start; index < html.length; index += 1) {
    const char = html[index]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '>') return index + 1
  }
  return Math.min(start + 1, html.length)
}

function safeJson(value: unknown) {
  return JSON.stringify(value ?? null)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

function validateSource(source: EditableSource) {
  if (/<\s*(script|iframe|object|embed|link|meta|base)\b/i.test(source.template)
    || /\son[a-z]+\s*=/i.test(source.template)) {
    return 'HTML 中不能包含脚本、事件属性或嵌入式内容。'
  }
  if (/@import\b/i.test(source.style) || /expression\s*\(/i.test(source.style)
    || /url\s*\(\s*(['"]?)(?:https?:|\/\/)/i.test(source.style)) {
    return 'CSS 不允许导入、expression 或远程 URL。'
  }
  return ''
}

function parseManifest(source: string, expectedId: string) {
  try {
    const value = JSON.parse(source) as WidgetStyleMeta
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('必须是 JSON 对象')
    if (value.id !== expectedId) throw new Error('样式 ID 不可修改')
    if (!value.title || typeof value.title !== 'object' || Array.isArray(value.title)
      || !Object.keys(value.title).length || Object.values(value.title).some(item => typeof item !== 'string')) {
      throw new Error('title 必须是非空的多语言字符串映射')
    }
    if (!Number.isInteger(value.defaultSize?.width) || !Number.isInteger(value.defaultSize?.height)
      || value.defaultSize.width <= 0 || value.defaultSize.height <= 0) {
      throw new Error('defaultSize 的宽高必须是正整数')
    }
    const colors = value.requiredColors
    const known = new Set(['black', 'white', 'red', 'yellow'])
    if (!Array.isArray(colors) || !colors.length || colors.some(color => !known.has(color))
      || new Set(colors).size !== colors.length) {
      throw new Error('requiredColors 只能包含不重复的 black、white、red、yellow')
    }
    return { value, error: '' }
  } catch (reason) {
    return { value: undefined, error: `Manifest 无效：${reason instanceof Error ? reason.message : String(reason)}` }
  }
}

function sandboxDocument(source: EditableSource, previewId: string, width: number, height: number) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<style>html,body,#mount{width:100%;height:100%;margin:0;overflow:hidden;background:#fff}</style></head>
<body><div id="mount"></div><script>
const previewId=${safeJson(previewId)};
const source=${safeJson(source)};
const renderWidth=${safeJson(width)};
const renderHeight=${safeJson(height)};
const respond=(type,value)=>parent.postMessage({channel:"epd-widget-preview",previewId,type,value},"*");
const annotateTemplate=html=>html.replace(/<\\/?[A-Za-z][\\w:-]*\\b[^>]*>/g,(match,offset)=>{
 if(match.startsWith("</")||/\\sdata-epd-src\\s*=/.test(match))return match;
 return match.replace(/^(<[A-Za-z][\\w:-]*)/,'$1 data-epd-src="'+offset+'"');
});
let inspectRoot=null;
let inspectEnabled=false;
let hoverEl=null;
let booted=false;
const clearHover=()=>{if(hoverEl){hoverEl.classList.remove("epd-inspect-hover");hoverEl=null}};
const setInspect=enabled=>{
 inspectEnabled=!!enabled;
 if(!inspectRoot)return;
 inspectRoot.classList.toggle("epd-inspect-active",inspectEnabled);
 if(!inspectEnabled)clearHover();
};
const bindInspect=root=>{
 inspectRoot=root;
 root.addEventListener("pointermove",event=>{
  if(!inspectEnabled)return;
  const next=event.target instanceof Element?event.target.closest("[data-epd-src]"):null;
  if(next===hoverEl)return;
  clearHover();
  if(!next)return;
  hoverEl=next;
  hoverEl.classList.add("epd-inspect-hover");
 },true);
 root.addEventListener("click",event=>{
  if(!inspectEnabled)return;
  event.preventDefault();
  event.stopPropagation();
  const target=event.target instanceof Element?event.target.closest("[data-epd-src]"):null;
  if(!target)return;
  const from=Number(target.getAttribute("data-epd-src"));
  if(!Number.isFinite(from))return;
  parent.postMessage({channel:"epd-widget-inspect",previewId,from},"*");
 },true);
 setInspect(inspectEnabled);
};
addEventListener("message",event=>{
 if(!event.data||event.data.previewId!==previewId)return;
 if(event.data.channel==="epd-widget-inspect-mode"){setInspect(event.data.enabled);return}
 if(event.data.channel!=="epd-widget-init"||booted)return;
 try{
  const mount=document.getElementById("mount");mount.textContent="";
  const shadow=mount.attachShadow?mount.attachShadow({mode:"open"}):mount;
  shadow.innerHTML="<style>:host{display:block;width:100%;height:100%;overflow:hidden;color:#000;background:#fff;font-family:Arial,sans-serif}*,*::before,*::after{box-sizing:border-box}.epd-widget-root{position:relative;width:100%;height:100%;overflow:hidden}.epd-widget-root.epd-inspect-active,.epd-widget-root.epd-inspect-active *{cursor:crosshair!important}.epd-inspect-hover{outline:2px solid #2563eb!important;outline-offset:1px;cursor:crosshair!important}svg{display:block}"+source.style+"</style><div class=\\"epd-preview-stage\\" style=\\"position:absolute;left:0;top:0;width:"+renderWidth+"px;height:"+renderHeight+"px;transform-origin:0 0\\"><div class=\\"epd-widget-root\\"></div></div>";
  const stage=shadow.querySelector(".epd-preview-stage");
  const root=shadow.querySelector(".epd-widget-root");root.innerHTML=annotateTemplate(source.template);
  const fit=()=>{const scale=Math.min(innerWidth/renderWidth,innerHeight/renderHeight);stage.style.transform="scale("+scale+")";stage.style.left=(innerWidth-renderWidth*scale)/2+"px";stage.style.top=(innerHeight-renderHeight*scale)/2+"px"};
  fit();addEventListener("resize",fit);
  const state=Object.freeze(event.data.state);
  for(const node of root.querySelectorAll("[data-text]")){let value=state;for(const key of node.getAttribute("data-text").split("."))value=value==null?undefined:value[key];node.textContent=value==null?"":String(value)}
  for(const node of root.querySelectorAll("[data-class]")){let value=state;for(const key of node.getAttribute("data-class").split("."))value=value==null?undefined:value[key];if(typeof value==="string")for(const token of value.split(/\\s+/))if(/^[a-z0-9_-]+$/i.test(token))node.classList.add(token)}
  for(const node of root.querySelectorAll("[data-percent]")){let value=state;for(const key of node.getAttribute("data-percent").split("."))value=value==null?undefined:value[key];node.style.setProperty("--percent",Math.min(100,Math.max(0,Number(value)||0))+"%")}
  for(const [key,value] of Object.entries(state.config||{})){root.style.setProperty("--config-"+key.replaceAll("_","-"),String(value));if(value===true)root.classList.add("config-"+key.replaceAll("_","-"))}
  bindInspect(root);
  booted=true;
  respond("ready");
 }catch(error){respond("error",String(error))}
});
</script></body></html>`
}

async function formatCode(tab: Tab, code: string) {
  const [
    prettier,
    htmlPlugin,
    postcssPlugin,
    estreePlugin,
    typescriptPlugin,
  ] = await Promise.all([
    import('prettier/standalone'),
    import('prettier/plugins/html'),
    import('prettier/plugins/postcss'),
    import('prettier/plugins/estree'),
    import('prettier/plugins/typescript'),
  ])
  const parser = tab === 'template' ? 'html'
    : tab === 'style' ? 'css'
      : 'typescript'
  return prettier.format(code, {
    parser,
    plugins: [
      htmlPlugin.default,
      postcssPlugin.default,
      estreePlugin.default,
      typescriptPlugin.default,
    ],
    semi: false,
    singleQuote: true,
  })
}

export default function WidgetCodeEditor({
  screen,
  widget,
  styleId,
  onPublished,
  onRepositoryStyleSaved,
  onDirtyChange,
}: {
  screen?: Screen
  widget: Widget
  styleId: string
  onPublished: () => void
  onRepositoryStyleSaved: (styleId: string) => void | Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}) {
  const client = useQueryClient()
  const iframe = useRef<HTMLIFrameElement>(null)
  const inspectModeRef = useRef(false)
  const [tab, setTab] = useState<Tab>('template')
  const [source, setSource] = useState<EditableSource>(EMPTY_SOURCE)
  const [manifestSource, setManifestSource] = useState('')
  const [dataSource, setDataSource] = useState('')
  const [debouncedSource, setDebouncedSource] = useState<EditableSource>(EMPTY_SOURCE)
  const [operationError, setOperationError] = useState('')
  const [runtimeError, setRuntimeError] = useState('')
  const [busy, setBusy] = useState('')
  const [testUrl, setTestUrl] = useState('')
  const [testStrategy, setTestStrategy] = useState('')
  const [testedData, setTestedData] = useState<unknown>()
  const [codePanelOpen, setCodePanelOpen] = useState(true)
  const [inspectMode, setInspectMode] = useState(false)
  const [reveal, setReveal] = useState<CodeReveal>()
  inspectModeRef.current = inspectMode
  const stylePath = `/api/v1/admin/plugins/${encodeURIComponent(widget.widget_type)}/styles/${encodeURIComponent(styleId)}/source`
  const dataPath = `/api/v1/admin/plugins/${encodeURIComponent(widget.widget_type)}/data/source`
  const adaptPath = `/api/v1/admin/plugins/${encodeURIComponent(widget.widget_type)}/data/adapt`
  const configKey = JSON.stringify(widget.config)
  const styleQueryKey = ['widget-source', widget.widget_type, styleId]
  const dataQueryKey = ['widget-data-source', widget.widget_type]
  const styleQuery = useQuery({
    queryKey: styleQueryKey,
    queryFn: () => api<WidgetSource>(stylePath),
  })
  const dataQuery = useQuery({
    queryKey: dataQueryKey,
    queryFn: () => api<WidgetDataSource>(dataPath),
  })
  const savedStyle = styleQuery.data
  const savedData = dataQuery.data
  const adaptedMockQuery = useQuery({
    queryKey: [
      'widget-adapted-mock',
      widget.widget_type,
      savedData?.source,
      savedStyle?.mockData,
      configKey,
    ],
    queryFn: () => api<{ data: unknown }>(adaptPath, {
      method: 'POST',
      body: JSON.stringify({
        source: savedData!.source,
        input: savedStyle!.mockData,
        config: widget.config,
      }),
    }),
    enabled: Boolean(savedStyle && savedData),
  })

  useEffect(() => {
    if (!savedStyle) return
    const loaded = { template: savedStyle.template, style: savedStyle.style }
    const loadedManifest = JSON.stringify(savedStyle.manifest, null, 2)
    let cancelled = false
    setSource(loaded)
    setManifestSource(loadedManifest)
    setOperationError('')
    void Promise.all([
      formatCode('template', loaded.template),
      formatCode('style', loaded.style),
    ]).then(([template, style]) => {
      if (cancelled || (template === loaded.template && style === loaded.style)) return
      const formatted = { template, style }
      setSource(current => (
        current.template === loaded.template && current.style === loaded.style ? formatted : current
      ))
      client.setQueryData<WidgetSource>(
        ['widget-source', widget.widget_type, styleId],
        current => current ? { ...current, ...formatted } : current,
      )
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [client, savedStyle, styleId, widget.widget_type])

  useEffect(() => {
    if (!savedData) return
    const loaded = savedData.source
    let cancelled = false
    setDataSource(loaded)
    void formatCode('data', loaded).then(formatted => {
      if (cancelled || formatted === loaded) return
      setDataSource(current => current === loaded ? formatted : current)
      client.setQueryData<WidgetDataSource>(
        ['widget-data-source', widget.widget_type],
        current => current ? { ...current, source: formatted } : current,
      )
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [client, savedData, widget.widget_type])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSource(source), 300)
    return () => window.clearTimeout(timer)
  }, [source])

  useEffect(() => () => {
    if (testUrl) URL.revokeObjectURL(testUrl)
  }, [testUrl])

  const syntaxError = useMemo(() => validateSource(source), [source])
  const manifestResult = useMemo(
    () => parseManifest(manifestSource, styleId),
    [manifestSource, styleId],
  )
  const manifestError = manifestResult.error
  const styleDirty = savedStyle ? (
    source.template !== savedStyle.template
    || source.style !== savedStyle.style
    || manifestSource !== JSON.stringify(savedStyle.manifest, null, 2)
  ) : false
  const dataDirty = savedData ? dataSource !== savedData.source : false
  const dirty = styleDirty || dataDirty
  const previewData = testedData ?? adaptedMockQuery.data?.data ?? savedStyle?.mockData ?? {}
  const previewDataKey = JSON.stringify(previewData)
  const previewSize = manifestResult.value?.defaultSize ?? {
    width: widget.width,
    height: widget.height,
  }

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])
  useEffect(() => setTestedData(undefined), [configKey])

  const previewId = useMemo(
    () => `${widget.id}:${styleId}:${debouncedSource.template.length}:${configKey}:${previewDataKey}:${randomUUID()}`,
    [configKey, debouncedSource, previewDataKey, widget.id, styleId],
  )
  const srcDoc = useMemo(
    () => sandboxDocument(debouncedSource, previewId, previewSize.width, previewSize.height),
    [debouncedSource, previewId, previewSize.width, previewSize.height],
  )

  function postInspectMode(enabled: boolean) {
    iframe.current?.contentWindow?.postMessage({
      channel: 'epd-widget-inspect-mode',
      previewId,
      enabled,
    }, '*')
  }

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.source !== iframe.current?.contentWindow
        || event.data?.previewId !== previewId) return
      if (event.data.channel === 'epd-widget-preview') {
        if (event.data.type === 'error') setRuntimeError(String(event.data.value))
        if (event.data.type === 'ready') {
          setRuntimeError('')
          if (inspectModeRef.current) postInspectMode(true)
        }
        return
      }
      if (event.data.channel !== 'epd-widget-inspect') return
      const from = Number(event.data.from)
      if (!Number.isFinite(from)) return
      const template = debouncedSource.template
      const to = openingTagEnd(template, from)
      setCodePanelOpen(true)
      setTab('template')
      setReveal({ from, to, key: Date.now() })
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [debouncedSource.template, previewId])

  useEffect(() => {
    postInspectMode(inspectMode)
  }, [inspectMode, previewId])

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.key === 'Escape' && inspectModeRef.current) {
        setInspectMode(false)
        return
      }
      if (event.shiftKey && event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        void formatActive()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  })

  function initializePreview() {
    setRuntimeError('')
    iframe.current?.contentWindow?.postMessage({
      channel: 'epd-widget-init',
      previewId,
      state: {
        data: previewData,
        config: widget.config,
        size: previewSize,
        locale: 'zh-CN',
      },
    }, '*')
  }

  function acceptStyle(result: WidgetSource) {
    client.setQueryData(styleQueryKey, result)
    setSource({ template: result.template, style: result.style })
    setManifestSource(JSON.stringify(result.manifest, null, 2))
    setOperationError('')
  }

  function acceptData(result: WidgetDataSource) {
    client.setQueryData(dataQueryKey, result)
    setDataSource(result.source)
    setOperationError('')
  }

  async function mutateStyle(action: string, requestPath: string, method: string, body?: string) {
    setBusy(action)
    setOperationError('')
    try {
      acceptStyle(await api<WidgetSource>(requestPath, { method, ...(body ? { body } : {}) }))
      if (action === 'publish-style' || action === 'restore-style') onPublished()
    } catch (reason) {
      setOperationError(String(reason))
    } finally {
      setBusy('')
    }
  }

  async function mutateData(action: string, requestPath: string, method: string, body?: string) {
    setBusy(action)
    setOperationError('')
    try {
      acceptData(await api<WidgetDataSource>(requestPath, { method, ...(body ? { body } : {}) }))
      if (action === 'publish-data' || action === 'restore-data') onPublished()
    } catch (reason) {
      setOperationError(String(reason))
    } finally {
      setBusy('')
    }
  }

  async function saveRepositoryStyle() {
    if (!manifestResult.value || styleValidationError) return
    const id = window.prompt('新正式样式 ID（字母、数字、下划线或连字符）')
    if (!id) return
    const title = window.prompt('新正式样式名称', id)
    if (!title) return
    setBusy('publish-style')
    setOperationError('')
    try {
      const result = await api<{ styleId: string }>(`${stylePath}/publish`, {
        method: 'POST',
        body: JSON.stringify({
          id,
          title,
          source: { ...source, manifest: manifestResult.value },
        }),
      })
      await client.invalidateQueries({ queryKey: styleQueryKey })
      await onRepositoryStyleSaved(result.styleId)
    } catch (reason) {
      setOperationError(String(reason))
    } finally {
      setBusy('')
    }
  }

  async function formatActive() {
    setBusy('format')
    setOperationError('')
    try {
      if (tab === 'data') {
        setDataSource(await formatCode(tab, dataSource))
      } else if (tab === 'manifest') {
        setManifestSource(JSON.stringify(JSON.parse(manifestSource), null, 2))
      } else {
        const formatted = await formatCode(tab, source[tab])
        setSource(current => ({ ...current, [tab]: formatted }))
      }
    } catch (reason) {
      setOperationError(`格式化失败：${String(reason)}`)
    } finally {
      setBusy('')
    }
  }

  async function testDataSource() {
    setBusy('test-data')
    setOperationError('')
    try {
      const result = await api<{ data: unknown }>(
        `/api/v1/admin/plugins/${encodeURIComponent(widget.widget_type)}/data/test`,
        {
          method: 'POST',
          body: JSON.stringify({ source: dataSource, config: widget.config }),
        },
      )
      setTestedData(result.data)
    } catch (reason) {
      setOperationError(String(reason))
    } finally {
      setBusy('')
    }
  }

  async function testRender() {
    if (!screen || !manifestResult.value) return
    setBusy('test-render')
    setOperationError('')
    try {
      const result = await apiBlob(`/api/v1/admin/screens/${screen.id}/widget-preview`, {
        method: 'POST',
        body: JSON.stringify({
          ...widget,
          source_override: source,
          style_manifest_override: manifestResult.value,
          manifest_test: true,
          data_override: previewData,
        }),
      })
      const next = URL.createObjectURL(result.blob)
      setTestUrl(previous => {
        if (previous) URL.revokeObjectURL(previous)
        return next
      })
      const width = result.headers.get('X-EPD-Test-Width') || previewSize.width
      const height = result.headers.get('X-EPD-Test-Height') || previewSize.height
      const colorMode = (result.headers.get('X-EPD-Test-Color-Mode') || screen.color_mode).toUpperCase()
      setTestStrategy(`${width} × ${height} · ${colorMode}`)
    } catch (reason) {
      setOperationError(String(reason))
    } finally {
      setBusy('')
    }
  }

  if (styleQuery.isLoading || dataQuery.isLoading) return <p className="muted">正在加载组件源码…</p>
  if (styleQuery.error || dataQuery.error) {
    return <p className="error">{String(styleQuery.error || dataQuery.error)}</p>
  }

  const labels: Record<Tab, string> = {
    template: 'HTML',
    style: 'CSS',
    manifest: 'Manifest',
    data: 'Data (TypeScript)',
  }
  const activeDirty = tab === 'data' ? dataDirty : styleDirty
  const activeSaved = tab === 'data' ? savedData : savedStyle
  const activeStatus = activeSaved?.draft
    ? tab === 'data' ? '已保存草稿' : '已保存并应用 · 未发布'
    : activeSaved?.published
      ? '已发布自定义版本'
      : tab === 'data' || savedStyle?.builtin ? '内置版本' : '用户样式'
  const styleValidationError = syntaxError || manifestError
  const stylePayload = manifestResult.value
    ? JSON.stringify({ ...source, manifest: manifestResult.value })
    : ''

  return <section className="widget-code-editor">
    {!codePanelOpen && <button
      className="code-panel-dock"
      title="展开代码编辑器"
      onClick={() => setCodePanelOpen(true)}
    ><Code2 size={16} /><span>插件代码</span></button>}
    {codePanelOpen && <aside className="code-floating-panel">
      <header>
        <div>
          <h4>{tab === 'data' ? '共享数据源' : tab === 'manifest' ? '样式 Manifest' : '插件代码'}</h4>
          <span>{activeStatus}{activeDirty ? ' · 未保存' : ''}{tab === 'data' ? ' · 所有样式共享' : ''}</span>
        </div>
        <button
          className="code-close"
          title="收纳到右侧"
          aria-label="收纳代码编辑器到右侧"
          onClick={() => setCodePanelOpen(false)}
        ><PanelRightClose size={16} /></button>
      </header>
      <div className="code-actions">
          <button disabled={Boolean(busy)} title="Shift+Alt+F" onClick={() => void formatActive()}><Sparkles size={13} />格式化</button>
          {tab === 'data' ? <>
            <button disabled={Boolean(busy) || !dataDirty} onClick={() => void mutateData('draft-data', `${dataPath}/draft`, 'PUT', JSON.stringify({ source: dataSource }))}><Save size={13} />保存草稿</button>
            <button disabled={Boolean(busy)} onClick={() => void mutateData('publish-data', `${dataPath}/publish`, 'POST', JSON.stringify({ source: dataSource }))}><Upload size={13} />发布数据源</button>
            <button disabled={Boolean(busy) || (!savedData?.draft && !savedData?.published && !dataDirty)} onClick={() => {
              if (window.confirm('清除共享数据源的用户修改并恢复内置版本吗？')) void mutateData('restore-data', `${dataPath}/restore`, 'POST')
            }}><RotateCcw size={13} />恢复内置</button>
            <button disabled={Boolean(busy)} onClick={() => void testDataSource()}><Play size={13} />{busy === 'test-data' ? '测试中…' : '测试数据源'}</button>
          </> : <>
            <button disabled={Boolean(busy) || Boolean(styleValidationError) || !styleDirty} onClick={() => void mutateStyle('draft-style', `${stylePath}/draft`, 'PUT', stylePayload)}><Save size={13} />保存并应用</button>
            <button disabled={Boolean(busy) || Boolean(styleValidationError)} onClick={() => void saveRepositoryStyle()}><Upload size={13} />另存到插件仓库</button>
            {savedStyle?.builtin && <button disabled={Boolean(busy) || (!savedStyle.draft && !savedStyle.published && !styleDirty)} onClick={() => {
              if (window.confirm('清除该样式的用户修改并恢复内置版本吗？')) void mutateStyle('restore-style', `${stylePath}/restore`, 'POST')
            }}><RotateCcw size={13} />恢复内置</button>}
          </>}
        </div>
      <div className="code-tabs">
        {(Object.keys(labels) as Tab[]).map(item => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{labels[item]}</button>)}
      </div>
      <CodeMirrorEditor
        key={`${widget.widget_type}:${styleId}:${tab}`}
        language={tab === 'data' ? 'typescript' : tab === 'manifest' ? 'json' : tab === 'style' ? 'css' : 'html'}
        value={tab === 'data' ? dataSource : tab === 'manifest' ? manifestSource : source[tab]}
        reveal={tab === 'template' ? reveal : undefined}
        onChange={value => {
          if (tab === 'data') {
            setDataSource(value)
            setTestedData(undefined)
          } else if (tab === 'manifest') {
            setManifestSource(value)
          } else setSource(current => ({ ...current, [tab]: value }))
        }}
      />
      {(styleValidationError || operationError || adaptedMockQuery.error) && <p className="code-error"><AlertCircle size={14} />{operationError || styleValidationError || `Mock 数据适配失败：${String(adaptedMockQuery.error)}`}</p>}
      {tab === 'data' && testedData !== undefined && <details className="data-test-output" open>
        <summary>数据源测试输出</summary>
        <pre>{JSON.stringify(testedData, null, 2)}</pre>
      </details>}
    </aside>}
    <div className="code-preview-grid">
      <div>
        <div className="code-preview-title">
          <b>即时沙箱</b>
          <div className="code-preview-tools">
            {runtimeError ? <span className="error">运行失败</span> : <span><Check size={12} />已隔离</span>}
            <button
              type="button"
              className={inspectMode ? 'active' : ''}
              title="定位模式：点击沙箱中的元素，跳转到 HTML 对应位置（Esc 退出）"
              aria-pressed={inspectMode}
              onClick={() => setInspectMode(current => !current)}
            ><Crosshair size={12} />{inspectMode ? '定位中' : '定位'}</button>
          </div>
        </div>
        <div
          className={`sandbox-frame${inspectMode ? ' inspecting' : ''}`}
          style={{ aspectRatio: `${previewSize.width} / ${previewSize.height}` }}
        >
          <iframe ref={iframe} title="组件沙箱预览" sandbox="allow-scripts" srcDoc={srcDoc} onLoad={initializePreview} />
        </div>
        {runtimeError && <p className="code-error"><AlertCircle size={14} />{runtimeError}</p>}
      </div>
      <div>
        <div className="code-preview-title"><b>墨水屏测试{testStrategy && <small>{testStrategy}</small>}</b><button disabled={!screen || Boolean(busy) || Boolean(styleValidationError)} title={screen ? '' : '选择目标屏幕后可用'} onClick={() => void testRender()}><Play size={12} />{busy === 'test-render' ? '渲染中…' : '运行'}</button></div>
        <div className="sandbox-frame" style={{ aspectRatio: `${previewSize.width} / ${previewSize.height}` }}>
          {testUrl ? <img src={testUrl} alt="墨水屏测试结果" /> : <span>{screen ? '点击运行生成设备色预览' : '选择目标屏幕后可进行设备色测试'}</span>}
        </div>
      </div>
    </div>
  </section>
}
