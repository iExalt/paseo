"""Selectors for the disposable Android keyboard's first-use dialog."""
import re


def workspace_row(nodes, workspace_id):
    if not re.fullmatch(r"wks_[A-Za-z0-9_-]+", workspace_id):
        raise ValueError("Invalid fixture workspace ID")
    found = [node for node in nodes
             if node.get("package") == "sh.paseo.iexalt"
             and node.get("resource-id", "").startswith("sidebar-workspace-row-")
             and node.get("resource-id", "").endswith(":" + workspace_id)]
    if len(found) > 1:
        raise ValueError("Ambiguous native workspace rows")
    if not found or found[0].get("enabled") != "true" or found[0].get("clickable") != "true":
        return None
    return found[0]


def permission_deny(nodes, message, buttons=("permission_deny_button",)):
    controller = "com.android.permissioncontroller"
    if not any(node.get("package") == controller
               and node.get("resource-id") == controller + ":id/permission_message"
               and node.get("text") == message for node in nodes):
        return None
    return next((node for node in nodes if node.get("package") == controller
                 and node.get("resource-id") in {controller + ":id/" + button for button in buttons}), None)


def keyboard_permission_deny(nodes):
    return permission_deny(nodes, "Allow Android Keyboard (AOSP) to access your contacts?")


def notification_permission_deny(nodes):
    return permission_deny(nodes, "Allow Paseo iExalt to send you notifications?",
                           ("permission_deny_button", "permission_deny_and_dont_ask_again_button"))


def input_ready(nodes, selector, ime):
    return bool(re.search(r"^\s*mInputShown=true\s*$", ime, re.M)) and any(
        node.get("resource-id", "").split(":id/")[-1] == selector
        and node.get("focused") == "true" for node in nodes)


def terminal_echo(nodes, command):
    # Native rows expose trimmed content descriptions; wrapping may remove a
    # trailing space. Restrict matching to terminal rows, never the input buffer.
    rows = "".join(node.get("content-desc", "") for node in nodes
                   if re.fullmatch(r"terminal-row-\d+", node.get("resource-id", "")))
    return "".join(command.split()) in "".join(rows.split())
