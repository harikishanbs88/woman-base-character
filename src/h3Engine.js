/**
 * SurgeX - Module 2: H3 Hotspot Detection Engine
 * Divides Bengaluru into H3 hexagonal cells and computes geospatial demand/supply metrics.
 */

const h3 = require('h3-js');
const config = require('./config');

class H3Engine {
  constructor() {
    this.resolution = config.H3_RESOLUTION;
    this.cells = new Map();
    this.initializeBengaluruCells();
  }

  initializeBengaluruCells() {
    config.ZONES.forEach(zone => {
      const h3Index = h3.latLngToCell(zone.lat, zone.lng, this.resolution);
      const boundary = h3.cellToBoundary(h3Index); // Array of [lat, lng] pairs

      this.cells.set(h3Index, {
        h3Index,
        zoneId: zone.id,
        name: zone.name,
        center: { lat: zone.lat, lng: zone.lng },
        boundary,
        description: zone.description,
        rainfall: zone.rainfall,
        // Dynamic operational state
        activeRequests: zone.baselineRequests,
        availableDrivers: zone.baselineDrivers,
        occupiedDrivers: 15,
        relocatingDrivers: 0,
        demandSupplyRatio: (zone.baselineRequests / Math.max(1, zone.baselineDrivers)),
        shortage: Math.max(0, zone.baselineRequests - zone.baselineDrivers),
        status: 'BALANCED_SUPPLY',
        currentMultiplier: 1.0,
        currentIncentive: 0,
        avgPickupEtaMinutes: 4.0,
        lastUpdated: Date.now()
      });
    });

    this.recomputeAllMetrics();
  }

  getAllCells() {
    return Array.from(this.cells.values());
  }

  getCell(h3Index) {
    return this.cells.get(h3Index);
  }

  getCellByZoneId(zoneId) {
    for (const cell of this.cells.values()) {
      if (cell.zoneId === zoneId) return cell;
    }
    return null;
  }

  findCellForLocation(lat, lng) {
    const h3Index = h3.latLngToCell(lat, lng, this.resolution);
    return this.cells.get(h3Index) || null;
  }

  /**
   * Calculate distance between two lat/lng coordinates in km (Haversine)
   */
  calculateDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  /**
   * Estimate driving travel time in minutes considering Bengaluru road factors & rainfall
   */
  estimateDriveTimeMinutes(originLat, originLng, destLat, destLng, weatherRain = false) {
    const distKm = this.calculateDistanceKm(originLat, originLng, destLat, destLng);
    // Average Bengaluru urban speed: ~18-20 km/h, reduced to 12 km/h in rain/congestion
    const avgSpeedKmH = weatherRain ? 13 : 20;
    const timeMinutes = (distKm / avgSpeedKmH) * 60;
    return Math.max(3, Math.round(timeMinutes * 10) / 10);
  }

  /**
   * Compute Demand, Supply, Ratio, Shortage, and Status for a single cell
   */
  computeCellMetrics(cell) {
    const requests = cell.activeRequests || 0;
    const drivers = Math.max(1, cell.availableDrivers || 0);
    const ratio = requests / drivers;
    const shortage = Math.max(0, requests - cell.availableDrivers);

    // Weather impact on pickup delays
    let weatherPenaltyMinutes = 0;
    if (cell.rainfall === 'HEAVY') weatherPenaltyMinutes = 4.5;
    else if (cell.rainfall === 'MODERATE') weatherPenaltyMinutes = 2.0;
    else if (cell.rainfall === 'LIGHT') weatherPenaltyMinutes = 1.0;

    // ETA calculation based on ratio and traffic
    const baseEta = 3.5;
    const congestionFactor = Math.min(10, Math.max(0, (ratio - 1.0) * 2.2));
    const etaMinutes = Math.round((baseEta + congestionFactor + weatherPenaltyMinutes) * 10) / 10;

    // Severity classification
    let status = 'BALANCED_SUPPLY';
    if (ratio >= 2.5 || shortage >= 35) {
      status = 'SEVERE_SHORTAGE';
    } else if (ratio >= 1.35 || shortage >= 12) {
      status = 'MODERATE_SHORTAGE';
    } else if (ratio < 0.85) {
      status = 'EXCESS_SUPPLY';
    } else {
      status = 'BALANCED_SUPPLY';
    }

    cell.demandSupplyRatio = Math.round(ratio * 100) / 100;
    cell.shortage = shortage;
    cell.status = status;
    cell.avgPickupEtaMinutes = etaMinutes;
    cell.lastUpdated = Date.now();

    return cell;
  }

  recomputeAllMetrics() {
    for (const cell of this.cells.values()) {
      this.computeCellMetrics(cell);
    }
  }

  updateCellCounts(zoneId, updates) {
    const cell = this.getCellByZoneId(zoneId);
    if (!cell) return null;

    if (updates.activeRequests !== undefined) cell.activeRequests = updates.activeRequests;
    if (updates.availableDrivers !== undefined) cell.availableDrivers = updates.availableDrivers;
    if (updates.rainfall !== undefined) cell.rainfall = updates.rainfall;
    if (updates.relocatingDrivers !== undefined) cell.relocatingDrivers = updates.relocatingDrivers;

    this.computeCellMetrics(cell);
    return cell;
  }
}

module.exports = new H3Engine();
