declare module "planer" {
  const planer: {
    extractFrom(msgBody: string, contentType: "text/plain" | "text/html", dom?: Document | null): string;
    extractFromPlain(msgBody: string): string;
    extractFromHtml(msgBody: string, dom: Document): string;
  };
  export default planer;
}
