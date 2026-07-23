#!/usr/bin/env python3
"""Loopback-only private phone pool service for the CLIProxy management UI."""

from __future__ import annotations

import hashlib
import http.client
import ipaddress
import json
import os
import re
import socket
import tempfile
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

DEFAULT_ALLOWED_HOSTS = frozenset(
    {
        'esim88.top',
        'eim388.top',
        'sms24.uk',
        '51sms.net',
        'app.yuntl.cc',
    }
)
MAX_REQUEST_BYTES = 256 * 1024
MAX_PROVIDER_BYTES = 128 * 1024
MAX_PHONES = 1000
MAX_PROVIDER_URL_BYTES = 4096
SENSITIVE_QUERY_KEYS = frozenset(
    {'access_token', 'apikey', 'api_key', 'auth', 'key', 'secret', 'token'}
)


class PhonePoolError(Exception):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.status = status


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def normalize_phone(value: str) -> str:
    raw = value.strip()
    if not raw or not re.fullmatch(r'[+\d\s().-]+', raw):
        raise PhonePoolError('invalid_phone')
    digits = re.sub(r'\D', '', raw)
    if len(digits) == 10:
        digits = f'1{digits}'
    if len(digits) < 8 or len(digits) > 15:
        raise PhonePoolError('invalid_phone')
    return f'+{digits}'


def normalize_email(value: str) -> str:
    normalized = value.strip().casefold()
    if not normalized or '@' not in normalized or len(normalized) > 320:
        raise PhonePoolError('invalid_account')
    return normalized


def account_identity(email: str) -> str:
    return hashlib.sha256(normalize_email(email).encode('utf-8')).hexdigest()


def phone_identity(number: str) -> str:
    digest = hashlib.sha256(number.encode('ascii')).hexdigest()[:24]
    return f'phone_{digest}'


