import mongoose from 'mongoose'

const MIB = 1024 * 1024

/**
 * Conservative storage guard for a small (free-tier) Atlas cluster.
 *
 * What it does: when the cluster is close to its storage limit it makes DropDrop refuse to create NEW rooms.
 * What it never does: delete or modify any data, or interrupt existing rooms.
 *
 * How it measures (and how honestly it reports that):
 *  1. "cluster"     `listDatabases` total on-disk size across EVERY database on the cluster (so other projects that
 *                   share the cluster are counted). This is an approximation of what the provider meters, which is
 *                   why the threshold is deliberately well below the limit. Needs a user allowed to list databases.
 *  2. "estimate"    If listing databases is not permitted (a least-privilege user), only this application's own
 *                   database can be measured. Other databases are then unknown, so the operator must declare a reserve
 *                   (STORAGE_OTHER_DB_RESERVE_MB). Without a declared reserve the result is "unknown" and new rooms are
 *                   allowed, because refusing on a guess would be wrong.
 *  3. "unavailable" Nothing could be measured: "unknown", new rooms allowed (fail open).
 * Exact figures are never presented as fact; only the source and a coarse state are exposed publicly.
 */
export class StorageGuard {
  constructor({
    getClient = () => mongoose.connection.getClient(),
    getDbName = () => mongoose.connection.name,
    enabled = true,
    limitMb = 512,
    thresholdRatio = 0.8,
    otherDatabasesReserveMb = 0,
    ttlMs = 60_000,
    errorTtlMs = 15_000,
    now = () => Date.now(),
    log = (...a) => console.log('[storage]', ...a),
  } = {}) {
    Object.assign(this, { getClient, getDbName, enabled, limitMb, thresholdRatio, otherDatabasesReserveMb, ttlMs, errorTtlMs, now, log })
    this.thresholdMb = limitMb * thresholdRatio
    this._cached = null
    this._cachedAt = 0
    this._inflight = null
    this._lastState = null
  }

  /** @returns {Promise<{allowNewRooms:boolean, state:'ok'|'refusing'|'unknown'|'disabled', source:'cluster'|'estimate'|'unavailable'|'none', approxUsedMb:number|null}>} */
  async status() {
    if (!this.enabled) return { allowNewRooms: true, state: 'disabled', source: 'none', approxUsedMb: null }
    const age = this.now() - this._cachedAt
    const ttl = this._cached?.source === 'unavailable' ? this.errorTtlMs : this.ttlMs
    if (this._cached && age < ttl) return this._cached
    if (!this._inflight) {
      this._inflight = this.#measure()
        .then((result) => {
          this._cached = result
          this._cachedAt = this.now()
          if (result.state !== this._lastState) {
            this._lastState = result.state
            // Operator log only: approximate, labelled with its source.
            this.log(`state=${result.state} source=${result.source}${result.approxUsedMb == null ? '' : ` approx_used=${Math.round(result.approxUsedMb)}MB`} refuse_new_rooms_at=${Math.round(this.thresholdMb)}MB`)
          }
          return result
        })
        .finally(() => {
          this._inflight = null
        })
    }
    return this._inflight
  }

  async #measure() {
    let client
    try {
      client = this.getClient()
    } catch {
      return this.#unavailable()
    }

    // 1. cluster-wide (counts databases belonging to other projects on the same cluster)
    try {
      const listed = await client.db('admin').admin().listDatabases()
      return this.#decide('cluster', listed.totalSize / MIB)
    } catch {
      /* not permitted for this user (or unsupported): fall through to the estimate */
    }

    // 2. own database only, plus the operator-declared reserve for everything else
    try {
      const stats = await client.db(this.getDbName()).command({ dbStats: 1 })
      const ownMb = ((stats.storageSize ?? 0) + (stats.indexSize ?? 0)) / MIB
      if (!this.otherDatabasesReserveMb) {
        // Others are unknown and nothing was declared: do not pretend to know.
        return { allowNewRooms: true, state: 'unknown', source: 'estimate', approxUsedMb: ownMb }
      }
      return this.#decide('estimate', ownMb + this.otherDatabasesReserveMb)
    } catch {
      return this.#unavailable()
    }
  }

  #decide(source, usedMb) {
    const refusing = usedMb >= this.thresholdMb
    return { allowNewRooms: !refusing, state: refusing ? 'refusing' : 'ok', source, approxUsedMb: usedMb }
  }

  #unavailable() {
    return { allowNewRooms: true, state: 'unknown', source: 'unavailable', approxUsedMb: null }
  }

  /** Last measurement without triggering a new one (health checks must stay cheap). */
  peek() {
    return this._cached ?? { allowNewRooms: true, state: 'unknown', source: 'none', approxUsedMb: null }
  }

  /** What the public health endpoint may say: coarse state and source only, never figures. */
  publicSummary(status) {
    return { guard: status.state === 'refusing' ? 'refusing-new-rooms' : status.state, source: status.source }
  }
}

export class StorageFullError extends Error {
  constructor() {
    super('New rooms are temporarily disabled because DropDrop\'s free storage is nearly full. Existing rooms keep working.')
    this.name = 'StorageFullError'
    this.code = 'STORAGE_FULL'
  }
}
