/**
 * SurgeX - Node.js Express & WebSocket API Server
 */

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const simulator = require('./simulator');
const h3Engine = require('./h3Engine');
const allocationEngine = require('./allocationEngine');
const bookingEngine = require('./bookingEngine');
const eventStream = require('./eventStream');
const metricsTracker = require('./metricsTracker');
const config = require('./config');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Broadcast system state to all connected WebSocket clients
function broadcastState() {
  if (wss.clients.size === 0) return;
  const stateData = JSON.stringify({
    type: 'STATE_UPDATE',
    payload: simulator.getSystemState()
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(stateData);
    }
  });
}

// Broadcast new Kafka events immediately
eventStream.on('event', (evt) => {
  if (wss.clients.size === 0) return;
  const eventMsg = JSON.stringify({
    type: 'EVENT_STREAM',
    payload: evt
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(eventMsg);
    }
  });
});

// Periodic broadcast every 1.5 seconds when active
setInterval(() => {
  broadcastState();
}, 1500);

// --- REST API ENDPOINTS ---

app.get('/api/state', (req, res) => {
  res.json({ success: true, data: simulator.getSystemState() });
});

app.post('/api/scenario/step', (req, res) => {
  const step = parseInt(req.body.step, 10) || 1;
  const result = simulator.executeScenarioStep(step);
  broadcastState();
  res.json({ success: true, ...result });
});

app.post('/api/scenario/trigger-peak', (req, res) => {
  const state = simulator.triggerRainyPeakScenario();
  broadcastState();
  res.json({ success: true, message: '6:00 PM Rainy Peak Demand Triggered in Koramangala', state });
});

app.post('/api/scenario/reset', (req, res) => {
  simulator.resetSimulation();
  broadcastState();
  res.json({ success: true, message: 'Simulation reset to baseline' });
});

app.post('/api/simulation/toggle', (req, res) => {
  if (simulator.isRunning) {
    simulator.stopSimulationLoop();
  } else {
    simulator.startSimulationLoop();
  }
  broadcastState();
  res.json({ success: true, isRunning: simulator.isRunning });
});

app.post('/api/relocate/accept', (req, res) => {
  const { driverId, targetZoneId } = req.body;
  const result = allocationEngine.acceptRelocationOffer(driverId, targetZoneId);
  if (result.success) {
    eventStream.publish('driver.relocations', {
      driverId,
      targetZoneId,
      bonus: result.bonus,
      etaMinutes: result.etaMinutes
    });
    simulator.syncLiveMetrics();
    broadcastState();
  }
  res.json(result);
});

app.post('/api/booking/create', async (req, res) => {
  const result = await bookingEngine.createRideBooking(req.body);
  if (result.success) {
    eventStream.publish('booking.reservations', {
      bookingId: result.booking.bookingId,
      driverId: result.booking.driver.id,
      zone: result.booking.originZoneName,
      fare: result.booking.fareBreakdown.finalFare
    });
  }
  simulator.syncLiveMetrics();
  broadcastState();
  res.json(result);
});

app.post('/api/booking/concurrency-test', async (req, res) => {
  const { driverId, count = 5 } = req.body;
  const targetId = driverId || (allocationEngine.getDrivers().find(d => d.status === 'AVAILABLE') || {}).id;
  if (!targetId) {
    return res.status(400).json({ error: 'No available driver to test' });
  }

  const result = await bookingEngine.simulateConcurrentRaceCondition(targetId, count);
  eventStream.publish('booking.concurrency_test', {
    driverId: targetId,
    attempts: count,
    winner: result.atomicWinner,
    safeRejected: result.safelyRejectedAttempts
  });
  broadcastState();
  res.json({ success: true, result });
});

app.post('/api/settings/update', (req, res) => {
  const { zoneId, rainfall, activeRequests, availableDrivers } = req.body;
  if (zoneId) {
    h3Engine.updateCellCounts(zoneId, {
      rainfall,
      activeRequests: activeRequests !== undefined ? parseInt(activeRequests, 10) : undefined,
      availableDrivers: availableDrivers !== undefined ? parseInt(availableDrivers, 10) : undefined
    });
  }
  simulator.syncLiveMetrics();
  broadcastState();
  res.json({ success: true, message: 'Settings updated' });
});

app.get('/api/events', (req, res) => {
  const filter = req.query.topic || null;
  res.json({ success: true, events: eventStream.getRecentEvents(40, filter), stats: eventStream.getTopicStats() });
});

// WebSocket Connection Handler
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'STATE_UPDATE',
    payload: simulator.getSystemState()
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG' }));
      }
    } catch (e) {
      console.error('WS parse err', e);
    }
  });
});

const PORT = config.PORT;
server.listen(PORT, () => {
  console.log(`🚀 SurgeX Server running on http://localhost:${PORT}`);
  // Start background simulation loop
  simulator.startSimulationLoop(2500);
});

module.exports = { app, server };
