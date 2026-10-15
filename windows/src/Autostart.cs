using System;
using Microsoft.Win32;

namespace DojoWallpaper
{
    // Demarrage avec Windows : valeur dans HKCU\...\Run (utilisateur courant, sans elevation).
    // keyPath est optionnel pour les tests : ne jamais l'utiliser avec la vraie cle Run dans les tests.
    public static class Autostart
    {
        public const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        public const string DefaultValueName = "DojoWallpaper";

        public static bool IsEnabled(string valueName = DefaultValueName, string keyPath = RunKeyPath)
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(keyPath, false))
            {
                return key != null && key.GetValue(valueName) is string;
            }
        }

        public static void Enable(string exePath, string valueName = DefaultValueName, string keyPath = RunKeyPath)
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
            }
        }

        public static void Disable(string valueName = DefaultValueName, string keyPath = RunKeyPath)
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(keyPath, true))
            {
                if (key != null)
                {
                    key.DeleteValue(valueName, false);
                }
            }
        }
    }
}
