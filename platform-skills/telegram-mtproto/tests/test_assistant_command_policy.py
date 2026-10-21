"""The signed task surface selects existing native parser leaves only."""
import argparse
import json
import pathlib
import unittest

from test_assistant_monitor import M


class AssistantCommandPolicy(unittest.TestCase):
    def test_native_read_and_correspondence_surface_never_includes_setup_or_admin(self):
        file = pathlib.Path(M.__file__).with_name("trelio-assistant-execution.json")
        policy = json.loads(file.read_text(encoding="utf-8"))
        self.assertEqual(set(policy), {"schemaVersion", "taskCommands"})
        self.assertEqual(policy["schemaVersion"], 1)
        prefixes = policy["taskCommands"]
        self.assertEqual(len(prefixes), len({tuple(prefix) for prefix in prefixes}))
        for prefix in prefixes:
            if prefix == ["guides"]:
                continue  # Existing signed guides test covers the early no-I/O entry.
            parser = M.build_parser()
            for token in prefix:
                choices = next(action.choices for action in parser._actions
                               if isinstance(action, argparse._SubParsersAction))
                self.assertIn(token, choices)
                parser = choices[token]
            self.assertFalse(any(isinstance(action, argparse._SubParsersAction)
                                 for action in parser._actions), prefix)
        # Do not duplicate a provider implementation in the host. This review
        # is local to its real parser; the host enforces signed prefixes.
        for denied in (["login"], ["bootstrap"], ["monitor"], ["policy", "set"],
                       ["__trelio_accounts_import"], ["edit"], ["delete"],
                       ["forward"], ["scheduled-cancel"], ["invite-create"],
                       ["join-request"], ["topic-create"], ["draft-save"],
                       ["send-series"], ["archive"], ["unarchive"], ["mute"], ["unmute"]):
            self.assertFalse(any(denied[:len(prefix)] == prefix for prefix in prefixes), denied)
        self.assertIn(["read-reference"], prefixes)
        self.assertIn(["reply"], prefixes)


if __name__ == "__main__":
    unittest.main()
