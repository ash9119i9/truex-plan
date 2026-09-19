import type { DomainEvent } from "../../shared/contracts";
import { api, base } from "./api";
export interface Transport {
  subscribe(
    sessionId: string,
    onEvent: (e: DomainEvent) => void,
    onStatus: (s: string) => void,
  ): () => void;
  send(sessionId: string, text: string, clientId: string): Promise<any>;
  interrupt(sessionId: string): Promise<any>;
  answer(sessionId: string, requestId: string, result: unknown): Promise<any>;
}
export const transport: Transport = {
  subscribe(sessionId, onEvent, onStatus) {
    const key = `cursor:${sessionId}`,
      cursor = sessionStorage.getItem(key) || "";
    const source = new EventSource(
      `${base}/api/sessions/${sessionId}/events${cursor ? "?cursor=" + encodeURIComponent(cursor) : ""}`,
    );
    source.onopen = () => onStatus("Connected");
    source.onerror = () => onStatus("Reconnecting");
    source.onmessage = (message) => {
      const event = JSON.parse(message.data);
      if (message.lastEventId) sessionStorage.setItem(key, message.lastEventId);
      onEvent(event);
    };
    return () => source.close();
  },
  send: (id, text, clientId) =>
    api(`/api/sessions/${id}/messages`, { text, clientId }),
  interrupt: (id) => api(`/api/sessions/${id}/interrupt`, {}),
  answer: (id, requestId, result) =>
    api(`/api/sessions/${id}/approvals/${encodeURIComponent(requestId)}`, {
      result,
    }),
};
