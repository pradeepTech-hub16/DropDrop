import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view'
import { defaultKeymap, indentWithTab, selectAll } from '@codemirror/commands'
import { LanguageDescription, bracketMatching, indentOnInput } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { oneDark } from '@codemirror/theme-one-dark'
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from 'y-codemirror.next'
import { ROOM_CONTENT_MAX } from '../lib/room.js'

// Transparent background so the page theme shows through; keep One Dark syntax colours.
const transparentTheme = EditorView.theme({ '&': { backgroundColor: 'transparent' } }, { dark: true })

async function loadLanguage(name) {
  if (!name || name === 'Plain text') return []
  const desc = LanguageDescription.matchLanguageName(languages, name, true)
  if (!desc) return []
  const support = await desc.load()
  return support
}

/**
 * CodeMirror 6 editor bound to a shared Y.Text (y-codemirror.next): local edits flow into Yjs, remote edits
 * and remote cursors flow back in. Undo/redo is Yjs-aware (only undoes your own changes).
 * Imperative handle: getText, selectAll, clear, focus.
 */
const Editor = forwardRef(function Editor({ ytext, awareness, language = 'Plain text', onChange, onSelectionChange, onLimit }, ref) {
  const host = useRef(null)
  const view = useRef(null)
  const langCompartment = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  const onSelRef = useRef(onSelectionChange)
  const onLimitRef = useRef(onLimit)
  onLimitRef.current = onLimit
  onChangeRef.current = onChange
  onSelRef.current = onSelectionChange

  useEffect(() => {
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          EditorView.lineWrapping,
          placeholder('Start typing, or paste something to share…'),
          // yCollab handles native undo events only; redo (Ctrl+Y, Cmd+Shift+Z) needs this keymap.
          keymap.of([...yUndoManagerKeymap, indentWithTab, ...defaultKeymap]),
          yCollab(ytext, awareness),
          // Stop local edits that would push the room past the server's size limit (remote edits always apply).
          EditorState.changeFilter.of((tr) => {
            if (tr.annotation(ySyncAnnotation) || tr.newDoc.length <= ROOM_CONTENT_MAX) return true
            onLimitRef.current?.()
            return false
          }),
          oneDark,
          transparentTheme,
          langCompartment.current.of([]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc)
            if (u.selectionSet || u.docChanged) onSelRef.current?.(u.state.selection.main, u.state.doc)
          }),
        ],
      }),
    })
    view.current = v
    return () => v.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytext, awareness])

  useEffect(() => {
    let cancelled = false
    loadLanguage(language).then((ext) => {
      if (!cancelled && view.current) {
        view.current.dispatch({ effects: langCompartment.current.reconfigure(ext) })
      }
    })
    return () => {
      cancelled = true
    }
  }, [language])

  useImperativeHandle(ref, () => ({
    getText: () => view.current.state.doc.toString(),
    selectAll: () => {
      view.current.focus()
      selectAll(view.current)
    },
    clear: () =>
      view.current.dispatch({ changes: { from: 0, to: view.current.state.doc.length, insert: '' } }),
    focus: () => view.current.focus(),
  }))

  return <div ref={host} className="h-full" data-testid="editor" />
})

export default Editor
