import { generateKeyPairSync, randomBytes } from "node:crypto";

// Prints a new Ed25519 access-token signing key as environment lines. The
// private key is a secret: put it in the secret store, never in git.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const kid = `k${date}-${randomBytes(3).toString("hex")}`;
const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
const publicDer = publicKey.export({ format: "der", type: "spki" });

console.log(`AUTH_SIGNING_KEY_ID=${kid}`);
console.log(`AUTH_SIGNING_KEY=${privateDer.toString("base64")}`);
console.log(
  `# When rotating away from this key, keep it verifiable for one access-token lifetime:`,
);
console.log(`# AUTH_VERIFY_KEYS=${kid}=${publicDer.toString("base64")}`);
