# Release review 1.0.1

Published baseline: skill-apple-calendar-v1.0.0 at
eed339bcba54bf0451b90daad517871e59d385e4. Review covers the complete provider
diff from that tag to this candidate, including instructions and release files;
the exact committed candidate is recorded by the integration coordinator.

Only setup guidance changes: the protected form links directly to Apple Account
and explains the menu path, local password field and existing five-minute expiry.
The main instruction/packaged guide prepare the human before opening that form.
There is no dependency, host ABI, command admission, account/scope, encrypted
storage, authentication, timer, network dispatch or recovery-code change.
The existing VERSION, User-Agent and PRODID identify the new immutable runtime.
Host minimum remains 3.31.0; no backend/host/plugin release or full cross-component
question-system stand is needed for this compatible presentation-only patch.

Selected checks: actual shared-renderer HTTP setup regression (including failed
input, local-only password, explicit calendar selection and timeout); ordinary
provider gates on hosted Linux/macOS/Windows, instruction/package/source-boundary
checks and exact tagged artifact. The changed presentation is additionally
inspected with the actual host renderer and synthetic setup only. No human
Apple password or live sign-in page is inspected. This release does not claim
new iCloud connectivity or invitation-delivery evidence.

## Historical review 1.0.0

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
