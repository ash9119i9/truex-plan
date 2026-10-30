"use client";
import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { Button } from "@/components/tx/button";
import { Chip } from "@/components/tx/chip";
import { Icon } from "@/components/tx/icon";
import { Segmented } from "@/components/tx/segmented";
import {
  AUTO_SIG,
  GUIDE_ITEM_MAX,
  GUIDE_ITEMS,
  GUIDE_TEXT_MAX,
  linesOf,
  plural,
  withIdea,
  type GuideAs,
} from "@/lib/agent-desk";

// The Agent ID desk's Rules editors and signature pad (DESIGN-SPEC 15.3),
// ported from system/screens/agent-id.html.

const rowsOf = (value: string) => (value === "" ? [] : value.split("\n"));

// A single choice as radio cards, two across (the study's scope rows): a real
// radio input, its label and a hint. Used for "What it answers" and "Who can
// use it".
export function DeskRadios<T extends string>({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string;
  value: T;
  options: { id: T; label: string; hint: string }[];
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="idd-set">
      <legend className="idd-label">{legend}</legend>
      <div className="idd-scope-row">
        {options.map((option) => (
          <label
            key={option.id}
            className={
              option.id === value
                ? "idd-scope-option is-on"
                : "idd-scope-option"
            }
          >
            <input
              type="radio"
              name={name}
              checked={option.id === value}
              onChange={() => onChange(option.id)}
            />
            <span>
              <b>{option.label}</b>
              <small>{option.hint}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// Rules and behaviour share one editor: a bullet list (Enter adds a line,
// Backspace on an empty line removes it) or free text. Both write the same
// newline-separated string.
export function GuideEditor({
  label,
  noun,
  value,
  as,
  onChange,
  onAs,
  placeholder,
  ideas,
}: {
  label: string;
  noun: string;
  value: string;
  as: GuideAs;
  onChange: (value: string) => void;
  onAs: (as: GuideAs) => void;
  placeholder: string;
  ideas: string[];
}) {
  const id = useId();
  // Rows live here so an empty row can exist while it's typed; a change from
  // outside (an idea, a format switch, a fresh draft) resets them.
  const [items, setItems] = useState<string[]>(() => rowsOf(value));
  useEffect(() => {
    setItems((rows) => (rows.join("\n") === value ? rows : rowsOf(value)));
  }, [value]);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const [focusAt, setFocusAt] = useState<number | null>(null);
  useEffect(() => {
    if (focusAt === null) return;
    refs.current[focusAt]?.focus();
    setFocusAt(null);
  }, [focusAt]);

  const write = (next: string[]) => {
    setItems(next);
    onChange(next.join("\n"));
  };
  const lines = linesOf(value);
  const full = items.length >= GUIDE_ITEMS;
  const add = (text = "", at = items.length) => {
    if (full) return;
    const next = [...items];
    next.splice(at, 0, text);
    write(next);
    if (!text) setFocusAt(at);
  };
  const remove = (at: number, focus: number) => {
    write(items.filter((_, i) => i !== at));
    setFocusAt(focus);
  };
  const unused = ideas.filter(
    (idea) => !lines.some((line) => line.toLowerCase() === idea.toLowerCase()),
  );
  const switchTo = (next: GuideAs) => {
    if (next === as) return;
    setItems(lines);
    onChange(lines.join("\n"));
    onAs(next);
  };
  const count = !lines.length
    ? "none yet"
    : as === "text"
      ? `${value.trim().length}/${GUIDE_TEXT_MAX}`
      : plural(lines.length, noun);

  return (
    <section className="idd-set idd-guide" aria-labelledby={id}>
      <div className="idd-label-row">
        <span className="idd-label" id={id}>
          {label} <span className="idd-hint">{count}</span>
        </span>
        <Segmented
          label={`${label} format`}
          size="sm"
          value={as}
          options={[
            { value: "list", label: "Bullets" },
            { value: "text", label: "Text" },
          ]}
          onChange={switchTo}
        />
      </div>
      {as === "text" ? (
        <textarea
          className="tx-input"
          rows={4}
          value={value}
          maxLength={GUIDE_TEXT_MAX}
          placeholder={placeholder}
          aria-labelledby={id}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <ul className="idd-gl" aria-labelledby={id}>
          {items.map((text, i) => (
            <li key={i} className="idd-gl-row">
              <span className="idd-gl-dot" aria-hidden="true" />
              <input
                ref={(el) => {
                  refs.current[i] = el;
                }}
                className="tx-input"
                value={text}
                maxLength={GUIDE_ITEM_MAX}
                placeholder={placeholder}
                aria-label={`${label} ${i + 1}`}
                onChange={(e) => {
                  const next = [...items];
                  next[i] = e.target.value;
                  write(next);
                }}
                onKeyDown={(e) => {
                  // Enter must not submit the form: it starts the next line.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (text.trim()) add("", i + 1);
                  } else if (e.key === "Backspace" && !text) {
                    e.preventDefault();
                    remove(i, Math.max(0, i - 1));
                  }
                }}
              />
              <Button
                className="idd-gl-x"
                iconOnly
                icon="x"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${noun} ${i + 1}`}
                onClick={() => remove(i, Math.min(i, items.length - 2))}
              />
            </li>
          ))}
          <li className="idd-gl-add">
            <Button
              variant="ghost"
              size="sm"
              icon="plus"
              disabled={full}
              onClick={() => add()}
            >
              {full ? `${GUIDE_ITEMS} is the most` : `Add ${noun}`}
            </Button>
          </li>
        </ul>
      )}
      {unused.length > 0 && !full && (
        <div
          className="idd-ideas"
          role="group"
          aria-label={`Suggested ${noun}s`}
        >
          {unused.map((idea) => (
            <Chip
              key={idea}
              className="idd-idea"
              title={idea}
              onClick={() =>
                as === "text" ? onChange(withIdea(value, idea)) : add(idea)
              }
            >
              <Icon name="plus" size="sm" />
              <span className="idd-idea-t">{idea}</span>
            </Chip>
          ))}
        </div>
      )}
    </section>
  );
}

// A long scribble stops growing here, so the path can't grow without bound.
const SIG_MAX = 20_000;

// Draw on the strip with a pointer; "Sign for me" covers keyboard users.
// Paths are kept in a 240×60 box.
export function SignPad({
  value,
  onChange,
  onStart,
}: {
  value: string;
  onChange: (sig: string) => void;
  onStart: () => void;
}) {
  const [live, setLive] = useState("");
  const path = useRef("");
  const down = useRef(false);
  const at = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * 240;
    const y = ((e.clientY - box.top) / box.height) * 60;
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  };
  const end = () => {
    if (!down.current) return;
    down.current = false;
    onChange(path.current);
    setLive("");
  };
  return (
    <div className="idd-sign">
      <svg
        className="idd-sign-pad"
        viewBox="0 0 240 60"
        role="img"
        aria-label={value ? "Signature drawn" : "Signature pad, empty"}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          down.current = true;
          onStart();
          path.current = (value ? value + " " : "") + "M" + at(e);
          setLive(path.current);
        }}
        onPointerMove={(e) => {
          if (!down.current || path.current.length > SIG_MAX) return;
          path.current += " L" + at(e);
          setLive(path.current);
        }}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <line
          className="idd-sign-line"
          x1="12"
          y1="48"
          x2="228"
          y2="48"
          strokeWidth={1}
        />
        <text className="idd-sign-x" x="12" y="44" fontSize={12}>
          ×
        </text>
        <path d={live || value} strokeWidth={2.2} />
      </svg>
      <div className="idd-sign-ctl">
        <Button
          size="sm"
          onClick={() => {
            onStart();
            onChange(AUTO_SIG);
          }}
        >
          Sign for me
        </Button>
        <Button size="sm" disabled={!value} onClick={() => onChange("")}>
          Clear
        </Button>
      </div>
    </div>
  );
}
