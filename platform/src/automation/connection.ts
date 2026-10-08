import { readFile } from "node:fs/promises";
import type { NativeConnectionOptions } from "@temporalio/worker";

/** Shared by the API client and worker; certificates stay out of histories and logs. */
export async function temporalSettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  connection: NativeConnectionOptions;
  namespace: string;
  taskQueue: string;
}> {
  if (
    env.TEMPORAL_TLS &&
    env.TEMPORAL_TLS !== "on" &&
    env.TEMPORAL_TLS !== "off"
  )
    throw new Error("TEMPORAL_TLS must be on or off");
  const enabled = env.TEMPORAL_TLS === "on";
  if (env.TEMPORAL_API_KEY && !enabled)
    throw new Error("Temporal API key requires TLS");
  const cert = env.TEMPORAL_TLS_CERT_PATH,
    key = env.TEMPORAL_TLS_KEY_PATH;
  if (
    !enabled &&
    (cert || key || env.TEMPORAL_TLS_CA_PATH || env.TEMPORAL_TLS_SERVER_NAME)
  )
    throw new Error("TLS certificate settings require TEMPORAL_TLS=on");
  if (enabled && !!cert !== !!key)
    throw new Error(
      "Temporal TLS client identity requires both certificate and key",
    );
  const tls = enabled
    ? {
        ...(env.TEMPORAL_TLS_CA_PATH
          ? {
              serverRootCACertificate: await readFile(env.TEMPORAL_TLS_CA_PATH),
            }
          : {}),
        ...(env.TEMPORAL_TLS_SERVER_NAME
          ? { serverNameOverride: env.TEMPORAL_TLS_SERVER_NAME }
          : {}),
        ...(cert && key
          ? {
              clientCertPair: {
                crt: await readFile(cert),
                key: await readFile(key),
              },
            }
          : {}),
      }
    : undefined;
  return {
    connection: {
      address: env.TEMPORAL_ADDRESS || "127.0.0.1:7233",
      ...(tls ? { tls } : {}),
      ...(env.TEMPORAL_API_KEY ? { apiKey: env.TEMPORAL_API_KEY } : {}),
    },
    namespace: env.TEMPORAL_NAMESPACE || "default",
    taskQueue: env.TEMPORAL_TASK_QUEUE || "truex-automations",
  };
}
