"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentProps,
} from "react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";

// Spring caret for a multi-line textarea (adapted from Skiper 106). A hidden
// mirror lays the text out identically so the caret's position can be read.
const SPRING = {
  type: "spring",
  stiffness: 500,
  damping: 30,
  mass: 0.5,
} as const;
// On a line change a horizontal move wider than this snaps instead of
// sweeping diagonally across the text (Enter, wrapping, Home/End jumps).
const SWEEP_LIMIT = 48;
const MIRRORED = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontFeatureSettings",
  "fontVariationSettings",
  "fontKerning",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textTransform",
  "textIndent",
  "textAlign",
  "tabSize",
  "direction",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderTopStyle",
  "borderRightStyle",
  "borderBottomStyle",
  "borderLeftStyle",
] as const;

type Target = { x: number; line: number; width: number };

export function SmoothTextarea({
  ref,
  onFocus,
  onBlur,
  autoGrow,
  ...props
}: ComponentProps<"textarea"> & {
  /** Grow with the text up to this many px (spec composer: 240). Off by default. */
  autoGrow?: number;
}) {
  const input = useRef<HTMLTextAreaElement | null>(null),
    mirror = useRef<HTMLDivElement>(null),
    last = useRef<Target | null>(null);
  const x = useMotionValue(0),
    line = useMotionValue(0),
    scroll = useMotionValue(0),
    height = useMotionValue(0),
    opacity = useMotionValue(0);
  // The line springs in content coordinates; scrolling applies instantly so
  // the caret stays pinned to the text instead of lagging behind it.
  const y = useTransform(() => line.get() - scroll.get());
  const reduced = useReducedMotion();

  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      input.current = el;
      if (typeof ref === "function") return ref(el);
      if (ref) ref.current = el;
    },
    [ref],
  );

  const hide = useCallback(() => {
    opacity.set(0);
    last.current = null;
  }, [opacity]);

  const update = useCallback(() => {
    const el = input.current,
      box = mirror.current;
    if (!el || !box) return;
    if (
      document.activeElement !== el ||
      el.disabled ||
      el.selectionStart !== el.selectionEnd
    )
      return hide();

    const styles = window.getComputedStyle(el);
    for (const key of MIRRORED) box.style[key] = styles[key];
    box.style.boxSizing = "border-box";
    box.style.width = `${
      el.clientWidth +
      parseFloat(styles.borderLeftWidth) +
      parseFloat(styles.borderRightWidth)
    }px`;

    // Text before the caret, then the rest in a span so the word under the
    // caret wraps exactly as it does in the textarea. The span starts where
    // the caret is.
    const index = el.selectionStart ?? 0;
    const tail = document.createElement("span");
    tail.textContent = el.value.slice(index) || ".";
    box.replaceChildren(el.value.slice(0, index), tail);

    const fontSize = parseFloat(styles.fontSize);
    const glyph = tail.getClientRects()[0]?.height || fontSize * 1.2;
    const size = Math.round(Math.min(glyph, fontSize * 1.25));
    const left = Math.min(
      el.offsetLeft + el.clientLeft + tail.offsetLeft - el.scrollLeft - 1,
      el.offsetLeft + el.clientLeft + el.clientWidth - 2,
    );
    const top =
      el.offsetTop + el.clientTop + tail.offsetTop + (glyph - size) / 2;
    const width = el.clientWidth;

    const inView =
      top - el.scrollTop >= el.offsetTop + el.clientTop - 1 &&
      top - el.scrollTop + size <=
        el.offsetTop + el.clientTop + el.clientHeight + 1;
    scroll.jump(el.scrollTop);
    height.set(size);
    opacity.set(inView ? 1 : 0);

    const prev = last.current;
    last.current = { x: left, line: top, width };
    if (prev && prev.x === left && prev.line === top) return;

    if (reduced || !prev || prev.width !== width) {
      x.jump(left);
      line.jump(top);
      return;
    }
    const lineChanged = prev.line !== top;
    if (lineChanged && Math.abs(left - prev.x) > SWEEP_LIMIT) x.jump(left);
    else if (left !== prev.x) animate(x, left, SPRING);
    if (lineChanged) animate(line, top, SPRING);
  }, [hide, reduced, x, line, scroll, height, opacity]);

  // Spec composer (Core §2): height = auto, then min(scrollHeight, cap).
  useLayoutEffect(() => {
    const el = input.current;
    if (!autoGrow || !el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, autoGrow)}px`;
  }, [props.value, autoGrow]);

  // Measure after the commit settles, so the parent's auto-resize has run.
  useEffect(() => {
    queueMicrotask(update);
  }, [props.value, props.disabled, update]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const onSelection = () => {
      if (document.activeElement === el) update();
    };
    document.addEventListener("selectionchange", onSelection);
    document.fonts.addEventListener("loadingdone", update);
    void document.fonts.ready.then(update);
    el.addEventListener("scroll", update);
    window.addEventListener("blur", hide);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      document.removeEventListener("selectionchange", onSelection);
      document.fonts.removeEventListener("loadingdone", update);
      el.removeEventListener("scroll", update);
      window.removeEventListener("blur", hide);
      observer.disconnect();
    };
  }, [update, hide]);

  return (
    <div className="smooth-field">
      <textarea
        {...props}
        ref={setRef}
        onFocus={(e) => {
          update();
          onFocus?.(e);
        }}
        onBlur={(e) => {
          hide();
          onBlur?.(e);
        }}
      />
      <div ref={mirror} className="smooth-mirror" aria-hidden="true" />
      <motion.div
        className="smooth-caret"
        aria-hidden="true"
        style={{ x, y, height, opacity }}
      />
    </div>
  );
}
