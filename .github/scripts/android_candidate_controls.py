"""Selectors for the disposable Android keyboard's first-use dialog."""
import re


def keyboard_permission_deny(nodes):
    controller = "com.android.permissioncontroller"
    message = "Allow Android Keyboard (AOSP) to access your contacts?"
    if not any(node.get("package") == controller
               and node.get("resource-id") == controller + ":id/permission_message"
               and node.get("text") == message for node in nodes):
        return None
    return next((node for node in nodes if node.get("package") == controller
                 and node.get("resource-id") == controller + ":id/permission_deny_button"), None)


def input_ready(nodes, selector, ime):
    return bool(re.search(r"^\s*mInputShown=true\s*$", ime, re.M)) and any(
        node.get("resource-id", "").split(":id/")[-1] == selector
        and node.get("focused") == "true" for node in nodes)
