import { EventEmitter } from 'node:events';
import type { InstanceView, NotificationItem, SocialEvent, TaskProgress, UpdateInfo } from '../../shared/types';

/** Bus de eventos interno tipado. El puente IPC lo reenvía a la ventana. */
export interface BusEvents {
  progress: [TaskProgress];
  instances: [InstanceView[]];
  accounts: [];
  social: [SocialEvent];
  update: [UpdateInfo];
  notification: [NotificationItem];
  gameLog: [{ instanceId: string; lines: string[] }];
}

export class EventBus {
  private readonly ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(50);
  }
  emit<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]): void {
    this.ee.emit(event, ...args);
  }
  on<K extends keyof BusEvents>(event: K, cb: (...args: BusEvents[K]) => void): () => void {
    this.ee.on(event, cb as (...a: unknown[]) => void);
    return () => this.ee.off(event, cb as (...a: unknown[]) => void);
  }
}
