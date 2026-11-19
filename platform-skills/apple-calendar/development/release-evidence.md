# Release review 1.0.5

Published baseline: skill-apple-calendar-v1.0.4 at
cce41b57a848b152fea2fad1b4d579454c2570e5. macOS previously refused a
pre-existing 0755 shared Trelio root. The native POSIX regression checks
existing readable parents, refusal of writable parents and the provider's
private ACL equivalent (0700). The signed account path, storage format,
permissions within the vault and host admission stay the same. Use the
provider OS matrix, tagged package and guarded read-back.

## Historical review 1.0.4

Published baseline: skill-apple-calendar-v1.0.3 at
b55a44308cb911a2290c0dadde556439bd7c0613. The integration receipt identifies
the exact candidate checked against that tag.

Windows 11 reproduced the baseline failure using the tagged native helper.
An existing synthetic Trelio directory with inherited permissions returns
exit 2 before creating the vault. The same helper succeeds with a clean root.

The new helper accepts inherited ACLs only for the two shared layout parents.
It verifies their current-user ownership, rejects reparse points and denies
write, delete and ACL-changing grants to principals outside the user and
Windows administrators/SYSTEM. It leaves existing shared ACLs untouched.
The provider directory, accounts, lock and encrypted state use the existing
owner-only checks, exact storage paths and DPAPI format. Host ABI/admission,
account and company bindings, provider consent, pending journals and replay
rules are unchanged. The supported host minimum stays 3.31.0.

The Windows regression uses existing inherited shared directories and the
real vault, doctor and host-rendered loopback form with a synthetic CalDAV
client. It checks encrypted save/read-back, unchanged shared ACLs, and refusal
with a widened provider DACL or unrelated delete-child rights on a shared
parent. Keep the existing cold, Restricted-parent and junction regressions.
Run the native provider gates on Windows, macOS and Linux and the signed
tagged-package read-back. The changed setup behavior can be verified on
Windows without using a real Apple Account.

## Historical review 1.0.3

Published baseline: skill-apple-calendar-v1.0.2 at
052edcf15902d4e455cd1e1237ae1e26e622d6e0. The integration receipt records the
exact candidate SHA for this provider-only revision.

Remove the legacy settings screen. The single protected form saves all
discovered calendars and the device time zone for a new connection. Reconnect
retains the saved calendars and zone. Refuse an unavailable zone before
credential entry. Incidental browser requests get an HTTP refusal without
ending the credential session. The admitted credential POST keeps its existing
transport and nonce checks. The production 1.0.2 refusal identified only
setup_request_denied. Its exact trigger remains unconfirmed. The new bounded
stage identifies transport versus form fields without exposing request data.

The host form API, signed command, admission, credential storage and account
scope are unchanged. Check the real renderer over loopback with fixtures for
the one-submit flow, an unrelated browser request, rejected submissions,
reconnect with a pending write, and expiry. Run the hosted Apple Calendar
gates on macOS, Windows and Linux, then verify the exact tagged package and
production read-back. Live connection is verified separately.

## Historical review 1.0.2

Published baseline: skill-apple-calendar-v1.0.1 at
9d4bd44be7898c6bf070355e39db3ef9b28200ca. Review covers the full provider diff
to the candidate recorded by the integration coordinator.

The same protected credential submit now explains and selects all discovered
calendars plus the native device IANA zone for NEW connections. Optional custom
settings retain the old explicit subset path. Reconnect preserves the exact
saved subset and zone, including unresolved operations; missing saved calendars
refuse before persistence. Both paths share the SAME durable encrypted writer,
expiry checks and success completion. No provider write is added to discovery.

This changes provider setup workflow inside the existing local-form/v1 API;
there is no host ABI, command/assistant admission, tenant/account namespace,
credential transport, iCloud privilege, journal format or replay change. The
same all-calendar grant remains visibly approved by the human's submit; existing
bindings never expand automatically. Host minimum remains 3.31.0.

Selected checks: actual host-rendered HTTP regressions for one-step ALL, detected
non-Moscow timezone, saved subset/zone on reconnect, custom subset/default zone,
unavailable timezone, missing saved calendar, unknown-operation preservation,
forged request/cancel/expiry and save-before-success. Ordinary native provider
gates on hosted Linux/macOS/Windows, instruction/package/source checks, tagged
artifact and signed-package read-back remain mandatory. No backend/host release
or unrelated full question-system stand is needed: their boundaries are unchanged.
Synthetic browser smoke inspects the changed form without human credentials.
Real iCloud setup/readiness is checked separately in the authorized local account.

## Historical review 1.0.1

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
