// Contenu des dix étapes de l'assistant, et petits composants partagés.
import SwiftUI

struct SetupStepView: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        switch model.step {
        case .welcome: WelcomeStep(model: model)
        case .dependencies: DependenciesStep(model: model, installer: model.nodeInstaller)
        case .weather: WeatherStep(model: model)
        case .github: OwnersStep(model: model)
        case .projects: ProjectsStep(model: model)
        case .calendars: CalendarsStep(model: model)
        case .claude: ClaudeStep(model: model)
        case .autostart: AutostartStep(model: model)
        case .theme: ThemeStep(model: model)
        case .windowZone: WindowZoneStep(model: model)
        case .done: DoneStep(model: model)
        }
    }
}

// MARK: Composants partagés

struct StepTitle: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.title2)
                .fontWeight(.semibold)
            Text(subtitle)
                .font(.callout)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct Notice: View {
    let text: String
    var isError = false

    var body: some View {
        Text(text)
            .font(.callout)
            .foregroundColor(isError ? .red : .secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// Bandeau d'avertissement : app lancée depuis le DMG ou une copie temporaire (démarrage automatique impossible).
struct LocationBanner: View {
    let text: String

    var body: some View {
        Label {
            Text(text)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.orange)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.orange.opacity(0.12))
        .cornerRadius(6)
    }
}

struct StatusRow: View {
    let title: String
    let detail: String
    let ok: Bool
    var isOptional = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: ok ? "checkmark.circle.fill" : (isOptional ? "minus.circle" : "xmark.octagon.fill"))
                .foregroundColor(ok ? .green : (isOptional ? .secondary : .red))
            VStack(alignment: .leading, spacing: 1) {
                Text(title).fontWeight(.medium)
                Text(detail).font(.caption).foregroundColor(.secondary)
            }
        }
    }
}

struct RemoveButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "minus.circle")
        }
        .buttonStyle(.borderless)
        .foregroundColor(.red)
    }
}

struct InstallerStatus: View {
    let state: NodeInstaller.State

    var body: some View {
        switch state {
        case .idle:
            EmptyView()
        case .working(let text):
            Notice(text: text)
        case .downloading(let fraction):
            VStack(alignment: .leading, spacing: 4) {
                ProgressView(value: fraction)
                Notice(text: "Téléchargement : \(Int(fraction * 100)) %")
            }
        case .done(let text):
            Notice(text: text)
        case .failed(let text):
            Notice(text: text, isError: true)
        }
    }
}

// MARK: Étape 1 : bienvenue

struct WelcomeStep: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            StepTitle(
                title: model.editing ? "Réglages de Claude Dojo" : "Bienvenue dans Claude Dojo",
                subtitle: model.editing
                    ? "Tu modifies la configuration existante. Rien n'est écrit tant que tu n'as pas validé la dernière étape."
                    : "Claude Dojo affiche sur ton bureau la météo, ton agenda, l'état de tes dépôts GitHub et de tes projets. Cet assistant prépare tout en quelques minutes.")
            if let warning = model.appLocationWarning {
                LocationBanner(text: warning)
            }
            VStack(alignment: .leading, spacing: 10) {
                Label("Dépendances : Node.js et des outils optionnels", systemImage: "shippingbox")
                Label("Météo, GitHub, projets et calendriers", systemImage: "slider.horizontal.3")
                Label("Intégration à Claude Code (hooks, barre de statut)", systemImage: "terminal")
                Label("Démarrage automatique à l'ouverture de session", systemImage: "power")
            }
            if model.loading {
                ProgressView().scaleEffect(0.6)
            }
            if let error = model.loadError {
                Notice(text: "Lecture de l'état impossible : \(error)", isError: true)
            }
        }
    }
}

// MARK: Étape 2 : dépendances

