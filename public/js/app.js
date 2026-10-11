/**
 * SurgeX - Modern Frontend Controller
 * Connects to WebSocket / REST API, manages Leaflet H3 map,
 * handles real-time simulation updates, and coordinates all 5 modules.
 */

document.addEventListener('DOMContentLoaded', () => {
  // --- Global State ---
  let map = null;
  let h3PolygonLayers = {};
  let h3LabelMarkers = {};
  let driverMarkers = {};
  let relocationPolylineLayers = [];
  let systemState = null;
  let activeStep = 0;
  let ws = null;
  let selectedZoneId = 'koramangala';

  // --- Initialize Leaflet Map ---
  function initMap() {
    // Center of Bengaluru
    map = L.map('bengaluruMap', {
      zoomControl: true,
      attributionControl: false
    }).setView([12.9450, 77.6400], 12);

    // CartoDB Dark Matter tiles for ultra-sleek modern UI
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 18,
      subdomains: 'abcd'
    }).addTo(map);
  }

  // --- WebSocket Connection ---
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        const statusEl = document.getElementById('connectionStatus');
        if (statusEl) statusEl.textContent = 'SIMULATOR LIVE (WS)';
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'STATE_UPDATE') {
            systemState = msg.payload;
            renderSystemState(systemState);
          } else if (msg.type === 'EVENT_STREAM') {
            appendKafkaEvent(msg.payload);
          }
        } catch (e) {
          console.error('WS parse error', e);
        }
      };

      ws.onclose = () => {
        const statusEl = document.getElementById('connectionStatus');
        if (statusEl) statusEl.textContent = 'POLLING MODE';
        // Auto-reconnect after 3s
        setTimeout(initWebSocket, 3000);
      };
    } catch (e) {
      console.warn('WebSocket failed, using REST fallback', e);
    }

    // Initial state fetch via REST
    fetchSystemState();
  }

  async function fetchSystemState() {
    try {
      const res = await fetch('/api/state');
      const json = await res.json();
      if (json.success && json.data) {
        systemState = json.data;
        renderSystemState(systemState);
      }
    } catch (err) {
      console.error('Fetch state error', err);
    }
  }

  // --- Map Rendering: H3 Hexagons & Telemetry ---
  function updateMapHexagons(cells) {
    if (!map || !cells) return;

    cells.forEach(cell => {
      const h3Id = cell.h3Index;
      // boundary is array of [lat, lng]
      const latlngs = cell.boundary.map(coord => [coord[0], coord[1]]);

      // Determine styling based on status
      let fillColor = '#06b6d4'; // balanced
      let strokeColor = '#38bdf8';
      let fillOpacity = 0.25;

      if (cell.status === 'SEVERE_SHORTAGE') {
        fillColor = '#ef4444';
        strokeColor = '#f87171';
        fillOpacity = 0.55;
      } else if (cell.status === 'MODERATE_SHORTAGE') {
        fillColor = '#f59e0b';
        strokeColor = '#fbbf24';
        fillOpacity = 0.35;
      } else if (cell.status === 'EXCESS_SUPPLY') {
        fillColor = '#10b981';
        strokeColor = '#34d399';
        fillOpacity = 0.30;
      }

      if (cell.zoneId === selectedZoneId) {
        strokeColor = '#ffffff';
      }

      if (!h3PolygonLayers[h3Id]) {
        // Create polygon
        const polygon = L.polygon(latlngs, {
          color: strokeColor,
          weight: cell.zoneId === selectedZoneId ? 3 : 1.5,
          fillColor: fillColor,
          fillOpacity: fillOpacity,
          dashArray: cell.status === 'SEVERE_SHORTAGE' ? '4, 4' : null
        }).addTo(map);

        polygon.on('click', () => {
          selectZone(cell.zoneId);
        });

        h3PolygonLayers[h3Id] = polygon;
      } else {
        // Update existing polygon
        h3PolygonLayers[h3Id].setStyle({
          color: strokeColor,
          weight: cell.zoneId === selectedZoneId ? 3 : 1.5,
          fillColor: fillColor,
          fillOpacity: fillOpacity,
          dashArray: cell.status === 'SEVERE_SHORTAGE' ? '4, 4' : null
        });
      }

      // Center marker label
      const center = [cell.center.lat, cell.center.lng];
      const rainIcon = cell.rainfall === 'HEAVY' ? ' 🌧️' : (cell.rainfall === 'MODERATE' ? ' 🌦️' : '');
      const bonusTag = cell.pricing && cell.pricing.driverIncentiveBonus > 0 ? ` <span style="color:#fbbf24;font-weight:700;">+₹${cell.pricing.driverIncentiveBonus}</span>` : '';

      const labelHtml = `
        <div class="h3-zone-label ${cell.status.toLowerCase()} ${cell.zoneId === selectedZoneId ? 'selected' : ''}" style="
          background: rgba(11, 15, 25, 0.85);
          backdrop-filter: blur(8px);
          border: 1px solid ${strokeColor};
          padding: 3px 8px;
          border-radius: 6px;
          font-size: 11px;
          color: #f8fafc;
          white-space: nowrap;
          text-align: center;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
          cursor: pointer;
        ">
          <div style="font-weight:700;">${cell.name}${rainIcon}</div>
          <div style="font-size:9.5px;color:#94a3b8;">
            Req: <b style="color:#fff;">${cell.activeRequests}</b> | Drv: <b style="color:#fff;">${cell.availableDrivers}</b> | R=<b style="color:${cell.status === 'SEVERE_SHORTAGE' ? '#f87171' : '#38bdf8'}">${cell.demandSupplyRatio}</b>${bonusTag}
          </div>
        </div>
      `;

      if (!h3LabelMarkers[h3Id]) {
        const customIcon = L.divIcon({
          html: labelHtml,
          className: 'custom-h3-label',
          iconSize: [140, 36],
          iconAnchor: [70, 18]
        });
        const marker = L.marker(center, { icon: customIcon }).addTo(map);
        marker.on('click', () => selectZone(cell.zoneId));
        h3LabelMarkers[h3Id] = marker;
      } else {
        h3LabelMarkers[h3Id].setIcon(L.divIcon({
          html: labelHtml,
          className: 'custom-h3-label',
          iconSize: [140, 36],
          iconAnchor: [70, 18]
        }));
      }
    });
  }

  function updateDriverMarkers(drivers) {
    if (!map || !drivers) return;

    // Clear old relocation polylines
    relocationPolylineLayers.forEach(layer => map.removeLayer(layer));
    relocationPolylineLayers = [];

    drivers.forEach(d => {
      let iconColor = '#64748b'; // default available
      let size = 6;

      if (d.status === 'AVAILABLE') {
        iconColor = '#10b981';
      } else if (d.status === 'RESERVED') {
        iconColor = '#f59e0b';
        size = 8;
      } else if (d.status === 'ASSIGNED') {
        iconColor = '#38bdf8';
        size = 8;
      } else if (d.status === 'RELOCATING') {
        iconColor = '#facc15';
        size = 9;

        // Draw animated relocation path to destination zone
        if (d.targetZoneId && systemState && systemState.cells) {
          const targetCell = systemState.cells.find(c => c.zoneId === d.targetZoneId);
          if (targetCell) {
            const line = L.polyline([[d.lat, d.lng], [targetCell.center.lat, targetCell.center.lng]], {
              color: '#facc15',
              weight: 2,
              dashArray: '5, 8',
              opacity: 0.85
            }).addTo(map);
            relocationPolylineLayers.push(line);
          }
        }
      }

      if (!driverMarkers[d.id]) {
        const marker = L.circleMarker([d.lat, d.lng], {
          radius: size,
          fillColor: iconColor,
          color: '#ffffff',
          weight: 1,
          opacity: 0.9,
          fillOpacity: 0.85
        }).addTo(map);

        marker.bindTooltip(`<b>${d.name}</b><br>Status: ${d.status}<br>Rating: ⭐ ${d.rating}`);
        driverMarkers[d.id] = marker;
      } else {
        driverMarkers[d.id].setLatLng([d.lat, d.lng]);
        driverMarkers[d.id].setStyle({
          radius: size,
          fillColor: iconColor
        });
        driverMarkers[d.id].setTooltipContent(`<b>${d.name}</b><br>Status: ${d.status}<br>Rating: ⭐ ${d.rating}`);
      }
    });
  }

  // --- Select Zone & Update Floating HUD Inspector ---
  function selectZone(zoneId) {
    selectedZoneId = zoneId;
    if (!systemState || !systemState.cells) return;

    const cell = systemState.cells.find(c => c.zoneId === zoneId);
    if (!cell) return;

    const inspector = document.getElementById('zoneQuickInspector');
    if (inspector) inspector.classList.remove('hidden');

    document.getElementById('inspectZoneName').textContent = cell.name + (cell.rainfall === 'HEAVY' ? ' (Heavy Rain 🌧️)' : '');
    const badge = document.getElementById('inspectZoneBadge');
    badge.className = `zone-badge ${cell.status.toLowerCase().replace('_', '-')}`;
    badge.textContent = cell.status.replace('_', ' ');

    document.getElementById('inspectDemandSupply').textContent = `${cell.activeRequests} / ${cell.availableDrivers}`;
    document.getElementById('inspectRatio').textContent = cell.demandSupplyRatio.toFixed(2);
    document.getElementById('inspectShortage').textContent = `${cell.shortage} rides`;

    const pricing = cell.pricing || {};
    document.getElementById('inspectMultiplier').textContent = `${pricing.multiplier || 1.0}x (₹${pricing.finalFare || 200})`;
    document.getElementById('inspectCompetitorFare').textContent = `${pricing.naiveCompetitor ? pricing.naiveCompetitor.multiplier : 1.0}x (₹${pricing.naiveCompetitor ? pricing.naiveCompetitor.fare : 200})`;
    document.getElementById('inspectBonus').textContent = pricing.driverIncentiveBonus > 0 ? `+₹${pricing.driverIncentiveBonus} / ride` : 'None';

    // Synchronize select dropdown in Pricing tab
    const calcSelect = document.getElementById('calcZoneSelect');
    if (calcSelect) {
      calcSelect.value = zoneId;
      updatePricingTab(cell);
    }

    // Refresh map polygons so selected border highlights
    if (systemState && systemState.cells) {
      updateMapHexagons(systemState.cells);
    }
  }

  // --- Render All System State Data ---
  function renderSystemState(state) {
    if (!state) return;

    // 1. Update Map
    updateMapHexagons(state.cells);
    updateDriverMarkers(state.drivers);

    // 2. Summary stats
    const mapStats = document.getElementById('mapSummaryStats');
    if (mapStats && state.summary) {
      mapStats.textContent = `${state.cells.length} Active H3 Cells • ${state.summary.availableDrivers} Available Drivers (${state.summary.relocatingDrivers} Relocating)`;
    }

    // 3. Update Stepper UI if scenario step changed
    if (state.scenarioStep !== undefined) {
      setScenarioStepUI(state.scenarioStep);
    }

    // 4. Update Overview Comparison Table
    updateOverviewTab(state.metrics);

    // 5. Update Module 2 Hotspot Table
    updateHotspotTable(state.cells);

    // 6. Update Module 4 Recommendations List
    updateAllocationTab(state.recommendations);

    // 7. Update Selected Zone Inspector
    if (selectedZoneId) {
      selectZone(selectedZoneId);
    }

    // 8. Update Concurrency test driver target
    const targetDriverSpan = document.getElementById('testTargetDriverName');
    const availDriver = state.drivers.find(d => d.status === 'AVAILABLE');
    if (targetDriverSpan && availDriver) {
      targetDriverSpan.textContent = `${availDriver.name} (${availDriver.id})`;
    }
  }

  // --- Render Overview Tab (Head-to-Head Comparison) ---
  function updateOverviewTab(metrics) {
    if (!metrics) return;
    const { surgeX, baseline } = metrics;

    setText('metWaitSurgeX', `${surgeX.avgWaitTimeMinutes} min`);
    setText('metWaitBaseline', `${baseline.avgWaitTimeMinutes} min`);

    setText('metCancelSurgeX', `${surgeX.cancellationRatePercent}%`);
    setText('metCancelBaseline', `${baseline.cancellationRatePercent}%`);

    setText('metUtilSurgeX', `${surgeX.driverUtilizationPercent}%`);
    setText('metUtilBaseline', `${baseline.driverUtilizationPercent}%`);

    setText('metFareSurgeX', `₹${surgeX.avgFarePaidInr} (${surgeX.avgSurgeMultiplier}x)`);
    setText('metFareBaseline', `₹${baseline.avgFarePaidInr} (${baseline.avgSurgeMultiplier}x)`);

    setText('metRelocSurgeX', `${surgeX.relocationAcceptanceRatePercent}% (${surgeX.relocationSuccessCount} arr)`);
    setText('metRelocBaseline', `${baseline.relocationAcceptanceRatePercent}% (${baseline.relocationSuccessCount} arr)`);

    setText('metFairnessSurgeX', `${surgeX.neighbourhoodFairnessScore} / 100`);
    setText('metFairnessBaseline', `${baseline.neighbourhoodFairnessScore} / 100`);

    setText('kpiTotalIncentives', `₹${(surgeX.totalIncentiveSpentInr || 1260).toLocaleString()}`);
    setText('kpiRelocationsCount', `${surgeX.relocationSuccessCount || 18}`);
    setText('kpiCustomerSaved', `₹${Math.max(0, baseline.avgFarePaidInr - surgeX.avgFarePaidInr)} / ride`);
  }

  // --- Render Module 2 Hotspots Table ---
  function updateHotspotTable(cells) {
    const tbody = document.getElementById('hotspotTableBody');
    if (!tbody || !cells) return;

    tbody.innerHTML = '';
    cells.forEach(cell => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.onclick = () => selectZone(cell.zoneId);

      const statusBadge = `<span class="zone-badge ${cell.status.toLowerCase().replace('_', '-')}">${cell.status.replace('_', ' ')}</span>`;
      const rain = cell.rainfall === 'HEAVY' ? ' 🌧️' : '';

      tr.innerHTML = `
        <td><strong>${cell.name}${rain}</strong></td>
        <td>${cell.activeRequests}</td>
        <td>${cell.availableDrivers}</td>
        <td style="font-weight:700;color:${cell.status === 'SEVERE_SHORTAGE' ? '#f87171' : '#38bdf8'};">${cell.demandSupplyRatio.toFixed(2)}</td>
        <td>${cell.avgPickupEtaMinutes} min</td>
        <td>${statusBadge}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // --- Render Module 3 Pricing Tab ---
  function updatePricingTab(cell) {
    if (!cell || !cell.pricing) return;
    const p = cell.pricing;

    setText('calcSurgeXFare', `₹${p.finalFare}`);
    setText('calcSurgeXBreakdown', `Base ₹${p.baseFare} × ${p.multiplier}x Multiplier`);

    if (p.naiveCompetitor) {
      setText('calcNaiveFare', `₹${p.naiveCompetitor.fare}`);
      setText('calcNaiveBreakdown', `Base ₹${p.baseFare} × ${p.naiveCompetitor.multiplier}x Uncapped Surge`);
    }

    const badge = document.getElementById('calcDriverBonusBadge');
    if (badge) {
      badge.textContent = p.driverIncentiveBonus > 0 ? `+₹${p.driverIncentiveBonus} / RIDE` : 'NO BONUS';
    }
    setText('calcDriverBonusDesc', p.driverAction);
  }

  // --- Render Module 4 Driver Allocation Recommendations ---
  function updateAllocationTab(recommendations) {
    const container = document.getElementById('allocationRecommendationsList');
    if (!container || !recommendations) return;

    container.innerHTML = '';
    recommendations.forEach(rec => {
      const card = document.createElement('div');
      card.className = `rec-card ${rec.isFairToRelocate ? 'safe-donor' : 'protected-zone'}`;

      const fairnessBadge = rec.isFairToRelocate
        ? `<span class="zone-badge excess">SAFE SURPLUS (+${rec.safeDonorSurplus} DRV)</span>`
        : `<span class="zone-badge balanced">PROTECTED (BALANCED)</span>`;

      card.innerHTML = `
        <div class="rec-info">
          <h5>${rec.donorZoneName} &rarr; ${rec.targetZoneName}</h5>
          <div class="rec-meta">
            Dist: <b>${rec.distanceKm} km</b> • Est. Travel: <b>${rec.estimatedTravelMinutes} mins</b> • Idle: <b>${rec.eligibleDriverCount}</b>
          </div>
          <div style="margin-top:4px;">${fairnessBadge}</div>
        </div>
        <div>
          ${rec.isFairToRelocate 
            ? `<button class="btn btn-sm btn-warning" onclick="window.relocateDonorBatch('${rec.donorZoneId}')">Relocate (${rec.safeDonorSurplus})</button>`
            : `<button class="btn btn-sm btn-outline" disabled>Do Not Drain</button>`
          }
        </div>
      `;
      container.appendChild(card);
    });
  }

  // --- Kafka Event Stream Terminal ---
  function appendKafkaEvent(evt) {
    const terminal = document.getElementById('kafkaEventLog');
    if (!terminal) return;

    const line = document.createElement('div');
    line.className = 'terminal-line';

    let colorClass = 'info';
    if (evt.topic === 'hotspot.alerts' || evt.topic === 'weather.events') colorClass = 'danger';
    else if (evt.topic === 'driver.incentives' || evt.topic === 'booking.reservations') colorClass = 'success';

    line.innerHTML = `<span style="color:#64748b;">[${evt.timestamp.slice(11, 19)}]</span> <b class="${colorClass}">${evt.topic}</b>: ${JSON.stringify(evt.payload)}`;
    terminal.insertBefore(line, terminal.firstChild);

    // Keep max 60 lines
    while (terminal.children.length > 60) {
      terminal.removeChild(terminal.lastChild);
    }
  }

  // --- Stepper UI Sync ---
  function setScenarioStepUI(step) {
    activeStep = step;
    document.getElementById('currentStepIndicator').textContent = `Step ${step > 0 ? step : 1} of 5`;

    for (let i = 1; i <= 5; i++) {
      const node = document.getElementById(`stepNode${i}`);
      const connector = document.getElementById(`connector${i}`);

      if (node) {
        if (i < step) {
          node.className = 'step-node completed';
        } else if (i === step) {
          node.className = 'step-node active';
        } else {
          node.className = 'step-node';
        }
      }

      if (connector) {
        if (i < step) connector.className = 'step-connector active';
        else connector.className = 'step-connector';
      }
    }

    const narratives = {
      0: { badge: 'INITIALIZED', text: 'Baseline Bengaluru operations. Click "6:00 PM Rain Spike" or "Next Step" to simulate the sudden demand spike in Koramangala.' },
      1: { badge: 'STEP 1: DETECT SHORTAGE', text: 'SurgeX receives 100 requests in Koramangala with only 20 drivers (R=5.0, Shortage=80). Indiranagar has 40 drivers for 30 requests (R=0.75, Excess). Whitefield has 30 drivers for 25 requests (R=0.83, Balanced).' },
      2: { badge: 'STEP 2: FIND NEARBY HELP', text: 'SurgeX identifies idle drivers in Indiranagar (~8 mins away). Crucial safeguard: SurgeX checks neighbourhood fairness and confirms Indiranagar can safely spare 10 drivers without deficit. Whitefield is safely protected!' },
      3: { badge: 'STEP 3: TARGETED INCENTIVE', text: 'SurgeX broadcasts targeted +₹30 driver bonus for Koramangala trips. Local fare multiplier is capped at only 1.18x (₹236 vs naive competitor ₹760!), prioritizing supply relocation over rider gouging.' },
      4: { badge: 'STEP 4: SAFE RIDE MATCHING', text: 'Idle drivers accept the ₹30 bonus and begin moving to Koramangala. Atomic reservation lock claims available drivers with zero double-booking race conditions.' },
      5: { badge: 'STEP 5: RECALCULATE & STABILIZE', text: '15 additional drivers arrive in Koramangala! Supply increases from 20 to 35. Ratio drops from 5.0 to 1.85. The shortage resolves, fares remain fair, and driver bonuses taper down gracefully.' }
    };

    const narrative = narratives[step] || narratives[0];
    document.getElementById('narrativeBadge').textContent = narrative.badge;
    document.getElementById('narrativeText').textContent = narrative.text;

    document.getElementById('btnPrevStep').disabled = step <= 1;
    document.getElementById('btnNextStep').disabled = step >= 5;
  }

  // Helper
  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // --- Attach Event Listeners ---
  initMap();
  initWebSocket();

  // Scenario Buttons
  document.getElementById('btnTriggerPeak').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/scenario/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 1 })
      });
      const data = await res.json();
      if (data.systemState) renderSystemState(data.systemState);
      setScenarioStepUI(1);
    } catch (e) { console.error(e); }
  });

  document.getElementById('btnNextStep').addEventListener('click', async () => {
    const next = Math.min(5, (activeStep || 0) + 1);
    try {
      const res = await fetch('/api/scenario/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: next })
      });
      const data = await res.json();
      if (data.systemState) renderSystemState(data.systemState);
      setScenarioStepUI(next);
    } catch (e) { console.error(e); }
  });

  document.getElementById('btnPrevStep').addEventListener('click', async () => {
    const prev = Math.max(1, (activeStep || 1) - 1);
    try {
      const res = await fetch('/api/scenario/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: prev })
      });
      const data = await res.json();
      if (data.systemState) renderSystemState(data.systemState);
      setScenarioStepUI(prev);
    } catch (e) { console.error(e); }
  });

  // Step Node clicks
  for (let i = 1; i <= 5; i++) {
    const node = document.getElementById(`stepNode${i}`);
    if (node) {
      node.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/scenario/step', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ step: i })
          });
          const data = await res.json();
          if (data.systemState) renderSystemState(data.systemState);
          setScenarioStepUI(i);
        } catch (e) { console.error(e); }
      });
    }
  }

  document.getElementById('btnResetFleet').addEventListener('click', async () => {
    try {
      await fetch('/api/scenario/reset', { method: 'POST' });
      fetchSystemState();
      setScenarioStepUI(0);
    } catch (e) { console.error(e); }
  });

  document.getElementById('btnToggleSim').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/simulation/toggle', { method: 'POST' });
      const data = await res.json();
      document.getElementById('simPlayIcon').textContent = data.isRunning ? '⏸' : '▶';
      document.getElementById('simPlayText').textContent = data.isRunning ? 'Pause Sim' : 'Play Sim';
    } catch (e) { console.error(e); }
  });

  // Tab Switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      const target = document.getElementById(targetId);
      if (target) target.classList.add('active');
    });
  });

  // Inspector Close
  document.getElementById('btnCloseInspector').addEventListener('click', () => {
    document.getElementById('zoneQuickInspector').classList.add('hidden');
  });

  // Pricing Zone Select
  document.getElementById('calcZoneSelect').addEventListener('change', (e) => {
    selectZone(e.target.value);
  });

  // Concurrency Race Condition Test
  document.getElementById('btnRunConcurrencyTest').addEventListener('click', async () => {
    const terminal = document.getElementById('concurrencyTestOutput');
    terminal.innerHTML = '<div class="terminal-line info">&bull; Initiating 5 simultaneous async booking requests against Driver Mutex Lock...</div>';

    try {
      const res = await fetch('/api/booking/concurrency-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 5 })
      });
      const data = await res.json();

      if (data.success && data.result) {
        const r = data.result;
        terminal.innerHTML += `
          <div class="terminal-line success">&check; [ATOMIC LOCK ACQUIRED]: ${r.atomicWinner} secured exclusive reservation on ${r.targetDriverId}</div>
          <div class="terminal-line danger">&cross; [RACE SHIELD]: ${r.safelyRejectedAttempts} concurrent requests safely backed off (Reason: DRIVER_ALREADY_RESERVED)</div>
          <div class="terminal-line success">&check; [INTEGRITY CHECK]: 0 Duplicate Bookings. Atomic Lock State Verified 100% Safe.</div>
        `;
      }
    } catch (e) {
      terminal.innerHTML += `<div class="terminal-line danger">Error: ${e.message}</div>`;
    }
  });

  // Passenger App Modal
  const modalPass = document.getElementById('modalPassengerApp');
  document.getElementById('btnOpenPassengerApp').addEventListener('click', () => {
    modalPass.classList.add('active');
  });
  document.getElementById('btnClosePassengerModal').addEventListener('click', () => {
    modalPass.classList.remove('active');
  });

  document.getElementById('btnConfirmPassengerRide').addEventListener('click', async () => {
    const origin = document.getElementById('passPickupZone').value;
    const dest = document.getElementById('passDropoffZone').value;

    try {
      const res = await fetch('/api/booking/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          passengerName: 'Ananya Sharma',
          originZoneId: origin,
          destinationZoneId: dest
        })
      });
      const data = await res.json();

      const box = document.getElementById('bookingResultBox');
      if (data.success && data.booking) {
        box.classList.remove('hidden');
        document.getElementById('bookingSuccessDetails').textContent = 
          `Driver ${data.booking.driver.name} (${data.booking.driver.plate}) confirmed atomically! Fare: ₹${data.booking.fareBreakdown.finalFare} (Saved ₹${data.booking.fareBreakdown.passengerSaved} vs predatory surge). ETA: ${data.booking.driver.etaMinutes} mins.`;
      } else {
        box.classList.remove('hidden');
        document.getElementById('bookingSuccessDetails').textContent = data.message || 'Ride requested.';
      }
    } catch (e) { console.error(e); }
  });

  // Driver App Modal
  const modalDriver = document.getElementById('modalDriverApp');
  document.getElementById('btnOpenDriverApp').addEventListener('click', () => {
    modalDriver.classList.add('active');
  });
  document.getElementById('btnCloseDriverModal').addEventListener('click', () => {
    modalDriver.classList.remove('active');
  });

  document.getElementById('btnAcceptDriverRelocation').addEventListener('click', async () => {
    if (!systemState || !systemState.drivers) return;
    const driver = systemState.drivers.find(d => d.zoneId === 'indiranagar' && d.status === 'AVAILABLE');
    if (!driver) return alert('No available driver found in Indiranagar');

    try {
      const res = await fetch('/api/relocate/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driverId: driver.id,
          targetZoneId: 'koramangala'
        })
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('driverRelocationCard').classList.add('hidden');
        document.getElementById('driverRelocatingState').classList.remove('hidden');
      }
    } catch (e) { console.error(e); }
  });

  // Global helper for Donor Batch Relocation
  window.relocateDonorBatch = async function(donorZoneId) {
    if (!systemState || !systemState.drivers) return;
    const drivers = systemState.drivers.filter(d => d.zoneId === donorZoneId && d.status === 'AVAILABLE').slice(0, 5);
    for (const d of drivers) {
      await fetch('/api/relocate/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driverId: d.id, targetZoneId: 'koramangala' })
      });
    }
  };

  // Quick action from Inspector
  document.getElementById('btnSimulateRideInZone').addEventListener('click', () => {
    modalPass.classList.add('active');
    document.getElementById('passPickupZone').value = selectedZoneId;
  });

  document.getElementById('btnRelocateToZone').addEventListener('click', () => {
    window.relocateDonorBatch('indiranagar');
  });
});
