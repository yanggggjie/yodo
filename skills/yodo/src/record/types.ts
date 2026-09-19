import type { YodoUrl } from "../utils/url.ts";
export type { YodoUrl };

export type Redaction = {
  location: "query" | "header" | "request-body" | "response-body";
  path: string;
  alias: string;
  shape: "jwt" | "uuid" | "hex" | "base64url" | "numeric" | "text" | "opaque";
  bytes: number;
};

export type RequestKind = "document" | "xhr" | "fetch";
export type TimelineRequestType = "mainDoc" | "doc" | "fetch" | "xhr";
export type DomEventType =
  | "click"
  | "fill"
  | "change"
  | "submit"
  | "keydown"
  | "scroll"
  | "navigation"
  | "final-state";

export type TimelineRequestItem = {
  t: number;
  type: "request";
  requestType: TimelineRequestType;
  method?: string;
  url: string;
  file: string;
};

export type TimelineDomEventItem = {
  eventId: string;
  t: number;
  type: "action";
  actionType: Exclude<DomEventType, "final-state">;
  role?: string;
  name?: string;
  key?: string;
  url?: string;
};

export type DomElement = {
  tag: string;
  id?: string;
  classes?: string[];
  attributes?: Record<string, string>;
  selectors?: string[];
  children?: DomElement[];
  childrenTruncated?: true;
};

export type DomTimelineItem = {
  eventId: string;
  t: number;
  type: DomEventType;
  url: string;
  frameUrl: string;
  mainFrame: boolean;
  targetId: string;
  target?: DomElement;
  ancestors?: DomElement[];
  children?: DomElement[];
  childrenTruncated?: true;
  value?: string;
  valueRedacted?: true;
  key?: string;
  code?: string;
  modifiers?: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
  role?: string;
  name?: string;
  checked?: boolean;
  selectedText?: string;
  scroll?: {
    left: number;
    top: number;
    deltaX: number;
    deltaY: number;
    nearEnd: boolean;
  };
  title?: string;
  elements?: DomElement[];
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

export function isRawRequest(entry: RawEvent): entry is RawRequest {
  return "requestType" in entry;
}
