// The small part of Yomitan's renderer the lookup panel uses. The bundled file
// is JavaScript; types for it live here instead of touching vendor/.
declare module 'yomitan/structured-content-generator' {
  export class StructuredContentGenerator {
    constructor(contentManager: object, document: Document, window: Window);
    createStructuredContent(content: unknown, dictionary: string): Node | null;
  }
}
