import json
import os
import uuid
from pathlib import Path

# Paths are resolved against the "PI Env" folder rather than the current
# working directory, so running a script from elsewhere does not silently
# create a second device identity.
BASE_DIR = Path(__file__).resolve().parent.parent

# One UUID per physical Pi, deliberately shared between dht22.py and C5A.py:
# the backend identifies a sensor by (deviceUUID, type, location), so the same
# UUID with different types registers as different sensors.
UUID_FILE = Path(os.environ.get("SENSOR_UUID_FILE", BASE_DIR / "device_uuid.txt"))

# config.txt is per-sensor. If both scripts run on one Pi, give each its own
# file via SENSOR_CONFIG (see the systemd units in deploy/).
DEFAULT_CONFIG_FILE = os.environ.get("SENSOR_CONFIG", "config.txt")

# Used only when the backend is unreachable and no period has ever been polled.
DEFAULT_PERIOD_SECONDS = 5


def get_device_uuid():
    if not UUID_FILE.exists():
        UUID_FILE.write_text(str(uuid.uuid4()))

    return UUID_FILE.read_text().strip()


def resolve_config_path(filename=None):
    path = Path(filename or DEFAULT_CONFIG_FILE)

    if not path.is_absolute():
        # Prefer the file next to the scripts; fall back to the cwd copy.
        candidate = BASE_DIR / path
        path = candidate if candidate.exists() else path

    return path


def _parse_text_config(text):
    """Plain-text config, one `key: value` per line:

        Type: DHT22
        Location: Inside Dome 1
        GPIO: D17

    Split on the FIRST colon only, so a value containing one survives. Blank
    lines and # comments are skipped. Values stay strings; readConfig() does
    the only conversion that matters (Period -> float).
    """
    data = {}

    for raw in text.splitlines():
        line = raw.strip()

        if not line or line.startswith("#"):
            continue

        key, separator, value = line.partition(":")

        # A line with no colon is not a setting - ignore rather than guess.
        if not separator:
            continue

        key = key.strip()

        if key:
            data[key] = value.strip()

    return data


def readConfig(filename=None):
    """Read the sensor's config.

    Accepts either JSON or `key: value` text. JSON is tried first, so files in
    either format work and Pis can be converted one at a time rather than all
    at once.
    """
    path = resolve_config_path(filename)

    with open(path, "r") as file:
        raw = file.read()

    try:
        config_data = json.loads(raw)
    except ValueError:
        config_data = _parse_text_config(raw)

    if not isinstance(config_data, dict):
        raise ValueError(
            f"{path}: expected a set of settings, got {type(config_data).__name__}"
        )

    sensor_type = config_data.get("Type") or config_data.get("sensorType") or config_data.get("type")
    location = config_data.get("Location") or config_data.get("locationName") or config_data.get("location")
    gpio = config_data.get("GPIO") or config_data.get("gpio")
    description = config_data.get("description") or config_data.get("Description") or config_data.get("desc")

    # Local fallback only. The PC is the authority on the sampling period
    # (POST /api/schedule); this just keeps a Pi sampling sensibly before it
    # has ever reached the backend.
    period = config_data.get("Period") or config_data.get("period") or config_data.get("periodSeconds")

    try:
        period = float(period) if period is not None else DEFAULT_PERIOD_SECONDS
    except (TypeError, ValueError):
        period = DEFAULT_PERIOD_SECONDS

    # /api/registerSensor rejects a payload without these, and a sensor that
    # never registers just caches locally forever. Failing here names the file
    # instead of leaving a 400 to be traced back from the dashboard.
    if not sensor_type or not location:
        raise ValueError(
            f"{path}: 'Type' and 'Location' are required "
            f"(got Type={sensor_type!r}, Location={location!r})"
        )

    return {
        "deviceUUID": get_device_uuid(),
        "sensorType": sensor_type,
        "locationName": location,
        "gpio": gpio,
        "description": description,
        "periodSeconds": period,
    }
