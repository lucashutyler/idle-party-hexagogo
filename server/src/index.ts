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
import { createAdminRoutes } from './admin/adminRoutes.js';
import { JsonSessionStore } from './auth/JsonSessionStore.js';
import type { ChatMessage } from '@idle-party-rpg/shared';
import { canMove } from './game/social/PartySystem.js';

const app = express();
const server = createServer(app);

// --- Stores ---
const store = new JsonFileStore();
const sessionStore = new JsonSessionStore('data/sessions');
const accountStore = new AccountStore();
const tokenStore = new TokenStore();
const gameLoop = new GameLoop(store, accountStore);
const { playerManager } = gameLoop;

// Trust first proxy (nginx/Cloudflare) so secure cookies work behind reverse proxy
app.set('trust proxy', 1);

// --- Session middleware ---
const sessionMiddleware = session({
  store: sessionStore,
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
  origin: [
    process.env.APP_URL ?? 'http://localhost:3000',
    process.env.ADMIN_URL ?? 'http://localhost:3002',
  ],
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

// --- Admin routes (game manager) ---
app.use('/admin', createAdminRoutes({
  contentStore: gameLoop.contentStore,
  gameLoop,
}));

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

  if (!username || username === 'undefined') {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    (ws as any)._username = username;
    wss.emit('connection', ws, req);
  });
});

