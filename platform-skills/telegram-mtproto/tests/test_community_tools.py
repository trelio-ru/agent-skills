"""Production parser/handlers against a changing synthetic Telegram server."""
import asyncio
import copy
import json
import unittest
from types import SimpleNamespace as NS
from unittest import mock
from datetime import datetime, timezone

import test_message_workflows as base
import test_reactions as reactions

M, TL = base.M, base.tl_type
C = M.import_community_tools()
NAMES = ("GetForumTopicsRequest GetForumTopicsByIDRequest SearchRequest SendReactionRequest GetMessagesReactionsRequest "
         "GetPollResultsRequest SendVoteRequest EditMessageRequest UpdatePinnedMessageRequest SendMediaRequest GetFullChannelRequest "
         "GetMessageStatsRequest GetMessagePublicForwardsRequest LoadAsyncGraphRequest GetExportedChatInvitesRequest "
         "GetExportedChatInviteRequest ExportChatInviteRequest GetChatInviteImportersRequest HideChatJoinRequestRequest "
         "GetParticipantRequest GetFullChatRequest").split()
F = NS(**{name: TL(name) for name in NAMES})
T = NS(**{name: TL(name) for name in ("InputMessagesFilterPinned InputMessagesFilterEmpty InputUserEmpty InputUserSelf "
          "InputPeerSelf ReactionEmoji Poll PollAnswer InputMediaPoll TextWithEntities").split()})
U = NS(get_peer_id=base.peer_id, get_input_user=lambda value: value)


