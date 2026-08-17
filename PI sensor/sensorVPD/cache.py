"""Offline-first local buffer.

Readings are always written here first, before any network call, so collection
never stops for network reasons. The backend client drains this in batches.

Two things this file has to get right beyond plain buffering:

* **Stream separation.** ``dht22.py`` and ``C5A.py`` run from the same folder
  and therefore share this database. Without the ``stream`` column each one
  flushed the other's rows to the wrong endpoint - ``dht22.py`` posting C5A
  rows to ``/api/getDataDHT`` silently dropped windspeed. Every read and
  delete is filtered by stream.
* **Rows taken before the clock was synced.** Each row stores ``bootID`` and a
  ``monotonic`` value. The monotonic clock is continuous and correct-rate
  within one boot, so once the offset to the PC is learned the true time of
  every row from that boot can be reconstructed exactly. See
  ``correct_boot_timestamps()``.
"""

import os
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from .timesync import CORRECTED, ESTIMATED, UNKNOWN

# Resolved against the package's parent (the "PI Env" folder), not the current
# working directory - otherwise the file that gets used depends on where the
# script happened to be launched from.
BASE_DIR = Path(__file__).resolve().parent.parent

DB_FILE = str(Path(os.environ.get("SENSOR_CACHE_DB", BASE_DIR / "sensor_cache.db")))

