using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace DojoWallpaper
{
    public sealed class PauseRules
    {
        public bool OnFullscreen = true, OnMaximized = true, OnBattery = true, OnBatterySaver = true;
        public string[] ForegroundApps = new string[0];
        // Processus qui ne mettent jamais le fond en pause (recherche, menu Demarrer, notre propre processus...).
        // "explorer" n'y figure pas : une fenetre de l'Explorateur maximisee doit mettre le fond en pause.
        // Le bureau et la barre des taches ne sont pas concernes : PauseEngine ignore leurs classes de fenetre
        // (Progman, WorkerW, Shell_TrayWnd, Shell_SecondaryTrayWnd).
        public string[] IgnoreApps = new[]
        {
            "DojoWallpaper", "SearchHost", "ShellExperienceHost", "StartMenuExperienceHost"
        };
    }

    // Config JSON (dojo-wallpaper.json). Lecture tolerante : valeurs invalides normalisees, fichier corrompu -> defauts + .bad.
    public sealed class DojoConfig
    {
        public const string DefaultUrl = "http://localhost:7777/";
        public const string DefaultMode = "interactive";
        public const string PassiveMode = "passive";
        public const string FileName = "dojo-wallpaper.json";
        public const string UrlEnvironmentVariable = "DOJO_URL";

        // A cote de DojoWallpaper.exe.
        public static readonly string DefaultPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, FileName);

        public string Url = DefaultUrl;
        public string Mode = DefaultMode; // "interactive" | "passive"
        public bool Mirror = true;
        public double Zoom = 0; // 0 = auto
        public int[] DisabledScreens = new int[0];
        public PauseRules Pause = new PauseRules();

        // Url telle qu'ecrite dans le fichier, et valeur de DOJO_URL appliquee au chargement (jamais ecrite par Save).
        private string _fileUrl = DefaultUrl;
        private string _environmentUrl;

        public static DojoConfig Load(string path)
        {
            string text = TryReadText(path);
            if (text != null)
            {
                DojoConfig parsed;
                if (TryParse(text, out parsed))
                {
                    return parsed;
                }
                BackupCorrupted(path);
            }
            return Defaults();
        }

        public void Save(string path)
        {
            WriteFile(path, ToFileJson());
        }

        public static string NormalizeMode(string mode)
        {
            return mode != null && string.Equals(mode.Trim(), PassiveMode, StringComparison.OrdinalIgnoreCase)
                ? PassiveMode
                : DefaultMode;
        }

        internal static DojoConfig Defaults()
        {
            return new DojoConfig().ApplyEnvironment();
        }

        // Parse un texte JSON ; renvoie false si ce n'est pas un objet JSON. DOJO_URL est applique.
        internal static bool TryParse(string text, out DojoConfig cfg)
        {
            cfg = null;
            object root;
            try
            {
                root = new JavaScriptSerializer().DeserializeObject(text);
            }
            catch (Exception)
            {
                return false;
            }

            var map = ToMap(root);
            if (map == null)
            {
                return false;
            }

            var c = new DojoConfig();
            c._fileUrl = NormalizeUrl(AsString(Get(map, "Url"))) ?? DefaultUrl;
            c.Url = c._fileUrl;
            c.Mode = NormalizeMode(AsString(Get(map, "Mode")));
            c.Mirror = AsBool(Get(map, "Mirror")) ?? true;
            c.Zoom = NormalizeZoom(AsDouble(Get(map, "Zoom")) ?? 0);
            if (map.ContainsKey("DisabledScreens"))
            {
                c.DisabledScreens = CleanScreens(ToIntList(Get(map, "DisabledScreens"))).ToArray();
            }
            c.Pause = ReadPause(ToMap(Get(map, "Pause")));
            cfg = c.ApplyEnvironment();
            return true;
        }

        internal static void WriteFile(string path, string json)
        {
            string full = Path.GetFullPath(path);
            Directory.CreateDirectory(Path.GetDirectoryName(full));
            // Ecriture atomique : fichier temporaire puis remplacement, pour qu'un lecteur ne voie jamais un fichier partiel.
            string tmp = full + ".tmp";
            File.WriteAllText(tmp, json, new UTF8Encoding(false));
            if (File.Exists(full))
            {
                File.Replace(tmp, full, null);
            }
            else
            {
                File.Move(tmp, full);
            }
        }

        // null si le fichier est absent ou illisible (verrouille) : l'appelant utilise les defauts.
        internal static string TryReadText(string path)
        {
            if (!File.Exists(path))
            {
                return null;
            }
            try
            {
                return File.ReadAllText(path, Encoding.UTF8);
            }
            catch (IOException)
            {
                return null;
            }
            catch (UnauthorizedAccessException)
            {
                return null;
            }
        }

        internal static void BackupCorrupted(string path)
        {
            try
            {
                File.Copy(path, path + ".bad", true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        internal DojoConfig ApplyEnvironment()
        {
            string url = NormalizeUrl(Environment.GetEnvironmentVariable(UrlEnvironmentVariable));
            _environmentUrl = url;
            if (url != null)
            {
                Url = url;
            }
            return this;
        }

        // Contenu du fichier : indente, valeurs normalisees, sans la surcharge DOJO_URL.
        internal string ToFileJson()
        {
            string url = NormalizeUrl(Url) ?? DefaultUrl;
            if (_environmentUrl != null && Url == _environmentUrl)
            {
                url = _fileUrl;
            }
            var pause = Pause ?? new PauseRules();

            var sb = new StringBuilder();
            sb.Append("{\n");
            AppendMember(sb, 1, "Url", Quote(url), true);
            AppendMember(sb, 1, "Mode", Quote(NormalizeMode(Mode)), true);
            AppendMember(sb, 1, "Mirror", Mirror ? "true" : "false", true);
            AppendMember(sb, 1, "Zoom", NormalizeZoom(Zoom).ToString("R", CultureInfo.InvariantCulture), true);
            AppendMember(sb, 1, "DisabledScreens", RenderIntArray(CleanScreens(DisabledScreens), 1), true);
            AppendMember(sb, 1, "Pause", RenderPause(pause), false);
            sb.Append("}\n");
            return sb.ToString();
        }

        private static string RenderPause(PauseRules p)
        {
            var sb = new StringBuilder();
            sb.Append("{\n");
            AppendMember(sb, 2, "OnFullscreen", p.OnFullscreen ? "true" : "false", true);
            AppendMember(sb, 2, "OnMaximized", p.OnMaximized ? "true" : "false", true);
            AppendMember(sb, 2, "OnBattery", p.OnBattery ? "true" : "false", true);
            AppendMember(sb, 2, "OnBatterySaver", p.OnBatterySaver ? "true" : "false", true);
            AppendMember(sb, 2, "ForegroundApps", RenderStringArray(CleanStrings(p.ForegroundApps), 2), true);
            AppendMember(sb, 2, "IgnoreApps", RenderStringArray(CleanStrings(p.IgnoreApps), 2), false);
            sb.Append("  }");
            return sb.ToString();
        }

        private static void AppendMember(StringBuilder sb, int level, string key, string value, bool comma)
        {
            sb.Append(Indent(level)).Append(Quote(key)).Append(": ").Append(value);
            if (comma)
            {
                sb.Append(',');
            }
            sb.Append('\n');
        }

        private static string RenderStringArray(IList<string> items, int level)
        {
            if (items.Count == 0)
            {
                return "[]";
            }
            var sb = new StringBuilder("[\n");
            for (int i = 0; i < items.Count; i++)
            {
                sb.Append(Indent(level + 1)).Append(Quote(items[i]));
                sb.Append(i < items.Count - 1 ? ",\n" : "\n");
            }
            return sb.Append(Indent(level)).Append(']').ToString();
        }

        private static string RenderIntArray(IList<int> items, int level)
        {
            if (items.Count == 0)
            {
                return "[]";
            }
            var sb = new StringBuilder("[\n");
            for (int i = 0; i < items.Count; i++)
            {
                sb.Append(Indent(level + 1)).Append(items[i].ToString(CultureInfo.InvariantCulture));
                sb.Append(i < items.Count - 1 ? ",\n" : "\n");
            }
            return sb.Append(Indent(level)).Append(']').ToString();
        }

        private static string Indent(int level)
        {
            return new string(' ', level * 2);
        }

        private static string Quote(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char ch in s)
            {
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (ch < 0x20)
                        {
                            sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(ch);
                        }
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        private static PauseRules ReadPause(IDictionary<string, object> map)
        {
            var p = new PauseRules();
            if (map == null)
            {
                return p;
            }
            p.OnFullscreen = AsBool(Get(map, "OnFullscreen")) ?? p.OnFullscreen;
            p.OnMaximized = AsBool(Get(map, "OnMaximized")) ?? p.OnMaximized;
            p.OnBattery = AsBool(Get(map, "OnBattery")) ?? p.OnBattery;
            p.OnBatterySaver = AsBool(Get(map, "OnBatterySaver")) ?? p.OnBatterySaver;
            if (map.ContainsKey("ForegroundApps"))
            {
                p.ForegroundApps = CleanStrings(ToStringList(Get(map, "ForegroundApps"))).ToArray();
            }
            if (map.ContainsKey("IgnoreApps"))
            {
                p.IgnoreApps = CleanStrings(ToStringList(Get(map, "IgnoreApps"))).ToArray();
            }
            return p;
        }

        internal static string NormalizeUrl(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return null;
            }
            string trimmed = value.Trim();
            Uri uri;
            if (Uri.TryCreate(trimmed, UriKind.Absolute, out uri)
                && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
            {
                return trimmed;
            }
            return null;
        }

        internal static double NormalizeZoom(double zoom)
        {
            // 0 = auto ; sinon borne dans 0.3..2.
            if (double.IsNaN(zoom) || double.IsInfinity(zoom) || zoom <= 0)
            {
                return 0;
            }
            if (zoom < 0.3)
            {
                return 0.3;
            }
            return zoom > 2 ? 2 : zoom;
        }

        private static List<int> CleanScreens(IEnumerable<int> source)
        {
            var result = new List<int>();
            if (source == null)
            {
                return result;
            }
            foreach (int index in source)
            {
                if (index >= 0 && !result.Contains(index))
                {
                    result.Add(index);
                }
            }
            return result;
        }

        private static List<string> CleanStrings(IEnumerable<string> source)
        {
            var result = new List<string>();
            if (source == null)
            {
                return result;
            }
            foreach (string item in source)
            {
                string value = item == null ? null : item.Trim();
                if (!string.IsNullOrEmpty(value) && !result.Exists(x => string.Equals(x, value, StringComparison.OrdinalIgnoreCase)))
                {
                    result.Add(value);
                }
            }
            return result;
        }

        private static IDictionary<string, object> ToMap(object value)
        {
            var source = value as Dictionary<string, object>;
            if (source == null)
            {
                return null;
            }
            var map = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in source)
            {
                map[pair.Key] = pair.Value;
            }
            return map;
        }

        private static object Get(IDictionary<string, object> map, string key)
        {
            object value;
            return map.TryGetValue(key, out value) ? value : null;
        }

        private static string AsString(object value)
        {
            return value as string;
        }

        private static bool? AsBool(object value)
        {
            return value is bool ? (bool?)value : null;
        }

        private static double? AsDouble(object value)
        {
            if (value == null || value is bool || value is string)
            {
                return null;
            }
            try
            {
                return Convert.ToDouble(value, CultureInfo.InvariantCulture);
            }
            catch (InvalidCastException)
            {
                return null;
            }
            catch (FormatException)
            {
                return null;
            }
            catch (OverflowException)
            {
                return null;
            }
        }

        private static List<string> ToStringList(object value)
        {
            var result = new List<string>();
            var items = value as object[];
            if (items == null)
            {
                return result;
            }
            foreach (object item in items)
            {
                string s = AsString(item);
                if (s != null)
                {
                    result.Add(s);
                }
            }
            return result;
        }

        private static List<int> ToIntList(object value)
        {
            var result = new List<int>();
            var items = value as object[];
            if (items == null)
            {
                return result;
            }
            foreach (object item in items)
            {
                double? d = AsDouble(item);
                if (d.HasValue && d.Value >= 0 && d.Value <= int.MaxValue && Math.Floor(d.Value) == d.Value)
                {
                    result.Add((int)d.Value);
                }
            }
            return result;
        }
    }
}
