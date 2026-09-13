declare module "*/whatsapp-web/lib/messages.mjs" {
  export function whatsappDescriptor(account?: string, connected?: boolean): any;
  export function whatsappToProviderText(text: string): string;
  export function whatsappFromProviderText(text: unknown): { text: string; markdown: string };
  export function normalizeWhatsAppMessage(raw: any, options?: any): any;
  export class WhatsAppMessagesStore {
    constructor(root: string, options?: { now?: () => number });
    append(raw: any, normalized: any): boolean;
    fetch(account: string, cursor?: any): any;
    expose(entry: any): any;
    get(externalId: string): any;
    raw(externalId: string): any;
  }
  export function createWhatsAppMessagesAdapter(options: any): Record<string, (input: any) => any>;
}
