#import "virtual-display-bridge.h"

#import <AppKit/AppKit.h>
#import <objc/message.h>
#import <objc/runtime.h>

// This file deliberately uses runtime lookup instead of private headers. A
// missing selector therefore produces a controlled startup failure rather
// than a loader error that could leave a partially configured display.

static bool VDSetObject(id target, const char *selectorName, id value) {
    SEL selector = sel_registerName(selectorName);
    if (![target respondsToSelector:selector]) return false;
    ((void (*)(id, SEL, id))objc_msgSend)(target, selector, value);
    return true;
}

static bool VDSetUInt32(id target, const char *selectorName, uint32_t value) {
    SEL selector = sel_registerName(selectorName);
    if (![target respondsToSelector:selector]) return false;
    ((void (*)(id, SEL, uint32_t))objc_msgSend)(target, selector, value);
    return true;
}

void *VDCreateDisplay(const char *name,
                      uint32_t width,
                      uint32_t height,
                      double refreshRate,
                      uint32_t vendorID,
                      uint32_t productID,
                      uint32_t serialNumber) {
    @autoreleasepool {
        Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
        Class displayClass = NSClassFromString(@"CGVirtualDisplay");
        Class modeClass = NSClassFromString(@"CGVirtualDisplayMode");
        Class settingsClass = NSClassFromString(@"CGVirtualDisplaySettings");
        if (!descriptorClass || !displayClass || !modeClass || !settingsClass) {
            return NULL;
        }

        id descriptor = [[descriptorClass alloc] init];
        NSString *displayName = [NSString stringWithUTF8String:name ?: "Codex iPhone Session"];
        if (!descriptor || !displayName
            || !VDSetObject(descriptor, "setName:", displayName)
            || !VDSetUInt32(descriptor, "setMaxPixelsWide:", width)
            || !VDSetUInt32(descriptor, "setMaxPixelsHigh:", height)
            || !VDSetUInt32(descriptor, "setVendorID:", vendorID)
            || !VDSetUInt32(descriptor, "setProductID:", productID)) {
            return NULL;
        }

        SEL sizeSelector = sel_registerName("setSizeInMillimeters:");
        if (![descriptor respondsToSelector:sizeSelector]) return NULL;
        const double pixelsPerMillimeter = 81.0 / 25.4;
        CGSize physicalSize = CGSizeMake(width / pixelsPerMillimeter,
                                         height / pixelsPerMillimeter);
        ((void (*)(id, SEL, CGSize))objc_msgSend)(descriptor, sizeSelector, physicalSize);

        // Both spellings have existed in implementations of the private API.
        // Select the one exposed by this macOS build instead of assuming it.
        if (![descriptor respondsToSelector:sel_registerName("setSerialNum:")]) {
            if (!VDSetUInt32(descriptor, "setSerialNumber:", serialNumber)) return NULL;
        } else if (!VDSetUInt32(descriptor, "setSerialNum:", serialNumber)) {
            return NULL;
        }

        SEL queueSelector = sel_registerName("setDispatchQueue:");
        if ([descriptor respondsToSelector:queueSelector]) {
            dispatch_queue_t queue = dispatch_queue_create(
                "codex.iphone-mirroring.virtual-display",
                DISPATCH_QUEUE_SERIAL
            );
            ((void (*)(id, SEL, id))objc_msgSend)(descriptor, queueSelector, queue);
        }

        id displayAllocation = [displayClass alloc];
        SEL displayInitializer = sel_registerName("initWithDescriptor:");
        if (![displayAllocation respondsToSelector:displayInitializer]) return NULL;
        id display = ((id (*)(id, SEL, id))objc_msgSend)(
            displayAllocation,
            displayInitializer,
            descriptor
        );
        if (!display) return NULL;

        id modeAllocation = [modeClass alloc];
        SEL modeInitializer = sel_registerName("initWithWidth:height:refreshRate:");
        if (![modeAllocation respondsToSelector:modeInitializer]) return NULL;
        id mode = ((id (*)(id, SEL, uint32_t, uint32_t, double))objc_msgSend)(
            modeAllocation,
            modeInitializer,
            width,
            height,
            refreshRate
        );
        if (!mode) return NULL;

        id settings = [[settingsClass alloc] init];
        if (!settings
            || !VDSetObject(settings, "setModes:", @[mode])
            || !VDSetUInt32(settings, "setHiDPI:", 0)) {
            return NULL;
        }

        SEL applySelector = sel_registerName("applySettings:");
        if (![display respondsToSelector:applySelector]) return NULL;
        BOOL applied = ((BOOL (*)(id, SEL, id))objc_msgSend)(
            display,
            applySelector,
            settings
        );
        if (!applied) return NULL;

        // The supervisor owns this +1 retain until VDReleaseDisplay. Keeping
        // ownership in one process ties display lifetime to its safety loop.
        return (__bridge_retained void *)display;
    }
}

void VDReleaseDisplay(void *display) {
    if (!display) return;
    CFBridgingRelease(display);
}

CGDirectDisplayID VDDisplayID(void *displayPointer) {
    if (!displayPointer) return kCGNullDirectDisplay;
    id display = (__bridge id)displayPointer;
    SEL selector = sel_registerName("displayID");
    if (![display respondsToSelector:selector]) return kCGNullDirectDisplay;
    return ((CGDirectDisplayID (*)(id, SEL))objc_msgSend)(display, selector);
}

bool VDFixupDisplayArrangement(CGDirectDisplayID virtualDisplayID,
                               CGDirectDisplayID savedMainDisplayID) {
    CGDisplayConfigRef configuration = NULL;
    if (CGBeginDisplayConfiguration(&configuration) != kCGErrorSuccess
        || !configuration) {
        return false;
    }

    bool valid = true;
    if (CGMainDisplayID() == virtualDisplayID) {
        valid = CGConfigureDisplayOrigin(
            configuration,
            savedMainDisplayID,
            0,
            0
        ) == kCGErrorSuccess;
    }

    if (valid && CGDisplayMirrorsDisplay(savedMainDisplayID) == virtualDisplayID) {
        valid = CGConfigureDisplayMirrorOfDisplay(
            configuration,
            savedMainDisplayID,
            kCGNullDirectDisplay
        ) == kCGErrorSuccess;
    }

    // Preserve every physical display's existing arrangement. Only append our
    // own vendor-tagged display to the right edge of the physical union.
    int32_t rightEdge = 0;
    CGDirectDisplayID online[32];
    uint32_t count = 0;
    if (valid && CGGetOnlineDisplayList(32, online, &count) == kCGErrorSuccess) {
        for (uint32_t index = 0; index < count; ++index) {
            CGDirectDisplayID candidate = online[index];
            if (candidate == virtualDisplayID || CGDisplayVendorNumber(candidate) == 0xEEEE) {
                continue;
            }
            CGRect bounds = CGDisplayBounds(candidate);
            rightEdge = MAX(rightEdge, (int32_t)ceil(CGRectGetMaxX(bounds)));
        }
    }

    if (valid) {
        valid = CGConfigureDisplayOrigin(
            configuration,
            virtualDisplayID,
            rightEdge,
            0
        ) == kCGErrorSuccess;
    }

    if (!valid) {
        CGCancelDisplayConfiguration(configuration);
        return false;
    }

    return CGCompleteDisplayConfiguration(
        configuration,
        kCGConfigureForAppOnly
    ) == kCGErrorSuccess;
}
