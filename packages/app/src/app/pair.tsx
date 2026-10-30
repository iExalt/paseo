import { Redirect } from "expo-router";

// `paseo://pair#offer=…` lands here. OfferLinkListener in _layout.tsx owns the import and
// navigates once the host connects; this route only replaces "Unmatched Route" with startup.
export default function PairRoute() {
  return <Redirect href="/" />;
}
