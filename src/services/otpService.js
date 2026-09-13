const AfricasTalking = require('africastalking');
const { query } = require('../../config/db');

// Initialize Africa's Talking
const AT = AfricasTalking({
  username: process.env.AT_USERNAME,  // 'sandbox' for testing
  apiKey:   process.env.AT_API_KEY,
});
const sms = AT.SMS;

// Generate a 6-digit OTP code
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Format phone to international format for Kenya (+254...)
function formatPhone(phone) {
  phone = phone.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
  if (phone.startsWith('07') || phone.startsWith('01')) {
    return '+254' + phone.substring(1);
  }
  if (phone.startsWith('254')) return '+' + phone;
  if (phone.startsWith('+254')) return phone;
  return phone;
}

/**
 * Send OTP to phone number
 * @param {string} phone - Phone number
 * @param {string} purpose - 'register' | 'login' | 'withdraw'
 */
async function sendOTP(phone, purpose) {
  const formattedPhone = formatPhone(phone);
  const code = generateOTP();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  // Invalidate any existing unused OTPs for this phone+purpose
  await query(
    `UPDATE otp_codes SET used = TRUE
     WHERE phone = $1 AND purpose = $2 AND used = FALSE`,
    [formattedPhone, purpose]
  );

  // Store new OTP in DB
  await query(
    `INSERT INTO otp_codes (phone, code, purpose, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [formattedPhone, code, purpose, expiresAt]
  );

  const messages = {
    register: `Your Aviator verification code is: ${code}. Valid for 5 minutes. Do not share this code.`,
    login:    `Your Aviator login code is: ${code}. Valid for 5 minutes. Do not share this code.`,
    withdraw: `Your Aviator withdrawal confirmation code is: ${code}. Valid for 5 minutes. Do not share this code.`,
  };

  // Send SMS via Africa's Talking
  // In sandbox mode this logs to their sandbox dashboard (free)
  if (process.env.NODE_ENV === 'production') {
    await sms.send({
      to:      [formattedPhone],
      message: messages[purpose] || `Your code is: ${code}`,
      from:    'AVIATOR',  // Register a shortcode with AT for production
    });
  } else {
    // Development: just log to console (no SMS sent, saves credits)
    console.log(`[DEV OTP] ${formattedPhone} → ${code} (${purpose})`);
  }

  return { success: true, phone: formattedPhone };
}

/**
 * Verify OTP code
 * @param {string} phone
 * @param {string} code
 * @param {string} purpose
 */
async function verifyOTP(phone, code, purpose) {
  const formattedPhone = formatPhone(phone);

  const result = await query(
    `SELECT id FROM otp_codes
     WHERE phone = $1
       AND code = $2
       AND purpose = $3
       AND used = FALSE
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [formattedPhone, code, purpose]
  );

  if (result.rows.length === 0) {
    return { valid: false, message: 'Invalid or expired OTP code.' };
  }

  // Mark as used
  await query(
    `UPDATE otp_codes SET used = TRUE WHERE id = $1`,
    [result.rows[0].id]
  );

  return { valid: true };
}

module.exports = { sendOTP, verifyOTP, formatPhone };
