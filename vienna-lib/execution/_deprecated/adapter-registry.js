/**
 * Adapter Configuration Registry
 * 
 * Manages adapter configs per tenant. In-memory for now,
 * maps to adapter_configs table schema for future DB persistence.
 * 
 * Table schema (future):
 *   id, tenant_id, type (webhook), endpoint_url, headers (JSON),
 *   auth_type (none|bearer|basic), encrypted_credentials (nullable),
 *   created_at
 */

const crypto = require('crypto');

class AdapterRegistry {
  constructor(options = {}) {
    this.configs = new Map(); // id → config
    this.byTenant = new Map(); // tenant_id → Set<id>
  }

  /**
   * Register an adapter configuration
   * 
   * @param {object} config - Adapter configuration
   * @returns {object} Registered config with generated id
   */
  register(config) {
    const required = ['tenant_id', 'type', 'endpoint_url'];
    const missing = required.filter(f => !config[f]);
    if (missing.length > 0) {
      throw new Error(`Missing required fields: ${missing.join(', ')}`);
    }

    if (!['webhook'].includes(config.type)) {
      throw new Error(`Unsupported adapter type: ${config.type}. Supported: webhook`);
    }

    const id = config.id || `adc_${crypto.randomBytes(8).toString('hex')}`;
    
    const entry = {
      id,
      tenant_id: config.tenant_id,
      type: config.type,
      endpoint_url: config.endpoint_url,
      headers: config.headers || {},
      auth_type: config.auth_type || 'none',
      encrypted_credentials: config.encrypted_credentials || null, // stub — plaintext for now
      created_at: new Date().toISOString()
    };

    this.configs.set(id, entry);

    // Index by tenant
    if (!this.byTenant.has(config.tenant_id)) {
      this.byTenant.set(config.tenant_id, new Set());
    }
    this.byTenant.get(config.tenant_id).add(id);

    return entry;
  }

  /**
   * Get adapter config by id
   */
  get(id) {
    return this.configs.get(id) || null;
  }

  /**
   * List configs for a tenant
   */
  listByTenant(tenantId) {
    const ids = this.byTenant.get(tenantId);
    if (!ids) return [];
    return Array.from(ids).map(id => this.configs.get(id)).filter(Boolean);
  }

  /**
   * Remove adapter config
   */
  remove(id) {
    const config = this.configs.get(id);
    if (!config) return false;
    
    this.configs.delete(id);
    const tenantSet = this.byTenant.get(config.tenant_id);
    if (tenantSet) tenantSet.delete(id);
    
    return true;
  }

  /**
   * Update adapter config
   */
  update(id, updates) {
    const config = this.configs.get(id);
    if (!config) throw new Error(`Adapter config ${id} not found`);
    
    const mutable = ['endpoint_url', 'headers', 'auth_type', 'encrypted_credentials'];
    for (const key of mutable) {
      if (updates[key] !== undefined) {
        config[key] = updates[key];
      }
    }
    
    return config;
  }
}

module.exports = { AdapterRegistry };
