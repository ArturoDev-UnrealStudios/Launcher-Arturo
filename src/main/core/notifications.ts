import crypto from 'node:crypto';
import { z } from 'zod';
import type { NotificationItem } from '../../shared/types';
import type { EventBus } from './events';
import { readJson, writeJson } from './jsonStore';

const Schema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        level: z.enum(['info', 'success', 'warning', 'error']),
        titleKey: z.string(),
        bodyKey: z.string().optional(),
        params: z.record(z.union([z.string(), z.number()])).optional(),
        at: z.number(),
      }),
    )
    .default([]),
});

/** Notificaciones importantes persistentes (se muestran en Inicio hasta descartarlas). */
export class Notifications {
  private items: NotificationItem[] = [];
  constructor(private readonly file: string, private readonly bus: EventBus) {
    bus.on('notification', (n) => {
      if (!this.items.some((x) => x.id === n.id)) this.store(n);
    });
  }
  async load(): Promise<void> {
    this.items = (await readJson(this.file, Schema, () => ({ items: [] }))).value.items;
  }
  list(): NotificationItem[] {
    return [...this.items].sort((a, b) => b.at - a.at);
  }
  push(n: Omit<NotificationItem, 'id' | 'at'> & { id?: string }): void {
    const item: NotificationItem = { ...n, id: n.id ?? crypto.randomUUID(), at: Date.now() };
    this.store(item);
    this.bus.emit('notification', item);
  }
  private store(n: NotificationItem): void {
    this.items = [n, ...this.items.filter((x) => x.id !== n.id)].slice(0, 30);
    void writeJson(this.file, { items: this.items }).catch(() => undefined);
  }
  async dismiss(id: string): Promise<void> {
    this.items = this.items.filter((x) => x.id !== id);
    await writeJson(this.file, { items: this.items });
  }
}
