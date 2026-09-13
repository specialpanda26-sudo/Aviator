const express     = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/security');
const gameService = require('../services/gameService');
const { query }   = require('../../config/db');

const router = express.Router();

// ─────────────────────────────────────────────
//  GET /api/game/state
//  Returns current round state for new connections
// ─────────────────────────────────────────────
router.get('/state', authenticate, (req, res) => {
  res.json(gameService.getCurrentState());
});

// ─────────────────────────────────────────────
//  POST /api/game/bet
// ─────────────────────────────────────────────
router.post('/bet',
  authenticate,
  [
    body('amount').isFloat({ min: 10 }),
    body('auto_cashout').optional().isFloat({ min: 1.01 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const result = await gameService.placeBet({
        userId:      req.user.id,
        amount:      parseFloat(req.body.amount),
        autoCashout: req.body.auto_cashout ? parseFloat(req.body.auto_cashout) : null,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────────
//  POST /api/game/cashout
// ─────────────────────────────────────────────
router.post('/cashout', authenticate, async (req, res) => {
  try {
    const state = gameService.getCurrentState();
    const result = await gameService.processCashout(req.user.id, state.multiplier);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  GET /api/game/history
//  Recent rounds (for the history ticker in UI)
// ─────────────────────────────────────────────
router.get('/history', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, crash_at, started_at, crashed_at, seed_hash, server_seed
       FROM game_rounds
       WHERE status = 'crashed'
       ORDER BY crashed_at DESC
       LIMIT 50`
    );
    res.json({ rounds: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history.' });
  }
});

// ─────────────────────────────────────────────
//  GET /api/game/my-bets
//  Authenticated user's bet history
// ─────────────────────────────────────────────
router.get('/my-bets', authenticate, async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const result = await query(
      `SELECT b.*, r.crash_at, r.started_at
       FROM bets b
       JOIN game_rounds r ON b.round_id = r.id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );
    res.json({ bets: result.rows, page, limit });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bet history.' });
  }
});

// ─────────────────────────────────────────────
//  GET /api/game/leaderboard
//  Top winners today
// ─────────────────────────────────────────────
router.get('/leaderboard', async (req, res) => {
  try {
    const result = await query(
      `SELECT u.username,
              SUM(b.payout) AS total_payout,
              COUNT(b.id)   AS total_bets,
              MAX(b.cashed_out_at) AS biggest_multiplier
       FROM bets b
       JOIN users u ON b.user_id = u.id
       WHERE b.status = 'won'
         AND b.created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY u.id, u.username
       ORDER BY total_payout DESC
       LIMIT 10`
    );
    res.json({ leaderboard: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leaderboard.' });
  }
});

// ─────────────────────────────────────────────
//  Socket.io handler — attach to io in server.js
// ─────────────────────────────────────────────
function attachSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    // Send current game state immediately on connect
    socket.emit('game:state', gameService.getCurrentState());

    // Join user's private room for cashout confirmations
    socket.on('auth', (token) => {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.join(decoded.userId); // join private room by userId
        socket.userId = decoded.userId;
        socket.emit('auth:ok');
      } catch {
        socket.emit('auth:error', 'Invalid token');
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Socket] Disconnected: ${socket.id}`);
    });
  });
}

module.exports = { router, attachSocketHandlers };
