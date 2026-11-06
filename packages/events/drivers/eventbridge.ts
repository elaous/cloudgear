import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import type { EventDriver, EventDriverOptions, PublishedEvent } from "../driver";

export function createEventBridgeDriver(options: EventDriverOptions): EventDriver {
  const client = new EventBridgeClient(options.region ? { region: options.region } : {});
  return {
    async publish(event: PublishedEvent) {
      const out = await client.send(
        new PutEventsCommand({
          Entries: [{ EventBusName: event.bus, Source: event.source, DetailType: event.type, Detail: JSON.stringify(event.detail ?? null) }],
        }),
      );
      const entry = out.Entries?.[0];
      if (out.FailedEntryCount || !entry?.EventId) throw new Error(`EventBridge rejected the event ${event.type}: ${entry?.ErrorMessage ?? "no event id returned"}`);
      return entry.EventId;
    },
  };
}