struct DependenciesStep: View {
    @ObservedObject var model: SetupModel
    @ObservedObject var installer: NodeInstaller

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            StepTitle(title: "Dépendances", subtitle: "Node.js 18 ou plus récent est requis. Les outils suivants sont optionnels.")
            if let error = model.loadError {
                Notice(text: error, isError: true)
            }
            StatusRow(title: "Node.js", detail: model.nodeDetail, ok: model.nodeOK)
            if !model.nodeOK {
                HStack(spacing: 10) {
                    Button("Installer Node.js LTS") { Task { await model.installNode() } }
                        .disabled(installer.isBusy)
                    if model.brewPath != nil {
                        Button("Installer via Homebrew") { Task { await model.brewInstall("node") } }
                            .disabled(installer.isBusy || model.brewBusy != nil)
                    }
                    Link("nodejs.org", destination: URL(string: "https://nodejs.org/")!)
                }
                InstallerStatus(state: installer.state)
            }
            Divider()
            Text("Optionnels").font(.headline)
            ToolRow(model: model, name: "macmon", purpose: "températures et charge du Mac",
                    present: model.detect?.macmon?.present == true, formula: "macmon")
            ToolRow(model: model, name: "media-control", purpose: "lecteur multimédia en cours",
                    present: model.detect?.mediaControl?.present == true, formula: "ungive/media-control/media-control")
            GhRow(model: model)
            if let message = model.brewMessage {
                Notice(text: message, isError: message.contains("échou"))
            }
        }
    }
}

struct ToolRow: View {
    @ObservedObject var model: SetupModel
    let name: String
    let purpose: String
    let present: Bool
    let formula: String

    var body: some View {
        HStack {
            StatusRow(title: name, detail: present ? "installé" : purpose, ok: present, isOptional: true)
            Spacer()
            if !present, model.brewPath != nil {
                Button(model.brewBusy == formula ? "Installation…" : "Installer via Homebrew") {
                    Task { await model.brewInstall(formula) }
                }
                .disabled(model.brewBusy != nil)
            }
        }
    }
}

struct GhRow: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        let gh = model.detect?.gh
        let installed = gh?.path != nil
        let authed = gh?.authed == true
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                StatusRow(
                    title: "gh (GitHub CLI)",
                    detail: installed ? (authed ? "connecté" : "installé, non connecté") : "pour les dépôts GitHub",
                    ok: installed && authed,
                    isOptional: true)
                Spacer()
                if !installed, model.brewPath != nil {
                    Button(model.brewBusy == "gh" ? "Installation…" : "Installer via Homebrew") {
                        Task { await model.brewInstall("gh") }
                    }
                    .disabled(model.brewBusy != nil)
                }
            }
            if installed && !authed {
                Text("Connexion : lance `gh auth login` dans un terminal.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }
}

// MARK: Étape 3 : météo

struct WeatherStep: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepTitle(title: "Météo", subtitle: "Ville des prévisions affichées sur le fond. Étape facultative.")
            HStack {
                TextField("Ville, ex. Paris", text: $model.city, onCommit: { Task { await model.geocode() } })
                    .textFieldStyle(.roundedBorder)
                Button("Rechercher") { Task { await model.geocode() } }
                    .disabled(model.city.trimmed.isEmpty || model.geoBusy)
            }
            if model.geoBusy {
                ProgressView().scaleEffect(0.6)
            }
            if let error = model.geoError {
                Notice(text: error, isError: true)
            }
            ForEach(model.geoResults) { result in
                Button {
                    model.choose(result)
                } label: {
                    HStack {
                        Image(systemName: isChosen(result) ? "checkmark.circle.fill" : "circle")
                        VStack(alignment: .leading, spacing: 1) {
                            Text(result.label)
                            Text("\(String(format: "%.4f", result.lat ?? 0)), \(String(format: "%.4f", result.lon ?? 0)) · \(result.timezone ?? "fuseau inconnu")")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                    }
                }
                .buttonStyle(.borderless)
            }
            Divider()
            if let w = model.weather {
                Notice(text: "Choisi : \(w.name ?? "") · lat \(String(format: "%.4f", w.lat ?? 0)) · lon \(String(format: "%.4f", w.lon ?? 0)) · fuseau \(w.timezone ?? "inconnu")")
                Button("Ne pas afficher la météo") { model.clearWeather() }
            } else {
                Notice(text: "Aucune ville choisie : la météo ne sera pas affichée.")
            }
        }
    }

    private func isChosen(_ result: GeoResult) -> Bool {
        guard let w = model.weather else { return false }
        return w.lat == result.lat && w.lon == result.lon
    }
}

