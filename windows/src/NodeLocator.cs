using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace DojoWallpaper
{
    // Node.js utilisable : chemin, version et verdict (version >= 18).
    public sealed class NodeInfo
    {
        public string Path { get; set; }
        public string Version { get; set; }
        public bool Ok { get; set; }
    }

    // Recherche de node.exe, dans le meme ordre que src/setup.js (winNodeCandidates) :
    // PATH, %ProgramFiles%\nodejs, %USERPROFILE%\.volta\bin, puis les dossiers de versions nvm-windows
    // (NVM_HOME, sinon %APPDATA%\nvm ; les versions les plus recentes d'abord).
    // DOJO_NODE, si defini, est utilise tel quel (tests).
    public static class NodeLocator
    {
        public const string OverrideVariable = "DOJO_NODE";
        public const int MinimumMajor = 18;
        // Echec de recherche memorise : les sondes de node peuvent durer 5 s chacune, pas a chaque appel.
        public static readonly TimeSpan FailureCacheDuration = TimeSpan.FromSeconds(30);

        private static readonly object Gate = new object();
        private static NodeInfo cached;
        private static NodeInfo missed;
        private static DateTime missedUntilUtc = DateTime.MinValue;
        private static readonly Regex MajorRe = new Regex(@"\A\s*v?(\d+)", RegexOptions.IgnoreCase);
        // Dossier absolu : lettre de lecteur ou partage UNC. Les entrees relatives de PATH sont ignorees.
        private static readonly Regex AbsoluteDirRe = new Regex(@"\A(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])");

        // Candidats dans l'ordre de recherche. Fonction pure : aucun acces au disque.
        public static IList<string> Candidates(
            IEnumerable<string> pathDirs, string programFiles, string userProfile, string nvmHome, IEnumerable<string> nvmVersionDirs)
        {
            var list = new List<string>();
            if (pathDirs != null)
            {
                foreach (string dir in pathDirs)
                {
                    string trimmed = dir == null ? null : dir.Trim().Trim('"');
                    // Entree relative de PATH (« . », « bin ») : node serait cherche dans le dossier courant. Ignoree.
                    if (trimmed == null || !AbsoluteDirRe.IsMatch(trimmed))
                    {
                        continue;
                    }
                    AddCandidate(list, trimmed, "node.exe");
                }
            }
            AddCandidate(list, programFiles, Path.Combine("nodejs", "node.exe"));
            AddCandidate(list, userProfile, Path.Combine(".volta", "bin", "node.exe"));
            if (nvmVersionDirs != null)
            {
                foreach (string version in nvmVersionDirs)
                {
                    AddCandidate(list, nvmHome, Path.Combine(version, "node.exe"));
                }
            }
            return list;
        }

        // Dossiers de versions tries du plus recent au plus ancien (comparaison numerique des nombres du nom).
        public static IList<string> SortVersionDirs(IEnumerable<string> names)
        {
            return names
                .OrderByDescending(n => VersionKey(n), new VersionKeyComparer())
                .ToList();
        }

        // Majeure d'une version (« v20.11.0 » -> 20) ; -1 si illisible.
        public static int ParseMajor(string version)
        {
            if (string.IsNullOrEmpty(version))
            {
                return -1;
            }
            Match m = MajorRe.Match(version);
            int major;
            return m.Success && int.TryParse(m.Groups[1].Value, out major) ? major : -1;
        }

        public static bool IsSupported(int major)
        {
            return major >= MinimumMajor;
        }

        // Node utilisable, ou null. Sans DOJO_NODE : premier node >= 18 ; sinon le premier node present (Ok = false).
        public static NodeInfo Find()
        {
            string forced = Environment.GetEnvironmentVariable(OverrideVariable);
            if (!string.IsNullOrWhiteSpace(forced))
            {
                return File.Exists(forced)
                    ? new NodeInfo { Path = forced, Version = string.Empty, Ok = true }
                    : null;
            }

            lock (Gate)
            {
                if (cached != null)
                {
                    return cached;
                }
                if (DateTime.UtcNow < missedUntilUtc)
                {
                    return missed;
                }

                NodeInfo firstPresent = null;
                foreach (string candidate in SystemCandidates())
                {
                    if (!File.Exists(candidate))
                    {
                        continue;
                    }
                    string version = Probe(candidate);
                    if (version == null)
                    {
                        continue;
                    }
                    var info = new NodeInfo
                    {
                        Path = candidate,
                        Version = version,
                        Ok = IsSupported(ParseMajor(version))
                    };
                    if (info.Ok)
                    {
                        cached = info;
                        return info;
                    }
                    if (firstPresent == null)
                    {
                        firstPresent = info;
                    }
                }
                // Aucun node >= 18 trouve (firstPresent : plus ancien ou null) : memorise pendant FailureCacheDuration.
                // Un node installe entre-temps n'est vu qu'apres ce delai.
                missed = firstPresent;
                missedUntilUtc = DateTime.UtcNow + FailureCacheDuration;
                return firstPresent;
            }
        }

        // Version de node (process.versions.node), ou null si le binaire ne repond pas.
        internal static string Probe(string nodeExe)
        {
            try
            {
                NodeRunner.ProcessRun run = NodeRunner.RunProcess(nodeExe, "-p process.versions.node", null, 5, null);
                if (run.TimedOut || run.ExitCode != 0)
                {
                    return null;
                }
                string version = run.Stdout.Trim();
                return version.Length == 0 ? null : version;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static IList<string> SystemCandidates()
        {
            string userProfile = Environment.GetEnvironmentVariable("USERPROFILE");
            if (string.IsNullOrEmpty(userProfile))
            {
                userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            }
            string appData = Environment.GetEnvironmentVariable("APPDATA");
            string nvmHome = Environment.GetEnvironmentVariable("NVM_HOME");
            if (string.IsNullOrWhiteSpace(nvmHome))
            {
                nvmHome = Path.Combine(
                    string.IsNullOrWhiteSpace(appData) ? Path.Combine(userProfile, "AppData", "Roaming") : appData,
                    "nvm");
            }
            string programFiles = Environment.GetEnvironmentVariable("ProgramFiles");
            if (string.IsNullOrWhiteSpace(programFiles))
            {
                programFiles = @"C:\Program Files";
            }

            var pathDirs = (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
                .Split(';')
                .Where(d => !string.IsNullOrWhiteSpace(d))
                .ToList();
            var versionDirs = new List<string>();
            try
            {
                if (Directory.Exists(nvmHome))
                {
                    versionDirs = SortVersionDirs(
                        Directory.GetDirectories(nvmHome).Select(d => Path.GetFileName(d))).ToList();
                }
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
            return Candidates(pathDirs, programFiles, userProfile, nvmHome, versionDirs);
        }

        private static void AddCandidate(List<string> list, string dir, string relative)
        {
            if (string.IsNullOrWhiteSpace(dir))
            {
                return;
            }
            try
            {
                list.Add(Path.Combine(dir, relative));
            }
            catch (ArgumentException)
            {
            }
        }

        private static List<int> VersionKey(string name)
        {
            return Regex.Matches(name ?? string.Empty, @"\d+")
                .Cast<Match>()
                .Select(m => int.TryParse(m.Value, out int n) ? n : 0)
                .ToList();
        }

        // Comparaison lexicographique de listes de nombres ; un nombre absent vaut 0.
        private sealed class VersionKeyComparer : IComparer<List<int>>
        {
            public int Compare(List<int> a, List<int> b)
            {
                int length = Math.Max(a.Count, b.Count);
                for (int i = 0; i < length; i++)
                {
                    int x = i < a.Count ? a[i] : 0;
                    int y = i < b.Count ? b[i] : 0;
                    if (x != y)
                    {
                        return x.CompareTo(y);
                    }
                }
                return 0;
            }
        }
    }
}
