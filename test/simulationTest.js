/**
 * SurgeX - Automated Validation Test Suite
 */

const assert = require('assert');
const h3Engine = require('../src/h3Engine');
const pricingEngine = require('../src/pricingEngine');
const allocationEngine = require('../src/allocationEngine');
const bookingEngine = require('../src/bookingEngine');
const simulator = require('../src/simulator');

async function runTests() {
  console.log('--- SurgeX Test Suite Starting ---');

  // Test 1: H3 Cell initialization
  const cells = h3Engine.getAllCells();
  assert(cells.length === 8, `Expected 8 Bengaluru zones, got ${cells.length}`);
  console.log('✓ Test 1 Passed: 8 Bengaluru H3 zones initialized.');

  // Test 2: Koramangala Shortage Calculation
  const koramangala = h3Engine.getCellByZoneId('koramangala');
  assert(koramangala !== null, 'Koramangala cell exists');
  h3Engine.updateCellCounts('koramangala', { activeRequests: 100, availableDrivers: 20 });
  const kMetrics = h3Engine.getCellByZoneId('koramangala');
  assert.strictEqual(kMetrics.demandSupplyRatio, 5.0, 'Ratio should be 5.0');
  assert.strictEqual(kMetrics.shortage, 80, 'Shortage should be 80');
  assert.strictEqual(kMetrics.status, 'SEVERE_SHORTAGE', 'Status should be SEVERE_SHORTAGE');
  console.log('✓ Test 2 Passed: Koramangala shortage metrics correctly computed (R=5.0, Shortage=80).');

  // Test 3: Capped Pricing & Transparent Breakdown
  const pricing = pricingEngine.evaluatePricingAndIncentive(kMetrics);
  assert(pricing.multiplier <= 1.45, `Multiplier ${pricing.multiplier} must not exceed cap 1.45`);
  assert(pricing.driverIncentiveBonus >= 30, `Bonus should be >= ₹30, got ₹${pricing.driverIncentiveBonus}`);
  assert.strictEqual(pricing.baseFare, 200, 'Base fare must be ₹200');
  console.log(`✓ Test 3 Passed: Capped pricing verified (SurgeX: ₹${pricing.finalFare} [${pricing.multiplier}x] vs Competitor Uncapped: ₹${pricing.naiveCompetitor.fare}).`);

  // Test 4: Neighbourhood Fairness Safeguard
  // Indiranagar has 40 drivers, 30 requests -> safe surplus = 10
  const recs = allocationEngine.findRelocationRecommendations('koramangala');
  const indiraRec = recs.find(r => r.donorZoneId === 'indiranagar');
  assert(indiraRec && indiraRec.isFairToRelocate === true, 'Indiranagar should be approved as donor zone');
  assert(indiraRec.safeDonorSurplus >= 10, 'Indiranagar safe donor surplus should be >= 10');

  // Whitefield should NOT be recommended for immediate Koramangala donor due to distance / balanced status
  const whitefieldRec = recs.find(r => r.donorZoneId === 'whitefield');
  assert(!whitefieldRec, 'Whitefield should not be drained for Koramangala');
  console.log('✓ Test 4 Passed: Neighbourhood fairness verified (Indiranagar surplus utilized, Whitefield protected).');

  // Test 5: Atomic Concurrency Lock Test
  const testDriver = allocationEngine.getDrivers().find(d => d.status === 'AVAILABLE');
  assert(testDriver, 'Available driver exists for concurrency test');
  const lockTest = await bookingEngine.simulateConcurrentRaceCondition(testDriver.id, 5);
  assert.strictEqual(lockTest.isAtomicSafe, true, 'Atomic lock must guarantee exactly 1 winner');
  assert.strictEqual(lockTest.safelyRejectedAttempts, 4, '4 parallel attempts must be safely rejected');
  console.log(`✓ Test 5 Passed: Atomic mutex concurrency lock verified (1 winner [${lockTest.atomicWinner}], 4 safely rejected).`);

  // Test 6: 5-Step Peak Demand Scenario Execution
  for (let step = 1; step <= 5; step++) {
    const res = simulator.executeScenarioStep(step);
    assert.strictEqual(res.step, step);
    console.log(`✓ Scenario Step ${step} executed cleanly: ${res.stepDescription.slice(0, 60)}...`);
  }

  console.log('--- ALL TESTS PASSED SUCCESSFULLY! ---');
}

runTests().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
