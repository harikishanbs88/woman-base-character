/**
 * SurgeX - Module 4: Smart Driver Allocation & Repositioning Engine
 * Evaluates candidate donor zones, checks neighborhood supply safety,
 * generates targeted relocation offers, and matches rides.
 */

const h3Engine = require('./h3Engine');
const pricingEngine = require('./pricingEngine');

class AllocationEngine {
  constructor() {
    this.drivers = new Map(); // id -> driver object
    this.activeOffers = new Map(); // driverId -> offer object
  }

  registerDriver(driver) {
    this.drivers.set(driver.id, {
      id: driver.id,
      name: driver.name,
      vehicleType: driver.vehicleType || 'Sedan',
      plate: driver.plate || 'KA-01-AB-1234',
      lat: driver.lat,
      lng: driver.lng,
      currentZoneId: driver.zoneId,
      status: driver.status || 'AVAILABLE', // AVAILABLE, RESERVED, ASSIGNED, RELOCATING, ON_TRIP
      rating: driver.rating || 4.85,
      completedTrips: driver.completedTrips || 12,
      todayEarnings: driver.todayEarnings || 1450,
      activeReservationId: null,
      targetZoneId: null,
      relocationEtaMinutes: null
    });
  }

  getDrivers() {
    return Array.from(this.drivers.values());
  }

  getDriver(id) {
    return this.drivers.get(id);
  }

  /**
   * Evaluate relocation candidates for a shortage hotspot zone
   * @param {string} hotspotZoneId Target zone experiencing shortage (e.g., 'koramangala')
   */
  findRelocationRecommendations(hotspotZoneId) {
    const targetCell = h3Engine.getCellByZoneId(hotspotZoneId);
    if (!targetCell) return [];

    const targetPricing = pricingEngine.evaluatePricingAndIncentive(targetCell);
    const recommendations = [];
    const allCells = h3Engine.getAllCells();

    // Loop through other cells to find viable donor zones
    for (const donorCell of allCells) {
      if (donorCell.zoneId === hotspotZoneId) continue;

      const distKm = h3Engine.calculateDistanceKm(
        donorCell.center.lat, donorCell.center.lng,
        targetCell.center.lat, targetCell.center.lng
      );

      // Disqualify zones that are too distant (> 12 km, e.g. Whitefield to Koramangala is ~18km)
      if (distKm > 11.0) {
        continue;
      }

      const travelTimeMinutes = h3Engine.estimateDriveTimeMinutes(
        donorCell.center.lat, donorCell.center.lng,
        targetCell.center.lat, targetCell.center.lng,
        targetCell.rainfall === 'HEAVY'
      );

      // NEIGHBOURHOOD FAIRNESS SAFETY CHECK:
      // Can donorCell afford to spare idle drivers without dropping below R > 1.15?
      const currentSupply = donorCell.availableDrivers;
      const currentDemand = donorCell.activeRequests;
      const minSafeSupply = Math.ceil(currentDemand * 0.95);
      const safeDonorSurplus = Math.max(0, currentSupply - minSafeSupply);

      // If donor cell has safe surplus (e.g., Indiranagar: 40 drivers, 30 req -> safeDonorSurplus = 10)
      const isFairToRelocate = safeDonorSurplus > 0 && donorCell.status === 'EXCESS_SUPPLY';

      // Find available idle drivers in this donor cell
      const idleDriversInCell = Array.from(this.drivers.values()).filter(
        d => d.currentZoneId === donorCell.zoneId && d.status === 'AVAILABLE'
      );

      recommendations.push({
        donorZoneId: donorCell.zoneId,
        donorZoneName: donorCell.name,
        targetZoneId: targetCell.zoneId,
        targetZoneName: targetCell.name,
        distanceKm: Math.round(distKm * 10) / 10,
        estimatedTravelMinutes: travelTimeMinutes,
        donorStatus: donorCell.status,
        donorSupply: currentSupply,
        donorDemand: currentDemand,
        safeDonorSurplus,
        isFairToRelocate,
        bonusOffered: targetPricing.driverIncentiveBonus,
        eligibleDriverCount: idleDriversInCell.length,
        candidateDriverIds: idleDriversInCell.slice(0, safeDonorSurplus).map(d => d.id)
      });
    }

    return recommendations.sort((a, b) => a.estimatedTravelMinutes - b.estimatedTravelMinutes);
  }

  /**
   * Driver accepts relocation offer
   */
  acceptRelocationOffer(driverId, targetZoneId) {
    const driver = this.drivers.get(driverId);
    const targetCell = h3Engine.getCellByZoneId(targetZoneId);
    if (!driver || !targetCell) {
      return { success: false, message: 'Driver or target zone not found' };
    }

    if (driver.status !== 'AVAILABLE') {
      return { success: false, message: `Driver is currently ${driver.status}` };
    }

    const currentCell = h3Engine.getCellByZoneId(driver.currentZoneId);
    const travelTime = h3Engine.estimateDriveTimeMinutes(
      driver.lat, driver.lng,
      targetCell.center.lat, targetCell.center.lng,
      targetCell.rainfall === 'HEAVY'
    );

    // Update driver status
    driver.status = 'RELOCATING';
    driver.targetZoneId = targetZoneId;
    driver.relocationEtaMinutes = travelTime;

    // Deduct from current zone available drivers
    if (currentCell) {
      h3Engine.updateCellCounts(currentCell.zoneId, {
        availableDrivers: Math.max(0, currentCell.availableDrivers - 1)
      });
    }

    // Add to target zone relocating count
    h3Engine.updateCellCounts(targetZoneId, {
      relocatingDrivers: (targetCell.relocatingDrivers || 0) + 1
    });

    return {
      success: true,
      driverId: driver.id,
      driverName: driver.name,
      originZone: currentCell ? currentCell.name : 'Unknown',
      destinationZone: targetCell.name,
      bonus: pricingEngine.evaluatePricingAndIncentive(targetCell).driverIncentiveBonus,
      etaMinutes: travelTime
    };
  }

  /**
   * Complete driver arrival in target zone
   */
  completeDriverArrival(driverId) {
    const driver = this.drivers.get(driverId);
    if (!driver || driver.status !== 'RELOCATING' || !driver.targetZoneId) return null;

    const targetCell = h3Engine.getCellByZoneId(driver.targetZoneId);
    if (targetCell) {
      // Driver arrives and is now AVAILABLE in the new zone!
      driver.currentZoneId = targetCell.zoneId;
      driver.lat = targetCell.center.lat + (Math.random() - 0.5) * 0.01;
      driver.lng = targetCell.center.lng + (Math.random() - 0.5) * 0.01;
      driver.status = 'AVAILABLE';
      driver.targetZoneId = null;
      driver.relocationEtaMinutes = null;

      // Update cell counts
      h3Engine.updateCellCounts(targetCell.zoneId, {
        availableDrivers: targetCell.availableDrivers + 1,
        relocatingDrivers: Math.max(0, (targetCell.relocatingDrivers || 1) - 1)
      });

      return {
        success: true,
        driverId: driver.id,
        newZone: targetCell.name,
        availableSupply: targetCell.availableDrivers
      };
    }
    return null;
  }
}

module.exports = new AllocationEngine();
