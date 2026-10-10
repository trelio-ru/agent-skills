import Foundation
import Security

// This helper has no interactive credential arguments. A Keychain item stores
// only a random AEAD key; provider credentials and journals remain ciphertext.
// Keychain's normal app-access prompts are respected without bypass or fallback.
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count < 16384,
          let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
          let account = request["account"] as? String,
          UUID(uuidString: account) != nil else { exit(2) }
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "trelio.vk-ads.vault.v1", kSecAttrAccount as String: account]
    if request["mode"] as? String == "delete" {
        let result = SecItemDelete(query as CFDictionary)
        exit(result == errSecSuccess || result == errSecItemNotFound ? 0 : 6)
    }
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    var status = SecItemCopyMatching(lookup as CFDictionary, &item)
    if status == errSecItemNotFound {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { exit(3) }
        let key = Data(bytes)
        var create = query
        create[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        create[kSecValueData as String] = key
        status = SecItemAdd(create as CFDictionary, nil)
        // Two independent setup processes can race on the first item. Read the
        // winner; never overwrite an existing key or silently invalidate a vault.
        if status == errSecDuplicateItem { status = SecItemCopyMatching(lookup as CFDictionary, &item) }
        else if status == errSecSuccess { item = key as CFData }
        bytes.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }
    }
    guard status == errSecSuccess, let key = item as? Data, key.count == 32 else { exit(4) }
    FileHandle.standardOutput.write(key)
} catch { exit(5) }
