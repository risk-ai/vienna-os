/**
 * Dual-Key Confirmation — High-Value Action Gate
 * 
 * For high-value or high-risk actions (e.g., $75K wire transfer),
 * require BOTH warrant approval AND a real-time confirmation:
 *   - OTP (time-based, delivered via email/SMS/push)
 *   - Supervisor sign-off (another authorized user)
 *   - Biometric placeholder (future)
 * 
 * This is the "two-person rule" for agent execution.
 */

const crypto = require('crypto');

const CONFIRMATION_TYPES = {
  OTP: 'otp',
  SUPERVISOR: 'supervisor',
  BIOMETRIC: 'biometric' // stub
};

const CONFIRMATION_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  DENIED: 'denied',
  EXPIRED: 'expired'
};

class DualKeyGate {
  constructor(options = {}) {
    this.confirmations = new Map();
    this.thresholds = options.thresholds || {
      dollar_amount: 10000,     // require dual-key above $10K
      risk_tier: 'T2'           // always require for T2
    };
    this.otpExpiryMs = options.otpExpiryMs || 300000; // 5 min
    this.supervisorExpiryMs = options.supervisorExpiryMs || 600000; // 10 min
    this.notifier = options.notifier || null; // { sendOTP, notifySupervisor }
    this.auditLog = options.auditLog || null;
  }

  /**
   * Check if an execution requires dual-key confirmation
   * 
   * @param {object} execution - Execution instruction or warrant
   * @returns {boolean}
   */
  requiresConfirmation(execution) {
    // Check dollar threshold
    const amount = execution.params?.amount || execution.constraints?.max_amount || 0;
    if (amount >= this.thresholds.dollar_amount) return true;

    // Check risk tier
    const tier = execution.constraints?.risk_tier || execution.risk_tier;
    if (tier === this.thresholds.risk_tier) return true;

    // Check explicit flag
    if (execution.requires_dual_key) return true;

    return false;
  }

  /**
   * Request confirmation for an execution
   * 
   * @param {string} executionId - Execution to confirm
   * @param {string} type - Confirmation type: 'otp' | 'supervisor'
   * @param {object} options - { recipient, supervisor_id, etc. }
   * @returns {object} Confirmation request
   */
  async requestConfirmation(executionId, type, options = {}) {
    const confirmationId = `cfm_${crypto.randomBytes(8).toString('hex')}`;
    const expiryMs = type === CONFIRMATION_TYPES.OTP ? this.otpExpiryMs : this.supervisorExpiryMs;

    const confirmation = {
      confirmation_id: confirmationId,
      execution_id: executionId,
      type,
      status: CONFIRMATION_STATUS.PENDING,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + expiryMs).toISOString(),
      confirmed_at: null,
      confirmed_by: null,
      metadata: {}
    };

    if (type === CONFIRMATION_TYPES.OTP) {
      const otp = this._generateOTP();
      confirmation.otp_hash = crypto.createHash('sha256').update(otp).digest('hex');
      confirmation.metadata.recipient = options.recipient;
      
      // Send OTP via notifier
      if (this.notifier?.sendOTP) {
        await this.notifier.sendOTP(options.recipient, otp, {
          execution_id: executionId,
          expires_in_minutes: Math.floor(expiryMs / 60000)
        });
      }
    } else if (type === CONFIRMATION_TYPES.SUPERVISOR) {
      confirmation.metadata.supervisor_id = options.supervisor_id;
      confirmation.metadata.reason = options.reason || 'High-value execution requires supervisor sign-off';
      
      // Notify supervisor
      if (this.notifier?.notifySupervisor) {
        await this.notifier.notifySupervisor(options.supervisor_id, {
          confirmation_id: confirmationId,
          execution_id: executionId,
          reason: confirmation.metadata.reason
        });
      }
    }

    // Set expiry timer
    confirmation._expiryTimer = setTimeout(() => {
      if (confirmation.status === CONFIRMATION_STATUS.PENDING) {
        confirmation.status = CONFIRMATION_STATUS.EXPIRED;
        this._audit('dual_key_expired', { confirmation_id: confirmationId, execution_id: executionId });
      }
    }, expiryMs);

    this.confirmations.set(confirmationId, confirmation);

    await this._audit('dual_key_requested', {
      confirmation_id: confirmationId,
      execution_id: executionId,
      type
    });

