// =====================
// Mist maker control panel
// =====================
const ACTUATOR_API = window.CONFIG.API

const MIST_TYPE = "MIST_MAKER"
const DEFAULT_RUN_SECONDS = 60

// The Pi reports at least once a minute. Three missed reports is the point at
// which we stop believing the status column - see the note in render().
const OFFLINE_AFTER_MS = 3 * 60 * 1000

// Panels are built once and then only their text is updated. Re-rendering the
// whole block on every poll would wipe whatever duration the user is halfway
// through typing.
const mistPanels = new Map()


function buildPanel(actuator) {
  const root = document.createElement("div")
  root.className = "panel"

  const title = document.createElement("strong")
  const durationInput = document.createElement("input")
  const startButton = document.createElement("button")
  const stopButton = document.createElement("button")
  const status = document.createElement("span")
  const seen = document.createElement("div")

  title.textContent = actuator.actuatorName ||
    actuator.description ||
    `${actuator.locationName || "mist maker"}`

  durationInput.type = "number"
  durationInput.min = "1"
  durationInput.max = "600"
  durationInput.step = "1"
  durationInput.size = 5
  durationInput.placeholder = DEFAULT_RUN_SECONDS

  startButton.textContent = "Start"
  stopButton.textContent = "Stop"

  status.className = "muted"
  seen.className = "muted"

  startButton.onclick = () => {
    const seconds = Number(durationInput.value) || DEFAULT_RUN_SECONDS
    sendCommand(actuator.actuatorID, "ON", seconds, status)
  }

  // Never disabled, not even when the panel thinks the mister is already off.
  // If the Pi's believed state has drifted, Stop is the thing that has to stay
  // reachable.
  stopButton.onclick = () => sendCommand(actuator.actuatorID, "OFF", null, status)

  const controls = document.createElement("div")
  controls.append("Run for ", durationInput, " seconds ", startButton, " ", stopButton)

  root.append(title, " ", status, controls, seen)
  document.getElementById("mistPanels").appendChild(root)

  return { root, status, seen }
}


async function sendCommand(actuatorID, action, durationSeconds, status) {
  status.textContent = "sending..."

  try {
    const res = await fetch(`${ACTUATOR_API}/actuatorCommand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actuatorID, action, durationSeconds })
    })

    const body = await res.json()

    if (!res.ok) {
      status.textContent = body.message || "failed"
      return
    }

    // The server clamps the duration to its own maximum, and the Pi clamps it
    // again from config.txt. Show what was actually stored rather than what
    // was asked for.
    status.textContent = action === "ON"
      ? `queued - ${body.durationSeconds}s`
      : "queued - stopping"

    loadMistMakers()

  } catch (err) {
    status.textContent = "failed: " + err.message
  }
}


async function loadMistMakers() {
  const note = document.getElementById("mistNote")

  try {
    const res = await fetch(`${ACTUATOR_API}/actuators`)
    const body = await res.json()

    const misters = body.actuators.filter(a => a.typeName === MIST_TYPE)

    note.textContent = misters.length === 0
      ? "no mist maker has registered yet"
      : ""

    misters.forEach(a => {
      if (!mistPanels.has(a.actuatorID)) {
        mistPanels.set(a.actuatorID, buildPanel(a))
      }

      render(mistPanels.get(a.actuatorID), a, body.serverEpochMs)
    })

  } catch (err) {
    note.textContent = "mist maker status unavailable"
  }
}


function render(panel, actuator, serverEpochMs) {
  const lastSeenMs = actuator.lastTelemetryAt
    ? new Date(actuator.lastTelemetryAt).getTime()
    : null

  // Compared against the SERVER's clock, not the browser's - a laptop with a
  // wrong clock would otherwise show every Pi as offline.
  const age = lastSeenMs == null ? null : serverEpochMs - lastSeenMs
  const offline = age == null || age > OFFLINE_AFTER_MS

  // A Pi that is not reporting is exactly when the status column is least
  // trustworthy: it still holds whatever was last written, which may be the
  // dashboard's own optimistic guess from a command the Pi never received. So
  // say "unknown" rather than claiming ON or OFF.
  if (offline) {
    panel.status.textContent = "[ offline - state unknown ]"
    panel.root.style.opacity = "0.6"
  } else {
    const since = actuator.statusUpdatedAtMs
      ? ` since ${new Date(actuator.statusUpdatedAtMs).toLocaleTimeString()}`
      : ""
    panel.status.textContent = `[ ${actuator.status}${since} ]`
    panel.root.style.opacity = "1"
  }

  panel.seen.textContent = age == null
    ? "never reported"
    : `last seen ${formatAge(Math.floor(age / 1000))}`
}


// =====================
// Start
// =====================
loadMistMakers()
setInterval(loadMistMakers, 5000)
