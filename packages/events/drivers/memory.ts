import type { EventDriver, PublishedEvent } from "../driver";

const published: (PublishedEvent & { id: string })[] = [];

export class MemoryEventDriver implements EventDriver {
  async publish(event: PublishedEvent) {
    const id = `memory-${published.length + 1}`;
    published.push({ ...event, id });
    return id;
  }
}

export const memoryEvents = (): readonly (PublishedEvent & { id: string })[] => published;

export const resetMemoryEvents = (): void => void (published.length = 0);

export const createMemoryEventDriver = (): MemoryEventDriver => new MemoryEventDriver();
