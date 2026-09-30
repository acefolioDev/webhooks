#!/usr/bin/env node
// The `nest-webhooks` command: PostgresWebhookStore's migrations from a shell or a CI step.
import { runStoreCli } from '@nestjs/store-kit';
import { webhookStoreSchema } from './migrations/index.js';

process.exitCode = await runStoreCli([webhookStoreSchema], process.argv.slice(2));
