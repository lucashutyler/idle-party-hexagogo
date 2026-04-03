const sharedComponents = {
  securitySchemes: {
    sessionCookie: {
      type: 'apiKey',
      in: 'cookie',
      name: 'connect.sid',
      description: 'Express session cookie',
    },
  },
  schemas: {
    ItemDefinition: {
      type: 'object',
      required: ['id', 'name', 'rarity'],
      properties: {
        id: { type: 'string', example: 'crystal_blade' },
        name: { type: 'string', example: 'Crystal Blade' },
        rarity: { type: 'string', enum: ['janky', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'heirloom'] },
        equipSlot: { type: 'string', enum: ['head', 'shoulders', 'chest', 'bracers', 'gloves', 'mainhand', 'offhand', 'twohanded', 'foot', 'ring', 'necklace', 'back', 'relic'] },
        classRestriction: { type: 'array', items: { type: 'string' }, example: ['Knight'] },
        bonusAttackMin: { type: 'number' },
        bonusAttackMax: { type: 'number' },
        damageReductionMin: { type: 'number' },
        damageReductionMax: { type: 'number' },
        magicReductionMin: { type: 'number' },
        magicReductionMax: { type: 'number' },
        value: { type: 'number' },
      },
    },
    MonsterDefinition: {
      type: 'object',
      required: ['id', 'name', 'level', 'hp', 'damage', 'damageType', 'xp', 'goldMin', 'goldMax'],
      properties: {
        id: { type: 'string', example: 'crystal_golem' },
        name: { type: 'string', example: 'Crystal Golem' },
        level: { type: 'number' },
        hp: { type: 'number' },
        damage: { type: 'number' },
        damageType: { type: 'string', enum: ['physical', 'magical', 'holy'] },
        xp: { type: 'number' },
        goldMin: { type: 'number' },
        goldMax: { type: 'number' },
        drops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              itemId: { type: 'string' },
              chance: { type: 'number', description: '0-1 probability' },
            },
          },
        },
      },
    },
    ZoneDefinition: {
      type: 'object',
      required: ['id', 'displayName', 'levelRange', 'encounterTable'],
      properties: {
        id: { type: 'string', example: 'darkwood' },
        displayName: { type: 'string', example: 'Darkwood' },
        levelRange: { type: 'array', items: { type: 'number' }, example: [2, 3] },
        encounterTable: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              monsterId: { type: 'string' },
              weight: { type: 'number' },
              minCount: { type: 'number' },
              maxCount: { type: 'number' },
            },
          },
        },
      },
    },
    WorldTileDefinition: {
      type: 'object',
      required: ['col', 'row', 'type', 'zone', 'name'],
      properties: {
        id: { type: 'string', description: 'GUID, auto-generated' },
        col: { type: 'number' },
        row: { type: 'number' },
        type: { type: 'string', enum: ['plains', 'forest', 'mountain', 'water', 'town', 'dungeon', 'desert', 'swamp'] },
        zone: { type: 'string' },
        name: { type: 'string', example: 'Town Square' },
      },
    },
  },
};

