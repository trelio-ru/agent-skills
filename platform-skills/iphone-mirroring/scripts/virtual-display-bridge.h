#ifndef CODEX_IPHONE_VIRTUAL_DISPLAY_BRIDGE_H
#define CODEX_IPHONE_VIRTUAL_DISPLAY_BRIDGE_H

#include <CoreGraphics/CoreGraphics.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// CGVirtualDisplay is a private Objective-C API without public headers. Keep
// the private calls behind a narrow C ABI so the Swift supervisor can fail
// cleanly when Apple changes or removes the runtime classes.
void *VDCreateDisplay(const char *name,
                      uint32_t width,
                      uint32_t height,
                      double refreshRate,
                      uint32_t vendorID,
                      uint32_t productID,
                      uint32_t serialNumber);

void VDReleaseDisplay(void *display);
CGDirectDisplayID VDDisplayID(void *display);

// Reassert the physical-main invariant and place the virtual display to the
// right of all physical displays. The app-only configuration automatically
// reverts when the owning supervisor exits.
bool VDFixupDisplayArrangement(CGDirectDisplayID virtualDisplayID,
                               CGDirectDisplayID savedMainDisplayID);

#ifdef __cplusplus
}
#endif

#endif
