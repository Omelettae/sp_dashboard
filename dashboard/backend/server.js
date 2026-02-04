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
    SELECT s.sensorID, s.sensorType, s.sensorLocation,
           l.datetime, l.temperature, l.humidity,
           l.windspeed, l.windDirection, l.VPD
    FROM SensorLog l
    JOIN Sensor s ON s.sensorID = l.sensorID
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

app.post('/api/getDataDHT', async (req, res) => {
  try {
    const { sensorID, temperature, humidity, VPD, time } = req.body;

    if (sensorID == null || temperature == null || humidity == null || VPD == null || time == null ) {
      return res.status(400).json({ message: 'Missing DHT data' });
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
    const { sensorID, windSpeed, windDirection, time } = req.body;

    if (
      sensorID == null ||
      windSpeed == null ||
      windDirection == null ||
      time == null
    ) {
      return res.status(400).json({ message: 'Missing C5A data' });
    }

    const sql = `
      INSERT INTO SensorLog
      (sensorID, datetime, windspeed, windDirection)
      VALUES (?, ?, ?, ?)
    `;

    const [result] = await pool.execute(sql, [
      sensorID,
      time,
      windSpeed,
      windDirection,
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
