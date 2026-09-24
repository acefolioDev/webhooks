import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import type { WebhooksEvent } from './webhooks-events.interface.js';
import { channels } from './webhooks.channels.js';

/**
 * The package's events in this application, for metrics and alerting. Every event is also
 * published on its `node:diagnostics_channel` channel (`nestjs:webhooks:<type>`).
 */
@Injectable()
export class WebhooksEvents implements OnApplicationShutdown {
  private readonly subject = new Subject<WebhooksEvent>();
  readonly events$: Observable<WebhooksEvent> = this.subject.asObservable();

  /**
   * Called by the worker and the verifier. Catch errors inside your subscribers: RxJS and
   * `diagnostics_channel` both rethrow a subscriber's error as an uncaught exception.
   */
  emit(event: WebhooksEvent): void {
    const target = channels[event.type];
    if (target.hasSubscribers) {
      target.publish(event);
    }
    this.subject.next(event);
  }

  // After onModuleDestroy, where the worker drains and may still emit.
  onApplicationShutdown() {
    this.subject.complete();
  }
}
