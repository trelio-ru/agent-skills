# Release review 1.0.0

Initial provider; no earlier apple-calendar tag or runtime exists. Base is public
origin/main 2df16c5; candidate is the committed diff containing this document.
No backend/host/plugin ABI, account catalog, admission or common executor changes.
The provider uses the existing local-accounts-v1, local-form/v1, account resource
policy and signed human-input setup. Host floor 3.31.0 is required by the account
resource policy; the earlier local-form API is already included in that host.

Selected checks: provider-owned protocol/recurrence/scheduling/CAS/fault tests;
actual Keychain/DPAPI storage and native bootstrap on hosted macOS/Windows;
Linux protocol tests and closed credential storage; exact package, instructions,
source-boundary and Windows static checks. The shared renderer fixture uses the
ordinary pinned public contract checkout; no corporate fixture or credentials.
Provider synthetic event writes are in-memory, never real Apple-account effects.

The requesting user explicitly withdrew real tests on the two systems and asked
to implement and publish 1.0.0. No live Apple Account was connected, no events
were sent and no invitation delivery was verified. These limitations are stated
in the public card/instructions. CI success does not change that evidence.
