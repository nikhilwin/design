# Email

## What it does

Doory sends email to confirm addresses and reset passwords. Without an SMTP server, it prints emails to the API
log instead, which is fine for trying Doory out.

## Requirements

An SMTP account: your own mail server or any transactional email service.

## Turn it on

```ini
EMAIL_URL=smtp+tls://user:password@smtp.example.com:587
DEFAULT_FROM_EMAIL=Doory <no-reply@example.com>
```

Use `smtp+ssl://` for port 465. URL-encode special characters in the password (`@` → `%40`, `/` → `%2F`). Then
restart the services.

## Settings

See [Email in configuration.md](../self-hosting/configuration.md#email).

## Check it works

```bash
docker compose exec api python manage.py sendtestemail you@example.com
```

## Troubleshooting

- **Nothing arrives and nothing is logged:** `EMAIL_SEND_ASYNC=true` sends in the background, so look for errors
  in the API log rather than in the browser.
- **Mail lands in spam:** set up SPF and DKIM for the domain in `DEFAULT_FROM_EMAIL`.
