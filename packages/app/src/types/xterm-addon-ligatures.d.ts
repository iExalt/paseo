declare module "@xterm/addon-ligatures/lib/addon-ligatures.js" {
  export class LigaturesAddon {
    constructor();
    activate(terminal: unknown): void;
    dispose(): void;
  }
}
