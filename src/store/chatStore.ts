import type { ChatMessage, ChatThread } from '../models/index.js';

/**
 * A person's own conversations.
 *
 * Every method takes the owner, and none of them has a way to ask for someone
 * else's: a developer's prompts are their working notes rather than managed
 * output, and there is deliberately no project-manager bypass. The same rule
 * is enforced again by the policies in `0002_row_level_security.sql`, because
 * a desktop reaches Postgres without passing through this code.
 *
 * The desktop keeps the conversation it is having in SQLite -- the runner
 * reads it mid-run, synchronously -- and publishes it here, so it survives the
 * machine and can be read back on the web.
 */
export interface ChatStore {
  listThreads(workspaceId: string, ownerId: string): Promise<ChatThread[]>;
  /** The messages of one thread, or null if it is not this person's. */
  messages(workspaceId: string, threadId: string, ownerId: string): Promise<ChatMessage[] | null>;
}
