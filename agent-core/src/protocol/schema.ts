import Ajv from "ajv";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import inventory from "../../../shared/protocol-inventory.json";
import { HttpError } from "../errors";
const root = resolve(process.env.PROJECT_ROOT || "..");
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
export function schema(name: string): any {
  for (const prefix of ["", "v2/", "v1/"]) {
    const file = resolve(root, "shared/schema", prefix + name + ".json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  }
  throw new Error(`Schema not found: ${name}`);
}
export function validate(name: string, value: unknown) {
  let check = validators.get(name);
  if (!check) {
    check = ajv.compile(schema(name));
    validators.set(name, check);
  }
  if (!check(value))
    throw new HttpError(
      400,
      `Invalid ${name}: ${ajv.errorsText(check.errors)}`,
      "INVALID_INPUT",
    );
}
export function validateRequest(method: string, params: unknown) {
  const entry = inventory.requests.find((x) => x.method === method);
  if (!entry)
    throw new HttpError(
      400,
      "Method is not in the pinned protocol",
      "UNKNOWN_METHOD",
    );
  validate("ClientRequest", { id: 0, method, params });
  return entry;
}
export { inventory };
