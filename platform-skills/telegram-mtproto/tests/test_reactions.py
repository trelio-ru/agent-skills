"""Reaction reads use synthetic TL snapshots, without sessions or network."""

import asyncio
import json
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace as NS
from unittest import mock

import test_message_workflows as base
import test_inventory_workflows as overview
import test_search_workflows as search


M = base.M
Emoji, CustomEmoji, Paid = map(base.tl_type, (
    "ReactionEmoji", "ReactionCustomEmoji", "ReactionPaid",
))


def snapshot(**overrides):
    """Model provider counts and a recent sample separately from permissions."""

    return NS(**{
        "results": [NS(reaction=Emoji(emoticon="👍"), count=3, chosen_order=0)],
        "recent_reactions": [], "min": False, "can_see_list": True,
        "reactions_as_tags": False, **overrides,
    })


class ReactionProjectionTests(unittest.TestCase):
    def project(self, reactions):
        return M.public_message_reactions(NS(reactions=reactions))

    def test_counts_unicode_custom_emoji_paid_and_zero_chosen_order_survive(self):
        result = self.project(snapshot(results=[
            NS(reaction=Emoji(emoticon="👩‍💻"), count=3, chosen_order=0),
            NS(reaction=CustomEmoji(document_id=9_007_199_254_740_993), count=2),
            NS(reaction=Paid(), count=7),
        ]))
        self.assertEqual(result["results"], [
            {"type": "emoji", "emoji": "👩‍💻", "count": 3, "chosen": True, "chosenOrder": 0},
            {"type": "custom_emoji", "documentId": "9007199254740993", "count": 2,
             "chosen": False, "chosenOrder": None},
            {"type": "paid", "count": 7, "chosen": False, "chosenOrder": None},
        ])
        self.assertEqual(result["totalCount"], 12)
        self.assertTrue(result["complete"])

    def test_missing_metadata_is_distinct_from_an_explicit_empty_snapshot(self):
        self.assertIsNone(self.project(None))
        self.assertIsNone(M.public_message_reactions(NS()))
        empty = self.project(snapshot(results=[]))
        self.assertEqual(empty["results"], [])
        self.assertEqual(empty["totalCount"], 0)
        self.assertTrue(empty["complete"])
        unavailable = self.project(NS())
        self.assertIsNone(unavailable["totalCount"])
        self.assertFalse(unavailable["complete"])

    def test_min_counts_do_not_invent_the_current_users_selection(self):
        result = self.project(snapshot(min=True, reactions_as_tags=True))
        self.assertTrue(result["complete"])
        self.assertEqual(result["totalCount"], 3)
        self.assertIsNone(result["results"][0]["chosen"])
        self.assertIsNone(result["results"][0]["chosenOrder"])
        self.assertTrue(result["asTags"])

    def test_invalid_selection_and_recent_peer_remain_unknown(self):
        result = self.project(snapshot(
            results=[NS(reaction=Emoji(emoticon="👍"), count=3, chosen_order=True)],
            recent_reactions=[NS(peer_id=NS(user_id=8), reaction=Emoji(emoticon="👍"))],
        ))
        self.assertIsNone(result["results"][0]["chosen"])
        self.assertTrue(result["complete"])
        self.assertEqual(result["recent"], [])
        self.assertTrue(result["recentTruncated"])

    def test_recent_rows_preserve_typed_peers_but_never_claim_a_full_list(self):
        date = datetime(2026, 10, 9, 12, tzinfo=timezone.utc)
        peers = [base.PeerUser(user_id=8), base.tl_type("PeerChat")(chat_id=9),
                 base.PeerChannel(channel_id=77)]
        recent = [NS(peer_id=peer, reaction=Emoji(emoticon="👍"), date=date,
                     my=(index == 0), unread=True) for index, peer in enumerate(peers)]
        message = NS(reactions=snapshot(recent_reactions=recent), _entities={
            8: base.User(id=8, first_name="Алиса", username="alice",
                         phone="PRIVATE_PHONE", access_hash="PRIVATE_HASH"),
        })
        result = M.public_message_reactions(message)
        self.assertEqual([row["peer"]["id"] for row in result["recent"]],
                         [8, -9, -1000000000077])
        self.assertEqual([row["peer"]["type"] for row in result["recent"]],
                         ["user", "chat", "channel"])
        self.assertEqual(result["recent"][0]["peer"]["title"], "Алиса")
        self.assertEqual(result["recent"][0]["date"], date.isoformat())
        self.assertTrue(result["recent"][0]["my"])
        self.assertFalse(result["recentComplete"])
        self.assertTrue(result["canSeeList"])
        self.assertNotIn("PRIVATE_", json.dumps(result))

    def test_unknown_reactions_invalid_counts_and_oversized_values_stay_partial(self):
        invalid = [
            NS(reaction=base.tl_type("FutureReaction")(secret="PRIVATE_VALUE"), count=2),
            NS(reaction=Emoji(emoticon="👍"), count=True),
            NS(reaction=Emoji(emoticon="👍"), count=-1),
            NS(reaction=Emoji(emoticon="👍"), count=2**31),
            NS(reaction=Emoji(emoticon="x" * (M.MAX_REACTION_EMOJI_CHARS + 1)), count=1),
            NS(reaction=CustomEmoji(document_id=True), count=1),
            NS(reaction=CustomEmoji(document_id=2**63), count=1),
        ]
        for row in invalid:
            with self.subTest(row=row):
                result = self.project(snapshot(results=[row]))
                self.assertEqual(result["results"], [])
                self.assertFalse(result["complete"])
                self.assertIsNone(result["totalCount"])
                self.assertNotIn("PRIVATE_VALUE", json.dumps(result))

    def test_type_and_recent_caps_do_not_misreport_counts_or_completeness(self):
        row = NS(reaction=Emoji(emoticon="👍"), count=1)
        recent = NS(peer_id=base.PeerUser(user_id=8), reaction=Emoji(emoticon="👍"))
        result = self.project(snapshot(
            results=[row] * (M.MAX_REACTION_TYPES + 1),
            recent_reactions=[recent] * (M.MAX_RECENT_REACTIONS + 1),
        ))
        self.assertEqual(len(result["results"]), M.MAX_REACTION_TYPES)
        self.assertEqual(len(result["recent"]), M.MAX_RECENT_REACTIONS)
        self.assertFalse(result["complete"])
        self.assertIsNone(result["totalCount"])
        self.assertTrue(result["recentTruncated"])
        self.assertFalse(result["recentComplete"])

    def test_hidden_recent_list_does_not_remove_aggregate_counts(self):
        result = self.project(snapshot(can_see_list=False, recent_reactions=None))
        self.assertEqual(result["totalCount"], 3)
        self.assertEqual(result["recent"], [])
        self.assertFalse(result["canSeeList"])
        self.assertFalse(result["recentComplete"])


