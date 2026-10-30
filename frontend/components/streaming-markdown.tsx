"use client";
import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import type { ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { createIncrementalMarkdownPlugin } from "@/lib/markdown-incremental";

const staticPlugins = [remarkGfm];
const markdownComponents = { pre: CodeBlock };

// Clipboard bytes come from the answer or rendered code, never innerHTML.
export function CopyTextButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">(
    "idle",
  );
  const request = useRef(0);
  useEffect(() => {
    request.current++;
    setState("idle");
    return () => {
      request.current++;
    };
  }, [text]);
  async function copy() {
    const current = ++request.current;
    setState("copying");
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (current === request.current) setState("copied");
    } catch {
      if (current === request.current) setState("failed");
    }
  }
  return (
    <span className="message-copy">
      <button
        type="button"
        className="tx-btn tx-ghost tx-xs"
        aria-label={label}
        disabled={state === "copying"}
        onClick={copy}
      >
        {state === "copying" ? "Copying…" : label}
      </button>
      <span className="copy-feedback muted sm" role="status">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Couldn’t copy. Select the text and copy it."
            : ""}
      </span>
    </span>
  );
}

function CodeBlock({
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const [wrapped, setWrapped] = useState(false);
  const parts = Children.toArray(children);
  const child = parts[0];
  const code =
    parts.length === 1 &&
    isValidElement<{ children?: ReactNode }>(child) &&
    child.type === "code" &&
    typeof child.props.children === "string"
      ? child.props.children
      : null;
  if (code === null) return <pre {...props}>{children}</pre>;
  const language =
    (isValidElement<{ className?: string }>(child) &&
      /language-([\w+#.-]+)/.exec(child.props.className ?? "")?.[1]) ||
    "code";
  return (
    <div className="code-block" data-wrapped={wrapped}>
      <div className="code-bar">
        <span className="code-lang">{language}</span>
        <button
          type="button"
          className="tx-btn tx-ghost tx-xs"
          aria-pressed={wrapped}
          onClick={() => setWrapped((value) => !value)}
        >
          Wrap lines
        </button>
        <CopyTextButton text={code} label="Copy code" />
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
}

// Same activation boundary as T3's ChatMarkdown: streaming documents containing
// code fences, using only the known remark pipeline. Final answers get a full parse.
export const StreamingMarkdown = memo(function StreamingMarkdown({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const incremental = streaming && /(?:^|\n) {0,3}(?:`{3}|~{3})/.test(text);
  const plugins = useMemo(
    () =>
      incremental
        ? [...staticPlugins, createIncrementalMarkdownPlugin()]
        : staticPlugins,
    [incremental],
  );
  return (
    <Markdown remarkPlugins={plugins} components={markdownComponents}>
      {text}
    </Markdown>
  );
});
