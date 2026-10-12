// Compile the actual TSX components for CPU-only React server-render regressions.
// No DOM shim, provider, application server or source-text assertions are used.
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);
const frontend = resolve(import.meta.dirname, "..");
const modules = new Map<string, { exports: any }>();
export function component(path: string): any {
  return load(resolve(frontend, "components", path));
}
function load(filename: string): any {
  const cached = modules.get(filename);
  if (cached) return cached.exports;
  const module = { exports: {} };
  modules.set(filename, module);
  // Optional frozen originals make before/after regression runs reproducible.
  const baseline = process.env.NEXT_DETAILS_BASELINE_DIR;
  const directory = resolve(frontend, "components");
  const relative = filename.slice(directory.length + 1);
  const selected =
    baseline &&
    filename.startsWith(directory + "/") &&
    relative &&
    existsSync(resolve(baseline, relative))
      ? resolve(baseline, relative)
      : filename;
  const compiled = ts.transpileModule(readFileSync(selected, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  const localRequire = (specifier: string) => {
    // Styles have no behavior in server-rendered component tests.
    if (specifier.endsWith(".css")) return {};
    if (!specifier.startsWith(".") && !specifier.startsWith("@/"))
      return require(specifier);
    const path = specifier.startsWith("@/")
      ? resolve(frontend, specifier.slice(2))
      : resolve(dirname(filename), specifier);
    const source = [path, `${path}.ts`, `${path}.tsx`].find(existsSync);
    if (!source)
      throw new Error(`Component dependency not found: ${specifier}`);
    return /\.tsx?$/.test(source) ? load(source) : require(source);
  };
  new Function("require", "module", "exports", compiled)(
    localRequire,
    module,
    module.exports,
  );
  return module.exports;
}
