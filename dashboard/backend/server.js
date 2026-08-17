require("dotenv").config();
const express = require("express");
const mysql = require('mysql2/promise');
const cors = require("cors");
const app = express();

// MIDDLEWARE
app.use(cors());
// Backlog batches are the reason for the raised limit: 500 sensor rows is well
// past the 100kb default, and body-parser would 413 them before any handler ran.
app.use(express.json({ limit: '5mb' }));

// MYSQL CONNECTION
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
})

// ===========================================================================
// TIME SYNC / DEVICE TRACKING CONFIG   (timeSyncPlan.md §3, §6b)
// ===========================================================================

const HEARTBEAT_INTERVAL_MS = 60 * 1000        // Pi maintenance cycle
const OFFLINE_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS
const WATCHDOG_TICK_MS = 30 * 1000
// A Pi cannot report its own death, so "offline" is always inferred. If the
// SERVER was the thing that was off, every Pi looks dead at startup - suppress
// detection for one full threshold so gaps stay attributable to the right box.
const STARTUP_GRACE_MS = OFFLINE_AFTER_MS

const MIN_PERIOD_SECONDS = 2      // DHT22 datasheet limit
const MAX_PERIOD_SECONDS = 3600
const DEFAULT_PERIOD_SECONDS = 5
const DEFAULT_LEAD_SECONDS = 30   // all Pis must have polled before the switch
const MAX_BATCH_ROWS = 500

const SERVER_STARTED_AT = Date.now()

const TIME_CONFIDENCE = ['SYNCED', 'CORRECTED', 'ESTIMATED', 'UNKNOWN']

// mysql2 hands Date objects straight to the driver, but being explicit keeps
// the fractional seconds we actually care about for the latency work.
function toSqlDateTime(epochMs) {
  const d = new Date(epochMs)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.` +
         `${p(d.getMilliseconds(), 3)}000`
}

function toEpochMs(value) {
  if (value == null) return null
  if (value instanceof Date) return value.getTime()
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

function toInt(value) {
  if (value == null || value === '') return null
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? n : null
}

async function startServer() {
  try {
    await pool.query('SELECT 1') // test DB
    console.log('Database connected')
  } catch (err) {
    console.error('Database connection failed:', err)
    process.exit(1)
  }

  try {
    await logDeviceEvent({
      sensorID: null,
      eventType: 'SERVER_START',
      occurredAtMs: SERVER_STARTED_AT,
      source: 'WATCHDOG',
      detail: `offline detection suppressed for ${STARTUP_GRACE_MS / 1000}s`
    })
  } catch (err) {
    // Missing DeviceEvent table just means migration_timesync.sql has not run.
    console.warn('SERVER_START event not logged:', err.message)
  }

  setInterval(runOfflineWatchdog, WATCHDOG_TICK_MS)
}
startServer()


// ===========================================================================
// DEVICE STATE HELPERS
// ===========================================================================

async function logDeviceEvent({ sensorID, eventType, occurredAtMs, bootID, source, detail }) {
  const [result] = await pool.execute(
    `INSERT INTO DeviceEvent (sensorID, eventType, occurredAt, bootID, source, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      sensorID ?? null,
      eventType,
      toSqlDateTime(occurredAtMs ?? Date.now()),
      bootID ?? null,
      source,
      detail ?? null
    ]
  )
  return result.insertId
}

/**
 * Records proof of life for a sensor and emits BOOT / ONLINE events on
 * transitions. Any upload counts as a heartbeat, not just /api/heartbeat.
 */
