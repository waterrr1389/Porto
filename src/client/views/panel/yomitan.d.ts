// The small part of Yomitan's renderer the lookup panel uses. The bundled file
// is JavaScript; types for it live here instead of touching vendor/.
declare module 'yomitan/anki-template-renderer-content-manager' {
  /** The renderer loads images only through this class (it checks with instanceof). */
  export class AnkiTemplateRendererContentManager {
    constructor(
      mediaProvider: { getMedia(data: unknown, path: [string, string], options: { dictionary: string }): string | null },
      data: object,
    );
  }
}

declare module 'yomitan/structured-content-generator' {
  export class StructuredContentGenerator {
    constructor(contentManager: object, document: Document, window: Window);
    createStructuredContent(content: unknown, dictionary: string): Node | null;
  }
}
