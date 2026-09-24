import { ConfigurableModuleBuilder } from '@nestjs/common';
import type { WebhooksModuleOptions } from './interfaces/webhooks-module-options.interface.js';
import type { WebhooksModuleStructure } from './interfaces/webhooks-module-options.interface.js';

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN: WEBHOOKS_MODULE_OPTIONS,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<WebhooksModuleOptions>({ moduleName: 'Webhooks' })
  .setClassMethodName('forRoot')
  .setFactoryMethodName('createWebhooksOptions')
  // `outgoing` and `transport` are extras so they stay out of the options value; WebhooksModule
  // adds the providers they decide in its forRoot()/forRootAsync().
  .setExtras<WebhooksModuleStructure>(
    { isGlobal: true, outgoing: true, transport: undefined, imports: undefined },
    (definition, { isGlobal, imports }) => ({
      ...definition,
      global: isGlobal,
      imports: [...(definition.imports ?? []), ...(imports ?? [])],
    }),
  )
  .build();
