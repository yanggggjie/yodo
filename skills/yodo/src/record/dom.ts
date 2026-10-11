import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DomTimelineItem, TimelineDomEventItem } from "./types.ts";

export class DomRecordStore {
  readonly events: DomTimelineItem[] = [];
  private active = true;

  append(targetId: string, input: Omit<DomTimelineItem, "targetId">): void {
    if (!this.active) return;
    this.events.push({ ...input, targetId });
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

/** 同一控件上的 click 之后，这个时间窗内出现 value / checked 时，click 只是触发状态变化的动作，不单独记录。 */
const CONTROL_WINDOW_MS = 2500;
/** 滚动位移（X、Y 的较大者）小于该值的 scroll 丢弃。 */
const SCROLL_MIN_PX = 20;

/** timeline 中的操作：click、value、checked、scroll、navigation。 */
export function simpleDomTimeline(events: DomTimelineItem[]): TimelineDomEventItem[] {
  const sorted = processDomTimeline(events);
  const isStateChange = (e: DomTimelineItem) => e.type === "fill" || e.type === "change";
  const rows: TimelineDomEventItem[] = [];
  sorted.forEach((event, index) => {
    if (event.type === "click") {
      const followedByState = sorted.slice(index + 1).some((later) =>
        later.t - event.t <= CONTROL_WINDOW_MS && isStateChange(later) && sameTarget(event, later));
      if (followedByState) return;
    }
    if (event.type === "scroll") {
      const delta = Math.max(Math.abs(event.scroll?.deltaX ?? 0), Math.abs(event.scroll?.deltaY ?? 0));
      if (delta < SCROLL_MIN_PX) return;
    }
    let actionType: TimelineDomEventItem["actionType"] | undefined;
    if (event.type === "click") actionType = "click";
    else if (event.type === "fill") actionType = "value";
    else if (event.type === "change") {
      const inputType = event.target?.attributes?.type;
      actionType = inputType === "checkbox" || inputType === "radio" ? "checked" : "value";
    } else if (event.type === "scroll") actionType = "scroll";
    else if (event.type === "navigation") actionType = "navigation";
    if (!actionType) return;
    rows.push({
      t: event.t,
      type: "action",
      actionType,
      ...(event.role ? { role: event.role } : {}),
      ...(event.name ? { name: event.name } : {}),
      ...(event.type === "navigation" ? { url: event.url } : {}),
    });
  });
  return rows;
}
