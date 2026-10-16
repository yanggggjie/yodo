import type { DomTimelineItem, RawRequest, TimelineDomEventItem } from "./types.ts";

export class DomRecordStore {
  readonly events: DomTimelineItem[] = [];
  /** 页面脚本已经生效（发来过 ready）的 tab。 */
  readonly ready = new Set<string>();
  private active = true;

  append(targetId: string, input: Omit<DomTimelineItem, "targetId">): void {
    if (!this.active) return;
    // 同一个文档里被注入了两份脚本时（晚注入与新文档注入撞在一起），同一个动作会来两次。
    const last = this.events.at(-1);
    if (last && last.targetId === targetId && last.t === input.t && last.type === input.type && last.frameUrl === input.frameUrl && last.url === input.url && last.selector === input.selector && last.value === input.value) return;
    this.events.push({ ...input, targetId });
  }

  markReady(targetId: string): void {
    this.ready.add(targetId);
  }

  deactivate(): void {
    this.active = false;
  }
}

function sameTarget(a: DomTimelineItem, b: DomTimelineItem): boolean {
  return a.targetId === b.targetId && a.frameUrl === b.frameUrl && a.selector === b.selector;
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
  // 标签页按第一次出现的顺序编号；只有一个标签页时不输出 tab。
  const tabNumbers = new Map<string, number>();
  for (const event of sorted) if (!tabNumbers.has(event.targetId)) tabNumbers.set(event.targetId, tabNumbers.size + 1);
  const multiTab = tabNumbers.size > 1;

  const rows: TimelineDomEventItem[] = [];
  sorted.forEach((event, index) => {
    if (event.type === "click") {
      const followedByState = sorted.slice(index + 1).some((later) =>
        later.t - event.t <= CONTROL_WINDOW_MS && isStateChange(later) && sameTarget(event, later));
      if (followedByState) return;
    }
    let actionType: TimelineDomEventItem["actionType"] | undefined;
    if (event.type === "click") actionType = "click";
    else if (event.type === "fill") actionType = "value";
    else if (event.type === "change") actionType = event.checked !== undefined ? "checked" : "value";
    else if (event.type === "scroll") actionType = "scroll";
    else if (event.type === "navigation") actionType = "navigation";
    if (!actionType) return;

    const row: TimelineDomEventItem = { t: event.t, type: "action", actionType };
    if (actionType === "navigation") {
      if (!event.mainFrame) return; // iframe 里的导航（广告、about:blank）不记录
      const previous = rows.at(-1);
      if (previous?.actionType === "navigation" && previous.url === event.url && previous.tab === (multiTab ? tabNumbers.get(event.targetId) : undefined)) return;
      row.url = event.url;
    } else {
      if (event.role) row.role = event.role;
      if (event.name) row.name = event.name;
      if (event.selector) row.selector = event.selector;
    }
    if (actionType === "value") {
      if (event.valueRedacted) row.valueRedacted = true;
      else if (event.value !== undefined) row.value = event.value;
      if (event.selectedText) row.option = event.selectedText;
      // 文本框先 fill、失焦时又触发 change，值相同就只留一条。
      const previous = rows.at(-1);
      if (previous?.actionType === "value" && previous.selector === row.selector && previous.value === row.value && previous.valueRedacted === row.valueRedacted && previous.option === row.option) return;
    }
    if (actionType === "checked") row.checked = event.checked;
    if (actionType === "scroll") {
      const deltaX = Math.round(event.scroll?.deltaX ?? 0);
      const deltaY = Math.round(event.scroll?.deltaY ?? 0);
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < SCROLL_MIN_PX) return;
      if (deltaX) row.deltaX = deltaX;
      if (deltaY) row.deltaY = deltaY;
      if (event.scroll?.nearEnd) row.nearEnd = true;
    }
    if (multiTab) row.tab = tabNumbers.get(event.targetId);
    if (actionType !== "navigation" && !event.mainFrame) row.frame = event.frameUrl;
    rows.push(row);
  });
  return rows;
}

/** 有网络请求、却从没收到页面脚本 ready 信号的页面（按来源去重）：这些页面的点击、输入、滚动没有录到。 */
export function pagesMissingScript(requests: Pick<RawRequest, "targetId" | "url">[], ready: ReadonlySet<string>): string[] {
  const origins = new Map<string, string>();
  for (const request of requests) {
    if (!request.targetId || ready.has(request.targetId) || origins.has(request.targetId)) continue;
    try {
      origins.set(request.targetId, new URL(request.url.bareUrl).origin);
    } catch {
      origins.set(request.targetId, request.url.bareUrl);
    }
  }
  return [...new Set(origins.values())];
}
