/** Live catalog readiness only: no provider calls, business actions or database writes. */
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AdaptiveMcpGatewayV2 } from "../../agent-core/src/adaptive-mcp-gateway-v2";
import { Redactor } from "../../agent-core/src/redact";

dotenv.config({ path: "platform/.env", quiet: true });
dotenv.config({ path: "agent-core/.env", quiet: true });
const { values } = parseArgs({
  options: {
    out: {
      type: "string",
      default: "docs/adaptive-correctness-fix/catalog-readiness.json",
    },
  },
});
const output = resolve(values.out!);
const mongo = new MongoClient(
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017",
);
const redactor = new Redactor();
const artifact: any = {
  evidenceKind: "live-catalog-only",
  createdAt: new Date().toISOString(),
  modelCalls: 0,
  businessCalls: 0,
  events: [],
};
let gateway: AdaptiveMcpGatewayV2 | undefined;
async function main() {
  try {
    await mongo.connect();
    const id = "6aaa7db671c8cc9e29e08d93";
    const profile = await mongo
      .db(process.env.MONGO_DB || "truex")
      .collection<any>("truex_mcp")
      .findOne({ _id: { $in: [id, new ObjectId(id)] } });
    if (!profile) throw new Error("Qlik profile unavailable");
    redactor.remember(profile);
    if (profile.auth?.kind !== "header" || !profile.auth.headerName)
      throw new Error("Expected configured header authentication");
    const config = {
      url: profile.url,
      enabled: profile.enabled !== false,
      http_headers: { [profile.auth.headerName]: profile.apiKey },
      startup_timeout_sec:
        Number(profile.capabilities?.connectTimeoutMs || 30000) / 1000,
      tool_timeout_sec:
        Number(profile.capabilities?.requestTimeoutMs || 120000) / 1000,
    };
    artifact.timeouts = {
      startupMs: config.startup_timeout_sec * 1000,
      toolMs: config.tool_timeout_sec * 1000,
    };
    gateway = new AdaptiveMcpGatewayV2(
      { qlik: config },
      (event) => artifact.events.push(redactor.clean(event)),
      fetch,
      { scope: { tenantId: "default", userId: "catalog-readiness" } },
    );
    const tools = await gateway.initializeRegistry();
    artifact.registryStatus = gateway.registryStatus;
    artifact.tools = tools;
    artifact.ready =
      gateway.registryStatus.state === "ready" && tools.length > 0;
    if (!artifact.ready) process.exitCode = 2;
  } catch (error) {
    artifact.ready = false;
    artifact.error = redactor.clean(String(error));
    process.exitCode = 1;
  } finally {
    artifact.completedAt = new Date().toISOString();
    await gateway?.close();
    await mongo.close();
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      JSON.stringify(redactor.clean(artifact), null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        ready: artifact.ready,
        state: artifact.registryStatus?.state,
        tools: artifact.tools?.length || 0,
        output,
      }),
    );
  }
}
void main();
