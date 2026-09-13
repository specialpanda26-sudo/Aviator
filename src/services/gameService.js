const crypto = require('crypto');
const { query } = require('../../config/db');

const HOUSE_EDGE  = parseFloat(process.env.HOUSE_EDGE)  || 0.05;
const MIN_BET     = parseFloat(process.env.MIN_BET)     || 10;
const MAX_BET     = parseFloat(process.env.MAX_BET)     || 50000;
const MIN_CASHOUT = parseFloat(process.env.MIN_CASHOUT) || 1.01;

// Round phases
const PHASE = { WAITING: 'waiting', FLYING: 'flying', CRASHED: 'crashed' };

// Timings (ms)
const WAITING_MS = 5000;   // 5s betting window
const TICK_MS    = 100;    // how often we update multiplier

let io; // Socket.io instance — set via init()

// ─────────────────────────────────────────────
//  PROVABLY FAIR CRASH CALCULATION
//  Based on the algorithm used by Bustadice / common Aviator implementations.
//  Server seed is generated, hashed → hash shared with players BEFORE round.
//  After round, seed is revealed so anyone can verify the result.
// ─────────────────────────────────────────────

function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function hashSeed(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

/**
 * Calculate crash multiplier from server seed.
 * Formula: use HMAC-SHA256 of seed, convert to a number, apply house edge.
 */
function calculateCrashPoint(serverSeed) {
  const hmac  = crypto.createHmac('sha256', serverSeed);
  hmac.update('aviator');
  const hash  = hmac.digest('hex');

  // Take first 8 hex chars, convert to integer
  const h = parseInt(hash.substring(0, 8), 16);

  // Instant crash (house keeps bet) — happens ~4.7% of the time with 5% edge
  if (h % 33 === 0) return 1.00;

  // Scale to a crash point ≥ 1.01 with house edge baked in
  const e = Math.pow(2, 32);
  const result = Math.floor((100 * e - h) / (e - h)) / 100;

  return Math.max(MIN_CASHOUT, result);
}

// ─────────────────────────────────────────────
//  GAME STATE
// ─────────────────────────────────────────────
let currentRound   = null;
let multiplier     = 1.00;
let gameInterval   = null;
let roundStartTime = null;
let activeBets     = new Map(); // userId → { betId, amount, autoCashout }

// ─────────────────────────────────────────────
//  ROUND LIFECYCLE
// ─────────────────────────────────────────────

async function startNewRound() {
  // Generate provably fair seed
  const serverSeed = generateServerSeed();
  const seedHash   = hashSeed(serverSeed);
  const crashAt    = calculateCrashPoint(serverSeed);

  // Save round to DB
  const result = await query(
    `INSERT INTO game_rounds (seed_hash, server_seed, crash_at, status)
     VALUES ($1, $2, $3, 'waiting')
     RETURNING *`,
    [seedHash, serverSeed, crashAt]
  );
  currentRound = result.rows[0];
  multiplier   = 1.00;
  activeBets   = new Map();

  // Broadcast waiting phase — share the hash so players can verify later
  io.emit('round:waiting', {
    roundId:  currentRound.id,
    seedHash: currentRound.seed_hash,
    startsIn: WAITING_MS / 1000,
  });

  console.log(`[Game] Round ${currentRound.id} | Crash @ ${crashAt}x | Waiting ${WAITING_MS}ms`);

  // After waiting period, start flying
  setTimeout(startFlying, WAITING_MS);
}

async function startFlying() {
  if (!currentRound) return;

  await query(
    `UPDATE game_rounds SET status = 'flying', started_at = NOW() WHERE id = $1`,
    [currentRound.id]
  );
  currentRound.status = PHASE.FLYING;
  roundStartTime = Date.now();

  io.emit('round:started', { roundId: currentRound.id });

  // Tick: increase multiplier and check for auto-cashouts
  gameInterval = setInterval(async () => {
    const elapsed = (Date.now() - roundStartTime) / 1000;
    // Exponential growth: x = e^(0.06 * t)  — same feel as real Aviator
    multiplier = parseFloat(Math.pow(Math.E, 0.06 * elapsed).toFixed(2));

    io.emit('round:tick', { multiplier });

    // Crash check
    if (multiplier >= currentRound.crash_at) {
      multiplier = currentRound.crash_at;
      clearInterval(gameInterval);
      await crashRound();
      return;
    }

    // Process auto-cashouts
    for (const [userId, bet] of activeBets.entries()) {
      if (bet.autoCashout && multiplier >= bet.autoCashout) {
        await processCashout(userId, multiplier);
      }
    }
  }, TICK_MS);
}

async function crashRound() {
  if (!currentRound) return;

  // Bust all remaining active bets (they lose)
  for (const [userId, bet] of activeBets.entries()) {
    await query(
      `UPDATE bets SET status = 'lost', updated_at = NOW() WHERE id = $1`,
      [bet.betId]
    );
  }
  activeBets.clear();

  await query(
    `UPDATE game_rounds
     SET status = 'crashed', crashed_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [currentRound.id]
  );

  // Reveal the server seed so players can verify
  io.emit('round:crashed', {
    roundId:    currentRound.id,
    crashAt:    currentRound.crash_at,
    serverSeed: currentRound.server_seed,  // revealed after crash
    seedHash:   currentRound.seed_hash,
  });

  console.log(`[Game] Round ${currentRound.id} CRASHED @ ${currentRound.crash_at}x`);

  // Wait 3s then start next round
  setTimeout(startNewRound, 3000);
}

// ─────────────────────────────────────────────
//  BET PLACEMENT
// ─────────────────────────────────────────────

async function placeBet({ userId, amount, autoCashout }) {
  if (!currentRound || currentRound.status !== PHASE.WAITING) {
    throw new Error('Betting window is closed. Wait for next round.');
  }
  if (activeBets.has(userId)) {
    throw new Error('You already have a bet in this round.');
  }
  if (amount < MIN_BET) throw new Error(`Minimum bet is KES ${MIN_BET}`);
  if (amount > MAX_BET) throw new Error(`Maximum bet is KES ${MAX_BET}`);

  // Check balance & deduct
  const userResult = await query(
    `SELECT balance, self_excluded, daily_limit FROM users WHERE id = $1`,
    [userId]
  );
  const user = userResult.rows[0];

  if (!user) throw new Error('User not found');
  if (user.self_excluded) throw new Error('Your account is self-excluded.');
  if (user.balance < amount) throw new Error('Insufficient balance.');

  // Daily limit check
  if (user.daily_limit !== null) {
    const todayDeposits = await query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
       WHERE user_id = $1 AND type = 'deposit' AND status = 'completed'
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [userId]
    );
    if (parseFloat(todayDeposits.rows[0].total) > user.daily_limit) {
      throw new Error('Daily deposit limit reached.');
    }
  }

  await query('BEGIN');
  try {
    await query(
      `UPDATE users SET balance = balance - $1 WHERE id = $2`,
      [amount, userId]
    );
    const betResult = await query(
      `INSERT INTO bets (user_id, round_id, amount, auto_cashout, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id`,
      [userId, currentRound.id, amount, autoCashout || null]
    );
    await query('COMMIT');

    activeBets.set(userId, {
      betId:       betResult.rows[0].id,
      amount,
      autoCashout: autoCashout || null,
    });

    return { success: true, betId: betResult.rows[0].id };
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }
}

// ─────────────────────────────────────────────
//  CASHOUT
// ─────────────────────────────────────────────

async function processCashout(userId, cashedOutAt) {
  const bet = activeBets.get(userId);
  if (!bet) throw new Error('No active bet found.');
  if (currentRound?.status !== PHASE.FLYING) throw new Error('Round is not active.');

  const payout = parseFloat((bet.amount * cashedOutAt).toFixed(2));

  activeBets.delete(userId);

  await query('BEGIN');
  try {
    await query(
      `UPDATE bets
       SET status = 'won', cashed_out_at = $1, payout = $2, updated_at = NOW()
       WHERE id = $3`,
      [cashedOutAt, payout, bet.betId]
    );
    await query(
      `UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
      [payout, userId]
    );
    await query('COMMIT');

    io.to(userId).emit('cashout:success', {
      multiplier: cashedOutAt,
      payout,
    });

    return { success: true, payout };
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }
}

// ─────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────

function getCurrentState() {
  return {
    roundId:    currentRound?.id || null,
    status:     currentRound?.status || PHASE.WAITING,
    multiplier,
    seedHash:   currentRound?.seed_hash || null,
  };
}

function init(socketIo) {
  io = socketIo;
  startNewRound();
  console.log('[Game] Engine started ✓');
}

module.exports = { init, placeBet, processCashout, getCurrentState };
