const API = window.CONFIG.API

let chart = null
let allData = []
let sensorsCreated = false


// =====================
// Load data
// =====================
async function loadData() {
  const res = await fetch(`${API}/logs?hours=2`)
  allData = await res.json()

  if (!sensorsCreated) {
    createSensorCheckboxes()
    buildChart()
    sensorsCreated = true
  }

  updateChart()
}


// =====================
// Create sensor toggles
// =====================
function createSensorCheckboxes() {
  const sensors = [...new Set(allData.map(d => d.sensorType))]
  const container = document.getElementById("checkboxes")

  container.innerHTML = ""

  sensors.forEach(name => {
    const label = document.createElement("label")

    label.innerHTML = `
      <input type="checkbox" checked value="${name}">
      ${name}
    `

    label.onchange = updateChart
    container.appendChild(label)
  })

  // metric toggles
  document.querySelectorAll("#metrics input")
    .forEach(cb => cb.onchange = updateChart)
}


// =====================
// Build chart once
// =====================
function buildChart() {
  chart = new Chart(document.getElementById("chart"), {
    type: "line",
    data: { datasets: [] },
    options: {
      animation: false,
      responsive: true,
      interaction: {
        mode: "nearest",
        intersect: false
      },
      scales: {
        x: {
          type: "time",
          time: { unit: "minute" }
        },
        y: {
          title: {
            display: true,
            text: "Value"
          }
        }
      }
    }
  })
}


// =====================
// Update datasets
// =====================
function updateChart() {
  const selectedSensors =
    [...document.querySelectorAll("#checkboxes input:checked")]
      .map(c => c.value)

  const selectedMetrics =
    [...document.querySelectorAll("#metrics input:checked")]
      .map(c => c.value)

  const datasets = []

  selectedSensors.forEach(sensor => {

    const sensorData = allData.filter(d => d.sensorType === sensor)

    // Temperature
    if (selectedMetrics.includes("temperature")) {
      datasets.push({
        label: `${sensor} (Temp)`,
        data: sensorData
          .filter(d => d.temperature !== null)
          .map(d => ({
            x: new Date(d.datetime),
            y: d.temperature
          })),
        fill: false
      })
    }

    // Humidity
    if (selectedMetrics.includes("humidity")) {
      datasets.push({
        label: `${sensor} (Humidity)`,
        data: sensorData
          .filter(d => d.humidity !== null)
          .map(d => ({
            x: new Date(d.datetime),
            y: d.humidity
          })),
        fill: false
      })
    }

  })

  chart.data.datasets = datasets
  chart.update()
}


// =====================
// Start
// =====================
loadData()
setInterval(loadData, 5000)
