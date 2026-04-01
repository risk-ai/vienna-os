/**
 * Dual-Key Gate — Pre-execution gate (STATELESS relative to execution engine)
 * 
 * Checks if an execution requires dual-key confirmation before proceeding.
 * Implements the gate interface: { check(execution) → { allowed, reason } }
 * 
 * This is a GATE, not a state owner. It blocks or allows. Period.
 * The ExecutionEngine decides what to do with the gate's response.
 */

const crypto = require('crypto');

class DualKeyGate {
  constructor(options = {}) {
    this.thresholds = options.thresholds || {
      dollar_amount: 10000,
      risk_tier: 'T2'
    };
    this.confirmations = new Map(); // executionId → confirmation status
    this.otpExpiryMs = options.otpExpiryMs || 300000;
    this.notifier = options.notifier || null;
  }

  /**
   * Gate interface: check if execution can proceed
   * Called by ExecutionEngine before executing steps.
   * 
   * @param {object} execution - Execution record (read-only)
   * @returns {object} { allowed: bool, reason?: string }
   */
  async check(execution) {
    if (!this._requiresConfirmation(execution)) {
      return { allowed: true };
    }

    // Check if already confirmed
    const confirmation = this.confirmations.get(execution.execution_id);
    if (confirmation && confirmation.status === 'confirmed') {
      return { allowed: true };
    }

    if (confirmation && confirmation.status === 'denied') {
      return { allowed: false, reason: 'Dual-key confirmation denied' };
    }

    if (confirmation && confirmation.status === 'expired') {
      return { allowed: false, reason: 'Dual-key confirmation expired' };
    }

    // No confirmation yet — block and request one
    return {
      allowed: false,
      reason: 'Dual-key confirmation required',
      requires_confirmation: true,
      execution_id: execution.execution_id,
      threshold_triggered: this._getTriggeredThreshold(execution)
    };
  }

  /**
   * Request a confirmation (OTP or supervisor)
   */
  async requestConfirmation(executionId, type, options = {}) {
    const confirmationId = `cfm_${crypto.randomBytes(8).toString('hex')}`;
    const otp = type === 'otp' ? this._generateOTP() : null;

    const confirmation = {
      confirmation_id: confirmationId,
      execution_id: executionId,
      type,
      status: 'pending',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + this.otpExpiryMs).toISOString(),
      otp_hash: otp ? crypto.createHash('sha256').update(otp).digest('hex') : null
    };

    this.confirmations.set(executionId, confirmation);

    // Notify
    if (type === 'otp' && this.notifier?.sendOTP) {
      await this.notifier.sendOTP(options.recipient, otp, { execution_id: executionId });
    }
    if (type === 'supervisor' && this.notifier?.notifySupervisor) {
      await this.notifier.notifySupervisor(options.supervisor_id, { execution_id: executionId });
    }

    // Auto-expire
    setTimeout(() => {
      const c = this.confirmations.get(executionId);
      if (c && c.status === 'pending') c.status = 'expired';
    }, this.otpExpiryMs);

    return { confirmation_id: confirmationId, type, status: 'pending' };
  }

  /**
   * Verify OTP
   */
  verifyOTP(executionId, code) {
    const c = this.confirmations.get(executionId);
    if (!c || c.type !== 'otp') return { verified: false, error: 'No OTP confirmation found' };
    if (c.status !== 'pending') return { verified: false, error: `Confirmation is ${c.status}` };
    if (new Date() > new Date(c.expires_at)) {
      c.status = 'expired';
      return { verified: false, error: 'OTP expired' };
    }

    const hash = crypto.createHash('sha256').update(code).digest('hex');
    if (hash !== c.otp_hash) return { verified: false, error: 'Invalid OTP' };

    c.status = 'confirmed';
    return { verified: true, execution_id: executionId };
  }

  /**
   * Supervisor decision
   */
  supervisorDecision(executionId, approved) {
    const c = this.confirmations.get(executionId);
    if (!c || c.type !== 'supervisor') return { verified: false, error: 'No supervisor confirmation found' };
    if (c.status !== 'pending') return { verified: false, error: `Confirmation is ${c.status}` };

    c.status = approved ? 'confirmed' : 'denied';
    return { verified: approved, execution_id: executionId };
  }

  // --- Internal ---

  _requiresConfirmation(execution) {
    // Check dollar threshold across all steps
    const totalAmount = execution.steps.reduce((sum, s) => sum + (s.params.amount || 0), 0);
    if (totalAmount >= this.thresholds.dollar_amount) return true;
    if (execution.risk_tier === this.thresholds.risk_tier) return true;
    return false;
  }

  _getTriggeredThreshold(execution) {
    const totalAmount = execution.steps.reduce((sum, s) => sum + (s.params.amount || 0), 0);
    if (totalAmount >= this.thresholds.dollar_amount) return `amount:${totalAmount}≥${this.thresholds.dollar_amount}`;
    if (execution.risk_tier === this.thresholds.risk_tier) return `risk_tier:${execution.risk_tier}`;
    return 'unknown';
  }

  _generateOTP() {
    return String(crypto.randomInt(100000, 999999));
  }
}

module.exports = { DualKeyGate };
