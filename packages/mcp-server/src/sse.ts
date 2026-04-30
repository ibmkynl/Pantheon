import type { FastifyReply } from 'fastify';

export interface SseEvent {
  agentName: string;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  timestamp: string;
}

export class SseEmitter {
  private clients: Set<FastifyReply> = new Set();

  addClient(reply: FastifyReply): void {
    this.clients.add(reply);
  }

  removeClient(reply: FastifyReply): void {
    this.clients.delete(reply);
  }

  emit(event: SseEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.raw.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