export const adminSwaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Idle Party RPG — Admin API',
    version: '0.1.0',
    description: 'Admin endpoints for content management, versioning, and player administration. Requires admin session cookie.',
  },
  servers: [{ url: '/' }],
  components: sharedComponents,
  security: [{ sessionCookie: [] }],
  tags: [
    { name: 'Overview', description: 'Server stats and content' },
    { name: 'Items', description: 'Item definition CRUD' },
    { name: 'Monsters', description: 'Monster definition CRUD' },
    { name: 'Zones', description: 'Zone definition CRUD' },
    { name: 'World', description: 'World map tile CRUD' },
    { name: 'Versions', description: 'Content versioning' },
    { name: 'Players', description: 'Player management' },
  ],
  paths: {
    // ── Overview ──
    '/api/admin/overview': {
      get: {
        tags: ['Overview'],
        summary: 'Server overview stats',
        responses: {
          200: {
            description: 'Server stats',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                onlinePlayers: { type: 'number' },
                totalSessions: { type: 'number' },
                totalConnections: { type: 'number' },
                totalAccounts: { type: 'number' },
                uptime: { type: 'number' },
              },
            } } },
          },
        },
      },
    },
    '/api/admin/accounts': {
      get: {
        tags: ['Overview'],
        summary: 'All accounts with online status',
        responses: { 200: { description: 'Account list' } },
      },
    },
    '/api/admin/content': {
      get: {
        tags: ['Overview'],
        summary: 'Full unfiltered game content',
        responses: { 200: { description: 'All monsters, items, zones, and world data' } },
      },
    },

    // ── Items ──
    '/api/admin/items': {
      get: {
        tags: ['Items'],
        summary: 'List all items',
        responses: {
          200: { description: 'All item definitions keyed by ID' },
        },
      },
    },
    '/api/admin/items/bulk': {
      post: {
        tags: ['Items'],
        summary: 'Bulk import items',
        description: 'Adds or updates each item in the array. Existing items with matching IDs are overwritten.',
        parameters: [
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' }, description: 'Target a draft version instead of live' },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'array',
            items: { $ref: '#/components/schemas/ItemDefinition' },
          } } },
        },
        responses: {
          200: { description: 'Items imported, returns count and all items' },
          400: { description: 'Body must be a non-empty array, or validation errors' },
        },
      },
    },
    '/api/admin/items/{id}': {
      put: {
        tags: ['Items'],
        summary: 'Add or update an item',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' }, description: 'Target a draft version instead of live' },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ItemDefinition' } } },
        },
        responses: {
          200: { description: 'Item saved, returns all items' },
          400: { description: 'Missing required fields' },
        },
      },
      delete: {
        tags: ['Items'],
        summary: 'Delete an item',
        description: 'Fails if any monster references this item in its drop table.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Item deleted, returns all items' },
          400: { description: 'Item referenced by a monster or not found' },
        },
      },
    },

    // ── Monsters ──
    '/api/admin/monsters': {
      get: {
        tags: ['Monsters'],
        summary: 'List all monsters',
        responses: { 200: { description: 'All monster definitions keyed by ID' } },
      },
    },
    '/api/admin/monsters/bulk': {
      post: {
        tags: ['Monsters'],
        summary: 'Bulk import monsters',
        description: 'Adds or updates each monster in the array. Existing monsters with matching IDs are overwritten.',
        parameters: [
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' }, description: 'Target a draft version instead of live' },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'array',
            items: { $ref: '#/components/schemas/MonsterDefinition' },
          } } },
        },
        responses: {
          200: { description: 'Monsters imported, returns count and all monsters' },
          400: { description: 'Body must be a non-empty array, or validation errors' },
        },
      },
    },
    '/api/admin/monsters/{id}': {
      put: {
        tags: ['Monsters'],
        summary: 'Add or update a monster',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/MonsterDefinition' } } },
        },
        responses: {
          200: { description: 'Monster saved, returns all monsters' },
          400: { description: 'Missing required fields' },
        },
      },
      delete: {
        tags: ['Monsters'],
        summary: 'Delete a monster',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Monster deleted, returns all monsters' },
          400: { description: 'Monster not found' },
        },
      },
    },

    // ── Zones ──
    '/api/admin/zones': {
      get: {
        tags: ['Zones'],
        summary: 'List all zones',
        responses: { 200: { description: 'All zone definitions keyed by ID' } },
      },
    },
    '/api/admin/zones/{id}': {
      put: {
        tags: ['Zones'],
        summary: 'Add or update a zone',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ZoneDefinition' } } },
        },
        responses: {
          200: { description: 'Zone saved, returns all zones' },
          400: { description: 'Missing required fields or zone referenced by tiles' },
        },
      },
      delete: {
        tags: ['Zones'],
        summary: 'Delete a zone',
        description: 'Fails if any world tile references this zone.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Zone deleted, returns all zones' },
          400: { description: 'Zone referenced by a tile or not found' },
        },
      },
    },

    // ── World ──
    '/api/admin/world/tile': {
      put: {
        tags: ['World'],
        summary: 'Add or update a world tile',
        parameters: [
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/WorldTileDefinition' } } },
        },
        responses: {
          200: { description: 'Tile saved, returns world data + relocated count' },
          400: { description: 'Missing required fields' },
        },
      },
      delete: {
        tags: ['World'],
        summary: 'Delete a world tile',
        parameters: [
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['col', 'row'],
            properties: { col: { type: 'number' }, row: { type: 'number' } },
          } } },
        },
        responses: {
          200: { description: 'Tile deleted' },
          400: { description: 'Cannot delete start tile or tile not found' },
        },
      },
    },
    '/api/admin/world/start-tile': {
      put: {
        tags: ['World'],
        summary: 'Set the start tile',
        parameters: [
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['col', 'row'],
            properties: { col: { type: 'number' }, row: { type: 'number' } },
          } } },
        },
        responses: {
          200: { description: 'Start tile updated' },
          400: { description: 'Tile not found or not traversable' },
        },
      },
    },

    // ── Versions ──
    '/api/admin/versions': {
      get: {
        tags: ['Versions'],
        summary: 'List all content versions',
        responses: { 200: { description: 'Version list with active version ID' } },
      },
      post: {
        tags: ['Versions'],
        summary: 'Create a new draft version',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              fromVersionId: { type: 'string', description: 'Clone from existing version (defaults to live)' },
            },
          } } },
        },
        responses: { 200: { description: 'Draft created' } },
      },
    },
    '/api/admin/versions/{id}': {
      put: {
        tags: ['Versions'],
        summary: 'Rename a draft version',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            properties: { name: { type: 'string' } },
          } } },
        },
        responses: { 200: { description: 'Version renamed' } },
      },
      delete: {
        tags: ['Versions'],
        summary: 'Delete a version',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Version deleted' } },
      },
    },
    '/api/admin/versions/{id}/content': {
      get: {
        tags: ['Versions'],
        summary: 'Get a version\'s full content snapshot',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Full content snapshot' } },
      },
    },
    '/api/admin/versions/{id}/publish': {
      post: {
        tags: ['Versions'],
        summary: 'Publish a draft version (freeze it)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Version published' } },
      },
    },
    '/api/admin/versions/{id}/deploy': {
      post: {
        tags: ['Versions'],
        summary: 'Deploy a published version to the live game',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Version deployed, returns relocated player count' } },
      },
    },

    // ── Players ──
    '/api/admin/master-reset': {
      post: {
        tags: ['Players'],
        summary: 'Reset all players to level 1',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['confirmation'],
            properties: { confirmation: { type: 'string', example: 'IT ALL MUST END' } },
          } } },
        },
        responses: { 200: { description: 'All players reset' } },
      },
    },
    '/api/admin/players/{username}/class': {
      post: {
        tags: ['Players'],
        summary: 'Change a player\'s class (resets to level 1)',
        parameters: [{ name: 'username', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['className'],
            properties: { className: { type: 'string', enum: ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'] } },
          } } },
        },
        responses: {
          200: { description: 'Class changed' },
          404: { description: 'Player not found' },
        },
      },
    },
  },
};