/** Sync friend lists and outgoing requests for both players, then broadcast state. */
function syncFriendState(a: string, b: string): void {
  const sessionA = playerManager.getSessionByUsername(a);
  if (sessionA) {
    sessionA.setFriends(playerManager.friends.getFriends(a));
    sessionA.setOutgoingFriendRequests(playerManager.friends.getOutgoingRequests(a));
  }
  playerManager.sendStateToPlayer(a);

  const sessionB = playerManager.getSessionByUsername(b);
  if (sessionB) {
    sessionB.setFriends(playerManager.friends.getFriends(b));
    sessionB.setOutgoingFriendRequests(playerManager.friends.getOutgoingRequests(b));
  }
  playerManager.sendStateToPlayer(b);
}

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

        const partyId = session.getPartyId();
        if (!partyId) {
          ws.send(JSON.stringify({ type: 'error', message: 'No party' }));
          return;
        }

        // Only owners and leaders can move the party
        const party = playerManager.parties.getParty(partyId);
        if (party) {
          const member = party.members.find(m => m.username === username);
          if (!member || !canMove(member.role)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Only owners and leaders can move' }));
            return;
          }
        }

        const success = playerManager.partyBattles.handleMove(partyId, msg.col, msg.row);
        if (!success) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid move' }));
        }
        return;
      }

      if (msg.type === 'set_priority_stat') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'No session' }));
          return;
        }

        const validStats = ['STR', 'INT', 'WIS', 'DEX', 'CON', 'CHA'];
        const stat = msg.stat;
        if (stat !== null && !validStats.includes(stat)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid stat' }));
          return;
        }

        session.setPriorityStat(stat);
        return;
      }

      if (msg.type === 'equip_item' && typeof msg.itemId === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'No session' }));
          return;
        }

        if (!session.handleEquipItem(msg.itemId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Cannot equip item' }));
        }
        return;
      }

      if (msg.type === 'unequip_item' && typeof msg.slot === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'No session' }));
          return;
        }

        const validSlots = ['head', 'chest', 'hand', 'foot'];
        if (!validSlots.includes(msg.slot)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid slot' }));
          return;
        }

        if (!session.handleUnequipItem(msg.slot)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Cannot unequip item' }));
        }
        return;
      }

      // --- Social messages ---

      if (msg.type === 'send_friend_request' && typeof msg.username === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        const target = msg.username;
        if (!accountStore.findByUsername(target)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Player not found' }));
          return;
        }
        const result = playerManager.friends.sendRequest(username, target);
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        syncFriendState(username, target);
        return;
      }

      if (msg.type === 'accept_friend_request' && typeof msg.username === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        const result = playerManager.friends.acceptRequest(username, msg.username);
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        syncFriendState(username, msg.username);
        return;
      }

      if (msg.type === 'decline_friend_request' && typeof msg.username === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        const result = playerManager.friends.declineRequest(username, msg.username);
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        syncFriendState(username, msg.username);
        return;
      }

      if (msg.type === 'revoke_friend_request' && typeof msg.username === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        const result = playerManager.friends.revokeRequest(username, msg.username);
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        syncFriendState(username, msg.username);
        return;
      }

      if (msg.type === 'remove_friend' && typeof msg.username === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        playerManager.friends.removeFriend(username, msg.username);
        syncFriendState(username, msg.username);
        return;
      }

      if (msg.type === 'block_user' && typeof msg.username === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        const validLevels = ['dm', 'all'];
        if (!validLevels.includes(msg.level)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid block level' }));
          return;
        }
        const blocked = session.getBlockedUsers();
        blocked[msg.username] = msg.level;
        session.setBlockedUsers(blocked);
        playerManager.sendStateToPlayer(username);
        return;
      }

      if (msg.type === 'unblock_user' && typeof msg.username === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        const blocked = session.getBlockedUsers();
        delete blocked[msg.username];
        session.setBlockedUsers(blocked);
        playerManager.sendStateToPlayer(username);
        return;
      }

      // --- Guild messages ---

      if (msg.type === 'create_guild' && typeof msg.name === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        const result = playerManager.guilds.createGuild(username, msg.name, session.getLevel());
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        session.setGuildId(result.id);
        playerManager.sendStateToPlayer(username);
        return;
      }

      if (msg.type === 'join_guild' && typeof msg.guildId === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        const result = playerManager.guilds.joinGuild(username, msg.guildId);
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        session.setGuildId(msg.guildId);
        playerManager.sendStateToPlayer(username);
        return;
      }

      if (msg.type === 'leave_guild') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        const result = playerManager.guilds.leaveGuild(username);
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        session.setGuildId(null);
        playerManager.sendStateToPlayer(username);
        return;
      }

      if (msg.type === 'invite_guild' && typeof msg.username === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        const guildId = session.getGuildId();
        if (!guildId) {
          ws.send(JSON.stringify({ type: 'error', message: 'You are not in a guild' }));
          return;
        }
        const targetSession = playerManager.getSessionByUsername(msg.username);
        if (!targetSession) {
          ws.send(JSON.stringify({ type: 'error', message: 'Player not found' }));
          return;
        }
        const result = playerManager.guilds.joinGuild(msg.username, guildId);
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        targetSession.setGuildId(guildId);
        playerManager.sendStateToPlayer(username);
        playerManager.sendStateToPlayer(msg.username);
        return;
      }

      // --- Chat messages ---

      if (msg.type === 'send_chat' && typeof msg.text === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;

        const channelType = msg.channelType;
        const channelId = msg.channelId;
        const validTypes = ['tile', 'zone', 'party', 'guild', 'dm', 'global'];
        if (!validTypes.includes(channelType)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid channel type' }));
          return;
        }

        // Build recipient list based on channel type
        const recipients: { username: string; send: (m: any) => void }[] = [];
        const blockedMap = playerManager.getAllBlockedUsers();

        if (channelType === 'zone') {
          // All players in the same zone
          for (const [u, s] of Array.from(playerManager['sessions'] as Map<string, any>)) {
            if (u === username) continue;
            if (s.getZone() === channelId) {
              recipients.push({ username: u, send: (m: any) => playerManager.sendChatToPlayer(u, m) });
            }
          }
        } else if (channelType === 'dm') {
          // Direct message to specific user — account must exist
          if (!accountStore.findByUsername(channelId)) {
            ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
            return;
          }
          recipients.push({ username: channelId, send: (m: any) => playerManager.sendChatToPlayer(channelId, m) });
        } else if (channelType === 'guild') {
          // All guild members
          const guildData = playerManager.guilds.getGuild(channelId);
          if (guildData) {
            for (const m of guildData.members) {
              if (m.username === username) continue;
              recipients.push({ username: m.username, send: (msg: any) => playerManager.sendChatToPlayer(m.username, msg) });
            }
          }
        } else if (channelType === 'party') {
          // All party members
          const partyId = session.getPartyId();
          if (partyId) {
            const party = playerManager.parties.getParty(partyId);
            if (party) {
              for (const m of party.members) {
                if (m.username === username) continue;
                recipients.push({ username: m.username, send: (msg: any) => playerManager.sendChatToPlayer(m.username, msg) });
              }
            }
          }
        } else if (channelType === 'tile') {
          // All players on the same tile
          const pos = session.getPosition();
          for (const [u, s] of Array.from(playerManager['sessions'] as Map<string, any>)) {
            if (u === username) continue;
            const otherPos = s.getPosition();
            if (otherPos.col === pos.col && otherPos.row === pos.row) {
              recipients.push({ username: u, send: (m: any) => playerManager.sendChatToPlayer(u, m) });
            }
          }
        } else if (channelType === 'global') {
          // All online players
          for (const u of playerManager.getOnlinePlayers()) {
            if (u === username) continue;
            recipients.push({ username: u, send: (m: any) => playerManager.sendChatToPlayer(u, m) });
          }
        }

        // Also send back to sender
        const chatMsg = playerManager.chat.sendMessage(username, channelType, channelId, msg.text, recipients, blockedMap);
        if (chatMsg) {
          playerManager.sendChatToPlayer(username, chatMsg);
        }
        return;
      }

      if (msg.type === 'request_chat_history') {
        const channelType = msg.channelType;
        const channelId = msg.channelId;
        const validTypes = ['tile', 'zone', 'party', 'guild', 'dm', 'global'];
        if (!validTypes.includes(channelType)) return;

        const session = playerManager.getSessionByUsername(username);
        if (!session) return;

        // Return from the player's personal chat history
        let messages: ChatMessage[];
        if (channelType === 'dm') {
          if (channelId) {
            // For DMs with a specific target, match either direction
            messages = session.getChatHistory().filter(m =>
              m.channelType === 'dm' && (m.channelId === channelId || m.senderUsername === channelId)
            );
          } else {
            // No target specified — return ALL DMs
            messages = session.getChatHistory().filter(m => m.channelType === 'dm');
          }
        } else {
          messages = session.getChatHistory(channelType);
        }

        ws.send(JSON.stringify({
          type: 'chat_history',
          channelType,
          channelId,
          messages,
        }));
        return;
      }

      // --- Party messages ---

      if (msg.type === 'create_party') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        const result = playerManager.parties.createParty(
          username,
          (u) => playerManager.getSessionByUsername(u)?.getPartyId() ?? null,
          (u, id) => playerManager.getSessionByUsername(u)?.setPartyId(id ?? null),
        );
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        playerManager.sendStateToPlayer(username);
        return;
      }

      if (msg.type === 'invite_party' && typeof msg.username === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        const targetSession = playerManager.getSessionByUsername(msg.username);
        if (!targetSession) {
          ws.send(JSON.stringify({ type: 'error', message: 'Player not found' }));
          return;
        }
        const result = playerManager.parties.inviteToParty(
          username,
          msg.username,
          (u) => playerManager.getSessionByUsername(u)?.getPartyId() ?? null,
          (a, b) => playerManager.areSameTile(a, b),
        );
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        // Notify the target they have a pending invite
        playerManager.sendStateToPlayer(msg.username);
        return;
      }

      if (msg.type === 'accept_party_invite' && typeof msg.partyId === 'string') {
        const session = playerManager.getSessionByUsername(username);
        const oldPartyId = session?.getPartyId() ?? null;

        const result = playerManager.parties.acceptInvite(
          username,
          msg.partyId,
          (u) => playerManager.getSessionByUsername(u)?.getPartyId() ?? null,
          (u, id) => playerManager.getSessionByUsername(u)?.setPartyId(id ?? null),
          (a, b) => playerManager.areSameTile(a, b),
        );
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        // Wire party battle join
        playerManager.handlePartyJoin(username, msg.partyId, oldPartyId);
        // Notify all members of the joined party
        for (const m of result.joined.members) {
          playerManager.sendStateToPlayer(m.username);
        }
        return;
      }

      if (msg.type === 'decline_party_invite' && typeof msg.partyId === 'string') {
        playerManager.parties.declineInvite(username, msg.partyId);
        playerManager.sendStateToPlayer(username);
        return;
      }

      if (msg.type === 'leave_party') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        const partyId = session.getPartyId();
        // Get other members before leaving (to notify them)
        const party = partyId ? playerManager.parties.getParty(partyId) : null;
        const otherMembers = party ? party.members.filter(m => m.username !== username) : [];

        const result = playerManager.parties.leaveParty(
          username,
          (u) => playerManager.getSessionByUsername(u)?.getPartyId() ?? null,
          (u, id) => playerManager.getSessionByUsername(u)?.setPartyId(id ?? null),
        );
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        // Handle party battle leave (removes from shared combat, creates solo party)
        if (partyId) {
          playerManager.handlePartyLeave(username, partyId);
        } else {
          playerManager.ensureParty(username);
        }
        playerManager.sendStateToPlayer(username);
        for (const m of otherMembers) {
          playerManager.sendStateToPlayer(m.username);
        }
        return;
      }

      if (msg.type === 'kick_party_member' && typeof msg.username === 'string') {
        const session = playerManager.getSessionByUsername(username);
        if (!session) return;
        const partyId = session.getPartyId();

        const result = playerManager.parties.kickMember(
          username,
          msg.username,
          (u) => playerManager.getSessionByUsername(u)?.getPartyId() ?? null,
          (u, id) => playerManager.getSessionByUsername(u)?.setPartyId(id ?? null),
        );
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        // Handle party battle leave for the kicked player
        if (partyId) {
          playerManager.handlePartyLeave(msg.username, partyId);
        } else {
          playerManager.ensureParty(msg.username);
        }
        playerManager.sendStateToPlayer(username);
        playerManager.sendStateToPlayer(msg.username);
        return;
      }

      if (msg.type === 'set_party_grid_position' && typeof msg.position === 'number') {
        const result = playerManager.parties.setGridPosition(
          username,
          msg.position,
          (u) => playerManager.getSessionByUsername(u)?.getPartyId() ?? null,
        );
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        const session = playerManager.getSessionByUsername(username);
        const partyId = session?.getPartyId();
        if (partyId) {
          const party = playerManager.parties.getParty(partyId);
          if (party) {
            for (const m of party.members) {
              playerManager.sendStateToPlayer(m.username);
            }
          }
        }
        return;
      }

      if (msg.type === 'promote_party_leader' && typeof msg.username === 'string') {
        const result = playerManager.parties.promoteLeader(
          username,
          msg.username,
          (u) => playerManager.getSessionByUsername(u)?.getPartyId() ?? null,
        );
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        const session = playerManager.getSessionByUsername(username);
        const partyId = session?.getPartyId();
        if (partyId) {
          const party = playerManager.parties.getParty(partyId);
          if (party) {
            for (const m of party.members) {
              playerManager.sendStateToPlayer(m.username);
            }
          }
        }
        return;
      }

      if (msg.type === 'demote_party_member' && typeof msg.username === 'string') {
        const result = playerManager.parties.demoteLeader(
          username,
          msg.username,
          (u) => playerManager.getSessionByUsername(u)?.getPartyId() ?? null,
        );
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        const session = playerManager.getSessionByUsername(username);
        const partyId = session?.getPartyId();
        if (partyId) {
          const party = playerManager.parties.getParty(partyId);
          if (party) {
            for (const m of party.members) {
              playerManager.sendStateToPlayer(m.username);
            }
          }
        }
        return;
      }

      if (msg.type === 'transfer_party_ownership' && typeof msg.username === 'string') {
        const result = playerManager.parties.transferOwnership(
          username,
          msg.username,
          (u) => playerManager.getSessionByUsername(u)?.getPartyId() ?? null,
        );
        if (typeof result === 'string') {
          ws.send(JSON.stringify({ type: 'error', message: result }));
          return;
        }
        const session = playerManager.getSessionByUsername(username);
        const partyId = session?.getPartyId();
        if (partyId) {
          const party = playerManager.parties.getParty(partyId);
          if (party) {
            for (const m of party.members) {
              playerManager.sendStateToPlayer(m.username);
            }
          }
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
  sessionStore.startReap();
  await gameLoop.init();

  server.listen(PORT, () => {
    console.log(`Game server listening on port ${PORT}`);
  });
}

async function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down...`);
  tokenStore.stop();
  sessionStore.stopReap();
  await gameLoop.shutdown();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
