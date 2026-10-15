import { Hero } from "@/components/v2/hero";

export default function ChatPage() {
  return (
    <section className="workspace-empty" aria-label="Chat">
      <Hero>
        <p className="workspace-empty-note" role="status">
          Your workspace is ready. Chat will be available here soon.
        </p>
      </Hero>
    </section>
  );
}
