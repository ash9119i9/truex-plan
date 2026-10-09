import { documentKind } from "@/lib/document-kind";
import { Icon, type IconName } from "./v2/icon";

// Closest v2 icons (Foundations §5): sheets → table, slides → chart, else doc.
const icons: Record<string, IconName> = {
  code: "doc",
  sheet: "table",
  slides: "chart",
  text: "doc",
  document: "doc",
  image: "doc",
};

// Decorative: the row's text already names the file and its type.
export function DocumentIcon({ name, size }: { name: string; size: number }) {
  return <Icon name={icons[documentKind(name).kind] ?? "doc"} size={size} />;
}
