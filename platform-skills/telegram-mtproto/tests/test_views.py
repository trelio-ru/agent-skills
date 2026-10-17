"""Channel-post views survive scoped reads without registering a new view.

Use the production command paths with a synthetic provider. Unexpected RPCs
fail instead of silently accepting a getMessagesViews/increment or read receipt.
No personal account, credential, session or Telegram network access is needed.
"""

import asyncio
import unittest
from types import SimpleNamespace as NS
from unittest import mock

import test_message_workflows as base
import test_inventory_workflows as overview
import test_search_workflows as search


M = base.M


class ViewReadTests(unittest.TestCase):
    setUp = base.MessageWorkflowsTests.setUp
    args = base.MessageWorkflowsTests.args
    call = base.MessageWorkflowsTests.call
    message = base.MessageWorkflowsTests.message
    history_provider = search.SearchWorkflowsTests.history_provider
    global_provider = search.SearchWorkflowsTests.global_provider
    global_message = search.SearchWorkflowsTests.global_message
    context_history = search.SearchWorkflowsTests.context_history

    def test_only_nonnegative_tl_int_counts_are_exposed_including_zero(self):
        for value in (0, 1, 123456, 2**31 - 1):
            with self.subTest(value=value):
                row = M.public_message(self.message(views=value))
                self.assertEqual(row["views"], value)
                self.assertIs(type(row["views"]), int)
        for value in (None, True, False, -1, 2**31, 1.0, "123", [], {}):
            with self.subTest(value=value):
                self.assertIsNone(M.public_message(self.message(views=value))["views"])
        # Older/service messages and ordinary chats may omit the attribute.
        self.assertIsNone(M.public_message(self.message())["views"])
        self.assertEqual(self.client.calls, [])

    def test_exact_and_recent_channel_reads_keep_views_without_extra_rpcs(self):
        self.group.broadcast = True
        post = self.message(views=123456)
        result = self.call(M.command_read_async, "read", "--link", "https://t.me/old_group/42")
        self.assertEqual(result["message"]["views"], 123456)
        self.assertFalse(result["readState"]["marksRead"])
        # A second explicit read returns a new provider snapshot, not a cache
        # of the old counter or an agent-computed increment.
        post.views = 123460
        result = self.call(M.command_read_async, "read", "--chat", "old_group", "--message-id", "42")
        self.assertEqual(result["message"]["views"], 123460)

        async def history():
            yield post
        self.client.iter_messages = mock.Mock(side_effect=lambda *_a, **_kw: history())
        result = self.call(M.command_read_async, "read", "--chat", "old_group", "--limit", "1")
        self.assertEqual(result["messages"][0]["views"], 123460)
        self.assertEqual(self.client.calls, [])
        self.client.send_message.assert_not_called()

    def test_exact_context_preserves_missing_and_zero_counters_independently(self):
        self.message(views=0)
        async def empty():
            if False:
                yield None
        self.client.iter_messages = mock.Mock(side_effect=lambda *_a, **_kw: empty())
        result = self.call(M.command_read_async, "read", "--chat", "old_group",
                           "--message-id", "42", "--context", "1")
        self.assertEqual(result["message"]["views"], 0)
        self.assertEqual(result["context"]["messages"][0]["views"], 0)
        self.assertEqual(self.client.calls, [])

    def test_thread_preserves_root_counter_and_unknown_reply_counter(self):
        self.message(11, views=7)
        reply = self.message(42, reply_to=base.TL(reply_to_top_id=11))
        def provider(request):
            self.assertIsInstance(request, base.FUNCTIONS.GetRepliesRequest)
            return NS(messages=[reply], users=[], chats=[self.group])
        self.client.dispatch = provider
        result = self.call(M.command_thread_async, "thread", "--chat", "old_group", "--message-id", "42")
        self.assertEqual(result["root"]["views"], 7)
        self.assertIsNone(result["messages"][0]["views"])
        self.assertEqual(len(self.client.calls), 1)

    def test_selected_and_global_search_preserve_post_counters(self):
        self.history_provider([self.message(views=81)])
        selected = self.call(M.command_search_async, "search", "--chat", "old_group", "--query", "текст", "--from", "8")
        self.assertEqual(selected["messages"][0]["views"], 81)
        self.assertEqual(len(self.client.calls), 1)
        self.global_provider([NS(messages=[self.global_message(43, views=92)],
                                 users=[], chats=[self.group], count=1, next_rate=0, inexact=False)])
        result = self.call(M.command_search_async, "search", "--global", "--query", "текст", "--limit", "1")
        self.assertEqual(result["messages"][0]["views"], 92)
        self.assertEqual(len(self.client.calls), 2)

    def test_merged_search_context_keeps_each_posts_own_counter(self):
        rows = [self.message(i, views=i * 10) for i in range(7, 16)]
        self.context_history(rows)
        matches = [rows[1], rows[3], rows[5]]
        public = asyncio.run(M.public_messages(matches, self.group))
        result = asyncio.run(M.attach_search_contexts(
            self.client, matches, public, 1, chats=[self.group] * 3,
        ))
        self.assertEqual(len(result["groups"]), 1)
        for row in result["groups"][0]["messages"]:
            self.assertEqual(row["views"], row["id"] * 10)
        self.assertEqual(self.client.calls, [])

    def test_scheduled_message_without_metadata_has_unknown_views(self):
        self.client.get_messages = mock.AsyncMock(return_value=[self.message()])
        result = self.call(M.command_scheduled_async, "scheduled", "--chat", "old_group")
        self.assertIsNone(result["messages"][0]["views"])
        self.assertTrue(self.client.get_messages.call_args.kwargs["scheduled"])
        self.assertEqual(self.client.calls, [])


class ViewExportTests(unittest.TestCase):
    setUp = overview.OverviewTests.setUp
    call = overview.OverviewTests.call
    export = overview.OverviewTests.export

    def test_export_preserves_views_without_extra_reads_or_receipts(self):
        post = overview.message(1, 42)
        post.views = 321
        self.provider.history[1] = [post]
        result = self.export("--chat", "1")
        self.assertEqual(result["chats"][0]["messages"][0]["views"], 321)
        self.assertEqual(len(self.provider.history_calls), 1)
        self.assertTrue(all(isinstance(request, overview.GetPeer) for request in self.provider.calls))


if __name__ == "__main__":
    unittest.main()
