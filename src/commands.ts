import { createPluginConfigStore } from './plugin-config';
import type {
  AppServices,
  CommandContext,
  CommandDefinition,
  CommandDispatchResult,
  JsonObject,
  NormalizedMessageEvent,
  OutgoingMessage,
} from './types';

interface CommandBusDependencies {
  bot: AppServices['bot'];
  models: AppServices['models'];
  storage: AppServices['storage'];
  runtime: AppServices['runtime'];
  appLogger: AppServices['appLogger'];
}

function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (const char of input.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if ((char === '"' || char === "'") && current === '') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export class CommandBus {
  private readonly commands = new Map<string, CommandDefinition>();
  private readonly owners = new Map<string, string>();

  constructor(private readonly services: CommandBusDependencies) {}

  register(definition: CommandDefinition): void {
    if (!definition.description || !definition.description.trim()) {
      throw new Error(`command /${definition.name} must have a non-empty description`);
    }
    const currentOwner = this.owners.get(definition.name);
    if (this.commands.has(definition.name) && currentOwner !== definition.owner) {
      throw new Error(`command ${definition.name} already exists`);
    }
    this.commands.set(definition.name, definition);
    this.owners.set(definition.name, definition.owner ?? 'builtin');
  }

  unregisterOwner(owner: string): void {
    for (const [name, currentOwner] of this.owners.entries()) {
      if (currentOwner === owner) {
        this.owners.delete(name);
        this.commands.delete(name);
      }
    }
  }

  list(): CommandDefinition[] {
    return [...this.commands.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async dispatch(event: NormalizedMessageEvent): Promise<CommandDispatchResult> {
    const text = event.content.text.trim();
    if (!text.startsWith('/')) {
      return { handled: false, reply: undefined };
    }

    const tokens = tokenizeCommand(text.slice(1));
    if (tokens.length === 0) {
      return { handled: false, reply: undefined };
    }

    const commandName = tokens[0]?.toLowerCase();
    if (!commandName) {
      return { handled: false, reply: undefined };
    }
    const args = tokens.slice(1);
    const definition = this.commands.get(commandName);

    if (!definition) {
      return { handled: false, command: commandName, args, reply: undefined };
    }

    if (definition.adminOnly && !event.visibility.fromAdmin) {
      return {
        handled: true,
        command: commandName,
        args,
        reply: undefined,
      };
    }

    const logger = this.services.appLogger.child(`command:${definition.name}`);
    const reply = async (message: OutgoingMessage): Promise<void> => {
      await this.services.bot.send(
        {
          type: event.scope,
          id: event.scope === 'group' ? event.conversationId.replace(/^group:/, '') : event.sender.userId,
        },
        message,
      );
    };

    // config 指向注册该命令的插件的 storage 命名空间（config 键），
    // 这样命令可以直接读写所属插件的配置。
    const owner = definition.owner ?? 'builtin';
    const config = createPluginConfigStore<JsonObject>(
      this.services.storage.namespace(owner),
      {},
    );

    const context: CommandContext = {
      event,
      args,
      bot: this.services.bot,
      models: this.services.models,
      storage: this.services.storage.namespace(`command-${definition.name}`),
      config,
      runtime: this.services.runtime,
      logger,
      reply,
    };

    const result = await definition.execute(context);
    const replyText = typeof result === 'string' ? result : undefined;

    if (replyText) {
      await reply(replyText);
    }

    return {
      handled: true,
      command: commandName,
      args,
      reply: replyText,
    };
  }
}
