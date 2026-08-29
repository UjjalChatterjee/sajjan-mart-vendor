/**
 * TypeScript declaration for console.tron (Reactotron).
 *
 * Only available in __DEV__ after ReactotronConfig.ts is imported.
 * Uses `any` intentionally to avoid deep generic type conflicts
 * between reactotron-core-client and reactotron-react-native.
 */

declare global {
  interface Console {
    /** Reactotron instance — only available in __DEV__ after ReactotronConfig import. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tron?: {
      log(options: { message: string; [key: string]: any }): void;
      warn(options: { message: string; [key: string]: any }): void;
      error(options: { message: string; [key: string]: any }): void;
      display(options: {
        name: string;
        value: any;
        preview?: string;
      }): void;
    };
  }
}

export {};
