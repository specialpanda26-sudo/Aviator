const axios = require('axios');
const { query } = require('../../config/db');

const INSTASEND_BASE  = process.env.INSTASEND_BASE_URL || 'https://sandbox.instasend.io';
const INSTASEND_KEY   = process.env.INSTASEND_API_KEY;
const INSTASEND_SECRET = process.env.INSTASEND_API_SECRET;

// Instasend authenticated axios instance
const instasend = axios.create({
  baseURL: INSTASEND_BASE,
  headers: {
    'Content-Type': 'application/json',
    'X-INSTASEND-API-TOKEN': INSTASEND_KEY,
  },
  timeout: 30000,
});

/**
 * Initiate M-Pesa STK Push (deposit) via Instasend
 * Instasend handles the Daraja API call for you.
 */
async function initiateDeposit({ userId, phone, amount }) {
  const minBet = parseInt(process.env.MIN_BET) || 10;
  const maxBet = parseInt(process.env.MAX_BET) || 50000;

  if (amount < minBet) throw new Error(`Minimum deposit is KES ${minBet}`);
  if (amount > maxBet) throw new Error(`Maximum deposit is KES ${maxBet}`);

  // Create a pending transaction in DB first
  const txResult = await query(
    `INSERT INTO transactions (user_id, type, amount, status, phone, provider)
     VALUES ($1, 'deposit', $2, 'pending', $3, 'instasend')
     RETURNING id`,
    [userId, amount, phone]
  );
  const transactionId = txResult.rows[0].id;

  try {
    // Call Instasend STK Push endpoint
    const response = await instasend.post('/api/v1/payment/mpesa-stk-push/', {
      amount:           amount,
      phone_number:     phone,
      currency:         'KES',
      api_ref:          transactionId,           // we use our DB tx ID as reference
      redirect_url:     `${process.env.APP_URL}/api/payments/callback`,
      narrative:        'Aviator deposit',
    });

    const { invoice } = response.data;

    // Save the Instasend invoice ID on our transaction
    await query(
      `UPDATE transactions SET provider_ref = $1 WHERE id = $2`,
      [invoice?.invoice_id || invoice?.id, transactionId]
    );

    return {
      success:       true,
      transactionId,
      invoiceId:     invoice?.invoice_id || invoice?.id,
      message:       'STK push sent. Check your phone and enter your M-Pesa PIN.',
    };
  } catch (err) {
    // Mark transaction as failed
    await query(
      `UPDATE transactions SET status = 'failed' WHERE id = $1`,
      [transactionId]
    );
    const msg = err.response?.data?.message || err.message;
    throw new Error('Payment initiation failed: ' + msg);
  }
}

/**
 * Handle Instasend payment callback (webhook)
 * Called by Instasend when M-Pesa payment is confirmed or fails.
 */
async function handlePaymentCallback(payload) {
  const { invoice, customer } = payload;
  const invoiceId   = invoice?.invoice_id || invoice?.id;
  const state       = invoice?.state?.toLowerCase(); // 'complete' | 'failed' | 'pending'
  const mpesaCode   = invoice?.mpesa_receipt || customer?.mpesa_receipt;

  // Find the matching transaction by provider_ref
  const txResult = await query(
    `SELECT * FROM transactions WHERE provider_ref = $1 AND status = 'pending'`,
    [invoiceId]
  );

  if (txResult.rows.length === 0) {
    console.warn('[Callback] No matching pending transaction for invoice:', invoiceId);
    return { ok: false };
  }

  const tx = txResult.rows[0];

  if (state === 'complete') {
    // Credit the user's wallet
    await query('BEGIN');
    try {
      await query(
        `UPDATE transactions
         SET status = 'completed', mpesa_receipt = $1, updated_at = NOW()
         WHERE id = $2`,
        [mpesaCode, tx.id]
      );

      await query(
        `UPDATE users SET balance = balance + $1, updated_at = NOW()
         WHERE id = $2`,
        [tx.amount, tx.user_id]
      );

      // First-deposit bonus: 100% match if first time depositing
      const userResult = await query(
        `SELECT first_deposit_done FROM users WHERE id = $1`,
        [tx.user_id]
      );
      const user = userResult.rows[0];

      if (!user.first_deposit_done && tx.amount >= 150) {
        const bonusAmount = tx.amount; // 100% match
        await query(
          `UPDATE users
           SET bonus_balance = bonus_balance + $1,
               first_deposit_done = TRUE,
               updated_at = NOW()
           WHERE id = $2`,
          [bonusAmount, tx.user_id]
        );
        // Record bonus transaction
        await query(
          `INSERT INTO transactions (user_id, type, amount, status, provider)
           VALUES ($1, 'bonus', $2, 'completed', 'system')`,
          [tx.user_id, bonusAmount]
        );
      } else if (!user.first_deposit_done) {
        await query(
          `UPDATE users SET first_deposit_done = TRUE WHERE id = $1`,
          [tx.user_id]
        );
      }

      // Pay out referral bonus if applicable
      await payReferralBonus(tx.user_id);

      await query('COMMIT');
      console.log(`[Payment] Deposit KES ${tx.amount} confirmed for user ${tx.user_id}`);
      return { ok: true };
    } catch (err) {
      await query('ROLLBACK');
      console.error('[Payment] Callback error:', err.message);
      throw err;
    }
  } else if (state === 'failed' || state === 'cancelled') {
    await query(
      `UPDATE transactions SET status = 'failed', updated_at = NOW() WHERE id = $1`,
      [tx.id]
    );
    return { ok: true };
  }

  return { ok: true }; // still pending
}

