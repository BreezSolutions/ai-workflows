declare module "slack-markdown" {
  interface SlackMarkdownOptions {
    slackOnly?: boolean;
    escapeHTML?: boolean;
    hrefTarget?: string;
    slackCallbacks?: Record<string, (info: { id: string; name?: string }) => string>;
    cssModuleNames?: Record<string, string>;
  }
  export function toHTML(text: string, options?: SlackMarkdownOptions): string;
}
