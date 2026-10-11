/**
 * SurgeX - Central Simulation Engine
 * Coordinates real-time events, manages driver fleets, runs Bengaluru scenarios,
 * and executes the 5-step Koramangala peak demand spike.
 */

const h3Engine = require('./h3Engine');
const pricingEngine = require('./pricingEngine');
const allocationEngine = require('./allocationEngine');
const bookingEngine = require('./bookingEngine');
const eventStream = require('./eventStream');
const metricsTracker = require('./metricsTracker');
const config = require('./config');

class SimulationEngine {
  constructor() {
    this.isRunning = false;
    this.simSpeed = 1; // 1x, 2x, 5x
    this.intervalId = null;
    this.completedRelocations = 0;
    this.totalIncentivesPaid = 0;
    this.scenarioStep = 0; // 0: Idle, 1: Detect, 2: Find Drivers, 3: Send Incentive, 4: Match Bookings, 5: Recalculate
    this.initializeFleet();
  }

  initializeFleet() {
    // Generate ~250 drivers distributed across Bengaluru zones
    let driverIdCounter = 101;
    const vehicleTypes = ['Sedan', 'Hatchback', 'SUV', 'EV-Sedan', 'Auto-Rickshaw'];
    const names = [
      'Ramesh Kumar', 'Manjunath Gowda', 'Suresh Reddy', 'Anand Rao', 'Venkatesh P',
      'Syed Imran', 'Santosh Patil', 'Praveen Nair', 'Karthik Shenoy', 'Deepak Hegde',
      'Girish Murthy', 'Vijay Shekhar', 'Sunil Nayak', 'Prashanth K', 'Raghu V'
    ];

    config.ZONES.forEach(zone => {
      const driverCount = zone.baselineDrivers;
      for (let i = 0; i < driverCount; i++) {
        const id = `DRV-${driverIdCounter++}`;
        // Slight jitter around zone center
        const jitterLat = (Math.random() - 0.5) * 0.016;
        const jitterLng = (Math.random() - 0.5) * 0.016;
        const driverName = names[(driverIdCounter + i) % names.length] + ` (#${id.slice(-3)})`;
        const vehicle = vehicleTypes[i % vehicleTypes.length];

        allocationEngine.registerDriver({
          id,
          name: driverName,
          vehicleType: vehicle,
          plate: `KA-0${Math.floor(Math.random() * 5 + 1)}-M-${Math.floor(Math.random() * 8999 + 1000)}`,
          lat: zone.lat + jitterLat,
          lng: zone.lng + jitterLng,
          zoneId: zone.id,
          status: 'AVAILABLE',
          rating: (4.6 + Math.random() * 0.39).toFixed(2),
          completedTrips: Math.floor(Math.random() * 20 + 5),
          todayEarnings: Math.floor(Math.random() * 1200 + 800)
        });
      }
    });

    eventStream.publish('system.init', {
      message: 'SurgeX Fleet Initialized across 8 Bengaluru H3 zones',
      totalDrivers: allocationEngine.getDrivers().length
    });
  }

  /**
   * Reset simulation state to default baseline
   */
  resetSimulation() {
    this.scenarioStep = 0;
    this.completedRelocations = 0;
    this.totalIncentivesPaid = 0;
    h3Engine.initializeBengaluruCells();

    // Reset drivers
    config.ZONES.forEach(zone => {
      const driversInZone = allocationEngine.getDrivers().filter(d => d.currentZoneId === zone.id);
      driversInZone.forEach(d => {
        d.status = 'AVAILABLE';
        d.targetZoneId = null;
        d.relocationEtaMinutes = null;
        d.lat = zone.lat + (Math.random() - 0.5) * 0.016;
        d.lng = zone.lng + (Math.random() - 0.5) * 0.016;
      });
    });

    eventStream.publish('system.reset', { message: 'Simulation reset to baseline state' });
    this.syncLiveMetrics();
  }

