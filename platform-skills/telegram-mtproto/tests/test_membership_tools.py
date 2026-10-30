"""Group creation/invitation against the actual parser and a changing server."""
import asyncio
import unittest
from types import SimpleNamespace as NS
from unittest import mock
import test_message_workflows as base
import test_community_tools as community

M, C, TL = base.M, community.C, base.tl_type
Chat = TL('Chat')

class MembershipTests(unittest.TestCase):
    def setUp(self):
        base.MessageWorkflowsTests.setUp(self)
        self.user = base.User(id=8, first_name='Алиса', username='alice', phone='PRIVATE_PHONE', access_hash='PRIVATE_HASH')
        self.group = Chat(id=77, title='Команда', creator=True)
        self.members = {1}
        self.missing = []
        self.write_count = 0
        functions = NS(**{name: TL(name) for name in ('CreateChatRequest', 'AddChatUserRequest', 'GetFullChatRequest',
            'GetFullChannelRequest', 'GetParticipantRequest', 'InviteToChannelRequest')})
        self.enterContext(mock.patch.object(C, 'api', return_value=(NS(messages=functions, channels=functions), NS(),
            NS(get_peer_id=self.peer_id, get_input_user=lambda user:user), None)))
        async def entity(reference):
            if reference in ('@alice', 8): return self.user
            return self.group
        self.client.get_entity = entity
        self.client.dispatch = self.dispatch

    def peer_id(self, entity):
        return -entity.id if type(entity).__name__ == 'Chat' else base.peer_id(entity)

    def dispatch(self, request):
        name = type(request).__name__
        if name == 'GetFullChatRequest':
            return NS(full_chat=TL('ChatFull')(id=self.group.id, participants=TL('ChatParticipants')(
                chat_id=self.group.id, participants=[NS(user_id=value) for value in sorted(self.members)])), chats=[self.group])
        if name in ('CreateChatRequest', 'AddChatUserRequest'):
            self.write_count += 1
            if name == 'CreateChatRequest': self.group.title = request.title
            if 8 not in self.missing: self.members.add(8)
            message = NS(peer_id=NS(chat_id=self.group.id), action=TL('MessageActionChatCreate')(title=self.group.title))
            return TL('InvitedUsers')(missing_invitees=[NS(user_id=value) for value in self.missing],
                updates=NS(chats=[self.group], updates=[TL('UpdateNewMessage')(message=message)]))
        raise AssertionError(name)

    def cli(self, *args):
        return asyncio.run(C.run(M.build_parser().parse_args(list(args)), self.identity, M))

    def apply(self, *args):
        preview = self.cli(*args, '--dry-run')
        return preview, self.cli(*args, '--confirm', '--approval-hash', preview['approvalHash'])

    def test_create_has_exact_preview_one_request_and_full_membership_readback(self):
        preview, result = self.apply('group-create', '--title', 'Рабочая группа', '--user', '@alice')
        self.assertEqual(preview['preview']['users'][0]['id'], 8)
        self.assertNotIn('PRIVATE_', str(preview))
        self.assertEqual(self.write_count, 1)
        self.assertTrue(result['created']); self.assertTrue(result['applied'])
        self.assertEqual(result['addedUserIds'], [8])
        self.assertEqual(self.client.reads, [], 'membership never reads message history')

    def test_missing_invitee_is_reported_without_recreating_the_created_group(self):
        self.missing = [8]
        _, result = self.apply('group-create', '--title', 'Группа', '--user', '@alice')
        self.assertTrue(result['created']); self.assertFalse(result['applied'])
        self.assertEqual(result['notAddedUserIds'], [8]); self.assertEqual(self.write_count, 1)

    def test_username_reassignment_title_change_and_duplicate_people_invalidate_preview(self):
        args = ['group-create', '--title', 'Группа', '--user', '@alice']
        preview = self.cli(*args, '--dry-run')
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli('group-create', '--title', 'Другая', '--user', '@alice', '--confirm', '--approval-hash', preview['approvalHash'])
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, '--user', '@alice', '--dry-run')
        self.user.username = 'different'
        with self.assertRaises(M.TelegramRuntimeError): self.cli(*args, '--dry-run')
        self.assertEqual(self.write_count, 0)

    def test_invite_existing_group_does_not_forward_old_history_or_repeat_membership(self):
        _, result = self.apply('member-add', '--chat', '-77', '--user', '@alice')
        self.assertTrue(result['applied']); self.assertEqual(self.write_count, 1)
        request = next(call for call in self.client.calls if type(call).__name__ == 'AddChatUserRequest')
        self.assertEqual(request.fwd_limit, 0)
        _, result = self.apply('member-add', '--chat', '-77', '--user', '@alice')
        self.assertTrue(result['alreadyMember']); self.assertEqual(self.write_count, 1)

    def test_read_only_and_missing_admin_permission_prevent_write(self):
        args = ['member-add', '--chat', '-77', '--user', '@alice']
        preview = self.cli(*args, '--dry-run')
        with mock.patch.object(M, 'load_policy', return_value={'sendMode':'read-only'}):
            with self.assertRaises(M.TelegramRuntimeError):
                self.cli(*args, '--confirm', '--approval-hash', preview['approvalHash'])
        self.group.creator = False
        with self.assertRaises(M.TelegramRuntimeError): self.cli(*args, '--dry-run')
        self.assertEqual(self.write_count, 0)

    def test_lost_native_response_consumes_approval_and_never_replays(self):
        args = ['group-create', '--title', 'Группа', '--user', '@alice']
        preview = self.cli(*args, '--dry-run')
        def lost(request):
            self.write_count += 1
            raise TimeoutError('PRIVATE_RESPONSE')
        self.client.dispatch = lost
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.cli(*args, '--confirm', '--approval-hash', preview['approvalHash'])
        self.assertEqual(caught.exception.code, 'TELEGRAM_ACTION_OUTCOME_UNKNOWN')
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, '--confirm', '--approval-hash', preview['approvalHash'])
        self.assertEqual(self.write_count, 1)

    def test_foreign_membership_readback_is_unknown_and_preserves_created_peer(self):
        original = self.dispatch
        def bad(request):
            result = original(request)
            if type(request).__name__ == 'GetFullChatRequest': result.full_chat.id = 99
            return result
        self.client.dispatch = bad
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.apply('group-create', '--title', 'Группа', '--user', '@alice')
        self.assertEqual(caught.exception.code, 'TELEGRAM_ACTION_OUTCOME_UNKNOWN')
        self.assertEqual(caught.exception.details['createdChatId'], -77)
        self.assertEqual(self.write_count, 1)

    def test_supergroup_uses_exact_invite_and_membership_not_history_or_basic_chat_rpc(self):
        self.group = base.Channel(id=77, title='Супергруппа', megagroup=True, broadcast=False, creator=True)
        def dispatch(request):
            name = type(request).__name__
            if name == 'GetFullChannelRequest':
                return NS(full_chat=TL('ChannelFull')(id=77), chats=[self.group])
            if name == 'GetParticipantRequest':
                if 8 not in self.members:
                    raise type('UserNotParticipantError', (Exception,), {})()
                return NS(participant=TL('ChannelParticipant')(user_id=8))
            if name == 'InviteToChannelRequest':
                self.write_count += 1; self.members.add(8)
                return TL('InvitedUsers')(missing_invitees=[], updates=NS(updates=[], chats=[]))
            raise AssertionError(name)
        self.client.dispatch = dispatch
        _, result = self.apply('member-add', '--chat', '-1000000000077', '--user', '@alice')
        self.assertTrue(result['applied']); self.assertEqual(self.write_count, 1)
        self.assertFalse(any(type(call).__name__ == 'AddChatUserRequest' for call in self.client.calls))
        self.assertEqual(self.client.reads, [])

    def test_native_request_constructors_match_current_telethon_without_network(self):
        try:
            from telethon import functions, types
        except ImportError:
            self.skipTest('Optional native constructors require installed Telethon')
        user = types.InputUser(user_id=8, access_hash=123)
        for request in [functions.messages.CreateChatRequest(users=[user], title='Группа'),
                        functions.messages.AddChatUserRequest(chat_id=77, user_id=user, fwd_limit=0),
                        functions.channels.InviteToChannelRequest(channel=types.InputChannel(77, 456), users=[user])]:
            self.assertTrue(bytes(request))

    def test_cleanup_failure_preserves_created_chat_id_without_replaying_creation(self):
        self.client.disconnect.side_effect = OSError('SYNTHETIC_PRIVATE_ERROR')
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.apply('group-create', '--title', 'Группа', '--user', '@alice')
        # Preview cleanup fails before dispatch too, so exercise the failed
        # cleanup only after a successful reviewed preview.
        self.assertEqual(self.write_count, 0)
        self.client.disconnect.side_effect = None
        args = ['group-create', '--title', 'Группа', '--user', '@alice']
        preview = self.cli(*args, '--dry-run')
        self.client.disconnect.side_effect = OSError('SYNTHETIC_PRIVATE_ERROR')
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.cli(*args, '--confirm', '--approval-hash', preview['approvalHash'])
        self.assertEqual(caught.exception.code, 'TELEGRAM_ACTION_OUTCOME_UNKNOWN')
        self.assertEqual(caught.exception.details['createdChatId'], -77)
        self.assertEqual(self.write_count, 1)
