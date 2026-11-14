import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useChatFindMessageSelected } from "./highlight-store";

/** Frames a stream row while chat find has selected its message. */
export function ChatFindRowFrame({
  messageId,
  children,
}: {
  messageId: string;
  children: ReactNode;
}) {
  const selected = useChatFindMessageSelected(messageId);
  return <View style={selected ? styles.selected : undefined}>{children}</View>;
}

const styles = StyleSheet.create((theme) => ({
  // Background only, so selecting a message never shifts its layout.
  selected: { backgroundColor: theme.colors.surface2 },
}));
