require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const morgan     = require('morgan');
const compression = require('compression');

const { helmetMiddleware, generalLimiter } = require('./middleware/security');
const authRoutes    = require('./routes/auth');
const paymentRoutes = require('./routes/payments');
const userRoutes    = require('./routes/user');
const { router: gameRouter, attachSocketHandlers } = require('./routes/game');
const gameService   = require('./services/gameService');

const app    = express();
const server = http.createServer(app);

// ─────────────────────────────────────────────
//  Socket.io — real-time game events
// ─────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin:      process.env.FRONTEND_URL || '*',
    methods:     ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout:  30000,
  pingInterval: 10000,
});

// ─────────────────────────────────────────────
//  Middleware
// ─────────────────────────────────────────────
app.use(helmetMiddleware);
app.use(compression());
app.use(cors({
  origin:      process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(generalLimiter);

// ─────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/user',     userRoutes);
app.use('/api/game',     gameRouter);

// Health check (Railway/Render use this to verify the app is alive)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('[Error]', err.stack);
  res.status(500).json({ error: 'Internal server error.' });
});

// ─────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`\n🚀 Aviator backend running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);

  // Attach Socket.io handlers THEN start game engine
  attachSocketHandlers(io);
  gameService.init(io);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  server.close(() => process.exit(0));
});
