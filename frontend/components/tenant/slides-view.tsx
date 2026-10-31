"use client";
import type { Deck } from "@/lib/office/pptx";

// A presentation in the file viewer: one card per slide with its title, text
// and pictures, in order. Text is rendered as React text, so a slide's text
// can't become markup; images are raster data: URLs only (lib/office/pptx).
export function SlidesView({ deck }: { deck: Deck }) {
  if (!deck.slides.length)
    return <p className="fv-note">This presentation has no slides to show.</p>;
  return (
    <div className="fv-slides">
      {deck.slides.map((slide, i) => (
        <section
          key={i}
          className="fv-slide"
          aria-label={`Slide ${i + 1} of ${deck.slides.length}`}
        >
          <p className="fv-slide-num">Slide {i + 1}</p>
          {slide.title && <h3 className="fv-slide-title">{slide.title}</h3>}
          {slide.paragraphs.map((text, j) => (
            <p key={j} className="fv-slide-text">
              {text}
            </p>
          ))}
          {slide.images.map((src, j) => (
            <img
              key={j}
              className="fv-slide-img"
              src={src}
              alt={`Picture ${j + 1} on slide ${i + 1}`}
            />
          ))}
        </section>
      ))}
      {deck.truncated && (
        <p className="fv-note">
          The preview shows the first {deck.slides.length} slides. Download the
          file to see the rest.
        </p>
      )}
    </div>
  );
}
