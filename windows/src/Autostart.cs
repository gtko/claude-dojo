using System;
using Microsoft.Win32;

namespace DojoWallpaper
{
    // Demarrage avec Windows : valeur dans HKCU\...\Run (utilisateur courant, sans elevation).
    // Meme nom que l'installateur (setup.js, RUN_WALL) : une seule valeur, donc un seul lancement a l'ouverture de session.
    // keyPath est optionnel pour les tests : ne jamais l'utiliser avec la vraie cle Run dans les tests.
    public static class Autostart
    {
        public const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        public const string DefaultValueName = "ClaudeDojoWallpaper";
        // Nom des versions precedentes de l'app : encore reconnu, retire par Enable et Disable. null : ignore.
        public const string LegacyValueName = "DojoWallpaper";

        public static bool IsEnabled(string valueName = DefaultValueName, string keyPath = RunKeyPath,
            string legacyName = LegacyValueName)
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(keyPath, false))
            {
                return key != null && (key.GetValue(valueName) is string
                    || (legacyName != null && key.GetValue(legacyName) is string));
            }
        }

        public static void Enable(string exePath, string valueName = DefaultValueName, string keyPath = RunKeyPath,
            string legacyName = LegacyValueName)
        {
            if (string.IsNullOrWhiteSpace(exePath))
            {
                throw new ArgumentException("Chemin de l'exe requis.", "exePath");
            }

            // Chemin quote : espaces dans le chemin (Program Files) gérés par le shell.
            string command = "\"" + exePath.Trim().Trim('"') + "\"";
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(keyPath))
            {
                key.SetValue(valueName, command, RegistryValueKind.String);
                if (legacyName != null && legacyName != valueName)
                {
                    key.DeleteValue(legacyName, false);
                }
            }
        }

        public static void Disable(string valueName = DefaultValueName, string keyPath = RunKeyPath,
            string legacyName = LegacyValueName)
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(keyPath, true))
            {
                if (key != null)
                {
                    key.DeleteValue(valueName, false);
                    if (legacyName != null)
                    {
                        key.DeleteValue(legacyName, false);
                    }
                }
            }
        }
    }
}
