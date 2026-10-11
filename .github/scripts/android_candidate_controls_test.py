import unittest
import xml.etree.ElementTree as ET
from android_candidate_controls import keyboard_permission_deny, input_ready


class ControlsTest(unittest.TestCase):
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

    def test_input_requires_focus_and_visible_keyboard(self):
        field = ET.fromstring('<node resource-id="direct-host-input" focused="true" />')
        self.assertTrue(input_ready([field], "direct-host-input", "  mInputShown=true\n"))
        self.assertFalse(input_ready([field], "direct-host-input", "  mInputShown=false\n"))
        field.set("focused", "false")
        self.assertFalse(input_ready([field], "direct-host-input", "  mInputShown=true\n"))


if __name__ == "__main__":
    unittest.main()
