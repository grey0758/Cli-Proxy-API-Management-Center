import importlib.util
import json
import stat
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).parents[2] / 'ops' / 'phone-pool-service' / 'phone_pool_service.py'
)
SPEC = importlib.util.spec_from_file_location('phone_pool_service', MODULE_PATH)
assert SPEC and SPEC.loader
phone_pool_service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(phone_pool_service)


class PhonePoolServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_directory.name)
        self.account_path = self.root / 'account-pool.json'
        self.state_path = self.root / 'phone-pool.json'
        self.account_path.write_text(
            json.dumps(
                {
                    'version': 1,
                    'accounts': [
                        {'email': 'first@example.com'},
                        {'email': 'second@example.com'},
                    ],
                }
            ),
            encoding='utf-8',
        )
        self.account_path.chmod(0o600)

        def fake_fetcher(url, allowed_hosts):
            self.assertIn('example-token', url)
            self.assertIn('provider.example', allowed_hosts)
            return {
                'provider_status': 200,
                'content_type': 'application/json',
                'body': '{"message":"123456"}',
                'truncated': False,
                'fetched_at': '2026-07-23T00:00:00Z',
            }

        self.repository = phone_pool_service.PhonePoolRepository(
            self.state_path,
            self.account_path,
            allowed_hosts=frozenset({'provider.example'}),
            provider_fetcher=fake_fetcher,
        )

    def tearDown(self):
        self.temp_directory.cleanup()

    def test_normalizes_supported_us_phone_forms(self):
        self.assertEqual(phone_pool_service.normalize_phone('443-857-5076'), '+14438575076')
        self.assertEqual(phone_pool_service.normalize_phone('13464738881'), '+13464738881')
        self.assertEqual(phone_pool_service.normalize_phone('+1 215 459 7144'), '+12154597144')
        with self.assertRaisesRegex(phone_pool_service.PhonePoolError, 'invalid_phone'):
            phone_pool_service.normalize_phone('call-me-at-4438575076')

    def test_import_snapshot_never_returns_provider_url(self):
        snapshot = self.repository.import_source(
            '4438575076----https://provider.example/sms?token=example-token',
            baseline_bindings=3,
        )
        self.assertEqual(snapshot['count'], 1)
        self.assertEqual(snapshot['enabled_count'], 1)
        self.assertEqual(snapshot['phones'][0]['number'], '+14438575076')
        self.assertEqual(snapshot['phones'][0]['binding_count'], 3)
        self.assertNotIn('sms_url', json.dumps(snapshot))
        self.assertNotIn('example-token', json.dumps(snapshot))
        self.assertEqual(stat.S_IMODE(self.state_path.stat().st_mode), 0o600)

    def test_binding_count_is_historical_and_binding_is_movable(self):
        snapshot = self.repository.import_source(
            '\n'.join(
                [
                    '4438575076|https://provider.example/a?token=example-token',
                    '7209875645|https://provider.example/b?token=example-token',
                ]
            ),
            baseline_bindings=3,
        )
        first_id, second_id = [phone['id'] for phone in snapshot['phones']]
        snapshot = self.repository.bind('FIRST@example.com', first_id)
        first_phone = next(phone for phone in snapshot['phones'] if phone['id'] == first_id)
        self.assertEqual(first_phone['binding_count'], 4)
        self.assertEqual(first_phone['current_bindings'], 1)

        snapshot = self.repository.bind('first@example.com', second_id)
        first_phone = next(phone for phone in snapshot['phones'] if phone['id'] == first_id)
        second_phone = next(phone for phone in snapshot['phones'] if phone['id'] == second_id)
        self.assertEqual(first_phone['binding_count'], 4)
        self.assertEqual(first_phone['current_bindings'], 0)
        self.assertEqual(second_phone['binding_count'], 4)
        self.assertEqual(second_phone['current_bindings'], 1)

        snapshot = self.repository.unbind('first@example.com')
        second_phone = next(phone for phone in snapshot['phones'] if phone['id'] == second_id)
        self.assertEqual(second_phone['binding_count'], 4)
        self.assertEqual(second_phone['current_bindings'], 0)
        self.assertEqual(snapshot['bindings'], [])

    def test_request_code_uses_current_binding_and_returns_no_url(self):
        snapshot = self.repository.import_source(
            '4438575076|https://provider.example/sms?token=example-token',
            baseline_bindings=3,
        )
        self.repository.bind('first@example.com', snapshot['phones'][0]['id'])
        response = self.repository.request_code(account_email='first@example.com')
        self.assertEqual(response['body'], '{"message":"123456"}')
        self.assertNotIn('url', response)
        self.assertNotIn('example-token', json.dumps(response))

    def test_rejects_unknown_accounts_and_disabled_phones(self):
        snapshot = self.repository.import_source(
            '4438575076|https://provider.example/sms?token=example-token',
            baseline_bindings=3,
        )
        phone_id = snapshot['phones'][0]['id']
        with self.assertRaisesRegex(phone_pool_service.PhonePoolError, 'account_not_found'):
            self.repository.bind('missing@example.com', phone_id)
        self.repository.set_enabled(phone_id, False)
        with self.assertRaisesRegex(phone_pool_service.PhonePoolError, 'phone_disabled'):
            self.repository.bind('first@example.com', phone_id)

    def test_provider_url_validation_blocks_non_https_and_private_dns(self):
        with self.assertRaisesRegex(phone_pool_service.PhonePoolError, 'invalid_provider_url'):
            phone_pool_service.validate_provider_url(
                'http://provider.example/sms',
                frozenset({'provider.example'}),
            )
        with self.assertRaisesRegex(phone_pool_service.PhonePoolError, 'invalid_provider_url'):
            phone_pool_service.validate_provider_url(
                'https://other.example/sms',
                frozenset({'provider.example'}),
            )

        def private_resolver(*args, **kwargs):
            return [(2, 1, 6, '', ('127.0.0.1', 443))]

        with self.assertRaisesRegex(phone_pool_service.PhonePoolError, 'provider_address_blocked'):
            phone_pool_service.validate_provider_url(
                'https://provider.example/sms',
                frozenset({'provider.example'}),
                resolver=private_resolver,
            )

    def test_redacts_query_and_path_secrets_from_provider_content(self):
        query_url = 'https://provider.example/sms?token=example-token'
        path_url = 'https://provider.example/sms/abcdefghijklmnopqrstuvwx'
        body = 'token=example-token path=abcdefghijklmnopqrstuvwx'
        redacted = phone_pool_service.redact_provider_body(body, [query_url, path_url])
        self.assertNotIn('example-token', redacted)
        self.assertNotIn('abcdefghijklmnopqrstuvwx', redacted)
        self.assertEqual(redacted.count('[REDACTED]'), 2)

    def test_private_file_mode_is_enforced(self):
        self.repository.import_source(
            '4438575076|https://provider.example/sms?token=example-token',
            baseline_bindings=3,
        )
        self.state_path.chmod(0o644)
        with self.assertRaisesRegex(phone_pool_service.PhonePoolError, 'private_file_mode_required'):
            self.repository.snapshot()


if __name__ == '__main__':
    unittest.main()
