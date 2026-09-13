const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/security');
const { query } = require('../../config/db');

const router = express.Router();

// ─────────────────────────────────────────────
//  GET /api/user/profile
// ─────────────────────────────────────────────
router.get('/profile', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, username, phone, balance, bonus_balance,
              referral_code, kyc_status, daily_limit,
              self_excluded, self_excluded_until, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    const u = result.rows[0];
    res.json({
      id:              u.id,
      username:        u.username,
      phone:           u.phone.replace(/(\+254|0)(\d{3})(\d{3})(\d{3})/, '$1$2***$4'), // mask middle
      balance:         parseFloat(u.balance),
      bonusBalance:    parseFloat(u.bonus_balance),
      referralCode:    u.referral_code,
      kycStatus:       u.kyc_status,
      dailyLimit:      u.daily_limit,
      selfExcluded:    u.self_excluded,
      selfExcludedUntil: u.self_excluded_until,
      memberSince:     u.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile.' });
  }
});

// ─────────────────────────────────────────────
//  POST /api/user/kyc
//  Submit KYC document URL (after uploading to Supabase Storage)
// ─────────────────────────────────────────────
router.post('/kyc',
  authenticate,
  [ body('doc_url').isURL() ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      if (req.user.kyc_status === 'verified') {
        return res.status(400).json({ error: 'Already verified.' });
      }
      await query(
        `UPDATE users SET kyc_doc_url = $1, kyc_status = 'submitted', updated_at = NOW()
         WHERE id = $2`,
        [req.body.doc_url, req.user.id]
      );
      res.json({ success: true, message: 'KYC submitted. We\'ll review within 24 hours.' });
    } catch (err) {
      res.status(500).json({ error: 'KYC submission failed.' });
    }
  }
);

// ─────────────────────────────────────────────
//  POST /api/user/limits
//  Set daily deposit limit or self-exclusion
// ─────────────────────────────────────────────
router.post('/limits',
  authenticate,
  [
    body('daily_limit').optional().isFloat({ min: 0 }),
    body('self_exclude_days').optional().isInt({ min: 1, max: 365 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { daily_limit, self_exclude_days } = req.body;
      const updates = [];

      if (daily_limit !== undefined) {
        await query(
          `UPDATE users SET daily_limit = $1, updated_at = NOW() WHERE id = $2`,
          [daily_limit === 0 ? null : daily_limit, req.user.id]
        );
        updates.push('Daily limit updated');
      }

      if (self_exclude_days) {
        const until = new Date();
        until.setDate(until.getDate() + parseInt(self_exclude_days));
        await query(
          `UPDATE users
           SET self_excluded = TRUE, self_excluded_until = $1, updated_at = NOW()
           WHERE id = $2`,
          [until.toISOString(), req.user.id]
        );
        updates.push(`Self-excluded for ${self_exclude_days} days`);
      }

      res.json({ success: true, message: updates.join('. ') || 'No changes made.' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update limits.' });
    }
  }
);

// ─────────────────────────────────────────────
//  GET /api/user/referrals
// ─────────────────────────────────────────────
router.get('/referrals', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT r.*, u.username AS referred_username, r.paid_out
       FROM referrals r
       JOIN users u ON r.referred_id = u.id
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.id]
    );
    const totalEarned = result.rows
      .filter(r => r.paid_out)
      .reduce((sum, r) => sum + parseFloat(r.referrer_bonus), 0);

    res.json({ referrals: result.rows, totalEarned });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch referrals.' });
  }
});

// ─────────────────────────────────────────────
//  ADMIN: GET /api/user/admin/users
// ─────────────────────────────────────────────
router.get('/admin/users', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only.' });
  try {
    const result = await query(
      `SELECT id, username, phone, balance, kyc_status,
              is_active, created_at, first_deposit_done
       FROM users ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// ADMIN: Approve/reject KYC
router.post('/admin/kyc/:userId/:action', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only.' });
  const { userId, action } = req.params;
  if (!['verified', 'rejected'].includes(action)) {
    return res.status(400).json({ error: 'Action must be verified or rejected.' });
  }
  try {
    await query(
      `UPDATE users SET kyc_status = $1, updated_at = NOW() WHERE id = $2`,
      [action, userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'KYC update failed.' });
  }
});

module.exports = router;
