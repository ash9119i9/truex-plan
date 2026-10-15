import { ObjectId } from "mongodb";

// IDs travel as canonical 24-character lowercase hex strings and are stored as
// ObjectIds. Only the exact canonical form is accepted at a boundary.
const WIRE_ID = /^[0-9a-f]{24}$/;

export function parseWireId(value: unknown): ObjectId | null {
  return typeof value === "string" && WIRE_ID.test(value)
    ? ObjectId.createFromHexString(value)
    : null;
}

export function toWireId(id: ObjectId): string {
  return id.toHexString();
}
