"use client";
import { memo, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createIncrementalMarkdownPlugin } from "@/lib/markdown-incremental";

const staticPlugins = [remarkGfm];

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
  return <Markdown remarkPlugins={plugins}>{text}</Markdown>;
});