async function markSeen(sensorID, { nowMs, bootID, uptimeSeconds, source, detail } = {}) {
  if (sensorID == null) return

  const seenAt = nowMs ?? Date.now()
  const [rows] = await pool.execute(
    'SELECT bootID, isOnline FROM DeviceStatus WHERE sensorID = ?',
    [sensorID]
  )
  const previous = rows[0] || null

  let bootAtMs = null
  if (uptimeSeconds != null && Number.isFinite(Number(uptimeSeconds))) {
    bootAtMs = seenAt - Number(uptimeSeconds) * 1000
  }

  await pool.execute(
    `INSERT INTO DeviceStatus (sensorID, lastSeen, lastHeartbeat, bootID, bootAt, isOnline)
     VALUES (?, ?, ?, ?, ?, TRUE)
     ON DUPLICATE KEY UPDATE
       lastSeen = VALUES(lastSeen),
       lastHeartbeat = VALUES(lastHeartbeat),
       bootID = COALESCE(VALUES(bootID), bootID),
       bootAt = COALESCE(VALUES(bootAt), bootAt),
       isOnline = TRUE`,
    [
      sensorID,
      toSqlDateTime(seenAt),
      toSqlDateTime(seenAt),
      bootID ?? null,
      bootAtMs == null ? null : toSqlDateTime(bootAtMs)
    ]
  )

  // A new bootID for a known sensor IS the power-on event.
  if (bootID && (!previous || previous.bootID !== bootID)) {
    await logDeviceEvent({
      sensorID,
      eventType: 'BOOT',
      occurredAtMs: bootAtMs ?? seenAt,
      bootID,
      source: 'BOOT_REPORT',
      detail: uptimeSeconds == null ? 'uptime unavailable' : `uptime ${Math.round(uptimeSeconds)}s`
    })
  }

  if (!previous || !previous.isOnline) {
    await logDeviceEvent({
      sensorID,
      eventType: 'ONLINE',
      occurredAtMs: seenAt,
      bootID: bootID ?? null,
      source: source || 'HEARTBEAT',
      detail: detail ?? null
    })
  }
}

// markSeen costs a SELECT plus an upsert. Uploads are proof of life too, but
// on the single-row fallback path that would be two extra round trips per
// reading on a disk-bound server - for information the watchdog only consults
// every 180 s. Throttled per sensor; /api/heartbeat is never throttled.
const SEEN_THROTTLE_MS = 15 * 1000
const lastSeenTouch = new Map()

function touchSeen(sensorID, detail) {
  if (sensorID == null) return

  const now = Date.now()
  const last = lastSeenTouch.get(sensorID)

  if (last != null && now - last < SEEN_THROTTLE_MS) return

  lastSeenTouch.set(sensorID, now)

  markSeen(sensorID, { nowMs: now, source: 'HEARTBEAT', detail })
    .catch(err => {
      lastSeenTouch.delete(sensorID)   // let the next upload retry
      console.error('markSeen failed:', err.message)
    })
}

async function runOfflineWatchdog() {
  const now = Date.now()

  // §6b pitfall: right after a backend restart every Pi looks dead.
  if (now - SERVER_STARTED_AT < STARTUP_GRACE_MS) return

  try {
    const [rows] = await pool.query(
      `SELECT sensorID, lastSeen, bootID
       FROM DeviceStatus
       WHERE isOnline = TRUE
         AND lastSeen IS NOT NULL
         AND lastSeen < NOW(6) - INTERVAL ? SECOND`,
      [Math.round(OFFLINE_AFTER_MS / 1000)]
    )

    for (const row of rows) {
      await pool.execute(
        'UPDATE DeviceStatus SET isOnline = FALSE WHERE sensorID = ?',
        [row.sensorID]
      )
      // occurredAt is the last proof of life; detectedAt (default) is now.
      // The gap between them is the watchdog timeout, and gets refined later
      // from the backlog once the Pi reconnects.
      await logDeviceEvent({
        sensorID: row.sensorID,
        eventType: 'OFFLINE',
        occurredAtMs: toEpochMs(row.lastSeen) ?? now,
        bootID: row.bootID,
        source: 'WATCHDOG',
        detail: `no contact for ${Math.round(OFFLINE_AFTER_MS / 1000)}s`
      })
      console.log(`Watchdog: sensor ${row.sensorID} marked OFFLINE`)
    }
  } catch (err) {
    console.error('Offline watchdog error:', err.message)
  }
}