/**
 * Initiate withdrawal (sends to admin queue for approval)
 * Actual M-Pesa send is done manually by admin for safety.
 */
async function initiateWithdrawal({ userId, phone, amount }) {
  const min = 100;
  if (amount < min) throw new Error(`Minimum withdrawal is KES ${min}`);

  // Check user balance
  const userResult = await query(
    `SELECT balance, kyc_status FROM users WHERE id = $1`,
    [userId]
  );
  const user = userResult.rows[0];

  if (!user) throw new Error('User not found');
  if (user.kyc_status !== 'verified') throw new Error('KYC verification required before withdrawing');
  if (user.balance < amount) throw new Error('Insufficient balance');

  // Deduct balance and create pending withdrawal
  await query('BEGIN');
  try {
    await query(
      `UPDATE users SET balance = balance - $1, updated_at = NOW() WHERE id = $2`,
      [amount, userId]
    );
    const txResult = await query(
      `INSERT INTO transactions (user_id, type, amount, status, phone, provider)
       VALUES ($1, 'withdrawal', $2, 'pending', $3, 'instasend')
       RETURNING id`,
      [userId, amount, phone]
    );
    await query('COMMIT');
    return {
      success:       true,
      transactionId: txResult.rows[0].id,
      message:       'Withdrawal request submitted. Admin will process within 24 hours.',
    };
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }
}

/**
 * Admin approves a withdrawal — triggers actual M-Pesa send via Instasend
 */
async function approveWithdrawal({ transactionId, adminId }) {
  const txResult = await query(
    `SELECT * FROM transactions WHERE id = $1 AND type = 'withdrawal' AND status = 'pending'`,
    [transactionId]
  );
  if (txResult.rows.length === 0) throw new Error('Transaction not found or already processed');

  const tx = txResult.rows[0];

  try {
    // Send money via Instasend B2C (Business to Customer)
    const response = await instasend.post('/api/v1/send-money/mpesa-b2c/', {
      currency:     'KES',
      transactions: [{
        account:  tx.phone,
        amount:   tx.amount,
        narrative: 'Aviator withdrawal',
      }],
    });

    const ref = response.data?.transactions?.[0]?.status_code || 'sent';

    await query(
      `UPDATE transactions
       SET status = 'completed',
           provider_ref = $1,
           reviewed_by = $2,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $3`,
      [ref, adminId, transactionId]
    );
    return { success: true };
  } catch (err) {
    // Refund user on failure
    await query(
      `UPDATE users SET balance = balance + $1 WHERE id = $2`,
      [tx.amount, tx.user_id]
    );
    await query(
      `UPDATE transactions SET status = 'failed', reviewed_by = $1, reviewed_at = NOW()
       WHERE id = $2`,
      [adminId, transactionId]
    );
    throw new Error('Withdrawal send failed: ' + (err.response?.data?.message || err.message));
  }
}

// Pay referral bonuses on first deposit
async function payReferralBonus(userId) {
  const refResult = await query(
    `SELECT * FROM referrals WHERE referred_id = $1 AND paid_out = FALSE`,
    [userId]
  );
  if (refResult.rows.length === 0) return;

  const ref = refResult.rows[0];
  await query(
    `UPDATE users SET balance = balance + $1 WHERE id = $2`,
    [ref.referrer_bonus, ref.referrer_id]
  );
  await query(
    `UPDATE users SET balance = balance + $1 WHERE id = $2`,
    [ref.referred_bonus, ref.referred_id]
  );
  await query(
    `UPDATE referrals SET paid_out = TRUE WHERE id = $1`,
    [ref.id]
  );
  await query(
    `INSERT INTO transactions (user_id, type, amount, status, provider)
     VALUES ($1, 'referral', $2, 'completed', 'system'),
            ($3, 'referral', $4, 'completed', 'system')`,
    [ref.referrer_id, ref.referrer_bonus, ref.referred_id, ref.referred_bonus]
  );
}

module.exports = { initiateDeposit, handlePaymentCallback, initiateWithdrawal, approveWithdrawal };
