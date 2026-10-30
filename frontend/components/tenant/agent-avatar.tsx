"use client";
import { tintOf } from "@/lib/agent-look";
import { Robot } from "@/components/v2/agent-badge";
import { initials } from "@/components/auth/workspace-frame";

// An agent's profile picture: its robot look on its tint, the same pair the
// team board shows. Without a look (no agent chosen yet) it falls back to
// the name's initials, or "?" with no name.
export function AgentAvatar({
  name,
  look,
  tint,
}: {
  name?: string;
  look?: number;
  tint?: string;
}) {
  if (look === undefined) {
    return (
      <span className="cs-agent-av" aria-hidden="true">
        {name ? initials(name) : "?"}
      </span>
    );
  }
  return (
    <span
      className="cs-agent-av has-robot"
      aria-hidden="true"
      style={{ background: tintOf(tint).bg }}
    >
      <Robot look={look} size={24} />
    </span>
  );
}