DEFAULT_FLUSH_LIMIT = 500

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS SensorLog (
    logID INTEGER PRIMARY KEY AUTOINCREMENT,
    sensorID INTEGER,
    datetime TEXT DEFAULT CURRENT_TIMESTAMP,
    temperature REAL,
    humidity REAL,
    windspeed REAL,
    windDirection INTEGER,
    VPD REAL,
    uploaded INTEGER DEFAULT 0
);
"""

# Added by migration on existing databases; see _migrate().
EXTRA_COLUMNS = (
    ("stream", "TEXT"),
    ("bootID", "TEXT"),
    ("monotonic", "REAL"),
    ("tickEpoch", "REAL"),
    ("timeConfidence", "TEXT DEFAULT 'UNKNOWN'"),
    ("readLatencyMs", "INTEGER"),
    ("tickJitterMs", "INTEGER"),
)


def _connect():
    return sqlite3.connect(DB_FILE, timeout=10)


def set_db_file(path):
    """Point the cache at a different file (per-script isolation if wanted)."""
    global DB_FILE
    DB_FILE = str(path)


def _migrate(conn):
    """Add any missing columns. Existing deployments already hold unsent rows,
    so the table is extended in place rather than recreated."""
    existing = {row[1] for row in conn.execute("PRAGMA table_info(SensorLog)")}
    added = []

    for name, spec in EXTRA_COLUMNS:
        if name not in existing:
            conn.execute(f"ALTER TABLE SensorLog ADD COLUMN {name} {spec}")
            added.append(name)

    if "stream" in added:
        # Legacy rows predate the column. Their stream is recoverable from the
        # data itself - only the C5A writes windspeed - so backfill it rather
        # than leave rows that both scripts would try to flush.
        conn.execute(
            "UPDATE SensorLog SET stream = "
            "CASE WHEN windspeed IS NOT NULL THEN 'C5A' ELSE 'DHT' END "
            "WHERE stream IS NULL"
        )


def init_db():
    conn = _connect()
    try:
        conn.execute(CREATE_TABLE_SQL)
        _migrate(conn)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sensorlog_unsent "
            "ON SensorLog (uploaded, stream, logID)"
        )
        conn.commit()
    finally:
        conn.close()


def save_reading(timestamp, temperature, humidity, vpd, windspeed=None,
                 windDirection=None, sensor_id=None, stream=None, boot_id=None,
                 monotonic=None, tick_epoch=None, time_confidence=UNKNOWN,
                 read_latency_ms=None, tick_jitter_ms=None):
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO SensorLog (
                sensorID, datetime, temperature, humidity, windspeed,
                windDirection, VPD, stream, bootID, monotonic, tickEpoch,
                timeConfidence, readLatencyMs, tickJitterMs
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sensor_id, timestamp, temperature, humidity, windspeed,
                windDirection, vpd, stream, boot_id, monotonic, tick_epoch,
                time_confidence, read_latency_ms, tick_jitter_ms,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def get_unsent(stream=None, limit=DEFAULT_FLUSH_LIMIT):
    """Oldest unsent rows for this stream.

    The limit is not optional: after a long outage the backlog is tens of
    thousands of rows, and loading all of them into memory on every flush
    attempt is how a Pi runs out of RAM while already struggling.
    """
    conn = _connect()
    conn.row_factory = sqlite3.Row
    try:
        query = (
            "SELECT logID AS id, sensorID, datetime AS timestamp, temperature, "
            "humidity, windspeed, windDirection, VPD AS vpd, stream, bootID, "
            "monotonic, tickEpoch, timeConfidence, readLatencyMs, tickJitterMs "
            "FROM SensorLog WHERE uploaded = 0"
        )
        params = []

        if stream is not None:
            query += " AND stream = ?"
            params.append(stream)

        query += " ORDER BY logID ASC LIMIT ?"
        params.append(int(limit))

        rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def count_unsent(stream=None):
    conn = _connect()
    try:
        query = "SELECT COUNT(*) FROM SensorLog WHERE uploaded = 0"
        params = []

        if stream is not None:
            query += " AND stream = ?"
            params.append(stream)

        return conn.execute(query, params).fetchone()[0]
    finally:
        conn.close()


def mark_uploaded(record_id):
    mark_uploaded_many([record_id])


def mark_uploaded_many(record_ids):
    ids = list(record_ids)

    if not ids:
        return

    conn = _connect()
    try:
        placeholders = ", ".join("?" for _ in ids)
        conn.execute(
            f"UPDATE SensorLog SET uploaded = 1 WHERE logID IN ({placeholders})",
            ids,
        )
        conn.commit()
    finally:
        conn.close()


def correct_boot_timestamps(boot_id, ref_monotonic, ref_epoch):
    """Rewrite timestamps for rows taken before the clock was synced.

    The offline-first requirement and time sync genuinely conflict at boot:
    with no network there is no correct time, but collection must continue
    anyway. The monotonic clock bridges the two::

        true_epoch(m) = ref_epoch + (m - ref_monotonic)

    Only un-uploaded rows of the current boot are touched. Rows already sent
    are the server's problem, not the cache's.

    Returns the number of rows corrected.
    """
    if boot_id is None or ref_monotonic is None or ref_epoch is None:
        return 0

    conn = _connect()
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT logID, monotonic FROM SensorLog "
            "WHERE uploaded = 0 AND bootID = ? AND monotonic IS NOT NULL "
            "AND timeConfidence = ?",
            (boot_id, ESTIMATED),
        ).fetchall()

        updates = []
        for row in rows:
            true_epoch = ref_epoch + (row["monotonic"] - ref_monotonic)
            updates.append((
                datetime.fromtimestamp(true_epoch).strftime("%Y-%m-%d %H:%M:%S"),
                true_epoch,
                CORRECTED,
                row["logID"],
            ))

        if updates:
            conn.executemany(
                "UPDATE SensorLog SET datetime = ?, tickEpoch = ?, "
                "timeConfidence = ? WHERE logID = ?",
                updates,
            )
            conn.commit()

        return len(updates)
    finally:
        conn.close()


def cleanup(days=30, stream=None):
    # Rows are written with local time (datetime.now()), so the cutoff has to
    # be local too. utcnow() here put the cutoff 7 hours off at UTC+7.
    cutoff = datetime.now() - timedelta(days=days)
    cutoff_str = cutoff.strftime("%Y-%m-%d %H:%M:%S")

    conn = _connect()
    try:
        query = "DELETE FROM SensorLog WHERE uploaded = 1 AND datetime < ?"
        params = [cutoff_str]

        if stream is not None:
            query += " AND stream = ?"
            params.append(stream)

        conn.execute(query, params)
        conn.commit()
    finally:
        conn.close()
