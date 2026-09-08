#!/bin/sh
set -eu

: "${TWITEE_API_KEY:?export TWITEE_API_KEY first}"
TWITEE_URL="${TWITEE_URL:-http://127.0.0.1:8080}"

curl -fsS "$TWITEE_URL/healthz"
curl -fsS -H "Authorization: Bearer $TWITEE_API_KEY" "$TWITEE_URL/v1/session"
curl -fsS -H "Authorization: Bearer $TWITEE_API_KEY" "$TWITEE_URL/v1/profiles/openai"
curl -fsS -H "Authorization: Bearer $TWITEE_API_KEY" "$TWITEE_URL/v1/profiles/openai/posts"
curl -fsS -G -H "Authorization: Bearer $TWITEE_API_KEY" --data-urlencode "q=open source" "$TWITEE_URL/v1/search/posts"
curl -fsS -G -H "Authorization: Bearer $TWITEE_API_KEY" --data-urlencode "q=OpenAI" "$TWITEE_URL/v1/search/people"
