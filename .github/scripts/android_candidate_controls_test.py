import unittest
import xml.etree.ElementTree as ET
from android_candidate_controls import keyboard_permission_deny, notification_permission_deny, input_ready, terminal_echo


class ControlsTest(unittest.TestCase):
    def test_terminal_echo_requires_rendered_rows_and_handles_wrapping(self):
        command = "printf PASEO_NATIVE_;echo PREVIOUS"
        root = ET.fromstring('''<hierarchy>
          <node resource-id="terminal-native-input" text="printf PASEO_NATIVE_;echo PREVIOUS" />
          <node resource-id="terminal-row-0" content-desc="runner$ printf PASEO_NATIVE_;echo" />
          <node resource-id="terminal-row-1" content-desc="PREVIOUS" />
        </hierarchy>''')
        nodes = list(root.iter("node"))
        self.assertTrue(terminal_echo(nodes, command))
        self.assertFalse(terminal_echo(nodes[:1], command))
        self.assertFalse(terminal_echo(nodes, "PASEO_NATIVE_PREVIOUS"))

    def test_only_keyboard_contacts_dialog_is_denied(self):
        # Minimal nodes from the retained Android 16 permission overlay.
        root = ET.fromstring('''<hierarchy>
          <node package="com.android.permissioncontroller"
            resource-id="com.android.permissioncontroller:id/permission_message"
            text="Allow Android Keyboard (AOSP) to access your contacts?" />
          <node package="com.android.permissioncontroller"
            resource-id="com.android.permissioncontroller:id/permission_deny_button" />
        </hierarchy>''')
        nodes = list(root.iter("node"))
        self.assertIs(keyboard_permission_deny(nodes), nodes[1])
        for message in ["Allow Paseo to access your contacts?",
                        "Allow Android Keyboard (AOSP) to record audio?"]:
            nodes[0].set("text", message)
            self.assertIsNone(keyboard_permission_deny(nodes))
        nodes[0].set("text", "Allow Paseo iExalt to send you notifications?")
        self.assertIs(notification_permission_deny(nodes), nodes[1])
        self.assertIsNone(keyboard_permission_deny(nodes))
        nodes[0].set("text", "Allow Paseo iExalt to access your contacts?")
        self.assertIsNone(notification_permission_deny(nodes))

    def test_input_requires_focus_and_visible_keyboard(self):
        field = ET.fromstring('<node resource-id="direct-host-input" focused="true" />')
        self.assertTrue(input_ready([field], "direct-host-input", "  mInputShown=true\n"))
        self.assertFalse(input_ready([field], "direct-host-input", "  mInputShown=false\n"))
        field.set("focused", "false")
        self.assertFalse(input_ready([field], "direct-host-input", "  mInputShown=true\n"))


if __name__ == "__main__":
    unittest.main()