// MARK: Étape 4 : GitHub

struct OwnersStep: View {
    @ObservedObject var model: SetupModel
    @State private var draft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepTitle(title: "GitHub", subtitle: "Comptes ou organisations dont Dojo suit les dépôts (pull requests, dépôts à jour). Facultatif.")
            HStack {
                TextField("login ou organisation", text: $draft, onCommit: addDraft)
                    .textFieldStyle(.roundedBorder)
                Button("Ajouter", action: addDraft)
                    .disabled(draft.trimmed.isEmpty)
            }
            ForEach(model.owners.indices, id: \.self) { index in
                HStack {
                    TextField("", text: $model.owners[index])
                        .textFieldStyle(.roundedBorder)
                    RemoveButton { model.owners.remove(at: index) }
                }
            }
            if model.owners.isEmpty {
                Notice(text: "Aucun propriétaire : les dépôts GitHub ne seront pas suivis.")
            }
        }
    }

    private func addDraft() {
        let value = draft.trimmed
        guard !value.isEmpty else { return }
        model.owners.append(value)
        draft = ""
    }
}

// MARK: Étape 5 : projets

struct ProjectsStep: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepTitle(title: "Projets", subtitle: "Dossiers racines où Dojo cherche tes dépôts Git. Facultatif : sans dossier, Dojo utilise ses emplacements usuels.")
            ForEach(model.roots.indices, id: \.self) { index in
                HStack {
                    TextField("", text: $model.roots[index])
                        .textFieldStyle(.roundedBorder)
                    RemoveButton { model.roots.remove(at: index) }
                }
            }
            HStack {
                Button("Ajouter un dossier…") { chooseFolders() }
                Spacer()
            }
            Toggle("Ne montrer que les dépôts des propriétaires GitHub suivis", isOn: $model.onlyOwners)
                .toggleStyle(.checkbox)
        }
    }

    private func chooseFolders() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Ajouter"
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            let path = (url.path as NSString).abbreviatingWithTildeInPath
            if !model.roots.contains(path) { model.roots.append(path) }
        }
    }
}

// MARK: Étape 6 : calendriers

struct CalendarsStep: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepTitle(title: "Calendriers", subtitle: "Adresses ICS de tes agendas (https:// ou webcal://). Facultatif. Dans Google Agenda : Paramètres, puis ton agenda, puis Adresse secrète au format iCal.")
            ForEach(model.calendars.indices, id: \.self) { index in
                HStack {
                    TextField("https://…", text: $model.calendars[index])
                        .textFieldStyle(.roundedBorder)
                    RemoveButton { model.calendars.remove(at: index) }
                }
                if !model.calendars[index].trimmed.isEmpty && !DojoConfig.isCalendarURL(model.calendars[index].trimmed) {
                    Notice(text: "URL invalide : elle doit commencer par https://, http:// ou webcal://", isError: true)
                }
            }
            Button("Ajouter un calendrier") { model.calendars.append("") }
            if model.calendars.isEmpty {
                Notice(text: "Aucun calendrier : l'agenda ne sera pas affiché.")
            }
        }
    }
}

// MARK: Étape 7 : Claude Code

