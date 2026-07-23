# CLIProxy private phone pool service

This loopback-only Python service backs the management UI's `/phone-pool`
route and the phone controls in `/account-pool`.

## Security boundary

- The process listens on `127.0.0.1:18317`; Nginx applies the existing
  CLIProxy Management API authentication before proxying requests.
- Provider URLs are stored only in
  `/var/lib/cliproxy-private/phone-pool.json`, which must be mode `0600`.
- API responses never include a stored provider URL or token.
- Provider requests accept HTTPS only, use an explicit hostname allowlist,
  reject non-public DNS results and unsafe redirects, and cap time and body
  size.
- Provider response text is token-redacted and must be rendered by the
  frontend as escaped text.
- Production may serve `management.html` from a host-managed file such as
  `/srv/cliproxy-management/management.html` instead of the container writable
  layer. Keep that file outside the phone-pool state directory, install it
  atomically, return `Cache-Control: no-store`, and retain the old container
  asset as rollback material.

## API

- `GET /v0/management/phone-pool`
- `POST /v0/management/phone-pool/import`
- `POST /v0/management/phone-pool/bind`
- `POST /v0/management/phone-pool/unbind`
- `POST /v0/management/phone-pool/enabled`
- `POST /v0/management/phone-pool/request-code`

The import endpoint accepts one `phone----https://provider/...` or
`phone|https://provider/...` entry per line. `baseline_bindings` records
historical usage and is not a capacity limit. New unique account bindings
increase the historical count; unbinding removes only the current
association.

## Verification

```bash
python3 -m unittest discover -s tests/python -v
python3 -m py_compile ops/phone-pool-service/phone_pool_service.py
```

Use `cliproxy-phone-pool.service` and `nginx-locations.conf` as deployment
templates. Back up the existing Nginx vhost, management UI, private account
snapshot, and service metadata before changing production.
