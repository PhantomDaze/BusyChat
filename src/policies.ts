import type { NormalizedMessageEvent, RuntimeState } from './types';

export class AdminPolicy {
  constructor(private runtime: RuntimeState) {}

  updateRuntime(runtime: RuntimeState): void {
    this.runtime = runtime;
  }

  isAdmin(userId: string): boolean {
    return this.runtime.admins.includes(userId);
  }

  isBot(event: NormalizedMessageEvent): boolean {
    return event.visibility.fromBot;
  }

  shouldIncludeInReport(event: NormalizedMessageEvent): boolean {
    return event.visibility.includeInReports;
  }

  shouldGenerateAdvice(event: NormalizedMessageEvent): boolean {
    return event.visibility.eligibleForAdvice && event.scope === 'private';
  }

  shouldAllowPluginObservation(event: NormalizedMessageEvent, permission: 'message:observe' | 'admin:observe'): boolean {
    if (permission === 'admin:observe') {
      return event.visibility.fromAdmin;
    }
    return event.visibility.includeInReports;
  }

  reportRecipients(): string[] {
    return [...this.runtime.admins];
  }
}