def _validate_provider_url_syntax(url: str, allowed_hosts: frozenset[str]) -> tuple[str, str]:
    if len(url.encode('utf-8')) > MAX_PROVIDER_URL_BYTES:
        raise PhonePoolError('invalid_provider_url')
    parsed = urlsplit(url.strip())
    host = (parsed.hostname or '').rstrip('.').casefold()
    if (
        parsed.scheme.casefold() != 'https'
        or not host
        or host not in allowed_hosts
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise PhonePoolError('invalid_provider_url')
    try:
        if parsed.port not in (None, 443):
            raise PhonePoolError('invalid_provider_url')
    except ValueError as error:
        raise PhonePoolError('invalid_provider_url') from error
    return url.strip(), host


def validate_provider_url(
    url: str,
    allowed_hosts: frozenset[str],
    resolver: Callable[..., list[tuple[Any, ...]]] = socket.getaddrinfo,
) -> str:
    normalized, host = _validate_provider_url_syntax(url, allowed_hosts)
    try:
        addresses = resolver(host, 443, type=socket.SOCK_STREAM)
    except OSError as error:
        raise PhonePoolError('provider_dns_failed', 502) from error
    if not addresses:
        raise PhonePoolError('provider_dns_failed', 502)
    for address in addresses:
        try:
            resolved = ipaddress.ip_address(address[4][0])
        except (IndexError, ValueError) as error:
            raise PhonePoolError('provider_dns_failed', 502) from error
        if not resolved.is_global:
            raise PhonePoolError('provider_address_blocked', 502)
    return normalized


def _provider_secret_values(url: str) -> set[str]:
    parsed = urlsplit(url)
    values = {
        value
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key.casefold() in SENSITIVE_QUERY_KEYS and value
    }
    values.update(
        segment
        for segment in parsed.path.split('/')
        if len(segment) >= 20 and re.fullmatch(r'[A-Za-z0-9_-]+', segment)
    )
    return values


def redact_provider_body(body: str, provider_urls: list[str]) -> str:
    redacted = body
    for url in provider_urls:
        for value in sorted(_provider_secret_values(url), key=len, reverse=True):
            redacted = redacted.replace(value, '[REDACTED]')
    redacted = re.sub(
        r'(?i)((?:access_?token|api_?key|auth|secret|token)\s*[=:]\s*)'
        r'([A-Za-z0-9._~+/=-]{6,})',
        r'\1[REDACTED]',
        redacted,
    )
    return redacted


class SafeRedirectHandler(HTTPRedirectHandler):
    def __init__(self, allowed_hosts: frozenset[str]):
        super().__init__()
        self.allowed_hosts = allowed_hosts

    def redirect_request(
        self,
        req: Request,
        fp: Any,
        code: int,
        msg: str,
        headers: http.client.HTTPMessage,
        newurl: str,
    ) -> Request | None:
        target = urljoin(req.full_url, newurl)
        validate_provider_url(target, self.allowed_hosts)
        return super().redirect_request(req, fp, code, msg, headers, target)


def fetch_provider_response(
    url: str,
    allowed_hosts: frozenset[str],
    timeout: float = 12.0,
) -> dict[str, Any]:
    initial_url = validate_provider_url(url, allowed_hosts)
    opener = build_opener(SafeRedirectHandler(allowed_hosts))
    request = Request(
        initial_url,
        headers={
            'Accept': 'application/json,text/plain;q=0.9,*/*;q=0.5',
            'User-Agent': 'CLIProxyPhonePool/1.0',
        },
        method='GET',
    )
    response: Any
    try:
        response = opener.open(request, timeout=timeout)
    except HTTPError as error:
        response = error
    except (TimeoutError, URLError, OSError) as error:
        raise PhonePoolError('provider_request_failed', 502) from error

    try:
        final_url = response.geturl()
        validate_provider_url(final_url, allowed_hosts)
        payload = response.read(MAX_PROVIDER_BYTES + 1)
        truncated = len(payload) > MAX_PROVIDER_BYTES
        payload = payload[:MAX_PROVIDER_BYTES]
        content_type = response.headers.get_content_type() or 'application/octet-stream'
        charset = response.headers.get_content_charset() or 'utf-8'
        try:
            text = payload.decode(charset, errors='replace')
        except LookupError:
            text = payload.decode('utf-8', errors='replace')
        text = redact_provider_body(text, [initial_url, final_url])
        return {
            'provider_status': int(response.status),
            'content_type': content_type,
            'body': text,
            'truncated': truncated,
            'fetched_at': utc_now(),
        }
    finally:
        response.close()


def parse_import_source(
    source: str,
    allowed_hosts: frozenset[str],
) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    seen: set[str] = set()
    for line_number, raw_line in enumerate(source.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith('#') or line.startswith('//'):
            continue
        if '----' in line:
            phone, url = line.split('----', 1)
        elif '|' in line:
            phone, url = line.split('|', 1)
        else:
            raise PhonePoolError(f'invalid_import_line:{line_number}')
        number = normalize_phone(phone)
        provider_url, _ = _validate_provider_url_syntax(url.strip(), allowed_hosts)
        if number in seen:
            raise PhonePoolError(f'duplicate_phone:{line_number}')
        seen.add(number)
        entries.append((number, provider_url))
    if not entries:
        raise PhonePoolError('empty_import')
    if len(entries) > MAX_PHONES:
        raise PhonePoolError('too_many_phones')
    return entries


class PhonePoolRepository:
    def __init__(
        self,
        state_path: Path,
        account_snapshot_path: Path,
        allowed_hosts: frozenset[str] = DEFAULT_ALLOWED_HOSTS,
        provider_fetcher: Callable[[str, frozenset[str]], dict[str, Any]] = fetch_provider_response,
    ):
        self.state_path = state_path
        self.account_snapshot_path = account_snapshot_path
        self.allowed_hosts = allowed_hosts
        self.provider_fetcher = provider_fetcher
        self.lock = threading.RLock()

    def _empty_state(self) -> dict[str, Any]:
        return {'version': 1, 'updated_at': utc_now(), 'phones': [], 'bindings': {}}

    @staticmethod
    def _require_private_file(path: Path) -> None:
        if path.exists() and path.stat().st_mode & 0o077:
            raise PhonePoolError('private_file_mode_required', 500)

    def _load_state(self) -> dict[str, Any]:
        self._require_private_file(self.state_path)
        if not self.state_path.exists():
            return self._empty_state()
        try:
            value = json.loads(self.state_path.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as error:
            raise PhonePoolError('state_invalid', 500) from error
        if (
            not isinstance(value, dict)
            or value.get('version') != 1
            or not isinstance(value.get('phones'), list)
            or not isinstance(value.get('bindings'), dict)
        ):
            raise PhonePoolError('state_invalid', 500)
        return value

    def _save_state(self, state: dict[str, Any]) -> None:
        self.state_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        state['updated_at'] = utc_now()
        descriptor, temporary_name = tempfile.mkstemp(
            dir=self.state_path.parent,
            prefix='.phone-pool.',
            suffix='.tmp',
        )
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
                json.dump(state, handle, ensure_ascii=False, separators=(',', ':'))
                handle.write('\n')
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, self.state_path)
            os.chmod(self.state_path, 0o600)
        except Exception:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise

    def _account_map(self) -> dict[str, str]:
        self._require_private_file(self.account_snapshot_path)
        try:
            snapshot = json.loads(self.account_snapshot_path.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as error:
            raise PhonePoolError('account_snapshot_unavailable', 503) from error
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get('accounts'), list):
            raise PhonePoolError('account_snapshot_invalid', 503)
        result: dict[str, str] = {}
        for item in snapshot['accounts']:
            if not isinstance(item, dict) or not isinstance(item.get('email'), str):
                raise PhonePoolError('account_snapshot_invalid', 503)
            original = item['email'].strip()
            result[normalize_email(original)] = original
        return result

    @staticmethod
    def _phones_by_id(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
        result: dict[str, dict[str, Any]] = {}
        for phone in state['phones']:
            if not isinstance(phone, dict) or not isinstance(phone.get('id'), str):
                raise PhonePoolError('state_invalid', 500)
            result[phone['id']] = phone
        return result

    def _sanitized_snapshot(self, state: dict[str, Any]) -> dict[str, Any]:
        accounts = self._account_map()
        account_emails_by_hash = {
            account_identity(normalized): original for normalized, original in accounts.items()
        }
        current_counts: dict[str, int] = {}
        bindings = []
        for account_hash, binding in state['bindings'].items():
            if not isinstance(binding, dict) or not isinstance(binding.get('phone_id'), str):
                raise PhonePoolError('state_invalid', 500)
            current_counts[binding['phone_id']] = current_counts.get(binding['phone_id'], 0) + 1
            account_email = account_emails_by_hash.get(account_hash)
            if account_email:
                bindings.append(
                    {
                        'account_email': account_email,
                        'phone_id': binding['phone_id'],
                        'bound_at': str(binding.get('bound_at') or ''),
                    }
                )

        phones = []
        for phone in state['phones']:
            historical_accounts = phone.get('bound_accounts', [])
            if not isinstance(historical_accounts, list):
                raise PhonePoolError('state_invalid', 500)
            baseline = int(phone.get('baseline_bindings', 0))
            historical = len(set(str(item) for item in historical_accounts))
            phones.append(
                {
                    'id': phone['id'],
                    'number': phone['number'],
                    'enabled': bool(phone.get('enabled', True)),
                    'baseline_bindings': baseline,
                    'recorded_bindings': historical,
                    'binding_count': baseline + historical,
                    'current_bindings': current_counts.get(phone['id'], 0),
                }
            )
        return {
            'version': 1,
            'updated_at': state.get('updated_at', ''),
            'count': len(phones),
            'enabled_count': sum(1 for phone in phones if phone['enabled']),
            'phones': phones,
            'bindings': sorted(bindings, key=lambda item: item['account_email'].casefold()),
        }

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return self._sanitized_snapshot(self._load_state())

    def import_source(self, source: str, baseline_bindings: int) -> dict[str, Any]:
        if baseline_bindings < 0 or baseline_bindings > 1_000_000:
            raise PhonePoolError('invalid_baseline_bindings')
        entries = parse_import_source(source, self.allowed_hosts)
        with self.lock:
            state = self._load_state()
            by_number = {phone.get('number'): phone for phone in state['phones']}
            if len(set(by_number).union(number for number, _ in entries)) > MAX_PHONES:
                raise PhonePoolError('too_many_phones')
            for number, provider_url in entries:
                existing = by_number.get(number)
                if existing:
                    existing['sms_url'] = provider_url
                    existing['baseline_bindings'] = baseline_bindings
                    existing['enabled'] = True
                    existing.setdefault('bound_accounts', [])
                else:
                    phone = {
                        'id': phone_identity(number),
                        'number': number,
                        'sms_url': provider_url,
                        'baseline_bindings': baseline_bindings,
                        'enabled': True,
                        'bound_accounts': [],
                        'created_at': utc_now(),
                    }
                    state['phones'].append(phone)
                    by_number[number] = phone
            self._save_state(state)
            return self._sanitized_snapshot(state)

    def bind(self, account_email: str, phone_id: str) -> dict[str, Any]:
        accounts = self._account_map()
        normalized_email = normalize_email(account_email)
        if normalized_email not in accounts:
            raise PhonePoolError('account_not_found', 404)
        account_hash = account_identity(normalized_email)
        with self.lock:
            state = self._load_state()
            phone = self._phones_by_id(state).get(phone_id)
            if not phone:
                raise PhonePoolError('phone_not_found', 404)
            if not phone.get('enabled', True):
                raise PhonePoolError('phone_disabled', 409)
            historical = phone.setdefault('bound_accounts', [])
            if account_hash not in historical:
                historical.append(account_hash)
            previous = state['bindings'].get(account_hash)
            bound_at = (
                previous.get('bound_at')
                if isinstance(previous, dict) and previous.get('phone_id') == phone_id
                else utc_now()
            )
            state['bindings'][account_hash] = {'phone_id': phone_id, 'bound_at': bound_at}
            self._save_state(state)
            return self._sanitized_snapshot(state)

    def unbind(self, account_email: str) -> dict[str, Any]:
        accounts = self._account_map()
        normalized_email = normalize_email(account_email)
        if normalized_email not in accounts:
            raise PhonePoolError('account_not_found', 404)
        with self.lock:
            state = self._load_state()
            state['bindings'].pop(account_identity(normalized_email), None)
            self._save_state(state)
            return self._sanitized_snapshot(state)

    def set_enabled(self, phone_id: str, enabled: bool) -> dict[str, Any]:
        with self.lock:
            state = self._load_state()
            phone = self._phones_by_id(state).get(phone_id)
            if not phone:
                raise PhonePoolError('phone_not_found', 404)
            phone['enabled'] = enabled
            self._save_state(state)
            return self._sanitized_snapshot(state)

    def request_code(
        self,
        account_email: str | None = None,
        phone_id: str | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            state = self._load_state()
            if account_email:
                accounts = self._account_map()
                normalized_email = normalize_email(account_email)
                if normalized_email not in accounts:
                    raise PhonePoolError('account_not_found', 404)
                binding = state['bindings'].get(account_identity(normalized_email))
                if not isinstance(binding, dict):
                    raise PhonePoolError('account_not_bound', 409)
                phone_id = binding.get('phone_id')
            if not phone_id:
                raise PhonePoolError('phone_required')
            phone = self._phones_by_id(state).get(str(phone_id))
            if not phone:
                raise PhonePoolError('phone_not_found', 404)
            if not phone.get('enabled', True):
                raise PhonePoolError('phone_disabled', 409)
            provider_url = str(phone.get('sms_url') or '')
            public_phone = {'phone_id': phone['id'], 'number': phone['number']}

        response = self.provider_fetcher(provider_url, self.allowed_hosts)
        return {**public_phone, **response}


class PhonePoolRequestHandler(BaseHTTPRequestHandler):
    server_version = 'CLIProxyPhonePool/1.0'
    repository: PhonePoolRepository

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Cache-Control', 'no-store, private')
        self.send_header('Pragma', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(encoded)

    def _ensure_loopback(self) -> None:
        try:
            if not ipaddress.ip_address(self.client_address[0]).is_loopback:
                raise PhonePoolError('loopback_only', 403)
        except ValueError as error:
            raise PhonePoolError('loopback_only', 403) from error

    def _read_json(self) -> dict[str, Any]:
        content_length = self.headers.get('Content-Length')
        if not content_length:
            raise PhonePoolError('content_length_required', 411)
        try:
            length = int(content_length)
        except ValueError as error:
            raise PhonePoolError('invalid_content_length') from error
        if length < 0 or length > MAX_REQUEST_BYTES:
            raise PhonePoolError('request_too_large', 413)
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PhonePoolError('invalid_json') from error
        if not isinstance(value, dict):
            raise PhonePoolError('invalid_json')
        return value

    def _route(self) -> str:
        path = urlsplit(self.path)
        if path.query or path.fragment:
            raise PhonePoolError('invalid_path', 404)
        return path.path.rstrip('/') or '/'

    def _handle(self, method: str) -> None:
        try:
            self._ensure_loopback()
            path = self._route()
            if method == 'GET' and path == '/healthz':
                self._send_json(200, {'status': 'ok'})
                return
            if method == 'GET' and path == '/v0/management/phone-pool':
                self._send_json(200, self.repository.snapshot())
                return
            if method != 'POST':
                raise PhonePoolError('not_found', 404)

            payload = self._read_json()
            if path == '/v0/management/phone-pool/import':
                source = payload.get('source')
                baseline = payload.get('baseline_bindings', 0)
                if not isinstance(source, str) or not isinstance(baseline, int):
                    raise PhonePoolError('invalid_import')
                result = self.repository.import_source(source, baseline)
            elif path == '/v0/management/phone-pool/bind':
                email, phone_id = payload.get('account_email'), payload.get('phone_id')
                if not isinstance(email, str) or not isinstance(phone_id, str):
                    raise PhonePoolError('invalid_binding')
                result = self.repository.bind(email, phone_id)
            elif path == '/v0/management/phone-pool/unbind':
                email = payload.get('account_email')
                if not isinstance(email, str):
                    raise PhonePoolError('invalid_binding')
                result = self.repository.unbind(email)
            elif path == '/v0/management/phone-pool/enabled':
                phone_id, enabled = payload.get('phone_id'), payload.get('enabled')
                if not isinstance(phone_id, str) or not isinstance(enabled, bool):
                    raise PhonePoolError('invalid_phone_state')
                result = self.repository.set_enabled(phone_id, enabled)
            elif path == '/v0/management/phone-pool/request-code':
                email, phone_id = payload.get('account_email'), payload.get('phone_id')
                if email is not None and not isinstance(email, str):
                    raise PhonePoolError('invalid_binding')
                if phone_id is not None and not isinstance(phone_id, str):
                    raise PhonePoolError('invalid_phone_state')
                result = self.repository.request_code(email, phone_id)
            else:
                raise PhonePoolError('not_found', 404)
            self._send_json(200, result)
        except PhonePoolError as error:
            self._send_json(error.status, {'error': error.code})
        except Exception:
            self._send_json(500, {'error': 'internal_error'})

    def do_GET(self) -> None:
        self._handle('GET')

    def do_POST(self) -> None:
        self._handle('POST')


def main() -> None:
    listen_host = os.environ.get('PHONE_POOL_LISTEN_HOST', '127.0.0.1')
    listen_port = int(os.environ.get('PHONE_POOL_LISTEN_PORT', '18317'))
    try:
        if not ipaddress.ip_address(listen_host).is_loopback:
            raise SystemExit('PHONE_POOL_LISTEN_HOST must be loopback')
    except ValueError as error:
        raise SystemExit('PHONE_POOL_LISTEN_HOST must be a literal loopback address') from error
    state_path = Path(
        os.environ.get('PHONE_POOL_STATE_PATH', '/var/lib/cliproxy-private/phone-pool.json')
    )
    account_path = Path(
        os.environ.get(
            'PHONE_POOL_ACCOUNT_SNAPSHOT_PATH',
            '/var/lib/cliproxy-private/account-pool.json',
        )
    )
    configured_hosts = os.environ.get('PHONE_POOL_ALLOWED_HOSTS', '')
    allowed_hosts = frozenset(
        host.strip().rstrip('.').casefold()
        for host in configured_hosts.split(',')
        if host.strip()
    ) or DEFAULT_ALLOWED_HOSTS
    PhonePoolRequestHandler.repository = PhonePoolRepository(
        state_path=state_path,
        account_snapshot_path=account_path,
        allowed_hosts=allowed_hosts,
    )
    server = ThreadingHTTPServer((listen_host, listen_port), PhonePoolRequestHandler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == '__main__':
    main()
