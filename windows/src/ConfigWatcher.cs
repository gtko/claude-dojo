using System;
using System.IO;
using System.Text;
using System.Threading;

namespace DojoWallpaper
{
    // Surveille dojo-wallpaper.json (rechargement a chaud). Surveille le dossier : couvre les ecritures
    // par remplacement (editeurs, fichier temporaire renomme). Save ne redeclenche pas Changed.
    public sealed class ConfigWatcher : IDisposable
    {
        private const int DebounceMs = 300;
        private const int ReadAttempts = 5;
        private const int ReadRetryMs = 60;

        private readonly string _path;
        private readonly string _fileName;
        private readonly SynchronizationContext _context;
        private readonly FileSystemWatcher _watcher;
        private readonly System.Threading.Timer _timer;
        private readonly object _gate = new object();
        private DojoConfig _current;
        private string _lastJson;
        private bool _disposed;

        // Leve sur le thread du SynchronizationContext capture a la construction (thread UI).
        public event Action<DojoConfig> Changed;

        public ConfigWatcher(string path)
        {
            if (path == null)
            {
                throw new ArgumentNullException("path");
            }

            _path = Path.GetFullPath(path);
            _fileName = Path.GetFileName(_path);
            _context = SynchronizationContext.Current ?? new SynchronizationContext();

            string dir = Path.GetDirectoryName(_path);
            Directory.CreateDirectory(dir);
            if (!File.Exists(_path))
            {
                new DojoConfig().Save(_path);
            }

            _current = DojoConfig.Load(_path);
            _lastJson = _current.ToFileJson();

            _timer = new System.Threading.Timer(OnSettled, null, Timeout.Infinite, Timeout.Infinite);
            _watcher = new FileSystemWatcher(dir, "*")
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size
            };
            _watcher.Changed += OnFileEvent;
            _watcher.Created += OnFileEvent;
            _watcher.Renamed += OnRenamed;
            _watcher.Error += (s, e) => Schedule();
            _watcher.EnableRaisingEvents = true;
        }

        public DojoConfig Current
        {
            get
            {
                lock (_gate)
                {
                    return _current;
                }
            }
        }

        // Ecrit la config (atomique) et la garde comme etat courant, sans Changed : pas de boucle de rechargement.
        public void Save(DojoConfig c)
        {
            if (c == null)
            {
                throw new ArgumentNullException("c");
            }

            lock (_gate)
            {
                if (_disposed)
                {
                    throw new ObjectDisposedException(GetType().Name);
                }

                string json = c.ToFileJson();
                DojoConfig.WriteFile(_path, json);
                DojoConfig next;
                if (!DojoConfig.TryParse(json, out next))
                {
                    next = DojoConfig.Defaults();
                }
                _lastJson = json;
                _current = next;
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }
                _disposed = true;
                _timer.Dispose();
            }
            _watcher.EnableRaisingEvents = false;
            _watcher.Dispose();
        }

        private bool IsOurs(string name)
        {
            return string.Equals(name, _fileName, StringComparison.OrdinalIgnoreCase);
        }

        private void OnFileEvent(object sender, FileSystemEventArgs e)
        {
            if (IsOurs(e.Name))
            {
                Schedule();
            }
        }

        private void OnRenamed(object sender, RenamedEventArgs e)
        {
            if (IsOurs(e.Name) || IsOurs(e.OldName))
            {
                Schedule();
            }
        }

        // Debounce : chaque evenement repousse la relecture de 300 ms.
        private void Schedule()
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }
                _timer.Change(DebounceMs, Timeout.Infinite);
            }
        }

        private void OnSettled(object state)
        {
            DojoConfig next = null;
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                string text = ReadWithRetry();
                // Absent, illisible, ou vide pendant une ecriture en cours : on attend l'evenement suivant.
                if (string.IsNullOrWhiteSpace(text))
                {
                    return;
                }

                if (!DojoConfig.TryParse(text, out next))
                {
                    DojoConfig.BackupCorrupted(_path);
                    next = DojoConfig.Defaults();
                }

                string json = next.ToFileJson();
                if (json == _lastJson)
                {
                    return;
                }
                _lastJson = json;
                _current = next;
            }

            _context.Post(RaiseChanged, next);
        }

        private void RaiseChanged(object state)
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }
            }

            var handler = Changed;
            if (handler != null)
            {
                handler((DojoConfig)state);
            }
        }

        // Relit le fichier ; un editeur peut le tenir verrouille quelques instants.
        private string ReadWithRetry()
        {
            for (int attempt = 1; attempt <= ReadAttempts; attempt++)
            {
                if (!File.Exists(_path))
                {
                    return null;
                }
                try
                {
                    return File.ReadAllText(_path, Encoding.UTF8);
                }
                catch (IOException)
                {
                    if (attempt == ReadAttempts)
                    {
                        return null;
                    }
                    Thread.Sleep(ReadRetryMs);
                }
                catch (UnauthorizedAccessException)
                {
                    return null;
                }
            }
            return null;
        }
    }
}