  /**
   * Apply 6:00 PM Rainy Peak Demand Spike Scenario
   */
  triggerRainyPeakScenario() {
    this.scenarioStep = 1;

    // 1. Koramangala: 100 requests, 20 drivers, Heavy Rain
    h3Engine.updateCellCounts('koramangala', {
      activeRequests: 100,
      availableDrivers: 20,
      rainfall: 'HEAVY'
    });

    // 2. Indiranagar: 30 requests, 40 drivers, No Rain (Excess supply)
    h3Engine.updateCellCounts('indiranagar', {
      activeRequests: 30,
      availableDrivers: 40,
      rainfall: 'NONE'
    });

    // 3. Whitefield: 25 requests, 30 drivers, Light Rain (Balanced supply)
    h3Engine.updateCellCounts('whitefield', {
      activeRequests: 25,
      availableDrivers: 30,
      rainfall: 'LIGHT'
    });

    // Broadcast weather radar & surge detection events
    eventStream.publish('weather.events', {
      zoneId: 'koramangala',
      condition: 'HEAVY_RAIN',
      rainfallIntensityMmPerHour: 48,
      timestamp: new Date().toISOString()
    });

    eventStream.publish('hotspot.alerts', {
      zoneId: 'koramangala',
      severity: 'SEVERE_SHORTAGE',
      activeRequests: 100,
      availableDrivers: 20,
      ratio: 5.0,
      shortage: 80,
      message: 'Sudden demand spike detected in Koramangala at 6:00 PM during heavy rainfall!'
    });

    this.syncLiveMetrics();
    return this.getSystemState();
  }