class ReactionReadPathTests(unittest.TestCase):
    setUp = base.MessageWorkflowsTests.setUp
    args = base.MessageWorkflowsTests.args
    call = base.MessageWorkflowsTests.call
    message = base.MessageWorkflowsTests.message
    history_provider = search.SearchWorkflowsTests.history_provider
    global_provider = search.SearchWorkflowsTests.global_provider
    global_message = search.SearchWorkflowsTests.global_message
    context_history = search.SearchWorkflowsTests.context_history

    def assert_reactions(self, message):
        self.assertEqual(message["reactions"]["results"][0]["emoji"], "👍")
        self.assertEqual(message["reactions"]["totalCount"], 3)

    def test_exact_and_recent_reads_return_counts_without_reaction_rpcs(self):
        message = self.message(reactions=snapshot())
        result = self.call(M.command_read_async, "read", "--chat", "old_group", "--message-id", "42")
        self.assert_reactions(result["message"])
        async def history():
            yield message
        self.client.iter_messages = mock.Mock(side_effect=lambda *_a, **_kw: history())
        result = self.call(M.command_read_async, "read", "--chat", "old_group", "--limit", "1")
        self.assert_reactions(result["messages"][0])
        self.assertEqual(self.client.calls, [])
        self.client.send_message.assert_not_called()

    def test_exact_context_keeps_reactions_in_the_normalized_window(self):
        self.message(reactions=snapshot())
        async def empty():
            if False:
                yield None
        self.client.iter_messages = mock.Mock(side_effect=lambda *_a, **_kw: empty())
        result = self.call(M.command_read_async, "read", "--chat", "old_group",
                           "--message-id", "42", "--context", "1")
        self.assert_reactions(result["message"])
        self.assert_reactions(result["context"]["messages"][0])
        self.assertEqual(self.client.calls, [])

    def test_thread_keeps_root_and_reply_reactions(self):
        self.message(11, reactions=snapshot())
        reply = self.message(42, reactions=snapshot(), reply_to=base.TL(reply_to_top_id=11))
        self.client.dispatch = lambda _request: NS(messages=[reply], users=[], chats=[self.group])
        result = self.call(M.command_thread_async, "thread", "--chat", "old_group", "--message-id", "42")
        self.assert_reactions(result["root"])
        self.assert_reactions(result["messages"][0])

    def test_selected_and_global_search_keep_reactions(self):
        self.history_provider([self.message(reactions=snapshot())])
        selected = self.call(M.command_search_async, "search", "--chat", "old_group", "--query", "текст", "--from", "8")
        self.assert_reactions(selected["messages"][0])
        self.global_provider([NS(messages=[self.global_message(43, reactions=snapshot())],
                                 users=[], chats=[self.group], count=1, next_rate=0, inexact=False)])
        global_result = self.call(M.command_search_async, "search", "--global", "--query", "текст", "--limit", "1")
        self.assert_reactions(global_result["messages"][0])

    def test_merged_search_context_keeps_reactions_on_all_window_messages(self):
        rows = [self.message(i, reactions=snapshot()) for i in range(7, 16)]
        self.context_history(rows)
        matches = [rows[1], rows[3], rows[5]]
        public = asyncio.run(M.public_messages(matches, self.group))
        result = asyncio.run(M.attach_search_contexts(
            self.client, matches, public, 1, chats=[self.group] * 3,
        ))
        self.assertEqual(len(result["groups"]), 1)
        for message in result["groups"][0]["messages"]:
            self.assert_reactions(message)

    def test_scheduled_message_projection_keeps_returned_reaction_metadata(self):
        self.client.get_messages = mock.AsyncMock(return_value=[self.message(reactions=snapshot())])
        result = self.call(M.command_scheduled_async, "scheduled", "--chat", "old_group")
        self.assert_reactions(result["messages"][0])
        self.assertTrue(self.client.get_messages.call_args.kwargs["scheduled"])


class ReactionExportTests(unittest.TestCase):
    setUp = overview.OverviewTests.setUp
    call = overview.OverviewTests.call
    export = overview.OverviewTests.export

    def test_period_export_preserves_reactions_without_extra_reads_or_receipts(self):
        message = overview.message(1, 42)
        message.reactions = snapshot()
        self.provider.history[1] = [message]
        result = self.export("--chat", "1")
        self.assertEqual(result["chats"][0]["messages"][0]["reactions"]["totalCount"], 3)
        self.assertEqual(len(self.provider.history_calls), 1)
        self.assertTrue(all(isinstance(request, overview.GetPeer) for request in self.provider.calls))


if __name__ == "__main__":
    unittest.main()
