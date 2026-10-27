import { Injectable } from "@nestjs/common";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { ClientSecretRef } from "./connector";

// How long a resolved secret is cached, so repeated connects do not call
// Secrets Manager every time (matches model-gateway's 5 minutes).
const SECRET_TTL_MS = 5 * 60_000;

// The client secret could not be resolved: the ARN is missing from Secrets
// Manager, access was denied, or the named env var is unset. The reason is a
// fixed string; the secret value is never in it.
export class ClientSecretUnavailableError extends Error {
  constructor() {
    super("The connector client secret could not be resolved.");
    this.name = "ClientSecretUnavailableError";
  }
}

// Resolves a connector's OAuth client secret from its catalog reference: a
// Secrets Manager ARN in production, or a process.env name for local
// development. The Secrets Manager client is constructed lazily (only when an
// arn is actually needed) and cached, so a gateway with only env-based
// connectors never loads the SDK region/credential chain.
@Injectable()
export class ClientSecretResolver {
  private client?: SecretsManagerClient;
  private readonly cache = new Map<
    string,
    { value: string; expires: number }
  >();

  // A field, not a constructor parameter: Nest would try to inject a
  // parameter, and the compiled build's metadata names it `Function`.
  private readonly now: () => number = Date.now;

  async resolve(ref: ClientSecretRef): Promise<string> {
    if ("env" in ref) {
      const value = process.env[ref.env];
      if (typeof value !== "string" || value.length === 0)
        throw new ClientSecretUnavailableError();
      return value;
    }
    return this.fromSecretsManager(ref.arn);
  }

  private async fromSecretsManager(arn: string): Promise<string> {
    const hit = this.cache.get(arn);
    if (hit && hit.expires > this.now()) return hit.value;
    const value = await this.fetchSecret(arn);
    this.cache.set(arn, { value, expires: this.now() + SECRET_TTL_MS });
    return value;
  }

  private async fetchSecret(arn: string): Promise<string> {
    const client = await this.secretsClient();
    try {
      const { GetSecretValueCommand } =
        await import("@aws-sdk/client-secrets-manager");
      const result = await client.send(
        new GetSecretValueCommand({ SecretId: arn }),
      );
      const value = result.SecretString;
      if (typeof value !== "string" || value.length === 0)
        throw new ClientSecretUnavailableError();
      return value;
    } catch (error) {
      if (error instanceof ClientSecretUnavailableError) throw error;
      // Never surface the AWS error: it can name the secret or the account.
      throw new ClientSecretUnavailableError();
    }
  }

  private async secretsClient(): Promise<SecretsManagerClient> {
    if (!this.client) {
      const { SecretsManagerClient } =
        await import("@aws-sdk/client-secrets-manager");
      this.client = new SecretsManagerClient({});
    }
    return this.client;
  }
}
