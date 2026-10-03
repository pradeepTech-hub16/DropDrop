import mongoose from 'mongoose'

const PLACEHOLDER_PATTERNS = [/<db_password>/i, /your_mongodb_atlas_connection_string/i, /<password>/i]

export class DatabaseConfigError extends Error {}

/** Strip anything that could carry credentials before an error message is logged or returned. */
export function redact(message, uri) {
  let out = String(message ?? '')
  if (uri) {
    out = out.split(uri).join('<redacted-uri>')
    try {
      const { password, username } = new URL(uri)
      if (password) out = out.split(decodeURIComponent(password)).join('<redacted>').split(password).join('<redacted>')
      if (username) out = out.split(decodeURIComponent(username)).join('<user>')
    } catch {
      /* not a parseable URL; the whole-URI replacement above still applies */
    }
  }
  return out.replace(/mongodb(\+srv)?:\/\/[^\s'"]+/gi, 'mongodb://<redacted>')
}

export function isDbConnected() {
  return mongoose.connection.readyState === 1
}

export async function connectDatabase(uri, { serverSelectionTimeoutMS = 8000, dbName } = {}) {
  if (!uri || PLACEHOLDER_PATTERNS.some((p) => p.test(uri))) {
    throw new DatabaseConfigError(
      'MONGODB_URI is not configured. Copy backend/.env.example to backend/.env and put your real ' +
        'MongoDB Atlas connection string (with the database name "dropdrop") in it.',
    )
  }
  mongoose.set('strictQuery', true)
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS, autoIndex: true, ...(dbName && { dbName }) })
    await mongoose.model('Room').init() // make sure the unique index exists
  } catch (err) {
    throw new DatabaseConfigError(`Could not connect to MongoDB: ${redact(err.message, uri)}`)
  }
}

export async function disconnectDatabase() {
  await mongoose.disconnect()
}
