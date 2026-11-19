/** Registry of live board rooms, shared by the collab and terminal layers. */
export interface BoardRoom {
  broadcast(data: string): void;
}

export const rooms = new Map<string, BoardRoom>();

export function broadcastToBoard(boardId: string, msg: object): void {
  rooms.get(boardId)?.broadcast(JSON.stringify(msg));
}