struct ClaudeStep: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepTitle(title: "Claude Code", subtitle: "Ce que Dojo ajoute à ~/.claude/settings.json. L'aperçu ci-dessous montre les modifications avant application.")
            // claude absent du JSON (null) se décode en nil : on avertit donc sur « pas présent », pas sur « présent et faux ».
            if model.detect != nil, model.detect?.claude?.present != true {
                Notice(text: "Claude Code introuvable : la configuration sera écrite quand même.")
            }
            Toggle("Hooks Dojo (suivi de session et d'activité)", isOn: $model.hooks)
                .toggleStyle(.checkbox)
            Text("Barre de statut").font(.callout).fontWeight(.medium)
            Picker("", selection: $model.statusLine) {
                Text("Remplacer par celle de Dojo").tag(StatusLinePolicy.replace)
                Text("Garder celle existante").tag(StatusLinePolicy.keep)
                Text("Ne pas gérer la barre de statut").tag(StatusLinePolicy.none)
            }
            .pickerStyle(.radioGroup)
            .labelsHidden()
            Toggle("Heavy-gate : empêche Claude Code de lancer trop de suites de tests/builds en parallèle", isOn: $model.heavyGate)
                .toggleStyle(.checkbox)
            if model.heavyGate, let limits = model.heavyLimits {
                Text("Seuils automatiques pour ce Mac : \(limits.suites) suites en parallèle · \(limits.nodes) processus node")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Toggle("VITEST_MAX_WORKERS : limite le nombre de workers de tests", isOn: $model.vitestWorkers)
                .toggleStyle(.checkbox)
            Text("Aperçu des modifications").font(.callout).fontWeight(.medium)
            if let error = model.previewError {
                Notice(text: error, isError: true)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    // Ajouts en phrases courtes (tous les hooks, barre de statut, env) : visibles sans défiler.
                    ForEach(model.changes, id: \.self) { line in
                        Text(line).font(.system(size: 11, design: .monospaced))
                    }
                    if !model.changes.isEmpty {
                        Divider()
                    }
                    // Diff brut, lignes longues repliées (pas de troncature) ; la hauteur du cadre suit le contenu.
                    Text(model.diff.isEmpty ? "Aperçu indisponible." : model.diff)
                        .font(.system(size: 11, design: .monospaced))
                        .lineLimit(nil)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
            }
            .frame(height: 170)
            .background(Color(nsColor: .textBackgroundColor))
            .cornerRadius(6)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.35)))
        }
    }
}

// MARK: Étape 8 : démarrage automatique

struct AutostartStep: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            StepTitle(title: "Démarrage automatique", subtitle: "Dojo se lance à l'ouverture de session, via des LaunchAgents dans ~/Library/LaunchAgents. Aucun droit administrateur requis.")
            if let warning = model.appLocationWarning {
                LocationBanner(text: warning)
            }
            Toggle("Lancer Dojo à l'ouverture de session", isOn: $model.autostart)
                .toggleStyle(.checkbox)
            if !model.autostart {
                Notice(text: "Désactivé : Dojo reste disponible via le menu ⛩ et se relance à la main.")
            }
        }
    }
}

// MARK: Étape 9 : récapitulatif et application

struct DoneStep: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepTitle(
                title: model.applied ? "Terminé" : "Prêt à appliquer",
                subtitle: model.applied
                    ? "Dojo est configuré et le fond d'écran est lancé."
                    : "Vérifie le récapitulatif, puis applique. Rien n'est modifié avant ce clic.")
            VStack(alignment: .leading, spacing: 4) {
                ForEach(model.summary, id: \.self) { line in
                    Text("• " + line).font(.callout)
                }
            }
            if model.autostart, let warning = model.appLocationWarning {
                LocationBanner(text: warning)
            }
            if !model.log.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(model.log.indices, id: \.self) { index in
                            Text(model.log[index]).font(.system(size: 11, design: .monospaced))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                }
                .frame(height: 110)
                .background(Color(nsColor: .textBackgroundColor))
                .cornerRadius(6)
            }
            if let error = model.applyError {
                Notice(text: error, isError: true)
            }
        }
    }
}
