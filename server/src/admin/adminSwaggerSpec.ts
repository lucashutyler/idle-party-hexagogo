const sharedComponents = {
  securitySchemes: {
    sessionCookie: {
      type: 'apiKey',
      in: 'cookie',
      name: 'connect.sid',
      description: 'Express session cookie',
    },
    apiToken: {
      type: 'http',
      scheme: 'bearer',
      description: 'An API token generated from the World Manager\'s API Tokens tab. Sent as `Authorization: Bearer ipr_...`. Resolved to its owner on every request, so it stops working the moment that account loses its admin role. Token- and role-management routes deliberately reject it and require a browser session.',
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
    SkillDefinition: {
      type: 'object',
      required: ['id', 'name', 'description', 'className', 'type', 'unlockLevel', 'sortOrder'],
      properties: {
        id: { type: 'string', example: 'knight_guard' },
        name: { type: 'string', example: 'Guard' },
        description: { type: 'string' },
        className: { type: 'string', enum: ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'] },
        type: { type: 'string', enum: ['passive', 'active'] },
        unlockLevel: { type: 'number', nullable: true, description: 'Level the class learns it; null = grant-only (item/set)' },
        sortOrder: { type: 'number', description: 'Display order within the class tree' },
        passiveEffects: { type: 'array', items: { type: 'object' }, description: 'Effect options — allowed on both passive and active skills' },
        activeEffects: { type: 'array', items: { type: 'object' }, description: 'Effect options — allowed only on active skills' },
        cooldown: { type: 'number', description: 'Actives: triggers every Nth attack (>= 1)' },
      },
    },
    SkillSlot: {
      type: 'object',
      required: ['type', 'unlocksAtLevel'],
      properties: {
        type: { type: 'string', enum: ['passive', 'active'] },
        unlocksAtLevel: { type: 'number', description: 'Integer 1-100' },
      },
    },
    WorldTileDefinition: {
      type: 'object',
      required: ['col', 'row', 'type', 'zone', 'name'],
      properties: {
        id: { type: 'string', description: 'GUID, auto-generated' },
        mapId: { type: 'string', description: "Map this room belongs to. Defaults to 'overworld'." },
        col: { type: 'number' },
        row: { type: 'number' },
        type: { type: 'string', enum: ['plains', 'forest', 'mountain', 'water', 'town', 'dungeon', 'desert', 'swamp'] },
        zone: { type: 'string' },
        name: { type: 'string', example: 'Town Square' },
        requiredItemId: {
          type: 'string',
          description: 'Legacy item gate. Prefer entryRequirements.requiredItemId — both are honoured.',
        },
        entryRequirements: {
          $ref: '#/components/schemas/RoomEntryRequirements',
          description: 'Gate on entering this room. Overrides the tile type gate field by field.',
        },
        transitions: {
          type: 'array',
          description: 'Links to rooms on other maps (e.g. manhole → sewers). A room may have several exits.',
          items: {
            type: 'object',
            required: ['mapId', 'tileId'],
            properties: {
              mapId: { type: 'string' },
              tileId: { type: 'string', description: 'Target room GUID' },
              entryRequirements: {
                $ref: '#/components/schemas/RoomEntryRequirements',
                description: 'Gate on taking this exit, applied on top of the destination room gate.',
              },
            },
          },
        },
      },
    },
    RoomEntryRequirements: {
      type: 'object',
      description: 'Entry gate for a room or transition. Every party member must satisfy every field set here.',
      properties: {
        minLevel: { type: 'number', description: 'Minimum character level every member must have.' },
        requiredItemId: { type: 'string', description: 'Item every member must have equipped.' },
        requiredQuestIds: {
          type: 'array',
          description: 'Quests every member must have completed (turned in).',
          items: { type: 'string' },
        },
      },
    },
    TileTypeDefinition: {
      type: 'object',
      required: ['id', 'name', 'icon', 'color', 'traversable'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        icon: { type: 'string', description: 'Emoji' },
        color: { type: 'string', example: '#7ec850' },
        traversable: { type: 'boolean' },
        requiredItemId: { type: 'string', description: 'Legacy item gate. Prefer entryRequirements.' },
        entryRequirements: {
          $ref: '#/components/schemas/RoomEntryRequirements',
          description: 'Default gate for every room of this type. Rooms override it field by field.',
        },
      },
    },
    AssetKindInfo: {
      type: 'object',
      description: 'One row of the shared ASSET_KIND_INFO registry — what a kind is, where it lives, and how it is keyed.',
      required: ['kind', 'label', 'description', 'mount', 'dir', 'idFormat', 'shape', 'urlTemplate', 'fallbacks'],
      properties: {
        kind: { type: 'string', example: 'monster' },
        label: { type: 'string', example: 'Monster' },
        description: { type: 'string', example: 'Monster portraits shown on the combat screen.' },
        mount: { type: 'string', description: 'Public URL prefix the client fetches from', example: '/monster-artwork' },
        dir: { type: 'string', description: 'Folder under the process working directory that holds the PNGs', example: 'data/monster-artwork' },
        idFormat: { type: 'string', description: 'Human description of the id format', example: 'MonsterDefinition.id' },
        shape: { type: 'string', enum: ['square', 'any'], description: "'square' rejects non-square uploads" },
        urlTemplate: { type: 'string', example: '/monster-artwork/{id}.png' },
        fallbacks: {
          type: 'array',
          description: 'Ordered chain the client walks when an id has no art of its own. Empty for most kinds.',
          items: {
            type: 'object',
            required: ['kind', 'idFrom'],
            properties: {
              kind: { type: 'string', description: 'Folder searched for the fallback' },
              idFrom: { type: 'string', enum: ['zoneId', 'tileType', 'nameSlug'], description: 'Which id is looked up there' },
            },
          },
        },
      },
    },
    AdminMe: {
      type: 'object',
      description: 'The admin behind the current request, however they authenticated.',
      required: ['email', 'role', 'isSuperAdmin', 'via'],
      properties: {
        email: { type: 'string', example: 'owner@example.com' },
        username: { type: 'string', nullable: true, example: 'Lucas' },
        role: { type: 'string', enum: ['admin', 'superadmin'] },
        isSuperAdmin: { type: 'boolean', description: 'Super admins may additionally grant roles' },
        via: { type: 'string', enum: ['session', 'token'], description: 'How this request authenticated' },
      },
    },
    ApiToken: {
      type: 'object',
      description: 'A stored API token, minus its secret — only the sha256 hash is kept server-side.',
      required: ['id', 'label', 'prefix', 'createdAt', 'expiresAt', 'lastUsedAt', 'expired'],
      properties: {
        id: { type: 'string', example: '6c84fb90-12c4-11e1-840d-7b25c5ee775a' },
        label: { type: 'string', example: 'laptop MCP' },
        prefix: { type: 'string', description: 'Leading characters of the secret, for identifying a row', example: 'ipr_1a2b3c4d' },
        createdAt: { type: 'string', description: 'ISO timestamp' },
        expiresAt: { type: 'string', nullable: true, description: 'ISO timestamp, or null for a token that never expires' },
        lastUsedAt: { type: 'string', nullable: true, description: 'ISO timestamp of the last authenticated request, flushed to disk about once a minute' },
        expired: { type: 'boolean' },
      },
    },
    AssetInfo: {
      type: 'object',
      description: 'A stored PNG on disk. Dimensions are read from the file\'s own IHDR header, not from the upload metadata.',
      required: ['id', 'kind', 'url', 'bytes', 'width', 'height', 'updatedAt'],
      properties: {
        id: { type: 'string', example: 'crystal_golem' },
        kind: { type: 'string', example: 'monster' },
        url: { type: 'string', description: 'Public URL including a cache-busting version stamp', example: '/monster-artwork/crystal_golem.png?v=1754000000000' },
        bytes: { type: 'number', example: 48211 },
        width: { type: 'number', example: 512 },
        height: { type: 'number', example: 512 },
        updatedAt: { type: 'string', description: "ISO timestamp of the file's last write" },
      },
    },
    AssetCoverageEntry: {
      type: 'object',
      required: ['id', 'label', 'hasOwnAsset', 'resolvedVia'],
      properties: {
        id: { type: 'string', example: 'crystal_golem' },
        label: { type: 'string', description: 'Display name of the entity that wants this art', example: 'Crystal Golem' },
        hasOwnAsset: { type: 'boolean', description: 'Whether a PNG exists under this exact id' },
        resolvedVia: { type: 'string', description: "What the player actually sees: 'own', 'placeholder', 'external' (the entity carries its own artwork URL), or 'fallback:{kind}'", example: 'fallback:zone' },
      },
    },
    AssetKindCoverage: {
      type: 'object',
      required: ['kind', 'label', 'description', 'dir', 'mount', 'idFormat', 'required', 'present', 'missing', 'coveredByFallback', 'overrides', 'orphans'],
      properties: {
        kind: { type: 'string', example: 'monster' },
        label: { type: 'string', example: 'Monster' },
        description: { type: 'string' },
        dir: { type: 'string', example: 'data/monster-artwork' },
        mount: { type: 'string', example: '/monster-artwork' },
        idFormat: { type: 'string' },
        required: { type: 'number', description: 'How many ids of this kind are expected to have art' },
        present: { type: 'number', description: 'Required ids that have art of their own' },
        missing: { type: 'number', description: 'Required ids with no art of their own' },
        coveredByFallback: { type: 'number', description: 'Of the missing, how many still render real art through a fallback' },
        overrides: { type: 'number', description: 'Optional per-entity override files present (per-room art and the like)' },
        orphans: { type: 'array', items: { type: 'string' }, description: 'Files matching no required id and no recognized override shape' },
        entries: {
          type: 'array',
          items: { $ref: '#/components/schemas/AssetCoverageEntry' },
          description: 'Per-id detail. Omitted unless includeEntries=true — some kinds have thousands.',
        },
      },
    },
    AssetCoverageReport: {
      type: 'object',
      required: ['generatedAt', 'summary', 'kinds'],
      properties: {
        generatedAt: { type: 'string', description: 'ISO timestamp' },
        summary: {
          type: 'object',
          description: 'Totals across every kind in the report.',
          required: ['kinds', 'required', 'present', 'missing', 'coveredByFallback', 'overrides', 'orphans'],
          properties: {
            kinds: { type: 'number' },
            required: { type: 'number' },
            present: { type: 'number' },
            missing: { type: 'number' },
            coveredByFallback: { type: 'number' },
            overrides: { type: 'number' },
            orphans: { type: 'number', description: 'Orphan count, where each kind reports the filenames' },
          },
        },
        kinds: { type: 'array', items: { $ref: '#/components/schemas/AssetKindCoverage' } },
      },
    },
  },
};

export const adminSwaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Idle Party RPG — Admin API',
    version: '0.1.0',
    description: 'Admin endpoints for content management, versioning, and player administration. Authenticate with either an admin session cookie or an API token generated in the World Manager (`Authorization: Bearer ipr_...`). Routes that manage roles or API tokens require a session and reject bearer tokens — those carry a narrower per-route `security` block.',
  },
  servers: [{ url: '/' }],
  components: sharedComponents,
  security: [{ sessionCookie: [] }, { apiToken: [] }],
  tags: [
    { name: 'Access', description: 'Admin roles and API tokens. Roles come from ADMIN_EMAILS (always super admin) or a super admin\'s grant; API tokens are per-user bearer credentials for this API and the MCP server.' },
    { name: 'Overview', description: 'Server stats and content' },
    { name: 'Items', description: 'Item definition CRUD' },
    { name: 'Monsters', description: 'Monster definition CRUD' },
    { name: 'Zones', description: 'Zone definition CRUD' },
    { name: 'Skills', description: 'Skill definition CRUD and per-class slot schedules' },
    { name: 'World', description: 'World map tile CRUD' },
    { name: 'Assets', description: 'Game imagery — kind registry, coverage audit, and PNG upload/delete. The `set` and `shop` kinds exist in the game but are not managed here yet; GET /api/admin/assets lists them under `deferred` with the reason. Assets are live and unversioned: they are not part of ContentSnapshot, so uploads bypass the draft/publish/deploy flow and take effect immediately.' },
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
    // ── Access ──
    '/api/admin/me': {
      get: {
        tags: ['Access'],
        summary: 'The calling admin\'s identity and role',
        description: 'Used by the World Manager to decide which super-admin-only controls to render.',
        responses: {
          200: {
            description: 'The caller',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AdminMe' } } },
          },
        },
      },
    },
    '/api/admin/accounts/{email}/role': {
      put: {
        tags: ['Access'],
        summary: 'Grant or clear an account\'s admin role',
        description: 'Super admins only, and session-only — an API token cannot escalate its owner\'s privileges. Accounts listed in ADMIN_EMAILS are super admins by configuration and are rejected here, as is changing your own role.',
        security: [{ sessionCookie: [] }],
        parameters: [
          { name: 'email', in: 'path', required: true, schema: { type: 'string' }, description: 'URL-encoded account email' },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['role'],
            properties: { role: { type: 'string', nullable: true, enum: ['admin', 'superadmin', null], description: 'null removes admin access' } },
          } } },
        },
        responses: {
          200: { description: 'Role updated' },
          400: { description: 'Invalid role, an ADMIN_EMAILS account, or your own account' },
          403: { description: 'Not a super admin, or authenticated with an API token' },
          404: { description: 'No such account' },
        },
      },
    },
    '/api/admin/api-tokens': {
      get: {
        tags: ['Access'],
        summary: 'Your own API tokens',
        description: 'Scoped to the caller — there is no way to list anyone else\'s tokens. Secrets are never returned.',
        security: [{ sessionCookie: [] }],
        responses: {
          200: {
            description: 'Your tokens',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: { tokens: { type: 'array', items: { $ref: '#/components/schemas/ApiToken' } } },
            } } },
          },
          403: { description: 'Authenticated with an API token rather than a session' },
        },
      },
      post: {
        tags: ['Access'],
        summary: 'Generate an API token for yourself',
        description: 'The plaintext secret is returned exactly once, in this response, and is stored only as a sha256 hash afterwards.',
        security: [{ sessionCookie: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['label'],
            properties: {
              label: { type: 'string', example: 'laptop MCP', description: 'Truncated to 60 characters' },
              expiresAt: { type: 'string', nullable: true, example: '2026-12-01', description: 'YYYY-MM-DD (through the end of that day) or a full ISO timestamp. Omit or null for a token that never expires.' },
            },
          } } },
        },
        responses: {
          200: {
            description: 'Token created — copy the secret now',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                token: { type: 'string', description: 'The plaintext secret. Shown once and unrecoverable.', example: 'ipr_1a2b3c...' },
                created: { $ref: '#/components/schemas/ApiToken' },
                tokens: { type: 'array', items: { $ref: '#/components/schemas/ApiToken' } },
              },
            } } },
          },
          400: { description: 'Missing label, or an invalid/past expiry' },
          403: { description: 'Authenticated with an API token rather than a session' },
        },
      },
    },
    '/api/admin/api-tokens/{id}': {
      delete: {
        tags: ['Access'],
        summary: 'Revoke one of your own API tokens',
        description: 'Deletes the token outright; anything using it stops working immediately. Scoped to the caller, so another admin\'s token id resolves as not found.',
        security: [{ sessionCookie: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Revoked, returns your remaining tokens' },
          403: { description: 'Authenticated with an API token rather than a session' },
          404: { description: 'No such token owned by you' },
        },
      },
    },
    '/api/admin/accounts': {
      get: {
        tags: ['Overview'],
        summary: 'All accounts with online status',
        description: 'Each account carries its granted `role` (null for non-admins) and `roleLocked` (true when the role comes from ADMIN_EMAILS).',
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

    // ── Skills ──
    '/api/admin/skills': {
      get: {
        tags: ['Skills'],
        summary: 'List all skills',
        responses: { 200: { description: 'All skill definitions keyed by ID' } },
      },
    },
    '/api/admin/skills/seed': {
      post: {
        tags: ['Skills'],
        summary: 'Restore default skills and slot schedules',
        description: 'Overwrites seed-id skills with their defaults and resets every class slot schedule. Custom (non-seed) skills are kept.',
        parameters: [
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' }, description: 'Target a draft version instead of live' },
        ],
        responses: { 200: { description: 'Seed skills restored, returns all skills and slot schedules' } },
      },
    },
    '/api/admin/skills/{id}': {
      put: {
        tags: ['Skills'],
        summary: 'Add or update a skill',
        description: 'Accepts legacy-shaped bodies (treeOrder / singular effects); the server normalizes and validates against the skill option catalog.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SkillDefinition' } } },
        },
        responses: {
          200: { description: 'Skill saved, returns all skills' },
          400: { description: 'Validation errors (joined into a single message)' },
        },
      },
      delete: {
        tags: ['Skills'],
        summary: 'Delete a skill',
        description: 'Fails while any item or set breakpoint grants this skill.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Skill deleted, returns all skills' },
          400: { description: 'Skill granted by an item/set or not found' },
        },
      },
    },
    '/api/admin/skill-slots/{className}': {
      put: {
        tags: ['Skills'],
        summary: "Replace a class's skill slot schedule",
        parameters: [
          { name: 'className', in: 'path', required: true, schema: { type: 'string', enum: ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'] } },
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['slots'],
            properties: { slots: { type: 'array', items: { $ref: '#/components/schemas/SkillSlot' } } },
          } } },
        },
        responses: {
          200: { description: 'Schedule saved, returns all slot schedules keyed by class' },
          400: { description: 'Invalid class, empty slots, bad slot type, or unlocksAtLevel out of range' },
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
            properties: { mapId: { type: 'string', description: "Defaults to 'overworld'." }, col: { type: 'number' }, row: { type: 'number' } },
          } } },
        },
        responses: {
          200: { description: 'Tile deleted' },
          400: { description: 'Cannot delete start tile, tile not found, or an inbound transition links to it' },
        },
      },
    },
    '/api/admin/world/start-tile': {
      put: {
        tags: ['World'],
        summary: "Set a map's start tile (defaults to the default/spawn map)",
        parameters: [
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['col', 'row'],
            properties: { mapId: { type: 'string', description: "Defaults to the world's default map." }, col: { type: 'number' }, row: { type: 'number' } },
          } } },
        },
        responses: {
          200: { description: 'Start tile updated' },
          400: { description: 'Tile not found or not traversable' },
        },
      },
    },
    '/api/admin/world/map': {
      post: {
        tags: ['World'],
        summary: 'Create or rename a map',
        parameters: [
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['id', 'name'],
            properties: { id: { type: 'string' }, name: { type: 'string' }, startTile: { type: 'object', properties: { col: { type: 'number' }, row: { type: 'number' } } } },
          } } },
        },
        responses: {
          200: { description: 'Map created/renamed, returns world data' },
          400: { description: 'Missing id/name' },
        },
      },
      delete: {
        tags: ['World'],
        summary: 'Delete a map (must have no rooms and no inbound transitions)',
        parameters: [
          { name: 'versionId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          } } },
        },
        responses: {
          200: { description: 'Map deleted' },
          400: { description: 'Default map, non-empty map, or inbound transition exists' },
        },
      },
    },

    // ── Assets ──
    '/api/admin/assets': {
      get: {
        tags: ['Assets'],
        summary: 'Describe every asset kind',
        description: 'The shared ASSET_KIND_INFO registry — what kinds exist, where they are served from, how they are keyed, and the upload size ceiling. Clients should read kinds from here rather than hard-coding them. Kinds the game has but this API does not manage yet come back under `deferred` instead of `kinds`.',
        responses: {
          200: {
            description: 'Kind registry',
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['kinds', 'deferred', 'maxBytes'],
              properties: {
                kinds: {
                  type: 'object',
                  description: 'Managed kinds, keyed by asset kind. Only these are valid on the routes below.',
                  additionalProperties: { $ref: '#/components/schemas/AssetKindInfo' },
                },
                deferred: {
                  type: 'array',
                  description: 'Kinds that exist in the game and are still served statically, but are not managed through this API yet. Sending one to any /assets route returns 400.',
                  items: {
                    type: 'object',
                    required: ['kind', 'label', 'reason'],
                    properties: {
                      kind: { type: 'string', example: 'shop' },
                      label: { type: 'string', example: 'Shop' },
                      reason: { type: 'string', description: 'Why the kind is held back' },
                    },
                  },
                },
                maxBytes: { type: 'number', description: 'Maximum upload size in bytes', example: 524288 },
              },
            } } },
          },
        },
      },
    },
    '/api/admin/assets/coverage': {
      get: {
        tags: ['Assets'],
        summary: 'Audit which content is missing artwork',
        description: 'Joins every asset folder against the content expected to have art in it. Accounts for the fallback chains the client actually walks, so an id with no art of its own can still report that it renders real art via another kind.',
        parameters: [
          { name: 'kind', in: 'query', required: false, schema: { type: 'string', enum: ['item', 'monster', 'zone', 'tile', 'tile-type', 'parchment', 'class', 'npc', 'henchman', 'logo', 'combat-bg', 'room-bg', 'class-icon', 'slot-icon', 'nav-icon'] }, description: 'Restrict the report to one kind. Omit for all kinds.' },
          { name: 'includeEntries', in: 'query', required: false, schema: { type: 'string', enum: ['true'] }, description: "Set to 'true' to include the per-id entries array on each kind" },
          { name: 'missingOnly', in: 'query', required: false, schema: { type: 'string', enum: ['true'] }, description: "With includeEntries, set to 'true' to list only ids that have no art of their own" },
          { name: 'limit', in: 'query', required: false, schema: { type: 'number' }, description: 'Cap on entries per kind. Defaults to 500.' },
        ],
        responses: {
          200: {
            description: 'Coverage report',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AssetCoverageReport' } } },
          },
          400: { description: 'Unknown kind — the message lists the valid kinds' },
          500: { description: 'Failed to compute coverage' },
        },
      },
    },
    '/api/admin/assets/{kind}': {
      get: {
        tags: ['Assets'],
        summary: 'List every stored asset of one kind',
        description: 'Reads the kind\'s folder and returns full metadata per file, sorted by id. A kind with no folder yet simply returns an empty list.',
        parameters: [
          { name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['item', 'monster', 'zone', 'tile', 'tile-type', 'parchment', 'class', 'npc', 'henchman', 'logo', 'combat-bg', 'room-bg', 'class-icon', 'slot-icon', 'nav-icon'] } },
        ],
        responses: {
          200: {
            description: 'Assets for the kind',
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['kind', 'count', 'assets'],
              properties: {
                kind: { type: 'string', example: 'monster' },
                count: { type: 'number' },
                assets: { type: 'array', items: { $ref: '#/components/schemas/AssetInfo' } },
              },
            } } },
          },
          400: { description: 'Unknown kind — the message lists the valid kinds' },
          500: { description: 'Failed to read the kind\'s folder' },
        },
      },
    },
    '/api/admin/assets/{kind}/{id}': {
      get: {
        tags: ['Assets'],
        summary: 'Metadata for one asset',
        parameters: [
          { name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['item', 'monster', 'zone', 'tile', 'tile-type', 'parchment', 'class', 'npc', 'henchman', 'logo', 'combat-bg', 'room-bg', 'class-icon', 'slot-icon', 'nav-icon'] } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Format varies by kind — see idFormat on GET /api/admin/assets' },
        ],
        responses: {
          200: {
            description: 'Asset metadata',
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['asset'],
              properties: { asset: { $ref: '#/components/schemas/AssetInfo' } },
            } } },
          },
          400: { description: 'Unknown kind' },
          404: { description: 'No artwork stored for this id (also returned for an unreadable id)' },
          500: { description: 'Failed to stat the asset' },
        },
      },
      post: {
        tags: ['Assets'],
        summary: 'Upload or replace a PNG',
        description: 'Multipart upload under the field name `artwork`. The bytes must be a real PNG — the signature and IHDR chunk are verified and the dimensions read from the file itself, never from the client-declared mime type. Kinds with shape `square` reject non-square images. Writes take effect on the live game immediately; artwork is not versioned content.',
        parameters: [
          { name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['item', 'monster', 'zone', 'tile', 'tile-type', 'parchment', 'class', 'npc', 'henchman', 'logo', 'combat-bg', 'room-bg', 'class-icon', 'slot-icon', 'nav-icon'] } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Letters, numbers, spaces, dots, dashes, and underscores only; no `..` runs' },
        ],
        requestBody: {
          required: true,
          content: { 'multipart/form-data': { schema: {
            type: 'object',
            required: ['artwork'],
            properties: { artwork: { type: 'string', format: 'binary', description: 'PNG file, 512 KB max' } },
          } } },
        },
        responses: {
          200: {
            description: 'Asset written, returns its metadata',
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['success', 'asset'],
              properties: { success: { type: 'boolean', example: true }, asset: { $ref: '#/components/schemas/AssetInfo' } },
            } } },
          },
          400: { description: 'Unknown kind, no file uploaded, invalid asset id, non-PNG bytes, non-square image for a square kind, or over the 512 KB limit' },
          500: { description: 'Failed to write the file' },
        },
      },
      delete: {
        tags: ['Assets'],
        summary: 'Delete an asset',
        description: 'Idempotent — deleting art that is not there still succeeds, with `removed: false`.',
        parameters: [
          { name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['item', 'monster', 'zone', 'tile', 'tile-type', 'parchment', 'class', 'npc', 'henchman', 'logo', 'combat-bg', 'room-bg', 'class-icon', 'slot-icon', 'nav-icon'] } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'Delete completed',
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['success', 'removed'],
              properties: {
                success: { type: 'boolean', example: true },
                removed: { type: 'boolean', description: 'Whether a file was actually removed' },
              },
            } } },
          },
          400: { description: 'Unknown kind or invalid asset id' },
          500: { description: 'Failed to remove the file' },
        },
      },
    },
    '/api/admin/artwork/{kind}/{id}': {
      post: {
        tags: ['Assets'],
        deprecated: true,
        summary: 'Upload artwork (deprecated)',
        description: 'Deprecated alias kept so an older client build does not break mid-deploy. Use POST /api/admin/assets/{kind}/{id}, which returns the stored asset metadata and reports oversized uploads as a JSON 400.',
        parameters: [
          { name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['item', 'monster', 'zone', 'tile', 'tile-type', 'parchment', 'class', 'npc', 'henchman', 'logo', 'combat-bg', 'room-bg', 'class-icon', 'slot-icon', 'nav-icon'] } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'multipart/form-data': { schema: {
            type: 'object',
            required: ['artwork'],
            properties: { artwork: { type: 'string', format: 'binary', description: 'PNG file, 512 KB max' } },
          } } },
        },
        responses: {
          200: { description: 'Artwork saved, returns { success: true } only' },
          400: { description: 'Unknown kind, no file uploaded, invalid asset id, non-PNG bytes, or non-square image for a square kind' },
          500: { description: 'Failed to save artwork' },
        },
      },
      delete: {
        tags: ['Assets'],
        deprecated: true,
        summary: 'Delete artwork (deprecated)',
        description: 'Deprecated alias. Use DELETE /api/admin/assets/{kind}/{id}, which also reports whether a file was actually removed.',
        parameters: [
          { name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['item', 'monster', 'zone', 'tile', 'tile-type', 'parchment', 'class', 'npc', 'henchman', 'logo', 'combat-bg', 'room-bg', 'class-icon', 'slot-icon', 'nav-icon'] } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Returns { success: true } whether or not a file existed' },
          400: { description: 'Unknown kind or invalid asset id' },
          500: { description: 'Failed to remove artwork' },
        },
      },
    },
    '/api/admin/items/{id}/artwork': {
      post: {
        tags: ['Assets'],
        deprecated: true,
        summary: 'Upload item artwork (deprecated)',
        description: "Deprecated item-specific alias, equivalent to the 'item' kind. Use POST /api/admin/assets/item/{id}.",
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'ItemDefinition.id' },
        ],
        requestBody: {
          required: true,
          content: { 'multipart/form-data': { schema: {
            type: 'object',
            required: ['artwork'],
            properties: { artwork: { type: 'string', format: 'binary', description: 'PNG file, 512 KB max, must be square' } },
          } } },
        },
        responses: {
          200: { description: 'Artwork saved, returns { success: true } only' },
          400: { description: 'No file uploaded, invalid asset id, non-PNG bytes, or non-square image' },
          500: { description: 'Failed to save artwork' },
        },
      },
      delete: {
        tags: ['Assets'],
        deprecated: true,
        summary: 'Delete item artwork (deprecated)',
        description: 'Deprecated item-specific alias. Use DELETE /api/admin/assets/item/{id}.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'ItemDefinition.id' },
        ],
        responses: {
          200: { description: 'Always returns { success: true } — a malformed id cannot name a real file either' },
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
    '/api/skills': {
      get: {
        tags: ['Game'],
        summary: 'Get skill definitions and per-class slot schedules',
        responses: { 200: { description: 'Returns { skills, slotSchedules } keyed by skill ID / class name' } },
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