    return {
      confirmation_id: confirmationId,
      type,
      status: CONFIRMATION_STATUS.PENDING,
      expires_at: confirmation.expires_at,
      message: type === CONFIRMATION_TYPES.OTP 
        ? `OTP sent to ${options.recipient}. Enter code to proceed.`
        : `Supervisor ${options.supervisor_id} notified. Awaiting sign-off.`
    };
  }

  /**
   * Verify an OTP confirmation
   * 
   * @param {string} confirmationId
   * @param {string} code - OTP code provided by user
   * @returns {object} Verification result
   */
  async verifyOTP(confirmationId, code) {
    const confirmation = this.confirmations.get(confirmationId);
    if (!confirmation) return { verified: false, error: 'Confirmation not found' };
    if (confirmation.type !== CONFIRMATION_TYPES.OTP) return { verified: false, error: 'Not an OTP confirmation' };
    if (confirmation.status !== CONFIRMATION_STATUS.PENDING) return { verified: false, error: `Confirmation is ${confirmation.status}` };

    // Check expiry
    if (new Date() > new Date(confirmation.expires_at)) {
      confirmation.status = CONFIRMATION_STATUS.EXPIRED;
      return { verified: false, error: 'OTP expired' };
    }

    // Verify code
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    if (codeHash !== confirmation.otp_hash) {
      return { verified: false, error: 'Invalid OTP' };
    }

    confirmation.status = CONFIRMATION_STATUS.CONFIRMED;
    confirmation.confirmed_at = new Date().toISOString();
    confirmation.confirmed_by = 'otp_holder';
    clearTimeout(confirmation._expiryTimer);

    await this._audit('dual_key_confirmed', {
      confirmation_id: confirmationId,
      execution_id: confirmation.execution_id,
      type: 'otp'
    });

    return { verified: true, confirmation_id: confirmationId, execution_id: confirmation.execution_id };
  }

  /**
   * Process supervisor sign-off
   * 
   * @param {string} confirmationId
   * @param {string} supervisorId - Who is signing off
   * @param {boolean} approved - true = approve, false = deny
   * @returns {object}
   */
  async supervisorDecision(confirmationId, supervisorId, approved) {
    const confirmation = this.confirmations.get(confirmationId);
    if (!confirmation) return { verified: false, error: 'Confirmation not found' };
    if (confirmation.type !== CONFIRMATION_TYPES.SUPERVISOR) return { verified: false, error: 'Not a supervisor confirmation' };
    if (confirmation.status !== CONFIRMATION_STATUS.PENDING) return { verified: false, error: `Confirmation is ${confirmation.status}` };

    if (new Date() > new Date(confirmation.expires_at)) {
      confirmation.status = CONFIRMATION_STATUS.EXPIRED;
      return { verified: false, error: 'Confirmation expired' };
    }

    confirmation.status = approved ? CONFIRMATION_STATUS.CONFIRMED : CONFIRMATION_STATUS.DENIED;
    confirmation.confirmed_at = new Date().toISOString();
    confirmation.confirmed_by = supervisorId;
    clearTimeout(confirmation._expiryTimer);

    await this._audit(approved ? 'dual_key_confirmed' : 'dual_key_denied', {
      confirmation_id: confirmationId,
      execution_id: confirmation.execution_id,
      supervisor_id: supervisorId,
      type: 'supervisor'
    });

    return {
      verified: approved,
      confirmation_id: confirmationId,
      execution_id: confirmation.execution_id,
      decision: approved ? 'approved' : 'denied',
      decided_by: supervisorId
    };
  }

  /**
   * Check if all required confirmations for an execution are complete
   */
  isFullyConfirmed(executionId) {
    const confirmations = Array.from(this.confirmations.values())
      .filter(c => c.execution_id === executionId);
    
    if (confirmations.length === 0) return { confirmed: false, reason: 'No confirmations found' };
    
    const allConfirmed = confirmations.every(c => c.status === CONFIRMATION_STATUS.CONFIRMED);
    const anyDenied = confirmations.some(c => c.status === CONFIRMATION_STATUS.DENIED);
    const anyExpired = confirmations.some(c => c.status === CONFIRMATION_STATUS.EXPIRED);

    return {
      confirmed: allConfirmed,
      denied: anyDenied,
      expired: anyExpired,
      total: confirmations.length,
      confirmed_count: confirmations.filter(c => c.status === CONFIRMATION_STATUS.CONFIRMED).length,
      pending_count: confirmations.filter(c => c.status === CONFIRMATION_STATUS.PENDING).length
    };
  }

  /**
   * Get confirmation by ID
   */
  getConfirmation(confirmationId) {
    const c = this.confirmations.get(confirmationId);
    if (!c) return null;
    const { _expiryTimer, otp_hash, ...safe } = c;
    return safe;
  }

  // --- Internal ---

  _generateOTP() {
    return String(crypto.randomInt(100000, 999999));
  }

  async _audit(eventType, data) {
    if (this.auditLog) {
      try {
        await this.auditLog.emit({ event_type: eventType, timestamp: new Date().toISOString(), ...data });
      } catch (e) { /* swallow */ }
    }
  }
}

module.exports = { DualKeyGate, CONFIRMATION_TYPES, CONFIRMATION_STATUS };
