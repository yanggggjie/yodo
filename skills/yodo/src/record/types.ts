import type { YodoUrl } from "../utils/url.ts";
export type { YodoUrl };

export type Redaction = {
  location: "query" | "header" | "request-body" | "response-body";
  path: string;
  alias: string;
  shape: "jwt" | "uuid" | "hex" | "base64url" | "numeric" | "text" | "opaque";
};

export type RequestKind = "document" | "xhr" | "fetch";
export type TimelineRequestType = "mainDoc" | "doc" | "fetch" | "xhr";
export type DomEventType =
  | "click"
  | "fill"
  | "change"
  | "scroll"
  | "navigation";

export type TimelineRequestItem = {
  t: number;
  type: "request";
  requestType: TimelineRequestType;
  method?: string;
  url: string;
  file: string;
};

/** 录制的操作类型：click、value、checked、scroll，以及 navigation。 */
export type TimelineActionType = "click" | "value" | "checked" | "scroll" | "navigation";

/**
 * timeline 里的一条操作。selector 是页面里尽量稳定且唯一的 CSS 选择器；
 * value 是输入后的值（密码等敏感字段只有 valueRedacted）；checked 是勾选后的状态；
 * option 是下拉框选中项的文字；deltaX、deltaY 是滚动量（整页滚动没有 selector）；
 * tab 是第几个标签页（只有一个标签页时省略）；frame 是 iframe 的地址（主页面省略）。
 */
export type TimelineDomEventItem = {
  t: number;
  type: "action";
  actionType: TimelineActionType;
  role?: string;
  name?: string;
  selector?: string;
  value?: string;
  valueRedacted?: true;
  checked?: boolean;
  option?: string;
  deltaX?: number;
  deltaY?: number;
  nearEnd?: true;
  tab?: number;
  frame?: string;
  url?: string;
};

/** 页面脚本回传的一个事件，stop 时由 simpleDomTimeline 整理成 TimelineDomEventItem。 */
export type DomTimelineItem = {
  t: number;
  type: DomEventType;
  url: string;
  frameUrl: string;
  mainFrame: boolean;
  targetId: string;
  role?: string;
  name?: string;
  selector?: string;
  value?: string;
  valueRedacted?: true;
  checked?: boolean;
  selectedText?: string;
  scroll?: { deltaX: number; deltaY: number; nearEnd: boolean };
};

export type TimelineItem = TimelineRequestItem | TimelineDomEventItem;

export type RawRequest = {
  id: string;
  requestType: TimelineRequestType;
  mainFrame: boolean;
  method?: string;
  url: YodoUrl;
  frameUrl: YodoUrl;
  headers: Record<string, string>;
  responseHeaders?: Record<string, string>;
  status?: number;
  requestBody: unknown | null;
  requestBodyUnavailableReason?: string;
  responseBody: unknown | null;
  responseBodyUnavailableReason?: string;
  responseBodyPath?: string;
  errorText?: string;
  startedAt: number;
  endedAt?: number;
  targetId?: string;
  late?: boolean;
};

export type RawEvent = RawRequest;
