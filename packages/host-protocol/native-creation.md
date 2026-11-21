# Native Create RPC, host protocol 1.3

Feature `native.creation.v1` adds four request/response methods to the authenticated `ui` role. The store channel remains version 5. A client uses these methods only when the verified host challenge announces the feature and protocol minor is at least 3. The host checks the caller's minor and the exact method allowlist. Other UI requests, including cancellation frames, are refused at the role boundary.

| Method                    | Exact params                                                                        | Result                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `native.creation.prepare` | name (trimmed, 1-40), slug, baseCurrency, modules, mcpPrivacy, optional deviceAlias | one-time `prepared` with operation ID, phrase session, 24-word phrase, ISO expiry; or fixed `refused` code |
| `native.creation.commit`  | operationId, phraseSession                                                          | verified `ready`, fixed `outcome_unknown` stage, or pre-effect `refused` code                              |
| `native.creation.inspect` | operationId                                                                         | `pending`, `outcome_unknown`, `ready`, or `not_found`                                                      |
| `native.creation.current` | empty object                                                                        | current `pending`, `outcome_unknown`, latest `ready`, or `none`                                            |

IDs are lowercase 32-hex opaque values. Status stages are `recorded`, `keys`, `artifacts`, `history`, `admission`, and `publishing`. Refusals are `invalid_input`, `setup_unavailable`, `pending_exists`, `prepare_expired`, `prepare_missing`, `operation_conflict`, and `unsafe_target`. Schemas reject extra fields. Inspect and current contain no phrase or user input and have no side effects. A previous ready anchor does not block a new explicit Add when no pending operation exists.

Prepare keeps phrase material in host memory for at most ten minutes and has no durable effects. Commit first durably records the operation and IDs under the host lock, then provisions keys and encrypted history. Once the durable record exists, loss of the request, UI cancellation or disconnect never reverses or replays the operation. The host holds its lock through the entire operation and returns `ready` only after authenticated reopen, profile and initial pin replay, and ready inventory publication. A lost reply is reconciled with inspect/current; neither status method schedules host handover. Only the original successful commit may request controlled handover after its verified ready response.

The UI treats `ready` as a locator. It checks whether the vault is present in the actual current connection, reconnects only if absent, and queries the returned vault's profile identity before navigation. A status of `not_found` alone never authorizes automatic retry. No caller supplies paths, key names, certificate bytes, or raw store events through these methods.

Positive and negative wire vectors are executable in `src/nativeCreation.test.ts`.
