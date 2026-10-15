using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace DojoWallpaper
{
    // Journal de l'application : %LOCALAPPDATA%\DojoWallpaper\dojo.log, lignes horodatees.
    // Rotation simple : au-dela de 512 Ko, le fichier courant devient dojo.log.1 (remplace l'ancien).
    // N'ecrit jamais d'identifiant ni de secret : les URL passent par Redact.
    // Ecriture ouverte/fermee a chaque ligne (pas de poignee gardee) : plusieurs processus peuvent ecrire.
    internal static class DojoLog
    {
        internal const long MaxBytes = 512 * 1024;

        private const string RotatedSuffix = ".1";
        private const int ATTACH_PARENT_PROCESS = -1;

        private static readonly object Gate = new object();
        private static string _path = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DojoWallpaper", "dojo.log");
        private static bool _console;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int processId);

        // A appeler une fois au demarrage. console : recopie aussi sur la console parente (--log-console).
        public static void Open(bool console)
        {
            Open(_path, console);
        }

        internal static void Open(string path, bool console)
        {
            lock (Gate)
            {
                _path = path;
                _console = console;
                if (console)
                {
                    AttachConsole(ATTACH_PARENT_PROCESS);
                }
                try
                {
                    string dir = Path.GetDirectoryName(Path.GetFullPath(path));
                    Directory.CreateDirectory(dir);
                    RotateIfNeeded(path, 0);
                }
                catch (IOException)
                {
                }
                catch (UnauthorizedAccessException)
                {
                }
            }
        }

        public static void Write(string message)
        {
            string text = (message ?? string.Empty).Replace("\r", " ").Replace("\n", " | ");
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture)
                + "  " + text + Environment.NewLine;
            lock (Gate)
            {
                try
                {
                    byte[] bytes = new UTF8Encoding(false).GetBytes(line);
                    RotateIfNeeded(_path, bytes.Length);
                    using (var stream = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                    {
                        stream.Write(bytes, 0, bytes.Length);
                    }
                    if (_console)
                    {
                        Console.Out.Write(line);
                    }
                }
                catch (IOException)
                {
                }
                catch (UnauthorizedAccessException)
                {
                }
            }
        }

        // Erreur : type et message de l'exception (pas de pile, pas de donnees utilisateur).
        public static void Error(string what, Exception ex)
        {
            string detail = ex == null ? "(sans detail)" : ex.GetType().Name + " : " + ex.Message;
            Write("ERREUR " + what + " : " + detail);
        }

        // URL sans identifiants, requete ni fragment : schema, hote, port, chemin.
        public static string Redact(string url)
        {
            Uri uri;
            if (string.IsNullOrEmpty(url) || !Uri.TryCreate(url, UriKind.Absolute, out uri))
            {
                return "(url invalide)";
            }
            string port = uri.IsDefaultPort ? string.Empty : ":" + uri.Port.ToString(CultureInfo.InvariantCulture);
            return uri.Scheme + "://" + uri.Host + port + uri.AbsolutePath;
        }

        // Rotation : si l'ecriture de extra octets depasse la limite, le fichier courant part en .1.
        private static void RotateIfNeeded(string path, int extra)
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length + extra <= MaxBytes)
            {
                return;
            }
            string rotated = path + RotatedSuffix;
            try
            {
                if (File.Exists(rotated))
                {
                    File.Delete(rotated);
                }
                File.Move(path, rotated);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    // Recopie les Trace.Trace*/Trace.Write* (ex. avertissements de PauseEngine) dans le journal.
    internal sealed class DojoTraceListener : System.Diagnostics.TraceListener
    {
        private readonly StringBuilder _pending = new StringBuilder();

        public override void Write(string message)
        {
            lock (_pending)
            {
                _pending.Append(message);
            }
        }

        public override void WriteLine(string message)
        {
            string text;
            lock (_pending)
            {
                _pending.Append(message);
                text = _pending.ToString();
                _pending.Clear();
            }
            DojoLog.Write("trace : " + text);
        }
    }
}