// test
app.get("/", (req, res) => {
  res.send("API is running");
});

// ===========================================================================
// TIME SOURCE  (timeSyncPlan.md §3)
//
// The Pis have no RTC and no internet; this route is their clock. It must not
// touch the database - the Pi measures round-trip delay against it, so any
// latency added here lands directly on the sensors as clock error.
// ===========================================================================
app.get('/api/time', (req, res) => {
  const now = Date.now();
  res.json({
    epochMs: now,
    iso: new Date(now).toISOString()
  });
});

// GET all sensors
app.get('/api/sensors', async (req, res) => {
  // Explicit columns, not SELECT *: deviceUUID moved to Device in v3, so a star
  // select would quietly drop it from the response instead of failing loudly.
  const [rows] = await pool.query(
    `SELECT s.sensorID,
            s.deviceID,
            d.deviceUUID,
            s.typeID,
            s.locationID,
            s.sensorDescription,
            s.createdAt
     FROM Sensor s
     JOIN Device d ON d.deviceID = s.deviceID
     ORDER BY s.sensorID`
  )
  res.json(rows)
})

app.post('/api/registerSensor', async (req, res) => {
  try {
    const {
      deviceUUID,
      sensorType,
      locationName
    } = req.body;

    // Validate input
    if (!deviceUUID || !sensorType || !locationName) {
      return res.status(400).json({
        success: false,
        message: 'deviceUUID, sensorType and locationName are required'
      });
    }

    // ======================
    // Find or Create Device
    // ======================

    // A Pi is not a sensor: one device owns several Sensor rows, so the on/off
    // tables key on deviceID. deviceUUID is UNIQUE, which lets the find-or-create
    // be a single upsert - two sensors on the same Pi registering at once cannot
    // race between a SELECT and an INSERT.
    await pool.execute(
      `
      INSERT INTO Device (deviceUUID)
      VALUES (?)
      ON DUPLICATE KEY UPDATE deviceID = deviceID
      `,
      [deviceUUID]
    );

    // insertId is unreliable after a no-op ON DUPLICATE KEY UPDATE, so read the
    // row back rather than trusting it.
    const [deviceRows] = await pool.execute(
      `
      SELECT deviceID
      FROM Device
      WHERE deviceUUID = ?
      `,
      [deviceUUID]
    );

    const deviceID = deviceRows[0].deviceID;

    // =========================
    // Find or Create SensorType
    // =========================

    let [typeRows] = await pool.execute(
      `
      SELECT typeID
      FROM SensorType
      WHERE sensorType = ?
      `,
      [sensorType]
    );

    let typeID;

    if (typeRows.length === 0) {

      const [result] = await pool.execute(
        `
        INSERT INTO SensorType (sensorType)
        VALUES (?)
        `,
        [sensorType]
      );

      typeID = result.insertId;

    } else {

      typeID = typeRows[0].typeID;

    }

    // ======================
    // Find or Create Location
    // ======================

    let [locationRows] = await pool.execute(
      `
      SELECT locationID
      FROM Location
      WHERE locationName = ?
      `,
      [locationName]
    );

    let locationID;

    if (locationRows.length === 0) {

      const [result] = await pool.execute(
        `
        INSERT INTO Location (locationName)
        VALUES (?)
        `,
        [locationName]
      );

      locationID = result.insertId;

    } else {

      locationID = locationRows[0].locationID;

    }

    // ======================================
    // Check Existing Sensor
    // Device + Type + Location
    // ======================================

    const [existingSensor] = await pool.execute(
      `
      SELECT sensorID
      FROM Sensor
      WHERE deviceID = ?
      AND typeID = ?
      AND locationID = ?
      `,
      [
        deviceID,
        typeID,
        locationID
      ]
    );

    if (existingSensor.length > 0) {

      return res.status(200).json({
        success: true,
        sensorID: existingSensor[0].sensorID,
        deviceID,
        existing: true
      });

    }

    // ======================
    // Create New Sensor
    // ======================

    const [sensorResult] = await pool.execute(
      `
      INSERT INTO Sensor (
        deviceID,
        typeID,
        locationID
      )
      VALUES (?, ?, ?)
      `,
      [
        deviceID,
        typeID,
        locationID
      ]
    );

    return res.status(201).json({
      success: true,
      sensorID: sensorResult.insertId,
      deviceID,
      existing: false
    });

  } catch (err) {

    console.error('registerSensor error:', err);

    return res.status(500).json({
      success: false,
      error: err.message
    });

  }
});
// GET logs for last X hours
// app.get('/api/logs', async (req, res) => {
//   const hours = req.query.hours || 2

