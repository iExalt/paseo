// Native browser panes reload when site data is cleared, matching the desktop
// profile clear, which reloads every guest. Desktop never notifies here.
const listeners = new Set<() => void>();

export function subscribeBrowserDataCleared(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyBrowserDataCleared(): void {
  for (const listener of listeners) {
    listener();
  }
}
