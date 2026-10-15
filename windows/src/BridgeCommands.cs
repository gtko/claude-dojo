using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace DojoWallpaper
{
    // Appel valide, pret a etre execute par NodeRunner : argv pour setup.js (sans le chemin de setup.js),
    // stdin eventuel (JSON, jamais en argv) et delai en secondes.
    public sealed class BridgeCall
    {
        public BridgeCall(string command, IList<string> argv, string stdin, int timeoutSeconds)
        {
            Command = command;
            Argv = new List<string>(argv).AsReadOnly();
            Stdin = stdin;
            TimeoutSeconds = timeoutSeconds;
            Writes = IsWriteCall(command, Argv);
        }

        public string Command { get; private set; }
        public IList<string> Argv { get; private set; }
        public string Stdin { get; private set; }
        public int TimeoutSeconds { get; private set; }

        // Vrai si l'appel modifie la configuration, les fonds ou le terminal : le pont les sérialise par fenêtre.
        public bool Writes { get; private set; }

        // argv[0] = commande, argv[1] = sous-commande (wallpapers, terminal).
        private static bool IsWriteCall(string command, IList<string> argv)
        {
            string action = argv.Count > 1 ? argv[1] : null;
            switch (command)
            {
                case "write-config":
                case "merge-settings":
                case "set-theme":
                case "set-background":
                    return true;
                case "wallpapers":
                    return action == "use" || action == "download" || action == "sync" || action == "next";
                case "terminal":
                    return action == "apply" || action == "remove";
                default:
                    return false;
            }
        }
    }

    // Refus d'une commande ou d'un argument. Le message est lisible (francais) et peut etre affiche tel quel.
    public sealed class BridgeRejectedException : Exception
    {
        public BridgeRejectedException(string message) : base(message)
        {
        }
    }

    // Liste blanche stricte des commandes de l'interface. Logique pure : aucun processus lance ici.
    // Toute commande absente est refusee ; aucun argument ne commence par '-' (sauf '-' litteral pour stdin).
    public static class BridgeCommands
    {
        public const int MaxStdinBytes = 1024 * 1024;
        public const int MaxTerminalJsonBytes = 2048;
        public const int MaxGeocodeLength = 100;

        // Identifiant de theme : meme forme que setup.js (THEME_ID_RE). \z et non $, pour refuser un saut de ligne final.
        private static readonly Regex ThemeIdRe = new Regex(@"\A[a-z0-9-]+\z");
        private static readonly Regex WallhavenIdRe = new Regex(@"\A[A-Za-z0-9]{3,16}\z");
        private static readonly Regex FileNameRe = new Regex(@"\A(?!-)[A-Za-z0-9._-]{1,80}\z");
        private static readonly Regex PageRe = new Regex(@"\A[0-9]{1,4}\z");
        // Chemin absolu local : lettre de lecteur. Les chemins reseau (UNC) sont refuses avant (RequireImagePath).
        private static readonly Regex AbsolutePathRe = new Regex(@"\A[A-Za-z]:[\\/]");
        // Extensions de fond : memes que setup.js (BG_EXT).
        private static readonly string[] ImageExtensions = { ".jpg", ".jpeg", ".png", ".webp", ".heic" };
        private static readonly string[] TerminalKeys = { "ghostty", "terminalApp", "windowsTerminal", "welcome" };
        private static readonly string[] TerminalActions = { "status", "apply", "remove" };
        private static readonly string[] WallpaperActions =
        {
            "list", "search", "local", "download", "sync", "progress", "use", "next"
        };

        // Valide un appel. Renvoie l'appel prepare, ou leve BridgeRejectedException (message en francais).
        public static BridgeCall Validate(string cmd, IList<string> args, string stdin)
        {
            if (string.IsNullOrEmpty(cmd))
            {
                throw Refuse("commande manquante.");
            }
            var list = args == null ? new List<string>() : new List<string>(args);
            foreach (string arg in list)
            {
                CheckArgument(cmd, arg);
            }

            switch (cmd)
            {
                case "themes":
                    return Plain(cmd, list, 0, 30, stdin);
                case "detect":
                    return Plain(cmd, list, 0, 60, stdin);
                case "status":
                    return Plain(cmd, list, 0, 30, stdin);
                case "set-theme":
                    RequireCount(cmd, list, 1, 1);
                    RequireTheme(list[0]);
                    return Plain(cmd, list, 1, 60, stdin);
                case "set-background":
                    RequireCount(cmd, list, 1, 1);
                    if (list[0] != "default")
                    {
                        RequireImagePath(list[0]);
                    }
                    return Plain(cmd, list, 1, 120, stdin);
                case "wallpapers":
                    return Wallpapers(list, stdin);
                case "terminal":
                    return Terminal(list, stdin);
                case "geocode":
                    RequireCount(cmd, list, 1, 1);
                    RequireGeocodeText(list[0]);
                    return Plain(cmd, list, 1, 30, stdin);
                case "write-config":
                    return JsonStdin(cmd, list, stdin, 60);
                case "merge-settings":
                    return JsonStdin(cmd, list, stdin, 120);
                default:
                    throw Refuse("commande refusee : " + cmd + ".");
            }
        }

        private static BridgeCall Wallpapers(IList<string> list, string stdin)
        {
            if (list.Count == 0)
            {
                throw Refuse("wallpapers attend une sous-commande : " + string.Join(", ", WallpaperActions) + ".");
            }
            string action = list[0];
            var rest = list.Skip(1).ToList();
            RejectStdin("wallpapers", stdin);
            switch (action)
            {
                case "list":
                    RequireCount("wallpapers " + action, rest, 1, 1);
                    RequireTheme(rest[0]);
                    return Build("wallpapers", list, 90);
                case "search":
                    RequireCount("wallpapers " + action, rest, 1, 2);
                    RequireTheme(rest[0]);
                    if (rest.Count == 2)
                    {
                        string page = RequirePage(rest[1]);
                        return Build("wallpapers", new[] { "search", rest[0], page }, 90);
                    }
                    return Build("wallpapers", list, 90);
                case "local":
                    RequireCount("wallpapers " + action, rest, 1, 1);
                    RequireTheme(rest[0]);
                    return Build("wallpapers", list, 30);
                case "download":
                    RequireCount("wallpapers " + action, rest, 1, 2);
                    RequireWallhavenId(rest[0]);
                    if (rest.Count == 2)
                    {
                        RequireTheme(rest[1]);
                    }
                    return Build("wallpapers", list, 180);
                case "sync":
                    RequireCount("wallpapers " + action, rest, 0, 1);
                    if (rest.Count == 1)
                    {
                        RequireTheme(rest[0]);
                    }
                    return Build("wallpapers", list, 600);
                case "progress":
                    RequireCount("wallpapers " + action, rest, 1, 1);
                    RequireTheme(rest[0]);
                    return Build("wallpapers", list, 30);
                case "use":
                    RequireCount("wallpapers " + action, rest, 1, 2);
                    if (rest[0] == "theme" || rest[0] == "bundled")
                    {
                        RequireCount("wallpapers use " + rest[0], rest, 1, 1);
                    }
                    else if (WallhavenIdRe.IsMatch(rest[0]))
                    {
                        if (rest.Count == 2)
                        {
                            RequireTheme(rest[1]);
                        }
                    }
                    else
                    {
                        RequireFileName(rest[0]);
                        RequireCount("wallpapers use " + rest[0], rest, 1, 1);
                    }
                    return Build("wallpapers", list, 60);
                case "next":
                    RequireCount("wallpapers " + action, rest, 0, 0);
                    return Build("wallpapers", list, 180);
                default:
                    throw Refuse("sous-commande wallpapers refusee : " + action + ".");
            }
        }

        private static BridgeCall Terminal(IList<string> list, string stdin)
        {
            RejectStdin("terminal", stdin);
            if (list.Count == 0 || Array.IndexOf(TerminalActions, list[0]) < 0)
            {
                throw Refuse("terminal attend status, apply ou remove.");
            }
            RequireCount("terminal " + list[0], list.Skip(1).ToList(), 0, 1);
            if (list.Count == 2)
            {
                RequireTerminalJson(list[1]);
            }
            return Build("terminal", list, 180);
        }

        private static BridgeCall JsonStdin(string cmd, IList<string> list, string stdin, int timeout)
        {
            if (list.Count != 1 || list[0] != "-")
            {
                throw Refuse(cmd + " attend exactement « - » : le JSON est transmis sur stdin, jamais en argument.");
            }
            if (stdin == null)
            {
                throw Refuse(cmd + " : JSON attendu sur stdin.");
            }
            if (Encoding.UTF8.GetByteCount(stdin) > MaxStdinBytes)
            {
                throw Refuse(cmd + " : JSON trop volumineux (1 Mo max).");
            }
            if (JsonText.ParseObject(stdin) == null)
            {
                throw Refuse(cmd + " : objet JSON valide attendu sur stdin.");
            }
            return Build(cmd, list, timeout, stdin);
        }

        private static BridgeCall Plain(string cmd, IList<string> list, int count, int timeout, string stdin)
        {
            RequireCount(cmd, list, count, count);
            RejectStdin(cmd, stdin);
            return Build(cmd, list, timeout);
        }

        // argv complet pour setup.js : le nom de la commande, puis ses arguments (sans le chemin de setup.js).
        private static BridgeCall Build(string cmd, IEnumerable<string> args, int timeout, string stdin = null)
        {
            var argv = new List<string> { cmd };
            argv.AddRange(args);
            return new BridgeCall(cmd, argv, stdin, timeout);
        }

        // Verifications communes a chaque argument, quelle que soit la commande.
        private static void CheckArgument(string cmd, string arg)
        {
            if (arg == null)
            {
                throw Refuse("argument manquant pour " + cmd + ".");
            }
            if (arg.Length > 0 && arg[0] == '-' && !(arg == "-" && IsJsonStdinCommand(cmd)))
            {
                throw Refuse("argument refuse (commence par « - ») : " + arg + ".");
            }
            foreach (char c in arg)
            {
                if (char.IsControl(c))
                {
                    throw Refuse("caractere de controle refuse dans un argument.");
                }
            }
        }

        private static bool IsJsonStdinCommand(string cmd)
        {
            return cmd == "write-config" || cmd == "merge-settings";
        }

        private static void RejectStdin(string cmd, string stdin)
        {
            if (!string.IsNullOrEmpty(stdin))
            {
                throw Refuse("stdin non accepte par " + cmd + ".");
            }
        }

        private static void RequireCount(string cmd, IList<string> list, int min, int max)
        {
            if (list.Count < min || list.Count > max)
            {
                throw Refuse("nombre d'arguments incorrect pour " + cmd + ".");
            }
        }

        private static void RequireTheme(string id)
        {
            if (!ThemeIdRe.IsMatch(id))
            {
                throw Refuse("identifiant de thème invalide (lettres minuscules, chiffres, tirets).");
            }
        }

        private static void RequireWallhavenId(string id)
        {
            if (!WallhavenIdRe.IsMatch(id))
            {
                throw Refuse("identifiant de fond invalide.");
            }
        }

        private static void RequireFileName(string name)
        {
            if (!FileNameRe.IsMatch(name) || name.Contains(".."))
            {
                throw Refuse("nom de fichier invalide.");
            }
        }

        private static string RequirePage(string text)
        {
            int page;
            if (!PageRe.IsMatch(text) || !int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out page)
                || page < 1 || page > 1000)
            {
                throw Refuse("page invalide (entre 1 et 1000).");
            }
            return page.ToString(CultureInfo.InvariantCulture);
        }

        private static void RequireImagePath(string path)
        {
            // Chemins reseau refuses (\\serveur\partage, \\?\, //serveur) : aucun acces SMB depuis l'interface.
            if (path.StartsWith(@"\\", StringComparison.Ordinal) || path.StartsWith("//", StringComparison.Ordinal))
            {
                throw Refuse("chemin réseau (UNC) refusé pour l'image de fond.");
            }
            if (!AbsolutePathRe.IsMatch(path))
            {
                throw Refuse("chemin absolu attendu pour l'image de fond.");
            }
            string ext = Path.GetExtension(path).ToLowerInvariant();
            if (Array.IndexOf(ImageExtensions, ext) < 0)
            {
                throw Refuse("extension d'image non prise en charge (jpg, jpeg, png, webp, heic).");
            }
            bool exists;
            try
            {
                exists = File.Exists(path);
            }
            catch (ArgumentException)
            {
                exists = false;
            }
            catch (NotSupportedException)
            {
                exists = false;
            }
            if (!exists)
            {
                throw Refuse("fichier image introuvable.");
            }
        }

        private static void RequireGeocodeText(string text)
        {
            if (text.Length < 1 || text.Length > MaxGeocodeLength || text.Trim().Length == 0)
            {
                throw Refuse("lieu attendu (1 à 100 caractères).");
            }
            if (text.StartsWith("-", StringComparison.Ordinal))
            {
                throw Refuse("lieu refuse (commence par « - »).");
            }
        }

        private static void RequireTerminalJson(string text)
        {
            if (Encoding.UTF8.GetByteCount(text) > MaxTerminalJsonBytes)
            {
                throw Refuse("options terminal : JSON trop long (2 Ko max).");
            }
            IDictionary<string, object> obj = JsonText.ParseObject(text);
            if (obj == null)
            {
                throw Refuse("options terminal : objet JSON valide attendu.");
            }
            foreach (KeyValuePair<string, object> pair in obj)
            {
                if (Array.IndexOf(TerminalKeys, pair.Key) < 0)
                {
                    throw Refuse("options terminal : clé refusée : " + pair.Key + ".");
                }
                if (!(pair.Value is bool))
                {
                    throw Refuse("options terminal : la valeur de " + pair.Key + " doit être un booléen.");
                }
            }
        }

        private static BridgeRejectedException Refuse(string message)
        {
            return new BridgeRejectedException(message);
        }
    }

    // Lecture JSON (System.Web.Extensions, comme le reste du projet).
    public static class JsonText
    {
        // Objet JSON -> dictionnaire ; null si le texte n'est pas un objet JSON valide.
        public static IDictionary<string, object> ParseObject(string text)
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                return null;
            }
            try
            {
                var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                return serializer.DeserializeObject(text) as IDictionary<string, object>;
            }
            catch (ArgumentException)
            {
                return null;
            }
            catch (InvalidOperationException)
            {
                return null;
            }
        }

        public static string Serialize(object value)
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            return serializer.Serialize(value);
        }
    }
}
