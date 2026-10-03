import { useCallback, useEffect, useState } from 'react'
import { CLOSE_MESSAGES, createCollab } from './collab.js'
import { config } from './config.js'

const FIRST_SYNC_GRACE_MS = 4000

/**
 * Owns the collaboration session for one room and exposes real connection state.
 * `phase` is only 'connected' while the WebSocket is actually open.
 *   connecting | connected | disconnected | reconnecting | closed (server refused: see closeMessage)
 */
export function useCollab(roomName) {
  const [attempt, setAttempt] = useState(0)
  const [collab, setCollab] = useState(null)
  const [phase, setPhase] = useState('connecting')
  const [synced, setSynced] = useState(false)
  const [persisted, setPersisted] = useState(true)
  const [language, setLanguage] = useState('plaintext')
  const [peers, setPeers] = useState([])
  const [closeMessage, setCloseMessage] = useState(null)
  const [waitedForSync, setWaitedForSync] = useState(false)
  const [everConnected, setEverConnected] = useState(false) // true after the first real connection
  const [wakeTimedOut, setWakeTimedOut] = useState(false) // never connected within the wake deadline (~90 s)

  useEffect(() => {
    const c = createCollab(roomName)
    let everConnected = false
    let failures = 0
    let permanent = false
    let timer = null

    setCollab(c)
    setPhase('connecting')
    setSynced(false)
    setCloseMessage(null)
    setWaitedForSync(false)
    setEverConnected(false)
    setWakeTimedOut(false)
    setLanguage(c.meta.get('language') ?? 'plaintext')

    const refreshPersisted = () => setPersisted(c.isPersisted())
    const refreshPeers = () => {
      const list = []
      c.awareness.getStates().forEach((state, clientId) => {
        if (state.user) list.push({ clientId, ...state.user, isSelf: clientId === c.doc.clientID })
      })
      setPeers(list)
    }
    const onStatus = ({ status }) => {
      if (permanent) return
      if (status === 'connected') {
        everConnected = true
        setEverConnected(true)
        setWakeTimedOut(false)
        setPhase('connected')
      } else if (status === 'connecting') {
        setPhase(everConnected || failures > 0 ? 'reconnecting' : 'connecting')
      } else {
        failures++
        setPhase('disconnected')
        setSynced(false)
      }
    }
    const onClose = (event) => {
      const code = event?.code
      if (code >= 4400 && code <= 4499) {
        permanent = true
        setPhase('closed')
        setSynced(false)
        setCloseMessage(CLOSE_MESSAGES[code] ?? 'The server closed the connection.')
      }
    }
    const onSync = (isSynced) => setSynced(isSynced)
    const onMeta = () => {
      const l = c.meta.get('language')
      setLanguage(typeof l === 'string' ? l : 'plaintext')
    }

    c.provider.on('status', onStatus)
    c.provider.on('connection-close', onClose)
    c.provider.on('sync', onSync)
    c.meta.observe(onMeta)
    c.awareness.on('change', refreshPeers)
    c.doc.on('update', refreshPersisted)
    c.onPersisted = refreshPersisted
    refreshPeers()
    timer = setTimeout(() => setWaitedForSync(true), FIRST_SYNC_GRACE_MS)
    const wakeTimer = setTimeout(() => !everConnected && setWakeTimedOut(true), config.WAKE_TIMEOUT_MS)

    return () => {
      clearTimeout(timer)
      clearTimeout(wakeTimer)
      c.onPersisted = null
      c.meta.unobserve(onMeta)
      c.destroy() // closes the WebSocket, removes presence, frees the Y.Doc
      setCollab(null)
    }
  }, [roomName, attempt])

  const reconnect = useCallback(() => setAttempt((n) => n + 1), [])

  const setRoomLanguage = useCallback(
    (id) => {
      collab?.meta.set('language', id)
    },
    [collab],
  )

  return { collab, phase, synced, persisted, language, peers, closeMessage, waitedForSync, everConnected, wakeTimedOut, reconnect, setRoomLanguage }
}
