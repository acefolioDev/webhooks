/**
 * The `nest-webhooks` command as lib/cli.ts runs it (the kit's runStoreCli() on both stores' schemas, PostgreSQL's
 * first), with its output captured: what the CLI specs of both stores call.
 */
import { runStoreCli, type StoreCliIo } from '@nestjs/store-kit';
import { mysqlWebhookStoreSchema } from '../../lib/mysql/migrations/index.js';
import { webhookStoreSchema } from '../../lib/postgres/migrations/index.js';

export async function runCli(argv: string[], env: StoreCliIo['env'] = {}): Promise<{ code: number; out: string; err: string }> {
  const output = { out: '', err: '' };
  const code = await runStoreCli([webhookStoreSchema, mysqlWebhookStoreSchema], argv, {
    out: (text) => (output.out += text),
    err: (text) => (output.err += text),
    env,
  });
  return { code, ...output };
}
