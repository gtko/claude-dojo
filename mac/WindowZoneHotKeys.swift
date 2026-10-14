// Raccourcis globaux de la zone de travail (⌃⌥↩, ⌃⌥←, ⌃⌥→) : Carbon RegisterEventHotKey, sans autorisation supplémentaire.
// Actifs seulement quand l'option est active. Un raccourci déjà pris par un autre outil (Rectangle, Magnet, Raycast…)
// est refusé par le système : il est listé dans `refused` (menu et Réglages) et réessayé à chaque `setActive(true)`.
import Cocoa
import Carbon.HIToolbox

final class WindowZoneHotKeys {
    var onAction: ((WindowZoneAction) -> Void)?

    /// Raccourcis que le système a refusés (déjà utilisés ailleurs), ex. « ⌃⌥← ». Vide si tout est enregistré ou si l'option est inactive.
    private(set) var refused: [String] = []
    /// Même liste, lisible depuis l'étape des Réglages (fil principal).
    static private(set) var currentRefused: [String] = []

    private var refs: [Int: EventHotKeyRef] = [:]
    private var handler: EventHandlerRef?
    private static let signature: OSType = 0x444A_5A4B   // « DJZK »
    fileprivate static weak var current: WindowZoneHotKeys?

    private static let keys: [(code: Int, action: WindowZoneAction, label: String)] = [
        (kVK_Return, .maximize, "⌃⌥↩"), (kVK_LeftArrow, .leftHalf, "⌃⌥←"), (kVK_RightArrow, .rightHalf, "⌃⌥→"),
    ]

    deinit {
        unregisterAll()
        if let handler { RemoveEventHandler(handler) }
        if Self.current === self { Self.current = nil }
    }

    /// Enregistre (ou désenregistre) les raccourcis. Appelable à répétition : seuls les raccourcis manquants sont retentés.
    func setActive(_ active: Bool) {
        guard active else {
            unregisterAll()
            publish([])
            return
        }
        Self.current = self
        guard installHandler() else {
            publish(Self.keys.map(\.label))
            return
        }
        var failed: [String] = []
        for (index, key) in Self.keys.enumerated() where refs[index] == nil {
            var ref: EventHotKeyRef?
            let id = EventHotKeyID(signature: Self.signature, id: UInt32(index))
            let status = RegisterEventHotKey(UInt32(key.code), UInt32(controlKey | optionKey), id, GetApplicationEventTarget(), 0, &ref)
            if status == noErr, let ref { refs[index] = ref } else { failed.append(key.label) }
        }
        publish(failed)
    }

    private func installHandler() -> Bool {
        if handler != nil { return true }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var id = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                           nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            // Seuls nos propres raccourcis nous concernent.
            if status == noErr, id.signature == WindowZoneHotKeys.signature { WindowZoneHotKeys.current?.fire(Int(id.id)) }
            return noErr
        }, 1, &spec, nil, &handler)
        if status != noErr { handler = nil }
        return status == noErr
    }

    private func unregisterAll() {
        refs.values.forEach { UnregisterEventHotKey($0) }
        refs = [:]
    }

    private func publish(_ list: [String]) {
        refused = list
        Self.currentRefused = list
    }

    fileprivate func fire(_ index: Int) {
        guard Self.keys.indices.contains(index) else { return }
        onAction?(Self.keys[index].action)
    }
}
