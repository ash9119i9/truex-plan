"use client";
import { sandboxedDocx } from "@/lib/tenant-files";

// A Word document in the file viewer. Its HTML comes from mammoth, so it is
// shown only in a frame with every sandbox flag off: no script, no
// same-origin access, no forms or navigation, and no network.
export function DocView({ html }: { html: string }) {
  return (
    <iframe
      className="fv-frame"
      title="Document preview"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={sandboxedDocx(html)}
    />
  );
}
