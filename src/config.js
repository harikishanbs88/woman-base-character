/**
 * SurgeX - Configuration and Bengaluru Zone Definitions
 */

module.exports = {
  PORT: process.env.PORT || 3000,
  BASE_FARE: 200, // ₹200 base fare as specified in prompt
  MAX_SURGE_MULTIPLIER: 1.45, // Capped local surge multiplier to keep fares fair (unlike naive 3.5x-5x)
  SURGE_SMOOTHING_FACTOR: 0.25, // Exponential moving average smoothing weight
  
  // Incentive Bonus Tiers (₹ per qualifying ride completed in hotspot)
  INCENTIVE_TIERS: {
    LOW: 20,
    MEDIUM: 30, // Default prompt tier for Koramangala
    HIGH: 50
  },
  
  // H3 Configuration
  H3_RESOLUTION: 7, // H3 resolution 7 gives ~5.16 km² area (~1.2km edge length) ideal for city zones
  
  // Bengaluru Key Neighborhood Centers
  ZONES: [
    {
      id: 'koramangala',
      name: 'Koramangala',
      lat: 12.9352,
      lng: 77.6245,
      type: 'commercial_nightlife',
      description: 'Major tech & food hub, high evening demand volatility',
      baselineRequests: 100,
      baselineDrivers: 20,
      rainfall: 'HEAVY' // 6:00 PM rainy weekday scenario
    },
    {
      id: 'indiranagar',
      name: 'Indiranagar',
      lat: 12.9784,
      lng: 77.6408,
      type: 'mixed_residential',
      description: 'Adjacent zone with idle drivers available for relocation',
      baselineRequests: 30,
      baselineDrivers: 40,
      rainfall: 'NONE'
    },
    {
      id: 'whitefield',
      name: 'Whitefield',
      lat: 12.9698,
      lng: 77.7499,
      type: 'tech_suburb',
      description: 'Distant tech corridor, balanced supply that must not be drained',
      baselineRequests: 25,
      baselineDrivers: 30,
      rainfall: 'LIGHT'
    },
    {
      id: 'hsr_layout',
      name: 'HSR Layout',
      lat: 12.9121,
      lng: 77.6446,
      type: 'startup_residential',
      description: 'Neighboring sector south of Koramangala',
      baselineRequests: 35,
      baselineDrivers: 45,
      rainfall: 'MODERATE'
    },
    {
      id: 'mg_road',
      name: 'MG Road / CBD',
      lat: 12.9756,
      lng: 77.6066,
      type: 'central_business_district',
      description: 'Central Bengaluru business and transit corridor',
      baselineRequests: 40,
      baselineDrivers: 42,
      rainfall: 'LIGHT'
    },
    {
      id: 'bellandur',
      name: 'Bellandur (Outer Ring Rd)',
      lat: 12.9304,
      lng: 77.6784,
      type: 'it_corridor',
      description: 'High-density tech corridor prone to traffic bottlenecks',
      baselineRequests: 55,
      baselineDrivers: 48,
      rainfall: 'HEAVY'
    },
    {
      id: 'electronic_city',
      name: 'Electronic City',
      lat: 12.8452,
      lng: 77.6602,
      type: 'industrial_tech',
      description: 'Southern tech hub with dedicated elevated highway',
      baselineRequests: 30,
      baselineDrivers: 35,
      rainfall: 'NONE'
    },
    {
      id: 'jayanagar',
      name: 'Jayanagar',
      lat: 12.9308,
      lng: 77.5838,
      type: 'traditional_residential',
      description: 'Stable residential blocks with predictable local trips',
      baselineRequests: 20,
      baselineDrivers: 28,
      rainfall: 'NONE'
    }
  ]
};
