export type EventProvider = "aws";

export interface PublishedEvent {
  bus: string;
  source: string;
  type: string;
  detail: unknown;
}

export interface EventDriver {
  publish(event: PublishedEvent): Promise<string>;
}

export interface EventDriverOptions {
  region?: string;
}

export type EventDriverFactory = (options: EventDriverOptions) => EventDriver | Promise<EventDriver>;

const factories = new Map<string, EventDriverFactory>();

export function registerEventDriver(provider: EventProvider, factory: EventDriverFactory): void {
  factories.set(provider, factory);
}

export async function createEventDriver(provider: EventProvider, options: EventDriverOptions = {}): Promise<EventDriver> {
  if (process.env.CLOUDGEAR_EVENTS_DRIVER === "memory") return (await import("./drivers/memory")).createMemoryEventDriver();
  let factory = factories.get(provider);
  if (!factory) {
    if (provider !== "aws") throw new Error(`No event driver for "${provider}"; register one with registerEventDriver()`);
    factory = (await import("./drivers/eventbridge")).createEventBridgeDriver;
    factories.set(provider, factory);
  }
  return factory(options);
}

const BUS_NAME = /^[A-Za-z0-9._-]{1,200}$/;
const TYPE = /^[A-Za-z0-9._:/ -]{1,128}$/;

export function assertBusName(name: string): string {
  if (name === "default") throw new Error('The bus name "default" is the account default bus; omit the name to use it');
  if (!BUS_NAME.test(name)) throw new Error(`Invalid bus name "${name}": use letters, digits, "." "_" and "-"`);
  return name;
}

export function assertEventType(type: string): string {
  if (!TYPE.test(type)) throw new Error(`Invalid event type "${type}": use letters, digits, spaces and . _ : / -`);
  return type;
}

export function assertEventSource(source: string): string {
  if (!TYPE.test(source)) throw new Error(`Invalid event source "${source}": use letters, digits, spaces and . _ : / -`);
  if (source.startsWith("aws.")) throw new Error(`Event source "${source}" is reserved: "aws." sources come from AWS services`);
  return source;
}
