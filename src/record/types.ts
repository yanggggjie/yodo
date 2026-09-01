import type { YodoUrl } from "../utils/url.js";
export type { YodoUrl };

export type Redaction = {
  location: "query" | "header" | "request-body" | "response-body";
  path: string;
  alias: string;
  shape: "jwt" | "uuid" | "hex" | "base64url" | "numeric" | "text" | "opaque";
  bytes: number;
};

export type RequestKind = "document" | "xhr" | "fetch" | "other";
export type TimelineRequestType = "mainDoc" | "doc" | "fetch" | "xhr";
export type TimelineActionType = "click" | "submit" | "scroll";

export type TimelineRequestItem = {
  t: number;
  type: "request";
  requestType: TimelineRequestType;
  method: string;
  url: string;
  file: string;
};

export type TimelineActionItem = {
  t: number;
  type: "action";
  actionType: TimelineActionType;
  name?: string;
  role?: string;
};

export type TimelineItem = TimelineRequestItem | TimelineActionItem;

export type RawRequest = {
  id: string;
  requestType: TimelineRequestType;
  mainFrame: boolean;
  method: string;
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

export type RawAction = {
  actionType: TimelineActionType;
  startedAt: number;
  frameUrl: YodoUrl;
  role?: string;
  name?: string;
  id?: string;
  targetId?: string;
};

export type RawEvent = RawRequest | RawAction;

export function isRawAction(entry: RawEvent): entry is RawAction {
  return "actionType" in entry;
}

export function isRawRequest(entry: RawEvent): entry is RawRequest {
  return "requestType" in entry;
}
