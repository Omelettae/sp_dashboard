"""C5A weather station (modbus over RS485) sampling loop.

Same tick grid as dht22.py, so the wind station and the DHT22s record at the
same instants. All network work runs on a background thread.
"""

import math
import signal
import sys
import threading
import time

import serial

import sensorVPD
from sensorVPD.timesync import ESTIMATED, SYNCED

STREAM = "C5A"

SERIAL_PORT = "/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0"
SERIAL_TIMEOUT = 1.0

# addr 0x01, func 0x03 (read holding registers), start 0x0000, count 5
REQUEST = bytes([0x01, 0x03, 0x00, 0x00, 0x00, 0x05])

# The response is 15 bytes: addr + func + byteCount + 5 registers x 2 + CRC.
# The old code asked for 20, and pyserial returns when it has the requested
# count OR the timeout expires - so every single read blocked for the full
# timeout (2 s) waiting for 5 bytes that were never coming. At 9600 8N1 the
# real exchange is ~35-75 ms.
RESPONSE_LENGTH = 15

READ_RETRIES = 1
RETRY_BUDGET_FRACTION = 0.6

sensorVPD.cache.init_db()

config = sensorVPD.configReader.readConfig()

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


def modbus_crc(data: bytes):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc.to_bytes(2, "little")


def temp_convert(data: bytes):
    binary = format(int(data, 16), "016b")
    sign = binary[1]

    if sign == "1":
        value = -((int("".join("1" if x == "0" else "0" for x in binary), 2) + 1))
    else:
        value = int(binary, 2)

    return value


try:
    ser = serial.Serial(
        port=SERIAL_PORT,
        baudrate=9600,
        bytesize=8,
        parity="N",
        stopbits=1,
        timeout=SERIAL_TIMEOUT,
    )
except Exception as e:
    print("Serial initialization failed:", e)
    ser = None

frame = REQUEST + modbus_crc(REQUEST)


def read_sensor():
    if ser is None:
        raise RuntimeError("Serial port not available")

    # Anything left over from a previous timed-out read would shift the frame.
    ser.reset_input_buffer()
    ser.write(frame)
    response = ser.read(RESPONSE_LENGTH)

    if len(response) < RESPONSE_LENGTH:
        raise RuntimeError(f"Short modbus response ({len(response)} bytes)")

    if modbus_crc(response[:-2]) != response[-2:]:
        raise RuntimeError("Modbus CRC mismatch")

    data = response[3:11]
    wind_speed = int.from_bytes(data[0:2], "big") * 0.01
    wind_direction = int.from_bytes(data[2:4], "big")
    temperature = temp_convert(data[4:6].hex().upper()) * 0.1
    humidity = int.from_bytes(data[6:8], "big") * 0.1
    vpd = (
        0.6108
        * math.exp((17.27 * temperature) / (temperature + 237.3))
        * (1 - (humidity / 100))
    )

    return wind_speed, wind_direction, temperature, humidity, vpd


def read_with_retries(budget_seconds):
    deadline = time.monotonic() + budget_seconds
    last_error = None

    for _ in range(READ_RETRIES + 1):
        try:
            return read_sensor(), None
        except Exception as e:
            last_error = e

        if time.monotonic() >= deadline:
            break

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
print(f"C5A loop started (period {scheduler.period}s, boot {client.boot_id})")
print("Send:", frame.hex(" "))
print("---------------------------------------------------")

while not stop_event.is_set():
    apply_pending_schedule()

    tick = scheduler.wait_for_next_tick()

    if tick is None:
        break

    if tick.skipped:
        print(f"Warning: {tick.skipped} tick(s) skipped - read overran the period")

    # Stamped with the tick, not read completion - see dht22.py.
    timestamp = clock.timestamp(tick.epoch)
    confidence = SYNCED if clock.synced else ESTIMATED

    read_started = time.monotonic()
    values, error = read_with_retries(tick.period * RETRY_BUDGET_FRACTION)
    read_latency_ms = int(round((time.monotonic() - read_started) * 1000))

    if values is None:
        print(f"{timestamp} Reading error:", error)
        continue

    wind_speed, wind_direction, temperature, humidity, vpd = values

    try:
        sensorVPD.cache.save_reading(
            timestamp,
            temperature,
            humidity,
            vpd,
            windspeed=wind_speed,
            windDirection=wind_direction,
            sensor_id=client.sensor_id,
            stream=STREAM,
            boot_id=client.boot_id,
            monotonic=tick.monotonic,
            tick_epoch=tick.epoch,
            time_confidence=confidence,
            read_latency_ms=read_latency_ms,
            tick_jitter_ms=tick.jitter_ms,
        )

        print(f"{timestamp} Wind: {wind_speed:.2f}m/s Dir: {wind_direction} "
              f"Temp: {temperature:.1f}C Humidity: {humidity:.1f}% VPD: {vpd:.2f}kPa "
              f"[{confidence} jitter={tick.jitter_ms}ms read={read_latency_ms}ms]")

    except Exception as e:
        print(f"{timestamp} Cache write failed:", e)

client.report_shutdown()
client.stop()
sys.exit(0)
