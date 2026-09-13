const express  = require('express');
const bcrypt   = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { query } = require('../../config/db');
const { sendOTP, verifyOTP, formatPhone } = require('../services/otpService');
const { generateToken, authLimiter, otpLimiter } = require('../middleware/security');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// ─────────────────────────────────────────────
//  POST /api/auth/register/request-otp
//  Step 1: User enters phone → get OTP
// ─────────────────────────────────────────────
router.post('/register/request-otp',
  otpLimiter,
  [
    body('phone').notEmpty().trim(),
    body('username').isLength({ min: 3, max: 30 }).trim().escape(),
    body('password').isLength({ min: 6 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { phone, username, password } = req.body;
      const formattedPhone = formatPhone(phone);

      // Check if phone or username already taken
      const existing = await query(
        `SELECT id FROM users WHERE phone = $1 OR username = $2`,
        [formattedPhone, username.toLowerCase()]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Phone number or username already registered.' });
      }

      // Store pending registration temporarily (we hash password here)
      const passwordHash = await bcrypt.hash(password, 12);
      // We'll store the hash in OTP table as a temp measure using a special field
      // Better: use Redis. Since we're free tier, store it in a temp DB row.
      await query(
        `INSERT INTO otp_codes (phone, code, purpose, expires_at)
         VALUES ($1, $2, 'register_meta', NOW() + INTERVAL '10 minutes')
         ON CONFLICT DO NOTHING`,
        [formattedPhone + '_meta', JSON.stringify({ username, passwordHash })]
      );

      await sendOTP(formattedPhone, 'register');
      res.json({ success: true, message: 'OTP sent to your phone.' });
    } catch (err) {
      console.error('[Register OTP]', err.message);
      res.status(500).json({ error: 'Failed to send OTP. Try again.' });
    }
  }
);

// ─────────────────────────────────────────────
//  POST /api/auth/register/verify
//  Step 2: Verify OTP → create account
// ─────────────────────────────────────────────
router.post('/register/verify',
  authLimiter,
  [
    body('phone').notEmpty().trim(),
    body('otp').isLength({ min: 6, max: 6 }),
    body('username').isLength({ min: 3, max: 30 }).trim().escape(),
    body('password').isLength({ min: 6 }),
    body('referral_code').optional().trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { phone, otp, username, password, referral_code } = req.body;
      const formattedPhone = formatPhone(phone);

      const otpResult = await verifyOTP(formattedPhone, otp, 'register');
      if (!otpResult.valid) {
        return res.status(400).json({ error: otpResult.message });
      }

      // Check uniqueness again
      const existing = await query(
        `SELECT id FROM users WHERE phone = $1 OR username = $2`,
        [formattedPhone, username.toLowerCase()]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Phone or username already taken.' });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const referralCode = uuidv4().substring(0, 8).toUpperCase();

      // Find referrer if code provided
      let referrerId = null;
      if (referral_code) {
        const refResult = await query(
          `SELECT id FROM users WHERE referral_code = $1`,
          [referral_code.toUpperCase()]
        );
        if (refResult.rows.length > 0) referrerId = refResult.rows[0].id;
      }

      await query('BEGIN');
      const userResult = await query(
        `INSERT INTO users (phone, username, password_hash, referral_code, referred_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, balance, bonus_balance`,
        [formattedPhone, username.toLowerCase(), passwordHash, referralCode, referrerId]
      );
      const newUser = userResult.rows[0];

      // Create referral record
      if (referrerId) {
        await query(
          `INSERT INTO referrals (referrer_id, referred_id)
           VALUES ($1, $2)`,
          [referrerId, newUser.id]
        );
      }
      await query('COMMIT');

      const token = generateToken(newUser.id);
      res.status(201).json({
        success: true,
        token,
        user: {
          id:           newUser.id,
          username:     newUser.username,
          balance:      newUser.balance,
          bonusBalance: newUser.bonus_balance,
          referralCode,
        },
      });
    } catch (err) {
      await query('ROLLBACK').catch(() => {});
      console.error('[Register Verify]', err.message);
      res.status(500).json({ error: 'Registration failed. Try again.' });
    }
  }
);

// ─────────────────────────────────────────────
//  POST /api/auth/login/request-otp
// ─────────────────────────────────────────────
router.post('/login/request-otp',
  otpLimiter,
  [ body('phone').notEmpty().trim() ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const formattedPhone = formatPhone(req.body.phone);
      const result = await query(
        `SELECT id FROM users WHERE phone = $1 AND is_active = TRUE`,
        [formattedPhone]
      );
      // Don't reveal if user exists or not (security)
      if (result.rows.length === 0) {
        return res.json({ success: true, message: 'If that number is registered, an OTP was sent.' });
      }
      await sendOTP(formattedPhone, 'login');
      res.json({ success: true, message: 'OTP sent to your phone.' });
    } catch (err) {
      console.error('[Login OTP]', err.message);
      res.status(500).json({ error: 'Failed to send OTP.' });
    }
  }
);

// ─────────────────────────────────────────────
//  POST /api/auth/login/verify
// ─────────────────────────────────────────────
router.post('/login/verify',
  authLimiter,
  [
    body('phone').notEmpty().trim(),
    body('otp').isLength({ min: 6, max: 6 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const formattedPhone = formatPhone(req.body.phone);
      const otpResult = await verifyOTP(formattedPhone, req.body.otp, 'login');
      if (!otpResult.valid) {
        return res.status(400).json({ error: otpResult.message });
      }

      const result = await query(
        `SELECT id, username, balance, bonus_balance, kyc_status, referral_code
         FROM users WHERE phone = $1 AND is_active = TRUE`,
        [formattedPhone]
      );
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Account not found.' });
      }

      const user = result.rows[0];
      const token = generateToken(user.id);
      res.json({
        success: true,
        token,
        user: {
          id:           user.id,
          username:     user.username,
          balance:      parseFloat(user.balance),
          bonusBalance: parseFloat(user.bonus_balance),
          kycStatus:    user.kyc_status,
          referralCode: user.referral_code,
        },
      });
    } catch (err) {
      console.error('[Login Verify]', err.message);
      res.status(500).json({ error: 'Login failed. Try again.' });
    }
  }
);

module.exports = router;
