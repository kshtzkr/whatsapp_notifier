# Bulk Messaging Policy Guardrails

This gem includes technical controls to reduce policy and spam risks:

- paced delivery via `bulk_base_delay_seconds` and `bulk_jitter_seconds`
- capped recipients via `bulk_max_recipients`
- bounded retries via `bulk_max_attempts`
- retry only on configured transient error codes
- automatic wait/sleep when provider returns `wait_seconds`
- idempotency key deduplication in the same bulk run

## Recommended defaults

- keep provider as `:official_api` in production
- avoid unsolicited messaging
- use explicit opt-in recipient lists
- keep throughput conservative

## Wait-time compliance

If provider returns:

```ruby
{ success: false, error_code: :rate_limited, wait_seconds: 30 }
```

the bulk dispatcher pauses for 30 seconds before moving forward.

## Web automation warning

Using `:web_automation` can create account risk and policy risk. It is opt-in and should be limited to controlled internal scenarios.
