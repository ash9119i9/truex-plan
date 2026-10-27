// Chat file storage: the S3 bucket that keeps every version of the files a
// chat's runs produce. Optional: without it runs work as before and their
// files stay in the runtime only. Credentials come from the AWS SDK's default
// chain (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE or an instance
// role), never from this config.

import type { FileStore } from "../modules/chats/chat-files";

export interface FilesConfig {
  readonly bucket: string;
  readonly region: string;
  // Prepended to every object key, e.g. "truex-next/". Empty for none.
  readonly prefix: string;
  // CHAT_UPLOADS_ENABLED=1: members can attach files to messages. Only with a
  // runtime that has coding on (RUNTIME_CODING_ENABLED=1), which the model
  // needs to open them; the adapter refuses uploads otherwise.
  readonly uploads?: boolean;
  // Not read from the environment: tests store files in memory instead.
  readonly store?: FileStore;
}

type Env = Readonly<Record<string, string | undefined>>;

// S3's bucket naming rules (no dots: virtual-hosted TLS breaks on them).
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const PREFIX = /^([A-Za-z0-9_-]+\/){0,4}$/;

export function loadFilesConfig(
  env: Env,
  problems: string[],
): FilesConfig | undefined {
  const bucket = env.CHAT_FILES_S3_BUCKET ?? "";
  const uploads = env.CHAT_UPLOADS_ENABLED === "1";
  if (
    env.CHAT_UPLOADS_ENABLED &&
    !["0", "1"].includes(env.CHAT_UPLOADS_ENABLED)
  )
    problems.push("CHAT_UPLOADS_ENABLED must be 0 or 1.");
  if (!bucket) {
    if (uploads)
      problems.push(
        "CHAT_UPLOADS_ENABLED=1 needs CHAT_FILES_S3_BUCKET: attached files are kept there.",
      );
    return undefined;
  }
  const region = env.CHAT_FILES_S3_REGION || env.AWS_REGION || "";
  const prefix = env.CHAT_FILES_S3_PREFIX ?? "";
  const before = problems.length;
  if (!BUCKET.test(bucket))
    problems.push(
      "CHAT_FILES_S3_BUCKET must be an S3 bucket name without dots.",
    );
  if (!REGION.test(region))
    problems.push(
      "CHAT_FILES_S3_REGION (or AWS_REGION) must be an AWS region such as us-east-1.",
    );
  if (!PREFIX.test(prefix))
    problems.push(
      'CHAT_FILES_S3_PREFIX must be empty or up to four "segment/" parts.',
    );
  if (problems.length > before) return undefined;
  return { bucket, region, prefix, ...(uploads ? { uploads } : {}) };
}
