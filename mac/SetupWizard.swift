// Conteneur de l'assistant : en-tête (étape, progression), contenu de l'étape, navigation Annuler / Précédent / Suivant.
import SwiftUI

/// Taille de l'assistant. Assez haute pour que l'étape Claude Code (aperçu compris) tienne sans défiler.
enum SetupLayout {
    static let width: CGFloat = 640
    static let height: CGFloat = 640
}

struct SetupWizardView: View {
    @ObservedObject var model: SetupModel
    /// Captures (--snapshot) seulement : contenu entier sans défilement ni hauteur fixe, pour qu'aucune section ne soit coupée.
    var unclipped = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(model.editing ? "Réglages" : "Installation")
                Spacer()
                Text("Étape \(model.step.rawValue + 1) sur \(SetupStep.allCases.count) · \(model.step.title)")
            }
            .font(.caption)
            .foregroundColor(.secondary)
            .padding(.horizontal, 20)
            .padding(.top, 14)

            ProgressView(value: Double(model.step.rawValue + 1), total: Double(SetupStep.allCases.count))
                .padding(.horizontal, 20)
                .padding(.top, 6)
            Divider().padding(.top, 10)

            if unclipped {
                SetupStepView(model: model)
                    .padding(20)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ScrollView {
                    SetupStepView(model: model)
                        .padding(20)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            Divider()
            footer
        }
        .frame(width: SetupLayout.width, height: unclipped ? nil : SetupLayout.height)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button("Annuler") { model.close() }
                .keyboardShortcut(.cancelAction)
            Spacer()
            if model.step != .welcome {
                Button("Précédent") { model.back() }
                    .disabled(model.applying)
            }
            if model.step == .done {
                if model.applied {
                    Button("Fermer") { model.close() }
                        .keyboardShortcut(.defaultAction)
                } else {
                    Button(model.applying ? "Application…" : "Appliquer") { Task { await model.apply() } }
                        .keyboardShortcut(.defaultAction)
                        .disabled(model.applying || model.detect == nil)
                }
            } else {
                Button("Suivant") { Task { await model.next() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!model.canGoNext)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }
}
