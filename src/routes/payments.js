const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate, paymentLimiter, otpLimiter, requireAdmin } = require('../middleware/security');
const { initiateDeposit, handlePaymentCallback, initiateWithdrawal, approveWithdrawal } = require('../services/paymentService');
const { sendOTP, verifyOTP, formatPhone } = require('../services/otpService');
const { query } = require('../../config/db');

const router = express.Router();

// ─────────────────────────────────────────────
//  POST /api/payments/deposit
// ─────────────────────────────────────────────
router.post('/deposit',
  authenticate,
  paymentLimiter,
  [ body('amount').isFloat({ min: 10 }), body('phone').notEmpty().trim() ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const result = await initiateDeposit({
        userId: req.user.id,
        phone:  formatPhone(req.body.phone),
        amount: parseFloat(req.body.amount),
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────────
//  POST /api/payments/callback  (Instasend webhook)
//  Add this URL in your Instasend dashboard as the callback URL.
//  No auth — called by Instasend server.
// ─────────────────────────────────────────────
router.post('/callback', async (req, res) => {
  try {
    // Verify the request is from Instasend using signature header
    // Instasend sends X-INSTASEND-SIGNATURE — verify in production
    const signature = req.headers['x-instasend-signature'];
    // TODO: validate signature against your secret for extra security
    // For now, we process and let DB constraints handle bad data

    await handlePaymentCallback(req.body);
    res.json({ status: 'received' });
  } catch (err) {
    console.error('[Callback Error]', err.message);
    res.status(500).json({ error: 'Callback processing failed' });
  }
});

// ─────────────────────────────────────────────
//  POST /api/payments/withdraw/request-otp
//  User must confirm withdrawal with OTP
// ─────────────────────────────────────────────
router.post('/withdraw/request-otp',
  authenticate,
  otpLimiter,
  async (req, res) => {
    try {
      await sendOTP(req.user.phone, 'withdraw');
      res.json({ success: true, message: 'OTP sent for withdrawal confirmation.' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to send OTP.' });
    }
  }
);

// ─────────────────────────────────────────────
//  POST /api/payments/withdraw
// ─────────────────────────────────────────────
router.post('/withdraw',
  authenticate,
  paymentLimiter,
  [
    body('amount').isFloat({ min: 100 }),
    body('phone').notEmpty().trim(),
    body('otp').isLength({ min: 6, max: 6 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      // Verify OTP before processing withdrawal
      const otpResult = await verifyOTP(req.user.phone, req.body.otp, 'withdraw');
      if (!otpResult.valid) {
        return res.status(400).json({ error: otpResult.message });
      }

      const result = await initiateWithdrawal({
        userId: req.user.id,
        phone:  formatPhone(req.body.phone),
        amount: parseFloat(req.body.amount),
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────────
//  GET /api/payments/transactions
//  User's transaction history
// ─────────────────────────────────────────────
router.get('/transactions', authenticate, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const result = await query(
      `SELECT id, type, amount, status, mpesa_receipt, created_at
       FROM transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );
    res.json({ transactions: result.rows, page, limit });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transactions.' });
  }
});

// ─────────────────────────────────────────────
//  ADMIN: GET /api/payments/admin/pending
// ─────────────────────────────────────────────
router.get('/admin/pending', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT t.*, u.username, u.phone AS user_phone
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       WHERE t.type = 'withdrawal' AND t.status = 'pending'
       ORDER BY t.created_at ASC`
    );
    res.json({ withdrawals: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pending withdrawals.' });
  }
});

// ─────────────────────────────────────────────
//  ADMIN: POST /api/payments/admin/approve/:id
// ─────────────────────────────────────────────
router.post('/admin/approve/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await approveWithdrawal({
      transactionId: req.params.id,
      adminId:       req.user.id,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ADMIN: POST /api/payments/admin/reject/:id
// ─────────────────────────────────────────────
router.post('/admin/reject/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const txResult = await query(
      `SELECT * FROM transactions WHERE id = $1 AND status = 'pending'`,
      [req.params.id]
    );
    if (txResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }
    const tx = txResult.rows[0];
    // Refund user
    await query(
      `UPDATE users SET balance = balance + $1 WHERE id = $2`,
      [tx.amount, tx.user_id]
    );
    await query(
      `UPDATE transactions
       SET status = 'cancelled', admin_note = $1, reviewed_by = $2, reviewed_at = NOW()
       WHERE id = $3`,
      [req.body.reason || 'Rejected by admin', req.user.id, tx.id]
    );
    res.json({ success: true, message: 'Withdrawal rejected and amount refunded.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
