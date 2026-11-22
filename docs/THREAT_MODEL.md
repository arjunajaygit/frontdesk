# STRIDE threat model
Assets: public and private conversations, account/session secrets, ownership, SLA facts, historical audit, service availability. Actors: anonymous internet user, customer, agent, compromised session, malicious insider, CI contributor, DB owner (trusted boundary).
| STRIDE | Attack path | Required mitigation | Verification |
|---|---|---|---|
| Spoofing | stolen token / brute force | Argon2id, session expiry/revocation, throttling | invalid/revoked token and rate tests |
| Tampering | duplicate claim or forged timestamp | conditional update, server clock, audit privilege | race, rollback, DB update denied |
| Repudiation | deny reply | actor/time/message ID transactional audit | exact same transaction, persisted history |
| Disclosure | guessed ID, note export/list | resource guard, PUBLIC query and DTO | two-customer negative tests, private sentinel absent |
| DoS | giant page/body, expensive query | bounded inputs, limits, indexes, job batch | 429, max size, readiness |
| Elevation | crafted role or mass assignment | DTO whitelist, deny default, non-owner roles | customer calls staff routes, privilege regression |
Residual risks: privileged DB owner, hosting outages/sleep, dependency zero-days, compromised browser, holiday config mistakes; record in risk register. DAST only against owned disposable test service. No real customer data. Optional MFA, external audit checkpoint and image signing reduce specific risks, not mandatory.

