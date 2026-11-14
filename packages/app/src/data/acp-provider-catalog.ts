import { ACP_PROVIDER_CATALOG_DATA } from "@getpaseo/protocol/acp-provider-catalog";
import { ACP_PROVIDER_ICON_SVGS } from "@/assets/acp-provider-icons";

export interface AcpProviderCatalogEntry {
  id: string;
  title: string;
  description: string;
  version: string;
  iconSvg: string | null;
  installLink: string;
  command: readonly [string, ...string[]];
  bundledProvider?: boolean;
  env?: Readonly<Record<string, string>>;
  params?: Readonly<Record<string, unknown>>;
}

export const ACP_PROVIDER_CATALOG: AcpProviderCatalogEntry[] = ACP_PROVIDER_CATALOG_DATA.map(
  (entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    version: entry.version,
    installLink: entry.installLink,
    command: entry.command,
    bundledProvider: "bundledProvider" in entry ? entry.bundledProvider : undefined,
    env: "env" in entry ? entry.env : undefined,
    params: "params" in entry ? entry.params : undefined,
    iconSvg: entry.iconId ? (ACP_PROVIDER_ICON_SVGS[entry.iconId] ?? null) : null,
  }),
);