class CommunityTests(unittest.TestCase):
    setUpBase = base.MessageWorkflowsTests.setUp
    message = base.MessageWorkflowsTests.message

    def setUp(self):
        self.setUpBase()
        self.group.forum, self.group.creator = True, True
        self.enterContext(mock.patch.object(C, "api", return_value=(NS(messages=F, channels=F, stats=F), T, U, NS(parse=base.markdown))))
        self.topic = TL("ForumTopic")(id=11, peer=base.PeerChannel(channel_id=77), title="Операции", top_message=42,
                                      date=datetime(2026, 9, 5, tzinfo=timezone.utc), closed=False, hidden=False)
        self.pending = [TL("ChatInviteImporter")(user_id=8, date=datetime(2026, 9, 5, tzinfo=timezone.utc))]
        self.invite = TL("ChatInviteExported")(link="https://t.me/+SYNTHETIC_LINK", title="Встреча", date=datetime(2026, 9, 5, tzinfo=timezone.utc),
                    expire_date=datetime(2026, 10, 30, tzinfo=timezone.utc), usage_limit=5, request_needed=False)
        self.current = self.message(out=False, pinned=False, reactions=reactions.snapshot(results=[]))
        self.client.dispatch = self.dispatch

    def dispatch(self, request):
        name = type(request).__name__
        if name == "GetFullChannelRequest":
            return NS(full_chat=TL("ChannelFull")(id=77, can_view_stats=True, stats_dc=2, default_send_as=base.PeerUser(user_id=1)))
        if name in {"GetForumTopicsRequest", "GetForumTopicsByIDRequest"}:
            return NS(topics=[self.topic], count=1, messages=[self.current])
        if name == "SearchRequest":
            return NS(messages=[self.current], inexact=False)
        if name == "GetMessagesReactionsRequest":
            return NS(updates=[TL("UpdateMessageReactions")(peer=self.current.peer_id, msg_id=self.current.id, reactions=self.current.reactions)])
        if name == "SendReactionRequest":
            self.current.reactions = reactions.snapshot(results=[NS(reaction=value, count=1, chosen_order=i) for i, value in enumerate(request.reaction)])
            return NS(updates=[])
        if name == "UpdatePinnedMessageRequest":
            self.current.pinned = not request.unpin
            return NS(updates=[])
        if name == "GetPollResultsRequest":
            return NS(updates=[TL("UpdateMessagePoll")(poll_id=self.current.media.poll.id, poll=None, results=self.current.media.results)])
        if name == "SendVoteRequest":
            for row in self.current.media.results.results:
                row.chosen = row.option in request.options
                row.voters = 2 if row.chosen else 0
            return NS(updates=[])
        if name == "EditMessageRequest":
            self.current.media.poll.closed = True
            return NS(updates=[])
        if name == "SendMediaRequest":
            self.current = self.message(100, out=True, message="", media=TL("MessageMediaPoll")(poll=request.media.poll,
                results=TL("PollResults")(min=False, total_voters=0, results=[TL("PollAnswerVoters")(option=row.option, voters=0, chosen=False) for row in request.media.poll.answers])))
            self.current.media.poll.id = 555
            return NS(updates=[TL("UpdateNewChannelMessage")(message=self.current)])
        if name == "GetMessageStatsRequest":
            return TL("MessageStats")(views_graph=TL("StatsGraph")(json=NS(data=json.dumps({"columns": [["x", 1], ["y", 2]], "types": {"x": "x", "y": "line"}}))))
        if name == "GetMessagePublicForwardsRequest":
            return NS(forwards=[], chats=[], count=0, next_offset=None)
        if name == "GetExportedChatInvitesRequest":
            return NS(invites=[self.invite], count=1)
        if name == "ExportChatInviteRequest":
            self.invite.expire_date = request.expire_date
            self.invite.usage_limit = request.usage_limit
            return self.invite
        if name == "GetExportedChatInviteRequest":
            return NS(invite=self.invite)
        if name == "GetChatInviteImportersRequest":
            return NS(importers=self.pending, count=len(self.pending), users=[base.User(id=8, first_name="Алиса", phone="PRIVATE_PHONE", access_hash="PRIVATE_HASH")])
        if name == "HideChatJoinRequestRequest":
            self.pending = []
            return NS(updates=[])
        if name == "GetParticipantRequest":
            return NS(participant=TL("ChannelParticipant")(user_id=8))
        raise AssertionError(name)

    def cli(self, *argv):
        args = M.build_parser().parse_args(list(argv))
        return asyncio.run(C.run(args, self.identity, M))

    def apply(self, *argv):
        preview = self.cli(*argv, "--dry-run")
        result = self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        return preview, result

    def poll(self, **overrides):
        p = T.Poll(id=555, hash=0, question=T.TextWithEntities(text="Когда?", entities=[]), closed=False,
                   answers=[T.PollAnswer(text=T.TextWithEntities(text=value, entities=[]), option=bytes([i])) for i, value in enumerate(("Сегодня", "Завтра"))],
                   multiple_choice=False, public_voters=False, **overrides)
        self.current.media = TL("MessageMediaPoll")(poll=p, results=TL("PollResults")(min=False, total_voters=2,
                      results=[TL("PollAnswerVoters")(option=bytes([i]), voters=1, chosen=False) for i in range(2)]))
        return p

    def test_topics_search_is_metadata_only_and_checks_exact_peer(self):
        result = self.cli("topics", "--chat", "@forum", "--query", "Опер")
        self.assertEqual(result["topics"][0]["id"], 11)
        self.assertTrue(result["coverage"]["complete"])
        self.assertFalse(result["readState"]["marksRead"])
        self.assertEqual(self.client.reads, [])
        self.assertEqual(self.client.calls[0].q, "Опер")
        self.topic.peer = base.PeerChannel(channel_id=99)
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("topics", "--chat", "@forum")

    def test_topic_read_rejects_foreign_thread_and_scopes_search(self):
        self.current.reply_to = NS(forum_topic=True, reply_to_msg_id=11)
        result = self.cli("topic-read", "--chat", "@forum", "--topic-id", "11")
        self.assertEqual(result["messages"][0]["id"], 42)
        self.assertEqual(self.client.calls[-1].top_msg_id, 11)
        self.current.reply_to.reply_to_msg_id = 12
        with self.assertRaisesRegex(M.TelegramRuntimeError, "foreign"):
            self.cli("topic-read", "--chat", "@forum", "--topic-id", "11")

    def test_general_topic_does_not_include_other_forum_threads(self):
        self.topic.id = 1
        self.assertEqual(len(self.cli("topic-read", "--chat", "@forum", "--topic-id", "1")["messages"]), 1)
        self.current.reply_to = NS(forum_topic=True, reply_to_msg_id=11)
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("topic-read", "--chat", "@forum", "--topic-id", "1")

    def test_topic_send_has_own_sender_and_exact_thread_verification(self):
        sent = self.message(100, message="Привет", out=True, reply_to=NS(forum_topic=True, reply_to_msg_id=11))
        self.client.send_message.return_value = sent
        preview, result = self.apply("topic-send", "--chat", "@forum", "--topic-id", "11", "--message", "Привет")
        self.assertTrue(result["sent"])
        self.assertEqual(self.client.send_message.call_args.kwargs["reply_to"], 11)
        self.assertEqual(self.client.send_message.call_args.kwargs["send_as"].id, 1)
        self.assertEqual(preview["preview"]["topic"]["title"], "Операции")
        self.topic.closed = True
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("topic-send", "--chat", "@forum", "--topic-id", "11", "--message", "Привет", "--dry-run")

    def test_reaction_to_incoming_message_and_removal_have_verified_receipts(self):
        _preview, result = self.apply("react", "--chat", "@group", "--message-id", "42", "--emoji", "👍")
        self.assertTrue(result["applied"])
        self.assertTrue(result["message"]["reactions"]["results"][0]["chosen"])
        self.apply("react", "--chat", "@group", "--message-id", "42", "--clear")
        self.assertEqual(self.current.reactions.results, [])
        self.assertFalse(self.current.out)

    def test_reaction_hash_rechecks_source_and_is_one_use(self):
        argv = ["react", "--chat", "@group", "--message-id", "42", "--emoji", "👍"]
        preview = self.cli(*argv, "--dry-run")
        self.current.message = "Изменено"
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertFalse(any(type(call).__name__ == "SendReactionRequest" for call in self.client.calls))
        preview, _ = self.apply(*argv)
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])

    def test_reaction_fails_closed_for_min_metadata_and_channel_send_as(self):
        self.current.reactions.min = True
        # Even an empty min snapshot does not prove an empty own selection.
        self.current.reactions.results = [NS(reaction=T.ReactionEmoji(emoticon="👍"), count=2)]
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("react", "--chat", "@group", "--message-id", "42", "--clear", "--dry-run")
        original = self.client.dispatch
        self.client.dispatch = lambda q: NS(full_chat=TL("ChannelFull")(id=77, default_send_as=base.PeerChannel(channel_id=99))) if type(q).__name__ == "GetFullChannelRequest" else original(q)
        with self.assertRaisesRegex(M.TelegramRuntimeError, "send-as"):
            self.cli("react", "--chat", "@group", "--message-id", "42", "--emoji", "👍", "--dry-run")

    def test_poll_read_never_exposes_native_options_or_voter_profiles(self):
        self.poll()
        result = self.cli("poll", "--chat", "@group", "--message-id", "42")["poll"]
        self.assertEqual(result["question"], "Когда?")
        self.assertEqual(result["options"][0], {"index": 1, "text": "Сегодня", "voters": 1, "chosen": False})
        self.assertTrue(result["resultsComplete"])
        self.assertNotIn("recent_voters", json.dumps(result))
        self.current.media.results.min = True
        self.assertIsNone(self.cli("poll", "--chat", "@group", "--message-id", "42")["poll"]["options"][0]["chosen"])

    def test_poll_vote_maps_display_index_and_allows_unrelated_count_changes(self):
        self.poll()
        argv = ["poll-vote", "--chat", "@group", "--message-id", "42", "--option", "2"]
        preview = self.cli(*argv, "--dry-run")
        self.current.media.results.total_voters += 1
        result = self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertTrue(result["applied"])
        request = next(call for call in self.client.calls if type(call).__name__ == "SendVoteRequest")
        self.assertEqual(request.options, [b'\x01'])

    def test_poll_multi_choice_bounds_and_own_close(self):
        self.poll()
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("poll-vote", "--chat", "@group", "--message-id", "42", "--option", "1", "--option", "2", "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("poll-close", "--chat", "@group", "--message-id", "42", "--dry-run")
        self.current.out = True
        self.assertTrue(self.apply("poll-close", "--chat", "@group", "--message-id", "42")[1]["applied"])

    def test_poll_create_verifies_question_answers_and_privacy(self):
        preview, result = self.apply("poll-create", "--chat", "@group", "--question", "Когда?", "--option", "Сегодня", "--option", "Завтра")
        self.assertEqual(result["poll"]["question"], "Когда?")
        self.assertTrue(result["poll"]["anonymous"])
        self.assertTrue(preview["preview"]["anonymous"])

    def test_pins_read_and_silent_pin_unpin_own_incoming_message(self):
        self.apply("pin", "--chat", "@group", "--message-id", "42")
        result = self.cli("pins", "--chat", "@group")
        self.assertEqual(result["messages"][0]["id"], 42)
        self.assertTrue(next(call for call in self.client.calls if type(call).__name__ == "UpdatePinnedMessageRequest").silent)
        self.apply("unpin", "--chat", "@group", "--message-id", "42")
        self.assertFalse(self.current.pinned)

    def test_message_stats_use_exact_dc_and_keep_graph_tokens_private(self):
        self.group.broadcast = True
        self.client.session = NS(dc_id=2)
        result = self.cli("message-stats", "--chat", "@channel", "--message-id", "42")
        self.assertTrue(result["graph"]["complete"])
        self.assertEqual(result["graph"]["series"][0]["values"], [2])
        result = self.cli("public-forwards", "--chat", "@channel", "--message-id", "42")
        self.assertFalse(result["coverage"]["privateForwardsIncluded"])

    def test_admin_reads_project_only_selected_safe_fields(self):
        result = self.cli("join-requests", "--chat", "@group")
        self.assertEqual(result["requests"][0]["userId"], 8)
        self.assertNotIn("PRIVATE_", json.dumps(result))
        result = self.cli("invites", "--chat", "@group")
        self.assertEqual(result["scope"], "own_admin_links")
        self.group.creator = False
        with self.assertRaisesRegex(M.TelegramRuntimeError, "invite_users"):
            self.cli("invites", "--chat", "@group")

    def test_expiring_invite_has_read_back_and_cannot_mix_join_request_with_cap(self):
        _preview, result = self.apply("invite-create", "--chat", "@group", "--title", "Встреча", "--expires-at", "2026-10-30T00:00:00Z", "--usage-limit", "5")
        self.assertEqual(result["invite"]["usageLimit"], 5)
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("invite-create", "--chat", "@group", "--title", "Встреча", "--expires-at", "2026-10-30T00:00:00Z", "--usage-limit", "5", "--request-needed", "--dry-run")

    def test_join_approve_checks_pending_identity_and_actual_membership(self):
        _preview, result = self.apply("join-request", "--chat", "@group", "--user-id", "8", "--decision", "approve")
        self.assertTrue(result["applied"])
        self.assertEqual(self.pending, [])
        self.assertEqual(type(self.client.calls[-1]).__name__, "GetParticipantRequest")

    def test_join_decline_checks_absence_and_missing_request_is_not_success(self):
        self.assertTrue(self.apply("join-request", "--chat", "@group", "--user-id", "8", "--decision", "decline")[1]["applied"])
        with self.assertRaisesRegex(M.TelegramRuntimeError, "no pending"):
            self.cli("join-request", "--chat", "@group", "--user-id", "8", "--decision", "approve", "--dry-run")

    def test_readonly_allows_preview_but_never_dispatches_or_consumes(self):
        with mock.patch.object(M, "load_policy", return_value={"sendMode": "read-only"}):
            preview = self.cli("pin", "--chat", "@group", "--message-id", "42", "--dry-run")
            with self.assertRaises(M.TelegramRuntimeError):
                self.cli("pin", "--chat", "@group", "--message-id", "42", "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertFalse(any(type(call).__name__ == "UpdatePinnedMessageRequest" for call in self.client.calls))

    def test_ambiguous_mutation_consumes_approval_and_redacts_provider_error(self):
        argv = ["pin", "--chat", "@group", "--message-id", "42"]
        preview = self.cli(*argv, "--dry-run")
        self.client.dispatch = lambda _q: (_ for _ in ()).throw(TimeoutError("PRIVATE_RPC_SECRET"))
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(caught.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        self.assertNotIn("PRIVATE_", str(caught.exception))
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])

    def test_mutation_client_disables_native_retries_and_subscription(self):
        # Call the unpatched production builder with native IO dependencies replaced.
        builder = self._original_builder
        client = mock.Mock()
        with mock.patch.object(M, "require_app_credentials", return_value=(123, "synthetic", False)), mock.patch.object(M, "import_telethon", return_value=(client, None, None)):
            builder(M.build_parser().parse_args(["react", "--chat", "@g", "--message-id", "42", "--clear", "--dry-run"]), self.identity)
        self.assertEqual(client.call_args.kwargs["request_retries"], 0)
        self.assertFalse(client.call_args.kwargs["receive_updates"])

    _original_builder = staticmethod(M.build_client)


class CommunityBoundaryTests(unittest.TestCase):
    """Additional races and bounds using the same synthetic server."""
    setUpBase = CommunityTests.setUpBase
    setUp = CommunityTests.setUp
    message = CommunityTests.message
    dispatch = CommunityTests.dispatch
    cli = CommunityTests.cli
    apply = CommunityTests.apply
    poll = CommunityTests.poll

    def test_unknown_reactions_do_not_become_an_empty_choice(self):
        for snapshot in (None, reactions.snapshot(min=True, results=[])):
            self.current.reactions = snapshot
            with self.assertRaises(M.TelegramRuntimeError):
                self.cli("react", "--chat", "@g", "--message-id", "42", "--clear", "--dry-run")

    def test_missing_stats_permission_never_queries_statistics(self):
        self.group.broadcast = True
        self.client.dispatch = lambda q: NS(full_chat=TL("ChannelFull")(id=77, can_view_stats=False))
        result = self.cli("message-stats", "--chat", "@g", "--message-id", "42")
        self.assertFalse(result["available"])
        self.assertEqual(len(self.client.calls), 1)

    def test_topic_page_has_usable_scoped_continuation(self):
        original = self.client.dispatch
        self.client.dispatch = lambda q: NS(topics=[self.topic], count=2, messages=[self.current]) if type(q).__name__ == "GetForumTopicsRequest" else original(q)
        result = self.cli("topics", "--chat", "@g", "--limit", "1")
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual(result["nextOffset"]["offsetTopic"], 11)
        self.assertEqual(result["nextOffset"]["offsetId"], 42)

    def test_foreign_scheduled_or_nonadvancing_search_never_becomes_a_pin_list(self):
        self.current.pinned = True
        self.current.peer_id = base.PeerChannel(channel_id=999)
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("pins", "--chat", "@g")

    def test_replaced_poll_cannot_reuse_vote_approval(self):
        self.poll()
        argv = ["poll-vote", "--chat", "@g", "--message-id", "42", "--option", "1"]
        preview = self.cli(*argv, "--dry-run")
        self.current.media.poll.answers[0].text.text = "Другое решение"
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertFalse(any(type(q).__name__ == "SendVoteRequest" for q in self.client.calls))

    def test_pending_scan_proves_absence_only_after_all_pages(self):
        calls = []
        rows = [TL("ChatInviteImporter")(user_id=i, date=datetime(2026, 9, 5, tzinfo=timezone.utc)) for i in range(10, 111)]
        def dispatch(q):
            calls.append(q)
            start = 0 if type(q.offset_user).__name__ == "InputUserEmpty" else 100
            return NS(importers=rows[start:start + 100], count=len(rows))
        self.client.dispatch = dispatch
        result = asyncio.run(C.find_request(self.client, self.group, 8, M, NS(messages=F), T, U))
        self.assertIsNone(result)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1].offset_user, 109)
        self.client.dispatch = lambda _q: NS(importers=[], count=5)
        with self.assertRaises(M.TelegramRuntimeError):
            asyncio.run(C.find_request(self.client, self.group, 8, M, NS(messages=F), T, U))

    def test_changed_join_request_does_not_use_old_approval(self):
        argv = ["join-request", "--chat", "@g", "--user-id", "8", "--decision", "approve"]
        preview = self.cli(*argv, "--dry-run")
        self.pending[0].date = datetime(2026, 9, 6, tzinfo=timezone.utc)
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(len(self.pending), 1)

    def test_approval_binds_account_and_expires_without_mutation(self):
        argv = ["pin", "--chat", "@g", "--message-id", "42"]
        preview = self.cli(*argv, "--dry-run")
        self.client.account.id = 2
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.client.account.id = 1
        with mock.patch.object(M.time, "time", return_value=M.time.time() + 301):
            with self.assertRaises(M.TelegramRuntimeError):
                self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertFalse(self.current.pinned)

    def test_failed_membership_verification_is_unknown_and_cannot_replay(self):
        original = self.client.dispatch
        self.client.dispatch = lambda q: NS(participant=TL("ChannelParticipantLeft")()) if type(q).__name__ == "GetParticipantRequest" else original(q)
        argv = ["join-request", "--chat", "@g", "--user-id", "8", "--decision", "approve"]
        preview = self.cli(*argv, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(caught.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        self.assertEqual(self.pending, [])

    def test_invite_year_outside_native_timestamp_rejected_before_write(self):
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("invite-create", "--chat", "@g", "--title", "Встреча", "--expires-at", "2100-01-01T00:00:00Z", "--dry-run")


if __name__ == '__main__':
    unittest.main()
