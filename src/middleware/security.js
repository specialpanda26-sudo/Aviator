const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const jwt          = require('jsonwebtoken');
const { query }    = require('../../config/db');

// ─────────────────────────────────────────────
//  HELMET — sets secure HTTP headers
// ─────────────────────────────────────────────
const helmetMiddleware = helmet({
  contentSecurityPolicy: false, // relax for API
  crossOriginEmbedderPolicy: false,
});

// ─────────────────────────────────────────────
//  RATE LIMITERS
// ─────────────────────────────────────────────

// General API: 100 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth endpoints: 10 per 15 minutes (prevents brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many auth attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// OTP: 5 per 10 minutes (prevents SMS bombing)
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { error: 'Too many OTP requests. Try again in 10 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Payment: 20 per hour
const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many payment requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─────────────────────────────────────────────
//  JWT AUTH MIDDLEWARE
// ─────────────────────────────────────────────

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch fresh user from DB (catches banned/deleted users mid-session)
    const result = await query(
      `SELECT id, phone, username, balance, bonus_balance, is_admin,
              is_active, kyc_status, self_excluded
       FROM users WHERE id = $1`,
      [decoded.userId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_active) {
      return res.status(401).json({ error: 'Account not found or disabled.' });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ error: 'Invalid authentication token.' });
  }
}

// Admin-only middleware (use after authenticate)
function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// Generate JWT token
function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

module.exports = {
  helmetMiddleware,
  generalLimiter,
  authLimiter,
  otpLimiter,
  paymentLimiter,
  authenticate,
  requireAdmin,
  generateToken,
};
