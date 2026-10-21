"""Provider-owned classification is checked against the real argparse tree.

No credentials/network/native helper is needed: classification must precede
those operations in the shared signed host, not be inferred from CLI prose.
"""
import argparse
import json
import unittest
from pathlib import Path

from test_trelio_email import MODULE as M


class AssistantCommandPolicy(unittest.TestCase):
    def test_reviewed_prefixes_select_real_leaf_operations(self):
        policy = json.loads((Path(M.__file__).parent / "trelio-assistant-execution.json").read_text(encoding="utf-8"))
        self.assertEqual(set(policy), {"schemaVersion", "taskCommands"})
        self.assertEqual(policy["schemaVersion"], 1)
        prefixes = policy["taskCommands"]
        self.assertEqual(len(prefixes), len({tuple(p) for p in prefixes}))
        for prefix in prefixes:
            if prefix == ["guides"]:
                # The existing no-I/O `guides` entry returns before argparse;
                # its actual packaged subprocess is covered by guides tests.
                continue
            parser = M.build_parser()
            for token in prefix:
                choices = next(action.choices for action in parser._actions
                               if isinstance(action, argparse._SubParsersAction))
                self.assertIn(token, choices)
                parser = choices[token]
            # A broad parent would also open unreviewed child writes. Every
            # declared prefix must reach a leaf, never e.g. bare `policy`.
            self.assertFalse(any(isinstance(action, argparse._SubParsersAction)
                                 for action in parser._actions), prefix)
        for denied in (["configure"], ["policy", "set"], ["signature", "set"],
                       ["signature", "clear"], ["description", "set"],
                       ["monitor"], ["ack-reference"], ["__trelio_accounts_import"]):
            self.assertFalse(any(denied[:len(p)] == p for p in prefixes), denied)
        self.assertIn(["read-reference"], prefixes)
        self.assertIn(["reply"], prefixes)


if __name__ == "__main__":
    unittest.main()
