import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DomTimelineItem, TimelineDomEventItem } from "./types.ts";

export class DomRecordStore {
  readonly events: DomTimelineItem[] = [];
  private next = 0;
  private active = true;

  append(targetId: string, input: Omit<DomTimelineItem, "eventId" | "targetId">): void {
    if (!this.active) return;
    this.events.push({
      ...input,
      eventId: `dom_${String(++this.next).padStart(3, "0")}`,
      targetId,
    });
  }

  deactivate(): void {
    this.active = false;
  }
}

function sameTarget(a: DomTimelineItem, b: DomTimelineItem): boolean {
  return a.targetId === b.targetId &&
    a.frameUrl === b.frameUrl &&
    JSON.stringify(a.target) === JSON.stringify(b.target);
}

export function processDomTimeline(events: DomTimelineItem[]): DomTimelineItem[] {
  const out: DomTimelineItem[] = [];
  for (const event of [...events].sort((a, b) => a.t - b.t)) {
    const previous = out.at(-1);
    if (event.type === "fill" && previous?.type === "fill" && sameTarget(previous, event)) {
      out[out.length - 1] = event;
    } else {
      out.push(event);
    }
  }
  return out;
}

export function simpleDomTimeline(events: DomTimelineItem[]): TimelineDomEventItem[] {
  return processDomTimeline(events)
    .filter((event) => event.type !== "final-state")
    .map((event) => ({
      eventId: event.eventId,
      t: event.t,
      type: "action",
      actionType: event.type as TimelineDomEventItem["actionType"],
      ...(event.role ? { role: event.role } : {}),
      ...(event.name ? { name: event.name } : {}),
      ...(event.key ? { key: event.key } : {}),
      ...(event.type === "navigation" ? { url: event.url } : {}),
    }));
}

export async function writeDomTimeline(recordDir: string, events: DomTimelineItem[]): Promise<void> {
  const dir = path.join(recordDir, "DOM");
  await fs.mkdir(dir, { recursive: true });
  const rows = processDomTimeline(events);
  await fs.writeFile(
    path.join(dir, "DOMTimeline.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
    "utf8",
  );
}
