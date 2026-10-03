import { Router } from 'express'
import { createRoom, getRoom, updateRoom } from '../controllers/roomController.js'

export default function roomRoutes(limiters) {
  const router = Router()
  router.post('/', limiters.write, createRoom)
  router.get('/:roomName', limiters.read, getRoom)
  router.put('/:roomName', limiters.write, updateRoom)
  return router
}
