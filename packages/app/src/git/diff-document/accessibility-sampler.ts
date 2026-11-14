/** Publish a leading sample and the latest scroll position after scrolling settles. */
export function createAccessibilitySampler(read: () => number, publish: (top: number) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    sample(top: number) {
      publish(top);
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        publish(read());
      }, 200);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
