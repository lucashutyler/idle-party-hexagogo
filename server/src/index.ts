import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { GameLoop } from './game/GameLoop';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set<WebSocket>();

// Create game loop that broadcasts to all connected clients
const gameLoop = new GameLoop(() => {
  const state = JSON.stringify({ type: 'state', ...gameLoop.getState() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(state);
    }
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ...gameLoop.getState() });
});

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`Client connected (${clients.size} total)`);

  // Send current state immediately
  ws.send(JSON.stringify({ type: 'state', ...gameLoop.getState() }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'move' && typeof msg.col === 'number' && typeof msg.row === 'number') {
        const success = gameLoop.handleMove(msg.col, msg.row);
        if (!success) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid move' }));
        }
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected (${clients.size} total)`);
  });
});

const PORT = process.env.PORT ?? 3001;
server.listen(PORT, () => {
  console.log(`Game server listening on port ${PORT}`);
});