export const gameSwaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Idle Party RPG — Game API',
    version: '0.1.0',
    description: 'Game endpoints for authenticated players. Auth is handled via REST (/auth/*), game state via WebSocket.',
  },
  servers: [{ url: '/' }],
  components: sharedComponents,
  security: [{ sessionCookie: [] }],
  tags: [
    { name: 'Auth', description: 'Authentication flow' },
    { name: 'Game', description: 'Game data endpoints' },
    { name: 'Health', description: 'Server health' },
  ],
  paths: {
    // ── Auth ──
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Start login flow',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['email'],
            properties: { email: { type: 'string', example: 'player@example.com' } },
          } } },
        },
        responses: {
          200: { description: 'Login initiated. Dev: returns token directly. Prod: sends magic link email.' },
        },
      },
    },
    '/auth/verify': {
      get: {
        tags: ['Auth'],
        summary: 'Verify magic link token (dev flow)',
        security: [],
        parameters: [
          { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Session created, returns username' },
          401: { description: 'Invalid or expired token' },
        },
      },
    },
    '/auth/approve': {
      post: {
        tags: ['Auth'],
        summary: 'Approve a login from magic link (prod flow)',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['token'],
            properties: { token: { type: 'string' } },
          } } },
        },
        responses: {
          200: { description: 'Login approved (no session created on this device)' },
        },
      },
    },
    '/auth/login-status': {
      get: {
        tags: ['Auth'],
        summary: 'Poll login approval status (prod flow)',
        security: [],
        parameters: [
          { name: 'loginId', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Returns { approved: boolean }. When approved, session is created on this response.' },
        },
      },
    },
    '/auth/session': {
      get: {
        tags: ['Auth'],
        summary: 'Check current session',
        responses: {
          200: { description: 'Returns { loggedIn, username, email, needsUsername }' },
        },
      },
    },
    '/auth/username': {
      post: {
        tags: ['Auth'],
        summary: 'Set or change username',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['username'],
            properties: { username: { type: 'string', description: '3-16 chars, alphanumeric + underscores' } },
          } } },
        },
        responses: {
          200: { description: 'Username set' },
          400: { description: 'Invalid or taken username' },
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Destroy session',
        responses: { 200: { description: 'Logged out' } },
      },
    },

    // ── Game ──
    '/api/world': {
      get: {
        tags: ['Game'],
        summary: 'Get world data (all tiles)',
        description: 'Returns all tiles. Client handles fog of war via state.unlocked.',
        responses: { 200: { description: 'World data with tiles and start position' } },
      },
    },

    // ── Health ──
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        security: [],
        responses: {
          200: {
            description: 'Server status',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                status: { type: 'string', example: 'ok' },
                sessions: { type: 'number' },
                connections: { type: 'number' },
              },
            } } },
          },
        },
      },
    },
  },
};
