import vm from "node:vm";
import { HttpError } from "../../errors";
import { code } from "./paths";
import { workspaceLimits as L } from "./specs";

export function globRegex(glob: string) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        out += "(?:.*/)?";
      } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
export function searchRegex(
  pattern: string,
  literal?: boolean,
  ignoreCase?: boolean,
) {
  const source = literal
    ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : pattern;
  if (
    !literal &&
    /\((?:[^()\\]|\\.)*[*+}](?:[^()\\]|\\.)*\)\s*[*+{]/.test(pattern)
  )
    throw new HttpError(
      400,
      "Nested repeated groups such as (a+)+ are not supported; simplify the pattern or use literal",
    );
  try {
    return new RegExp(source, ignoreCase ? "i" : "");
  } catch (error) {
    throw new HttpError(
      400,
      `Invalid search pattern: ${(error as Error).message}`,
    );
  }
}

// Regex search runs inside vm with a timeout so catastrophic backtracking the
// shape check misses (e.g. (a|a)*b) is interrupted instead of blocking the process.
// The budget counts only regex time, so reading many files cannot use it up.
const searchContext = vm.createContext({});
const searchScript = new vm.Script(
  "(() => { const o = []; for (let i = 0; i < l.length && o.length <= m; i++) if (r.test(l[i])) o.push(i); return o; })()",
);
export function matchLines(
  regex: RegExp,
  all: string[],
  max: number,
  budget: { ms: number },
): number[] {
  const slow = () =>
    new HttpError(
      400,
      `Search pattern took longer than ${L.searchMs / 1000} s; simplify the regular expression or use literal`,
    );
  const timeout = Math.floor(budget.ms),
    started = Date.now();
  if (timeout < 1) throw slow();
  Object.assign(searchContext, { r: regex, l: all, m: max });
  try {
    return [...searchScript.runInContext(searchContext, { timeout })];
  } catch (error) {
    if (code(error) === "ERR_SCRIPT_EXECUTION_TIMEOUT") throw slow();
    throw error;
  } finally {
    budget.ms -= Date.now() - started;
    Object.assign(searchContext, { r: null, l: null });
  }
}
