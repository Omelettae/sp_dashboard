"""Clock synchronisation against the backend PC.

The Pis have no RTC and no internet. ``fake-hwclock`` restores whatever time
was saved at shutdown, so ``datetime.now()`` is meaningless after a reboot.
The PC is the time source, reached over the same LAN link that already carries
sensor data - no internet is involved anywhere.

Two layers:

* ``step_system_clock()`` runs once at boot, as root, before the sensor
  service starts. It fixes the OS clock so logs and file mtimes make sense.
  Coarse - ``timedatectl`` only accepts whole seconds.
* ``Clock`` holds a small in-memory offset for drift while the app runs. The
  system clock is never stepped underneath a running schedule: a backward jump
  would corrupt tick scheduling.

Offsets are measured with Cristian's algorithm, which cancels the network
delay by assuming it is symmetric::

    t0     = local clock before the request
    t1     = PC clock from the response body
    t3     = local clock after the response
    rtt    = t3 - t0
    offset = t1 - t0 - rtt/2

Several samples are taken and the one with the LOWEST round trip is kept - a
fast exchange is the one least distorted by queueing delay. This is what NTP
does. On a LAN this lands within a few milliseconds.
"""

import subprocess
import time
from datetime import datetime

import requests

BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id"
UPTIME_PATH = "/proc/uptime"

DEFAULT_SAMPLES = 10
DEFAULT_TIMEOUT = 5.0

# Cristian's algorithm assumes symmetric delay. Server-side processing breaks
# that assumption, and the backend PC is a slow box whose event loop can stall
# on a large /api/logs response. A bad sync is worse than a slightly stale one,
# so anything slower than this is rejected and the previous offset is kept.
MAX_ACCEPTABLE_RTT = 0.100  # seconds

TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M:%S"

SYNCED = "SYNCED"
CORRECTED = "CORRECTED"
ESTIMATED = "ESTIMATED"
UNKNOWN = "UNKNOWN"


def read_boot_id():
    """Kernel boot id - a fresh UUID on every boot. Identifies which power-on
    a cached reading belongs to."""
    try:
        with open(BOOT_ID_PATH, "r") as f:
            return f.read().strip()
    except Exception:
        return None


def read_uptime():
    """Seconds since boot, or None. The server turns this into a boot time."""
    try:
        with open(UPTIME_PATH, "r") as f:
            return float(f.read().split()[0])
    except Exception:
        return None


def probe(base_url, samples=DEFAULT_SAMPLES, timeout=DEFAULT_TIMEOUT,
          max_rtt=MAX_ACCEPTABLE_RTT, session=None):
    """Measure the offset to the backend clock.

    Returns ``(offset_seconds, rtt_seconds)`` for the lowest-RTT sample, or
    ``None`` if every sample failed or the best one was still too slow.
    """
    if not base_url:
        return None

    http = session or requests
    url = f"{base_url}/api/time"
    best = None

    for _ in range(samples):
        try:
            t0 = time.time()
            r = http.get(url, timeout=timeout)
            t3 = time.time()

            if r.status_code != 200:
                continue

            epoch_ms = r.json().get("epochMs")

            if epoch_ms is None:
                continue

            t1 = epoch_ms / 1000.0
            rtt = t3 - t0
            offset = t1 - t0 - rtt / 2.0

            if best is None or rtt < best[1]:
                best = (offset, rtt)

        except Exception:
            continue

        # A sample this fast cannot be improved on meaningfully; stop early so
        # the maintenance cycle is not held up.
        if best is not None and best[1] < 0.005:
            break

    if best is None:
        return None

    if best[1] > max_rtt:
        return None

    return best


def step_system_clock(epoch_seconds):
    """Step the OS clock. Root only - meant for the boot-time oneshot service.

    ``systemd-timesyncd`` is disabled first: it is currently failing in the
    background trying to reach public NTP servers, and can refuse or overwrite
    our setting. Both calls are purely local syscalls.
    """
    target = datetime.fromtimestamp(epoch_seconds).strftime("%Y-%m-%d %H:%M:%S")

    try:
        subprocess.run(
            ["timedatectl", "set-ntp", "false"],
            check=False, capture_output=True, timeout=10,
        )
        result = subprocess.run(
            ["timedatectl", "set-time", target],
            check=False, capture_output=True, timeout=10,
        )

        if result.returncode != 0:
            print("timedatectl set-time failed:", result.stderr.decode(errors="replace").strip())
            return False

        return True

    except Exception as e:
        print("Clock step failed:", e)
        return False


class Clock:
    """The app's view of the true time.

    ``now()`` is ``time.time() + offset``. Nothing here ever touches the system
    clock, so a sync arriving mid-sleep cannot disturb a running schedule.

    Also records the (monotonic, epoch) pair captured at the first successful
    sync of this boot. The monotonic clock is continuous and correct-rate
    within a boot, so readings taken before the sync can have their true time
    reconstructed exactly afterwards::

        true_epoch(m) = ref_epoch + (m - ref_monotonic)
    """

    def __init__(self):
        self.offset = 0.0
        self.rtt = None
        self.synced = False
        self.last_sync_monotonic = None
        self.boot_id = read_boot_id()
        # Captured once, at the first successful sync of this boot.
        self.ref_monotonic = None
        self.ref_epoch = None

    # -- time ------------------------------------------------------------

    def now(self):
        return time.time() + self.offset

    @staticmethod
    def monotonic():
        return time.monotonic()

    def timestamp(self, epoch=None):
        """Local-time string, matching the format already stored in MySQL."""
        return datetime.fromtimestamp(
            self.now() if epoch is None else epoch
        ).strftime(TIMESTAMP_FORMAT)

    @property
    def confidence(self):
        return SYNCED if self.synced else ESTIMATED

    def age_seconds(self):
        if self.last_sync_monotonic is None:
            return None
        return time.monotonic() - self.last_sync_monotonic

    # -- syncing ---------------------------------------------------------

    def sync(self, base_url, samples=DEFAULT_SAMPLES, timeout=DEFAULT_TIMEOUT,
             session=None):
        """Re-measure the offset.

        Returns ``(offset, rtt)`` on success, ``None`` on failure (in which
        case the previous offset is kept).
        """
        result = probe(base_url, samples=samples, timeout=timeout, session=session)

        if result is None:
            return None

        offset, rtt = result
        first_sync = not self.synced

        self.offset = offset
        self.rtt = rtt
        self.synced = True
        self.last_sync_monotonic = time.monotonic()

        if first_sync:
            # Order matters: read monotonic and epoch as close together as
            # possible so the reference pair is self-consistent.
            self.ref_monotonic = time.monotonic()
            self.ref_epoch = self.now()

        return offset, rtt

    def reference(self):
        """``(ref_monotonic, ref_epoch)`` for back-correcting cached rows, or
        ``None`` if this boot has never synced."""
        if self.ref_monotonic is None:
            return None
        return self.ref_monotonic, self.ref_epoch
