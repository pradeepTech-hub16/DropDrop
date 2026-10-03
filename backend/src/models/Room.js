import mongoose from 'mongoose'
import { LANGUAGES, MAX_CONTENT_LENGTH, ROOM_NAME_MAX, ROOM_NAME_PATTERN } from '../utils/validation.js'

const roomSchema = new mongoose.Schema(
  {
    roomName: {
      type: String,
      required: [true, 'roomName is required'],
      trim: false,
      maxlength: ROOM_NAME_MAX,
      match: [ROOM_NAME_PATTERN, 'roomName contains invalid characters'],
    },
    // Plain-text view of the document. In Phase 2 this is the source of truth;
    // in Phase 3 it becomes a cache derived from the Yjs state below.
    content: { type: String, default: '', maxlength: MAX_CONTENT_LENGTH },
    language: { type: String, enum: LANGUAGES, default: 'plaintext' },

    // Reserved for Phase 3: encoded Yjs document state (Y.encodeStateAsUpdate).
    // Never returned by the REST API (select: false).
    yjsState: { type: Buffer, default: null, select: false },
    yjsUpdatedAt: { type: Date, default: null },
    // Snapshot revision, bumped on every snapshot write; lets concurrent server instances use compare-and-set.
    yjsRev: { type: Number, default: 0 },
  },
  {
    timestamps: true, // createdAt, updatedAt
    versionKey: false,
    toJSON: {
      transform: (_doc, ret) => ({
        roomName: ret.roomName,
        content: ret.content,
        language: ret.language,
        createdAt: ret.createdAt,
        updatedAt: ret.updatedAt,
      }),
    },
  },
)

// Unique index: guarantees no duplicate room records, even under concurrent creates.
roomSchema.index({ roomName: 1 }, { unique: true })
// Supports future housekeeping of stale rooms.
roomSchema.index({ updatedAt: 1 })

export default mongoose.models.Room || mongoose.model('Room', roomSchema)
