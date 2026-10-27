import { randomBytes } from "node:crypto";

// Prints a new AES-256 connector token key as environment lines. The key is a
// secret: put it in the secret store, never in git. It encrypts the OAuth
// tokens users grant a directory connector.
const key = randomBytes(32);
const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const keyId = `mk${date}-${randomBytes(3).toString("hex")}`;

console.log(`MCP_TOKEN_KEYS=${keyId}=${key.toString("base64")}`);
console.log(`MCP_TOKEN_ACTIVE_KEY=${keyId}`);
console.log(`# When rotating, prepend the new key to MCP_TOKEN_KEYS and point`);
console.log(
  `# MCP_TOKEN_ACTIVE_KEY at it; keep the old key in the list so stored`,
);
console.log(`# tokens still decrypt until users reconnect.`);