//   const [rows] = await pool.query(`
//     SELECT s.sensorID, s.sensorType, s.sensorLocation,
//            l.datetime, l.temperature, l.humidity, l.windspeed, l.VPD
//     FROM SensorLog l
//     JOIN Sensor s ON s.sensorID = l.sensorID
//     WHERE l.datetime >= NOW() - INTERVAL ? HOUR
//     ORDER BY l.datetime
//   `, [hours])

//   res.json(rows)
// })

app.get('/api/logs', async (req, res) => {
  const { hours, start, end, instrumentation } = req.query

  // Opt-in: the default 6-hour window is ~17k rows, and serialising five extra
  // fields per row for every dashboard refresh is not free on this server.
  const extraColumns = instrumentation === '1' || instrumentation === 'true'
    ? `,
           l.timeConfidence,
           l.readLatencyMs,
           l.tickJitterMs,
           l.queueDelayMs,
           l.recordedAt,
           TIMESTAMPDIFF(MICROSECOND, l.datetime, l.recordedAt) AS endToEndUs`
    : ''

  let query = `
    SELECT s.sensorID,
           s.sensorDescription,
           t.sensorType,
           loc.locationName,
           l.datetime,
           l.temperature,
           l.humidity,
           l.windspeed,
           l.windDirection,
           l.VPD${extraColumns}
    FROM SensorLog l
    JOIN Sensor s ON s.sensorID = l.sensorID
    LEFT JOIN SensorType t ON s.typeID = t.typeID
    LEFT JOIN Location loc ON s.locationID = loc.locationID
    WHERE 1=1
  `
  const params = []

  if (start && end) {
    query += ` AND l.datetime BETWEEN ? AND ?`
    params.push(start, end)
  } else {
    query += ` AND l.datetime >= NOW() - INTERVAL ? HOUR`
    params.push(hours || 6)
  }

  query += ` ORDER BY l.datetime`

  const [rows] = await pool.query(query, params)
  res.json(rows)
})

