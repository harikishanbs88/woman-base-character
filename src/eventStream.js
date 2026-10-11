/**
 * SurgeX - Module 1: Real-Time Data Collection & Kafka Event Stream Bus
 * Ingests, validates, and routes ride requests, GPS telemetry, weather, traffic, and bookings.
 */

const EventEmitter = require('events');

class EventStreamBus extends EventEmitter {
  constructor() {
    super();
    this.eventBuffer = [];
    this.maxBufferSize = 150;
    this.topicStats = {
      'ride.requests': 0,
      'driver.telemetry': 0,
      'weather.events': 0,
      'traffic.conditions': 0,
      'hotspot.alerts': 0,
      'driver.incentives': 0,
      'booking.reservations': 0
    };
  }

  /**
   * Publish an event to the simulated Kafka topic
   */
  publish(topic, payload) {
    const event = {
      id: `evt-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      topic,
      payload,
      timestamp: new Date().toISOString(),
      partition: Math.floor(Math.random() * 3)
    };

    this.eventBuffer.unshift(event);
    if (this.eventBuffer.length > this.maxBufferSize) {
      this.eventBuffer.pop();
    }

    if (this.topicStats[topic] !== undefined) {
      this.topicStats[topic]++;
    } else {
      this.topicStats[topic] = 1;
    }

    this.emit('event', event);
    this.emit(topic, event);
    return event;
  }

  getRecentEvents(limit = 40, filterTopic = null) {
    if (filterTopic && filterTopic !== 'all') {
      return this.eventBuffer.filter(e => e.topic === filterTopic).slice(0, limit);
    }
    return this.eventBuffer.slice(0, limit);
  }

  getTopicStats() {
    return { ...this.topicStats };
  }
}

module.exports = new EventStreamBus();
