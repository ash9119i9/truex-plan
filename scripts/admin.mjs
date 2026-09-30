// Admin dashboard CLI.
//
//   npm run admin -- hash-password
//
// hash-password reads the password from stdin (never argv, so it stays out
// of shell history) and prints the ADMIN_PASSWORD_HASH value:
// scrypt$N$r$p$<saltB64>$<hashB64>, checked by platform/src/admin.ts.
import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";

const N = 16384;
const r = 8;
const p = 1;
const KEY_LENGTH = 64;

const usage = `usage: node scripts/admin.mjs <command>
  hash-password   read a password from stdin and print ADMIN_PASSWORD_HASH`;

class CliError extends Error {}

async function readStdin() {
  if (process.stdin.isTTY) {
    process.stderr.write("Password (input is visible; pipe it to hide): ");
    // One line from the terminal.
    return await new Promise((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      const onData = (chunk) => {
        data += chunk;
        const i = data.indexOf("\n");
        if (i >= 0) {
          process.stdin.off("data", onData);
          process.stdin.pause();
          resolve(data.slice(0, i));
        }
      };
      process.stdin.on("data", onData);
    });
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await promisify(scrypt)(password, salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: 256 * N * r + (1 << 20),
  });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function main(argv) {
  const [command] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(usage);
    return;
  }
  if (command !== "hash-password")
    throw new CliError(`unknown command "${command}"\n${usage}`);
  if (argv.length > 1)
    throw new CliError(
      "hash-password takes no arguments; pipe the password on stdin",
    );
  // Only the trailing newline is dropped; other whitespace is part of it.
  const password = (await readStdin()).replace(/\r?\n$/, "");
  if (password.length < 12)
    throw new CliError("password must be at least 12 characters");
  console.log(await hashPassword(password));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof CliError ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
