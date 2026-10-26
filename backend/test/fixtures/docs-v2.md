# Petstore API

All requests use JSON.

## Authentication

Send your key in the `X-API-Key` header on every request.

## Pets

### List pets

`GET /pets` returns up to `limit` pets (max 50). Use `cursor` to page.

## Operations

### Rate limits

100 requests per minute per IP.

```bash
# This is a comment, not a heading
curl https://api.example.com/v1/pets
```
