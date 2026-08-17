"""All backend traffic, on a background thread.

Everything network-related lives here so the sampling loop stays real-time.
That matters concretely: ``networkSearch`` blocks up to 5 s *per IP* in
``networkList.txt``, which on a 5 s sampling period would miss ticks by itself.
The tick loop must never wait on the network.

``dht22.py`` and ``C5A.py`` previously duplicated ~80 lines of this each; both
now share it.

Thread safety: every ``cache`` call opens its own SQLite connection and the
existing ``timeout=10`` covers write contention, so the maintenance thread and
the tick loop can both touch the cache.
"""

import threading
import time

import requests

from . import cache
from . import network
from .timesync import Clock, read_boot_id, read_uptime

DEFAULT_NETWORK_LIST = "networkList.txt"
DEFAULT_PORT = 5000
DEFAULT_MAINTENANCE_SECONDS = 60
DEFAULT_CLEANUP_DAYS = 30

# Chunk size for the batch upload. Small enough that a large backlog cannot
# monopolise the server, large enough that a 6-hour outage drains in seconds
# instead of minutes of fsync.
DEFAULT_BATCH_SIZE = 200
DEFAULT_MAX_BATCHES_PER_CYCLE = 10

STREAM_ROUTES = {
    "DHT": "/api/getDataDHT",
    "C5A": "/api/getDataC5A",
}


