import MySQL from 'mysql2/promise'
import { escapeId, escape } from 'mysql2'

const DEFAULT_BUCKET_SIZE = 100
const DEFAULT_TABLE_NAME = '__ResolveSnapshots__'

const init = async pool => {
  if (pool.initPromise != null) {
    return pool.initPromise
  }

  pool.initPromise = (async () => {
    const { bucketSize, tableName, ...connectionOptions } = pool.config
    pool.connection = await MySQL.createConnection(connectionOptions)
    pool.bucketSize = bucketSize
    if (!Number.isInteger(pool.bucketSize) || pool.bucketSize < 1) {
      pool.bucketSize = DEFAULT_BUCKET_SIZE
    }
    pool.tableName = tableName
    if (pool.tableName == null || pool.tableName.constructor !== String) {
      pool.tableName = DEFAULT_TABLE_NAME
    }

    await pool.connection.execute(`CREATE TABLE IF NOT EXISTS ${escapeId(
      pool.tableName
    )} (
      ${escapeId('SnapshotKey')} MEDIUMBLOB NOT NULL,
      ${escapeId('SnapshotContent')} LONGBLOB,
      PRIMARY KEY(${escapeId('SnapshotKey')}(255))
    )`)

    pool.counters = new Map()
  })()

  return pool.initPromise
}

const loadSnapshot = async (pool, snapshotKey) => {
  await init(pool)
  if (pool.disposed) {
    throw new Error('Adapter is disposed')
  }

  const [rows] = await pool.connection.execute(
    `SELECT ${escapeId('SnapshotContent')} FROM ${escapeId(pool.tableName)}
   WHERE ${escapeId('SnapshotKey')}= ${escape(snapshotKey)} `
  )

  const content = rows.length > 0 ? rows[0].SnapshotContent.toString() : null

  return content != null ? JSON.parse(content) : null
}

const saveSnapshot = async (pool, snapshotKey, content) => {
  await init(pool)
  if (pool.disposed) {
    throw new Error('Adapter is disposed')
  }
  if (!pool.counters.has(snapshotKey)) {
    pool.counters.set(snapshotKey, 0)
  }

  if (pool.counters.get(snapshotKey) < pool.bucketSize) {
    pool.counters.set(snapshotKey, pool.counters.get(snapshotKey) + 1)
    return
  }
  pool.counters.set(snapshotKey, 0)

  const stringContent = JSON.stringify(content)

  await pool.connection.execute(
    `INSERT INTO ${escapeId(pool.tableName)}(${escapeId(
      'SnapshotKey'
    )}, ${escapeId('SnapshotContent')})
    VALUES(${escape(snapshotKey)}, ${escape(stringContent)})
    ON DUPLICATE KEY UPDATE
    ${escapeId('SnapshotContent')} = ${escape(stringContent)}`
  )
}

const dispose = async pool => {
  await init(pool)
  if (pool.disposed) {
    throw new Error('Adapter is disposed')
  }
  pool.disposed = true

  pool.counters.clear()

  await pool.connection.end()
}

const drop = async (pool, snapshotKey) => {
  await init(pool)
  if (pool.disposed) {
    throw new Error('Adapter is disposed')
  }

  await pool.connection.execute(
    `DELETE FROM ${escapeId(pool.tableName)}
    WHERE ${escapeId('SnapshotKey')} LIKE ${escape(`${snapshotKey}%`)}`,
    [snapshotKey]
  )
}

const createAdapter = config => {
  const pool = { config }

  return Object.freeze({
    loadSnapshot: loadSnapshot.bind(null, pool),
    saveSnapshot: saveSnapshot.bind(null, pool),
    dispose: dispose.bind(null, pool),
    drop: drop.bind(null, pool)
  })
}

export default createAdapter
