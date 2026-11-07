import { beforeAll, describe, expect, it } from 'vitest';

let TOOLS: typeof import('./boardMcpServer.js')['TOOLS'];
let permitted: typeof import('./boardMcpServer.js')['permitted'];

beforeAll(async () => {
  // Load the tool table without starting the stdio loop.
  process.env.ALPHA_BOARD_MCP_NO_STDIO = '1';
  ({ TOOLS, permitted } = await import('./boardMcpServer.js'));
});

const allowed = (access: 'read' | 'comment' | 'write') => Object.entries(TOOLS).filter(([, tool]) => permitted(tool, access)).map(([name]) => name);

describe('board tool server', () => {
  it('offers read tools only, to a read pass', () => {
    expect(allowed('read')).toEqual(['board_list_cards', 'board_get_card']);
  });

  it('adds commenting for a specialist on its own card', () => {
    expect(allowed('comment')).toEqual(['board_list_cards', 'board_get_card', 'board_comment']);
  });

  it('offers the full set to the Manager Agent, with no delete tool', () => {
    expect(allowed('write')).toEqual(Object.keys(TOOLS));
    expect(Object.keys(TOOLS).some(name => name.includes('delete'))).toBe(false);
  });

  it('never lets an agent move a card into Building or Done', () => {
    const column = (TOOLS.board_move_card.inputSchema as any).properties.column.enum;
    expect(column).toEqual(['backlog', 'todo', 'in_progress', 'review']);
  });
});

