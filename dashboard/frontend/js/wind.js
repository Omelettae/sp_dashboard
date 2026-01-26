const API = window.CONFIG.API

let chart = null
let allData = []
let sensorsCreated = false


// =======================
// Load data
// =======================
async function loadData() {
  const res = await fetch(`${API}/logs?hours=2`)
  allData = await res.json()

  // only keep sensors that have wind
  allData = allData.filter(d => d.windspeed !== null)

  if (!sensorsCreated) {
    createCheckboxes()
    buildChart()
    sensorsCreated = true
  }

  updateChart()
}


// =======================
// Sensor toggles
// =======================
function createCheckboxes() {
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
}


// =======================
// Chart
// =======================
function buildChart() {
  chart = new Chart(document.getElementById("chart"), {
    type: "line",
    data: { datasets: [] },
    options: {
      animation: false,
      responsive: true,
      scales: {
        x: {
          type: "time",
          time: { unit: "minute" }
        },
        y: {
          title: {
            display: true,
            text: "Wind Speed (m/s)"
          }
        }
      }
    }
  })
}


// =======================
// Update
// =======================
function updateChart() {
  const selected =
    [...document.querySelectorAll("input:checked")]
      .map(c => c.value)

  chart.data.datasets = selected.map(sensor => ({
    label: sensor,
    fill: false,
    data: allData
      .filter(d => d.sensorType === sensor)
      .map(d => ({
        x: new Date(d.datetime),
        y: d.windspeed
      }))
  }))

  chart.update()
}


// =======================
// Start
// =======================
loadData()
setInterval(loadData, 5000)
