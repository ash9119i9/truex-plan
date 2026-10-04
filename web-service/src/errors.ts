import {
  webSearchErrors,
  type WebSearchErrorCode,
} from "../../shared/web-search";

export class SearchError extends Error {
  constructor(
    readonly status: number,
    readonly code: WebSearchErrorCode,
    readonly retryable = false,
  ) {
    super(webSearchErrors[code]);
  }
}
