/**
 * SurgeX - Module 3: Dynamic Pricing and Driver Incentive Engine
 * Calculates fair, capped, smoothed fare multipliers and targeted driver bonuses.
 */

const config = require('./config');

class PricingEngine {
  constructor() {
    this.baseFare = config.BASE_FARE;
    this.maxMultiplier = config.MAX_SURGE_MULTIPLIER;
    this.smoothingAlpha = config.SURGE_SMOOTHING_FACTOR;
    this.tiers = config.INCENTIVE_TIERS;
  }

  /**
   * Calculate fair, capped surge multiplier and driver incentive for an H3 cell
   * @param {Object} cell H3 cell object with ratio, shortage, status, rainfall
   * @param {number} previousMultiplier previously active multiplier for smoothing
   */
  evaluatePricingAndIncentive(cell, previousMultiplier = 1.0) {
    const ratio = cell.demandSupplyRatio;
    const shortage = cell.shortage;
    const status = cell.status;

    let targetMultiplier = 1.0;
    let recommendedBonus = 0;
    let rationale = '';
    let driverAction = 'No intervention needed';

    switch (status) {
      case 'SEVERE_SHORTAGE':
        // Capped logarithmic surge formula to avoid predatory prices:
        // Multiplier = min(MAX, 1.0 + 0.18 * ln(ratio))
        const rawMultiplier = 1.0 + 0.18 * Math.log(Math.max(1, ratio));
        targetMultiplier = Math.min(this.maxMultiplier, Math.max(1.15, rawMultiplier));
        
        // Targeted bonus based on shortage severity
        recommendedBonus = shortage >= 50 ? this.tiers.HIGH : this.tiers.MEDIUM;
        rationale = `Severe shortage (R=${ratio.toFixed(2)}, Shortage=${shortage}). Applying capped local surge to prevent runaway pricing while offering ₹${recommendedBonus} driver incentive.`;
        driverAction = `Broadcast high-priority hotspot alert with ₹${recommendedBonus} bonus per qualifying ride.`;
        break;

      case 'MODERATE_SHORTAGE':
        // Mild adjustment (1.05x - 1.15x)
        targetMultiplier = Math.min(1.20, 1.0 + 0.08 * (ratio - 1.0));
        recommendedBonus = this.tiers.LOW;
        rationale = `Moderate shortage (R=${ratio.toFixed(2)}). Small fare adjustment of ${(targetMultiplier).toFixed(2)}x and ₹${recommendedBonus} incentive to encourage nearby drivers.`;
        driverAction = `Suggest repositioning with ₹${recommendedBonus} bonus incentive.`;
        break;

      case 'EXCESS_SUPPLY':
        // Normal fare, absolutely no surge
        targetMultiplier = 1.0;
        recommendedBonus = 0;
        rationale = `Excess supply (R=${ratio.toFixed(2)}). Normal fare maintained. Recommend idle drivers to reposition to adjacent shortage zones.`;
        driverAction = 'Recommend relocating to neighboring hotspots to maximize driver hourly earnings.';
        break;

      case 'BALANCED_SUPPLY':
      default:
        targetMultiplier = 1.0;
        recommendedBonus = 0;
        rationale = `Balanced supply (R=${ratio.toFixed(2)}). Fares remain at standard ₹${this.baseFare}. Do not draw drivers away unnecessarily.`;
        driverAction = 'Maintain current operations.';
        break;
    }

    // Weather impact consideration (Rain adds slight operational support factor if severe shortage)
    if (cell.rainfall === 'HEAVY' && status === 'SEVERE_SHORTAGE') {
      targetMultiplier = Math.min(this.maxMultiplier, targetMultiplier + 0.05);
    }

    // Apply exponential moving average smoothing to prevent abrupt price jumps
    const smoothedMultiplier = Math.round(
      (this.smoothingAlpha * targetMultiplier + (1 - this.smoothingAlpha) * previousMultiplier) * 100
    ) / 100;

    const finalMultiplier = Math.max(1.0, Math.min(this.maxMultiplier, smoothedMultiplier));
    const finalFare = Math.round(this.baseFare * finalMultiplier);

    // Naive Competitor Uncapped Multiplier (for comparison metrics)
    const naiveMultiplier = status === 'SEVERE_SHORTAGE' 
      ? Math.round(Math.min(4.8, 1.0 + 0.8 * (ratio - 1.0)) * 10) / 10
      : (status === 'MODERATE_SHORTAGE' ? 1.6 : 1.0);
    const naiveFare = Math.round(this.baseFare * naiveMultiplier);

    return {
      zoneId: cell.zoneId,
      name: cell.name,
      baseFare: this.baseFare,
      finalFare,
      multiplier: finalMultiplier,
      targetMultiplier: Math.round(targetMultiplier * 100) / 100,
      driverIncentiveBonus: recommendedBonus,
      rationale,
      driverAction,
      naiveCompetitor: {
        multiplier: naiveMultiplier,
        fare: naiveFare,
        passengerSaved: Math.max(0, naiveFare - finalFare)
      }
    };
  }
}

module.exports = new PricingEngine();
