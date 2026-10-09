import { useCallback, useEffect, useState } from "react";
import { getDesktopHost, type DesktopNixUpdateResult } from "@/desktop/host";

export type NixUpdateAction = "check" | "status" | "stage" | "activate" | "rollback";

export interface NixDesktopUpdaterState {
  result: DesktopNixUpdateResult | null;
  error: string | null;
  busy: NixUpdateAction | null;
  run(action: NixUpdateAction): Promise<void>;
}

export function useNixDesktopUpdater(): NixDesktopUpdaterState {
  const [result, setResult] = useState<DesktopNixUpdateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<NixUpdateAction | null>(null);

  const run = useCallback(async (action: NixUpdateAction) => {
    const method = getDesktopHost()?.nixUpdates?.[action];
    if (!method) {
      setError("The managed Nix update bridge is unavailable.");
      return;
    }
    setBusy(action);
    setError(null);
    try {
      setResult(await method());
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void run("status");
  }, [run]);

  return { result, error, busy, run };
}