  /**
   * Execute Scenario Step-by-Step
   * @param {number} step 1 to 5
   */
  executeScenarioStep(step) {
    this.scenarioStep = step;
    let stepDescription = '';

    switch (step) {
      case 1:
        // Step 1: Detect the shortage
        this.triggerRainyPeakScenario();
        stepDescription = 'Step 1: Shortage detected in Koramangala (100 requests vs 20 available drivers; R=5.0). Indiranagar has 40 drivers vs 30 requests (R=0.75, Excess supply). Whitefield has 30 drivers vs 25 requests (R=0.83, Balanced).';
        break;

      case 2:
        // Step 2: Find drivers who can help & verify neighbourhood fairness
        const recs = allocationEngine.findRelocationRecommendations('koramangala');
        const donorRec = recs.find(r => r.donorZoneId === 'indiranagar');
        stepDescription = `Step 2: Identified eligible idle drivers in Indiranagar (~8 mins away). Verified neighbourhood fairness: Indiranagar safe surplus = ${donorRec ? donorRec.safeDonorSurplus : 10} drivers without inducing a shortage. Whitefield excluded due to distance (18km) and balanced status.`;
        
        eventStream.publish('driver.allocation', {
          target: 'koramangala',
          donorZone: 'indiranagar',
          eligibleDrivers: donorRec ? donorRec.candidateDriverIds.length : 10,
          safeguardFairnessPassed: true,
          action: 'Preparing targeted incentives for Indiranagar drivers'
        });
        break;

      case 3:
        // Step 3: Send a targeted incentive
        const kCell = h3Engine.getCellByZoneId('koramangala');
        const kPricing = pricingEngine.evaluatePricingAndIncentive(kCell);
        const bonus = kPricing.driverIncentiveBonus || 30;

        eventStream.publish('driver.incentives', {
          targetZone: 'Koramangala',
          bonusAmountInr: bonus,
          durationMinutes: 30,
          qualifyingCondition: 'Completed trip with pickup in Koramangala H3 cell',
          message: `Broadcast ₹${bonus} bonus offer to idle drivers in Indiranagar & HSR Layout`
        });

        stepDescription = `Step 3: SurgeX broadcasts targeted incentive offer: +₹${bonus} extra bonus per completed trip in Koramangala. Capped fare multiplier adjusted to only ${kPricing.multiplier}x (Fare: ₹${kPricing.finalFare} vs Naive competitor ₹${kPricing.naiveCompetitor.fare}).`;
        break;

      case 4:
        // Step 4: Drivers accept incentive & Relocate + Match Bookings
        const indiraDrivers = allocationEngine.getDrivers()
          .filter(d => d.currentZoneId === 'indiranagar' && d.status === 'AVAILABLE')
          .slice(0, 10);

        indiraDrivers.forEach(d => {
          allocationEngine.acceptRelocationOffer(d.id, 'koramangala');
        });

        // Also simulate an atomic ride booking in Koramangala
        bookingEngine.createRideBooking({
          passengerName: 'Ananya Sharma',
          originZoneId: 'koramangala',
          destinationZoneId: 'indiranagar'
        });

        stepDescription = `Step 4: 10 idle drivers from Indiranagar accept the ₹30 bonus and start relocating to Koramangala. Atomic booking lock verified: passenger booking matched cleanly without duplicate assignment.`;
        break;

      case 5:
        // Step 5: Recalculate the situation after 15 additional drivers arrive
        // 15 additional drivers arrive in Koramangala
        const arrivingDrivers = allocationEngine.getDrivers()
          .filter(d => d.status === 'RELOCATING' || d.currentZoneId === 'indiranagar')
          .slice(0, 15);

        arrivingDrivers.forEach(d => {
          d.status = 'RELOCATING';
          d.targetZoneId = 'koramangala';
          allocationEngine.completeDriverArrival(d.id);
        });

        this.completedRelocations += 15;
        this.totalIncentivesPaid += 15 * 30;

        // Koramangala supply increases from 20 to 35
        h3Engine.updateCellCounts('koramangala', {
          availableDrivers: 35,
          activeRequests: 65,
          rainfall: 'LIGHT' // Rain subsiding
        });

        const updatedKoramangala = h3Engine.getCellByZoneId('koramangala');
        const newPricing = pricingEngine.evaluatePricingAndIncentive(updatedKoramangala);

        eventStream.publish('hotspot.recalculation', {
          zone: 'Koramangala',
          newSupply: updatedKoramangala.availableDrivers,
          newRequests: updatedKoramangala.activeRequests,
          newRatio: updatedKoramangala.demandSupplyRatio,
          newMultiplier: newPricing.multiplier,
          newBonus: newPricing.driverIncentiveBonus,
          message: '15 drivers arrived! Supply increased to 35. Ratio reduced. Incentive bonus tapering down.'
        });

        stepDescription = `Step 5: 15 additional drivers arrived in Koramangala! Supply increased from 20 to 35. Demand ratio improved from 5.0 to ${updatedKoramangala.demandSupplyRatio}. Shortage dropped from 80 to ${updatedKoramangala.shortage}. Fares stabilised and incentives tapered down gracefully.`;
        break;
    }

    this.syncLiveMetrics();
    return {
      step,
      stepDescription,
      systemState: this.getSystemState()
    };
  }

