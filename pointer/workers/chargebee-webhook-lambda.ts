import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import { createSqsBatchHandler } from "./sqs-lambda-handler";
import type { ChargebeeWebhookMessageProcessor } from "./chargebee-webhook-processor";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function requireSecretField(
  secret: Record<string, unknown>,
  field: string,
): string {
  const value = secret[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Secrets Manager value is missing required field ${field}`);
  }
  return value;
}

const secrets = new SecretsManagerClient();

async function getJsonSecret(secretId: string): Promise<Record<string, unknown>> {
  const response = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const value =
    response.SecretString ??
    (response.SecretBinary
      ? new TextDecoder().decode(response.SecretBinary)
      : undefined);
  if (!value) {
    throw new Error(`Secrets Manager value ${secretId} is empty`);
  }

  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Secrets Manager value ${secretId} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function loadWorkerSecrets(): Promise<void> {
  const [database, app] = await Promise.all([
    getJsonSecret(requireEnv("DATABASE_SECRET_ARN")),
    getJsonSecret(requireEnv("APP_SECRET_ARN")),
  ]);

  process.env.DATABASE_URL = requireSecretField(database, "database_url");
  process.env.BETTER_AUTH_SECRET = requireSecretField(
    app,
    "better_auth_secret",
  );
  process.env.CHARGEBEE_SITE = requireSecretField(app, "chargebee_site");
  process.env.CHARGEBEE_API_KEY = requireSecretField(
    app,
    "chargebee_api_key",
  );
  process.env.CHARGEBEE_WEBHOOK_USERNAME = requireSecretField(
    app,
    "chargebee_webhook_username",
  );
  process.env.CHARGEBEE_WEBHOOK_PASSWORD = requireSecretField(
    app,
    "chargebee_webhook_password",
  );

  if (typeof app.admin_user_ids === "string") {
    process.env.ADMIN_USER_IDS = app.admin_user_ids;
  }
}

let processorPromise: Promise<ChargebeeWebhookMessageProcessor> | undefined;

function getProcessor(): Promise<ChargebeeWebhookMessageProcessor> {
  if (!processorPromise) {
    processorPromise = loadWorkerSecrets()
      // The processor imports the Better Auth configuration, which reads
      // secrets at module evaluation time. Keep this import after bootstrap.
      .then(() => import("./chargebee-webhook-processor"))
      .then(({ createChargebeeWebhookMessageProcessor }) =>
        createChargebeeWebhookMessageProcessor({
          queueUrl: requireEnv("CHARGEBEE_WEBHOOK_SQS_QUEUE_URL"),
          dlqUrl: requireEnv("CHARGEBEE_WEBHOOK_DLQ_URL"),
        }),
      )
      .catch((err) => {
        // Allow a warm execution environment to recover from a transient
        // Secrets Manager/bootstrap failure on a later invocation.
        processorPromise = undefined;
        throw err;
      });
  }
  return processorPromise;
}

export const handler = createSqsBatchHandler(getProcessor);
