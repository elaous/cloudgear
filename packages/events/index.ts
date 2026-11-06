import { timed } from "@cloudgear/debug";
import { assertBusName, assertEventSource, assertEventType, createEventDriver, type EventDriver, type EventProvider } from "./driver";

export { createEventDriver, registerEventDriver } from "./driver";
export type { EventDriver, EventDriverFactory, EventDriverOptions, EventProvider, PublishedEvent } from "./driver";

export const DEFAULT_SOURCE = "cloudgear";

export interface EventBusOptions {
  // Name of a bus cloudgear creates for the app; omit it for the account's default bus. Literal only.
  name?: string;
  // Region of the bus; defaults to the function's. Literal only.
  region?: string;
  driver?: EventDriver;
}

export interface EventMatch {
  type: string;
  // Publishers set it; a trigger without one matches any source.
  source?: string;
}

// What starts a function: the events of a type published on a bus.
export interface EventTrigger {
  readonly kind: "event";
  readonly bus: EventBus;
  readonly type: string;
  readonly source?: string;
}

// Constructing it does nothing; `cloudgear apply` creates a named bus and the rules for its triggers.
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

  // The variable the deployed function finds the bus's physical name in.
  static envVarFor(name: string): string {
    return `CLOUDGEAR_EVENTBUS_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  }

  get location(): string {
    return process.env[EventBus.envVarFor(this.name)] ?? this.name;
  }

  // `on: bus.event("order.created")` on a route, or `@on(bus.event(...))` on a method.
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
    const driver = await this.driver();
    return timed("events", `publish ${type}`, () => driver.publish({ bus: this.location, source, type, detail }));
  }

  driver(): Promise<EventDriver> {
    this.driverPromise ??= createEventDriver(this.provider, { region: this.options.region }).catch((err) => {
      this.driverPromise = undefined;
      throw err;
    });
    return this.driverPromise;
  }
}

// A no-op at runtime; `cloudgear generate` reads it and deploys a rule that starts the method.
export function on(_trigger: EventTrigger) {
  return (_method: unknown, _context: ClassMethodDecoratorContext): void => {};
}
