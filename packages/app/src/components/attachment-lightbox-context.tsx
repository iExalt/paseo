import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { AttachmentLightbox, type ImageLightboxSource } from "./attachment-lightbox";

type OpenLightbox = (source: ImageLightboxSource) => void;
const LightboxContext = createContext<OpenLightbox | null>(null);

/** The host outlives compact and wide workspace panels. */
export function WorkspaceLightboxProvider({
  children,
  active,
}: {
  children: ReactNode;
  active: boolean;
}) {
  const [source, setSource] = useState<ImageLightboxSource | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const close = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
    setSource(null);
  }, []);
  const open = useCallback((next: ImageLightboxSource) => {
    const release =
      next.type === "attachment" ? retainAttachmentForGarbageCollection(next.metadata.id) : null;
    releaseRef.current?.();
    releaseRef.current = release;
    setSource(next);
  }, []);
  useEffect(() => {
    if (!active) close();
  }, [active, close]);
  useEffect(() => () => releaseRef.current?.(), []);
  return (
    <LightboxContext.Provider value={open}>
      {children}
      <AttachmentLightbox source={source} onClose={close} />
    </LightboxContext.Provider>
  );
}

/** Standalone consumers keep a local host when no workspace provides one. */
export function useAttachmentLightbox() {
  const workspaceOpen = useContext(LightboxContext);
  const [source, setSource] = useState<ImageLightboxSource | null>(null);
  const close = useCallback(() => setSource(null), []);
  const open = workspaceOpen ?? setSource;
  return {
    open,
    localLightbox: workspaceOpen ? null : <AttachmentLightbox source={source} onClose={close} />,
  };
}
