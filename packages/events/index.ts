import { timed } from "@cloudgear/debug";
import { assertBusName, assertEventSource, assertEventType, createEventDriver, type EventDriver, type EventProvider } from "./driver";

export { assertBusName, assertEventSource, assertEventType, createEventDriver, registerEventDriver } from "./driver";
export type { EventDriver, EventDriverFactory, EventDriverOptions, EventProvider, PublishedEvent } from "./driver";

export const DEFAULT_SOURCE = "cloudgear";

// PutEvents limit: 256 KB per entry, envelope included.
const MAX_DETAIL_BYTES = 250_000;

export interface EventBusOptions {
  // Literal only; omit for the account's default bus.
  name?: string;
  driver?: EventDriver;
}

export interface EventMatch {
  type: string;
  // Publishers set it; a trigger without one matches any source.
  source?: string;
}

export interface EventTrigger {
  readonly kind: "event";
  readonly bus: EventBus;
  readonly type: string;
  readonly source?: string;
}

// Constructing does nothing; `cloudgear apply` creates the bus.
export class EventBus {
  private driverPromise?: Promise<EventDriver>;

  constructor(
    readonly provider: EventProvider,
    readonly options: EventBusOptions = {},
  ) {
    if (provider !== "aws") throw new Error(`Event provider "${provider}" is not supported yet (supported: aws)`);
    if (options.name !== undefined) assertBusName(options.name);
    if (options.driver) this.driverPromise = Promise.resolve(options.driver);
  }

  get name(): string {
    return this.options.name ?? "default";
  }

  static envVarFor(name: string): string {
    return `CLOUDGEAR_EVENTBUS_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  }

  get location(): string {
    return process.env[EventBus.envVarFor(this.name)] ?? this.name;
  }

  event(match: string | EventMatch): EventTrigger {
    const { type, source } = typeof match === "string" ? { type: match, source: undefined } : match;
    return Object.freeze({
      kind: "event" as const,
      bus: this,
      type: assertEventType(type),
      ...(source !== undefined ? { source: assertEventSource(source) } : {}),
    });
  }

  async publish(type: string, detail: unknown, options: { source?: string } = {}): Promise<string> {
    assertEventType(type);
    const source = assertEventSource(options.source ?? DEFAULT_SOURCE);
    if (Buffer.byteLength(JSON.stringify(detail ?? null)) > MAX_DETAIL_BYTES) throw new Error(`The detail of ${type} is over ${MAX_DETAIL_BYTES} bytes; EventBridge accepts events up to 256 KB`);
    const driver = await this.driver();
    return timed("events", `publish ${type}`, () => driver.publish({ bus: this.location, source, type, detail }));
  }

  driver(): Promise<EventDriver> {
    this.driverPromise ??= createEventDriver(this.provider).catch((err) => {
      this.driverPromise = undefined;
      throw err;
    });
    return this.driverPromise;
  }
}

// Runtime no-op; `cloudgear generate` reads it.
export function on(_trigger: EventTrigger) {
  return (_method: unknown, _context: ClassMethodDecoratorContext): void => {};
}
