import { errorFields, log } from "../../../shared/logging";
import { publicEvent } from "../public/events";
export class PublicEventStream {
  private buffer = "";
  private decoder = new TextDecoder();
  // Observes each public event, for example to persist goal summaries. An
  // observer may return a replacement event (for example a snapshot with the
  // saved plan filled in).
  constructor(
    private readonly onEvent?: (event: any) => any,
    private readonly strictSync = false,
  ) {}
  push(chunk: Uint8Array): string {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    if (this.buffer.length > 4 * 1024 * 1024)
      throw new Error("Event exceeds stream limit");
    let output = "",
      boundary: number;
    while ((boundary = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      if (frame.startsWith(":")) {
        output += ": heartbeat\n\n";
        continue;
      }
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      let event;
      try {
        const raw = JSON.parse(data);
        if (
          this.strictSync &&
          (!raw ||
            typeof raw.type !== "string" ||
            !raw.data ||
            typeof raw.data !== "object" ||
            Array.isArray(raw.data))
        )
          throw new TypeError("Invalid synchronized event envelope");
        event = publicEvent(raw);
        if (this.strictSync && raw.type === "sync.completed" && !event)
          throw new TypeError("Invalid synchronized completion marker");
      } catch (error) {
        // Legacy streams can skip a bad frame. A synchronized stream cannot
        // acknowledge a high-water cursor after losing public state.
        log(
          "warn",
          this.strictSync
            ? "Rejected malformed synchronized update"
            : "skipped malformed live update",
          {
            op: "stream",
            bytes: data.length,
            ...errorFields(error),
          },
        );
        if (this.strictSync) throw error;
        continue;
      }
      if (event && this.onEvent)
        try {
          event = this.onEvent(event) ?? event;
        } catch (error) {
          if (this.strictSync) throw error;
          // Legacy observers do not interrupt the live stream.
        }
      if (event)
        output += `${event.cursor ? "id: " + event.cursor + "\n" : ""}data: ${JSON.stringify(event)}\n\n`;
    }
    return output;
  }
}
