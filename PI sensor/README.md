# Link
https://github.com/Omelettae/sp_dashboard

# Install

```
sudo apt update
sudo apt install python3-pip python3-venv
```
```
python3 -m venv ~/venv
source ~/venv/bin/activate
```

Inside venv
```
pip3 install adafruit-circuitpython-dht
pip install requests pyserial
```

# Timezone — do this on every Pi

Timestamps are stored in **local time**, matching the existing data and the
dashboard. The PC sends unambiguous epoch milliseconds and the Pi formats it
locally, so every Pi must be in the same zone as the backend PC:

```
sudo timedatectl set-timezone Asia/Bangkok
```

# Clock sync — no internet involved

The Pis have no RTC and no internet, so `fake-hwclock` restores whatever time
was saved at shutdown. The backend PC is the time source, over the same LAN
link that already carries sensor data.

`systemd-timesyncd` must be off. It is currently failing in the background
trying to reach public NTP servers, and it can refuse or overwrite the clock
setting:

```
sudo timedatectl set-ntp false
```

`sync_clock.py` also does this before stepping the clock.

# Config files

`config.txt` is **JSON**, one per sensor:

```json
{
  "Type": "DHT22",
  "Location": "Outside Dome 1",
  "GPIO": "D17",
  "description": "outside north wall",
  "Period": 5
}
```

`Period` is optional and only a local fallback — the sampling interval comes
from the PC (`POST /api/schedule`) once the backend is reachable. Minimum is
2 s, the DHT22 datasheet limit.

For the C5A there is no GPIO key; the serial port is used instead.

`networkList.txt` — candidate backend addresses, tried in order:

```
10.230.146.87
192.168.1.100
192.168.1.130
```

## File locations

`sensor_cache.db`, `device_uuid.txt`, `networkList.txt` and `config.txt` are
resolved relative to this `PI Env` folder, not the current working directory,
so it does not matter where a script is launched from.

`device_uuid.txt` is deliberately shared between `dht22.py` and `C5A.py`: the
backend identifies a sensor by (deviceUUID, type, location), so the same UUID
with different types registers as two different sensors.

The cache is shared too, and separated internally by a `stream` column — that
is what stops `dht22.py` from flushing C5A rows to `/api/getDataDHT`.

If two sensor scripts run on the same Pi, give each its own config file:

```
SENSOR_CONFIG=config_dht22.txt python3 dht22.py
SENSOR_CONFIG=config_c5a.txt   python3 C5A.py
```

Other overrides: `SENSOR_CACHE_DB`, `SENSOR_UUID_FILE`.

# Running as a service

`deploy/` holds the unit files. `sensor-timesync.service` is a root oneshot
that steps the system clock from the PC and is ordered **before** the sampling
service, so Pi logs and file mtimes are correct from boot.

```
sudo cp deploy/sensor-timesync.service /etc/systemd/system/
sudo cp deploy/sensor.service /etc/systemd/system/sensor-dht22.service
sudo nano /etc/systemd/system/sensor-dht22.service     # paths, SENSOR_CONFIG

sudo systemctl daemon-reload
sudo systemctl enable --now sensor-timesync.service
sudo systemctl enable --now sensor-dht22.service
```

Check it:

```
systemctl status sensor-dht22
journalctl -u sensor-dht22 -f
timedatectl                    # "NTP service: inactive" is what we want
```

`deploy/010-timesync-sudoers` is optional — only needed to run
`sync_clock.py` by hand as the `pi` user.

# How sampling stays aligned

Each Pi computes its own sampling instants from the Unix epoch:

```
next_tick = floor(now / P) * P + P
```

Given a shared clock, every Pi derives identical instants with no per-sample
message from the PC, so a network outage cannot break alignment. Readings are
stamped with the **tick**, not with read completion — the C5A serial exchange
and the DHT22 read take different amounts of time, and stamping at completion
would bake a permanent bias between sensor types into the data.

Readings taken before the clock is synced are marked `ESTIMATED` and carry a
monotonic timestamp; once the PC is reachable they are rewritten as
`CORRECTED` with their true times. Collection never waits for the network.
