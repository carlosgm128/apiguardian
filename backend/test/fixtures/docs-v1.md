# Petstore API

All requests use JSON.

## Authentication

No authentication is required.

## Pets

### List pets

`GET /pets` returns up to `limit` pets (max 100).

### Delete a pet

`DELETE /pets/{id}` removes a pet permanently.

## Rate limits

100 requests per minute per IP.

```bash
# This is a comment, not a heading
curl https://api.example.com/v1/pets
```
