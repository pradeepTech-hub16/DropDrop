import mongoose from 'mongoose'

// Append-only log of Yjs updates not yet folded into the Room.yjsState snapshot.
// Yjs updates commute, so replaying them in any order (and more than once) is safe.
// Each document is one *batch* (several keystrokes merged), written at most ~1/second per room.
const roomUpdateSchema = new mongoose.Schema(
  {
    roomName: { type: String, required: true },
    update: { type: Buffer, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
)

roomUpdateSchema.index({ roomName: 1, _id: 1 })

export default mongoose.models.RoomUpdate || mongoose.model('RoomUpdate', roomUpdateSchema)
