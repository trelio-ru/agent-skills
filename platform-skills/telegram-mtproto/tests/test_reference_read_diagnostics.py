"""Source read diagnostics across real parser/dispatcher/output boundaries.

Only provider I/O is synthetic. The native exact resolver, revision checks,
projection, cleanup and CLI pipes remain real; no account/session is loaded.
"""
import json
import os
import pathlib
import subprocess
import sys
import unittest
from unittest import mock

import test_assistant_monitor as base

M = base.M


class ReferenceDiagnostics(unittest.TestCase):
    def setUp(self):
        self.fixture = base.ReferenceRead()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def refusal(self, stage, category="unclassified", args=None):
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.fixture.read(args)
        payload = caught.exception.public_payload()
        self.assertEqual(payload["code"], "TELEGRAM_REFERENCE_UNAVAILABLE")
        self.assertEqual(payload["details"]["diagnostic"]["stage"], stage)
        self.assertEqual(payload["details"]["diagnostic"]["category"], category)
        self.assertFalse(payload["details"]["diagnostic"]["automaticRetry"])
        self.assertNotIn("PRIVATE_CANARY", json.dumps(payload))
        self.assertNotIn("message", payload)
        self.fixture.provider.send_message.assert_not_awaited()
        self.assertEqual(self.fixture.provider.calls, [])
        return caught.exception

    def test_unauthorized_session_and_binding_failure_are_distinct_before_lookup(self):
        self.fixture.provider.authorized = False
        self.refusal("authorization", "authorization_required")
        self.fixture.provider.get_messages.assert_not_awaited()
        self.fixture.provider.authorized = True
        with mock.patch.object(self.fixture.provider, "get_me", side_effect=TimeoutError("PRIVATE_CANARY")):
            self.refusal("conversation_binding", "timeout")
        self.fixture.provider.get_messages.assert_not_awaited()

    def test_peer_resolution_and_native_lookup_have_different_stages(self):
        self.fixture.resolve.side_effect = ValueError("PRIVATE_CANARY")
        self.refusal("peer_resolution")
        self.fixture.provider.get_messages.assert_not_awaited()
        self.fixture.resolve.side_effect = None
        self.fixture.provider.get_messages.side_effect = TimeoutError("PRIVATE_CANARY")
        error = self.refusal("message_lookup", "timeout")
        self.assertIsNot(error.__cause__, error)
        self.fixture.provider.get_messages.assert_awaited_once()

    def test_empty_lookup_does_not_claim_deletion_or_reference_mismatch(self):
        args = self.fixture.args()
        for value in (None, base.tl("MessageEmpty", id=1)):
            self.fixture.native = value
            error = self.refusal("message_lookup", "unknown", args)
            self.assertEqual(error.details["diagnostic"]["nextStep"], "verify_original_link_and_chat_access")

    def test_actual_wrong_id_or_peer_is_a_reference_validation_failure(self):
        args = self.fixture.args()
        for value in (base.message(2), base.message(peer=base.tl("PeerUser", user_id=88))):
            self.fixture.native = value
            error = self.refusal("reference_validation", "reference_mismatch", args)
            self.assertEqual(error.details["diagnostic"]["nextStep"], "verify_native_message_mapping")

    def test_projection_cannot_export_a_coded_error_with_private_details(self):
        # A matching public code alone is insufficient to reuse an arbitrary
        # diagnostic. Only the reader's private exception marker is preserved.
        failure = M.TelegramRuntimeError("PRIVATE_CANARY", code="TELEGRAM_REFERENCE_UNAVAILABLE",
            details={"diagnostic": {"stage": "PRIVATE_CANARY", "body": "PRIVATE_CANARY"}})
        with mock.patch.object(M, "public_message", side_effect=failure):
            self.refusal("message_projection")

    def test_semantic_validation_remains_separate_from_observed_revision_change(self):
        args = self.fixture.args()
        self.fixture.native.date = None
        self.refusal("semantic_revision", args=args)
        self.fixture.native.date = base.NOW
        self.fixture.native.message = "PRIVATE_CANARY"
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.fixture.read(args)
        self.assertEqual(caught.exception.code, "TELEGRAM_REFERENCE_CHANGED")
        self.assertNotIn("PRIVATE_CANARY", json.dumps(caught.exception.public_payload()))

    def test_cleanup_failure_has_no_success_and_cannot_mask_original_refusal(self):
        self.fixture.provider.disconnect.side_effect = TimeoutError("PRIVATE_CANARY")
        self.refusal("cleanup", "timeout")
        args = self.fixture.args()
        self.fixture.native = None
        self.refusal("message_lookup", "unknown", args)

    def test_real_cli_pipes_preserve_nested_stage_and_original_exit(self):
        # Real -I subprocess and stderr JSON catch main's former second error
        # classification, which otherwise overwrote the stage. The existing
        # fixture replaces provider I/O, not main/dispatcher/session locking.
        code = """
import json, pathlib, sys
from unittest import mock
sys.path.insert(0, sys.argv[1])
import test_assistant_monitor as base
f=base.ReferenceRead(); f.setUp()
try:
    revision=f.revision()
    f.provider.get_messages.side_effect=TimeoutError('PRIVATE_CANARY')
    with mock.patch.object(base.M, 'identity_from_args', return_value=f.identity), \\
         mock.patch.object(base.M, 'reexec_in_runtime_if_needed'):
        sys.argv=['fixture','read-reference','--chat','77','--message-id','1','--expected-revision',revision]
        result=base.M.main()
    assert f.provider.get_messages.await_count == 1
    assert f.provider.disconnect.await_count == 1
    assert f.provider.send_message.await_count == 0
    raise SystemExit(result)
finally:
    f.doCleanups()
"""
        env = {k: v for k, v in os.environ.items() if not k.startswith(("TRELIO_", "PYTHON"))}
        result = subprocess.run([sys.executable, "-I", "-B", "-c", code, str(pathlib.Path(__file__).parent)],
            capture_output=True, text=True, encoding="utf-8", env=env, timeout=15)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(result.stdout, "")
        payload = json.loads(result.stderr)
        self.assertEqual(payload["code"], "TELEGRAM_REFERENCE_UNAVAILABLE")
        self.assertEqual(payload["details"]["diagnostic"]["stage"], "message_lookup")
        self.assertEqual(payload["details"]["diagnostic"]["category"], "timeout")
        self.assertNotIn("PRIVATE_CANARY", result.stderr)
        self.assertNotIn(str(pathlib.Path(__file__).parent), result.stderr)


if __name__ == "__main__":
    unittest.main()
