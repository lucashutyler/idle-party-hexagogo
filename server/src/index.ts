import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { GameLoop } from './game/GameLoop';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const gameLoop = new GameLoop();
const { playerManager } = gameLoop;

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    sessions: playerManager.sessionCount,
    connections: playerManager.connectionCount,
  });
});

wss.on('connection', (ws) => {
  console.log(`WebSocket connected (awaiting login)`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'login' && typeof msg.username === 'string') {
        const username = msg.username.trim();

        if (!username || username.length > 20) {
          ws.send(JSON.stringify({ type: 'login_error', message: 'Username must be 1-20 characters' }));
          return;
        }

        if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
          ws.send(JSON.stringify({ type: 'login_error', message: 'Username may only contain letters, numbers, hyphens, and underscores' }));
          return;
        }

        const session = playerManager.login(ws, username);

        ws.send(JSON.stringify({ type: 'login_success', username: session.username }));

        // Send initial state immediately
        playerManager.sendStateToPlayer(username);
        return;
      }

      if (msg.type === 'request_state') {
        const username = playerManager.getUsernameForWs(ws);
        if (username) {
          playerManager.sendStateToPlayer(username);
        }
        return;
      }

      if (msg.type === 'move' && typeof msg.col === 'number' && typeof msg.row === 'number') {
        const session = playerManager.getSession(ws);
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not logged in' }));
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

const PORT = process.env.PORT ?? 3001;
server.listen(PORT, () => {
  console.log(`Game server listening on port ${PORT}`);
});
