// =====================
// Sampling interval + device on/off panel
// =====================
const DEVICE_API = window.CONFIG.API

const MIN_PERIOD_SECONDS = 2   // DHT22 datasheet limit, also enforced server-side


// =====================
// Sampling schedule
// =====================
async function loadSchedule() {
  const status = document.getElementById("scheduleStatus")

  try {
    const res = await fetch(`${DEVICE_API}/schedule`)
    const s = await res.json()

    document.getElementById("periodInput").placeholder = s.periodSeconds

    const effective = new Date(s.effectiveFromMs)
    const pending = s.effectiveFromMs > s.serverEpochMs

    status.textContent = pending
      ? `${s.periodSeconds}s - takes effect at ${effective.toLocaleTimeString()}`
      : `${s.periodSeconds}s - active since ${effective.toLocaleString()}`

    // The PC and the Pis share a clock now, so a browser clock that disagrees
    // with the server is worth surfacing - it makes chart times look wrong.
    const skew = Math.abs(Date.now() - s.serverEpochMs)
    document.getElementById("clockSkew").textContent =
      skew > 5000 ? `browser clock differs from the server by ~${Math.round(skew / 1000)}s` : ""

  } catch (err) {
    status.textContent = "schedule unavailable"
  }
}

async function applySchedule() {
  const input = document.getElementById("periodInput")
  const status = document.getElementById("scheduleStatus")
  const periodSeconds = Number(input.value)

  if (!Number.isInteger(periodSeconds) || periodSeconds < MIN_PERIOD_SECONDS) {
    status.textContent = `period must be a whole number of seconds, at least ${MIN_PERIOD_SECONDS}`
    return
  }

  status.textContent = "applying..."

  try {
    const res = await fetch(`${DEVICE_API}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // leadSeconds gives every Pi time to poll before the switch instant, so
      // they all change period on the same tick instead of scattering.
      body: JSON.stringify({ periodSeconds, leadSeconds: 30 })
    })

    const body = await res.json()

    if (!res.ok) {
      status.textContent = body.message || "failed"
      return
    }

    input.value = ""
    const at = new Date(body.effectiveFromMs)
    status.textContent =
      `${body.periodSeconds}s - all sensors switch at ${at.toLocaleTimeString()}`

  } catch (err) {
    status.textContent = "failed: " + err.message
  }
}


// =====================
// Device on/off state
// =====================
function formatAge(seconds) {
  if (seconds == null) return "never"
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

async function loadDevices() {
  const tbody = document.querySelector("#deviceTable tbody")
  const note = document.getElementById("deviceNote")

  try {
    const res = await fetch(`${DEVICE_API}/devices`)
    const body = await res.json()

    // A Pi that loses power cannot report its own death, so "offline" is
    // always inferred - and right after a backend restart every Pi looks dead.
    note.textContent = body.inStartupGrace
      ? "backend just restarted - offline detection is suppressed for now"
      : ""

    tbody.innerHTML = ""

    body.devices.forEach(d => {
      const row = document.createElement("tr")
      const name = d.sensorDescription ||
        `${d.sensorType || "unknown"}_${d.locationName || "unknown"}`

      row.innerHTML = `
        <td>${d.sensorID}</td>
        <td>${name}</td>
        <td>${d.isOnline ? "ONLINE" : "offline"}</td>
        <td>${formatAge(d.secondsSinceLastSeen)}</td>
        <td>${d.bootAtMs ? new Date(d.bootAtMs).toLocaleString() : "-"}</td>
      `

      tbody.appendChild(row)
    })

  } catch (err) {
    note.textContent = "device status unavailable"
  }
}

async function loadDeviceEvents() {
  const tbody = document.querySelector("#eventTable tbody")

  try {
    const res = await fetch(`${DEVICE_API}/deviceEvents?limit=25`)
    const events = await res.json()

    tbody.innerHTML = ""

    events.forEach(e => {
      const row = document.createElement("tr")
      const name = e.sensorID == null
        ? "(server)"
        : `${e.sensorType || "sensor"}_${e.locationName || e.sensorID}`

      row.innerHTML = `
        <td>${e.eventType}</td>
        <td>${name}</td>
        <td>${new Date(e.occurredAtMs).toLocaleString()}</td>
        <td>${e.source}</td>
        <td>${e.detail || ""}</td>
      `

      tbody.appendChild(row)
    })

  } catch (err) {
    // The tables just stay as they were.
  }
}


// =====================
// Start
// =====================
document.getElementById("applyPeriod").onclick = applySchedule

function refreshDevicePanel() {
  loadSchedule()
  loadDevices()
  loadDeviceEvents()
}

refreshDevicePanel()
setInterval(refreshDevicePanel, 10000)
