// Every test that talks to the real MongoDB Atlas cluster MUST connect through this helper.
// It forces the isolated "dropdrop_test" database (overriding whatever database name the URI contains)
// and refuses to continue if the connection ended up anywhere else, so the real "dropdrop" database
// can never be written by a test.
import mongoose from 'mongoose'
import { connectDatabase, disconnectDatabase } from '../src/config/database.js'

export const TEST_DB = 'dropdrop_test'
export const REAL_DB = 'dropdrop'

export const atlasConfigured = (uri) => Boolean(uri) && !/<db_password>|YOUR_PASSWORD|your_mongodb_atlas_connection_string/i.test(uri)

export async function connectTestDatabase(uri) {
  await connectDatabase(uri, { dbName: TEST_DB })
  if (mongoose.connection.name !== TEST_DB) {
    const actual = mongoose.connection.name
    await disconnectDatabase()
    throw new Error(`Refusing to run: connected to "${actual}" instead of the isolated "${TEST_DB}" database.`)
  }
}
