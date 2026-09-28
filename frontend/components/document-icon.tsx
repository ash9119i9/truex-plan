import {
  FileCode,
  FileSpreadsheet,
  FileText,
  Presentation,
} from "lucide-react";
import { documentKind } from "@/lib/document-kind";

const icons = {
  code: FileCode,
  sheet: FileSpreadsheet,
  slides: Presentation,
  text: FileText,
  document: FileText,
};

// Decorative: the row's text already names the file and its type.
export function DocumentIcon({ name, size }: { name: string; size: number }) {
  const Icon = icons[documentKind(name).kind];
  return <Icon size={size} aria-hidden="true" />;
}
