import { useEffect, useRef } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { EditorSelection, EditorState } from '@codemirror/state'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'

type Language = 'html' | 'css' | 'typescript' | 'json'

export type CodeReveal = {
  from: number
  to: number
  key: number
}

const languageExtension = {
  html: html(),
  css: css(),
  typescript: javascript({ typescript: true }),
  json: javascript(),
} satisfies Record<Language, ReturnType<typeof html>>

export default function CodeMirrorEditor({
  value,
  language,
  onChange,
  reveal,
}: {
  value: string
  language: Language
  onChange: (value: string) => void
  reveal?: CodeReveal
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(null)
  const onChangeRef = useRef(onChange)
  const valueRef = useRef(value)
  onChangeRef.current = onChange
  valueRef.current = value

  useEffect(() => {
    if (!host.current) return
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          basicSetup,
          languageExtension[language],
          EditorView.lineWrapping,
          EditorView.theme({
            '&': { height: '100%', fontSize: '12px' },
            '.cm-scroller': { overflow: 'auto', fontFamily: '"Cascadia Code", Consolas, monospace' },
            '.cm-content': { minHeight: '260px' },
          }),
          EditorView.updateListener.of(update => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [language])

  useEffect(() => {
    const editor = view.current
    if (!editor || editor.state.doc.toString() === value) return
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
    })
  }, [value])

  useEffect(() => {
    const editor = view.current
    if (!editor || !reveal) return
    const length = editor.state.doc.length
    const from = Math.max(0, Math.min(reveal.from, length))
    const to = Math.max(from, Math.min(reveal.to, length))
    editor.dispatch({
      selection: EditorSelection.range(from, to),
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    })
    editor.focus()
  }, [reveal])

  return <div className="code-mirror-host" ref={host} />
}
