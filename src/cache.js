// Simple in‑memory cache used by the integration test
// It stores arbitrary values keyed by a string identifier.

export class Cache {
  constructor() {
    this.store = new Map();
  }

  /**
   * Retrieve a cached value.
   * @param {string} key
   * @returns {*} cached value or undefined
   */
  get(key) {
    return this.store.get(key);
  }

  /**
   * Store a value in the cache.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    this.store.set(key, value);
  }
}