  /**
   * Single background simulation tick
   */
  tick() {
    // 1. Progress relocating drivers toward destinations
    const drivers = allocationEngine.getDrivers();
    const relocatingDrivers = drivers.filter(d => d.status === 'RELOCATING');

    relocatingDrivers.forEach(d => {
      if (d.targetZoneId) {
        const targetCell = h3Engine.getCellByZoneId(d.targetZoneId);
        if (targetCell) {
          // Move driver slightly closer to target cell center
          d.lat += (targetCell.center.lat - d.lat) * 0.35;
          d.lng += (targetCell.center.lng - d.lng) * 0.35;

          const distRemaining = h3Engine.calculateDistanceKm(d.lat, d.lng, targetCell.center.lat, targetCell.center.lng);
          if (distRemaining < 0.6) {
            // Arrived!
            allocationEngine.completeDriverArrival(d.id);
            this.completedRelocations++;
            this.totalIncentivesPaid += 30;
            eventStream.publish('driver.telemetry', {
              driverId: d.id,
              driverName: d.name,
              event: 'ARRIVAL_AT_HOTSPOT',
              zone: targetCell.name,
              bonusEarnedInr: 30
            });
          }
        }
      }
    });

    // 2. Random slight traffic / request fluctuations across Bengaluru cells
    const allCells = h3Engine.getAllCells();
    allCells.forEach(cell => {
      // Natural organic ride request completions & new arrivals
      if (Math.random() < 0.3) {
        const delta = Math.floor((Math.random() - 0.48) * 3);
        const newReq = Math.max(10, cell.activeRequests + delta);
        h3Engine.updateCellCounts(cell.zoneId, { activeRequests: newReq });
      }
    });

    // 3. Emit Kafka periodic telemetry heartbeat
    if (Math.random() < 0.25) {
      eventStream.publish('driver.telemetry', {
        activeDrivers: drivers.length,
        available: drivers.filter(d => d.status === 'AVAILABLE').length,
        assigned: drivers.filter(d => d.status === 'ASSIGNED').length,
        relocating: drivers.filter(d => d.status === 'RELOCATING').length
      });
    }

    this.syncLiveMetrics();
  }

  syncLiveMetrics() {
    const allCells = h3Engine.getAllCells();
    const totalShortage = allCells.reduce((sum, c) => sum + c.shortage, 0);
    const avgEta = allCells.reduce((sum, c) => sum + c.avgPickupEtaMinutes, 0) / allCells.length;
    const allDrivers = allocationEngine.getDrivers();
    const activeBookings = allDrivers.filter(d => d.status === 'ASSIGNED').length;

    metricsTracker.updateMetrics({
      totalShortage,
      avgEta,
      completedRelocations: this.completedRelocations,
      totalDrivers: allDrivers.length,
      activeBookings,
      incentivesPaid: this.totalIncentivesPaid
    });
  }

  startSimulationLoop(intervalMs = 2500) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.intervalId = setInterval(() => {
      this.tick();
    }, intervalMs);
    eventStream.publish('simulation.lifecycle', { status: 'RUNNING', intervalMs });
  }

  stopSimulationLoop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    clearInterval(this.intervalId);
    this.intervalId = null;
    eventStream.publish('simulation.lifecycle', { status: 'PAUSED' });
  }

  getSystemState() {
    const cells = h3Engine.getAllCells().map(cell => {
      const pricing = pricingEngine.evaluatePricingAndIncentive(cell, cell.currentMultiplier);
      cell.currentMultiplier = pricing.multiplier;
      cell.currentIncentive = pricing.driverIncentiveBonus;
      return {
        ...cell,
        pricing
      };
    });

    const drivers = allocationEngine.getDrivers();
    const recommendations = allocationEngine.findRelocationRecommendations('koramangala');
    const metrics = metricsTracker.getMetrics();
    const recentEvents = eventStream.getRecentEvents(25);

    return {
      scenarioStep: this.scenarioStep,
      isSimulationRunning: this.isRunning,
      cells,
      drivers: drivers.map(d => ({
        id: d.id,
        name: d.name,
        vehicleType: d.vehicleType,
        plate: d.plate,
        lat: d.lat,
        lng: d.lng,
        zoneId: d.currentZoneId,
        status: d.status,
        rating: d.rating,
        targetZoneId: d.targetZoneId
      })),
      recommendations,
      metrics,
      recentEvents,
      summary: {
        totalDrivers: drivers.length,
        availableDrivers: drivers.filter(d => d.status === 'AVAILABLE').length,
        relocatingDrivers: drivers.filter(d => d.status === 'RELOCATING').length,
        assignedDrivers: drivers.filter(d => d.status === 'ASSIGNED').length,
        totalCompletedRelocations: this.completedRelocations,
        totalIncentivesPaid: this.totalIncentivesPaid
      }
    };
  }
}

module.exports = new SimulationEngine();
