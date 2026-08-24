"""DHT22 sampling loop.

Sampling is driven by the shared tick grid (see sensorVPD/scheduler.py), not by
a free-running sleep, so every Pi records at the same instants. All network
work runs on a background thread (sensorVPD/client.py) - the tick path never
blocks on it.
"""

import math
import signal
import sys
import threading
import time

import board
import adafruit_dht

import sensorVPD
from sensorVPD.timesync import ESTIMATED, SYNCED

STREAM = "DHT"

# DHT22 fails often. Retries are given a slice of the period rather than a
# fixed count, so a shorter period cannot push the read past its own tick.
RETRY_BUDGET_FRACTION = 0.6
RETRY_SPACING_SECONDS = 2.0   # datasheet minimum between reads

sensorVPD.cache.init_db()

config = sensorVPD.configReader.readConfig()
gpio = config.get("gpio")
sensor_type = config.get("sensorType")

dht = None

if gpio:
    try:
        dht = adafruit_dht.DHT22(getattr(board, gpio))
    except Exception as e:
        print("Sensor initialization failed:", e)
else:
    if sensor_type == "DHT22":
        print("Warning: DHT22 requires GPIO configuration. "
              "Sensor reads will be disabled until GPIO is configured.")

stop_event = threading.Event()

client = sensorVPD.BackendClient(config, stream=STREAM)
clock = client.clock
scheduler = sensorVPD.TickScheduler(
    clock, config.get("periodSeconds", 5), stop_event=stop_event
)


def handle_stop(signum, frame):
    print("Stopping...")
    stop_event.set()


signal.signal(signal.SIGTERM, handle_stop)
signal.signal(signal.SIGINT, handle_stop)


def read_sensor():
    if dht is None:
        raise RuntimeError("No sensor configured")

    temperature = dht.temperature
    humidity = dht.humidity

    if temperature is None or humidity is None:
        raise RuntimeError("Sensor returned invalid values")

    vpd = (
        0.6108
        * math.exp((17.27 * temperature) / (temperature + 237.3))
        * (1 - (humidity / 100))
    )

    return temperature, humidity, vpd


def read_with_retries(budget_seconds):
    """Read within a time budget. Returns (values, error). Raising all the way
    out would drop the tick silently; an exhausted budget is recorded instead."""
    deadline = time.monotonic() + budget_seconds
    last_error = None

    while True:
        try:
            return read_sensor(), None
        except Exception as e:
            last_error = e

        if time.monotonic() + RETRY_SPACING_SECONDS > deadline:
            return None, last_error

        if stop_event.wait(RETRY_SPACING_SECONDS):
            return None, last_error


def apply_pending_schedule():
    update = client.take_schedule()

    if update is None:
        return

    period, effective_from = update

    if scheduler.schedule_period_change(period, effective_from):
        print(f"Sampling period -> {period}s at "
              f"{clock.timestamp(effective_from)}")


client.start()
print(f"DHT22 loop started (period {scheduler.period}s, "
      f"gpio {gpio}, boot {client.boot_id})")

while not stop_event.is_set():
    apply_pending_schedule()

    tick = scheduler.wait_for_next_tick()

    if tick is None:
        break

    if tick.skipped:
        print(f"Warning: {tick.skipped} tick(s) skipped - read overran the period")

    # Stamped with the TICK, not with read completion. A DHT22 read takes ~1 s
    # and a C5A read a different amount; stamping at completion would bake a
    # permanent bias between sensor types into the data and defeat the whole
    # exercise. The real read duration is stored separately in readLatencyMs.
    timestamp = clock.timestamp(tick.epoch)
    confidence = SYNCED if clock.synced else ESTIMATED
    # The sync in force for THIS reading - captured at the tick, because the
    # background thread may resync before the row is uploaded.
    sync_rtt_ms = None if clock.rtt is None else int(round(clock.rtt * 1000))

    read_started = time.monotonic()
    values, error = read_with_retries(tick.period * RETRY_BUDGET_FRACTION)
    read_latency_ms = int(round((time.monotonic() - read_started) * 1000))

    if values is None:
        print(f"{timestamp} ({gpio}) Reading error:", error)
        continue

    temperature, humidity, vpd = values

    try:
        sensorVPD.cache.save_reading(
            timestamp,
            temperature,
            humidity,
            vpd,
            sensor_id=client.sensor_id,
            stream=STREAM,
            boot_id=client.boot_id,
            monotonic=tick.monotonic,
            tick_epoch=tick.epoch,
            time_confidence=confidence,
            read_latency_ms=read_latency_ms,
            tick_jitter_ms=tick.jitter_ms,
            sync_rtt_ms=sync_rtt_ms,
        )

        print(f"{timestamp} ({gpio}) Temp: {temperature:.1f}C "
              f"Humidity: {humidity:.1f}% VPD: {vpd:.2f}kPa "
              f"[{confidence} jitter={tick.jitter_ms}ms read={read_latency_ms}ms]")

    except Exception as e:
        print(f"{timestamp} ({gpio}) Cache write failed:", e)

client.report_shutdown()
client.stop()
sys.exit(0)
