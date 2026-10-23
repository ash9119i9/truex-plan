// Agent looks and tints (docs/truex-design-spec.html, Foundations §3 and
// Session §7; source app.tsx:46-89). Pure data so node tests can import it.
import type { AgentTint } from "../../shared/contracts";

export interface Look {
  name: string;
  body: string;
  visor: string;
  glow: string;
  face: "line" | "eyes" | "happy";
  acc?: string;
  accColor?: string;
}
export const LOOKS: Look[] = [
  {
    name: "Graphite",
    body: "#3A4750",
    visor: "#1F2A30",
    glow: "#BCDEE8",
    face: "line",
  },
  {
    name: "Antenna",
    body: "#F4F7F8",
    visor: "#2B3F6B",
    glow: "#BCDEE8",
    face: "eyes",
    acc: "antenna",
  },
  {
    name: "Navy",
    body: "#2E4470",
    visor: "#16213A",
    glow: "#BCDEE8",
    face: "line",
  },
  {
    name: "Listener",
    body: "#D5DDE1",
    visor: "#2B3F6B",
    glow: "#BCDEE8",
    face: "happy",
    acc: "headphones",
    accColor: "#3691CD",
  },
  {
    name: "Scout",
    body: "#D8C3A0",
    visor: "#3A4750",
    glow: "#EBCB8B",
    face: "line",
    acc: "cap",
    accColor: "#E07B6E",
  },
  {
    name: "Chef",
    body: "#F4F7F8",
    visor: "#2B3F6B",
    glow: "#BCDEE8",
    face: "eyes",
    acc: "chef",
  },
  {
    name: "Builder",
    body: "#F4F7F8",
    visor: "#3A4750",
    glow: "#EBCB8B",
    face: "eyes",
    acc: "hardhat",
    accColor: "#F2C94C",
  },
  {
    name: "Scarf",
    body: "#3A4750",
    visor: "#1F2A30",
    glow: "#F0B999",
    face: "happy",
    acc: "scarf",
    accColor: "#E07B6E",
  },
  {
    name: "Mint",
    body: "#BFE3CF",
    visor: "#1F2A30",
    glow: "#A9D5BE",
    face: "eyes",
    acc: "antenna",
  },
  {
    name: "Lilac",
    body: "#CFC8EC",
    visor: "#2B3F6B",
    glow: "#C4BDE3",
    face: "happy",
    acc: "bow",
    accColor: "#F0A3B5",
  },
  {
    name: "Peach",
    body: "#F5C7A8",
    visor: "#3A4750",
    glow: "#F0B999",
    face: "line",
    acc: "headphones",
    accColor: "#3A4750",
  },
  {
    name: "Captain",
    body: "#2E4470",
    visor: "#16213A",
    glow: "#BCDEE8",
    face: "eyes",
    acc: "cap",
    accColor: "#3691CD",
  },
];

// `bg` is the badge background; `dot` is the strap colour and agent hue.
// Fixed hex values: tints do not change in dark mode.
export interface Tint {
  id: AgentTint;
  label: string;
  bg: string;
  dot: string;
}
export const TINTS: Tint[] = [
  { id: "ice", label: "Ice", bg: "#EAF5F8", dot: "#3691CD" },
  { id: "mint", label: "Mint", bg: "#E7F4ED", dot: "#A9D5BE" },
  { id: "butter", label: "Butter", bg: "#FFF3D9", dot: "#EBCB8B" },
  { id: "peach", label: "Peach", bg: "#FBE9DD", dot: "#F0B999" },
  { id: "lilac", label: "Lilac", bg: "#EFEDF8", dot: "#C4BDE3" },
];

export const tintOf = (id?: string): Tint =>
  TINTS.find((t) => t.id === id) || TINTS[0];
export const lookOf = (i?: number): Look =>
  (i === undefined ? undefined : LOOKS[i]) || LOOKS[0];

// Mix a hex colour toward white (amt > 0) or black (amt < 0); used for the robots' shading.
export const tone = (hex: string, amt: number): string => {
  const n = parseInt(hex.slice(1), 16),
    t = amt < 0 ? 0 : 255,
    k = Math.abs(amt);
  const ch = (sh: number) =>
    Math.round(((n >> sh) & 255) + (t - ((n >> sh) & 255)) * k)
      .toString(16)
      .padStart(2, "0");
  return "#" + ch(16) + ch(8) + ch(0);
};

export const CONFETTI_COLORS = [
  "#3691CD",
  "#BCDEE8",
  "#A9D5BE",
  "#EBCB8B",
  "#F0B999",
  "#C4BDE3",
  "#F2C94C",
];
