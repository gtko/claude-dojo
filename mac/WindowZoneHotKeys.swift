// Raccourcis globaux de la zone de travail (⌃⌥↩, ⌃⌥←, ⌃⌥→) : Carbon RegisterEventHotKey, sans autorisation supplémentaire.
// Actifs seulement quand l'option est active ; si un autre outil possède déjà un raccourci, celui-ci est simplement ignoré.
import Cocoa
import Carbon.HIToolbox

final class WindowZoneHotKeys {
    var onAction: ((WindowZoneAction) -> Void)?

    private var refs: [EventHotKeyRef] = []
    private var handler: EventHandlerRef?
    private static let signature: OSType = 0x444A_5A4B   // « DJZK »
    fileprivate static weak var current: WindowZoneHotKeys?

    private static let keys: [(code: Int, action: WindowZoneAction)] = [
        (kVK_Return, .maximize), (kVK_LeftArrow, .leftHalf), (kVK_RightArrow, .rightHalf),
    ]

    func setActive(_ active: Bool) {
        if !active {
            refs.forEach { UnregisterEventHotKey($0) }
            refs = []
            return
        }
        guard refs.isEmpty else { return }
        Self.current = self
        if handler == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
                var id = EventHotKeyID()
                let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                               nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
                if status == noErr { WindowZoneHotKeys.current?.fire(Int(id.id)) }
                return noErr
            }, 1, &spec, nil, &handler)
        }
        for (index, key) in Self.keys.enumerated() {
            var ref: EventHotKeyRef?
            let id = EventHotKeyID(signature: Self.signature, id: UInt32(index))
            if RegisterEventHotKey(UInt32(key.code), UInt32(controlKey | optionKey), id, GetApplicationEventTarget(), 0, &ref) == noErr, let ref {
                refs.append(ref)
            }
        }
    }

    fileprivate func fire(_ index: Int) {
        guard Self.keys.indices.contains(index) else { return }
        onAction?(Self.keys[index].action)
    }
}