class BackendClient:
    """Discovery, registration, clock sync, schedule polling, heartbeat and
    upload - all driven by one maintenance cycle on a daemon thread."""

    def __init__(self, config, stream, network_list=None, port=DEFAULT_PORT,
                 maintenance_seconds=DEFAULT_MAINTENANCE_SECONDS,
                 cleanup_days=DEFAULT_CLEANUP_DAYS,
                 batch_size=DEFAULT_BATCH_SIZE,
                 max_batches_per_cycle=DEFAULT_MAX_BATCHES_PER_CYCLE,
                 clock=None):
        self.config = config
        self.stream = stream
        self.data_route = STREAM_ROUTES[stream]
        self.network_list = str(network_list or (cache.BASE_DIR / DEFAULT_NETWORK_LIST))
        self.port = port
        self.maintenance_seconds = maintenance_seconds
        self.cleanup_days = cleanup_days
        self.batch_size = batch_size
        self.max_batches_per_cycle = max_batches_per_cycle

        self.clock = clock or Clock()
        self.boot_id = read_boot_id()

        self.stop_event = threading.Event()
        self._lock = threading.Lock()
        self._thread = None
        self._session = requests.Session()

        self._base_url = None
        self._sensor_id = None
        self._schedule = None       # (period_seconds, effective_from_epoch)
        self._batch_supported = True
        self._corrected_this_boot = False

    # -- thread-safe accessors -------------------------------------------

    @property
    def base_url(self):
        with self._lock:
            return self._base_url

    @property
    def sensor_id(self):
        with self._lock:
            return self._sensor_id

    def take_schedule(self):
        """Pop a pending schedule update, or None. Called from the tick loop."""
        with self._lock:
            schedule, self._schedule = self._schedule, None
            return schedule

    # -- lifecycle --------------------------------------------------------

    def start(self):
        if self._thread is not None:
            return

        self._thread = threading.Thread(
            target=self._run, name=f"backend-{self.stream}", daemon=True
        )
        self._thread.start()

    def stop(self, timeout=5):
        self.stop_event.set()

        if self._thread is not None:
            self._thread.join(timeout=timeout)

    def _run(self):
        # Do a full cycle immediately rather than waiting a minute for the
        # first sync - the clock is wrong until then.
        while not self.stop_event.is_set():
            try:
                self.run_maintenance()
            except Exception as e:
                print(f"[{self.stream}] maintenance error:", e)

            self.stop_event.wait(self.maintenance_seconds)

    def run_maintenance(self):
        self.discover_backend()
        self.register_sensor_if_needed()
        self.sync_clock()
        self.poll_schedule()
        self.send_heartbeat()
        self.flush()

        try:
            cache.cleanup(self.cleanup_days, stream=self.stream)
        except Exception as e:
            print(f"[{self.stream}] cache cleanup error:", e)

    # -- discovery / registration ----------------------------------------

    def discover_backend(self):
        if self._base_url is not None and self._probe_current_backend():
            return

        try:
            new_url = network.networkSearch(self.network_list, self.port, "")
        except Exception as e:
            print(f"[{self.stream}] backend discovery error:", e)
            new_url = None

        with self._lock:
            changed = new_url != self._base_url
            self._base_url = new_url

        if changed:
            print(f"[{self.stream}] Backend discovered:" if new_url
                  else f"[{self.stream}] Backend unavailable",
                  new_url or "")

    def _probe_current_backend(self):
        """Cheap liveness check so a working backend is not re-scanned every
        cycle (the scan costs up to 5 s per listed IP)."""
        try:
            r = self._session.get(f"{self._base_url}/api/time", timeout=3)
            return r.status_code == 200
        except Exception:
            return False

    def register_sensor_if_needed(self):
        base_url = self.base_url

        if base_url is None or self.sensor_id is not None:
            return

        try:
            r = self._session.post(
                f"{base_url}/api/registerSensor", json=self.config, timeout=5
            )
            r.raise_for_status()
            sensor_id = r.json().get("sensorID")

            if sensor_id:
                with self._lock:
                    self._sensor_id = sensor_id
                print(f"[{self.stream}] Registered sensor ID: {sensor_id}")
            else:
                print(f"[{self.stream}] Registration response did not include sensorID")

        except Exception as e:
            print(f"[{self.stream}] Registration failed:", e)

    # -- clock ------------------------------------------------------------

    def sync_clock(self):
        base_url = self.base_url

        if base_url is None:
            return

        was_synced = self.clock.synced
        result = self.clock.sync(base_url, session=self._session)

        if result is None:
            # Either every probe failed or the best RTT was above the reject
            # threshold. Keeping the previous offset beats accepting a bad one.
            print(f"[{self.stream}] Clock sync rejected (no usable sample)")
            return

        offset, rtt = result
        print(f"[{self.stream}] Clock sync: offset={offset * 1000:.1f}ms "
              f"rtt={rtt * 1000:.1f}ms")

        if not was_synced:
            self._correct_cached_timestamps()

    def _correct_cached_timestamps(self):
        """Turn ESTIMATED rows from this boot into CORRECTED ones."""
        if self._corrected_this_boot:
            return

        reference = self.clock.reference()

        if reference is None or self.boot_id is None:
            return

        try:
            corrected = cache.correct_boot_timestamps(self.boot_id, *reference)
            self._corrected_this_boot = True

            if corrected:
                print(f"[{self.stream}] Corrected {corrected} pre-sync timestamps")

        except Exception as e:
            print(f"[{self.stream}] Timestamp correction failed:", e)

    # -- schedule ---------------------------------------------------------

    def poll_schedule(self):
        base_url = self.base_url

        if base_url is None:
            return

        try:
            r = self._session.get(f"{base_url}/api/schedule", timeout=5)

            if r.status_code != 200:
                return

            body = r.json()
            period = body.get("periodSeconds")
            effective_from_ms = body.get("effectiveFromMs")

            if period is None:
                return

            effective_from = (effective_from_ms / 1000.0
                              if effective_from_ms is not None
                              else self.clock.now())

            with self._lock:
                self._schedule = (float(period), effective_from)

        except Exception as e:
            print(f"[{self.stream}] Schedule poll failed:", e)

    # -- heartbeat --------------------------------------------------------

    def send_heartbeat(self):
        base_url = self.base_url
        sensor_id = self.sensor_id

        if base_url is None or sensor_id is None:
            return

        payload = {
            "sensorID": sensor_id,
            "deviceUUID": self.config.get("deviceUUID"),
            "bootID": self.boot_id,
            "uptimeSeconds": read_uptime(),
            "clientEpochMs": int(self.clock.now() * 1000),
            "offsetMs": round(self.clock.offset * 1000, 3),
            "rttMs": None if self.clock.rtt is None else round(self.clock.rtt * 1000, 3),
            "detail": f"{self.stream} stream",
        }

        try:
            self._session.post(f"{base_url}/api/heartbeat", json=payload, timeout=5)
        except Exception as e:
            print(f"[{self.stream}] Heartbeat failed:", e)

    def report_shutdown(self):
        """Best-effort clean-shutdown notice. Distinguishes 'deliberately
        stopped' from 'power cut' - but only when the network is up and the
        stop was graceful, so it supplements the watchdog, never replaces it."""
        base_url = self.base_url
        sensor_id = self.sensor_id

        if base_url is None or sensor_id is None:
            return

        try:
            self._session.post(
                f"{base_url}/api/deviceEvent",
                json={
                    "sensorID": sensor_id,
                    "eventType": "SHUTDOWN",
                    "occurredAtMs": int(self.clock.now() * 1000),
                    "bootID": self.boot_id,
                    "detail": f"{self.stream} service stopped",
                },
                timeout=3,
            )
        except Exception:
            pass

    # -- upload -----------------------------------------------------------

    def _row_payload(self, row, now_epoch):
        payload = {
            "sensorID": self.sensor_id,
            "temperature": row["temperature"],
            "humidity": row["humidity"],
            "VPD": row["vpd"],
            "time": row["timestamp"],
            "timeConfidence": row["timeConfidence"] or "UNKNOWN",
            "readLatencyMs": row["readLatencyMs"],
            "tickJitterMs": row["tickJitterMs"],
            "syncRttMs": row["syncRttMs"],
        }

        # Tick -> upload attempt. Large values mean this row was replayed from
        # the offline cache rather than sent live, which is what separates
        # "the network was slow" from "the Pi was offline for six hours".
        if row["tickEpoch"] is not None:
            payload["queueDelayMs"] = int(round((now_epoch - row["tickEpoch"]) * 1000))

        if self.stream == "C5A":
            payload["windSpeed"] = row["windspeed"]
            payload["windDirection"] = row["windDirection"]

        return payload

    def flush(self):
        base_url = self.base_url

        if base_url is None or self.sensor_id is None:
            return

        for _ in range(self.max_batches_per_cycle):
            if self.stop_event.is_set():
                return

            try:
                rows = cache.get_unsent(stream=self.stream, limit=self.batch_size)
            except Exception as e:
                print(f"[{self.stream}] Cache read failed:", e)
                return

            if not rows:
                return

            now_epoch = self.clock.now()
            payloads = [self._row_payload(row, now_epoch) for row in rows]

            if self._batch_supported:
                sent = self._send_batch(base_url, payloads)

                if sent is None:
                    return  # network problem - try again next cycle

                cache.mark_uploaded_many([row["id"] for row in rows])
                print(f"[{self.stream}] Uploaded {len(rows)} rows "
                      f"({rows[0]['timestamp']} .. {rows[-1]['timestamp']})")
            else:
                if not self._send_one_by_one(base_url, rows, payloads):
                    return

            if len(rows) < self.batch_size:
                return

    def _send_batch(self, base_url, payloads):
        try:
            r = self._session.post(
                f"{base_url}/api/sensorLogBatch",
                json={"rows": payloads},
                timeout=30,
            )

            if r.status_code == 404:
                # Older backend. Fall back permanently for this run.
                print(f"[{self.stream}] Batch endpoint missing, using single-row upload")
                self._batch_supported = False
                return None

            if r.status_code != 200:
                print(f"[{self.stream}] Batch upload failed: {r.status_code} {r.text[:200]}")
                return None

            return r.json().get("inserted", len(payloads))

        except Exception as e:
            print(f"[{self.stream}] Batch upload error:", e)
            return None

    def _send_one_by_one(self, base_url, rows, payloads):
        url = f"{base_url}{self.data_route}"
        uploaded = []

        for row, payload in zip(rows, payloads):
            try:
                r = self._session.post(url, json=payload, timeout=5)

                if r.status_code == 200:
                    uploaded.append(row["id"])
                else:
                    print(f"[{self.stream}] Upload failed for record {row['id']}: "
                          f"{r.status_code} {r.text[:200]}")
                    break

            except Exception as e:
                print(f"[{self.stream}] Upload error for record {row['id']}:", e)
                break

        cache.mark_uploaded_many(uploaded)
        return len(uploaded) == len(rows)
