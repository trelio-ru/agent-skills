"""Synthetic MTProto overview tests: no account, network or personal session."""
import asyncio
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS
from unittest import mock

PATH = pathlib.Path(__file__).parents[1] / 'scripts' / 'trelio-telegram.py'
SPEC = importlib.util.spec_from_file_location('telegram_inventory_runtime', PATH)
M = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = M
SPEC.loader.exec_module(M)


class User:
    def __init__(self, peer_id):
        self.id = peer_id
        self.first_name = 'Контакт ' + str(peer_id)
        self.username = None
        self.bot = False


class Utils:
    @staticmethod
    def get_peer_id(peer):
        return peer if isinstance(peer, int) else peer.id


def request_class(name):
    return type(name, (), {'__init__': lambda self, **kw: self.__dict__.update(kw)})


GetDialogs = request_class('GetDialogs')
GetPinned = request_class('GetPinned')
GetPeer = request_class('GetPeer')
InputDialog = type('InputDialog', (), {'__init__': lambda self, peer: setattr(self, 'peer', peer)})
Empty = type('Empty', (), {})
Dialogs = request_class('Dialogs')
DialogsSlice = request_class('DialogsSlice')


def message(peer_id, message_id, text='Сообщение', date=None, media=None):
    return NS(id=message_id, peer_id=peer_id, date=date or datetime(2026, 10, 6, 12, tzinfo=timezone.utc),
              message=text, out=False, sender=None, entities=[], media=media, file=None,
              reply_to=None, reply_to_msg_id=None)


class Provider:
    """Model the native folder, pin and exclusive message-ID boundaries."""
    def __init__(self, count=3):
        self.entities = {i: User(i) for i in range(1, count + 1)}
        self.folders = {i: 0 for i in self.entities}
        self.pins = []
        self.order = list(self.entities)
        self.history = {i: [] for i in self.entities}
        self.calls = []
        self.history_calls = []
        self.disconnect = mock.AsyncMock()
        self.fail_history = set()
        self.fail_metadata = set()
        self.fail_inventory = False
        self.timestamp = datetime(2026, 10, 6, 13, tzinfo=timezone.utc)

    async def get_me(self):
        return User(999)

    async def get_entity(self, reference):
        return self.entities[int(reference)]

    async def get_input_entity(self, entity):
        return self.entities[entity] if isinstance(entity, int) else entity

    def response(self, ids, kind=Dialogs):
        dialogs = [NS(peer=i, top_message=1, folder_id=self.folders[i] or None,
                      unread_count=i % 2, pinned=i in self.pins) for i in ids]
        # Preview text deliberately must never appear in inventory/output/token.
        previews = [message(i, 1, 'PRIVATE PREVIEW MUST NOT LEAK',
                            self.timestamp - timedelta(seconds=self.order.index(i))) for i in ids]
        return kind(dialogs=dialogs, users=[self.entities[i] for i in ids], chats=[], messages=previews)

    async def __call__(self, request):
        self.calls.append(request)
        if isinstance(request, GetPinned):
            return self.response([i for i in self.pins if self.folders[i] == request.folder_id])
        if isinstance(request, GetPeer):
            ids = [Utils.get_peer_id(p.peer) for p in request.peers]
            if any(i in self.fail_metadata for i in ids):
                raise TimeoutError('private transport detail')
            return self.response(ids)
        if isinstance(request, GetDialogs):
            if self.fail_inventory:
                raise TimeoutError('private transport detail')
            ids = [i for i in self.order if i not in self.pins and self.folders[i] == request.folder_id]
            if not isinstance(request.offset_peer, Empty):
                peer_id = Utils.get_peer_id(request.offset_peer)
                ids = ids[ids.index(peer_id) + 1:]
            selected = ids[:request.limit]
            return self.response(selected, DialogsSlice if len(ids) > request.limit else Dialogs)
        raise AssertionError('Unexpected or mutating provider method')

    def iter_messages(self, entity, **kwargs):
        self.history_calls.append((entity.id, kwargs))
        async def stream():
            if entity.id in self.fail_history:
                raise TimeoutError('private history detail')
            # Keep the upper boundary local too: a misbehaving provider must not
            # admit an out-of-period row merely because it accepted offset_date.
            rows = [m for m in self.history[entity.id]
                    if not kwargs['offset_id'] or m.id < kwargs['offset_id']]
            for m in rows[:kwargs['limit']]:
                yield m
        return stream()


class OverviewTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(mock.patch.object(M, 'connection_root', return_value=pathlib.Path(directory)))
        self.provider = Provider()
        self.enterContext(mock.patch.object(M, 'build_client', side_effect=lambda *_: self.provider))
        self.enterContext(mock.patch.object(M, 'ensure_authorized', new=mock.AsyncMock()))
        self.enterContext(mock.patch.object(M, 'import_telethon_inventory', return_value=(
            GetDialogs, GetPinned, GetPeer, Empty, InputDialog, Utils)))
        async def generation(_client):
            # Simulate account update changes even for a peer not visited yet.
            return M.overview_digest([self.provider.order, self.provider.pins,
                                      self.provider.folders, self.provider.timestamp.isoformat()])
        self.enterContext(mock.patch.object(M, 'inventory_generation', new=generation))
        self.identity = M.Identity('company', 'member', 'connection')

    def call(self, command, *argv):
        args = M.build_parser().parse_args([command, *argv])
        return asyncio.run((M.command_dialogs_async if command == 'dialogs' else M.command_export_async)(args, self.identity))

    def export(self, *argv):
        return self.call('export', '--since', '2026-10-06', '--until', '2026-10-07', '--timezone', 'Europe/Moscow', *argv)

    def inventory(self, *argv):
        results = []
        cursor = None
        for _ in range(200):
            result = self.call('dialogs', *argv, *(['--cursor', cursor] if cursor else []))
            results.append(result)
            cursor = result['coverage']['nextCursor']
            if not cursor:
                return results
        self.fail('Inventory did not terminate')

    def exported(self, *argv):
        results = []
        cursor = None
        for _ in range(200):
            result = self.export(*argv, *(['--cursor', cursor] if cursor else []))
            results.append(result)
            cursor = result['coverage']['nextCursor']
            if not cursor:
                return results
        self.fail('Export did not terminate')

    def test_more_than_1000_dialogs_pins_and_archive_are_covered_without_content(self):
        self.provider = Provider(1107)
        self.provider.pins = [1100, 1101]
        self.provider.folders[1107] = 1
        pages = self.inventory('--archive-scope', 'active', '--limit', '100')
        ids = [d['id'] for p in pages for d in p['dialogs']]
        self.assertEqual(set(ids), set(range(1, 1107)))
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(pages[-1]['coverage']['complete'])
        self.assertEqual(pages[-1]['coverage']['dialogsScanned'], 1106)
        self.assertNotIn('PRIVATE PREVIEW', json.dumps(pages))
        for request in self.provider.calls:
            self.assertEqual(request.folder_id, 0)
            if isinstance(request, GetDialogs):
                self.assertTrue(request.exclude_pinned)
                self.assertLessEqual(request.limit, 100)
        self.assertEqual(self.provider.history_calls, [])

    def test_pin_cursor_never_skips_newer_unpinned_dialogs(self):
        self.provider.pins = [3]
        pages = self.inventory('--limit', '1')
        self.assertEqual([d['id'] for p in pages for d in p['dialogs']], [3, 1, 2])
        self.assertTrue(pages[-1]['coverage']['verificationComplete'])

    def test_changes_during_inventory_never_report_complete(self):
        first = self.call('dialogs', '--archive-scope', 'active', '--limit', '1')
        self.provider.folders[3] = 1
        cursor = first['coverage']['nextCursor']
        while cursor:
            result = self.call('dialogs', '--archive-scope', 'active', '--limit', '1', '--cursor', cursor)
            cursor = result['coverage']['nextCursor']
        self.assertFalse(result['coverage']['complete'])
        self.assertIn('inventory_changed', result['coverage']['incompleteReasons'])

    def test_partial_inventory_failure_retries_the_last_delivered_offset(self):
        # The pinned part succeeded internally, but the ordinary RPC failed:
        # no rows were delivered, so continuation must include that pin again.
        self.provider.pins = [3]
        self.provider.fail_inventory = True
        result = self.export('--all-dialogs', '--archive-scope', 'active')
        self.assertEqual(result['chats'], [])
        self.assertIn('inventory_read_failed', result['coverage']['incompleteReasons'])
        self.assertEqual(self.provider.history_calls, [])
        self.provider.fail_inventory = False
        cursor = result['coverage']['nextCursor']
        peers = []
        while cursor:
            result = self.export('--all-dialogs', '--archive-scope', 'active', '--cursor', cursor)
            peers.extend(c['chat']['peerId'] for c in result['chats'])
            cursor = result['coverage']['nextCursor']
        self.assertEqual(peers, [3, 1, 2])
        self.assertTrue(result['coverage']['complete'])

    def test_missing_archive_field_cannot_be_treated_as_active(self):
        response = self.provider.response([1])
        del response.dialogs[0].folder_id
        with self.assertRaises(M.TelegramRuntimeError):
            M.inventory_rows(response, 0, False, Utils)
        with mock.patch.object(self.provider, 'response', return_value=response):
            result = self.export('--chat', '1', '--archive-scope', 'active')
        self.assertEqual(self.provider.history_calls, [])
        self.assertFalse(result['coverage']['complete'])
        self.assertIn('archive_metadata_unavailable', result['chats'][0]['incomplete_reasons'])

    def test_chat_and_channel_marked_ids_do_not_collide_with_user_ids(self):
        entities = [NS(id=7, kind='user'), NS(id=7, kind='chat'), NS(id=7, kind='channel')]
        def marked(peer):
            return {'user': 7, 'chat': -7, 'channel': -1000000000007}[peer.kind]
        utils = NS(get_peer_id=marked)
        peers = [NS(kind=e.kind) for e in entities]
        response = Dialogs(users=entities[:1], chats=entities[1:],
            dialogs=[NS(peer=p, folder_id=None, top_message=1, unread_count=0) for p in peers],
            messages=[NS(peer_id=p, id=1, date=self.provider.timestamp) for p in peers])
        rows = M.inventory_rows(response, 0, False, utils)
        self.assertEqual([r['id'] for r in rows], [7, -7, -1000000000007])

    def test_cursor_binds_account_scope_expiry_and_integrity(self):
        token = self.call('dialogs', '--archive-scope', 'active', '--limit', '1')['coverage']['nextCursor']
        for scope, changed_token in [('archived', token), ('active', token[:-1] + ('0' if token[-1] != '0' else '1'))]:
            with self.assertRaises(M.TelegramRuntimeError):
                self.call('dialogs', '--archive-scope', scope, '--cursor', changed_token)
        with mock.patch.object(self.provider, 'get_me', new=mock.AsyncMock(return_value=User(888))):
            with self.assertRaises(M.TelegramRuntimeError):
                self.call('dialogs', '--archive-scope', 'active', '--cursor', token)
        with mock.patch.object(M.time, 'time', return_value=M.time.time() + M.OVERVIEW_CURSOR_TTL + 1):
            with self.assertRaises(M.TelegramRuntimeError):
                self.call('dialogs', '--archive-scope', 'active', '--cursor', token)

    def test_same_timestamp_resume_and_closed_chats_are_not_reread(self):
        self.provider.history[1] = [message(1, i) for i in (4, 3, 2, 1)]
        self.provider.history[2] = [message(2, 1)]
        pages = self.exported('--chat', '1', '--chat', '2', '--archive-scope', 'active',
                              '--per-chat-limit', '2', '--chronological')
        keys = [(c['chat']['peerId'], m['id']) for p in pages for c in p['chats'] for m in c['messages']]
        self.assertEqual(set(keys), {(1, 1), (1, 2), (1, 3), (1, 4), (2, 1)})
        self.assertEqual(len(keys), 5)
        self.assertTrue(pages[-1]['coverage']['complete'])
        self.assertEqual([i for i, _ in self.provider.history_calls], [1, 2, 1])
        self.assertEqual(self.provider.history_calls[-1][1]['offset_id'], 3)

    def test_byte_and_total_scan_caps_resume_without_losing_omitted_rows(self):
        self.provider.history[1] = [message(1, i, 'я' * M.MAX_READ_TEXT_CHARS) for i in range(40, 0, -1)]
        pages = self.exported('--chat', '1', '--max-output-bytes', '1048576', '--chronological')
        self.assertTrue(pages[0]['hit_output_byte_limit'])
        self.assertTrue(all(M.compact_json_bytes({'ok': True, **p}) <= 1048576 for p in pages))
        ids = [m['id'] for p in pages for c in p['chats'] for m in c['messages']]
        self.assertEqual(sorted(ids), list(range(1, 41)))
        self.provider.history_calls.clear()
        pages = self.exported('--chat', '1', '--total-message-limit', '2', '--scan-limit', '2')
        self.assertTrue(pages[0]['hit_scan_limit'])
        self.assertEqual(sum(p['message_count'] for p in pages), 40)
        self.assertTrue(pages[-1]['coverage']['complete'])

    def test_archive_change_or_unknown_metadata_is_rechecked_before_history(self):
        self.provider.history[1] = [message(1, i) for i in (3, 2, 1)]
        first = self.export('--chat', '1', '--archive-scope', 'active', '--per-chat-limit', '1')
        self.provider.folders[1] = 1
        result = self.export('--chat', '1', '--archive-scope', 'active', '--per-chat-limit', '1',
                             '--cursor', first['coverage']['nextCursor'])
        self.assertEqual(len(self.provider.history_calls), 1)
        self.assertFalse(result['coverage']['complete'])
        self.assertIn('archive_scope_mismatch', result['chats'][0]['incomplete_reasons'])
        self.provider.fail_metadata.add(2)
        result = self.export('--chat', '2', '--archive-scope', 'active')
        self.assertTrue(result['coverage']['nextCursor'])
        self.assertFalse(result['coverage']['complete'])
        self.assertEqual(len(self.provider.history_calls), 1)

    def test_export_inventory_can_finish_more_than_1000_empty_chats(self):
        self.provider = Provider(1005)
        pages = self.exported('--all-dialogs', '--archive-scope', 'active', '--dialog-limit', '100')
        self.assertTrue(pages[-1]['coverage']['complete'])
        self.assertEqual(pages[-1]['coverage']['completedChats'], 1005)
        self.assertEqual(len(self.provider.history_calls), 1005)
        self.assertTrue(pages[-1]['coverage']['inventory']['complete'])

    def test_failures_keep_the_exact_unclosed_scope_and_other_chats_progress(self):
        self.provider.fail_history.add(1)
        self.provider.history[2] = [message(2, 1)]
        result = self.export('--chat', '1', '--chat', '2', '--archive-scope', 'active')
        self.assertEqual(result['message_count'], 1)
        self.assertFalse(result['coverage']['complete'])
        self.assertEqual(result['incomplete_chats'][0]['chat']['peerId'], 1)
        self.assertNotIn('private history', json.dumps(result))
        self.provider.fail_history.clear()
        result = self.export('--chat', '1', '--chat', '2', '--archive-scope', 'active',
                             '--cursor', result['coverage']['nextCursor'])
        self.assertTrue(result['coverage']['complete'])
        self.assertEqual([i for i, _ in self.provider.history_calls], [1, 2, 1])

    def test_period_binding_media_and_no_reply_or_mutation_side_effects(self):
        m = message(1, 1, media=NS())
        m.reply_to_msg_id = 4
        m.get_reply_message = mock.AsyncMock(side_effect=AssertionError('Must not dereference reply'))
        self.provider.history[1] = [m]
        result = self.export('--chat', '1', '--archive-scope', 'active')
        m.get_reply_message.assert_not_awaited()
        self.assertTrue(result['coverage']['complete'])
        self.assertEqual(result['chats'][0]['attachments'], {'returnedMetadata': 1, 'contentRead': 0})
        self.assertFalse(result['coverage']['attachmentsContentRead'])
        self.assertFalse(result['readState']['readReceiptsSent'])
        self.provider.history[1] = [message(1, i) for i in (3, 2, 1)]
        first = self.export('--chat', '1', '--per-chat-limit', '1')
        with self.assertRaises(M.TelegramRuntimeError):
            self.call('export', '--chat', '1', '--since', '2026-10-05', '--until', '2026-10-07',
                      '--cursor', first['coverage']['nextCursor'])

    def test_truncated_text_never_claims_full_content_coverage(self):
        self.provider.history[1] = [message(1, 1, 'я' * (M.MAX_READ_TEXT_CHARS + 1))]
        result = self.export('--chat', '1')
        self.assertFalse(result['coverage']['complete'])
        self.assertFalse(result['coverage']['textComplete'])
        self.assertFalse(result['chats'][0]['coverage']['complete'])
        self.assertFalse(result['chats'][0]['coverage']['textComplete'])
        self.assertIn('text_truncated', result['chats'][0]['incomplete_reasons'])


if __name__ == '__main__':
    unittest.main()
