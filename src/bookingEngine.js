/**
 * SurgeX - Module 5: Safe Booking Engine with Atomic Reservation Lock
 * Prevents double-booking / race conditions when matching drivers to ride requests.
 */

const allocationEngine = require('./allocationEngine');
const h3Engine = require('./h3Engine');
const pricingEngine = require('./pricingEngine');

class BookingEngine {
  constructor() {
    this.bookings = new Map(); // bookingId -> booking details
    this.reservationLocks = new Map(); // driverId -> { reservationId, expiresAt }
    this.lockTimeoutMs = 15000; // 15 seconds reservation lock timeout
    this.counter = 1000;
  }

  generateBookingId() {
    this.counter++;
    return `BK-${Date.now().toString().slice(-4)}-${this.counter}`;
  }

  /**
   * Atomic driver reservation test & lock acquisition
   * Uses an atomic mutex lock pattern to guarantee that even if multiple async requests
   * compete for the same driver at the same millisecond, only ONE succeeds.
   */
  async acquireDriverLock(driverId, bookingId) {
    const now = Date.now();
    const existingLock = this.reservationLocks.get(driverId);

    // If locked and lock hasn't expired, reject immediately
    if (existingLock && existingLock.expiresAt > now) {
      return { success: false, reason: 'DRIVER_ALREADY_RESERVED' };
    }

    const driver = allocationEngine.getDriver(driverId);
    if (!driver || driver.status !== 'AVAILABLE') {
      return { success: false, reason: 'DRIVER_NOT_AVAILABLE' };
    }

    // Atomically claim lock and update status
    this.reservationLocks.set(driverId, {
      bookingId,
      expiresAt: now + this.lockTimeoutMs
    });
    driver.status = 'RESERVED';
    driver.activeReservationId = bookingId;

    return { success: true, lock: this.reservationLocks.get(driverId) };
  }

  /**
   * Release driver reservation lock
   */
  releaseDriverLock(driverId) {
    this.reservationLocks.delete(driverId);
    const driver = allocationEngine.getDriver(driverId);
    if (driver && driver.status === 'RESERVED') {
      driver.status = 'AVAILABLE';
      driver.activeReservationId = null;
    }
  }

  /**
   * Request and match a ride with atomic safety
   */
  async createRideBooking(request) {
    const {
      passengerName,
      originZoneId,
      destinationZoneId,
      vehicleType = 'Any',
      passengerLat,
      passengerLng
    } = request;

    const originCell = h3Engine.getCellByZoneId(originZoneId);
    if (!originCell) {
      return { success: false, error: 'Invalid origin zone' };
    }

    const bookingId = this.generateBookingId();
    const pricing = pricingEngine.evaluatePricingAndIncentive(originCell);

    // Find nearby available drivers sorted by distance/ETA
    const allDrivers = allocationEngine.getDrivers();
    const candidateDrivers = allDrivers
      .filter(d => (d.currentZoneId === originZoneId || d.status === 'AVAILABLE') && d.status === 'AVAILABLE')
      .map(d => {
        const distKm = h3Engine.calculateDistanceKm(
          passengerLat || originCell.center.lat,
          passengerLng || originCell.center.lng,
          d.lat, d.lng
        );
        const etaMinutes = h3Engine.estimateDriveTimeMinutes(
          d.lat, d.lng,
          passengerLat || originCell.center.lat,
          passengerLng || originCell.center.lng,
          originCell.rainfall === 'HEAVY'
        );
        return { driver: d, distKm, etaMinutes };
      })
      .sort((a, b) => a.etaMinutes - b.etaMinutes);

    if (candidateDrivers.length === 0) {
      return {
        success: false,
        bookingId,
        status: 'NO_DRIVERS_AVAILABLE',
        fare: pricing.finalFare,
        message: 'No available drivers found in the vicinity. SurgeX is actively relocating drivers to this zone.'
      };
    }

    // Attempt atomic lock on the closest driver; if race condition occurred, try next closest
    let matchedCandidate = null;
    for (const candidate of candidateDrivers) {
      const lockResult = await this.acquireDriverLock(candidate.driver.id, bookingId);
      if (lockResult.success) {
        matchedCandidate = candidate;
        break;
      }
    }

    if (!matchedCandidate) {
      return {
        success: false,
        bookingId,
        status: 'LOCK_CONTENTION',
        message: 'Candidate drivers were claimed by concurrent bookings. Please retry momentarily.'
      };
    }

    // Finalize assignment
    const assignedDriver = matchedCandidate.driver;
    assignedDriver.status = 'ASSIGNED';
    this.reservationLocks.delete(assignedDriver.id); // clear temp lock, driver is formally ASSIGNED

    // Decrement available drivers in origin cell
    h3Engine.updateCellCounts(originZoneId, {
      availableDrivers: Math.max(0, originCell.availableDrivers - 1),
      activeRequests: Math.max(0, originCell.activeRequests - 1)
    });

    const bookingRecord = {
      bookingId,
      passengerName: passengerName || 'Harish Kumar',
      originZoneId,
      originZoneName: originCell.name,
      destinationZoneId: destinationZoneId || 'mg_road',
      status: 'CONFIRMED',
      fareBreakdown: {
        baseFare: pricing.baseFare,
        multiplier: pricing.multiplier,
        finalFare: pricing.finalFare,
        driverIncentivePaid: pricing.driverIncentiveBonus,
        naiveUncappedCompetitorFare: pricing.naiveCompetitor.fare,
        passengerSaved: pricing.naiveCompetitor.passengerSaved
      },
      driver: {
        id: assignedDriver.id,
        name: assignedDriver.name,
        vehicleType: assignedDriver.vehicleType,
        plate: assignedDriver.plate,
        rating: assignedDriver.rating,
        etaMinutes: matchedCandidate.etaMinutes
      },
      createdAt: new Date().toISOString()
    };

    this.bookings.set(bookingId, bookingRecord);
    return { success: true, booking: bookingRecord };
  }

  /**
   * Concurrency Test: Simulate N simultaneous bookings hitting the exact same single driver
   */
  async simulateConcurrentRaceCondition(driverId, concurrentCount = 5) {
    const driver = allocationEngine.getDriver(driverId);
    if (!driver) return { error: 'Driver not found' };

    // Reset driver to available for clean test
    driver.status = 'AVAILABLE';
    this.reservationLocks.delete(driverId);

    const attempts = [];
    for (let i = 1; i <= concurrentCount; i++) {
      attempts.push({
        bookingAttemptId: `RACE-REQ-${i}`,
        timestamp: Date.now()
      });
    }

    // Execute all lock attempts simultaneously using Promise.all
    const results = await Promise.all(
      attempts.map(async (att) => {
        const lock = await this.acquireDriverLock(driverId, att.bookingAttemptId);
        return {
          attemptId: att.bookingAttemptId,
          acquired: lock.success,
          reason: lock.reason || 'LOCK_ACQUIRED_SUCCESSFULLY'
        };
      })
    );

    const winner = results.find(r => r.acquired);
    const losers = results.filter(r => !r.acquired);

    // Release lock test cleanup
    this.releaseDriverLock(driverId);

    return {
      targetDriverId: driverId,
      totalConcurrentAttempts: concurrentCount,
      atomicWinner: winner ? winner.attemptId : 'None',
      safelyRejectedAttempts: losers.length,
      isAtomicSafe: results.filter(r => r.acquired).length === 1,
      results
    };
  }
}

module.exports = new BookingEngine();
