/**
 * Controls only the listed notification ids in an isolated Electron test.
 * Native mode observes the original show() call; scripted mode emits the requested event.
 */
export async function installNotificationReceipts(desktop, cases) {
  await desktop.evaluate(({ Notification }, items) => {
    const originalShow = Notification.prototype.show;
    const originalSupported = Notification.isSupported;
    const pending = new Map(items.map((item) => [item.id, item.mode]));
    const receipts = [];
    globalThis.notificationReceiptTest = { originalShow, originalSupported, pending, receipts };
    if (!items.some((item) => item.mode === "native")) Notification.isSupported = () => true;
    Notification.prototype.show = function () {
      const mode = pending.get(this.id);
      if (!mode) {
        if (this.id?.startsWith("paseo-qa-receipt:"))
          throw new Error(`Unexpected notification: ${this.id}`);
        return originalShow.call(this);
      }
      pending.delete(this.id);
      const receipt = {
        id: this.id,
        title: this.title,
        mode: mode === "native" ? "native" : "scripted",
        outcome: "pending",
      };
      receipts.push(receipt);
      this.once("show", () => {
        receipt.outcome = "show";
      });
      this.once("failed", (_event, error) => {
        receipt.outcome = "failed";
        receipt.error = error;
      });
      if (mode === "scripted-show") this.emit("show");
      else if (mode === "scripted-failed") this.emit("failed", {}, "injected failure");
      else if (mode === "native") return originalShow.call(this);
      else if (mode !== "scripted-timeout") throw new Error(`Unknown notification mode: ${mode}`);
    };
  }, cases);
}

export async function notificationReceipt(desktop, id) {
  return desktop.evaluate((_, wantedId) => {
    const receipt = globalThis.notificationReceiptTest.receipts.find(
      (item) => item.id === wantedId,
    );
    if (!receipt) throw new Error(`No notification receipt for ${wantedId}`);
    if (receipt.outcome === "pending") receipt.outcome = "timeout";
    return receipt;
  }, id);
}

export async function restoreNotificationReceipts(desktop) {
  return desktop.evaluate(({ Notification }) => {
    const test = globalThis.notificationReceiptTest;
    Notification.prototype.show = test.originalShow;
    Notification.isSupported = test.originalSupported;
    delete globalThis.notificationReceiptTest;
    if (test.pending.size) throw new Error(`Unused notification cases: ${test.pending.size}`);
  });
}
