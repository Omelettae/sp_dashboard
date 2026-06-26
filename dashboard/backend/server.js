require("dotenv").config();
const express = require("express");
const mysql = require('mysql2/promise');
const cors = require("cors");
const app = express();

// MIDDLEWARE
app.use(cors());
app.use(express.json());

// MYSQL CONNECTION
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
})

async function startServer() {
  try {
    await pool.query('SELECT 1') // test DB
    console.log('Database connected')
  } catch (err) {
    console.error('Database connection failed:', err)
    process.exit(1)
  }
}
startServer()



// test
app.get("/", (req, res) => {
  res.send("API is running");
});

// GET all sensors
app.get('/api/sensors', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM Sensor')
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
    // UUID + Type + Location
    // ======================================

    const [existingSensor] = await pool.execute(
      `
      SELECT sensorID
      FROM Sensor
      WHERE deviceUUID = ?
      AND typeID = ?
      AND locationID = ?
      `,
      [
        deviceUUID,
        typeID,
        locationID
      ]
    );

    if (existingSensor.length > 0) {

      return res.status(200).json({
        success: true,
        sensorID: existingSensor[0].sensorID,
        existing: true
      });

    }

    // ======================
    // Create New Sensor
    // ======================

    const [sensorResult] = await pool.execute(
      `
      INSERT INTO Sensor (
        typeID,
        locationID,
        deviceUUID
      )
      VALUES (?, ?, ?)
      `,
      [
        typeID,
        locationID,
        deviceUUID
      ]
    );

    return res.status(201).json({
      success: true,
      sensorID: sensorResult.insertId,
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
  const { hours, start, end } = req.query

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
           l.VPD
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


app.post('/api/getDataDHT', async (req, res) => {
  try {
    const { sensorID, temperature, humidity, VPD, time } = req.body;

    if (sensorID == null ) {
      return res.status(400).json({ message: 'Missing Sensor ID' });
    }

    const sql = `
      INSERT INTO SensorLog
      (sensorID, datetime, temperature, humidity, VPD)
      VALUES (?, ?, ?, ?, ?)
    `;

    const [result] = await pool.execute(sql, [
      sensorID,
      time,
      temperature,
      humidity,
      VPD
    ]);

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
    const { sensorID, windSpeed, windDirection, temperature, humidity, VPD, time } = req.body;

    if (
      sensorID == null ||
    ) {
      return res.status(400).json({ message: 'Missing Sensor ID' });
    }

    const sql = `
      INSERT INTO SensorLog
      (sensorID, datetime, temperature, humidity windspeed, windDirection,  VPD)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const [result] = await pool.execute(sql, [
      sensorID,
      time,
      temperature,
      humidity,
      windSpeed,
      windDirection,
      VPD,
    ]);

    res.status(200).json({
      success: true,
      logID: result.insertId
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// START SERVER
app.listen(process.env.PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${process.env.PORT}`);
});

