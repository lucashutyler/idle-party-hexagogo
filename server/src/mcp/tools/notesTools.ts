import crypto from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DesignNote } from '@idle-party-rpg/shared';
import type { ContentSnapshot, ContentVersion } from '../../game/VersionStore.js';
import type { McpToolDeps } from './McpToolDeps.js';
import { toolResult, errorMessage } from './mcpResult.js';

/**
 * Starts a new content-authoring session by creating a DRAFT version — either cloned
 * from an existing version's snapshot, or seeded from the currently-live content.
 * Mirrors `POST /api/admin/versions` in `adminRoutes.ts`. The returned version's `id`
 * is the `versionId` every subsequent write/notes tool call operates on.
 */
export async function createDraft(
  deps: McpToolDeps,
  input: { name: string; fromVersionId?: string }
): Promise<ContentVersion | { error: string }> {
  try {
    const versions = deps.versionStore();
    let snapshot: ContentSnapshot;
    if (input.fromVersionId) {
      const fromVersion = versions.get(input.fromVersionId);
      if (!fromVersion) return { error: 'Source version not found.' };
      snapshot = await versions.loadSnapshot(input.fromVersionId);
    } else {
      snapshot = deps.contentStore().toSnapshot();
    }
    return await versions.createDraft(input.name, input.fromVersionId ?? null, snapshot);
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/**
 * Creates or updates a design note in a draft version. Notes record the agreed-upon
 * design context for a content-authoring session (never sent to players). `createdAt`
 * is preserved across edits; `author` always comes from the caller's authenticated
 * token label, never from tool input.
 */
export async function saveNote(
  deps: McpToolDeps,
  input: { versionId: string; note: { id?: string; title: string; body: string; tags?: string[] } }
): Promise<DesignNote | { error: string }> {
  try {
    const noteId = input.note.id ?? crypto.randomUUID();
    let createdAt: string | undefined;

    if (input.note.id) {
      const version = deps.versionStore().get(input.versionId);
      if (!version) return { error: 'Version not found.' };
      if (version.status !== 'draft') return { error: 'Only drafts can be edited.' };
      const snapshot = await deps.versionStore().loadSnapshot(input.versionId);
      const existing = (snapshot.designNotes ?? []).find(n => n.id === input.note.id);
      createdAt = existing?.createdAt;
    }

    const now = new Date().toISOString();
    if (!createdAt) createdAt = now;

    const fullNote: DesignNote = {
      id: noteId,
      title: input.note.title,
      body: input.note.body,
      tags: input.note.tags,
      author: deps.tokenLabel,
      createdAt,
      updatedAt: now,
    };

    const result = await deps.draftEditor.upsertDesignNote(input.versionId, fullNote);
    if (!result.success) return { error: result.error };
    return result.entries.find(n => n.id === noteId) ?? fullNote;
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/** Deletes a design note from a draft version by id. */
export async function deleteNote(
  deps: McpToolDeps,
  input: { versionId: string; noteId: string }
): Promise<{ success: true } | { error: string }> {
  try {
    const result = await deps.draftEditor.deleteDesignNote(input.versionId, input.noteId);
    if (!result.success) return { error: result.error };
    return { success: true };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export function registerNotesTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    'create_draft',
    {
      description:
        'Start a new content-authoring session by creating a DRAFT content version. ' +
        'Pass fromVersionId to clone an existing version\'s snapshot, or omit it to seed ' +
        'the draft from the currently-live content. Returns the created version, whose ' +
        '"id" field is the versionId every subsequent write/notes tool call needs. ' +
        'A human admin must still publish and deploy the draft via the World Manager ' +
        'admin dashboard — this never touches live content.',
      inputSchema: {
        name: z.string().describe('Display name for the new draft version.'),
        fromVersionId: z.string().optional().describe('Existing version id to clone content from. Omit to start from live content.'),
      },
    },
    async (args) => {
      const result = await createDraft(deps, args);
      return toolResult(result);
    }
  );

  server.registerTool(
    'save_note',
    {
      description:
        'Create or update a design note inside a DRAFT content version. Design notes are ' +
        'markdown records of the agreed-upon design context for a draft (e.g. "starter ' +
        'island: 3 goblins, 1 shop, quest chain X->Y->Z") — they are never sent to players. ' +
        'Omit note.id to create a new note; pass an existing note.id to update it in place ' +
        '(its original createdAt is preserved). The author field is always set from the ' +
        'caller\'s authenticated token label.',
      inputSchema: {
        versionId: z.string().describe('Draft version id to save the note into.'),
        note: z.object({
          id: z.string().optional().describe('Existing note id to update. Omit to create a new note.'),
          title: z.string().describe('Short title for the note.'),
          body: z.string().describe('Markdown body — the design context to record.'),
          tags: z.array(z.string()).optional().describe('Optional freeform tags for filtering/organizing notes.'),
        }),
      },
    },
    async (args) => {
      const result = await saveNote(deps, args);
      return toolResult(result);
    }
  );

  server.registerTool(
    'delete_note',
    {
      description: 'Delete a design note from a DRAFT content version by id.',
      inputSchema: {
        versionId: z.string().describe('Draft version id to delete the note from.'),
        noteId: z.string().describe('Id of the design note to delete.'),
      },
    },
    async (args) => {
      const result = await deleteNote(deps, args);
      return toolResult(result);
    }
  );
}
