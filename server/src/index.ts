import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import session from 'express-session';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import type { IncomingMessage } from 'http';
import { GameLoop } from './game/GameLoop.js';
import { JsonFileStore } from './game/JsonFileStore.js';
import { AccountStore } from './auth/AccountStore.js';
import { TokenStore } from './auth/TokenStore.js';
import { createAuthRoutes } from './auth/authRoutes.js';

const app = express();
const server = createServer(app);

// --- Stores ---
const store = new JsonFileStore();
const accountStore = new AccountStore();
const tokenStore = new TokenStore();
const gameLoop = new GameLoop(store);
const { playerManager } = gameLoop;

// --- Session middleware ---
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET ?? 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
});

// --- Express middleware ---
app.use(cors({
  origin: process.env.APP_URL ?? 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());
app.use(sessionMiddleware);

// --- Routes ---
app.use('/auth', createAuthRoutes({
  accountStore,
  tokenStore,
  onRenamePlayer: (oldUsername, newUsername) => {
    playerManager.renamePlayer(oldUsername, newUsername);
  },
}));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    sessions: playerManager.sessionCount,
    connections: playerManager.connectionCount,
  });
});

// --- Static files (production: serve built client) ---
if (process.env.NODE_ENV === 'production') {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  // SPA fallback — serve index.html for any non-API route
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// --- WebSocket with session auth ---
const wss = new WebSocketServer({ noServer: true });

/**
 * Parse the session from an HTTP upgrade request.
 * Returns the session's username if authenticated, or null.
 */
function getSessionUsername(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    // Use express-session middleware to parse the cookie
    const res = { end() {} } as any;
    sessionMiddleware(req as any, res, () => {
      const sess = (req as any).session;
      resolve(sess?.username ?? null);
    });
  });
}

server.on('upgrade', async (req, socket, head) => {
  const username = await getSessionUsername(req);

  if (!username) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    (ws as any)._username = username;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const username: string = (ws as any)._username;
  console.log(`WebSocket connected for "${username}"`);

  // Register the connection and send initial state
  playerManager.login(ws, username);
  playerManager.sendStateToPlayer(username);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'request_state') {
        playerManager.sendStateToPlayer(username);
        return;
      }

      if (msg.type === 'move' && typeof msg.col === 'number' && typeof msg.row === 'number') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'No session' }));
          return;
        }

        const success = session.handleMove(msg.col, msg.row);
        if (!success) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid move' }));
        }
        return;
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    playerManager.removeConnection(ws);
  });
});

// --- Start ---
const PORT = process.env.PORT ?? 3001;

async function start() {
  await accountStore.load();
  tokenStore.start();
  await gameLoop.init();

  server.listen(PORT, () => {
    console.log(`Game server listening on port ${PORT}`);
  });
}

async function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down...`);
  tokenStore.stop();
  await gameLoop.shutdown();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