app.post('/api/ErrorLog', async (req, res) => {
  try {
    const { sensorID, errorType, errorMessage, severity } = req.body;

    if (!errorMessage) {
      return res.status(400).json({ message: 'Error message is required' });
    }

    const sql = `
      INSERT INTO ErrorLog (sensorID, errorType, errorMessage, severity)
      VALUES (?, ?, ?, ?)
    `;

    const [result] = await pool.execute(sql, [
      sensorID || null,
      errorType || 'UNKNOWN',
      errorMessage,
      severity || 'LOW'
    ]);

    res.status(200).json({
      success: true,
      errorID: result.insertId
    });

  } catch (err) {
    console.error("Error logging failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ===========================================================================
// SENSOR LOG INSERTS
//
// One shared column list for the single-row and batch routes so the
// instrumentation fields (timeSyncPlan.md §5) cannot drift between them.
// ===========================================================================

const SENSORLOG_COLUMNS = [
  'sensorID', 'datetime', 'temperature', 'humidity', 'windspeed', 'windDirection', 'VPD',
  'timeConfidence', 'readLatencyMs', 'tickJitterMs', 'queueDelayMs'
];

const SENSORLOG_PLACEHOLDERS = `(${SENSORLOG_COLUMNS.map(() => '?').join(', ')})`;

const SENSORLOG_INSERT_PREFIX =
  `INSERT INTO SensorLog (${SENSORLOG_COLUMNS.join(', ')}) VALUES `;

/** Maps a request body row onto SENSORLOG_COLUMNS. Returns null if invalid. */
function toSensorLogValues(row) {
  const { sensorID, temperature, humidity, VPD, time } = row;

  if (sensorID == null || temperature == null || humidity == null ||
      VPD == null || time == null) {
    return null;
  }

  const confidence = TIME_CONFIDENCE.includes(row.timeConfidence)
    ? row.timeConfidence
    : 'UNKNOWN';

  return [
    sensorID,
    time,
    temperature,
    humidity,
    row.windSpeed ?? row.windspeed ?? null,
    row.windDirection ?? null,
    VPD,
    confidence,
    toInt(row.readLatencyMs),
    toInt(row.tickJitterMs),
    toInt(row.queueDelayMs)
  ];
}

app.post('/api/getDataDHT', async (req, res) => {
  try {
    const values = toSensorLogValues(req.body);

    if (!values) {
      return res.status(400).json({ message: 'Missing DHT data' });
    }

    const [result] = await pool.execute(
      SENSORLOG_INSERT_PREFIX + SENSORLOG_PLACEHOLDERS,
      values
    );

    touchSeen(req.body.sensorID, 'data upload');

    res.status(200).json({
      success: true,
      logID: result.insertId
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/getDataC5A', async (req, res) => {
  try {
    const { windSpeed, windDirection } = req.body;

    // windSpeed/windDirection are what make this a C5A row, so unlike the
    // shared validator they are required here.
    if (windSpeed == null || windDirection == null) {
      return res.status(400).json({ message: 'Missing C5A data' });
    }

    const values = toSensorLogValues(req.body);

    if (!values) {
      return res.status(400).json({ message: 'Missing C5A data' });
    }

    const [result] = await pool.execute(
      SENSORLOG_INSERT_PREFIX + SENSORLOG_PLACEHOLDERS,
      values
    );

    touchSeen(req.body.sensorID, 'data upload');

    res.status(200).json({
      success: true,
      logID: result.insertId
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Batch insert - required, not an optimisation (timeSyncPlan.md §7a).
 *
 * One POST per row means one MySQL transaction per row, and with
 * innodb_flush_log_at_trx_commit = 1 that is one fsync per row (~8-15 ms on
 * the spinning-disk server). A 6-hour backlog across 4 Pis is ~17k rows:
 * ~4 minutes of pure fsync one-at-a-time, ~1.3 s batched at 200/POST. While
 * that drain grinds, live inserts from the other Pis queue behind it.
 */
app.post('/api/sensorLogBatch', async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : req.body.rows;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ success: false, message: 'rows array required' });
    }

    if (rows.length > MAX_BATCH_ROWS) {
      return res.status(413).json({
        success: false,
        message: `batch too large, max ${MAX_BATCH_ROWS} rows`
      });
    }

    const values = [];
    const rejected = [];

    rows.forEach((row, i) => {
      const mapped = toSensorLogValues(row);
      if (mapped) {
        values.push(mapped);
      } else {
        rejected.push(i);
      }
    });

    if (values.length === 0) {
      return res.status(400).json({ success: false, message: 'no valid rows', rejected });
    }

    const sql = SENSORLOG_INSERT_PREFIX +
      values.map(() => SENSORLOG_PLACEHOLDERS).join(', ');

    const [result] = await pool.query(sql, values.flat());

    [...new Set(values.map(v => v[0]))].forEach(id => touchSeen(id, 'batch upload'));

    res.status(200).json({
      success: true,
      inserted: values.length,
      firstLogID: result.insertId,
      rejected
    });

  } catch (err) {
    console.error('sensorLogBatch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ===========================================================================
// SAMPLING SCHEDULE  (timeSyncPlan.md §5)
//
// Every Pi derives its own tick instants from the Unix epoch, so a period
// change only works if they all switch at the SAME instant - otherwise they
// scatter onto different grids as each one happens to poll. That is what
// effectiveFrom is for, and why it is snapped to a multiple of the new period.
// ===========================================================================

app.get('/api/schedule', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT configID, periodSeconds, effectiveFrom, active, createdAt
       FROM SamplingConfig
       ORDER BY configID DESC
       LIMIT 1`
    );

    const now = Date.now();

    if (rows.length === 0) {
      return res.json({
        periodSeconds: DEFAULT_PERIOD_SECONDS,
        effectiveFromMs: now,
        configID: null,
        serverEpochMs: now
      });
    }

    const row = rows[0];

    res.json({
      configID: row.configID,
      periodSeconds: row.periodSeconds,
      effectiveFromMs: toEpochMs(row.effectiveFrom),
      active: !!row.active,
      serverEpochMs: now
    });

  } catch (err) {
    console.error('schedule read error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/schedule', async (req, res) => {
  try {
    const periodSeconds = toInt(req.body.periodSeconds);
    const leadSeconds = toInt(req.body.leadSeconds) ?? DEFAULT_LEAD_SECONDS;

    // DHT22 cannot be sampled faster than once per 2 s (datasheet). Enforced
    // here as well as in the Pi scheduler.
    if (periodSeconds == null ||
        periodSeconds < MIN_PERIOD_SECONDS ||
        periodSeconds > MAX_PERIOD_SECONDS) {
      return res.status(400).json({
        success: false,
        message: `periodSeconds must be an integer between ${MIN_PERIOD_SECONDS} and ${MAX_PERIOD_SECONDS}`
      });
    }

    if (leadSeconds < 0 || leadSeconds > 3600) {
      return res.status(400).json({ success: false, message: 'leadSeconds out of range' });
    }

    const now = Date.now();
    const periodMs = periodSeconds * 1000;
    // Snap to a multiple of the NEW period so every Pi lands on the same grid.
    const effectiveFromMs = Math.ceil((now + leadSeconds * 1000) / periodMs) * periodMs;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('UPDATE SamplingConfig SET active = FALSE WHERE active = TRUE');
      const [result] = await conn.execute(
        `INSERT INTO SamplingConfig (periodSeconds, effectiveFrom, active)
         VALUES (?, ?, TRUE)`,
        [periodSeconds, toSqlDateTime(effectiveFromMs)]
      );
      await conn.commit();

      res.status(201).json({
        success: true,
        configID: result.insertId,
        periodSeconds,
        effectiveFromMs,
        serverEpochMs: now
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

  } catch (err) {
    console.error('schedule write error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ===========================================================================
// DEVICE ON/OFF TRACKING  (timeSyncPlan.md §6b)
// ===========================================================================

app.post('/api/heartbeat', async (req, res) => {
  try {
    const sensorID = toInt(req.body.sensorID);

    if (sensorID == null) {
      return res.status(400).json({ success: false, message: 'sensorID is required' });
    }

    await markSeen(sensorID, {
      bootID: req.body.bootID || null,
      uptimeSeconds: req.body.uptimeSeconds,
      source: 'HEARTBEAT',
      detail: req.body.detail || null
    });

    res.json({
      success: true,
      serverEpochMs: Date.now(),
      offlineAfterSeconds: Math.round(OFFLINE_AFTER_MS / 1000)
    });

  } catch (err) {
    console.error('heartbeat error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Clean-shutdown hook. Only reachable on a graceful stop with the network up,
 *  so it supplements the watchdog inference rather than replacing it. */
app.post('/api/deviceEvent', async (req, res) => {
  try {
    const sensorID = toInt(req.body.sensorID);
    const eventType = req.body.eventType;

    if (!['SHUTDOWN', 'BOOT', 'ONLINE', 'OFFLINE'].includes(eventType)) {
      return res.status(400).json({ success: false, message: 'unsupported eventType' });
    }

    const occurredAtMs = toInt(req.body.occurredAtMs) ?? Date.now();

    const eventID = await logDeviceEvent({
      sensorID,
      eventType,
      occurredAtMs,
      bootID: req.body.bootID || null,
      source: eventType === 'SHUTDOWN' ? 'SHUTDOWN_HOOK' : 'HEARTBEAT',
      detail: req.body.detail || null
    });

    if (eventType === 'SHUTDOWN' && sensorID != null) {
      await pool.execute(
        'UPDATE DeviceStatus SET isOnline = FALSE WHERE sensorID = ?',
        [sensorID]
      );
    }

    res.status(201).json({ success: true, eventID });

  } catch (err) {
    console.error('deviceEvent error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/devices', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.sensorID,
              s.sensorDescription,
              t.sensorType,
              loc.locationName,
              d.lastSeen,
              d.bootID,
              d.bootAt,
              COALESCE(d.isOnline, FALSE) AS isOnline,
              TIMESTAMPDIFF(SECOND, d.lastSeen, NOW(6)) AS secondsSinceLastSeen
       FROM Sensor s
       LEFT JOIN DeviceStatus d ON d.sensorID = s.sensorID
       LEFT JOIN SensorType t ON s.typeID = t.typeID
       LEFT JOIN Location loc ON s.locationID = loc.locationID
       ORDER BY s.sensorID`
    );

    res.json({
      serverEpochMs: Date.now(),
      offlineAfterSeconds: Math.round(OFFLINE_AFTER_MS / 1000),
      // Tells the dashboard that "everything offline" right now may just mean
      // the backend restarted a moment ago.
      inStartupGrace: Date.now() - SERVER_STARTED_AT < STARTUP_GRACE_MS,
      devices: rows.map(r => ({
        ...r,
        isOnline: !!r.isOnline,
        lastSeenMs: toEpochMs(r.lastSeen),
        bootAtMs: toEpochMs(r.bootAt)
      }))
    });

  } catch (err) {
    console.error('devices error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/deviceEvents', async (req, res) => {
  try {
    const limit = Math.min(toInt(req.query.limit) ?? 100, 1000);
    const sensorID = toInt(req.query.sensorID);
    const hours = toInt(req.query.hours);

    let query = `
      SELECT e.eventID, e.sensorID, e.eventType, e.occurredAt, e.detectedAt,
             e.bootID, e.source, e.detail,
             loc.locationName, t.sensorType
      FROM DeviceEvent e
      LEFT JOIN Sensor s ON s.sensorID = e.sensorID
      LEFT JOIN SensorType t ON s.typeID = t.typeID
      LEFT JOIN Location loc ON s.locationID = loc.locationID
      WHERE 1=1
    `;
    const params = [];

    if (sensorID != null) {
      query += ' AND e.sensorID = ?';
      params.push(sensorID);
    }

    if (hours != null) {
      query += ' AND e.occurredAt >= NOW(6) - INTERVAL ? HOUR';
      params.push(hours);
    }

    query += ' ORDER BY e.occurredAt DESC LIMIT ?';
    params.push(limit);

    const [rows] = await pool.query(query, params);

    res.json(rows.map(r => ({
      ...r,
      occurredAtMs: toEpochMs(r.occurredAt),
      detectedAtMs: toEpochMs(r.detectedAt)
    })));

  } catch (err) {
    console.error('deviceEvents error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// START SERVER
app.listen(process.env.PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${process.env.PORT}`);
});

